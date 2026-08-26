//! 远程图片内容的尽力而为持久缓存。
//!
//! 缓存文件保存原始图片字节，并以已加入白名单的上游 URL 的 MD5 摘要作为
//! 文件名。摘要只是缓存键，不是安全边界：
//! 代理在本模块被调用前已校验上游主机，
//! 且纯十六进制的路径不可能包含用户可控的路径分隔符。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, SystemTime};

use md5::{Digest, Md5};
use serde::Serialize;
use tokio::fs;
use uuid::Uuid;

/// 让图片代理的内存响应上限与缓存条目上限保持一致。
pub const MAX_IMAGE_BYTES: usize = 16 * 1024 * 1024;

#[cfg(target_os = "android")]
const CACHE_BUDGET_BYTES: u64 = 64 * 1024 * 1024;
#[cfg(not(target_os = "android"))]
const CACHE_BUDGET_BYTES: u64 = 256 * 1024 * 1024;

const CACHE_TTL: Duration = Duration::from_secs(30 * 24 * 60 * 60);
const TOUCH_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);
/// `put` 至多写 `MAX_IMAGE_BYTES` 并立即提交，因此早于该时限的临时文件
/// 不可能属于进行中的写入：它是某个进程死在 `write` 与 `rename`
/// 之间留下的残余。
const ORPHAN_TTL: Duration = Duration::from_secs(60 * 60);
const TEMPORARY_SUFFIX: &str = ".tmp-";
const SWEEP_WRITE_INTERVAL: u64 = 64;
const SWEEP_TARGET_PERCENT: u64 = 80;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct CacheUsage {
    pub bytes: u64,
    pub files: u64,
    pub path: String,
}

#[derive(Debug)]
pub struct ImageCache {
    root: PathBuf,
    writes: AtomicU64,
    sweeping: AtomicBool,
}

#[derive(Debug)]
struct CacheEntry {
    path: PathBuf,
    bytes: u64,
    modified: SystemTime,
}

/// 缓存目录中的全部内容。已提交条目是 `usage` 报告并受预算约束的部分；
/// 孤儿文件是中断写入产生的临时文件，单独跟踪以便清扫时回收。
#[derive(Debug, Default)]
struct CacheSnapshot {
    entries: Vec<CacheEntry>,
    orphans: Vec<CacheEntry>,
}

impl ImageCache {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            writes: AtomicU64::new(0),
            sweeping: AtomicBool::new(false),
        }
    }

    pub async fn get(&self, url: &str) -> Option<(Vec<u8>, &'static str)> {
        let path = self.path_for(url);
        let metadata = match fs::metadata(&path).await {
            Ok(metadata) if metadata.is_file() && metadata.len() <= MAX_IMAGE_BYTES as u64 => {
                metadata
            }
            Ok(_) => return None,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
            Err(error) => {
                tracing::debug!(error = %error, "image cache metadata read failed");
                return None;
            }
        };

        let bytes = match fs::read(&path).await {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
            Err(error) => {
                tracing::debug!(error = %error, "image cache read failed");
                return None;
            }
        };
        let content_type = match sniff_image_type(&bytes) {
            Some(content_type) => content_type,
            None => {
                let _ = fs::remove_file(&path).await;
                return None;
            }
        };

        if metadata
            .modified()
            .ok()
            .and_then(|modified| SystemTime::now().duration_since(modified).ok())
            .is_some_and(|age| age > TOUCH_INTERVAL)
        {
            touch_file(path.clone()).await;
        }

        Some((bytes, content_type))
    }

    pub async fn put(&self, url: &str, bytes: &[u8]) {
        if bytes.len() > MAX_IMAGE_BYTES || sniff_image_type(bytes).is_none() {
            return;
        }

        let key = cache_key(url);
        let path = self.path_for_key(&key);
        let Some(parent) = path.parent() else {
            return;
        };
        if let Err(error) = fs::create_dir_all(parent).await {
            tracing::debug!(error = %error, "create image cache directory failed");
            return;
        }

        let temporary = parent.join(temporary_file_name(&key));
        if let Err(error) = fs::write(&temporary, bytes).await {
            tracing::debug!(error = %error, "write image cache temporary file failed");
            let _ = fs::remove_file(&temporary).await;
            return;
        }

        let committed = match fs::rename(&temporary, &path).await {
            Ok(()) => true,
            Err(error) => {
                // Windows 上 rename 会拒绝已存在的目标。如果是另一个请求赢得了竞争，
                // 期望的缓存条目已经存在，
                // 直接丢弃临时文件即可。
                let target_exists = fs::metadata(&path).await.is_ok();
                if !target_exists {
                    tracing::debug!(error = %error, "commit image cache file failed");
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
    /// 它们是下一次清扫会回收的垃圾，
    /// 不是用户能受益的缓存内容。
    pub async fn usage(&self) -> CacheUsage {
        let entries = self.snapshot().await.entries;
        CacheUsage {
            bytes: entries
                .iter()
                .fold(0_u64, |total, entry| total.saturating_add(entry.bytes)),
            files: entries.len() as u64,
            // 根目录已被规范化，因此在 Windows 上带有 `\\?\` verbatim 前缀，
            // 不能让它进入 UI 或原生对话框。
            path: crate::app_paths::path_to_string(&self.root),
        }
    }

    pub async fn clear(&self) -> crate::error::AppResult<()> {
        match fs::remove_dir_all(&self.root).await {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(crate::error::AppError::new(
                    "image_cache_clear",
                    format!("清除图片缓存失败: {error}"),
                ));
            }
        }
        // 重建（现已为空的）目录，使 `usage` 报告的路径
        // 仍可从设置页打开浏览。
        self.ensure_root().await;
        self.writes.store(0, Ordering::Relaxed);
        Ok(())
    }

    /// 尽力而为：缓存自身会在写入时创建所需目录，
    /// 但设置页可能在任何内容被缓存之前就提供打开该目录的入口。
    pub(crate) async fn ensure_root(&self) {
        if let Err(error) = fs::create_dir_all(&self.root).await {
            tracing::debug!(error = %error, "create image cache root failed");
        }
    }

    pub(crate) async fn sweep(&self) {
        self.sweep_with_budget(CACHE_BUDGET_BYTES).await;
    }

    async fn sweep_with_budget(&self, budget: u64) {
        if self
            .sweeping
            .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
            .is_err()
        {
            return;
        }
        // 即使清扫 panic 或任务被中止也要清除该标志，
        // 这样一次失败不会禁用进程剩余生命周期的淘汰机制。
        let _guard = SweepGuard(&self.sweeping);

        self.sweep_inner(budget).await;
    }

    async fn sweep_inner(&self, budget: u64) {
        let now = SystemTime::now();
        let cutoff = now.checked_sub(CACHE_TTL).unwrap_or(SystemTime::UNIX_EPOCH);
        let orphan_cutoff = now
            .checked_sub(ORPHAN_TTL)
            .unwrap_or(SystemTime::UNIX_EPOCH);
        let snapshot = self.snapshot().await;
        let mut survivors = Vec::new();
        let mut total = 0_u64;

        for orphan in snapshot.orphans {
            if orphan.modified < orphan_cutoff {
                remove_entry(&orphan.path).await;
            }
        }

        for entry in snapshot.entries {
            if entry.modified < cutoff && remove_entry(&entry.path).await {
                continue;
            }
            total = total.saturating_add(entry.bytes);
            survivors.push(entry);
        }

        if total <= budget {
            return;
        }

        survivors.sort_by_key(|entry| entry.modified);
        let target = budget.saturating_mul(SWEEP_TARGET_PERCENT) / 100;
        for entry in survivors {
            if total <= target {
                break;
            }
            if remove_entry(&entry.path).await {
                total = total.saturating_sub(entry.bytes);
            }
        }
    }

    fn path_for(&self, url: &str) -> PathBuf {
        self.path_for_key(&cache_key(url))
    }

    fn path_for_key(&self, key: &str) -> PathBuf {
        self.root.join(&key[..2]).join(key)
    }

    /// 在一个阻塞任务里遍历两层缓存树。目录可能持有数千个文件，
    /// 而 `tokio::fs` 遍历会为每次 `read_dir` 和每次 `metadata`
    /// 分别派发一个阻塞任务。
    async fn snapshot(&self) -> CacheSnapshot {
        let root = self.root.clone();
        tokio::task::spawn_blocking(move || collect_snapshot(&root))
            .await
            .unwrap_or_default()
    }
}

fn collect_snapshot(root: &Path) -> CacheSnapshot {
    let mut snapshot = CacheSnapshot::default();
    let directories = match std::fs::read_dir(root) {
        Ok(directories) => directories,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return snapshot,
        Err(error) => {
            tracing::debug!(error = %error, "read image cache directory failed");
            return snapshot;
        }
    };

    for directory in directories {
        let directory = match directory {
            Ok(directory) => directory,
            Err(error) => {
                tracing::debug!(error = %error, "read image cache subdirectory failed");
                continue;
            }
        };
        let is_directory = match directory.file_type() {
            Ok(file_type) => file_type.is_dir(),
            Err(error) => {
                tracing::debug!(error = %error, "read image cache entry type failed");
                false
            }
        };
        if !is_directory {
            continue;
        }

        let files = match std::fs::read_dir(directory.path()) {
            Ok(files) => files,
            Err(error) => {
                tracing::debug!(error = %error, "read image cache files failed");
                continue;
            }
        };
        for file in files {
            let file = match file {
                Ok(file) => file,
                Err(error) => {
                    tracing::debug!(error = %error, "read image cache file entry failed");
                    continue;
                }
            };
            let name = file.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            let committed = if is_cache_file_name(name) {
                true
            } else if is_orphan_file_name(name) {
                false
            } else {
                continue;
            };
            let metadata = match file.metadata() {
                Ok(metadata) if metadata.is_file() => metadata,
                Ok(_) => continue,
                Err(error) => {
                    tracing::debug!(error = %error, "read image cache file metadata failed");
                    continue;
                }
            };
            let entry = CacheEntry {
                path: file.path(),
                bytes: metadata.len(),
                modified: metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
            };
            if committed {
                snapshot.entries.push(entry);
            } else {
                snapshot.orphans.push(entry);
            }
        }
    }
    snapshot
}

fn cache_key(url: &str) -> String {
    hex::encode(Md5::digest(url.as_bytes()))
}

fn is_cache_file_name(value: &str) -> bool {
    value.len() == 32 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn temporary_file_name(key: &str) -> String {
    format!("{key}{TEMPORARY_SUFFIX}{}", Uuid::new_v4().simple())
}

/// 匹配 `temporary_file_name` 生成的名字。缓存树中的其他内容一概不动：
/// 本模块只能回收自己的文件。
fn is_orphan_file_name(value: &str) -> bool {
    let Some((key, suffix)) = value.split_once(TEMPORARY_SUFFIX) else {
        return false;
    };
    is_cache_file_name(key)
        && suffix.len() == 32
        && suffix.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// 在每条退出路径（包括 unwind）上都释放清扫标志。
struct SweepGuard<'a>(&'a AtomicBool);

impl Drop for SweepGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

pub(crate) fn sniff_image_type(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF8") {
        Some("image/gif")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" && &bytes[8..12] == b"avif" {
        Some("image/avif")
    } else if bytes.starts_with(b"BM") {
        Some("image/bmp")
    } else {
        None
    }
}

async fn touch_file(path: PathBuf) {
    let result = tokio::task::spawn_blocking(move || {
        std::fs::OpenOptions::new()
            .write(true)
            .open(path)
            .and_then(|file| file.set_modified(SystemTime::now()))
    })
    .await;
    if let Ok(Err(error)) = result {
        tracing::debug!(error = %error, "touch image cache file failed");
    }
}

async fn remove_entry(path: &Path) -> bool {
    match fs::remove_file(path).await {
        Ok(()) => true,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
        Err(error) => {
            tracing::debug!(error = %error, "remove image cache file failed");
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        ImageCache, cache_key, is_cache_file_name, is_orphan_file_name, sniff_image_type,
        temporary_file_name,
    };
    use std::fs::OpenOptions;
    use std::time::{Duration, SystemTime};
    use uuid::Uuid;

    fn test_root() -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "rlive-image-cache-test-{}",
            Uuid::new_v4().simple()
        ))
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
        let key = cache_key("https://i0.hdslb.com/path/头像.png?x=1");
        assert_eq!(key.len(), 32);
        assert!(is_cache_file_name(&key));
        assert!(!key.contains('/'));
        assert!(!key.contains('\\'));
    }

    #[test]
    fn orphan_names_match_only_this_modules_temporary_files() {
        let key = cache_key("https://example.com/a.png");
        let temporary = temporary_file_name(&key);
        assert!(is_orphan_file_name(&temporary));
        assert!(!is_cache_file_name(&temporary));
        assert!(!is_orphan_file_name(&key));
        assert!(!is_orphan_file_name(&format!("{key}.tmp-short")));
        assert!(!is_orphan_file_name(
            "notes.tmp-00000000000000000000000000000000"
        ));
        assert!(!is_orphan_file_name("rlive.db"));
    }

    #[test]
    fn image_type_sniffing_accepts_known_formats_only() {
        assert_eq!(
            sniff_image_type(b"\x89PNG\r\n\x1a\nbody"),
            Some("image/png")
        );
        assert_eq!(sniff_image_type(b"\xff\xd8\xffbody"), Some("image/jpeg"));
        assert_eq!(sniff_image_type(b"GIF89abody"), Some("image/gif"));
        assert_eq!(sniff_image_type(b"RIFFxxxxWEBPbody"), Some("image/webp"));
        assert_eq!(sniff_image_type(b"xxxxftypavifbody"), Some("image/avif"));
        assert_eq!(sniff_image_type(b"BMbody"), Some("image/bmp"));
        assert_eq!(sniff_image_type(b"<!doctype html>"), None);
    }

    #[tokio::test]
    async fn put_get_usage_and_clear_round_trip() {
        let root = test_root();
        let cache = ImageCache::new(root.clone());
        let bytes = b"\x89PNG\r\n\x1a\ncache";

        cache.put("https://example.com/a.png", bytes).await;
        assert_eq!(
            cache.get("https://example.com/a.png").await,
            Some((bytes.to_vec(), "image/png"))
        );
        assert_eq!(cache.get("https://example.com/missing.png").await, None);
        assert_eq!(cache.usage().await.bytes, bytes.len() as u64);
        assert_eq!(cache.usage().await.files, 1);

        cache
            .put("https://example.com/not-image", b"text/html")
            .await;
        assert_eq!(cache.usage().await.files, 1);
        cache.clear().await.unwrap();
        assert_eq!(cache.usage().await.files, 0);
        cache.clear().await.unwrap();
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn sweep_removes_expired_entries_and_oldest_entries_over_budget() {
        let root = test_root();
        let cache = ImageCache::new(root.clone());
        let bytes = b"BMcache";
        cache.put("https://example.com/expired", bytes).await;
        let expired_path = cache.path_for("https://example.com/expired");
        set_modified(&expired_path, Duration::from_secs(31 * 24 * 60 * 60));
        cache.sweep().await;
        assert_eq!(cache.usage().await.files, 0);

        cache.put("https://example.com/old", bytes).await;
        cache.put("https://example.com/middle", bytes).await;
        cache.put("https://example.com/new", bytes).await;
        set_modified(
            &cache.path_for("https://example.com/old"),
            Duration::from_secs(3 * 60),
        );
        set_modified(
            &cache.path_for("https://example.com/middle"),
            Duration::from_secs(2 * 60),
        );
        set_modified(
            &cache.path_for("https://example.com/new"),
            Duration::from_secs(60),
        );
        cache.sweep_with_budget(16).await;
        assert_eq!(cache.get("https://example.com/old").await, None);
        assert_eq!(cache.get("https://example.com/middle").await, None);
        assert!(cache.get("https://example.com/new").await.is_some());
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn sweep_reclaims_stale_temporary_files_only() {
        let root = test_root();
        let cache = ImageCache::new(root.clone());
        cache
            .put("https://example.com/kept.png", b"\x89PNG\r\n\x1a\ncache")
            .await;

        let key = cache_key("https://example.com/interrupted.png");
        let directory = root.join(&key[..2]);
        std::fs::create_dir_all(&directory).unwrap();
        let stale = directory.join(temporary_file_name(&key));
        let fresh = directory.join(temporary_file_name(&key));
        let unrelated = directory.join("keep-me.txt");
        for path in [&stale, &fresh, &unrelated] {
            std::fs::write(path, b"partial").unwrap();
        }
        set_modified(&stale, Duration::from_secs(2 * 60 * 60));

        // 临时文件占用磁盘，但不属于缓存内容。
        let usage = cache.usage().await;
        assert_eq!(usage.files, 1);
        assert_eq!(usage.bytes, b"\x89PNG\r\n\x1a\ncache".len() as u64);

        cache.sweep().await;
        assert!(!stale.exists(), "stale temporary file survived the sweep");
        assert!(fresh.exists(), "an in-flight write was reclaimed too early");
        assert!(unrelated.exists(), "sweep touched a file it does not own");
        assert!(cache.get("https://example.com/kept.png").await.is_some());
        let _ = std::fs::remove_dir_all(root);
    }
}
