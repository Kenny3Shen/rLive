use std::collections::{HashMap, HashSet, VecDeque};
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
use crate::media_cache::MediaCache;
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
    /// 短视频媒体分片的磁盘缓存（与图片缓存并列，预算与 TTL 各自独立）。
    pub media_cache: MediaCache,
    /// story feed 最近发过哪些条目（进程内）。见 [`StoryFeedSeen`]。
    pub story_feed_seen: StoryFeedSeen,
}

/// story feed 最近发给前端的 `bvid` 环，用于「优先给没见过的」。
///
/// 为什么需要它：上游这条流**没有游标**，而且**头部很黏** —— 实测同一账号连续 6 次
/// 首屏（每次 10 条）共 60 条里只有 43 条唯一，其中一条 6 次全在。换设备号不解决
/// （实测新 buvid 之间两两交集 0~1/5，黏的是账号侧的推荐头部而不是设备状态），
/// 改 `pull=0` 更糟（60 条里只剩 32 条唯一）。既然上游不给游标，去重记忆只能记在
/// 我们这边。
///
/// 挂在 `AppState` 而不是站点实例上：站点每条命令新建一个（见 `commands/video.rs`
/// 的 `resolve_bilibili`），记在实例上等于没记。
///
/// 进程内而不是落库：这只是「这次运行里已经推过的」，重启后上游头部通常也换了一
/// 轮；真正跨重启的记忆走观看历史（`video_history`，已看过的条目本就不该再推）。
pub struct StoryFeedSeen {
    inner: Mutex<StoryFeedSeenInner>,
}

#[derive(Default)]
struct StoryFeedSeenInner {
    /// 淘汰顺序（先进先出）。
    order: VecDeque<String>,
    /// 同一批集合的查询索引，避免每次线性扫。
    ids: HashSet<String>,
}

impl StoryFeedSeen {
    /// 环的容量。
    ///
    /// 300 条约等于连续刷十几次补货：再往前的条目让它重新可推，因为上游轮换到那时
    /// 早就换过内容了，无限增长只会让过滤越来越严直到无货可发。
    const CAPACITY: usize = 300;

    pub fn new() -> Self {
        Self::default()
    }

    /// 当前记住的集合。锁中毒时返回空集：宁可这次不过滤，也不要让整条命令失败。
    pub fn snapshot(&self) -> HashSet<String> {
        match self.inner.lock() {
            Ok(inner) => inner.ids.clone(),
            Err(_) => HashSet::new(),
        }
    }

    /// 记下这次发出去的条目（含兜底重复的那些：它们确实被端上去了）。
    pub fn record<I: IntoIterator<Item = String>>(&self, bvids: I) {
        let Ok(mut inner) = self.inner.lock() else {
            return;
        };
        for bvid in bvids {
            if bvid.is_empty() || !inner.ids.insert(bvid.clone()) {
                continue;
            }
            inner.order.push_back(bvid);
            while inner.order.len() > Self::CAPACITY {
                if let Some(evicted) = inner.order.pop_front() {
                    inner.ids.remove(&evicted);
                }
            }
        }
    }
}

impl Default for StoryFeedSeen {
    fn default() -> Self {
        Self {
            inner: Mutex::new(StoryFeedSeenInner::default()),
        }
    }
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
            media_cache: MediaCache::new(directories.cache.join("media")),
            lan_sync: LanSyncManager::new(),
            story_feed_seen: StoryFeedSeen::new(),
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
            ("douyu", "斗鱼", danmu_rs::douyu::normalize_outgoing_message),
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
