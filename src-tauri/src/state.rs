use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use rusqlite::Connection;

use crate::app_paths::AppDirectories;
#[cfg(not(target_os = "android"))]
use crate::asr::AsrManager;
use crate::danmu_rs::DanmakuManager;
use crate::db::Db;
use crate::dlna::DlnaManager;
use crate::error::{AppError, AppResult};
use crate::image_proxy::ImageProxy;
use crate::lan_sync::LanSyncManager;
#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
use crate::recording::RecordingManager;
use crate::stream_proxy::StreamProxy;

pub struct AppState {
    /// 启动时解析好的应用数据目录。Android 上移动宿主的数据目录
    /// 仅在启动期间可得，事后无法重新解析，
    /// 因此所有需要数据路径的命令都从这里取。
    pub directories: AppDirectories,
    pub db: Mutex<Connection>,
    #[cfg(not(target_os = "android"))]
    pub asr: AsrManager,
    pub danmaku: DanmakuManager,
    pub bilibili_send_limiter: BilibiliDanmakuSendLimiter,
    pub douyu_send_limiter: DouyuDanmakuSendLimiter,
    pub huya_send_limiter: HuyaDanmakuSendLimiter,
    pub stream_proxy: StreamProxy,
    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
    pub recording: RecordingManager,
    pub dlna: DlnaManager,
    pub image_proxy: ImageProxy,
    pub lan_sync: LanSyncManager,
}

/// Bilibili 发送方的保守房间级写入闸门。它刻意只作用于进程内部：
/// 这是 UX/安全层面的冷却，
/// 不是为了绕过或镜像 Bilibili 自身权威的频率限制。
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

    /// 在任何网络调用之前先占用一次手动发送额度。失败或结果不明的请求也会短暂
    /// 持有冷却，使应用绝不会自动重试一条远端服务可能已接受的消息。
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

/// 斗鱼发送方的保守房间级写入闸门。
///
/// 这刻意只是本地 UX/安全冷却，不能替代斗鱼权威的房间与账号频率限制。
/// 每次占用都发生在网络写入之前，
/// 因为超时仍可能意味着远端服务已接受该消息。
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

/// 虎牙发送方的保守房间级写入闸门。它只保护显式的本地 UI 免受意外的快速
/// 重复发送；账号/房间限制与内容审核的权威始终在平台一侧。
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

impl AppState {
    pub fn init(directories: &AppDirectories) -> AppResult<Self> {
        let app_directory = &directories.root;
        let path = create_db_path(app_directory.to_path_buf())?;
        let conn = Db::open(&path)?;
        Ok(Self {
            directories: directories.clone(),
            db: Mutex::new(conn),
            #[cfg(not(target_os = "android"))]
            asr: AsrManager::new(app_directory),
            danmaku: DanmakuManager::new(),
            bilibili_send_limiter: BilibiliDanmakuSendLimiter::new(),
            douyu_send_limiter: DouyuDanmakuSendLimiter::new(),
            huya_send_limiter: HuyaDanmakuSendLimiter::new(),
            stream_proxy: StreamProxy::new(),
            #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
            recording: RecordingManager::new(app_directory)?,
            dlna: DlnaManager::new(),
            image_proxy: ImageProxy::new(directories.cache.join("images")),
            lan_sync: LanSyncManager::new(),
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

#[cfg(test)]
mod tests {
    use super::{BilibiliDanmakuSendLimiter, DouyuDanmakuSendLimiter, HuyaDanmakuSendLimiter};

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
}
