use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};
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
    pub bilibili_send_limiter: DanmakuSendLimiter,
    pub douyu_send_limiter: DanmakuSendLimiter,
    pub huya_send_limiter: DanmakuSendLimiter,
    pub stream_proxy: StreamProxy,
    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
    pub recording: RecordingManager,
    pub dlna: DlnaManager,
    pub image_proxy: ImageProxy,
    pub lan_sync: LanSyncManager,
}

/// 手动弹幕发送的保守房间级写入闸门，每个站点一个实例。它刻意只作用于
/// 进程内部：这是 UX/安全层面的冷却，不是为了绕过或镜像平台自身权威的
/// 频率限制。站点差异（错误码前缀、展示名与出站消息规范化）随实例携带。
pub struct DanmakuSendLimiter {
    /// 站点 id：错误码前缀，并回填到错误的 `site` 字段。
    pub site: &'static str,
    /// 面向用户的站点展示名（"B站"、"斗鱼"、"虎牙"）。
    pub label: &'static str,
    /// 该站点的出站消息规范化函数。
    pub normalize: fn(&str) -> AppResult<String>,
    sent_at: Mutex<HashMap<String, Instant>>,
}

impl DanmakuSendLimiter {
    const COOLDOWN: Duration = Duration::from_secs(3);

    pub fn new(
        site: &'static str,
        label: &'static str,
        normalize: fn(&str) -> AppResult<String>,
    ) -> Self {
        Self {
            site,
            label,
            normalize,
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
                    format!("{}_send_cooldown", self.site),
                    format!("发送过快，请在约 {remaining} 秒后再试"),
                )
                .with_site(self.site)
                .retryable());
            }
        }
        sent_at.insert(room_id.to_string(), now);
        Ok(())
    }
}

impl AppState {
    /// 以统一的错误语义锁定数据库连接。
    pub fn conn(&self) -> AppResult<MutexGuard<'_, Connection>> {
        self.db
            .lock()
            .map_err(|_| AppError::new("db_lock_error", "database mutex poisoned"))
    }

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
            bilibili_send_limiter: DanmakuSendLimiter::new(
                "bilibili",
                "B站",
                crate::danmu_rs::bilibili::normalize_outgoing_message,
            ),
            douyu_send_limiter: DanmakuSendLimiter::new(
                "douyu",
                "斗鱼",
                crate::danmu_rs::douyu::normalize_outgoing_message,
            ),
            huya_send_limiter: DanmakuSendLimiter::new(
                "huya",
                "虎牙",
                crate::danmu_rs::huya::normalize_outgoing_message,
            ),
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
    use super::DanmakuSendLimiter;
    use crate::danmu_rs;

    #[test]
    fn send_limiter_holds_the_same_room_and_keeps_site_error_codes() {
        // 合并前三个结构体各自硬编码自己的错误码，写错不可能；现在 site 是
        // 构造时传入的数据，参数写反或接错实例编译器不会报。逐站点锁住。
        for (site, label, normalize) in [
            (
                "bilibili",
                "B站",
                danmu_rs::bilibili::normalize_outgoing_message
                    as fn(&str) -> crate::error::AppResult<String>,
            ),
            (
                "douyu",
                "斗鱼",
                danmu_rs::douyu::normalize_outgoing_message,
            ),
            ("huya", "虎牙", danmu_rs::huya::normalize_outgoing_message),
        ] {
            let limiter = DanmakuSendLimiter::new(site, label, normalize);
            assert_eq!(limiter.site, site);
            assert_eq!(limiter.label, label);

            limiter.reserve("1").unwrap();
            assert!(limiter.reserve("2").is_ok());
            let error = limiter.reserve("1").unwrap_err();
            assert_eq!(error.code, format!("{site}_send_cooldown"));
            assert_eq!(error.site.as_deref(), Some(site));
            assert!(error.retryable);
        }
    }
}
