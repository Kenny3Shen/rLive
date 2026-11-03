//! B 站 VOD 下载：队列、断点续传与音视频合并。
//!
//! 下载内容与录制一样刻意放在 SQLite 之外：每个条目是一个自包含目录
//! （`entry.json` + 两条临时轨 + 成片），应用被杀掉后仍可恢复。
//!
//! 与录制共用 `BilibiliSite::video_play_selection` 解出的完整分片表。区别是
//! 不需要重新抓直播流：DASH 轨就是完整的 fMP4 文件，按字节区间顺序下载后
//! 重封装为 MP4。桌面端用进程内 FFmpeg 流复制，Android 用原生
//! `MediaMuxer`，两条路径都不转码。

use std::collections::HashMap;
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
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::AsyncWriteExt;
use tokio::sync::{Notify, watch};

use crate::commands::video::{resolve_bilibili, video_stream_headers};
use crate::error::{AppError, AppResult};
use crate::models::video::VideoPlayRequest;
use crate::sites::bilibili::video::VideoTrack;
use crate::state::AppState;

pub const VIDEO_DOWNLOAD_CHANGED_EVENT: &str = "video-download-changed";
pub const VIDEO_DOWNLOAD_PROGRESS_EVENT: &str = "video-download-progress";

const ENTRY_FILE: &str = "entry.json";
const VIDEO_PART: &str = "video.m4s.part";
const AUDIO_PART: &str = "audio.m4s.part";
const OUTPUT_PART: &str = "output.mp4.part";
const MAX_TITLE_CHARS: usize = 80;
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

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredEntry {
    item: VideoDownloadItem,
    file_name: String,
}

struct InnerState {
    items: Vec<VideoDownloadItem>,
    worker_running: bool,
    active_id: Option<String>,
    cancel: Option<watch::Sender<bool>>,
    /// 当前活动 worker 结束（含取消）时通知；删除活动条目要等它停止写文件。
    active_done: Option<Arc<Notify>>,
}

/// 下载管理器。由 `AppState` 以 `Arc` 持有，后台 worker 需要跨任务存活。
pub struct VideoDownloadManager {
    root: PathBuf,
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
        Ok(Self {
            root,
            app: Mutex::new(None),
            inner: Mutex::new(InnerState {
                items,
                worker_running: false,
                active_id: None,
                cancel: None,
                active_done: None,
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
        let file_name = format!("{}.mp4", safe_file_stem(title, &id));
        let now = unix_seconds();
        let qn = input.qn.unwrap_or(0).max(0);
        let submit = {
            let mut inner = self
                .inner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if let Some(index) = inner.items.iter().position(|item| item.id == id) {
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
                if existing.qn != qn && qn > 0 {
                    let _ = std::fs::remove_file(dir.join(VIDEO_PART));
                    let _ = std::fs::remove_file(dir.join(AUDIO_PART));
                    existing.downloaded_bytes = 0;
                    existing.total_bytes = 0;
                }
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
            }
        };
        self.emit_changed(Some(&submit));
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
                    if inner.active_id.as_deref() == Some(id)
                        && let Some(cancel) = &inner.cancel
                    {
                        let _ = cancel.send(true);
                    }
                    Some(inner.items[index].clone())
                }
                VideoDownloadStatus::Paused
                | VideoDownloadStatus::Completed
                | VideoDownloadStatus::Failed => return Ok(inner.items[index].clone()),
            }
        };
        if let Some(item) = &changed {
            let _ = persist_item(self, item);
            self.emit_changed(Some(item));
        }
        changed.ok_or_else(not_found)
    }

    pub fn resume(self: &Arc<Self>, id: &str) -> AppResult<VideoDownloadItem> {
        let resumed = {
            let mut inner = self
                .inner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let Some(item) = inner.items.iter_mut().find(|item| item.id == id) else {
                return Err(not_found());
            };
            match item.status {
                VideoDownloadStatus::Failed | VideoDownloadStatus::Paused => {
                    item.status = VideoDownloadStatus::Queued;
                    item.error = None;
                    item.clone()
                }
                _ => return Ok(item.clone()),
            }
        };
        persist_item(self, &resumed)?;
        self.emit_changed(Some(&resumed));
        if let Some(app) = self.app_handle() {
            spawn_worker(self.clone(), app);
        }
        Ok(resumed)
    }

    pub async fn remove(&self, id: &str) -> AppResult<()> {
        let done = {
            let mut inner = self
                .inner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let Some(index) = inner.items.iter().position(|item| item.id == id) else {
                return Err(not_found());
            };
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
        if let Err(error) = std::fs::remove_dir_all(&dir)
            && error.kind() != std::io::ErrorKind::NotFound
        {
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

    fn report_progress(&self, id: &str, downloaded_bytes: u64, total_bytes: u64) {
        let status = {
            let mut inner = self
                .inner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let Some(item) = inner.items.iter_mut().find(|item| item.id == id) else {
                return;
            };
            item.downloaded_bytes = downloaded_bytes;
            item.total_bytes = total_bytes;
            item.status
        };
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

    fn update_item(
        &self,
        id: &str,
        apply: impl FnOnce(&mut VideoDownloadItem),
    ) -> Option<VideoDownloadItem> {
        let updated = {
            let mut inner = self
                .inner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let item = inner.items.iter_mut().find(|item| item.id == id)?;
            apply(item);
            item.clone()
        };
        let _ = persist_item(self, &updated);
        self.emit_changed(Some(&updated));
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
    let stored = StoredEntry {
        item: item.clone(),
        file_name: file_name.to_string(),
    };
    let bytes = serde_json::to_vec_pretty(&stored).map_err(|error| {
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
        let Some(index) = inner
            .items
            .iter()
            .position(|item| item.status == VideoDownloadStatus::Queued)
        else {
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
        (item, cancel_rx, done)
    };
    let (item, cancel_rx, done) = queue;
    let _ = persist_item(&manager, &item);
    manager.emit_changed(Some(&item));
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
        inner.worker_running = false;
        inner.active_id = None;
        inner.cancel = None;
        inner.active_done = None;
        if let Some(stored) = inner.items.iter_mut().find(|entry| entry.id == item.id) {
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
    }
    if let Some(updated) = manager
        .inner
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .items
        .iter()
        .find(|entry| entry.id == item.id)
        .cloned()
    {
        let _ = persist_item(&manager, &updated);
        manager.emit_changed(Some(&updated));
    }
    // 删活动条目的一方在等这个信号；必须在启动下一个任务前唤醒，
    // 否则下一次 `spawn_worker` 会换掉 `active_done`。
    done.notify_one();
    // 队列里还有条目就继续；暂停/失败不会阻塞后面的条目。
    spawn_worker(manager, app);
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
    manager.update_item(&item.id, |stored| {
        stored.qn = selection.quality;
        stored.quality_label = selection.quality_label.clone();
        if duration > 0.0 {
            stored.duration = duration;
        }
        stored.total_bytes = total_bytes;
        stored.downloaded_bytes = downloaded_now;
    });
    let client = match crate::http_client::recording_stream_client_for_route(&route) {
        Ok(client) => client,
        Err(error) => return DownloadOutcome::failed(error.message, downloaded_now, total_bytes),
    };
    let headers = video_stream_headers();
    let dir = manager.root.join(&item.id);
    let video_part = dir.join(VIDEO_PART);
    let audio_part = dir.join(AUDIO_PART);

    match download_track(&TrackDownload {
        manager,
        item_id: &item.id,
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

    let file_name = Path::new(&item.file_path)
        .file_name()
        .and_then(|name| name.to_str())
        .map(str::to_string)
        .unwrap_or_else(|| format!("{}.mp4", safe_file_stem(&item.title, &item.id)));
    let final_path = dir.join(&file_name);
    let output_part = dir.join(OUTPUT_PART);
    manager.update_item(&item.id, |stored| {
        stored.status = VideoDownloadStatus::Merging;
    });
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
            manager.report_progress(item_id, base_bytes.saturating_add(current), total_bytes);
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
    manager.report_progress(item_id, base_bytes.saturating_add(current), total_bytes);
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
    // Windows 保留设备名。加下划线前缀即可避开，不影响可读性。
    if matches!(
        stem.to_ascii_uppercase().as_str(),
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
    ) {
        stem.insert(0, '_');
    }
    stem
}

fn safe_file_name(value: &str) -> bool {
    !value.is_empty()
        && !value.contains('/')
        && !value.contains('\\')
        && !value.chars().any(char::is_control)
}

fn not_found() -> AppError {
    AppError::new("video_download_not_found", "下载任务不存在")
}

#[cfg(test)]
mod tests {
    use super::{item_id, safe_file_name, safe_file_stem, safe_id};

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
        let long = "长".repeat(200);
        assert_eq!(safe_file_stem(&long, "fallback").chars().count(), 80);
        assert!(safe_file_name("正常 标题.mp4"));
        assert!(!safe_file_name("../escape.mp4"));
        assert!(!safe_file_name("a\\b.mp4"));
    }
}
