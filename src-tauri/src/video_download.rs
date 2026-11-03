//! B 站 VOD 下载：队列、断点续传与音视频合并。
//!
//! 下载内容与录制一样刻意放在 SQLite 之外：每个条目是一个自包含目录
//! （`entry.json` + 两条临时轨 + 成片），应用被杀掉后仍可恢复。
//!
//! 与录制共用 `BilibiliSite::video_play_selection` 解出的完整分片表。区别是
//! 不需要重新抓直播流：DASH 轨就是完整的 fMP4 文件，按字节区间顺序下载后
//! 重封装为 MP4。桌面端用进程内 FFmpeg 流复制，Android 用原生
//! `MediaMuxer`，两条路径都不转码。

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::io::Read;
use std::path::{Path, PathBuf};
#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
use std::sync::OnceLock;
#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
use ffmpeg::{Packet, Rational, Rescale, format, media};
#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
use ffmpeg_next as ffmpeg;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::AsyncWriteExt;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{Notify, watch};
use uuid::Uuid;

use crate::commands::video::{resolve_bilibili, video_stream_headers};
use crate::error::{AppError, AppResult};
use crate::local_http;
use crate::models::video::{VideoDanmakuSegment, VideoPlayRequest, VideoSubtitle};
use crate::sites::bilibili::BilibiliSite;
use crate::sites::bilibili::video::VideoTrack;
use crate::state::AppState;
use crate::stream_proxy::request_header;

pub const VIDEO_DOWNLOAD_CHANGED_EVENT: &str = "video-download-changed";
pub const VIDEO_DOWNLOAD_PROGRESS_EVENT: &str = "video-download-progress";

const ENTRY_FILE: &str = "entry.json";
const VIDEO_PART: &str = "video.m4s.part";
const AUDIO_PART: &str = "audio.m4s.part";
const OUTPUT_PART: &str = "output.mp4.part";
const SUBTITLE_FILE_PREFIX: &str = "subtitle-";
const SUBTITLE_FILE_EXTENSION: &str = ".vtt";
const DANMAKU_FILE: &str = "danmaku.json";
const MAX_TITLE_CHARS: usize = 80;
const VIDEO_FILE_EXTENSION: &str = ".mp4";
const MAX_FILE_NAME_BYTES: usize = 255;
const MAX_FILE_STEM_BYTES: usize = MAX_FILE_NAME_BYTES - VIDEO_FILE_EXTENSION.len();
const PROGRESS_INTERVAL: Duration = Duration::from_millis(500);
const TRACK_ATTEMPTS: u32 = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VideoDownloadStatus {
    Queued,
    Downloading,
    Paused,
    Merging,
    Completed,
    Failed,
}

impl VideoDownloadStatus {
    fn is_active(self) -> bool {
        matches!(
            self,
            Self::Queued | Self::Downloading | Self::Merging | Self::Paused | Self::Failed
        )
    }
}

/// 跨 IPC 的下载条目。字段保持 snake_case，与 VOD 其余模型一致。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoDownloadItem {
    pub id: String,
    pub bvid: Option<String>,
    pub cid: i64,
    pub ep_id: Option<String>,
    pub title: String,
    pub cover: String,
    pub author: String,
    /// 秒；取流前缺失为 0，取流后由 sidx 时间轴回填。
    pub duration: f64,
    pub qn: i64,
    pub quality_label: String,
    pub status: VideoDownloadStatus,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub created_at: i64,
    pub completed_at: Option<i64>,
    /// 成片的绝对路径；未完成时也给出预期路径，前端据此展示位置。
    pub file_path: String,
    pub error: Option<String>,
    /// 只用于区分同一队列条目上的多次用户请求，不跨 IPC 或重启传递。
    #[serde(skip)]
    request_generation: u64,
    /// 切换画质后需要等旧 worker 离场再清理旧分片。
    #[serde(skip)]
    discard_partials: bool,
    /// 观看进度以秒保存，和下载条目的原始 `duration` 分开。
    #[serde(skip)]
    watch_progress: f64,
    #[serde(skip)]
    watch_duration: f64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct VideoDownloadInput {
    pub bvid: Option<String>,
    pub cid: i64,
    pub ep_id: Option<String>,
    pub title: String,
    #[serde(default)]
    pub cover: Option<String>,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub duration: Option<f64>,
    #[serde(default)]
    pub qn: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
struct VideoDownloadChangedEvent {
    id: String,
    item: Option<VideoDownloadItem>,
}

#[derive(Debug, Clone, Serialize)]
struct VideoDownloadProgressEvent {
    id: String,
    downloaded_bytes: u64,
    total_bytes: u64,
    status: VideoDownloadStatus,
}

/// 应用内播放所需的信息。URL 只能由后端生成，并绑定到本次进程内的任务授权。
#[derive(Debug, Clone, Serialize)]
pub struct VideoDownloadPlaybackInfo {
    pub item: VideoDownloadItem,
    pub url: String,
    /// 上次离开时的播放位置，单位秒。
    pub progress: f64,
    /// 下载时缓存的 B 站 CC 字幕，播放时不需要再访问上游。
    pub subtitles: Vec<VideoDownloadSubtitle>,
    /// 字幕未完整缓存时的可展示原因，不影响已下载媒体播放。
    pub subtitle_error: Option<String>,
    pub danmaku_url: Option<String>,
    pub danmaku_error: Option<String>,
}

/// 已完成下载可离线加载的字幕轨。
#[derive(Debug, Clone, Serialize)]
pub struct VideoDownloadSubtitle {
    pub id: String,
    pub lan: String,
    pub lan_doc: String,
    /// 本机回放服务签发的 VTT 地址。
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CachedSubtitle {
    id: String,
    lan: String,
    lan_doc: String,
    file_name: String,
}

#[derive(Default)]
struct CachedSubtitleState {
    subtitles: Vec<CachedSubtitle>,
    subtitle_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CachedDanmakuSegment {
    segment_index: i64,
    #[serde(flatten)]
    segment: VideoDanmakuSegment,
}

#[derive(Default)]
struct CachedDanmakuState {
    cached: bool,
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredEntry {
    item: VideoDownloadItem,
    file_name: String,
    /// 换画质时旧 worker 可能尚未退出；即使随后进程退出，重启后也必须
    /// 从空分片开始，不能把旧 representation 的字节接到新分片表后面。
    #[serde(default)]
    discard_partials: bool,
    #[serde(default)]
    watch_progress: f64,
    #[serde(default)]
    watch_duration: f64,
    #[serde(default)]
    subtitles: Vec<CachedSubtitle>,
    #[serde(default)]
    subtitle_error: Option<String>,
    #[serde(default)]
    danmaku_cached: bool,
    #[serde(default)]
    danmaku_error: Option<String>,
}

struct InnerState {
    items: Vec<VideoDownloadItem>,
    worker_running: bool,
    active_id: Option<String>,
    cancel: Option<watch::Sender<bool>>,
    /// 当前活动 worker 结束（含取消）时通知；删除活动条目要等它停止写文件。
    active_done: Option<Arc<Notify>>,
    /// 正在删除的条目；在文件和内存记录都清完之前禁止 start/resume 复活它。
    deleting: HashSet<String>,
}

#[derive(Clone)]
struct PlaybackGrant {
    item_id: String,
    file: PathBuf,
}

struct PlaybackServerInner {
    token: String,
    base_url: String,
    grants: Arc<Mutex<HashMap<String, PlaybackGrant>>>,
    shutdown: watch::Sender<bool>,
    task: JoinHandle<()>,
}

struct DownloadPlaybackServer {
    root: PathBuf,
    state: Mutex<Option<PlaybackServerInner>>,
}

impl DownloadPlaybackServer {
    fn new(root: PathBuf) -> Self {
        Self {
            root,
            state: Mutex::new(None),
        }
    }

    async fn urls(&self, item_id: &str, files: &[PathBuf]) -> AppResult<Vec<String>> {
        {
            let state = self
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if let Some(server) = state.as_ref() {
                return server.register(item_id, files);
            }
        }

        let listener = TcpListener::bind("127.0.0.1:0").await.map_err(|error| {
            AppError::new(
                "video_download_playback_server_error",
                format!("启动下载回放服务失败: {error}"),
            )
        })?;
        let port = listener
            .local_addr()
            .map_err(|error| {
                AppError::new(
                    "video_download_playback_server_error",
                    format!("读取下载回放端口失败: {error}"),
                )
            })?
            .port();
        let token = Uuid::new_v4().simple().to_string();
        let base_url = format!("http://127.0.0.1:{port}");
        let grants = Arc::new(Mutex::new(HashMap::new()));
        let (shutdown, receiver) = watch::channel(false);
        let root = self.root.clone();
        let task_token = token.clone();
        let task_grants = grants.clone();
        let task = tauri::async_runtime::spawn(async move {
            run_playback_server(listener, root, task_grants, task_token, receiver).await;
        });

        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.is_none() {
            *state = Some(PlaybackServerInner {
                token,
                base_url,
                grants,
                shutdown,
                task,
            });
        } else {
            let _ = shutdown.send(true);
            task.abort();
        }
        state
            .as_ref()
            .expect("download playback server installed")
            .register(item_id, files)
    }

    fn revoke(&self, item_id: &str) {
        let state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(server) = state.as_ref() {
            server
                .grants
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .retain(|_grant, value| value.item_id != item_id);
        }
    }

    fn stop(&self) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(server) = state.take() {
            let _ = server.shutdown.send(true);
            server.task.abort();
        }
    }
}

impl PlaybackServerInner {
    fn register(&self, item_id: &str, files: &[PathBuf]) -> AppResult<Vec<String>> {
        let mut grants = self
            .grants
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let current: HashMap<&Path, &str> = grants
            .iter()
            .filter(|(_grant, value)| value.item_id == item_id)
            .map(|(grant, value)| (value.file.as_path(), grant.as_str()))
            .collect();
        if current.len() == files.len()
            && files
                .iter()
                .all(|file| current.contains_key(file.as_path()))
        {
            return Ok(files
                .iter()
                .map(|file| {
                    let grant = current
                        .get(file.as_path())
                        .expect("registered playback file");
                    format!("{}/{}/{}", self.base_url, self.token, grant)
                })
                .collect());
        }
        grants.retain(|_grant, value| value.item_id != item_id);
        Ok(files
            .iter()
            .map(|file| {
                let grant = Uuid::new_v4().simple().to_string();
                grants.insert(
                    grant.clone(),
                    PlaybackGrant {
                        item_id: item_id.to_string(),
                        file: file.to_path_buf(),
                    },
                );
                format!("{}/{}/{}", self.base_url, self.token, grant)
            })
            .collect())
    }
}

impl Drop for DownloadPlaybackServer {
    fn drop(&mut self) {
        self.stop();
    }
}

/// 下载管理器。由 `AppState` 以 `Arc` 持有，后台 worker 需要跨任务存活。
pub struct VideoDownloadManager {
    root: PathBuf,
    playback: DownloadPlaybackServer,
    app: Mutex<Option<AppHandle>>,
    inner: Mutex<InnerState>,
    /// 元数据文件写入串行化，避免 worker 与命令同时替换同一份 `entry.json`。
    io_lock: Mutex<()>,
}

impl VideoDownloadManager {
    pub fn new(root: PathBuf) -> AppResult<Self> {
        std::fs::create_dir_all(&root).map_err(|error| {
            AppError::new(
                "video_download_dir_error",
                format!("创建下载目录失败: {error}"),
            )
        })?;
        let items = load_items(&root);
        let playback_root = root.clone();
        Ok(Self {
            root,
            playback: DownloadPlaybackServer::new(playback_root),
            app: Mutex::new(None),
            inner: Mutex::new(InnerState {
                items,
                worker_running: false,
                active_id: None,
                cancel: None,
                active_done: None,
                deleting: HashSet::new(),
            }),
            io_lock: Mutex::new(()),
        })
    }

    /// 启动时接管已有的未完成队列。必须在 `app.manage(state)` 之后调用：
    /// worker 依赖 `AppHandle::state::<AppState>()` 读取登录态与代理设置。
    pub fn attach(self: &Arc<Self>, app: AppHandle) {
        *self
            .app
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(app.clone());
        spawn_worker(self.clone(), app);
    }

    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
    pub fn root_path(&self) -> String {
        crate::app_paths::path_to_string(&self.root)
    }

    pub fn list(&self) -> Vec<VideoDownloadItem> {
        let mut items = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .items
            .clone();
        sort_items(&mut items);
        items
    }

    /// 按 id 取一个条目；命令层用它校验「已完成」再打开文件。
    pub fn get(&self, id: &str) -> AppResult<VideoDownloadItem> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .items
            .iter()
            .find(|item| item.id == id)
            .cloned()
            .ok_or_else(not_found)
    }

    /// 为已完成下载生成应用内播放信息。前端只消费这里返回的 URL，不能传入路径。
    pub async fn playback_info(&self, id: &str) -> AppResult<VideoDownloadPlaybackInfo> {
        let item = self.get(id)?;
        if item.status != VideoDownloadStatus::Completed {
            return Err(AppError::new(
                "video_download_not_completed",
                "下载尚未完成，暂时无法播放",
            ));
        }
        let file = validate_playback_file(&self.root, &item.id, Path::new(&item.file_path))?;
        let cached = load_cached_subtitles(&self.root, &item.id);
        let mut files = vec![file.clone()];
        let mut cached_subtitles = Vec::new();
        let mut subtitle_error = cached.subtitle_error;
        for subtitle in cached.subtitles {
            let path = self.root.join(&item.id).join(&subtitle.file_name);
            match validate_download_file(&self.root, &item.id, &path, is_subtitle_file) {
                Ok(path) => {
                    files.push(path);
                    cached_subtitles.push(subtitle);
                }
                Err(_) => {
                    let missing = "部分字幕缓存已丢失，重新下载可恢复";
                    subtitle_error = Some(match subtitle_error.take() {
                        Some(error) => format!("{error}；{missing}"),
                        None => missing.to_string(),
                    });
                }
            }
        }
        let stored = read_stored_entry(&self.root, &item.id);
        let mut danmaku_error = stored
            .as_ref()
            .and_then(|entry| entry.danmaku_error.clone());
        let danmaku_available = stored.is_some_and(|entry| entry.danmaku_cached);
        let danmaku_file = self.root.join(&item.id).join(DANMAKU_FILE);
        let danmaku_path = if danmaku_available {
            match read_cached_danmaku(&self.root, &item.id) {
                Some(_) => {
                    validate_download_file(&self.root, &item.id, &danmaku_file, is_danmaku_file)
                        .ok()
                }
                None => None,
            }
        } else {
            None
        };
        if danmaku_available && danmaku_path.is_none() {
            danmaku_error = Some("弹幕缓存已丢失或损坏，重新下载可恢复".to_string());
        }
        if let Some(path) = danmaku_path.as_ref() {
            files.push(path.clone());
        }
        let urls = self.playback.urls(&item.id, &files).await?;
        let current = {
            let inner = self
                .inner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if inner.deleting.contains(&item.id) {
                Err(deleting_error())
            } else if let Some(current) = inner.items.iter().find(|entry| entry.id == item.id) {
                if current.status != VideoDownloadStatus::Completed {
                    Err(AppError::new(
                        "video_download_not_completed",
                        "下载尚未完成，暂时无法播放",
                    ))
                } else {
                    validate_playback_file(&self.root, &current.id, Path::new(&current.file_path))
                        .map(|_| current.clone())
                }
            } else {
                Err(not_found())
            }
        };
        let item = match current {
            Ok(item) => item,
            Err(error) => {
                // 启动本地服务期间条目可能已被删除；撤掉本次刚注册的授权，
                // 防止同一 id 重新下载后旧 URL 又意外生效。
                self.playback.revoke(&item.id);
                return Err(error);
            }
        };
        let mut urls = urls.into_iter();
        let url = urls.next().expect("playback media URL");
        let subtitles = cached_subtitles
            .into_iter()
            .map(|subtitle| (subtitle, urls.next().expect("playback subtitle URL")))
            .map(|(subtitle, url)| VideoDownloadSubtitle {
                id: subtitle.id,
                lan: subtitle.lan,
                lan_doc: subtitle.lan_doc,
                url,
            })
            .collect();
        Ok(VideoDownloadPlaybackInfo {
            progress: item.watch_progress,
            item,
            url,
            subtitles,
            subtitle_error,
            danmaku_url: danmaku_path.and_then(|_| urls.next()),
            danmaku_error,
        })
    }

    /// 保存应用内播放进度。`duration` 来自实际媒体读数，单独保存，不回写下载
    /// 条目的 `duration`。
    pub fn report_watch_progress(&self, id: &str, progress: f64, duration: f64) -> AppResult<()> {
        if !progress.is_finite() || progress < 0.0 || !duration.is_finite() || duration < 0.0 {
            return Err(AppError::new(
                "video_download_invalid_request",
                "播放进度或时长无效",
            ));
        }
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if inner.deleting.contains(id) {
            return Err(deleting_error());
        }
        let item = inner
            .items
            .iter_mut()
            .find(|item| item.id == id)
            .ok_or_else(not_found)?;
        if item.status != VideoDownloadStatus::Completed {
            return Err(AppError::new(
                "video_download_not_completed",
                "下载尚未完成，无法保存播放进度",
            ));
        }
        validate_playback_file(&self.root, &item.id, Path::new(&item.file_path))?;

        let effective_duration = if duration > 0.0 {
            duration
        } else if item.watch_duration > 0.0 {
            item.watch_duration
        } else {
            item.duration
        };
        let next_progress = if effective_duration > 0.0 {
            progress.min(effective_duration)
        } else {
            progress
        };
        let mut updated = item.clone();
        updated.watch_progress = next_progress;
        if duration > 0.0 {
            updated.watch_duration = duration;
        }
        persist_item(self, &updated)?;
        item.watch_progress = updated.watch_progress;
        item.watch_duration = updated.watch_duration;
        Ok(())
    }

    pub fn start(self: &Arc<Self>, input: VideoDownloadInput) -> AppResult<VideoDownloadItem> {
        let cid = input.cid;
        if cid <= 0 {
            return Err(AppError::new(
                "video_download_invalid_request",
                "下载请求缺少 cid",
            ));
        }
        let bvid = normalize_id(input.bvid);
        let ep_id = normalize_id(input.ep_id);
        if bvid.is_none() && ep_id.is_none() {
            return Err(AppError::new(
                "video_download_invalid_request",
                "下载请求缺少 bvid 或 ep_id",
            ));
        }
        let title = input.title.trim();
        if title.is_empty() {
            return Err(AppError::new(
                "video_download_invalid_request",
                "下载请求缺少标题",
            ));
        }
        let id = item_id(bvid.as_deref(), ep_id.as_deref(), cid)?;
        let dir = self.root.join(&id);
        let file_name = safe_video_file_name(title, &id);
        let now = unix_seconds();
        let qn = input.qn.unwrap_or(0).max(0);
        let submit = {
            let mut inner = self
                .inner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if inner.deleting.contains(&id) {
                return Err(deleting_error());
            }
            let submit = if let Some(index) = inner.items.iter().position(|item| item.id == id) {
                let active = inner.active_id.as_deref() == Some(id.as_str());
                let existing = &mut inner.items[index];
                // 已完成/进行中的同一内容不重复入队：重复点击只会让用户以为
                // 自己多下了一份，实际共用同一目录。
                if existing.status != VideoDownloadStatus::Failed
                    && existing.status != VideoDownloadStatus::Paused
                {
                    return Ok(existing.clone());
                }
                // 重试允许换画质；旧分片属于另一条 profile，混在一起会得到
                // 无法解复用的文件，宁可从头下。
                if existing.qn != qn {
                    if active {
                        // 暂停命令会先返回；旧 worker 此时可能还握着文件句柄。
                        // 把清理推迟到下一代 worker 启动后，避免 Windows 上删
                        // 不掉文件又把旧画质字节拼进新分片。
                        existing.discard_partials = true;
                    } else {
                        remove_partial_tracks(&dir).map_err(|error| {
                            AppError::new(
                                "video_download_dir_error",
                                format!("清理旧画质分片失败: {error}"),
                            )
                        })?;
                    }
                    existing.downloaded_bytes = 0;
                    existing.total_bytes = 0;
                }
                existing.request_generation = next_request_generation(existing.request_generation);
                existing.qn = qn;
                existing.title = title.to_string();
                existing.cover = input.cover.unwrap_or_default();
                existing.author = input.author.unwrap_or_default();
                existing.duration = input.duration.unwrap_or(0.0).max(0.0);
                existing.status = VideoDownloadStatus::Queued;
                existing.error = None;
                existing.completed_at = None;
                existing.file_path = crate::app_paths::path_to_string(&dir.join(&file_name));
                submit_entry(self, existing, &file_name)?;
                existing.clone()
            } else {
                let item = VideoDownloadItem {
                    id: id.clone(),
                    bvid,
                    cid,
                    ep_id,
                    title: title.to_string(),
                    cover: input.cover.unwrap_or_default(),
                    author: input.author.unwrap_or_default(),
                    duration: input.duration.unwrap_or(0.0).max(0.0),
                    qn,
                    quality_label: String::new(),
                    status: VideoDownloadStatus::Queued,
                    downloaded_bytes: 0,
                    total_bytes: 0,
                    created_at: now,
                    completed_at: None,
                    file_path: crate::app_paths::path_to_string(&dir.join(&file_name)),
                    error: None,
                    request_generation: 1,
                    discard_partials: false,
                    watch_progress: 0.0,
                    watch_duration: 0.0,
                };
                std::fs::create_dir_all(&dir).map_err(|error| {
                    AppError::new(
                        "video_download_dir_error",
                        format!("创建下载目录失败: {error}"),
                    )
                })?;
                submit_entry(self, &item, &file_name)?;
                inner.items.push(item.clone());
                item
            };
            self.emit_changed(Some(&submit));
            submit
        };
        if let Some(app) = self.app_handle() {
            spawn_worker(self.clone(), app);
        }
        Ok(submit)
    }

    pub fn pause(&self, id: &str) -> AppResult<VideoDownloadItem> {
        let changed = {
            let mut inner = self
                .inner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if inner.deleting.contains(id) {
                return Err(deleting_error());
            }
            let Some(index) = inner.items.iter().position(|item| item.id == id) else {
                return Err(not_found());
            };
            match inner.items[index].status {
                VideoDownloadStatus::Merging => {
                    return Err(AppError::new(
                        "video_download_busy",
                        "正在合并音视频，请稍候",
                    ));
                }
                VideoDownloadStatus::Downloading | VideoDownloadStatus::Queued => {
                    // worker 会在下一个数据块边界停下并写回 paused；
                    // 这里先标状态让按钮立即响应，两处写入的是同一件事。
                    inner.items[index].status = VideoDownloadStatus::Paused;
                    inner.items[index].request_generation =
                        next_request_generation(inner.items[index].request_generation);
                    if inner.active_id.as_deref() == Some(id)
                        && let Some(cancel) = &inner.cancel
                    {
                        let _ = cancel.send(true);
                    }
                    let item = inner.items[index].clone();
                    // 与 start/worker 保持一致：状态、磁盘记录和事件在同一
                    // 把锁内发布，避免迟到的旧快照覆盖更新的 generation。
                    let _ = persist_item(self, &item);
                    self.emit_changed(Some(&item));
                    Some(item)
                }
                VideoDownloadStatus::Paused
                | VideoDownloadStatus::Completed
                | VideoDownloadStatus::Failed => return Ok(inner.items[index].clone()),
            }
        };
        changed.ok_or_else(not_found)
    }

    pub fn resume(self: &Arc<Self>, id: &str) -> AppResult<VideoDownloadItem> {
        let resumed = {
            let mut inner = self
                .inner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if inner.deleting.contains(id) {
                return Err(deleting_error());
            }
            let Some(item) = inner.items.iter_mut().find(|item| item.id == id) else {
                return Err(not_found());
            };
            match item.status {
                VideoDownloadStatus::Failed | VideoDownloadStatus::Paused => {
                    item.status = VideoDownloadStatus::Queued;
                    item.error = None;
                    item.request_generation = next_request_generation(item.request_generation);
                    let resumed = item.clone();
                    persist_item(self, &resumed)?;
                    self.emit_changed(Some(&resumed));
                    resumed
                }
                _ => return Ok(item.clone()),
            }
        };
        if let Some(app) = self.app_handle() {
            spawn_worker(self.clone(), app);
        }
        Ok(resumed)
    }

    pub async fn remove(&self, id: &str) -> AppResult<()> {
        self.playback.revoke(id);
        let done = {
            let mut inner = self
                .inner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if inner.deleting.contains(id) {
                return Err(deleting_error());
            }
            let Some(index) = inner.items.iter().position(|item| item.id == id) else {
                return Err(not_found());
            };
            inner.deleting.insert(id.to_string());
            if inner.active_id.as_deref() == Some(id) {
                if let Some(cancel) = &inner.cancel {
                    let _ = cancel.send(true);
                }
                inner.active_done.clone()
            } else {
                inner.items.remove(index);
                None
            }
        };
        // 活动条目先等 worker 离开写入路径，再删目录：Windows 上打开中的文件
        // 会让 remove_dir_all 失败，随后残留目录又会被启动扫描当成未完成任务。
        if let Some(done) = done {
            done.notified().await;
            let mut inner = self
                .inner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if let Some(index) = inner.items.iter().position(|item| item.id == id) {
                inner.items.remove(index);
            }
        }
        let dir = self.root.join(id);
        let remove_result = match std::fs::remove_dir_all(&dir) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error),
        };
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .deleting
            .remove(id);
        if let Err(error) = remove_result {
            return Err(AppError::new(
                "video_download_delete_error",
                format!("删除下载失败: {error}"),
            ));
        }
        self.emit_removed(id);
        Ok(())
    }

    fn app_handle(&self) -> Option<AppHandle> {
        self.app
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    fn emit_changed(&self, item: Option<&VideoDownloadItem>) {
        let Some(app) = self.app_handle() else { return };
        let Some(item) = item else { return };
        let _ = app.emit(
            VIDEO_DOWNLOAD_CHANGED_EVENT,
            VideoDownloadChangedEvent {
                id: item.id.clone(),
                item: Some(item.clone()),
            },
        );
    }

    fn emit_removed(&self, id: &str) {
        let Some(app) = self.app_handle() else { return };
        let _ = app.emit(
            VIDEO_DOWNLOAD_CHANGED_EVENT,
            VideoDownloadChangedEvent {
                id: id.to_string(),
                item: None,
            },
        );
    }

    fn report_progress(
        &self,
        id: &str,
        request_generation: u64,
        downloaded_bytes: u64,
        total_bytes: u64,
    ) {
        {
            let mut inner = self
                .inner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let Some(item) = inner.items.iter_mut().find(|item| item.id == id) else {
                return;
            };
            if item.request_generation != request_generation {
                return;
            }
            item.downloaded_bytes = downloaded_bytes;
            item.total_bytes = total_bytes;
            let status = item.status;
            let Some(app) = self.app_handle() else { return };
            let _ = app.emit(
                VIDEO_DOWNLOAD_PROGRESS_EVENT,
                VideoDownloadProgressEvent {
                    id: id.to_string(),
                    downloaded_bytes,
                    total_bytes,
                    status,
                },
            );
        }
    }

    fn update_item_if_current(
        &self,
        id: &str,
        request_generation: u64,
        apply: impl FnOnce(&mut VideoDownloadItem),
    ) -> Option<VideoDownloadItem> {
        let updated = {
            let mut inner = self
                .inner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let item = inner.items.iter_mut().find(|item| item.id == id)?;
            if item.request_generation != request_generation {
                return None;
            }
            apply(item);
            let updated = item.clone();
            let _ = persist_item(self, &updated);
            self.emit_changed(Some(&updated));
            updated
        };
        Some(updated)
    }
}

fn submit_entry(
    manager: &VideoDownloadManager,
    item: &VideoDownloadItem,
    file_name: &str,
) -> AppResult<()> {
    let _guard = manager
        .io_lock
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    write_entry(&manager.root, item, file_name)
}

fn write_entry(root: &Path, item: &VideoDownloadItem, file_name: &str) -> AppResult<()> {
    let existing = read_stored_entry(root, &item.id);
    let stored = StoredEntry {
        item: item.clone(),
        file_name: file_name.to_string(),
        discard_partials: item.discard_partials,
        watch_progress: item.watch_progress,
        watch_duration: item.watch_duration,
        subtitles: existing
            .as_ref()
            .map(|entry| entry.subtitles.clone())
            .unwrap_or_default(),
        subtitle_error: existing
            .as_ref()
            .and_then(|entry| entry.subtitle_error.clone()),
        danmaku_cached: existing.as_ref().is_some_and(|entry| entry.danmaku_cached),
        danmaku_error: existing.and_then(|entry| entry.danmaku_error),
    };
    write_stored_entry(root, &stored)
}

fn write_stored_entry(root: &Path, stored: &StoredEntry) -> AppResult<()> {
    let item = &stored.item;
    let bytes = serde_json::to_vec_pretty(stored).map_err(|error| {
        AppError::new(
            "video_download_metadata_error",
            format!("序列化下载信息失败: {error}"),
        )
    })?;
    let dir = root.join(&item.id);
    std::fs::create_dir_all(&dir).map_err(|error| {
        AppError::new(
            "video_download_dir_error",
            format!("创建下载目录失败: {error}"),
        )
    })?;
    crate::app_paths::write_recoverable_file(&dir.join(ENTRY_FILE), &bytes, |bytes| {
        serde_json::from_slice::<StoredEntry>(bytes).is_ok()
    })
    .map_err(|error| {
        AppError::new(
            "video_download_metadata_error",
            format!("保存下载信息失败: {error}"),
        )
    })
}

fn read_stored_entry(root: &Path, id: &str) -> Option<StoredEntry> {
    read_stored_entry_from_dir(&root.join(id))
}

fn read_stored_entry_from_dir(dir: &Path) -> Option<StoredEntry> {
    let bytes = std::fs::read(dir.join(ENTRY_FILE)).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn load_cached_subtitles(root: &Path, id: &str) -> CachedSubtitleState {
    read_cached_subtitles_from_dir(&root.join(id))
}

fn read_cached_subtitles_from_dir(dir: &Path) -> CachedSubtitleState {
    read_stored_entry_from_dir(dir)
        .map(|stored| CachedSubtitleState {
            subtitles: stored.subtitles,
            subtitle_error: stored.subtitle_error,
        })
        .unwrap_or_default()
}

fn persist_cached_subtitles(
    manager: &VideoDownloadManager,
    item: &VideoDownloadItem,
    state: &CachedSubtitleState,
) -> AppResult<()> {
    let _guard = manager
        .io_lock
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let file_name = Path::new(&item.file_path)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| safe_file_name(name))
        .ok_or_else(|| AppError::new("video_download_metadata_error", "下载文件名无效"))?;
    let existing = read_stored_entry(&manager.root, &item.id);
    let mut stored = existing.unwrap_or_else(|| StoredEntry {
        item: item.clone(),
        file_name: file_name.to_string(),
        discard_partials: item.discard_partials,
        watch_progress: item.watch_progress,
        watch_duration: item.watch_duration,
        subtitles: Vec::new(),
        subtitle_error: None,
        danmaku_cached: false,
        danmaku_error: None,
    });
    stored.file_name = file_name.to_string();
    stored.subtitles = state.subtitles.clone();
    stored.subtitle_error = state.subtitle_error.clone();
    write_stored_entry(&manager.root, &stored)
}

fn persist_cached_subtitles_for_completion(
    manager: &VideoDownloadManager,
    item: &VideoDownloadItem,
    state: &CachedSubtitleState,
    downloaded_bytes: u64,
    total_bytes: u64,
) -> Result<(), Box<DownloadOutcome>> {
    persist_cached_subtitles(manager, item, state).map_err(|error| {
        Box::new(DownloadOutcome::failed(
            format!("保存字幕缓存信息失败：{}", error.message),
            downloaded_bytes,
            total_bytes,
        ))
    })
}

fn persist_cached_danmaku(
    manager: &VideoDownloadManager,
    item: &VideoDownloadItem,
    state: &CachedDanmakuState,
) -> AppResult<()> {
    let _guard = manager
        .io_lock
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut stored = read_stored_entry(&manager.root, &item.id)
        .ok_or_else(|| AppError::new("video_download_metadata_error", "下载信息已丢失"))?;
    stored.danmaku_cached = state.cached;
    stored.danmaku_error = state.error.clone();
    write_stored_entry(&manager.root, &stored)
}

fn read_cached_danmaku(root: &Path, id: &str) -> Option<Vec<CachedDanmakuSegment>> {
    let path = validate_download_file(root, id, &root.join(id).join(DANMAKU_FILE), is_danmaku_file)
        .ok()?;
    let bytes = std::fs::read(path).ok()?;
    let segments: Vec<CachedDanmakuSegment> = serde_json::from_slice(&bytes).ok()?;
    let mut indices = HashSet::new();
    if segments
        .iter()
        .any(|segment| segment.segment_index <= 0 || !indices.insert(segment.segment_index))
    {
        return None;
    }
    Some(segments)
}

fn write_cached_danmaku(dir: &Path, segments: &[CachedDanmakuSegment]) -> AppResult<()> {
    let bytes = serde_json::to_vec(segments).map_err(|error| {
        AppError::new(
            "video_download_danmaku_error",
            format!("序列化弹幕失败：{error}"),
        )
    })?;
    crate::app_paths::write_recoverable_file(&dir.join(DANMAKU_FILE), &bytes, |bytes| {
        serde_json::from_slice::<Vec<CachedDanmakuSegment>>(bytes).is_ok()
    })
    .map_err(|error| {
        AppError::new(
            "video_download_danmaku_error",
            format!("保存弹幕失败：{error}"),
        )
    })
}

fn persist_item(manager: &VideoDownloadManager, item: &VideoDownloadItem) -> AppResult<()> {
    let file_name = Path::new(&item.file_path)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| safe_file_name(name))
        .map(str::to_string)
        .ok_or_else(|| AppError::new("video_download_metadata_error", "下载文件名无效"))?;
    submit_entry(manager, item, &file_name)
}

fn load_items(root: &Path) -> Vec<VideoDownloadItem> {
    let mut items = Vec::new();
    let Ok(read_dir) = std::fs::read_dir(root) else {
        return items;
    };
    for entry in read_dir.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(id) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if !safe_id(id) {
            continue;
        }
        let entry_path = path.join(ENTRY_FILE);
        let Ok(bytes) = std::fs::read(&entry_path) else {
            continue;
        };
        let Ok(mut stored) = serde_json::from_slice::<StoredEntry>(&bytes) else {
            continue;
        };
        if !safe_file_name(&stored.file_name) {
            continue;
        }
        let mut changed = false;
        let item = &mut stored.item;
        item.id = id.to_string();
        item.file_path = crate::app_paths::path_to_string(&path.join(&stored.file_name));
        item.discard_partials = stored.discard_partials;
        item.watch_progress = finite_non_negative(stored.watch_progress);
        item.watch_duration = finite_non_negative(stored.watch_duration);
        if item.watch_progress != stored.watch_progress
            || item.watch_duration != stored.watch_duration
        {
            changed = true;
        }
        match item.status {
            VideoDownloadStatus::Downloading | VideoDownloadStatus::Merging => {
                item.status = VideoDownloadStatus::Paused;
                item.error = Some("应用退出时中断，可继续下载".to_string());
                changed = true;
            }
            VideoDownloadStatus::Completed if !path.join(&stored.file_name).is_file() => {
                item.status = VideoDownloadStatus::Failed;
                item.error = Some("下载文件已被移动或删除".to_string());
                changed = true;
            }
            _ => {}
        }
        if !matches!(item.status, VideoDownloadStatus::Completed) {
            let downloaded = partial_size(&path.join(VIDEO_PART))
                .saturating_add(partial_size(&path.join(AUDIO_PART)));
            if item.downloaded_bytes != downloaded {
                item.downloaded_bytes = downloaded;
                changed = true;
            }
        }
        if changed {
            let _ = write_entry(root, item, &stored.file_name);
        }
        items.push(stored.item);
    }
    sort_items(&mut items);
    items
}

fn partial_size(path: &Path) -> u64 {
    std::fs::metadata(path)
        .map(|metadata| metadata.len())
        .unwrap_or(0)
}

fn sort_items(items: &mut [VideoDownloadItem]) {
    items.sort_by(|left, right| {
        let left_rank = if left.status.is_active() { 0 } else { 1 };
        let right_rank = if right.status.is_active() { 0 } else { 1 };
        left_rank
            .cmp(&right_rank)
            .then_with(|| right.created_at.cmp(&left.created_at))
    });
}

fn spawn_worker(manager: Arc<VideoDownloadManager>, app: AppHandle) {
    let queue = {
        let mut inner = manager
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if inner.worker_running {
            return;
        }
        let Some(index) = inner.items.iter().position(|item| {
            item.status == VideoDownloadStatus::Queued && !inner.deleting.contains(&item.id)
        }) else {
            return;
        };
        inner.worker_running = true;
        let (cancel_tx, cancel_rx) = watch::channel(false);
        inner.cancel = Some(cancel_tx);
        let done = Arc::new(Notify::new());
        inner.active_done = Some(done.clone());
        inner.items[index].status = VideoDownloadStatus::Downloading;
        inner.items[index].error = None;
        let item = inner.items[index].clone();
        inner.active_id = Some(item.id.clone());
        // 状态与磁盘记录必须在同一把 inner 锁下发布，否则紧随其后的暂停
        // 可能先持久化 paused，又被这里迟到的 downloading 覆盖。
        let _ = persist_item(&manager, &item);
        manager.emit_changed(Some(&item));
        (item, cancel_rx, done)
    };
    let (item, cancel_rx, done) = queue;
    let handle = tauri::async_runtime::spawn(async move {
        run_worker(manager, app, item, cancel_rx, done).await;
    });
    // JoinHandle 只是让任务不被误认为同步工作；生命周期由运行时管理。
    drop(handle);
}

async fn run_worker(
    manager: Arc<VideoDownloadManager>,
    app: AppHandle,
    item: VideoDownloadItem,
    cancel_rx: watch::Receiver<bool>,
    done: Arc<Notify>,
) {
    let outcome = download_item(&manager, &app, &item, cancel_rx).await;
    {
        let mut inner = manager
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let updated = finish_worker_state(&mut inner, &item, outcome);
        if let Some(current) = &updated {
            // 与状态一起持久化并在锁内发布，保证暂停/重试不会被旧终态事件
            // 或旧 entry.json 覆盖。
            let _ = persist_item(&manager, current);
            manager.emit_changed(Some(current));
        }
    }
    // 删活动条目的一方在等这个信号；必须在启动下一个任务前唤醒，
    // 否则下一次 `spawn_worker` 会换掉 `active_done`。
    done.notify_one();
    // 队列里还有条目就继续；暂停/失败不会阻塞后面的条目。
    spawn_worker(manager, app);
}

/// 收尾当前 worker。若用户已暂停、重试或删除该条目，代次会变化；此时只允许
/// 暂停态刷新字节数，绝不能把旧 worker 的 paused/completed 写回新请求。
fn finish_worker_state(
    inner: &mut InnerState,
    item: &VideoDownloadItem,
    outcome: DownloadOutcome,
) -> Option<VideoDownloadItem> {
    inner.worker_running = false;
    inner.active_id = None;
    inner.cancel = None;
    inner.active_done = None;
    let deleting = inner.deleting.contains(&item.id);
    let stored = inner.items.iter_mut().find(|entry| entry.id == item.id)?;
    if stored.request_generation == item.request_generation && !deleting {
        apply_download_outcome(stored, outcome);
    } else if stored.status == VideoDownloadStatus::Paused {
        // 纯暂停没有新 queued 请求，仍把最后一个数据块的进度带回来。
        stored.downloaded_bytes = outcome.downloaded_bytes;
        stored.total_bytes = outcome.total_bytes;
    }
    Some(stored.clone())
}

fn apply_download_outcome(stored: &mut VideoDownloadItem, outcome: DownloadOutcome) {
    stored.status = outcome.status;
    stored.downloaded_bytes = outcome.downloaded_bytes;
    stored.total_bytes = outcome.total_bytes;
    stored.qn = outcome.qn.unwrap_or(stored.qn);
    if let Some(label) = outcome.quality_label {
        stored.quality_label = label;
    }
    if let Some(duration) = outcome.duration.filter(|duration| *duration > 0.0) {
        stored.duration = duration;
    }
    if let Some(path) = outcome.file_path {
        stored.file_path = path;
    }
    stored.error = outcome.error;
    if outcome.status == VideoDownloadStatus::Completed {
        stored.completed_at = Some(unix_seconds());
    }
}

struct DownloadOutcome {
    status: VideoDownloadStatus,
    downloaded_bytes: u64,
    total_bytes: u64,
    qn: Option<i64>,
    quality_label: Option<String>,
    duration: Option<f64>,
    file_path: Option<String>,
    error: Option<String>,
}

impl DownloadOutcome {
    fn paused(downloaded_bytes: u64, total_bytes: u64) -> Self {
        Self {
            status: VideoDownloadStatus::Paused,
            downloaded_bytes,
            total_bytes,
            qn: None,
            quality_label: None,
            duration: None,
            file_path: None,
            error: None,
        }
    }

    fn failed(error: String, downloaded_bytes: u64, total_bytes: u64) -> Self {
        Self {
            status: VideoDownloadStatus::Failed,
            downloaded_bytes,
            total_bytes,
            qn: None,
            quality_label: None,
            duration: None,
            file_path: None,
            error: Some(error),
        }
    }
}

enum TrackError {
    Paused,
    Failed(AppError),
}

async fn download_item(
    manager: &Arc<VideoDownloadManager>,
    app: &AppHandle,
    item: &VideoDownloadItem,
    cancel: watch::Receiver<bool>,
) -> DownloadOutcome {
    let dir = manager.root.join(&item.id);
    if item.discard_partials {
        // 上一代 worker 已经退出后才会走到这里，因此此刻清理不会撞上
        // Windows 的文件占用。
        if let Err(error) = remove_partial_tracks(&dir) {
            return DownloadOutcome::failed(
                format!("清理旧画质分片失败: {error}"),
                0,
                item.total_bytes,
            );
        }
        if manager
            .update_item_if_current(&item.id, item.request_generation, |stored| {
                stored.discard_partials = false;
                stored.downloaded_bytes = 0;
                stored.total_bytes = 0;
            })
            .is_none()
        {
            return DownloadOutcome::paused(0, item.total_bytes);
        }
    }
    let (downloaded, total) = partial_bytes(manager, item);
    if *cancel.borrow() {
        return DownloadOutcome::paused(downloaded, total);
    }
    let state = app.state::<AppState>();
    let site = match resolve_bilibili(&state) {
        Ok(site) => site,
        Err(error) => return DownloadOutcome::failed(error.message, downloaded, total),
    };
    let route = match state
        .conn()
        .and_then(|conn| crate::settings::get(&conn).map(|settings| settings.proxy_route()))
    {
        Ok(route) => route,
        Err(error) => return DownloadOutcome::failed(error.message, downloaded, total),
    };
    let request = VideoPlayRequest {
        bvid: item.bvid.clone(),
        cid: item.cid,
        ep_id: item.ep_id.clone(),
        qn: (item.qn > 0).then_some(item.qn),
        audio_only: Some(false),
        media_cache: Some(false),
    };
    let selection = match site.video_play_selection(&request).await {
        Ok(selection) => selection,
        Err(error) => return DownloadOutcome::failed(error.message, downloaded, total),
    };
    if *cancel.borrow() {
        return DownloadOutcome::paused(downloaded, total);
    }
    let duration = selection.video.sidx.duration_secs();
    let total_bytes = track_total(&selection.video)
        + selection
            .audio
            .as_ref()
            .map(track_total)
            .unwrap_or_default();
    let (downloaded_now, _) = partial_bytes(manager, item);
    if manager
        .update_item_if_current(&item.id, item.request_generation, |stored| {
            stored.qn = selection.quality;
            stored.quality_label = selection.quality_label.clone();
            if duration > 0.0 {
                stored.duration = duration;
            }
            stored.total_bytes = total_bytes;
            stored.downloaded_bytes = downloaded_now;
        })
        .is_none()
    {
        return DownloadOutcome::paused(downloaded_now, total_bytes);
    }
    let client = match crate::http_client::recording_stream_client_for_route(&route) {
        Ok(client) => client,
        Err(error) => return DownloadOutcome::failed(error.message, downloaded_now, total_bytes),
    };
    let headers = video_stream_headers();
    let video_part = dir.join(VIDEO_PART);
    let audio_part = dir.join(AUDIO_PART);

    match download_track(&TrackDownload {
        manager,
        item_id: &item.id,
        request_generation: item.request_generation,
        client: &client,
        headers: &headers,
        track: &selection.video,
        part: &video_part,
        base_bytes: 0,
        total_bytes,
        cancel: &cancel,
    })
    .await
    {
        Ok(_) => {}
        Err(TrackError::Paused) => {
            let (downloaded, _) = partial_bytes(manager, item);
            return DownloadOutcome::paused(downloaded, total_bytes);
        }
        Err(TrackError::Failed(error)) => {
            let (downloaded, _) = partial_bytes(manager, item);
            return DownloadOutcome::failed(error.message, downloaded, total_bytes);
        }
    }
    if let Some(audio) = selection.audio.as_ref() {
        let video_bytes = partial_size(&video_part);
        match download_track(&TrackDownload {
            manager,
            item_id: &item.id,
            request_generation: item.request_generation,
            client: &client,
            headers: &headers,
            track: audio,
            part: &audio_part,
            base_bytes: video_bytes,
            total_bytes,
            cancel: &cancel,
        })
        .await
        {
            Ok(_) => {}
            Err(TrackError::Paused) => {
                let (downloaded, _) = partial_bytes(manager, item);
                return DownloadOutcome::paused(downloaded, total_bytes);
            }
            Err(TrackError::Failed(error)) => {
                let (downloaded, _) = partial_bytes(manager, item);
                return DownloadOutcome::failed(error.message, downloaded, total_bytes);
            }
        }
    }
    let Some(subtitle_state) = cache_download_subtitles(&site, &request, &dir, &cancel).await
    else {
        let (downloaded, _) = partial_bytes(manager, item);
        return DownloadOutcome::paused(downloaded, total_bytes);
    };
    let Some(danmaku_state) =
        cache_download_danmaku(&manager.root, &item.id, duration, &cancel, |index| {
            site.video_danmaku(item.cid, index)
        })
        .await
    else {
        let (downloaded, _) = partial_bytes(manager, item);
        return DownloadOutcome::paused(downloaded, total_bytes);
    };
    if *cancel.borrow() {
        let (downloaded, _) = partial_bytes(manager, item);
        return DownloadOutcome::paused(downloaded, total_bytes);
    }

    let file_name = Path::new(&item.file_path)
        .file_name()
        .and_then(|name| name.to_str())
        .map(str::to_string)
        .unwrap_or_else(|| safe_video_file_name(&item.title, &item.id));
    let final_path = dir.join(&file_name);
    let output_part = dir.join(OUTPUT_PART);
    let (downloaded_before_merge, _) = partial_bytes(manager, item);
    if let Err(outcome) = persist_cached_subtitles_for_completion(
        manager,
        item,
        &subtitle_state,
        downloaded_before_merge,
        total_bytes,
    ) {
        return *outcome;
    }
    if let Err(error) = persist_cached_danmaku(manager, item, &danmaku_state) {
        return DownloadOutcome::failed(
            format!("保存弹幕缓存信息失败：{}", error.message),
            downloaded_before_merge,
            total_bytes,
        );
    }
    if manager
        .update_item_if_current(&item.id, item.request_generation, |stored| {
            stored.status = VideoDownloadStatus::Merging;
        })
        .is_none()
    {
        return DownloadOutcome::paused(downloaded_before_merge, total_bytes);
    }
    let audio = selection.audio.as_ref().map(|_| audio_part.as_path());
    if let Err(error) = merge_download_tracks(app, &video_part, audio, &output_part).await {
        let (downloaded, _) = partial_bytes(manager, item);
        return DownloadOutcome::failed(
            format!("合并音视频失败: {error}"),
            downloaded,
            total_bytes,
        );
    }
    if let Err(error) = replace_output(&output_part, &final_path) {
        let (downloaded, _) = partial_bytes(manager, item);
        return DownloadOutcome::failed(format!("保存成片失败: {error}"), downloaded, total_bytes);
    }
    let _ = std::fs::remove_file(&video_part);
    let _ = std::fs::remove_file(&audio_part);
    DownloadOutcome {
        status: VideoDownloadStatus::Completed,
        downloaded_bytes: total_bytes,
        total_bytes,
        qn: Some(selection.quality),
        quality_label: Some(selection.quality_label),
        duration: Some(duration),
        file_path: Some(crate::app_paths::path_to_string(&final_path)),
        error: None,
    }
}

async fn cache_download_danmaku<F, Fut>(
    root: &Path,
    id: &str,
    duration: f64,
    cancel: &watch::Receiver<bool>,
    fetch: F,
) -> Option<CachedDanmakuState>
where
    F: Fn(i64) -> Fut,
    Fut: Future<Output = AppResult<VideoDanmakuSegment>>,
{
    let dir = root.join(id);
    let mut segments = read_cached_danmaku(root, id).unwrap_or_default();
    // 按完整媒体时长遍历；空段仍是有效结果，不能据此提前结束。
    let count = (finite_non_negative(duration) / 360.0).ceil().max(1.0) as i64;
    segments.retain(|segment| segment.segment_index <= count);
    let mut failed = 0;
    let mut last_error = String::new();
    for index in 1..=count {
        if *cancel.borrow() {
            return None;
        }
        if let Some(cached) = segments
            .iter()
            .find(|segment| segment.segment_index == index)
        {
            if !cached.segment.has_more {
                break;
            }
            continue;
        }
        match await_with_cancel(fetch(index), cancel).await? {
            Ok(segment) => {
                let has_more = segment.has_more;
                segments.push(CachedDanmakuSegment {
                    segment_index: index,
                    segment,
                });
                segments.sort_by_key(|segment| segment.segment_index);
                // 每段独立提交完整快照，暂停或进程退出后复用成功段，只补失败段。
                if let Err(error) = write_cached_danmaku(&dir, &segments) {
                    return Some(CachedDanmakuState {
                        cached: read_cached_danmaku(root, id).is_some(),
                        error: Some(error.message),
                    });
                }
                if !has_more {
                    break;
                }
            }
            Err(error) => {
                failed += 1;
                last_error = error.message;
            }
        }
    }
    let cached = read_cached_danmaku(root, id).is_some();
    Some(CachedDanmakuState {
        cached,
        error: (failed > 0).then(|| {
            let retained = if cached {
                "；已缓存部分仍可播放"
            } else {
                ""
            };
            format!("{failed} 段弹幕缓存失败：{last_error}{retained}")
        }),
    })
}

async fn cache_download_subtitles(
    site: &BilibiliSite,
    request: &VideoPlayRequest,
    dir: &Path,
    cancel: &watch::Receiver<bool>,
) -> Option<CachedSubtitleState> {
    let mut state = CachedSubtitleState::default();
    let cached = read_cached_subtitles_from_dir(dir);
    let meta = match await_with_cancel(site.video_player_meta(request), cancel).await? {
        Ok(meta) => meta,
        Err(error) => {
            state.subtitles = cached
                .subtitles
                .into_iter()
                .filter(|subtitle| cached_subtitle_file_is_valid(dir, subtitle))
                .collect();
            let retained = if state.subtitles.is_empty() {
                ""
            } else {
                "；已沿用上次缓存"
            };
            state.subtitle_error = Some(format!("字幕信息获取失败：{}{retained}", error.message));
            return Some(state);
        }
    };
    if meta.subtitles.is_empty() {
        prune_subtitle_files(dir, &HashSet::new()).await;
        return Some(state);
    }

    let mut failures = Vec::new();
    let mut fallbacks = Vec::new();
    let mut assigned = HashSet::new();
    let mut keep = HashSet::new();
    for subtitle in &meta.subtitles {
        let file_name = allocate_subtitle_file_name(&cached.subtitles, &assigned, &subtitle.lan);
        assigned.insert(file_name.clone());
        let id = subtitle_id_from_file_name(&file_name);
        match cache_one_subtitle(site, subtitle, &dir.join(&file_name), cancel).await {
            None => return None,
            Some(Ok(())) => {
                keep.insert(file_name.clone());
                state.subtitles.push(CachedSubtitle {
                    id,
                    lan: subtitle.lan.clone(),
                    lan_doc: subtitle.lan_doc.clone(),
                    file_name,
                });
            }
            Some(Err(error)) => {
                if let Some(previous) =
                    reusable_cached_subtitle(dir, &cached.subtitles, &file_name, &subtitle.lan)
                {
                    keep.insert(file_name.clone());
                    state.subtitles.push(CachedSubtitle {
                        id,
                        lan: subtitle.lan.clone(),
                        lan_doc: subtitle.lan_doc.clone(),
                        file_name,
                    });
                    fallbacks.push(format!("{}（已沿用上次缓存）", previous.lan_doc));
                } else {
                    failures.push(format!("{}：{error}", subtitle.lan_doc));
                }
            }
        }
    }
    if *cancel.borrow() {
        return None;
    }
    prune_subtitle_files(dir, &keep).await;
    state.subtitle_error = subtitle_cache_warning(&failures, &fallbacks);
    Some(state)
}

async fn cache_one_subtitle(
    site: &BilibiliSite,
    subtitle: &VideoSubtitle,
    path: &Path,
    cancel: &watch::Receiver<bool>,
) -> Option<Result<(), String>> {
    let result = await_with_cancel(site.fetch_subtitle(&subtitle.url), cancel).await?;
    let raw = match result {
        Ok(raw) => raw,
        Err(error) => return Some(Err(error.message)),
    };
    let vtt = match subtitle_json_to_vtt(&raw) {
        Ok(vtt) => vtt,
        Err(error) => return Some(Err(error)),
    };
    Some(write_subtitle_vtt(path, &vtt).await)
}

async fn await_with_cancel<T>(
    future: impl Future<Output = T>,
    cancel: &watch::Receiver<bool>,
) -> Option<T> {
    if *cancel.borrow() {
        return None;
    }
    let mut cancellation = cancel.clone();
    tokio::select! {
        biased;
        _ = cancellation.changed() => None,
        output = future => Some(output),
    }
}

async fn write_subtitle_vtt(path: &Path, vtt: &str) -> Result<(), String> {
    if !vtt.starts_with("WEBVTT") {
        return Err("字幕内容不是有效的 WebVTT".to_string());
    }
    let path = path.to_path_buf();
    let bytes = vtt.as_bytes().to_vec();
    tokio::task::spawn_blocking(move || {
        crate::app_paths::write_recoverable_file(&path, &bytes, |bytes| {
            bytes.starts_with(b"WEBVTT")
        })
    })
    .await
    .map_err(|error| format!("写入 VTT 后台任务失败：{error}"))?
    .map_err(|error| format!("写入 VTT 失败：{error}"))
}

fn reusable_cached_subtitle<'a>(
    dir: &Path,
    cached: &'a [CachedSubtitle],
    file_name: &str,
    lan: &str,
) -> Option<&'a CachedSubtitle> {
    cached.iter().find(|subtitle| {
        subtitle.file_name == file_name
            && subtitle.lan == lan
            && cached_subtitle_file_is_valid(dir, subtitle)
    })
}

fn cached_subtitle_file_is_valid(dir: &Path, subtitle: &CachedSubtitle) -> bool {
    if !safe_file_name(&subtitle.file_name) || !is_subtitle_file(Path::new(&subtitle.file_name)) {
        return false;
    }
    let path = dir.join(&subtitle.file_name);
    let Ok(metadata) = std::fs::symlink_metadata(&path) else {
        return false;
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return false;
    }
    let Ok(mut file) = std::fs::File::open(path) else {
        return false;
    };
    let mut header = [0_u8; 6];
    file.read_exact(&mut header).is_ok() && &header == b"WEBVTT"
}

fn subtitle_cache_warning(failures: &[String], fallbacks: &[String]) -> Option<String> {
    match (failures.first(), fallbacks.first()) {
        (None, None) => None,
        (Some(first), None) => Some(if failures.len() == 1 {
            format!("字幕缓存失败，{first}")
        } else {
            format!("字幕缓存不完整，{first}（共 {} 条失败）", failures.len())
        }),
        (None, Some(first)) => Some(if fallbacks.len() == 1 {
            format!("字幕刷新失败，{first}")
        } else {
            format!("部分字幕刷新失败，{first}（共 {} 条）", fallbacks.len())
        }),
        (Some(first), Some(_)) => Some(format!(
            "字幕缓存不完整，{first}（共 {} 条失败；{} 条沿用上次缓存）",
            failures.len(),
            fallbacks.len()
        )),
    }
}

async fn prune_subtitle_files(dir: &Path, keep: &HashSet<String>) {
    let Ok(mut entries) = tokio::fs::read_dir(dir).await else {
        return;
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if is_subtitle_file(Path::new(name)) && !keep.contains(name) {
            let _ = tokio::fs::remove_file(entry.path()).await;
        }
    }
}

fn subtitle_file_name(index: usize) -> String {
    format!("{SUBTITLE_FILE_PREFIX}{index}{SUBTITLE_FILE_EXTENSION}")
}

fn allocate_subtitle_file_name(
    cached: &[CachedSubtitle],
    assigned: &HashSet<String>,
    lan: &str,
) -> String {
    if let Some(file_name) = cached.iter().find_map(|subtitle| {
        (subtitle.lan == lan
            && !assigned.contains(&subtitle.file_name)
            && safe_file_name(&subtitle.file_name)
            && is_subtitle_file(Path::new(&subtitle.file_name)))
        .then(|| subtitle.file_name.clone())
    }) {
        return file_name;
    }

    (0..)
        .map(subtitle_file_name)
        .find(|file_name| {
            !assigned.contains(file_name)
                && !cached
                    .iter()
                    .any(|subtitle| subtitle.file_name == *file_name)
        })
        .expect("subtitle file name space exhausted")
}

fn subtitle_id_from_file_name(file_name: &str) -> String {
    Path::new(file_name)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or(file_name)
        .to_string()
}

fn subtitle_json_to_vtt(raw: &str) -> Result<String, String> {
    let root: serde_json::Value =
        serde_json::from_str(raw).map_err(|error| format!("字幕 JSON 无效：{error}"))?;
    let body = root
        .get("body")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| "字幕 JSON 缺少 body".to_string())?;
    let mut cues = Vec::new();
    for line in body {
        let (Some(from), Some(to), Some(content)) = (
            line.get("from").and_then(serde_json::Value::as_f64),
            line.get("to").and_then(serde_json::Value::as_f64),
            line.get("content").and_then(serde_json::Value::as_str),
        ) else {
            continue;
        };
        if !from.is_finite() || !to.is_finite() || from < 0.0 || to <= from {
            continue;
        }
        let from_ms = vtt_millis(from);
        let to_ms = vtt_millis(to);
        if to_ms <= from_ms {
            continue;
        }
        let content = content
            .replace("\r\n", "\n")
            .replace('\r', "\n")
            .replace('\0', "");
        let content = content
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .collect::<Vec<_>>()
            .join("\n");
        if content.is_empty() {
            continue;
        }
        cues.push(format!(
            "{} --> {}\n{content}",
            vtt_timestamp(from_ms),
            vtt_timestamp(to_ms)
        ));
    }
    if cues.is_empty() {
        return Err("字幕文件没有有效内容".to_string());
    }
    Ok(format!("WEBVTT\n\n{}\n", cues.join("\n\n")))
}

fn vtt_millis(seconds: f64) -> u64 {
    (seconds.max(0.0) * 1_000.0).round() as u64
}

fn vtt_timestamp(total_millis: u64) -> String {
    let hours = total_millis / 3_600_000;
    let minutes = total_millis / 60_000 % 60;
    let seconds = total_millis / 1_000 % 60;
    let millis = total_millis % 1_000;
    format!("{hours:02}:{minutes:02}:{seconds:02}.{millis:03}")
}

fn partial_bytes(manager: &VideoDownloadManager, item: &VideoDownloadItem) -> (u64, u64) {
    let dir = manager.root.join(&item.id);
    let downloaded =
        partial_size(&dir.join(VIDEO_PART)).saturating_add(partial_size(&dir.join(AUDIO_PART)));
    (downloaded, item.total_bytes)
}

fn track_total(track: &VideoTrack) -> u64 {
    track
        .sidx
        .segments
        .last()
        .map(|segment| segment.end_byte.saturating_add(1))
        .unwrap_or_default()
}

/// 单条轨下载所需的全部上下文。参数超过一组时打包，调用点也不必逐项对齐。
struct TrackDownload<'a> {
    manager: &'a Arc<VideoDownloadManager>,
    item_id: &'a str,
    request_generation: u64,
    client: &'a reqwest::Client,
    headers: &'a HashMap<String, String>,
    track: &'a VideoTrack,
    part: &'a Path,
    /// 已完成轨的累计字节，用于计算整体进度。
    base_bytes: u64,
    total_bytes: u64,
    cancel: &'a watch::Receiver<bool>,
}

async fn download_track(task: &TrackDownload<'_>) -> Result<u64, TrackError> {
    let mut last_error = None;
    for _ in 0..TRACK_ATTEMPTS {
        match download_track_once(task).await {
            Ok(bytes) => return Ok(bytes),
            Err(TrackError::Paused) => return Err(TrackError::Paused),
            Err(TrackError::Failed(error)) => {
                if *task.cancel.borrow() {
                    return Err(TrackError::Paused);
                }
                last_error = Some(error);
            }
        }
    }
    Err(TrackError::Failed(last_error.unwrap_or_else(|| {
        AppError::new("video_download_failed", "下载失败")
    })))
}

async fn download_track_once(task: &TrackDownload<'_>) -> Result<u64, TrackError> {
    let manager = task.manager;
    let item_id = task.item_id;
    let request_generation = task.request_generation;
    let client = task.client;
    let headers = task.headers;
    let track = task.track;
    let part = task.part;
    let base_bytes = task.base_bytes;
    let total_bytes = task.total_bytes;
    let cancel = task.cancel;
    let total = track_total(track);
    if total == 0 {
        return Err(TrackError::Failed(AppError::new(
            "video_download_empty_track",
            "该轨道没有可下载的分片",
        )));
    }
    let mut current = partial_size(part);
    if current > total {
        tokio::fs::remove_file(part).await.ok();
        current = 0;
    }
    let mut file = if current == 0 {
        let mut file = tokio::fs::File::create(part)
            .await
            .map_err(|error| io_error("创建下载临时文件失败", error))?;
        if !track.init_bytes.is_empty() {
            file.write_all(&track.init_bytes)
                .await
                .map_err(|error| io_error("写入初始化段失败", error))?;
            current = track.init_bytes.len() as u64;
        }
        file
    } else {
        tokio::fs::OpenOptions::new()
            .append(true)
            .open(part)
            .await
            .map_err(|error| io_error("打开下载临时文件失败", error))?
    };
    if current >= total {
        return Ok(current);
    }
    let mut request = client
        .get(&track.base_url)
        .header("range", format!("bytes={current}-{}", total - 1));
    for (key, value) in headers {
        request = request.header(key, value);
    }
    let response = request
        .send()
        .await
        .map_err(|error| TrackError::Failed(network_error("请求媒体分片失败", error)))?;
    let status = response.status().as_u16();
    if status == 416 && current >= total {
        return Ok(current);
    }
    if status != 200 && status != 206 {
        return Err(TrackError::Failed(AppError::new(
            "video_download_http_error",
            format!("媒体服务器返回 HTTP {status}"),
        )));
    }
    if status == 200 && current > 0 {
        // CDN 忽略了 Range：已写入的字节与完整响应重叠，只能从头写。
        drop(file);
        file = tokio::fs::File::create(part)
            .await
            .map_err(|error| io_error("重置下载临时文件失败", error))?;
        current = 0;
    }
    let mut stream = response.bytes_stream();
    let mut last_emit = Instant::now() - PROGRESS_INTERVAL;
    while let Some(chunk) = stream.next().await {
        if *cancel.borrow() {
            let _ = file.flush().await;
            return Err(TrackError::Paused);
        }
        let chunk =
            chunk.map_err(|error| TrackError::Failed(network_error("读取媒体响应失败", error)))?;
        file.write_all(&chunk)
            .await
            .map_err(|error| io_error("写入下载文件失败", error))?;
        current = current.saturating_add(chunk.len() as u64);
        if current > total {
            return Err(TrackError::Failed(AppError::new(
                "video_download_oversized",
                "下载字节超出分片表声明的长度",
            )));
        }
        if last_emit.elapsed() >= PROGRESS_INTERVAL {
            manager.report_progress(
                item_id,
                request_generation,
                base_bytes.saturating_add(current),
                total_bytes,
            );
            last_emit = Instant::now();
        }
    }
    file.flush()
        .await
        .map_err(|error| io_error("刷新下载文件失败", error))?;
    if current != total {
        return Err(TrackError::Failed(
            AppError::new(
                "video_download_incomplete",
                format!("下载不完整：{current}/{total} 字节"),
            )
            .retryable(),
        ));
    }
    manager.report_progress(
        item_id,
        request_generation,
        base_bytes.saturating_add(current),
        total_bytes,
    );
    Ok(current)
}

fn io_error(message: &str, error: std::io::Error) -> TrackError {
    TrackError::Failed(AppError::new(
        "video_download_io_error",
        format!("{message}: {error}"),
    ))
}

fn network_error(message: &str, error: reqwest::Error) -> AppError {
    AppError::new(
        "video_download_network_error",
        format!("{message}: {error}"),
    )
    .retryable()
}

/// 把下载好的两条轨合并为成片。
///
/// 桌面端走进程内 FFmpeg 流复制；Android 没有链接 FFmpeg，交给原生
/// `MediaMuxer`（见 `RliveVideoMuxPlugin`）在同一份字节上重封装。两条路径都
/// 不转码。无声稿件只有视频轨，直接改名即可播放。
async fn merge_download_tracks(
    app: &AppHandle,
    video: &Path,
    audio: Option<&Path>,
    output: &Path,
) -> Result<(), String> {
    let Some(audio) = audio else {
        // 无声稿件没有音轨，视频轨本身就是可播放的 fMP4。
        return std::fs::rename(video, output).map_err(|error| error.to_string());
    };

    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
    {
        let _ = app;
        let (video, audio, output) = (
            video.to_path_buf(),
            audio.to_path_buf(),
            output.to_path_buf(),
        );
        match tokio::task::spawn_blocking(move || merge_tracks(&video, &audio, &output)).await {
            Ok(result) => result,
            Err(error) => Err(format!("合并任务意外终止: {error}")),
        }
    }

    #[cfg(target_os = "android")]
    {
        crate::commands::android_video_mux::mux_video_audio(app, video, audio, output)
            .await
            .map_err(|error| error.message)
    }

    #[cfg(not(any(
        target_os = "windows",
        target_os = "linux",
        target_os = "macos",
        target_os = "android"
    )))]
    {
        let _ = (app, video, audio, output);
        Err("当前平台不支持视频下载合并".to_string())
    }
}

fn replace_output(source: &Path, destination: &Path) -> std::io::Result<()> {
    if let Err(error) = std::fs::rename(source, destination) {
        // Windows 不允许 rename 覆盖既存文件；先删目标再重试。
        if destination.exists() {
            std::fs::remove_file(destination)?;
            return std::fs::rename(source, destination);
        }
        return Err(error);
    }
    Ok(())
}

#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
static FFMPEG_INIT_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
static FFMPEG_READY: AtomicBool = AtomicBool::new(false);

#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
fn initialize_ffmpeg() -> Result<(), String> {
    if FFMPEG_READY.load(Ordering::Acquire) {
        return Ok(());
    }
    let lock = FFMPEG_INIT_LOCK.get_or_init(|| Mutex::new(()));
    let _guard = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if FFMPEG_READY.load(Ordering::Acquire) {
        return Ok(());
    }
    ffmpeg::init().map_err(|error| format!("初始化 FFmpeg 失败: {error}"))?;
    ffmpeg::log::set_level(ffmpeg::log::Level::Error);
    FFMPEG_READY.store(true, Ordering::Release);
    Ok(())
}

/// 把两条完整 fMP4 轨按时间戳交错写入一个 MP4。
///
/// 不做转码：B 站 DASH 的视频与音频编码与 MP4 容器相容，流复制即可保留原始
/// 画质与音质。两条轨各自从 0 开始，输出时间基由 muxer 决定，逐包重算时间戳。
#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
fn merge_tracks(video: &Path, audio: &Path, output: &Path) -> Result<(), String> {
    initialize_ffmpeg()?;
    let _ = std::fs::remove_file(output);
    let mut video_input =
        format::input(video).map_err(|error| format!("打开视频轨失败: {error}"))?;
    let mut audio_input =
        format::input(audio).map_err(|error| format!("打开音频轨失败: {error}"))?;
    let video_index = video_input
        .streams()
        .best(media::Type::Video)
        .map(|stream| stream.index())
        .ok_or_else(|| "视频轨中没有视频流".to_string())?;
    let audio_index = audio_input
        .streams()
        .best(media::Type::Audio)
        .map(|stream| stream.index())
        .ok_or_else(|| "音频轨中没有音频流".to_string())?;
    let video_time_base = video_input
        .stream(video_index)
        .ok_or_else(|| "视频轨索引失效".to_string())?
        .time_base();
    let audio_time_base = audio_input
        .stream(audio_index)
        .ok_or_else(|| "音频轨索引失效".to_string())?
        .time_base();
    let video_parameters = video_input
        .stream(video_index)
        .ok_or_else(|| "视频轨索引失效".to_string())?
        .parameters();
    let audio_parameters = audio_input
        .stream(audio_index)
        .ok_or_else(|| "音频轨索引失效".to_string())?
        .parameters();

    let mut output_context =
        format::output_as(output, "mp4").map_err(|error| format!("创建输出文件失败: {error}"))?;
    for parameters in [video_parameters, audio_parameters] {
        let mut stream = output_context
            .add_stream(ffmpeg::encoder::find(ffmpeg::codec::Id::None))
            .map_err(|error| format!("创建输出轨道失败: {error}"))?;
        stream.set_parameters(parameters);
        unsafe {
            (*stream.parameters().as_mut_ptr()).codec_tag = 0;
        }
    }
    output_context
        .write_header()
        .map_err(|error| format!("写入 MP4 容器头失败: {error}"))?;
    // 输出时间基由 muxer 在写头时定下来，写头之前读到的是未初始化值
    // （0/1 会让每个包的时间戳都非法，表现为 `Invalid argument`）。
    let output_time_bases: Vec<Rational> = (0..2)
        .filter_map(|index| {
            output_context
                .stream(index)
                .map(|stream| stream.time_base())
        })
        .collect();

    let mut video_packets = video_input.packets().peekable();
    let mut audio_packets = audio_input.packets().peekable();
    loop {
        let take_video = match (video_packets.peek(), audio_packets.peek()) {
            (Some((_, video)), Some((_, audio))) => {
                packet_time(video, video_time_base) <= packet_time(audio, audio_time_base)
            }
            (Some(_), None) => true,
            (None, Some(_)) => false,
            (None, None) => break,
        };
        let (packet, input_time_base, output_index) = if take_video {
            let Some((_, packet)) = video_packets.next() else {
                continue;
            };
            (packet, video_time_base, 0usize)
        } else {
            let Some((_, packet)) = audio_packets.next() else {
                continue;
            };
            (packet, audio_time_base, 1usize)
        };
        let output_time_base = output_time_bases
            .get(output_index)
            .copied()
            .ok_or_else(|| "输出轨道索引失效".to_string())?;
        let mut packet = packet;
        packet.set_stream(output_index);
        packet.rescale_ts(input_time_base, output_time_base);
        packet.set_position(-1);
        packet
            .write_interleaved(&mut output_context)
            .map_err(|error| format!("写入媒体包失败: {error}"))?;
    }
    output_context
        .write_trailer()
        .map_err(|error| format!("写入 MP4 容器尾失败: {error}"))?;
    Ok(())
}

#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
fn packet_time(packet: &Packet, time_base: Rational) -> i64 {
    packet
        .dts()
        .or_else(|| packet.pts())
        .map(|timestamp| timestamp.rescale(time_base, Rational(1, 1_000_000)))
        .unwrap_or(i64::MAX)
}

fn unix_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or_default()
}

fn next_request_generation(current: u64) -> u64 {
    current.wrapping_add(1).max(1)
}

fn normalize_id(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn item_id(bvid: Option<&str>, ep_id: Option<&str>, cid: i64) -> AppResult<String> {
    let identity = match (ep_id, bvid) {
        (Some(ep_id), _) if safe_id(ep_id) => format!("ep-{ep_id}"),
        (_, Some(bvid)) if safe_id(bvid) => bvid.to_string(),
        _ => {
            return Err(AppError::new(
                "video_download_invalid_request",
                "下载标识无效",
            ));
        }
    };
    Ok(format!("{identity}-{cid}"))
}

fn safe_id(value: &str) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
}

/// 成片文件名：去掉跨平台非法字符与控制字符，保留中文标题。
fn safe_file_stem(title: &str, fallback_id: &str) -> String {
    let mut stem = String::with_capacity(title.len());
    for ch in title.chars() {
        if ch.is_control() || matches!(ch, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
            stem.push('_');
        } else {
            stem.push(ch);
        }
    }
    let stem = stem.trim().trim_matches('.').trim();
    let mut stem: String = stem.chars().take(MAX_TITLE_CHARS).collect();
    stem = stem.trim_end_matches([' ', '.']).to_string();
    if stem.is_empty() {
        stem = fallback_id.to_string();
    }
    // Windows 的保留名按第一个点前的基名判定，`CON.txt` 同样非法。
    if windows_reserved_device_name(&stem) {
        stem.insert(0, '_');
    }
    truncate_utf8_bytes(&stem, MAX_FILE_STEM_BYTES)
        .trim_end_matches([' ', '.'])
        .to_string()
}

fn safe_video_file_name(title: &str, fallback_id: &str) -> String {
    format!(
        "{}{VIDEO_FILE_EXTENSION}",
        safe_file_stem(title, fallback_id)
    )
}

fn windows_reserved_device_name(stem: &str) -> bool {
    let base = stem.split('.').next().unwrap_or(stem).trim_end();
    matches!(
        base.to_ascii_uppercase().as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    )
}

fn truncate_utf8_bytes(value: &str, max_bytes: usize) -> &str {
    if value.len() <= max_bytes {
        return value;
    }
    let mut end = max_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    &value[..end]
}

fn safe_file_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_FILE_NAME_BYTES
        && !value.contains('/')
        && !value.contains('\\')
        && !value.chars().any(char::is_control)
}

fn remove_partial_tracks(dir: &Path) -> std::io::Result<()> {
    for path in [
        dir.join(VIDEO_PART),
        dir.join(AUDIO_PART),
        dir.join(OUTPUT_PART),
    ] {
        match std::fs::remove_file(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

async fn run_playback_server(
    listener: TcpListener,
    root: PathBuf,
    grants: Arc<Mutex<HashMap<String, PlaybackGrant>>>,
    token: String,
    mut shutdown: watch::Receiver<bool>,
) {
    loop {
        tokio::select! {
            changed = shutdown.changed() => {
                if changed.is_ok() && *shutdown.borrow() {
                    break;
                }
            }
            accepted = listener.accept() => match accepted {
                Ok((mut socket, _)) => {
                    let root = root.clone();
                    let grants = grants.clone();
                    let token = token.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = handle_playback_client(&mut socket, &root, &grants, &token).await;
                    });
                }
                Err(_) => break,
            },
        }
    }
}

async fn handle_playback_client(
    socket: &mut TcpStream,
    root: &Path,
    grants: &Arc<Mutex<HashMap<String, PlaybackGrant>>>,
    token: &str,
) -> Result<(), String> {
    let head = local_http::read_request_head(socket, local_http::MAX_REQUEST_HEAD_BYTES)
        .await
        .map_err(|error| error.to_string())?;
    let Some(head) = head.filter(|head| !head.is_empty()) else {
        return Ok(());
    };
    let head = String::from_utf8_lossy(&head);
    let (method, target) = local_http::request_line(&head);
    if local_http::answer_method_preflight(socket, method)
        .await
        .map_err(|error| error.to_string())?
    {
        return Ok(());
    }
    let path = target.split_once('?').map_or(target, |(path, _)| path);
    let mut components = path.trim_start_matches('/').split('/');
    if components.next() != Some(token) {
        local_http::write_simple_response(socket, 404, "Not Found", "").await?;
        return Ok(());
    }
    let Some(grant) = components.next() else {
        local_http::write_simple_response(socket, 404, "Not Found", "").await?;
        return Ok(());
    };
    if components.next().is_some() {
        local_http::write_simple_response(socket, 404, "Not Found", "").await?;
        return Ok(());
    }
    let Some(grant) = grants
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(grant)
        .cloned()
    else {
        local_http::write_simple_response(socket, 404, "Not Found", "").await?;
        return Ok(());
    };
    let Ok(canonical_file) =
        validate_download_file(root, &grant.item_id, &grant.file, is_served_file)
    else {
        local_http::write_simple_response(socket, 404, "Not Found", "").await?;
        return Ok(());
    };
    local_http::serve_file(
        socket,
        method == "HEAD",
        &canonical_file,
        request_header(&head, "range"),
    )
    .await
}

fn validate_playback_file(root: &Path, item_id: &str, file: &Path) -> AppResult<PathBuf> {
    validate_download_file(root, item_id, file, is_mp4_file)
}

fn validate_download_file(
    root: &Path,
    item_id: &str,
    file: &Path,
    allowed: impl Fn(&Path) -> bool,
) -> AppResult<PathBuf> {
    if !safe_id(item_id) {
        return Err(AppError::new(
            "video_download_missing",
            "下载文件已被移动或删除",
        ));
    }
    let task_dir = root.join(item_id);
    let task_metadata = std::fs::symlink_metadata(&task_dir)
        .map_err(|_| AppError::new("video_download_missing", "下载文件已被移动或删除"))?;
    if task_metadata.file_type().is_symlink() || !task_metadata.is_dir() {
        return Err(AppError::new(
            "video_download_missing",
            "下载文件已被移动或删除",
        ));
    }
    let canonical_root = std::fs::canonicalize(root)
        .map_err(|_| AppError::new("video_download_missing", "下载文件已被移动或删除"))?;
    let canonical_dir = std::fs::canonicalize(&task_dir)
        .map_err(|_| AppError::new("video_download_missing", "下载文件已被移动或删除"))?;
    if canonical_dir.parent() != Some(canonical_root.as_path()) {
        return Err(AppError::new(
            "video_download_missing",
            "下载文件已被移动或删除",
        ));
    }
    let metadata = std::fs::symlink_metadata(file)
        .map_err(|_| AppError::new("video_download_missing", "下载文件已被移动或删除"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || !allowed(file) {
        return Err(AppError::new(
            "video_download_missing",
            "下载文件已被移动或删除",
        ));
    }
    let canonical_file = std::fs::canonicalize(file)
        .map_err(|_| AppError::new("video_download_missing", "下载文件已被移动或删除"))?;
    if canonical_file.parent() != Some(canonical_dir.as_path()) {
        return Err(AppError::new(
            "video_download_missing",
            "下载文件已被移动或删除",
        ));
    }
    Ok(canonical_file)
}

fn is_mp4_file(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("mp4"))
}

fn is_served_file(path: &Path) -> bool {
    is_mp4_file(path) || is_subtitle_file(path) || is_danmaku_file(path)
}

fn is_danmaku_file(path: &Path) -> bool {
    path.file_name().and_then(|name| name.to_str()) == Some(DANMAKU_FILE)
}

fn is_subtitle_file(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    let Some(index) = name
        .strip_prefix(SUBTITLE_FILE_PREFIX)
        .and_then(|name| name.strip_suffix(SUBTITLE_FILE_EXTENSION))
    else {
        return false;
    };
    !index.is_empty() && index.bytes().all(|byte| byte.is_ascii_digit())
}

fn finite_non_negative(value: f64) -> f64 {
    if value.is_finite() && value >= 0.0 {
        value
    } else {
        0.0
    }
}

fn not_found() -> AppError {
    AppError::new("video_download_not_found", "下载任务不存在")
}

fn deleting_error() -> AppError {
    AppError::new("video_download_busy", "正在删除下载任务，请稍候")
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;

    fn test_item(status: VideoDownloadStatus, request_generation: u64) -> VideoDownloadItem {
        VideoDownloadItem {
            id: "BV1test-42".to_string(),
            bvid: Some("BV1test".to_string()),
            cid: 42,
            ep_id: None,
            title: "测试视频".to_string(),
            cover: String::new(),
            author: String::new(),
            duration: 10.0,
            qn: 64,
            quality_label: "720P".to_string(),
            status,
            downloaded_bytes: 100,
            total_bytes: 200,
            created_at: 1,
            completed_at: None,
            file_path: "/tmp/测试视频.mp4".to_string(),
            error: None,
            request_generation,
            discard_partials: false,
            watch_progress: 0.0,
            watch_duration: 0.0,
        }
    }

    fn completed_outcome(file_path: &str) -> DownloadOutcome {
        DownloadOutcome {
            status: VideoDownloadStatus::Completed,
            downloaded_bytes: 200,
            total_bytes: 200,
            qn: Some(80),
            quality_label: Some("1080P".to_string()),
            duration: Some(10.0),
            file_path: Some(file_path.to_string()),
            error: None,
        }
    }

    fn temp_root(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        std::env::temp_dir().join(format!(
            "rlive-video-download-{label}-{}-{nonce}",
            Uuid::new_v4().simple()
        ))
    }

    fn download_input(qn: i64) -> VideoDownloadInput {
        VideoDownloadInput {
            bvid: Some("BV1test".to_string()),
            cid: 42,
            ep_id: None,
            title: "测试视频".to_string(),
            cover: None,
            author: None,
            duration: Some(10.0),
            qn: Some(qn),
        }
    }

    fn cached_subtitle(lan: &str, file_name: &str) -> CachedSubtitle {
        CachedSubtitle {
            id: subtitle_id_from_file_name(file_name),
            lan: lan.to_string(),
            lan_doc: lan.to_string(),
            file_name: file_name.to_string(),
        }
    }

    fn persisted_item(root: &Path, id: &str) -> VideoDownloadItem {
        load_items(root)
            .into_iter()
            .find(|item| item.id == id)
            .expect("命令返回前应已写入 entry.json")
    }

    fn complete_item(
        manager: &VideoDownloadManager,
        id: &str,
        contents: &[u8],
    ) -> VideoDownloadItem {
        let mut inner = manager
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let item = inner
            .items
            .iter_mut()
            .find(|item| item.id == id)
            .expect("测试条目应存在");
        std::fs::write(&item.file_path, contents).unwrap();
        item.status = VideoDownloadStatus::Completed;
        item.downloaded_bytes = contents.len() as u64;
        item.total_bytes = contents.len() as u64;
        item.completed_at = Some(2);
        let updated = item.clone();
        persist_item(manager, &updated).unwrap();
        updated
    }

    async fn http_request(
        authority: &str,
        method: &str,
        path: &str,
        headers: &str,
    ) -> (u16, String, Vec<u8>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let mut socket = TcpStream::connect(authority).await.unwrap();
        let request = format!(
            "{method} {path} HTTP/1.1\r\nHost: {authority}\r\n{headers}Connection: close\r\n\r\n"
        );
        socket.write_all(request.as_bytes()).await.unwrap();
        let mut response = Vec::new();
        socket.read_to_end(&mut response).await.unwrap();
        let split = response
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .expect("响应应包含请求头结束标记");
        let head = String::from_utf8(response[..split].to_vec()).unwrap();
        let status = head
            .lines()
            .next()
            .and_then(|line| line.split_whitespace().nth(1))
            .and_then(|status| status.parse().ok())
            .unwrap();
        (status, head, response[split + 4..].to_vec())
    }

    #[test]
    fn ids_are_stable_and_safe() {
        assert_eq!(
            item_id(Some("BV1xx411c7mD"), None, 42).unwrap(),
            "BV1xx411c7mD-42"
        );
        assert_eq!(item_id(None, Some("826497"), 7).unwrap(), "ep-826497-7");
        assert!(item_id(Some("../../etc"), None, 1).is_err());
        assert!(safe_id("BV1xx411c7mD-42"));
        assert!(!safe_id("a/b"));
        assert!(!safe_id(""));
    }

    #[test]
    fn file_names_strip_cross_platform_specials() {
        assert_eq!(
            safe_file_stem("标题: 第一集/结局?", "id"),
            "标题_ 第一集_结局_"
        );
        assert_eq!(safe_file_stem("   ", "fallback"), "fallback");
        assert_eq!(safe_file_stem("....", "fallback"), "fallback");
        assert_eq!(safe_file_stem("CON", "fallback"), "_CON");
        assert_eq!(safe_file_stem("CON.txt", "fallback"), "_CON.txt");
        assert_eq!(safe_file_stem("com1.final", "fallback"), "_com1.final");
        assert_eq!(safe_video_file_name("CON.txt", "fallback"), "_CON.txt.mp4");
        let long = "长".repeat(200);
        assert_eq!(safe_file_stem(&long, "fallback").chars().count(), 80);
        let emoji = "😀".repeat(64);
        let file_name = safe_video_file_name(&emoji, "fallback");
        assert!(file_name.len() <= MAX_FILE_NAME_BYTES);
        assert!(file_name.ends_with(VIDEO_FILE_EXTENSION));
        assert!(safe_file_name("正常 标题.mp4"));
        assert!(!safe_file_name("../escape.mp4"));
        assert!(!safe_file_name("a\\b.mp4"));
    }

    #[test]
    fn stale_worker_cannot_overwrite_newer_queued_request() {
        let stale = test_item(VideoDownloadStatus::Downloading, 1);
        let mut current = test_item(VideoDownloadStatus::Queued, 2);
        current.qn = 64;
        current.file_path = "new.mp4".to_string();
        let mut inner = InnerState {
            items: vec![current.clone()],
            worker_running: true,
            active_id: Some(current.id.clone()),
            cancel: None,
            active_done: None,
            deleting: HashSet::new(),
        };

        let finished =
            finish_worker_state(&mut inner, &stale, completed_outcome("old.mp4")).unwrap();

        assert_eq!(finished.status, VideoDownloadStatus::Queued);
        assert_eq!(finished.request_generation, 2);
        assert_eq!(finished.qn, 64);
        assert_eq!(finished.file_path, "new.mp4");
        assert!(!inner.worker_running);
        assert!(inner.active_id.is_none());
    }

    #[test]
    fn current_worker_still_applies_completion() {
        let current = test_item(VideoDownloadStatus::Downloading, 7);
        let mut inner = InnerState {
            items: vec![current.clone()],
            worker_running: true,
            active_id: Some(current.id.clone()),
            cancel: None,
            active_done: None,
            deleting: HashSet::new(),
        };

        let finished =
            finish_worker_state(&mut inner, &current, completed_outcome("new.mp4")).unwrap();

        assert_eq!(finished.status, VideoDownloadStatus::Completed);
        assert_eq!(finished.qn, 80);
        assert_eq!(finished.file_path, "new.mp4");
        assert_eq!(finished.error, None);
    }

    #[test]
    fn stale_worker_progress_and_metadata_updates_are_ignored() {
        let root = temp_root("generation");
        let manager = Arc::new(VideoDownloadManager::new(root.clone()).unwrap());
        let item = manager.start(download_input(80)).unwrap();
        {
            let mut inner = manager
                .inner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            inner.items[0].request_generation = 2;
            inner.items[0].status = VideoDownloadStatus::Queued;
            inner.items[0].downloaded_bytes = 0;
            inner.items[0].total_bytes = 0;
        }

        let updated = manager.update_item_if_current(&item.id, 1, |stored| stored.qn = 16);
        assert!(updated.is_none());
        manager.report_progress(&item.id, 1, 99, 100);

        let unchanged = manager
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .items[0]
            .clone();
        assert_eq!(unchanged.qn, 80);
        assert_eq!(unchanged.downloaded_bytes, 0);
        assert_eq!(unchanged.total_bytes, 0);
        let persisted = persisted_item(&root, &item.id);
        assert_eq!(persisted.status, VideoDownloadStatus::Queued);
        assert_eq!(persisted.qn, 80);

        drop(manager);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn pause_then_quality_change_defers_partial_cleanup_and_blocks_delete_races() {
        let root = temp_root("state");
        let manager = Arc::new(VideoDownloadManager::new(root.clone()).unwrap());
        let item = manager.start(download_input(80)).unwrap();
        assert_eq!(item.request_generation, 1);

        {
            let mut inner = manager
                .inner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            inner.worker_running = true;
            inner.active_id = Some(item.id.clone());
            inner.items[0].status = VideoDownloadStatus::Downloading;
        }
        let part = root.join(&item.id).join(VIDEO_PART);
        std::fs::write(&part, b"old profile").unwrap();

        let paused = manager.pause(&item.id).unwrap();
        assert_eq!(paused.status, VideoDownloadStatus::Paused);
        assert_eq!(paused.request_generation, 2);
        let persisted_paused = persisted_item(&root, &item.id);
        assert_eq!(persisted_paused.status, VideoDownloadStatus::Paused);
        assert!(!persisted_paused.discard_partials);
        let resumed = manager.resume(&item.id).unwrap();
        assert_eq!(resumed.status, VideoDownloadStatus::Queued);
        assert_eq!(
            persisted_item(&root, &item.id).status,
            VideoDownloadStatus::Queued
        );
        let paused_again = manager.pause(&item.id).unwrap();
        assert_eq!(paused_again.status, VideoDownloadStatus::Paused);
        assert_eq!(paused_again.request_generation, 4);
        let queued = manager.start(download_input(64)).unwrap();
        assert_eq!(queued.status, VideoDownloadStatus::Queued);
        assert_eq!(queued.request_generation, 5);
        let persisted_queued = persisted_item(&root, &item.id);
        assert_eq!(persisted_queued.status, VideoDownloadStatus::Queued);
        assert_eq!(persisted_queued.qn, 64);
        assert!(persisted_queued.discard_partials);
        assert!(part.is_file(), "旧 worker 仍持有文件时不得立即删除分片");
        assert!(
            manager
                .inner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .items[0]
                .discard_partials
        );

        manager
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .deleting
            .insert(item.id.clone());
        let error = manager.start(download_input(80)).unwrap_err();
        assert_eq!(error.code, "video_download_busy");
        let error = manager.resume(&item.id).unwrap_err();
        assert_eq!(error.code, "video_download_busy");

        drop(manager);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn transient_request_fields_stay_out_of_persisted_shape() {
        let mut item = test_item(VideoDownloadStatus::Queued, 9);
        item.discard_partials = true;
        let value = serde_json::to_value(&item).unwrap();
        assert!(value.get("request_generation").is_none());
        assert!(value.get("discard_partials").is_none());
        assert!(value.get("watch_progress").is_none());
        assert!(value.get("watch_duration").is_none());
        let decoded: VideoDownloadItem = serde_json::from_value(value).unwrap();
        assert_eq!(decoded.request_generation, 0);
        assert!(!decoded.discard_partials);
        assert_eq!(decoded.watch_progress, 0.0);
        assert_eq!(decoded.watch_duration, 0.0);
    }

    #[test]
    fn watch_progress_is_clamped_and_survives_restart() {
        let root = temp_root("watch-progress");
        let manager = Arc::new(VideoDownloadManager::new(root.clone()).unwrap());
        let item = manager.start(download_input(80)).unwrap();
        complete_item(&manager, &item.id, b"completed mp4");

        manager
            .report_watch_progress(&item.id, 120.0, 100.0)
            .unwrap();
        let updated = manager.get(&item.id).unwrap();
        assert_eq!(updated.watch_progress, 100.0);
        assert_eq!(updated.watch_duration, 100.0);
        assert_eq!(updated.duration, 10.0, "不应覆盖下载条目的媒体时长");
        assert_eq!(
            manager
                .report_watch_progress(&item.id, -1.0, 100.0)
                .unwrap_err()
                .code,
            "video_download_invalid_request"
        );
        manager
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .deleting
            .insert(item.id.clone());
        assert_eq!(
            manager
                .report_watch_progress(&item.id, 50.0, 100.0)
                .unwrap_err()
                .code,
            "video_download_busy"
        );

        drop(manager);
        let reloaded = VideoDownloadManager::new(root.clone()).unwrap();
        let persisted = reloaded.get(&item.id).unwrap();
        assert_eq!(persisted.watch_progress, 100.0);
        assert_eq!(persisted.watch_duration, 100.0);

        drop(reloaded);
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn playback_info_rejects_unfinished_and_missing_files() {
        let root = temp_root("playback-info");
        let manager = Arc::new(VideoDownloadManager::new(root.clone()).unwrap());
        let item = manager.start(download_input(80)).unwrap();
        assert_eq!(
            manager.playback_info(&item.id).await.unwrap_err().code,
            "video_download_not_completed"
        );

        complete_item(&manager, &item.id, b"completed mp4");
        let info = manager.playback_info(&item.id).await.unwrap();
        assert!(info.url.starts_with("http://127.0.0.1:"));
        assert_eq!(info.progress, 0.0);
        assert_eq!(info.item.id, item.id);
        let repeated = manager.playback_info(&item.id).await.unwrap();
        assert_eq!(repeated.url, info.url, "并发/重复取信息应复用有效 grant");

        let other_dir = root.join("BV1other-42");
        std::fs::create_dir_all(&other_dir).unwrap();
        let other_file = other_dir.join("other.mp4");
        std::fs::write(&other_file, b"other task").unwrap();
        {
            let mut inner = manager
                .inner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let current = inner
                .items
                .iter_mut()
                .find(|entry| entry.id == item.id)
                .unwrap();
            current.file_path = crate::app_paths::path_to_string(&other_file);
        }
        assert_eq!(
            manager.playback_info(&item.id).await.unwrap_err().code,
            "video_download_missing"
        );

        std::fs::remove_file(&info.item.file_path).unwrap();
        assert_eq!(
            manager.playback_info(&item.id).await.unwrap_err().code,
            "video_download_missing"
        );

        drop(manager);
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn playback_server_enforces_token_grants_and_http_ranges() {
        let root = temp_root("playback-http");
        let manager = Arc::new(VideoDownloadManager::new(root.clone()).unwrap());
        let item = manager.start(download_input(80)).unwrap();
        complete_item(&manager, &item.id, b"0123456789");
        let info = manager.playback_info(&item.id).await.unwrap();
        let without_scheme = info.url.strip_prefix("http://").unwrap();
        let (authority, path) = without_scheme.split_once('/').unwrap();
        let path = format!("/{path}");

        let (status, head, body) = http_request(authority, "HEAD", &path, "").await;
        assert_eq!(status, 200);
        assert!(head.contains("Content-Type: video/mp4"));
        assert!(head.contains("Content-Length: 10"));
        assert!(body.is_empty());

        let (status, head, body) =
            http_request(authority, "GET", &path, "Range: bytes=2-5\r\n").await;
        assert_eq!(status, 206);
        assert!(head.contains("Content-Range: bytes 2-5/10"));
        assert_eq!(body, b"2345");

        let (status, _, _) = http_request(authority, "GET", &path, "Range: bytes=20-\r\n").await;
        assert_eq!(status, 416);

        let granted = path.rsplit('/').next().unwrap();
        let (status, _, _) =
            http_request(authority, "GET", &format!("/wrong-token/{granted}"), "").await;
        assert_eq!(status, 404);
        let (status, _, _) = http_request(authority, "GET", &format!("{path}/extra"), "").await;
        assert_eq!(status, 404);

        drop(manager);
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn playback_server_rejects_symlink_escape_after_registration() {
        use std::os::unix::fs::symlink;

        let root = temp_root("playback-symlink");
        let outside = temp_root("playback-outside");
        std::fs::create_dir_all(&outside).unwrap();
        let outside_file = outside.join("outside.mp4");
        std::fs::write(&outside_file, b"outside").unwrap();

        let manager = Arc::new(VideoDownloadManager::new(root.clone()).unwrap());
        let item = manager.start(download_input(80)).unwrap();
        let completed = complete_item(&manager, &item.id, b"inside");
        let info = manager.playback_info(&item.id).await.unwrap();
        std::fs::remove_file(&completed.file_path).unwrap();
        symlink(&outside_file, &completed.file_path).unwrap();

        let without_scheme = info.url.strip_prefix("http://").unwrap();
        let (authority, path) = without_scheme.split_once('/').unwrap();
        let (status, _, _) = http_request(authority, "GET", &format!("/{path}"), "").await;
        assert_eq!(status, 404);

        drop(manager);
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(outside);
    }

    #[cfg(unix)]
    #[test]
    fn playback_validation_rejects_task_directory_symlink_escape() {
        use std::os::unix::fs::symlink;

        let root = temp_root("playback-dir-symlink");
        let outside = temp_root("playback-dir-outside");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let file = outside.join("outside.mp4");
        std::fs::write(&file, b"outside").unwrap();
        let item_id = "BV1test-42";
        symlink(&outside, root.join(item_id)).unwrap();

        let error = validate_playback_file(&root, item_id, &root.join(item_id).join("outside.mp4"))
            .unwrap_err();
        assert_eq!(error.code, "video_download_missing");

        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(outside);
    }

    #[test]
    fn pending_partial_cleanup_survives_restart() {
        let root = temp_root("discard");
        let mut item = test_item(VideoDownloadStatus::Paused, 3);
        item.discard_partials = true;
        write_entry(&root, &item, "测试视频.mp4").unwrap();

        let loaded = load_items(&root);
        assert_eq!(loaded.len(), 1);
        assert!(loaded[0].discard_partials);

        let value = serde_json::to_value(StoredEntry {
            item: item.clone(),
            file_name: "测试视频.mp4".to_string(),
            discard_partials: true,
            watch_progress: 0.0,
            watch_duration: 0.0,
            subtitles: Vec::new(),
            subtitle_error: None,
            danmaku_cached: false,
            danmaku_error: None,
        })
        .unwrap();
        let mut legacy = value.as_object().unwrap().clone();
        legacy.remove("discard_partials");
        legacy.remove("watch_progress");
        legacy.remove("watch_duration");
        legacy.remove("subtitles");
        legacy.remove("subtitle_error");
        legacy.remove("danmaku_cached");
        legacy.remove("danmaku_error");
        let decoded: StoredEntry =
            serde_json::from_value(serde_json::Value::Object(legacy)).unwrap();
        assert!(!decoded.discard_partials);
        assert_eq!(decoded.watch_progress, 0.0);
        assert_eq!(decoded.watch_duration, 0.0);
        assert!(decoded.subtitles.is_empty());
        assert!(decoded.subtitle_error.is_none());
        assert!(!decoded.danmaku_cached);
        assert!(decoded.danmaku_error.is_none());

        let _ = std::fs::remove_dir_all(root);
    }

    fn empty_danmaku(has_more: bool) -> VideoDanmakuSegment {
        VideoDanmakuSegment {
            has_more,
            items: Vec::new(),
        }
    }

    #[tokio::test]
    async fn danmaku_cache_keeps_empty_segments_and_retries_only_failed_segments() {
        let root = temp_root("danmaku-partial");
        let manager = Arc::new(VideoDownloadManager::new(root.clone()).unwrap());
        let item = manager.start(download_input(80)).unwrap();
        let (_sender, cancel) = watch::channel(false);
        let calls = Mutex::new(Vec::new());
        let state = cache_download_danmaku(&root, &item.id, 1080.0, &cancel, |index| {
            calls.lock().unwrap().push(index);
            async move {
                if index == 2 {
                    Err(AppError::new("test", "请求失败"))
                } else {
                    Ok(empty_danmaku(true))
                }
            }
        })
        .await
        .unwrap();
        assert!(state.cached);
        assert!(state.error.as_deref().unwrap().contains("1 段"));
        assert_eq!(*calls.lock().unwrap(), vec![1, 2, 3]);
        assert_eq!(read_cached_danmaku(&root, &item.id).unwrap().len(), 2);
        calls.lock().unwrap().clear();
        let state = cache_download_danmaku(&root, &item.id, 1080.0, &cancel, |index| {
            calls.lock().unwrap().push(index);
            async { Ok(empty_danmaku(true)) }
        })
        .await
        .unwrap();
        assert!(state.error.is_none());
        assert_eq!(*calls.lock().unwrap(), vec![2]);
        assert_eq!(read_cached_danmaku(&root, &item.id).unwrap().len(), 3);
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn danmaku_cache_stops_at_end_and_cancellation_preserves_committed_segments() {
        let root = temp_root("danmaku-cancel");
        let manager = Arc::new(VideoDownloadManager::new(root.clone()).unwrap());
        let item = manager.start(download_input(80)).unwrap();
        let (sender, cancel) = watch::channel(false);
        let calls = Mutex::new(Vec::new());
        let result = cache_download_danmaku(&root, &item.id, 1080.0, &cancel, |index| {
            let sender = &sender;
            async move {
                if index == 1 {
                    return Ok(empty_danmaku(true));
                }
                sender.send(true).unwrap();
                std::future::pending().await
            }
        })
        .await;
        assert!(result.is_none());
        assert_eq!(read_cached_danmaku(&root, &item.id).unwrap().len(), 1);
        sender.send(false).unwrap();
        let cancel = sender.subscribe();
        let state = cache_download_danmaku(&root, &item.id, 1800.0, &cancel, |index| {
            calls.lock().unwrap().push(index);
            async move { Ok(empty_danmaku(index < 2)) }
        })
        .await
        .unwrap();
        assert!(state.cached);
        assert!(state.error.is_none());
        assert_eq!(calls.lock().unwrap().last(), Some(&2));
        assert_eq!(read_cached_danmaku(&root, &item.id).unwrap().len(), 2);
        calls.lock().unwrap().clear();
        cache_download_danmaku(&root, &item.id, 1800.0, &cancel, |index| {
            calls.lock().unwrap().push(index);
            async { Ok(empty_danmaku(true)) }
        })
        .await
        .unwrap();
        assert!(calls.lock().unwrap().is_empty());
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn danmaku_playback_grants_preserve_metadata_and_are_revoked_on_delete() {
        let root = temp_root("danmaku-playback");
        let manager = Arc::new(VideoDownloadManager::new(root.clone()).unwrap());
        let item = manager.start(download_input(80)).unwrap();
        complete_item(&manager, &item.id, b"mp4");
        let legacy = manager.playback_info(&item.id).await.unwrap();
        assert!(legacy.danmaku_url.is_none());
        assert!(legacy.danmaku_error.is_none());
        write_cached_danmaku(
            &root.join(&item.id),
            &[CachedDanmakuSegment {
                segment_index: 1,
                segment: empty_danmaku(true),
            }],
        )
        .unwrap();
        persist_cached_danmaku(
            &manager,
            &item,
            &CachedDanmakuState {
                cached: true,
                error: Some("部分弹幕未缓存".to_string()),
            },
        )
        .unwrap();
        persist_cached_subtitles(&manager, &item, &CachedSubtitleState::default()).unwrap();
        manager.report_watch_progress(&item.id, 4.0, 10.0).unwrap();
        let info = manager.playback_info(&item.id).await.unwrap();
        assert_eq!(info.danmaku_error.as_deref(), Some("部分弹幕未缓存"));
        let url = info.danmaku_url.unwrap();
        let (authority, path) = url
            .strip_prefix("http://")
            .unwrap()
            .split_once('/')
            .unwrap();
        let (status, head, body) = http_request(authority, "GET", &format!("/{path}"), "").await;
        assert_eq!(status, 200);
        assert!(head.contains("Content-Type: application/json; charset=utf-8"));
        assert_eq!(
            serde_json::from_slice::<Vec<CachedDanmakuSegment>>(&body)
                .unwrap()
                .len(),
            1
        );
        std::fs::write(root.join(&item.id).join(DANMAKU_FILE), b"invalid json").unwrap();
        let damaged = manager.playback_info(&item.id).await.unwrap();
        assert!(damaged.danmaku_url.is_none());
        assert!(damaged.danmaku_error.unwrap().contains("损坏"));
        manager.remove(&item.id).await.unwrap();
        let (status, _, _) = http_request(authority, "GET", &format!("/{path}"), "").await;
        assert_eq!(status, 404);
        assert!(!root.join(&item.id).exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn subtitle_json_is_converted_to_valid_vtt_and_drops_invalid_cues() {
        let raw = serde_json::json!({
            "body": [
                { "from": 0.0, "to": 1.2345, "content": "第一行" },
                { "from": 2.0, "to": 3.0, "content": "第一行\r\n第二行" },
                { "from": 4.0, "to": 4.0, "content": "无效" },
                { "from": 5.0, "to": 6.0, "content": "  " }
            ]
        })
        .to_string();
        let vtt = subtitle_json_to_vtt(&raw).unwrap();
        assert!(vtt.starts_with("WEBVTT\n\n"));
        assert!(vtt.contains("00:00:00.000 --> 00:00:01.235\n第一行"));
        assert!(vtt.contains("00:00:02.000 --> 00:00:03.000\n第一行\n第二行"));
        assert!(!vtt.contains("无效"));
        assert!(subtitle_json_to_vtt("not json").is_err());
        assert!(subtitle_json_to_vtt(r#"{"body":[]}"#).is_err());
    }

    #[test]
    fn subtitle_file_names_are_narrowly_validated() {
        assert!(is_subtitle_file(Path::new("subtitle-0.vtt")));
        assert!(is_subtitle_file(Path::new("subtitle-123.vtt")));
        assert!(!is_subtitle_file(Path::new("subtitle-.vtt")));
        assert!(!is_subtitle_file(Path::new("subtitle-1.json")));
        assert!(!is_subtitle_file(Path::new("subtitle-1.vtt/extra")));
    }

    #[test]
    fn subtitle_file_names_follow_language_when_metadata_order_changes() {
        let cached = vec![
            cached_subtitle("zh-CN", "subtitle-0.vtt"),
            cached_subtitle("en-US", "subtitle-1.vtt"),
        ];
        let mut assigned = HashSet::new();

        let english = allocate_subtitle_file_name(&cached, &assigned, "en-US");
        assigned.insert(english.clone());
        let chinese = allocate_subtitle_file_name(&cached, &assigned, "zh-CN");
        assigned.insert(chinese.clone());
        let japanese = allocate_subtitle_file_name(&cached, &assigned, "ja-JP");

        assert_eq!(english, "subtitle-1.vtt");
        assert_eq!(chinese, "subtitle-0.vtt");
        assert_eq!(japanese, "subtitle-2.vtt");
        assert_eq!(subtitle_id_from_file_name(&english), "subtitle-1");
        assert_eq!(subtitle_id_from_file_name(&chinese), "subtitle-0");
    }

    #[test]
    fn duplicate_cached_languages_use_distinct_subtitle_files() {
        let cached = vec![
            cached_subtitle("zh-CN", "subtitle-0.vtt"),
            cached_subtitle("zh-CN", "subtitle-1.vtt"),
        ];
        let mut assigned = HashSet::new();

        let first = allocate_subtitle_file_name(&cached, &assigned, "zh-CN");
        assigned.insert(first.clone());
        let second = allocate_subtitle_file_name(&cached, &assigned, "zh-CN");
        assigned.insert(second.clone());
        let third = allocate_subtitle_file_name(&cached, &assigned, "zh-CN");

        assert_eq!(first, "subtitle-0.vtt");
        assert_eq!(second, "subtitle-1.vtt");
        assert_eq!(third, "subtitle-2.vtt");
    }

    #[test]
    fn unsafe_cached_subtitle_paths_are_never_reused_or_read() {
        let root = temp_root("subtitle-unsafe");
        let dir = root.join("task");
        std::fs::create_dir_all(&dir).unwrap();
        let outside = root.join("subtitle-0.vtt");
        std::fs::write(&outside, b"WEBVTT\n\n00:00.000 --> 00:01.000\noutside\n").unwrap();

        for file_name in [
            "../subtitle-0.vtt".to_string(),
            outside.to_string_lossy().into_owned(),
            r"..\subtitle-0.vtt".to_string(),
        ] {
            let cached = cached_subtitle("zh-CN", &file_name);
            let assigned = HashSet::new();
            assert_eq!(
                allocate_subtitle_file_name(std::slice::from_ref(&cached), &assigned, "zh-CN"),
                "subtitle-0.vtt",
                "{file_name}"
            );
            assert!(!cached_subtitle_file_is_valid(&dir, &cached), "{file_name}");
        }

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn interrupted_subtitle_refresh_cannot_rebind_old_language_file_name() {
        let cached = vec![cached_subtitle("zh-CN", "subtitle-0.vtt")];
        let mut assigned = HashSet::new();

        // 上游顺序变化后先写英文；worker 此时暂停，旧索引仍只记录中文。
        let english = allocate_subtitle_file_name(&cached, &assigned, "en-US");
        assigned.insert(english.clone());
        assert_eq!(english, "subtitle-1.vtt");

        let chinese = allocate_subtitle_file_name(&cached, &assigned, "zh-CN");
        assert_eq!(chinese, "subtitle-0.vtt");
        assert_eq!(cached[0].lan, "zh-CN");
        assert_eq!(cached[0].file_name, chinese);
        assert_ne!(cached[0].file_name, english);
        assert!(
            cached.iter().all(|subtitle| subtitle.lan != "en-US"),
            "暂停后未持久化的英文轨道不能出现在旧索引中"
        );
    }

    #[test]
    fn subtitle_refresh_can_reuse_a_matching_previous_vtt() {
        let root = temp_root("subtitle-fallback");
        std::fs::create_dir_all(&root).unwrap();
        let cached = CachedSubtitle {
            id: "subtitle-0".to_string(),
            lan: "zh-CN".to_string(),
            lan_doc: "中文".to_string(),
            file_name: "subtitle-0.vtt".to_string(),
        };
        let path = root.join(&cached.file_name);
        std::fs::write(&path, b"WEBVTT\n\n00:00.000 --> 00:01.000\nold\n").unwrap();

        assert!(
            reusable_cached_subtitle(
                &root,
                std::slice::from_ref(&cached),
                "subtitle-0.vtt",
                "zh-CN"
            )
            .is_some()
        );
        assert!(
            reusable_cached_subtitle(
                &root,
                std::slice::from_ref(&cached),
                "subtitle-1.vtt",
                "zh-CN"
            )
            .is_none()
        );
        assert!(
            reusable_cached_subtitle(
                &root,
                std::slice::from_ref(&cached),
                "subtitle-0.vtt",
                "en-US"
            )
            .is_none()
        );

        std::fs::write(&path, b"not a subtitle").unwrap();
        assert!(
            reusable_cached_subtitle(
                &root,
                std::slice::from_ref(&cached),
                "subtitle-0.vtt",
                "zh-CN"
            )
            .is_none()
        );

        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn subtitle_atomic_write_failure_keeps_the_previous_vtt() {
        let root = temp_root("subtitle-atomic");
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("subtitle-0.vtt");
        let previous = b"WEBVTT\n\n00:00.000 --> 00:01.000\nold\n";
        std::fs::write(&path, previous).unwrap();
        // 同目录事务侧文件被目录占用时，发布步骤失败，但已成片 VTT 不应被截断。
        std::fs::create_dir(path.with_extension("vtt.tmp")).unwrap();

        let error = write_subtitle_vtt(&path, "WEBVTT\n\n00:01.000 --> 00:02.000\nnew\n")
            .await
            .unwrap_err();
        assert!(error.contains("写入 VTT"));
        assert_eq!(std::fs::read(&path).unwrap(), previous);

        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn subtitle_request_wait_stops_when_download_is_cancelled() {
        let (cancel, receiver) = watch::channel(false);
        let task = tokio::spawn(async move {
            await_with_cancel(std::future::pending::<()>(), &receiver).await
        });
        cancel.send(true).unwrap();

        let result = tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .expect("取消后字幕请求应立即返回")
            .unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn subtitle_metadata_save_failure_maps_to_failed_download() {
        let root = temp_root("subtitle-metadata-failure");
        let manager = Arc::new(VideoDownloadManager::new(root.clone()).unwrap());
        let mut item = manager.start(download_input(80)).unwrap();
        item.file_path.clear();

        let outcome = persist_cached_subtitles_for_completion(
            &manager,
            &item,
            &CachedSubtitleState::default(),
            7,
            9,
        )
        .unwrap_err();
        let outcome = *outcome;
        assert_eq!(outcome.status, VideoDownloadStatus::Failed);
        assert!(
            outcome
                .error
                .is_some_and(|error| error.starts_with("保存字幕缓存信息失败"))
        );
        assert_ne!(outcome.status, VideoDownloadStatus::Completed);

        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn playback_info_serves_cached_vtt_from_the_media_origin() {
        let root = temp_root("subtitle-playback");
        let manager = Arc::new(VideoDownloadManager::new(root.clone()).unwrap());
        let item = manager.start(download_input(80)).unwrap();
        complete_item(&manager, &item.id, b"completed mp4");
        let subtitle_path = root.join(&item.id).join("subtitle-0.vtt");
        std::fs::write(
            &subtitle_path,
            b"WEBVTT\n\n00:00.000 --> 00:01.000\nHello\n",
        )
        .unwrap();
        persist_cached_subtitles(
            &manager,
            &item,
            &CachedSubtitleState {
                subtitles: vec![CachedSubtitle {
                    id: "subtitle-0".to_string(),
                    lan: "zh-CN".to_string(),
                    lan_doc: "中文".to_string(),
                    file_name: "subtitle-0.vtt".to_string(),
                }],
                subtitle_error: Some("另一条字幕失败".to_string()),
            },
        )
        .unwrap();

        let info = manager.playback_info(&item.id).await.unwrap();
        assert_eq!(info.subtitles.len(), 1);
        assert_eq!(info.subtitles[0].id, "subtitle-0");
        assert_eq!(info.subtitles[0].lan, "zh-CN");
        assert_eq!(info.subtitle_error.as_deref(), Some("另一条字幕失败"));
        let media_origin = info.url.split('/').take(3).collect::<Vec<_>>().join("/");
        assert!(info.subtitles[0].url.starts_with(&media_origin));

        let media_without_scheme = info.url.strip_prefix("http://").unwrap();
        let (media_authority, media_path) = media_without_scheme.split_once('/').unwrap();
        let (status, _, _) =
            http_request(media_authority, "GET", &format!("/{media_path}"), "").await;
        assert_eq!(status, 200);

        let without_scheme = info.subtitles[0].url.strip_prefix("http://").unwrap();
        let (authority, path) = without_scheme.split_once('/').unwrap();
        let (status, head, body) = http_request(authority, "GET", &format!("/{path}"), "").await;
        assert_eq!(status, 200);
        assert!(head.contains("Content-Type: text/vtt; charset=utf-8"));
        assert!(body.starts_with(b"WEBVTT"));

        manager.report_watch_progress(&item.id, 4.0, 10.0).unwrap();
        let refreshed = manager.playback_info(&item.id).await.unwrap();
        assert_eq!(refreshed.subtitles.len(), 1);
        assert_eq!(refreshed.subtitles[0].url, info.subtitles[0].url);

        std::fs::remove_file(subtitle_path).unwrap();
        let missing = manager.playback_info(&item.id).await.unwrap();
        assert!(missing.subtitles.is_empty());
        assert!(
            missing
                .subtitle_error
                .as_deref()
                .is_some_and(|error| error.contains("字幕缓存已丢失"))
        );

        drop(manager);
        let _ = std::fs::remove_dir_all(root);
    }
}
