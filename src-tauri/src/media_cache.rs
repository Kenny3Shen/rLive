//! 短视频媒体的分片级磁盘缓存。
//!
//! 缓存的是**媒体分片字节**，挂在 VOD 媒体代理的转发路径上：命中时直接回本机
//! 206，不触达上游。它让回滑、重进与重看不必再付一次 CDN 往返，是短视频无缝
//! 加载里唯一跨会话生效的那一半（另一半是前端的双播放器预热）。
//!
//! 键为什么不是 URL：playurl 的产物带 `expire` 短时签名，同一稿件每次取流的
//! URL 都不同。按 URL 缓存必然零命中，而且会随每次取流无限增长。因此键是
//! `key_prefix`（稿件 + 分 P + 清晰度 + 轨）拼接分片字节区间的信息摘要 ——
//! 内容没变，键就不变。
//!
//! 反过来，**playurl 响应与 MPD 本身绝不能落盘**：它们带签名与过期时间，
//! 重放一个过期的 MPD 只会让播放器去打一批已经被 CDN 拒绝的签名地址。

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use crate::disk_cache::{DiskCache, DiskCacheConfig, disk_cache_key, is_committed_cache_name};

#[cfg(target_os = "android")]
const MEDIA_CACHE_BUDGET_BYTES: u64 = 128 * 1024 * 1024;
#[cfg(not(target_os = "android"))]
const MEDIA_CACHE_BUDGET_BYTES: u64 = 512 * 1024 * 1024;

/// 媒体分片缓存的生存期。
///
/// 短视频消费是分钟级的：用户滑过去就再也不会回到那条。跨天缓存只有磁盘占用，
/// 没有命中率。
const MEDIA_CACHE_TTL: Duration = Duration::from_secs(6 * 60 * 60);
/// 早于这个年龄的临时文件才是中断写入的残余。与写入路径的耗时相比足够长，
/// 不会把并发进行中的写入当垃圾回收。
const MEDIA_CACHE_ORPHAN_TTL: Duration = Duration::from_secs(60 * 60);
/// 单个分片的上限。超过它只转发不缓存：那要么不是分片（上游忽略了 Range 返回
/// 全量），要么大得不值得为一个 Range 缓存。
pub const MAX_SEGMENT_BYTES: u64 = 32 * 1024 * 1024;

/// 自上次清扫起新提交多少字节就再清扫一次（预算的 1/8）。
///
/// 取 1/8 而不是更小的值：清扫要遍历两层目录并取每个文件的 metadata，太频繁会把
/// 开销压到写入路径上；取更大的值则让超预算的窗口变宽。
const MEDIA_CACHE_SWEEP_INTERVAL_BYTES: u64 = MEDIA_CACHE_BUDGET_BYTES / 8;

/// 在途缓存字节的共享上限。
///
/// 它管的是内存，不是磁盘：转发路径为每个待缓存分片持一份完整缓冲，写盘又在后台
/// 任务里继续持有它。没有额度时，6 路并发 × 32MiB 分片 × 慢盘堆积的写队可以把 RSS
/// 推到任意高。Android 取得更紧，与它更小的磁盘预算一致。
#[cfg(target_os = "android")]
const MEDIA_CACHE_IN_FLIGHT_BYTES: u64 = 32 * 1024 * 1024;
#[cfg(not(target_os = "android"))]
const MEDIA_CACHE_IN_FLIGHT_BYTES: u64 = 128 * 1024 * 1024;

/// 同时在途的待缓存分片数上限。
///
/// 字节额度已经抦住大分片，这个计数抦的是另一端：大量小分片同时入队时，
/// 每个后台写任务自身的开销（任务、临时文件、rename）也不应无界。
const MEDIA_CACHE_IN_FLIGHT_WRITES: u64 = 16;

/// 在途缓存字节与写任务的共享额度。
///
/// 语义是**试预留**：额度不足就让这次转发不缓存，绝不让前台转发排队等额度。
/// 缓存是尽力而为的，少缓存一个分片只是下次多一次 CDN 往返，而让分片转发等内存
/// 额度会直接变成卡顿。
#[derive(Debug)]
pub struct CacheWriteBudget {
    max_bytes: u64,
    max_writes: u64,
    bytes: AtomicU64,
    writes: AtomicU64,
}

/// 一笔已批准的在途额度，drop 时归还。
#[derive(Debug)]
pub struct CacheWriteReservation {
    budget: Arc<CacheWriteBudget>,
    bytes: u64,
}

impl Drop for CacheWriteReservation {
    fn drop(&mut self) {
        self.budget.bytes.fetch_sub(self.bytes, Ordering::AcqRel);
        self.budget.writes.fetch_sub(1, Ordering::AcqRel);
    }
}

impl CacheWriteBudget {
    pub fn new(max_bytes: u64, max_writes: u64) -> Self {
        Self {
            max_bytes,
            max_writes,
            bytes: AtomicU64::new(0),
            writes: AtomicU64::new(0),
        }
    }

    /// 当前已预留的（字节，笔数）。仅用于观测与测试。
    #[cfg(test)]
    pub fn in_flight(&self) -> (u64, u64) {
        (
            self.bytes.load(Ordering::Acquire),
            self.writes.load(Ordering::Acquire),
        )
    }

    /// 试着预留 `bytes`。不阻塞；额度不足返回 `None`。
    fn try_reserve(self: &Arc<Self>, bytes: u64) -> Option<CacheWriteReservation> {
        if bytes > self.max_bytes {
            return None;
        }
        // 字节与笔数分开 CAS：先拿笔数名额，再拿字节，失败则退回笔数。
        let mut current = self.writes.load(Ordering::Acquire);
        loop {
            if current >= self.max_writes {
                return None;
            }
            match self.writes.compare_exchange_weak(
                current,
                current + 1,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => break,
                Err(observed) => current = observed,
            }
        }

        let mut current = self.bytes.load(Ordering::Acquire);
        loop {
            if current + bytes > self.max_bytes {
                self.writes.fetch_sub(1, Ordering::AcqRel);
                return None;
            }
            match self.bytes.compare_exchange_weak(
                current,
                current + bytes,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => {
                    return Some(CacheWriteReservation {
                        budget: Arc::clone(self),
                        bytes,
                    });
                }
                Err(observed) => current = observed,
            }
        }
    }
}

/// 一个媒体代理可以缓存的字节区间集合。
///
/// 只缓存**精确落在分片表里**的区间：分片表来自该轨的 sidx（外加 init 段），
/// 因此键的集合是有限的、可枚举的。任意 Range 一律不缓存 —— 否则同一个分片被
/// 不同的 Range 切成无数个键，缓存碎片化且命中率归零。
#[derive(Debug, Clone)]
pub struct MediaCacheSpec {
    /// 内容前缀：`{bvid}:{cid}:{qn}:{v|a}`。
    prefix: String,
    /// 轨的容器类型（fMP4 的 init 段与分片同类型）。
    content_type: &'static str,
    /// 可缓存的字节区间（起止均含），来自该轨的 sidx 分片表 + init 段。
    segments: Vec<(u64, u64)>,
}

impl MediaCacheSpec {
    pub fn new(prefix: String, content_type: &'static str, segments: Vec<(u64, u64)>) -> Self {
        Self {
            prefix,
            content_type,
            segments,
        }
    }

    /// 缓存命中时应答的 Content-Type。与上游一致即可，不必存进键里。
    pub fn content_type(&self) -> &'static str {
        self.content_type
    }

    /// 这个 Range 是否精确覆盖一个已知分片；是则返回缓存键。
    pub fn key_for_range(&self, start: u64, end: u64) -> Option<String> {
        if end < start {
            return None;
        }
        if !self
            .segments
            .iter()
            .any(|(segment_start, segment_end)| *segment_start == start && *segment_end == end)
        {
            return None;
        }
        Some(disk_cache_key(&format!(
            "{}:{}:{}",
            self.prefix, start, end
        )))
    }
}

/// 媒体缓存。薄薄一层：所有不变量都在 [`DiskCache`] 里，这里只给参数。
///
/// `Clone` 是廉价的（内部是 `Arc`）：代理的每个回环会话都要持有一份。
#[derive(Debug, Clone)]
pub struct MediaCache {
    inner: Arc<DiskCache>,
    budget: Arc<CacheWriteBudget>,
}

impl MediaCache {
    pub fn new(root: PathBuf) -> Self {
        Self::with_write_budget(
            root,
            CacheWriteBudget::new(MEDIA_CACHE_IN_FLIGHT_BYTES, MEDIA_CACHE_IN_FLIGHT_WRITES),
        )
    }

    /// 自定义在途额度（供测试构造“额度耗尽”与“单笔额度”等边界）。
    pub fn with_write_budget(root: PathBuf, budget: CacheWriteBudget) -> Self {
        Self {
            inner: Arc::new(DiskCache::new(DiskCacheConfig {
                root,
                budget_bytes: MEDIA_CACHE_BUDGET_BYTES,
                sweep_interval_bytes: MEDIA_CACHE_SWEEP_INTERVAL_BYTES,
                ttl: MEDIA_CACHE_TTL,
                orphan_ttl: MEDIA_CACHE_ORPHAN_TTL,
                max_entry_bytes: MAX_SEGMENT_BYTES,
                committed_name: is_committed_cache_name,
            })),
            budget: Arc::new(budget),
        }
    }

    /// 试着为一个待缓存分片预留在途字节。不足则本次只转发不缓存。
    pub fn try_reserve(&self, bytes: u64) -> Option<CacheWriteReservation> {
        self.budget.try_reserve(bytes)
    }

    /// 当前在途的（字节，笔数）。
    #[cfg(test)]
    pub fn in_flight(&self) -> (u64, u64) {
        self.budget.in_flight()
    }

    pub fn root(&self) -> &std::path::Path {
        self.inner.root()
    }

    pub async fn get(&self, key: &str) -> Option<Vec<u8>> {
        self.inner.get(key).await
    }

    pub async fn put(&self, key: &str, bytes: &[u8]) {
        self.inner.put(key, bytes).await;
    }

    pub async fn usage(&self) -> crate::disk_cache::DiskCacheUsage {
        self.inner.usage().await
    }

    pub async fn clear(&self) -> crate::error::AppResult<()> {
        self.inner.clear().await
    }

    pub async fn ensure_root(&self) {
        self.inner.ensure_root().await;
    }
}

/// 解析 `Range: bytes=start-end` 与 `Content-Range: bytes start-end/total`。
///
/// 两者都必须**精确**解析：缓存键是字节区间，多一个字节或少一个字节都会让键
/// 落空，或者更糟 —— 让上游忽略 Range 返回的全量 body 被写进一个分片键里。
pub fn parse_range_bounds(value: &str) -> Option<(u64, u64)> {
    let value = value.trim();
    let value = value.strip_prefix("bytes=").unwrap_or(value);
    let (start, end) = value.split_once('-')?;
    let start = start.trim().parse::<u64>().ok()?;
    let end = end.trim().parse::<u64>().ok()?;
    (end >= start).then_some((start, end))
}

/// 校验上游的 `Content-Range` 与请求的字节区间完全一致。
///
/// 上游可能忽略 Range 直接返回 200 全量（这时 `Content-Range` 缺失），也可能
/// 返回 206 但给了一个不同的区间（代理/CDN 改写）。这两种情况都不能落盘 ——
/// 写进去的字节不属于那个键。
pub fn content_range_matches(content_range: Option<&str>, start: u64, end: u64) -> bool {
    let Some(content_range) = content_range else {
        return false;
    };
    // 单位必须是 bytes：没有单位的区间（或 `*`）不是我们请求的那段。
    let Some(rest) = content_range.trim().strip_prefix("bytes") else {
        return false;
    };
    let rest = rest.trim_start().trim_start_matches('=').trim_start();
    let Some((range, _total)) = rest.split_once('/') else {
        return false;
    };
    let Some((range_start, range_end)) = parse_range_bounds(range) else {
        return false;
    };
    range_start == start && range_end == end
}

/**
 * 代理转发路径持有的缓存句柄。
 *
 * `MediaCache` 本身已是 `Arc` 内的共享结构，这里不再套一层：代理的每个回环
 * 会话各持一份 clone，指向同一个根目录与同一组计数器。
 */
pub type SharedMediaCache = MediaCache;

#[cfg(test)]
#[cfg(test)]
mod tests {
    use super::{
        CacheWriteBudget, MediaCache, MediaCacheSpec, content_range_matches, parse_range_bounds,
    };

    fn cache_with_budget(max_bytes: u64, max_writes: u64) -> (MediaCache, std::path::PathBuf) {
        let root = std::env::temp_dir().join(format!(
            "rlive-media-cache-budget-{}",
            uuid::Uuid::new_v4().simple()
        ));
        (
            MediaCache::with_write_budget(
                root.clone(),
                CacheWriteBudget::new(max_bytes, max_writes),
            ),
            root,
        )
    }

    #[test]
    fn write_budget_grants_until_a_limit_is_hit_and_returns_on_drop() {
        let (cache, root) = cache_with_budget(100, 3);

        let first = cache.try_reserve(40).expect("额度内应获批");
        let second = cache.try_reserve(60).expect("刚好用满应获批");
        assert_eq!(cache.in_flight(), (100, 2));

        // 字节用满：不阻塞、直接拒绝，调用方本次不缓存。
        assert!(cache.try_reserve(1).is_none(), "超字节额度仍获批");
        drop(first);
        assert_eq!(cache.in_flight(), (60, 1));
        assert!(cache.try_reserve(40).is_some(), "归还后额度应可再用");

        // 笔数上限：字节还宽裕也要拦。
        let (small, small_root) = cache_with_budget(1 << 20, 2);
        let a = small.try_reserve(1).unwrap();
        let b = small.try_reserve(1).unwrap();
        assert!(small.try_reserve(1).is_none(), "超出在途笔数仍获批");
        drop((a, b));
        assert_eq!(small.in_flight(), (0, 0));

        // 单笔大于总额度：一开始就不该获批，也不占用笔数。
        let (tiny, tiny_root) = cache_with_budget(64, 4);
        assert!(tiny.try_reserve(65).is_none());
        assert_eq!(tiny.in_flight(), (0, 0));

        drop((second, cache));
        for root in [root, small_root, tiny_root] {
            let _ = std::fs::remove_dir_all(root);
        }
    }

    #[tokio::test]
    async fn reserved_segment_is_released_only_after_the_write_finishes() {
        let (cache, root) = cache_with_budget(64, 2);
        let reservation = cache.try_reserve(32).unwrap();
        assert_eq!(cache.in_flight(), (32, 1));

        // 额度持有的就是缓冲的生命周期：写盘结束、缓冲释放后才归还。
        cache
            .put("0123456789abcdef0123456789abcdef", &[7_u8; 32])
            .await;
        assert_eq!(cache.in_flight(), (32, 1), "写盘期间不得提前归还额度");
        drop(reservation);
        assert_eq!(cache.in_flight(), (0, 0));

        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn budget_exhaustion_skips_caching_instead_of_blocking_the_caller() {
        let (cache, root) = cache_with_budget(16, 1);
        let held = cache.try_reserve(16).unwrap();

        // 额度耗尽时只应拿到 None（转发路径据此不缓存），而不是等待。
        let started = std::time::Instant::now();
        assert!(cache.try_reserve(16).is_none());
        assert!(
            started.elapsed() < std::time::Duration::from_millis(50),
            "额度不足不得阻塞调用方"
        );

        drop(held);
        assert!(cache.try_reserve(16).is_some());
        drop(cache);
        let _ = std::fs::remove_dir_all(root);
    }

    fn spec() -> MediaCacheSpec {
        MediaCacheSpec::new(
            "BV1x:41855094127:112:v".to_string(),
            "video/mp4",
            vec![(0, 799), (800, 12_345)],
        )
    }

    #[test]
    fn only_exact_known_segments_are_cacheable() {
        let spec = spec();
        assert!(spec.key_for_range(0, 799).is_some());
        assert!(spec.key_for_range(800, 12_345).is_some());
        // 不是分片边界（子区间、跨片、越界）一律不缓存。
        assert!(spec.key_for_range(0, 400).is_none());
        assert!(spec.key_for_range(400, 799).is_none());
        assert!(spec.key_for_range(0, 12_345).is_none());
        assert!(spec.key_for_range(12_346, 13_000).is_none());
        assert!(spec.key_for_range(900, 800).is_none());
    }

    #[test]
    fn distinct_segments_get_distinct_keys() {
        let spec = spec();
        assert_ne!(
            spec.key_for_range(0, 799).unwrap(),
            spec.key_for_range(800, 12_345).unwrap()
        );
    }

    #[test]
    fn range_bounds_parse_strictly() {
        assert_eq!(parse_range_bounds("bytes=0-799"), Some((0, 799)));
        assert_eq!(parse_range_bounds("0-799"), Some((0, 799)));
        assert_eq!(parse_range_bounds("bytes=800-12345"), Some((800, 12_345)));
        // 无上界、非数字、倒序、缺少分隔一律拒绝。
        assert_eq!(parse_range_bounds("bytes=800-"), None);
        assert_eq!(parse_range_bounds("bytes=abc-799"), None);
        assert_eq!(parse_range_bounds("bytes=900-800"), None);
        assert_eq!(parse_range_bounds("bytes=800"), None);
        assert_eq!(parse_range_bounds(""), None);
    }

    #[test]
    fn only_matching_content_ranges_are_cacheable() {
        assert!(content_range_matches(Some("bytes 0-799/12346"), 0, 799));
        // 上游忽略 Range 返回 200 全量时没有 Content-Range。
        assert!(!content_range_matches(None, 0, 799));
        // 区间被改写过：写进去的字节不属于这个键。
        assert!(!content_range_matches(Some("bytes 0-12345/12346"), 0, 799));
        assert!(!content_range_matches(Some("bytes 0-798/12346"), 0, 799));
        assert!(!content_range_matches(Some("bytes 0-799"), 0, 799));
        assert!(!content_range_matches(Some("0-799/12346"), 0, 799));
    }
}
