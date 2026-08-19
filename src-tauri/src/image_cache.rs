//! Best-effort persistent cache for remote image bodies.
//!
//! Cache files contain the original image bytes and use an MD5 digest of the
//! already allowlisted upstream URL as their name. The digest is only a cache
//! key, not a security boundary: the proxy validates the upstream host before
//! this module is called, and the hex-only path cannot contain user-controlled
//! path separators.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, SystemTime};

use md5::{Digest, Md5};
use serde::Serialize;
use tokio::fs;
use uuid::Uuid;

/// Keep the image proxy's in-memory response bound and cache entry bound equal.
pub const MAX_IMAGE_BYTES: usize = 16 * 1024 * 1024;

#[cfg(target_os = "android")]
const CACHE_BUDGET_BYTES: u64 = 64 * 1024 * 1024;
#[cfg(not(target_os = "android"))]
const CACHE_BUDGET_BYTES: u64 = 256 * 1024 * 1024;

const CACHE_TTL: Duration = Duration::from_secs(30 * 24 * 60 * 60);
const TOUCH_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);
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

        let temporary = parent.join(format!("{key}.tmp-{}", Uuid::new_v4().simple()));
        if let Err(error) = fs::write(&temporary, bytes).await {
            tracing::debug!(error = %error, "write image cache temporary file failed");
            let _ = fs::remove_file(&temporary).await;
            return;
        }

        let committed = match fs::rename(&temporary, &path).await {
            Ok(()) => true,
            Err(error) => {
                // On Windows rename refuses an existing target. If another
                // request won the race, the desired cache entry is already
                // present and the temporary file can simply be discarded.
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
            if writes % SWEEP_WRITE_INTERVAL == 0 {
                self.sweep().await;
            }
        }
    }

    pub async fn usage(&self) -> CacheUsage {
        let entries = self.collect_entries().await;
        CacheUsage {
            bytes: entries
                .iter()
                .fold(0_u64, |total, entry| total.saturating_add(entry.bytes)),
            files: entries.len() as u64,
            path: self.root.display().to_string(),
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
        self.writes.store(0, Ordering::Relaxed);
        Ok(())
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

        self.sweep_inner(budget).await;
        self.sweeping.store(false, Ordering::Release);
    }

    async fn sweep_inner(&self, budget: u64) {
        let now = SystemTime::now();
        let cutoff = now.checked_sub(CACHE_TTL).unwrap_or(SystemTime::UNIX_EPOCH);
        let mut survivors = Vec::new();
        let mut total = 0_u64;

        for entry in self.collect_entries().await {
            if entry.modified < cutoff {
                if remove_entry(&entry.path).await {
                    continue;
                }
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

    async fn collect_entries(&self) -> Vec<CacheEntry> {
        let mut directories = match fs::read_dir(&self.root).await {
            Ok(directories) => directories,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
            Err(error) => {
                tracing::debug!(error = %error, "read image cache directory failed");
                return Vec::new();
            }
        };
        let mut entries = Vec::new();

        loop {
            let directory = match directories.next_entry().await {
                Ok(Some(directory)) => directory,
                Ok(None) => break,
                Err(error) => {
                    tracing::debug!(error = %error, "read image cache subdirectory failed");
                    break;
                }
            };
            let is_directory = match directory.file_type().await {
                Ok(file_type) => file_type.is_dir(),
                Err(error) => {
                    tracing::debug!(error = %error, "read image cache entry type failed");
                    false
                }
            };
            if !is_directory {
                continue;
            }

            let mut files = match fs::read_dir(directory.path()).await {
                Ok(files) => files,
                Err(error) => {
                    tracing::debug!(error = %error, "read image cache files failed");
                    continue;
                }
            };
            loop {
                let file = match files.next_entry().await {
                    Ok(Some(file)) => file,
                    Ok(None) => break,
                    Err(error) => {
                        tracing::debug!(error = %error, "read image cache file entry failed");
                        break;
                    }
                };
                let Some(name) = file.file_name().to_str().map(str::to_owned) else {
                    continue;
                };
                if !is_cache_file_name(&name) {
                    continue;
                }
                let metadata = match file.metadata().await {
                    Ok(metadata) if metadata.is_file() => metadata,
                    Ok(_) => continue,
                    Err(error) => {
                        tracing::debug!(error = %error, "read image cache file metadata failed");
                        continue;
                    }
                };
                entries.push(CacheEntry {
                    path: file.path(),
                    bytes: metadata.len(),
                    modified: metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                });
            }
        }
        entries
    }
}

fn cache_key(url: &str) -> String {
    hex::encode(Md5::digest(url.as_bytes()))
}

fn is_cache_file_name(value: &str) -> bool {
    value.len() == 32 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
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
    use super::{ImageCache, cache_key, is_cache_file_name, sniff_image_type};
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
}
