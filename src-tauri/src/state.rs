use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use rusqlite::Connection;

use crate::danmaku::DanmakuManager;
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::stream_proxy::StreamProxy;

pub struct AppState {
    pub db: Mutex<Connection>,
    pub danmaku: DanmakuManager,
    pub bilibili_send_limiter: BilibiliDanmakuSendLimiter,
    pub stream_proxy: StreamProxy,
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

impl AppState {
    pub fn init() -> AppResult<Self> {
        let path = db_path()?;
        let conn = Db::open(&path)?;
        Ok(Self {
            db: Mutex::new(conn),
            danmaku: DanmakuManager::new(),
            bilibili_send_limiter: BilibiliDanmakuSendLimiter::new(),
            stream_proxy: StreamProxy::new(),
        })
    }
}

fn db_path() -> AppResult<PathBuf> {
    if let Some(data_dir) = dirs::data_dir() {
        let dir = data_dir.join("rlive");
        std::fs::create_dir_all(&dir).map_err(|e| {
            AppError::new(
                "db_io_error",
                format!("create data dir {}: {e}", dir.display()),
            )
        })?;
        Ok(dir.join("rlive.db"))
    } else {
        Ok(PathBuf::from("./rlive.db"))
    }
}

#[cfg(test)]
mod tests {
    use super::BilibiliDanmakuSendLimiter;

    #[test]
    fn send_limiter_holds_the_same_room() {
        let limiter = BilibiliDanmakuSendLimiter::new();
        limiter.reserve("1").unwrap();
        assert!(limiter.reserve("1").is_err());
        assert!(limiter.reserve("2").is_ok());
    }
}
