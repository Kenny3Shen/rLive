//! 通用磁盘字节缓存：参数化的根目录、预算、生存期与提交命名校验。
//!
//! 图片缓存与媒体分片缓存共用同一套不变量，但预算、TTL 与「什么算有效内容」
//! 各不相同，因此把实现参数化放在这里，由调用方各自封装一层薄配置：
//!
//! 1. **tmp 写 + rename 提交**：直接写目标路径会让并发读者读到半个文件。
//! 2. **`usage` 是纯读路径**：它绝不能回收任何东西，否则会删掉别人正在写的临时
//!    文件，让那次 `put` 的 rename 静默拿到 NotFound。回收只属于 `sweep`。
//! 3. **`sweep` 带孤儿年龄阈值**：早于阈值的临时文件才是中断写入的残余。
//! 4. **Windows 的 rename 会拒绝已存在的目标**：赢得竞争的那个已经提交了，
//!    输的那个丢弃自己的临时文件即可，不算错误。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime};

use md5::{Digest, Md5};
use tokio::fs;

/// 每写过这么多次就清扫一次。
const SWEEP_WRITE_INTERVAL: u64 = 64;
/// 超预算时清扫到预算的这个百分比，避免每次只删一点点而反复触发。
const SWEEP_TARGET_PERCENT: u64 = 80;

/// 一份缓存的配置。
#[derive(Debug)]
pub struct DiskCacheConfig {
    /// 缓存根目录（本模块负责创建）。
    pub root: PathBuf,
    /// 已提交条目的总字节上限。
    pub budget_bytes: u64,
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
    writes: AtomicU64,
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
            writes: AtomicU64::new(0),
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

        let bytes = match fs::read(&path).await {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
            Err(error) => {
                tracing::debug!(error = %error, "disk cache read failed");
                return None;
            }
        };

        if metadata
            .modified()
            .ok()
            .and_then(|modified| SystemTime::now().duration_since(modified).ok())
            .is_some_and(|age| age > self.config.ttl)
        {
            // 过期条目当作未命中：读路径不删文件，回收留给 sweep。
            return None;
        }
        Some(bytes)
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

        let temporary = parent.join(format!("{key}.tmp"));
        if let Err(error) = fs::write(&temporary, bytes).await {
            tracing::debug!(error = %error, "write disk cache temporary file failed");
            let _ = fs::remove_file(&temporary).await;
            return;
        }

        let committed = match fs::rename(&temporary, &path).await {
            Ok(()) => true,
            Err(error) => {
                // Windows 上 rename 会拒绝已存在的目标。如果是另一个请求赢得了竞争，
                // 期望的缓存条目已经存在，直接丢弃临时文件即可。
                let target_exists = fs::metadata(&path).await.is_ok();
                if !target_exists {
                    tracing::debug!(error = %error, "commit disk cache file failed");
                }
                let _ = fs::remove_file(&temporary).await;
                target_exists
            }
        };

        if committed {
            let writes = self.writes.fetch_add(1, Ordering::Relaxed) + 1;
            if writes.is_multiple_of(SWEEP_WRITE_INTERVAL) {
                self.sweep().await;
            }
        }
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
        self.writes.store(0, Ordering::Relaxed);
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
    use super::{DiskCache, DiskCacheConfig, disk_cache_key, is_committed_cache_name};
    use std::fs::OpenOptions;
    use std::time::{Duration, SystemTime};
    use uuid::Uuid;

    fn test_root() -> std::path::PathBuf {
        std::env::temp_dir().join(format!("rlive-disk-cache-test-{}", Uuid::new_v4().simple()))
    }

    fn cache(root: std::path::PathBuf) -> DiskCache {
        DiskCache::new(DiskCacheConfig {
            root,
            budget_bytes: 1 << 20,
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
        let stale = directory.join(format!("{stale_key}.tmp"));
        let fresh = directory.join(format!("{fresh_key}.tmp"));
        let unrelated = directory.join("keep-me.txt");
        for path in [&stale, &fresh, &unrelated] {
            std::fs::write(path, b"partial").unwrap();
        }
        set_modified(&stale, Duration::from_secs(120));
        set_modified(&unrelated, Duration::from_secs(120));

        let usage = cache.usage().await;
        assert_eq!(usage.files, 1, "usage 不得把临时文件计入已提交条目");
        assert!(stale.exists(), "usage 回收了陈旧临时文件");
        assert!(fresh.exists(), "usage 删掉了正在写入的临时文件");

        cache.sweep().await;
        assert!(!stale.exists(), "陈旧临时文件未被 sweep 回收");
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
}
