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
}

impl MediaCache {
    pub fn new(root: PathBuf) -> Self {
        Self {
            inner: Arc::new(DiskCache::new(DiskCacheConfig {
                root,
                budget_bytes: MEDIA_CACHE_BUDGET_BYTES,
                ttl: MEDIA_CACHE_TTL,
                orphan_ttl: MEDIA_CACHE_ORPHAN_TTL,
                max_entry_bytes: MAX_SEGMENT_BYTES,
                committed_name: is_committed_cache_name,
            })),
        }
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
mod tests {
    use super::{MediaCacheSpec, content_range_matches, parse_range_bounds};

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
