use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use rusqlite::Connection;

use crate::danmaku::DanmakuManager;
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::image_proxy::ImageProxy;
use crate::stream_proxy::StreamProxy;

pub struct AppState {
    pub db: Mutex<Connection>,
    pub danmaku: DanmakuManager,
    pub bilibili_send_limiter: BilibiliDanmakuSendLimiter,
    pub douyu_send_limiter: DouyuDanmakuSendLimiter,
    pub huya_send_limiter: HuyaDanmakuSendLimiter,
    pub douyin_send_limiter: DouyinDanmakuSendLimiter,
    pub stream_proxy: StreamProxy,
    pub image_proxy: ImageProxy,
}

/// Conservative per-room write gate for the Bilibili sender.
/// It is deliberately process-local: this is a UX/safety cooldown, not an
/// attempt to bypass or mirror Bilibili's own authoritative rate limits.
pub struct BilibiliDanmakuSendLimiter {
    sent_at: Mutex<HashMap<String, Instant>>,
}

impl BilibiliDanmakuSendLimiter {
    const COOLDOWN: Duration = Duration::from_secs(3);

    pub fn new() -> Self {
        Self {
            sent_at: Mutex::new(HashMap::new()),
        }
    }

    /// Reserve one manual send before any network call. A failed or ambiguous
    /// request is still held briefly so the app never automatically retries a
    /// message the remote service may have accepted.
    pub fn reserve(&self, room_id: &str) -> AppResult<()> {
        let now = Instant::now();
        let mut sent_at = self
            .sent_at
            .lock()
            .map_err(|_| AppError::new("send_limiter_lock", "发送状态暂不可用"))?;
        sent_at.retain(|_, sent| now.duration_since(*sent) < Duration::from_secs(90));
        if let Some(previous) = sent_at.get(room_id) {
            let elapsed = now.duration_since(*previous);
            if elapsed < Self::COOLDOWN {
                let remaining = (Self::COOLDOWN - elapsed).as_secs().max(1);
                return Err(AppError::new(
                    "bilibili_send_cooldown",
                    format!("发送过快，请在约 {remaining} 秒后再试"),
                )
                .with_site("bilibili")
                .retryable());
            }
        }
        sent_at.insert(room_id.to_string(), now);
        Ok(())
    }
}

/// Conservative per-room write gate for the Douyu sender.
///
/// This is deliberately a local UX/safety cooldown, not a replacement for
/// Douyu's authoritative room and account rate limits. Each reservation is
/// made before the network write because a timeout can still mean the remote
/// service accepted the message.
pub struct DouyuDanmakuSendLimiter {
    sent_at: Mutex<HashMap<String, Instant>>,
}

impl DouyuDanmakuSendLimiter {
    const COOLDOWN: Duration = Duration::from_secs(3);

    pub fn new() -> Self {
        Self {
            sent_at: Mutex::new(HashMap::new()),
        }
    }

    pub fn reserve(&self, room_id: &str) -> AppResult<()> {
        let now = Instant::now();
        let mut sent_at = self
            .sent_at
            .lock()
            .map_err(|_| AppError::new("send_limiter_lock", "发送状态暂不可用"))?;
        sent_at.retain(|_, sent| now.duration_since(*sent) < Duration::from_secs(90));
        if let Some(previous) = sent_at.get(room_id) {
            let elapsed = now.duration_since(*previous);
            if elapsed < Self::COOLDOWN {
                let remaining = (Self::COOLDOWN - elapsed).as_secs().max(1);
                return Err(AppError::new(
                    "douyu_send_cooldown",
                    format!("发送过快，请在约 {remaining} 秒后再试"),
                )
                .with_site("douyu")
                .retryable());
            }
        }
        sent_at.insert(room_id.to_string(), now);
        Ok(())
    }
}

/// Conservative per-room write gate for the Huya sender. It only protects the
/// explicit local UI from accidental rapid repeats; the platform remains the
/// authority for account/room limits and moderation.
pub struct HuyaDanmakuSendLimiter {
    sent_at: Mutex<HashMap<String, Instant>>,
}

impl HuyaDanmakuSendLimiter {
    const COOLDOWN: Duration = Duration::from_secs(3);

    pub fn new() -> Self {
        Self {
            sent_at: Mutex::new(HashMap::new()),
        }
    }

    pub fn reserve(&self, room_id: &str) -> AppResult<()> {
        let now = Instant::now();
        let mut sent_at = self
            .sent_at
            .lock()
            .map_err(|_| AppError::new("send_limiter_lock", "发送状态暂不可用"))?;
        sent_at.retain(|_, sent| now.duration_since(*sent) < Duration::from_secs(90));
        if let Some(previous) = sent_at.get(room_id) {
            let elapsed = now.duration_since(*previous);
            if elapsed < Self::COOLDOWN {
                let remaining = (Self::COOLDOWN - elapsed).as_secs().max(1);
                return Err(AppError::new(
                    "huya_send_cooldown",
                    format!("发送过快，请在约 {remaining} 秒后再试"),
                )
                .with_site("huya")
                .retryable());
            }
        }
        sent_at.insert(room_id.to_string(), now);
        Ok(())
    }
}

/// Conservative per-room write gate for the Douyin sender.
///
/// Same local UX cooldown pattern as the other platforms: reserve before the
/// HTTP write so a timeout cannot cause automatic retries of a possibly
/// accepted message.
pub struct DouyinDanmakuSendLimiter {
    sent_at: Mutex<HashMap<String, Instant>>,
}

impl DouyinDanmakuSendLimiter {
    const COOLDOWN: Duration = Duration::from_secs(3);

    pub fn new() -> Self {
        Self {
            sent_at: Mutex::new(HashMap::new()),
        }
    }

    pub fn reserve(&self, room_id: &str) -> AppResult<()> {
        let now = Instant::now();
        let mut sent_at = self
            .sent_at
            .lock()
            .map_err(|_| AppError::new("send_limiter_lock", "发送状态暂不可用"))?;
        sent_at.retain(|_, sent| now.duration_since(*sent) < Duration::from_secs(90));
        if let Some(previous) = sent_at.get(room_id) {
            let elapsed = now.duration_since(*previous);
            if elapsed < Self::COOLDOWN {
                let remaining = (Self::COOLDOWN - elapsed).as_secs().max(1);
                return Err(AppError::new(
                    "douyin_send_cooldown",
                    format!("发送过快，请在约 {remaining} 秒后再试"),
                )
                .with_site("douyin")
                .retryable());
            }
        }
        sent_at.insert(room_id.to_string(), now);
        Ok(())
    }
}

impl AppState {
    /// Creates the application state using the platform-owned data directory
    /// when one is supplied by the mobile host.
    ///
    /// `dirs` deliberately does not expose Android's app sandbox. Falling
    /// back to a relative path there makes startup depend on the process
    /// working directory (normally `/`), which is not writable by an app.
    /// Desktop callers keep the historic `dirs` location so existing local
    /// databases continue to be found without a migration.
    pub fn init(app_data_dir: Option<&Path>) -> AppResult<Self> {
        let path = db_path(app_data_dir)?;
        let conn = Db::open(&path)?;
        Ok(Self {
            db: Mutex::new(conn),
            danmaku: DanmakuManager::new(),
            bilibili_send_limiter: BilibiliDanmakuSendLimiter::new(),
            douyu_send_limiter: DouyuDanmakuSendLimiter::new(),
            huya_send_limiter: HuyaDanmakuSendLimiter::new(),
            douyin_send_limiter: DouyinDanmakuSendLimiter::new(),
            stream_proxy: StreamProxy::new(),
            image_proxy: ImageProxy::new(),
        })
    }
}

fn create_db_path(dir: PathBuf) -> AppResult<PathBuf> {
    std::fs::create_dir_all(&dir).map_err(|e| {
        AppError::new(
            "db_io_error",
            format!("create data dir {}: {e}", dir.display()),
        )
    })?;
    Ok(dir.join("rlive.db"))
}

#[cfg(target_os = "android")]
fn db_path(app_data_dir: Option<&Path>) -> AppResult<PathBuf> {
    let data_dir = app_data_dir.ok_or_else(|| {
        AppError::new(
            "db_io_error",
            "Android app data directory is unavailable during startup",
        )
    })?;
    create_db_path(data_dir.join("rlive"))
}

#[cfg(not(target_os = "android"))]
fn db_path(_app_data_dir: Option<&Path>) -> AppResult<PathBuf> {
    if let Some(data_dir) = dirs::data_dir() {
        create_db_path(data_dir.join("rlive"))
    } else {
        Ok(PathBuf::from("./rlive.db"))
    }
}

#[cfg(test)]
mod tests {
    use super::{
        BilibiliDanmakuSendLimiter, DouyinDanmakuSendLimiter, DouyuDanmakuSendLimiter,
        HuyaDanmakuSendLimiter,
    };

    #[test]
    fn send_limiter_holds_the_same_room() {
        let limiter = BilibiliDanmakuSendLimiter::new();
        limiter.reserve("1").unwrap();
        assert!(limiter.reserve("1").is_err());
        assert!(limiter.reserve("2").is_ok());
    }

    #[test]
    fn douyu_send_limiter_holds_the_same_room() {
        let limiter = DouyuDanmakuSendLimiter::new();
        limiter.reserve("1").unwrap();
        assert!(limiter.reserve("1").is_err());
        assert!(limiter.reserve("2").is_ok());
    }

    #[test]
    fn huya_send_limiter_holds_the_same_room() {
        let limiter = HuyaDanmakuSendLimiter::new();
        limiter.reserve("1").unwrap();
        assert!(limiter.reserve("1").is_err());
        assert!(limiter.reserve("2").is_ok());
    }

    #[test]
    fn douyin_send_limiter_holds_the_same_room() {
        let limiter = DouyinDanmakuSendLimiter::new();
        limiter.reserve("1").unwrap();
        assert!(limiter.reserve("1").is_err());
        assert!(limiter.reserve("2").is_ok());
    }
}
