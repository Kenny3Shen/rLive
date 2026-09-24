//! 通用磁盘字节缓存：参数化的根目录、预算、生存期与提交命名校验。
//!
//! 图片缓存与媒体分片缓存共用同一套不变量，但预算、TTL 与「什么算有效内容」
//! 各不相同，因此把实现参数化放在这里，由调用方各自封装一层薄配置：
//!
//! 1. **tmp 写 + rename 提交**：直接写目标路径会让并发读者读到半个文件。
//! 2. **`usage` 是纯读路径**：它绝不能回收任何东西，否则会删掉别人正在写的临时
//!    文件，让那次 `put` 的 rename 静默拿到 NotFound。回收只属于 `sweep`。
//! 3. **`sweep` 带孤儿年龄阈值**：早于阈值的临时文件才是中断写入的残余。
//! 4. **每次写入独占临时文件**：完整写入并关闭后才 rename，失败只清理自身临时文件。
//!    Windows 的 rename 同样支持替换已存在的文件，不应先删除目标再提交。
//! 5. **清扫按字节触发且单飞**：预算是字节，用提交次数当触发器会让大小悬殊的条目
//!    在两次清扫之间积累出远超预算的占用；同时只允许一个清扫在跑，其余写入直接返回，
//!    不排队。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, SystemTime};

use md5::{Digest, Md5};
use tokio::fs;
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

/// 超预算时清扫到预算的这个百分比，避免每次只删一点点而反复触发。
const SWEEP_TARGET_PERCENT: u64 = 80;

/// 一份缓存的配置。
#[derive(Debug)]
pub struct DiskCacheConfig {
    /// 缓存根目录（本模块负责创建）。
    pub root: PathBuf,
    /// 已提交条目的总字节上限。
    pub budget_bytes: u64,
    /// 自上次清扫起新提交多少字节就再清扫一次。
    ///
    /// 为什么是字节而不是次数：单条目上限可以比平均条目大上两三个数量级，
    /// 按次数触发时「两次清扫之间的最大占用」是 `间隔 × 单条上限`，与预算无关。
    pub sweep_interval_bytes: u64,
    /// 已提交条目的生存期。
    pub ttl: Duration,
    /// 单个临时文件被视为「中断写入的残余」所需的年龄。
    pub orphan_ttl: Duration,
    /// 单条目最大字节数；超过不写。
    pub max_entry_bytes: u64,
    /// 已提交条目的文件名校验（键是纯十六进制，因此不含路径分隔符）。
    pub committed_name: fn(&str) -> bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DiskCacheUsage {
    pub bytes: u64,
    pub files: u64,
}

#[derive(Debug)]
pub struct DiskCache {
    config: DiskCacheConfig,
    /// 自上次清扫起新提交的字节数。
    pending_bytes: AtomicU64,
    /// 清扫单飞门：同时只让一个清扫遍历目录。
    sweeping: AtomicBool,
    /// 仅测试：读取缓存正文的次数，用于证明 TTL 判定在读正文之前。
    #[cfg(test)]
    body_reads: AtomicU64,
}

#[derive(Debug)]
struct CacheEntry {
    path: PathBuf,
    bytes: u64,
    modified: SystemTime,
    /// 文件名通过 `committed_name` 校验，即 rename 已经提交。
    /// 其余是中断写入留下的临时文件，只有 sweep 才有权回收。
    committed: bool,
}

impl DiskCache {
    pub fn new(config: DiskCacheConfig) -> Self {
        Self {
            config,
            pending_bytes: AtomicU64::new(0),
            sweeping: AtomicBool::new(false),
            #[cfg(test)]
            body_reads: AtomicU64::new(0),
        }
    }

    pub fn root(&self) -> &Path {
        &self.config.root
    }

    /// 读一个已提交条目。缺失、过大或读失败一律返回 None —— 缓存是尽力而为的。
    pub async fn get(&self, key: &str) -> Option<Vec<u8>> {
        let path = self.path_for(key);
        let metadata = match fs::metadata(&path).await {
            Ok(metadata) if metadata.is_file() && metadata.len() <= self.config.max_entry_bytes => {
                metadata
            }
            Ok(_) => return None,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
            Err(error) => {
                tracing::debug!(error = %error, "disk cache metadata read failed");
                return None;
            }
        };

        if metadata
            .modified()
            .ok()
            .and_then(|modified| SystemTime::now().duration_since(modified).ok())
            .is_some_and(|age| age > self.config.ttl)
        {
            // 在读正文**之前**就判过期：否则一个 32MiB 的过期分片会先被完整读进内存
            // 再丢掉。过期条目当作未命中：读路径不删文件，回收留给 sweep。
            return None;
        }

        #[cfg(test)]
        self.body_reads.fetch_add(1, Ordering::Relaxed);
        match fs::read(&path).await {
            Ok(bytes) => Some(bytes),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => {
                tracing::debug!(error = %error, "disk cache read failed");
                None
            }
        }
    }

    pub async fn put(&self, key: &str, bytes: &[u8]) {
        if bytes.len() as u64 > self.config.max_entry_bytes {
            return;
        }

        let path = self.path_for(key);
        let Some(parent) = path.parent() else {
            return;
        };
        if let Err(error) = fs::create_dir_all(parent).await {
            tracing::debug!(error = %error, "create disk cache directory failed");
            return;
        }

        // UUID 隔离同键并发写入；create_new 确保只有创建成功者拥有该临时文件。
        let temporary = parent.join(format!("{key}.{}.tmp", Uuid::new_v4().simple()));
        let mut file = match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .await
        {
            Ok(file) => file,
            Err(error) => {
                // 创建失败时尚未取得所有权，不得清理可能属于其他写入者的文件。
                tracing::debug!(error = %error, "create disk cache temporary file failed");
                return;
            }
        };
        let written = async {
            file.write_all(bytes).await?;
            file.flush().await
        }
        .await;
        // 等待 Tokio 的后台文件操作结束并关闭句柄，再提交或清理（含 Windows）。
        drop(file.into_std().await);
        if let Err(error) = written {
            tracing::debug!(error = %error, "write disk cache temporary file failed");
            let _ = fs::remove_file(&temporary).await;
            return;
        }

        let committed = match fs::rename(&temporary, &path).await {
            Ok(()) => true,
            Err(error) => {
                // std::fs::rename 在 Windows 上也支持替换已有文件。
                // 权限或共享冲突等失败只丢弃自身临时文件，绝不先删除已提交目标。
                tracing::debug!(error = %error, "commit disk cache file failed");
                let _ = fs::remove_file(&temporary).await;
                false
            }
        };

        if committed {
            let pending = self
                .pending_bytes
                .fetch_add(bytes.len() as u64, Ordering::Relaxed)
                + bytes.len() as u64;
            if pending >= self.config.sweep_interval_bytes {
                self.sweep_if_idle().await;
            }
        }
    }

    /// 按字节触发的单飞清扫。
    ///
    /// 已有清扫在跑时直接返回：本方法在写入路径上，排队等另一次目录遍历
    /// 只会把后台写队堆得更长，而待清扫字节不清零，下一次写入会再试。
    async fn sweep_if_idle(&self) {
        if self
            .sweeping
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return;
        }
        // 守卫而不是手写释放：后台写任务可能被 abort，这个 future 会被直接 drop。
        struct Guard<'a>(&'a AtomicBool);
        impl Drop for Guard<'_> {
            fn drop(&mut self) {
                self.0.store(false, Ordering::Release);
            }
        }
        let _guard = Guard(&self.sweeping);
        self.pending_bytes.store(0, Ordering::Relaxed);
        self.sweep().await;
    }

    /// 只报告已提交的缓存条目。中断写入留下的临时文件不计入：
    /// 它们是下一次清扫会回收的垃圾，不是用户能受益的缓存内容。
    pub async fn usage(&self) -> DiskCacheUsage {
        let entries = self.snapshot().await;
        let mut bytes = 0_u64;
        let mut files = 0_u64;
        for entry in entries.iter().filter(|entry| entry.committed) {
            bytes = bytes.saturating_add(entry.bytes);
            files += 1;
        }
        DiskCacheUsage { bytes, files }
    }

    pub async fn clear(&self) -> crate::error::AppResult<()> {
        match fs::remove_dir_all(&self.config.root).await {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(crate::error::AppError::new(
                    "disk_cache_clear",
                    format!("清除缓存失败: {error}"),
                ));
            }
        }
        // 重建（现已为空的）目录，使 `usage` 报告的路径仍可从设置页打开浏览。
        self.ensure_root().await;
        self.pending_bytes.store(0, Ordering::Relaxed);
        Ok(())
    }

    /// 尽力而为：缓存自身会在写入时创建所需目录，但设置页可能在任何内容被缓存
    /// 之前就提供打开该目录的入口。
    pub async fn ensure_root(&self) {
        if let Err(error) = fs::create_dir_all(&self.config.root).await {
            tracing::debug!(error = %error, "create disk cache root failed");
        }
    }

    pub async fn sweep(&self) {
        let now = SystemTime::now();
        let cutoff = now
            .checked_sub(self.config.ttl)
            .unwrap_or(SystemTime::UNIX_EPOCH);
        let orphan_cutoff = now
            .checked_sub(self.config.orphan_ttl)
            .unwrap_or(SystemTime::UNIX_EPOCH);
        let snapshot = self.snapshot().await;
        let mut survivors = Vec::new();
        let mut total = 0_u64;

        for entry in snapshot {
            // 未提交的临时文件不占预算（它们不是可用缓存），够老就回收。
            if !entry.committed {
                if entry.modified < orphan_cutoff {
                    remove_entry(&entry.path).await;
                }
                continue;
            }
            if entry.modified < cutoff && remove_entry(&entry.path).await {
                continue;
            }
            total = total.saturating_add(entry.bytes);
            survivors.push(entry);
        }

        if total <= self.config.budget_bytes {
            return;
        }

        survivors.sort_by_key(|entry| entry.modified);
        let target = self
            .config
            .budget_bytes
            .saturating_mul(SWEEP_TARGET_PERCENT)
            / 100;
        for entry in survivors {
            if total <= target {
                break;
            }
            if remove_entry(&entry.path).await {
                total = total.saturating_sub(entry.bytes);
            }
        }
    }

    fn path_for(&self, key: &str) -> PathBuf {
        // 键是 32 位十六进制，前两位分桶避免单目录上万文件。
        self.config.root.join(&key[..2]).join(key)
    }

    /// 在一个阻塞任务里遍历两层缓存树。目录可能持有数千个文件，而 `tokio::fs`
    /// 遍历会为每次 `read_dir` 和每次 `metadata` 分别派发一个阻塞任务。
    async fn snapshot(&self) -> Vec<CacheEntry> {
        let root = self.config.root.clone();
        let committed_name = self.config.committed_name;
        tokio::task::spawn_blocking(move || collect_snapshot(&root, committed_name))
            .await
            .unwrap_or_default()
    }
}

fn collect_snapshot(root: &Path, committed_name: fn(&str) -> bool) -> Vec<CacheEntry> {
    let mut entries = Vec::new();
    let directories = match std::fs::read_dir(root) {
        Ok(directories) => directories,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return entries,
        Err(error) => {
            tracing::debug!(error = %error, "read disk cache directory failed");
            return entries;
        }
    };

    for directory in directories {
        let directory = match directory {
            Ok(directory) => directory,
            Err(error) => {
                tracing::debug!(error = %error, "read disk cache subdirectory failed");
                continue;
            }
        };
        let is_directory = match directory.file_type() {
            Ok(file_type) => file_type.is_dir(),
            Err(error) => {
                tracing::debug!(error = %error, "read disk cache entry type failed");
                false
            }
        };
        if !is_directory {
            continue;
        }

        let files = match std::fs::read_dir(directory.path()) {
            Ok(files) => files,
            Err(error) => {
                tracing::debug!(error = %error, "read disk cache files failed");
                continue;
            }
        };
        for file in files {
            let file = match file {
                Ok(file) => file,
                Err(error) => {
                    tracing::debug!(error = %error, "read disk cache file entry failed");
                    continue;
                }
            };
            let name = file.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            // 遍历是纯读路径：在这里删文件会把别人正在写入的临时文件删掉。
            let committed = committed_name(name);
            let metadata = match file.metadata() {
                Ok(metadata) if metadata.is_file() => metadata,
                Ok(_) => continue,
                Err(error) => {
                    tracing::debug!(error = %error, "read disk cache file metadata failed");
                    continue;
                }
            };
            entries.push(CacheEntry {
                path: file.path(),
                bytes: metadata.len(),
                modified: metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                committed,
            });
        }
    }
    entries
}

/// 缓存键：内容的 MD5 十六进制摘要。
///
/// 摘要只是缓存键，不是安全边界：调用方在写入前已校验过内容来源，而纯十六进制
/// 的路径不可能包含用户可控的路径分隔符。
pub fn disk_cache_key(identity: &str) -> String {
    hex::encode(Md5::digest(identity.as_bytes()))
}

/// 缓存文件名的校验：32 位纯十六进制（即 [`disk_cache_key`] 的产物）。
pub fn is_committed_cache_name(value: &str) -> bool {
    value.len() == 32 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

async fn remove_entry(path: &Path) -> bool {
    match fs::remove_file(path).await {
        Ok(()) => true,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
        Err(error) => {
            tracing::debug!(error = %error, "remove disk cache file failed");
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        DiskCache, DiskCacheConfig, SWEEP_TARGET_PERCENT, disk_cache_key, is_committed_cache_name,
    };
    use std::fs::OpenOptions;
    use std::sync::Arc;
    use std::sync::atomic::Ordering;
    use std::time::{Duration, SystemTime};
    use tokio::sync::Barrier;
    use tokio::task::JoinSet;
    use uuid::Uuid;

    fn test_root() -> std::path::PathBuf {
        std::env::temp_dir().join(format!("rlive-disk-cache-test-{}", Uuid::new_v4().simple()))
    }

    fn cache(root: std::path::PathBuf) -> DiskCache {
        DiskCache::new(DiskCacheConfig {
            root,
            budget_bytes: 1 << 20,
            sweep_interval_bytes: 1 << 20,
            ttl: Duration::from_secs(3600),
            orphan_ttl: Duration::from_secs(60),
            max_entry_bytes: 4096,
            committed_name: is_committed_cache_name,
        })
    }

    fn set_modified(path: &std::path::Path, age: Duration) {
        OpenOptions::new()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(SystemTime::now() - age)
            .unwrap();
    }

    #[test]
    fn cache_key_is_hex_only() {
        let key = disk_cache_key("BV1x:41:v:0-1023");
        assert_eq!(key.len(), 32);
        assert!(is_committed_cache_name(&key));
        assert!(!key.contains('/'));
        assert!(!key.contains('\\'));
    }

    #[tokio::test]
    async fn put_get_usage_and_clear_round_trip() {
        let root = test_root();
        let cache = cache(root.clone());
        let bytes = b"segment-bytes";

        cache.put(&disk_cache_key("a"), bytes).await;
        assert_eq!(cache.get(&disk_cache_key("a")).await, Some(bytes.to_vec()));
        assert_eq!(cache.get(&disk_cache_key("missing")).await, None);
        let usage = cache.usage().await;
        assert_eq!(usage.bytes, bytes.len() as u64);
        assert_eq!(usage.files, 1);

        cache.clear().await.unwrap();
        assert_eq!(cache.usage().await.files, 0);
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn put_replaces_existing_entry_with_complete_contents() {
        let root = test_root();
        let cache = cache(root.clone());
        let key = disk_cache_key("replaced");
        for bytes in [vec![1; 4096], vec![2; 1], vec![3; 2047]] {
            cache.put(&key, &bytes).await;
            assert_eq!(cache.get(&key).await, Some(bytes));
            let entries = cache.snapshot().await;
            assert_eq!(entries.len(), 1, "提交后不得残留临时文件");
            assert!(entries[0].committed);
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_same_key_puts_and_reads_keep_complete_candidates() {
        let root = test_root();
        let cache = Arc::new(cache(root.clone()));
        let key = disk_cache_key("concurrent");
        let candidates = Arc::new(
            [1, 17, 127, 255, 1023, 2047, 4095, 4096]
                .into_iter()
                .enumerate()
                .map(|(index, len)| vec![index as u8 + 1; len])
                .collect::<Vec<_>>(),
        );
        // 先提交一个候选，让并发读不仅检查完整性，也检查替换期间没有缺失窗口。
        cache.put(&key, &candidates[0]).await;
        let barrier = Arc::new(Barrier::new(candidates.len() + 1));
        let mut writers = JoinSet::new();
        for index in 0..candidates.len() {
            let cache = Arc::clone(&cache);
            let candidates = Arc::clone(&candidates);
            let barrier = Arc::clone(&barrier);
            let key = key.clone();
            writers.spawn(async move {
                barrier.wait().await;
                for _ in 0..16 {
                    cache.put(&key, &candidates[index]).await;
                    let bytes = cache.get(&key).await.expect("提交后缓存条目不得缺失");
                    assert!(candidates.contains(&bytes), "提交后读到了截断或混合内容");
                }
            });
        }
        barrier.wait().await;
        while !writers.is_empty() {
            let bytes = cache.get(&key).await.expect("并发替换时缓存条目不得缺失");
            assert!(candidates.contains(&bytes), "并发读到了截断或混合内容");
            while let Some(result) = writers.try_join_next() {
                result.unwrap();
            }
        }
        let bytes = cache.get(&key).await.unwrap();
        assert!(candidates.contains(&bytes), "最终条目不是完整候选");
        let entries = cache.snapshot().await;
        assert_eq!(entries.len(), 1, "并发提交后不得残留临时文件");
        assert!(entries[0].committed);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn failed_commit_only_removes_its_own_temporary_file() {
        let root = test_root();
        let cache = cache(root.clone());
        let key = disk_cache_key("blocked");
        let target = cache.path_for(&key);
        // 以目录阻止文件提交，确保失败路径不会删除目标或其他写入者的临时文件。
        std::fs::create_dir_all(&target).unwrap();
        let foreign = target
            .parent()
            .unwrap()
            .join(format!("{key}.{}.tmp", Uuid::new_v4().simple()));
        std::fs::write(&foreign, b"in-flight").unwrap();

        cache.put(&key, b"cannot-commit").await;

        assert!(target.is_dir(), "提交失败不得删除目标");
        assert_eq!(std::fs::read(&foreign).unwrap(), b"in-flight");
        let entries = cache.snapshot().await;
        assert_eq!(entries.len(), 1, "提交失败未清理自身临时文件");
        assert_eq!(entries[0].path, foreign);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn expired_entries_read_as_misses_but_survive_until_sweep() {
        let root = test_root();
        let cache = cache(root.clone());
        let key = disk_cache_key("expiring");
        cache.put(&key, b"old").await;
        set_modified(&root.join(&key[..2]).join(&key), Duration::from_secs(7200));

        // 读路径不删文件：它可能被并发使用，回收只属于 sweep。
        assert_eq!(cache.get(&key).await, None);
        cache.sweep().await;
        assert_eq!(cache.usage().await.files, 0);
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn entries_beyond_max_size_are_not_stored() {
        let root = test_root();
        let cache = cache(root.clone());
        let key = disk_cache_key("huge");
        cache.put(&key, &[7_u8; 8192]).await;
        assert_eq!(cache.get(&key).await, None);
        assert_eq!(cache.usage().await.files, 0);
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn usage_never_reclaims_and_sweep_only_reclaims_old_orphans() {
        let root = test_root();
        let cache = cache(root.clone());
        let kept = disk_cache_key("kept");
        cache.put(&kept, b"kept-bytes").await;

        let stale_key = disk_cache_key("interrupted");
        let fresh_key = disk_cache_key("in-flight");
        let directory = root.join(&stale_key[..2]);
        std::fs::create_dir_all(&directory).unwrap();
        let stale = directory.join(format!("{stale_key}.{}.tmp", Uuid::new_v4().simple()));
        let fresh = directory.join(format!("{fresh_key}.{}.tmp", Uuid::new_v4().simple()));
        let legacy = directory.join(format!("{stale_key}.tmp"));
        let unrelated = directory.join("keep-me.txt");
        for path in [&stale, &fresh, &legacy, &unrelated] {
            std::fs::write(path, b"partial").unwrap();
        }
        set_modified(&stale, Duration::from_secs(120));
        set_modified(&legacy, Duration::from_secs(120));
        set_modified(&unrelated, Duration::from_secs(120));

        let usage = cache.usage().await;
        assert_eq!(usage.files, 1, "usage 不得把临时文件计入已提交条目");
        assert_eq!(usage.bytes, b"kept-bytes".len() as u64);
        assert!(stale.exists(), "usage 回收了陈旧临时文件");
        assert!(legacy.exists(), "usage 回收了旧命名临时文件");
        assert!(fresh.exists(), "usage 删掉了正在写入的临时文件");

        cache.sweep().await;
        assert!(!stale.exists(), "陈旧临时文件未被 sweep 回收");
        assert!(!legacy.exists(), "旧命名临时文件未被 sweep 回收");
        assert!(fresh.exists(), "sweep 回收了可能正在写入的新鲜临时文件");
        // 与图片缓存不同，磁盘缓存的目录是本模块独占的：无缓存命名的陈旧文件
        // 同样是写入中断留下的残余，sweep 一并回收。
        assert!(!unrelated.exists(), "sweep 保留了无缓存命名的陈旧文件");
        assert_eq!(cache.usage().await.files, 1);
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn sweep_reclaims_oldest_entries_beyond_budget() {
        let root = test_root();
        let mut cache = cache(root.clone());
        // 预算压到只容得下最新的一条。
        cache.config.budget_bytes = 8;
        let old = disk_cache_key("old");
        let middle = disk_cache_key("middle");
        let new = disk_cache_key("new");
        for key in [&old, &middle, &new] {
            cache.put(key, b"12345").await;
        }
        set_modified(&root.join(&old[..2]).join(&old), Duration::from_secs(300));
        set_modified(
            &root.join(&middle[..2]).join(&middle),
            Duration::from_secs(200),
        );
        set_modified(&root.join(&new[..2]).join(&new), Duration::from_secs(60));

        cache.sweep().await;
        assert_eq!(cache.get(&old).await, None);
        assert_eq!(cache.get(&middle).await, None);
        assert!(cache.get(&new).await.is_some());
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn sweep_is_triggered_by_bytes_written_not_by_entry_count() {
        let root = test_root();
        let mut cache = cache(root.clone());
        // 预算保持宽裕，只观察「字节累计到阈值才清扫」这一行为；
        // 过期条目是清扫是否真的发生的可观测证据（读路径不删文件）。
        cache.config.sweep_interval_bytes = 4096;

        let expired = disk_cache_key("expired");
        cache.put(&expired, b"old").await;
        set_modified(
            &root.join(&expired[..2]).join(&expired),
            Duration::from_secs(7200),
        );
        assert_eq!(cache.usage().await.files, 1);

        // 未达触发阈值：即使条数在增长也不清扫。
        for (index, bytes) in [(0_u8, 1024_usize), (1, 1024)] {
            cache
                .put(&disk_cache_key(&format!("k{index}")), &vec![index; bytes])
                .await;
            assert_eq!(
                cache.usage().await.files,
                index as u64 + 2,
                "未达字节阈值就触发了清扫（写第 {index} 条后）"
            );
        }

        // 累计到 4096 字节：本次 put 内触发清扫，过期条目被回收。
        // 若未清扫，这里会是 4 条（过期条 + k0 + k1 + k2）。
        cache.put(&disk_cache_key("k2"), &vec![2_u8; 2048]).await;
        assert_eq!(
            cache.usage().await.files,
            3,
            "达到字节阈值仍未清扫：过期条目未被回收"
        );
        assert!(
            !root.join(&expired[..2]).join(&expired).exists(),
            "过期条目文件未被清扫删除"
        );
        assert_eq!(
            cache.pending_bytes.load(Ordering::Relaxed),
            0,
            "清扫后待清扫字节应归零"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn concurrent_sweeps_do_not_stack_up() {
        let root = test_root();
        let mut owned = cache(root.clone());
        owned.config.sweep_interval_bytes = 1;
        let cache = Arc::new(owned);
        for index in 0..8_u8 {
            cache
                .put(&disk_cache_key(&format!("k{index}")), &[index; 16])
                .await;
        }

        // 单飞门已在前面串行写入中释放；这里直接验证并发调用不会互相卡住。
        let barrier = Arc::new(Barrier::new(6));
        let mut sweeps = JoinSet::new();
        for _ in 0..6 {
            let cache = Arc::clone(&cache);
            let barrier = Arc::clone(&barrier);
            sweeps.spawn(async move {
                barrier.wait().await;
                cache.sweep_if_idle().await;
            });
        }
        while let Some(result) = sweeps.join_next().await {
            result.unwrap();
        }
        assert!(!cache.sweeping.load(Ordering::Acquire), "清扫门未释放");
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn expired_entries_are_rejected_before_reading_the_body() {
        let root = test_root();
        let cache = cache(root.clone());
        let key = disk_cache_key("expired-body");
        cache.put(&key, b"stale-bytes").await;
        set_modified(&root.join(&key[..2]).join(&key), Duration::from_secs(7200));
        let reads_before = cache.body_reads.load(Ordering::Relaxed);

        assert_eq!(cache.get(&key).await, None);

        assert_eq!(
            cache.body_reads.load(Ordering::Relaxed),
            reads_before,
            "过期条目不得先读正文再丢弃"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    /// 清扫开销与占用规模的关系。默认 ignore：绝对耗时依赖机器与磁盘。
    ///
    /// `cargo test -p rlive sweep_cost_scaling --lib -- --ignored --nocapture`
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "规模测量，手动跑"]
    async fn sweep_cost_scaling() {
        // 每轮从空目录开始，使打印的耗时确实对应“目录里有 count 个条目时的清扫开销”。
        for count in [500_usize, 2_000, 8_000] {
            let root = test_root();
            let mut cache = cache(root.clone());
            // 预算故意设小，让每次清扫都要真的删一批而不是空跑。
            cache.config.budget_bytes = 128 * 1024;
            for index in 0..count {
                cache
                    .put(&disk_cache_key(&format!("entry-{index}")), &[7_u8; 512])
                    .await;
            }
            let at = std::time::Instant::now();
            cache.sweep().await;
            let elapsed = at.elapsed().as_secs_f64() * 1000.0;
            let usage = cache.usage().await;
            println!(
                "entries={count} sweep={elapsed:.1}ms remaining_bytes={} remaining_files={}",
                usage.bytes, usage.files
            );
            assert!(
                usage.bytes <= cache.config.budget_bytes * SWEEP_TARGET_PERCENT / 100,
                "清扫后未回到预算目标线"
            );
            let _ = std::fs::remove_dir_all(root);
        }
    }

    #[tokio::test]
    async fn a_single_oversized_entry_cannot_overshoot_the_budget_by_a_full_interval() {
        // 旧形态用「每 64 次提交」触发清扫，两次清扫间最多新增 63 × 单条上限；
        // 现在触发量是字节，写满一个间隔就会清扫。
        let root = test_root();
        let mut cache = cache(root.clone());
        cache.config.max_entry_bytes = 1024;
        cache.config.budget_bytes = 1024;
        cache.config.sweep_interval_bytes = 2048;

        for index in 0..4_u8 {
            cache
                .put(&disk_cache_key(&format!("big{index}")), &[index; 1024])
                .await;
        }

        let usage = cache.usage().await;
        assert!(
            usage.bytes <= 2048,
            "两次清扫之间的占用超出触发间隔: {} 字节",
            usage.bytes
        );
        let _ = std::fs::remove_dir_all(root);
    }
}
