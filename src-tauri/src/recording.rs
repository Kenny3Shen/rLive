//! 桌面端直播录制与本地回放服务。
//!
//! 录制内容刻意存放在 SQLite 数据库之外。一场录制是一个自包含的小型分卷
//! （元数据加媒体），因此应用被杀死后仍可恢复，
//! 用户无需导出数据库即可查看或复制。

#![cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]

use std::collections::{HashMap, HashSet};
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, BufWriter, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, TryLockError};
use std::time::{Duration, Instant, SystemTime};

use chrono::{Local, TimeZone, Utc};
use futures_util::StreamExt;
use percent_encoding::percent_decode_str;
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::http_client;
use crate::models::live::{DanmakuEvent, PlayUrl, PlaybackProtocol};
use crate::stream_proxy::{StreamProxyStartOptions, request_header};

#[path = "recording_ffmpeg.rs"]
mod ffmpeg_backend;

#[path = "recording_ass.rs"]
mod ass;

pub use ass::AssExportOptions;

const RECORDINGS_DIRECTORY: &str = "recordings";
const RECORDING_STORAGE_CONFIG_FILE: &str = "recording-storage-v2.json";
const RECORDING_STORAGE_CONFIG_VERSION: u32 = 2;
const RECORDING_METADATA_VERSION: u32 = 2;
const RECORDING_MANAGER_LOCK_FILE: &str = ".recording-manager.lock";
const GRACEFUL_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(15);
const TASK_ABORT_SETTLE_TIMEOUT: Duration = Duration::from_secs(1);
const MINIMUM_FREE_SPACE_BYTES: u64 = 512 * 1024 * 1024;
const STORAGE_SPACE_CHECK_INTERVAL: Duration = Duration::from_secs(5);
const RECORDING_PROGRESS_EVENT_INTERVAL_MS: u64 = 500;
const RECORDING_CHANGED_EVENT: &str = "recording-changed";
const RECORDING_PROGRESS_EVENT: &str = "recording-progress";
static METADATA_IO_LOCK: Mutex<()> = Mutex::new(());
static ASS_EXPORT_IO_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RecordingStatus {
    Recording,
    Completed,
    Interrupted,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
pub struct RecordingItem {
    pub id: String,
    /// 用于防止意外重复会话的稳定内容标识。
    pub source_key: String,
    pub source_kind: String,
    pub site_id: Option<String>,
    pub room_id: Option<String>,
    pub title: String,
    pub user_name: String,
    pub cover: String,
    pub user_avatar: String,
    pub protocol: PlaybackProtocol,
    pub status: RecordingStatus,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub duration_ms: u64,
    pub size_bytes: u64,
    /// 是否请求了本地可独立开关的弹幕轨道。
    pub include_danmaku: bool,
    /// 该会话是否可以在其播放器页关闭后继续录制。
    pub continue_on_leave: bool,
    /// 到目前为止成功写入伴生文件的弹幕事件数量。
    pub danmaku_count: u64,
    /// 启用时，录制分卷内伴生文件的相对路径。
    pub danmaku_file: Option<String>,
    /// 供原生文件定位操作使用的可播放媒体绝对路径。
    /// 播放 URL 本身刻意与之分开。
    pub file_path: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingStartInput {
    pub source: PlayUrl,
    pub source_key: String,
    pub source_kind: String,
    pub site_id: Option<String>,
    pub room_id: Option<String>,
    pub title: String,
    pub user_name: String,
    pub cover: String,
    pub user_avatar: String,
    /// 把活动的弹幕连接保存为同步的伴生轨道。
    #[serde(default)]
    pub include_danmaku: Option<bool>,
    /// 离开当前播放器页时，保持媒体任务及请求的弹幕伴生采集继续运行。
    #[serde(default)]
    pub continue_on_leave: Option<bool>,
}

/// 后台延续是无条件的：未指定的请求会在页面离开后保持任务存活，
/// 只有显式的 `false` 才选择退出。
pub(crate) const CONTINUE_ON_LEAVE_DEFAULT: bool = true;

impl RecordingStartInput {
    pub(crate) fn with_recording_defaults(mut self, default_include_danmaku: bool) -> Self {
        self.include_danmaku = Some(self.include_danmaku.unwrap_or(default_include_danmaku));
        self.continue_on_leave = Some(self.continue_on_leave.unwrap_or(CONTINUE_ON_LEAVE_DEFAULT));
        self
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct RecordingStorageInfo {
    pub path: String,
    pub default_path: String,
    pub is_default: bool,
    pub available_bytes: Option<u64>,
    pub minimum_free_bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FfmpegRecordingOptions {
    pub rw_timeout_seconds: u32,
    pub reconnect_delay_max_seconds: u32,
    pub hls_segment_retry_count: u32,
    pub split_duration: Option<Duration>,
}

impl Default for FfmpegRecordingOptions {
    fn default() -> Self {
        Self {
            rw_timeout_seconds: 10,
            reconnect_delay_max_seconds: 8,
            hls_segment_retry_count: 5,
            split_duration: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RecordingChangedEvent {
    recording_id: String,
    status: RecordingStatus,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RecordingProgressEvent {
    recording_id: String,
    duration_ms: u64,
    size_bytes: u64,
    danmaku_count: u64,
}

#[derive(Default)]
struct RecordingEventSink {
    app: Mutex<Option<AppHandle>>,
}

impl RecordingEventSink {
    fn attach(&self, app: AppHandle) {
        *self
            .app
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(app);
    }

    fn emit(&self, recording_id: &str, status: RecordingStatus) {
        let app = self
            .app
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        let Some(app) = app else { return };
        if let Err(error) = app.emit(
            RECORDING_CHANGED_EVENT,
            RecordingChangedEvent {
                recording_id: recording_id.to_string(),
                status,
            },
        ) {
            tracing::warn!(error = %error, "发送录制状态事件失败");
        }
    }

    fn emit_progress(&self, progress: RecordingProgressEvent) {
        let app = self
            .app
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        let Some(app) = app else { return };
        if let Err(error) = app.emit(RECORDING_PROGRESS_EVENT, progress) {
            tracing::warn!(error = %error, "发送录制进度事件失败");
        }
    }

    fn release_background_danmaku(&self, source_key: &str) {
        let app = self
            .app
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        let Some(app) = app else { return };
        let Some(state) = app.try_state::<crate::state::AppState>() else {
            return;
        };
        if !state.recording.has_background_danmaku_recording(source_key) {
            state.danmaku.disconnect_background_for_source(source_key);
        }
    }

    async fn prepare_danmaku_finish(&self, source_key: &str) {
        let app = self
            .app
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        let Some(app) = app else { return };
        let Some(state) = app.try_state::<crate::state::AppState>() else {
            return;
        };
        state.danmaku.finish_recording_source(source_key).await;
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecordingStorageConfig {
    schema_version: u32,
    current_path: Option<String>,
    known_paths: Vec<String>,
}

impl Default for RecordingStorageConfig {
    fn default() -> Self {
        Self {
            schema_version: RECORDING_STORAGE_CONFIG_VERSION,
            current_path: None,
            known_paths: Vec::new(),
        }
    }
}

#[derive(Debug, Clone)]
struct RecordingStorageState {
    default_root: PathBuf,
    current_root: PathBuf,
    /// 包含当前与默认根目录，其后是历史根目录。
    roots: Vec<PathBuf>,
    history: Vec<PathBuf>,
    config_path: PathBuf,
}

#[derive(Debug)]
struct IndexedRecordingRoot {
    recordings: HashMap<String, StoredRecording>,
    modified_at: Option<SystemTime>,
}

#[derive(Debug, Default)]
struct RecordingLibraryIndex {
    roots: HashMap<PathBuf, IndexedRecordingRoot>,
}

impl RecordingLibraryIndex {
    fn refresh_changed_roots(&mut self, roots: &[PathBuf]) {
        for root in roots {
            let modified_at = recording_root_modified_at(root);
            let unchanged = self
                .roots
                .get(root)
                .is_some_and(|indexed| indexed.modified_at == modified_at);
            if unchanged {
                continue;
            }
            self.replace_root(root.clone(), scan_recording_root(root));
        }
        self.roots.retain(|root, _| roots.contains(root));
    }

    fn replace_root(&mut self, root: PathBuf, recordings: HashMap<String, StoredRecording>) {
        let modified_at = recording_root_modified_at(&root);
        self.roots.insert(
            root,
            IndexedRecordingRoot {
                recordings,
                modified_at,
            },
        );
    }

    fn upsert(&mut self, root: &Path, stored: StoredRecording) {
        let modified_at = recording_root_modified_at(root);
        let indexed =
            self.roots
                .entry(root.to_path_buf())
                .or_insert_with(|| IndexedRecordingRoot {
                    recordings: HashMap::new(),
                    modified_at,
                });
        indexed.recordings.insert(stored.id.clone(), stored);
        indexed.modified_at = modified_at;
    }

    fn remove(&mut self, root: &Path, id: &str) {
        let modified_at = recording_root_modified_at(root);
        if let Some(indexed) = self.roots.get_mut(root) {
            indexed.recordings.remove(id);
            indexed.modified_at = modified_at;
        }
    }

    fn items(&self, roots: &[PathBuf]) -> Vec<RecordingItem> {
        let mut by_id = HashMap::<String, RecordingItem>::new();
        for root in roots {
            let Some(indexed) = self.roots.get(root) else {
                continue;
            };
            for stored in indexed.recordings.values() {
                by_id
                    .entry(stored.id.clone())
                    .or_insert_with(|| stored.item(root));
            }
        }
        by_id.into_values().collect()
    }
}

impl RecordingStorageState {
    fn info(&self) -> RecordingStorageInfo {
        RecordingStorageInfo {
            path: crate::app_paths::path_to_string(&self.current_root),
            default_path: crate::app_paths::path_to_string(&self.default_root),
            is_default: self.current_root == self.default_root,
            available_bytes: available_storage_space(&self.current_root).ok(),
            minimum_free_bytes: MINIMUM_FREE_SPACE_BYTES,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredRecording {
    schema_version: u32,
    id: String,
    source_key: String,
    source_kind: String,
    site_id: Option<String>,
    room_id: Option<String>,
    title: String,
    user_name: String,
    cover: String,
    user_avatar: String,
    protocol: PlaybackProtocol,
    status: RecordingStatus,
    started_at: i64,
    ended_at: Option<i64>,
    duration_ms: u64,
    size_bytes: u64,
    include_danmaku: bool,
    continue_on_leave: bool,
    danmaku_count: u64,
    danmaku_file: Option<String>,
    media_file: String,
    error: Option<String>,
}

impl StoredRecording {
    fn item(&self, root: &Path) -> RecordingItem {
        let bundle = root.join(&self.id);
        let media_path = Path::new(&self.media_file);
        let reveal_path = if safe_relative_path(media_path) {
            let candidate = bundle.join(media_path);
            if candidate.exists() {
                candidate
            } else {
                bundle
            }
        } else {
            bundle
        };
        RecordingItem {
            id: self.id.clone(),
            source_key: self.source_key.clone(),
            source_kind: self.source_kind.clone(),
            site_id: self.site_id.clone(),
            room_id: self.room_id.clone(),
            title: self.title.clone(),
            user_name: self.user_name.clone(),
            cover: self.cover.clone(),
            user_avatar: self.user_avatar.clone(),
            protocol: self.protocol,
            status: self.status.clone(),
            started_at: self.started_at,
            ended_at: self.ended_at,
            duration_ms: self.duration_ms,
            size_bytes: self.size_bytes,
            include_danmaku: self.include_danmaku,
            continue_on_leave: self.continue_on_leave,
            danmaku_count: self.danmaku_count,
            danmaku_file: self.danmaku_file.clone(),
            file_path: crate::app_paths::path_to_string(&reveal_path),
            error: self.error.clone(),
        }
    }
}

/// 录制库视图的统一排序：最新开始在前，同一时间按 id 稳定排列。
/// 完整库与活动集合共用它，避免两条查询路径各自演化出不同顺序。
fn sort_recordings_newest_first(items: &mut [RecordingItem]) {
    items.sort_by(|left, right| {
        right
            .started_at
            .cmp(&left.started_at)
            .then_with(|| left.id.cmp(&right.id))
    });
}

fn parse_stored_recording(bytes: &[u8]) -> Result<StoredRecording, String> {
    let stored =
        serde_json::from_slice::<StoredRecording>(bytes).map_err(|error| error.to_string())?;
    if stored.schema_version != RECORDING_METADATA_VERSION {
        return Err(format!(
            "录制 metadata 版本 {} 不受支持，当前版本为 {}",
            stored.schema_version, RECORDING_METADATA_VERSION
        ));
    }
    Ok(stored)
}

struct SessionState {
    root: PathBuf,
    bundle: PathBuf,
    stored: Mutex<StoredRecording>,
    bytes: AtomicU64,
    duration_ms: AtomicU64,
    danmaku_count: AtomicU64,
    last_progress_event_ms: AtomicU64,
    danmaku_writer: Mutex<Option<std::fs::File>>,
    danmaku_closed: AtomicBool,
    finished: AtomicBool,
    finish_lock: Mutex<()>,
    library: Arc<Mutex<RecordingLibraryIndex>>,
    events: Arc<RecordingEventSink>,
}

#[derive(Debug, Serialize)]
struct StoredDanmakuBatch<'a> {
    offset_ms: u64,
    events: &'a [DanmakuEvent],
}

impl SessionState {
    fn snapshot(&self) -> RecordingItem {
        let mut item = self
            .stored
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .item(&self.root);
        if !self.finished.load(Ordering::Acquire) {
            item.size_bytes = self.bytes.load(Ordering::Relaxed);
            item.duration_ms = self.duration_ms.load(Ordering::Relaxed);
            item.danmaku_count = self.danmaku_count.load(Ordering::Relaxed);
        }
        item
    }

    fn append_danmaku(&self, events: &[DanmakuEvent]) {
        if events.is_empty() || self.danmaku_closed.load(Ordering::Acquire) {
            return;
        }
        let (include, started_at) = {
            let stored = self
                .stored
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            (stored.include_danmaku, stored.started_at)
        };
        if !include || self.danmaku_closed.load(Ordering::Acquire) {
            return;
        }
        let batch = match serde_json::to_vec(&StoredDanmakuBatch {
            offset_ms: unix_ms().saturating_sub(started_at).max(0) as u64,
            events,
        }) {
            Ok(bytes) => bytes,
            Err(error) => {
                tracing::warn!(error = %error, "序列化录制弹幕失败");
                return;
            }
        };
        let mut writer = self
            .danmaku_writer
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if self.danmaku_closed.load(Ordering::Acquire) {
            return;
        }
        let Some(file) = writer.as_mut() else { return };
        if file.write_all(&batch).is_err() || file.write_all(b"\n").is_err() {
            *writer = None;
            tracing::warn!("写入录制弹幕轨失败，后续弹幕已停用");
            return;
        }
        self.danmaku_count
            .fetch_add(events.len() as u64, Ordering::Relaxed);
        self.emit_progress();
    }

    fn emit_progress(&self) {
        let now = unix_ms().max(0) as u64;
        let mut previous = self.last_progress_event_ms.load(Ordering::Relaxed);
        loop {
            if now.saturating_sub(previous) < RECORDING_PROGRESS_EVENT_INTERVAL_MS {
                return;
            }
            match self.last_progress_event_ms.compare_exchange_weak(
                previous,
                now,
                Ordering::Relaxed,
                Ordering::Relaxed,
            ) {
                Ok(_) => break,
                Err(current) => previous = current,
            }
        }
        let recording_id = self
            .stored
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .id
            .clone();
        self.events.emit_progress(RecordingProgressEvent {
            recording_id,
            duration_ms: self.duration_ms.load(Ordering::Relaxed),
            size_bytes: self.bytes.load(Ordering::Relaxed),
            danmaku_count: self.danmaku_count.load(Ordering::Relaxed),
        });
    }
}

struct Session {
    active: Arc<ActiveSessionState>,
    cancel: watch::Sender<bool>,
    task: JoinHandle<()>,
}

struct ActiveSessionState {
    inner: Mutex<ActiveSessionInner>,
}

struct ActiveSessionInner {
    current: Arc<SessionState>,
    recording_ids: HashSet<String>,
}

impl ActiveSessionState {
    fn new(state: Arc<SessionState>) -> Self {
        let recording_id = state
            .stored
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .id
            .clone();
        Self {
            inner: Mutex::new(ActiveSessionInner {
                current: state,
                recording_ids: HashSet::from([recording_id]),
            }),
        }
    }

    fn current(&self) -> Arc<SessionState> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .current
            .clone()
    }

    fn replace(&self, state: Arc<SessionState>) {
        let recording_id = state
            .stored
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .id
            .clone();
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        inner.recording_ids.insert(recording_id);
        inner.current = state;
    }

    fn owns_recording_id(&self, recording_id: &str) -> bool {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .recording_ids
            .contains(recording_id)
    }
}

struct FinalizingSession {
    state: Arc<SessionState>,
}

struct BundleGuard {
    path: PathBuf,
    committed: bool,
}

impl BundleGuard {
    fn new(path: PathBuf) -> Self {
        Self {
            path,
            committed: false,
        }
    }

    fn commit(mut self) {
        self.committed = true;
    }
}

impl Drop for BundleGuard {
    fn drop(&mut self) {
        if !self.committed {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }
}

/// 进程级管理器。它持有录制任务，
/// 并惰性启动应用内录制播放器使用的回环文件服务器。
pub struct RecordingManager {
    _instance_lock: File,
    storage: Arc<Mutex<RecordingStorageState>>,
    library: Arc<Mutex<RecordingLibraryIndex>>,
    /// 完整库索引是否已建立。首次 `list()` 才扫描历史根，启动路径只做恢复保护。
    library_hydrated: AtomicBool,
    sessions: Mutex<HashMap<String, Session>>,
    finalizing: Mutex<HashMap<String, FinalizingSession>>,
    pending_background_danmaku: Mutex<HashMap<String, usize>>,
    start_gate: Mutex<()>,
    shutting_down: AtomicBool,
    events: Arc<RecordingEventSink>,
    playback: PlaybackServer,
}

pub(crate) struct PendingBackgroundDanmakuStart<'a> {
    pending: &'a Mutex<HashMap<String, usize>>,
    events: &'a RecordingEventSink,
    source_key: Option<String>,
}

impl Drop for PendingBackgroundDanmakuStart<'_> {
    fn drop(&mut self) {
        let Some(source_key) = self.source_key.take() else {
            return;
        };
        let mut pending = self
            .pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(count) = pending.get_mut(&source_key) {
            if *count <= 1 {
                pending.remove(&source_key);
            } else {
                *count -= 1;
            }
        }
        drop(pending);
        // 一次失败的启动可能已让路由清理为该预订挂起了连接。
        // 只要没有已提交的录制持有它，就释放掉。
        self.events.release_background_danmaku(&source_key);
    }
}

impl RecordingManager {
    pub fn new(app_directory: &Path) -> AppResult<Self> {
        let instance_lock = acquire_recording_manager_lock(app_directory)?;
        let state = load_storage_state(app_directory)?;
        // 恢复保护保留在启动路径：崩溃遗留的 `.part` 与「录制中」元数据必须在
        // 下一次启动时收尾，否则库视图与实际文件会长期不一致。
        for root in &state.roots {
            if let Err(error) = recover_stale_recordings(root) {
                if *root == state.default_root {
                    return Err(error);
                }
                tracing::warn!(path = %root.display(), error = %error, "无法恢复历史录制目录");
            }
        }
        // 完整库索引（逐 bundle 读 metadata）延迟到首次 `list()`：不使用录制库的
        // 启动不再为历史根做全量扫描。索引未建立期间的增量写入仍照常落到
        // `library`，首次水合会以磁盘扫描结果为准覆盖对应根。
        let storage = Arc::new(Mutex::new(state));
        let library = Arc::new(Mutex::new(RecordingLibraryIndex::default()));
        let events = Arc::new(RecordingEventSink::default());
        Ok(Self {
            _instance_lock: instance_lock,
            playback: PlaybackServer::new(storage.clone()),
            storage,
            library,
            library_hydrated: AtomicBool::new(false),
            sessions: Mutex::new(HashMap::new()),
            finalizing: Mutex::new(HashMap::new()),
            pending_background_danmaku: Mutex::new(HashMap::new()),
            start_gate: Mutex::new(()),
            shutting_down: AtomicBool::new(false),
            events,
        })
    }

    pub fn attach_app_handle(&self, app: AppHandle) {
        self.events.attach(app);
    }

    pub(crate) fn reserve_background_danmaku_start(
        &self,
        source_key: &str,
        enabled: bool,
    ) -> PendingBackgroundDanmakuStart<'_> {
        let source_key = (enabled && !source_key.is_empty()).then(|| source_key.to_string());
        if let Some(source_key) = source_key.as_deref() {
            *self
                .pending_background_danmaku
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .entry(source_key.to_string())
                .or_insert(0) += 1;
        }
        PendingBackgroundDanmakuStart {
            pending: &self.pending_background_danmaku,
            events: &self.events,
            source_key,
        }
    }

    pub fn storage_info(&self) -> RecordingStorageInfo {
        self.storage
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .info()
    }

    pub fn set_storage_path(&self, requested: Option<String>) -> AppResult<RecordingStorageInfo> {
        let _start_gate = self
            .start_gate
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let next_root = match requested {
            Some(path) => {
                if path.trim().is_empty() {
                    return Err(AppError::new(
                        "recording_storage_path_invalid",
                        "录制保存位置不能为空",
                    ));
                }
                prepare_storage_root(Path::new(&path))?
            }
            None => self
                .storage
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .default_root
                .clone(),
        };
        let current_root = self
            .storage
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .current_root
            .clone();
        if current_root == next_root {
            return Ok(self.storage_info());
        }
        let mut sessions = self
            .sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        self.reap_finished_locked(&mut sessions);
        let mut finalizing = self
            .finalizing
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        Self::reap_finalizing_locked(&mut finalizing);
        if !sessions.is_empty() || !finalizing.is_empty() {
            return Err(AppError::new(
                "recording_storage_busy",
                "请先停止录制并等待收尾完成，再迁移录制保存位置",
            ));
        }
        drop(finalizing);
        drop(sessions);

        let moved = migrate_recording_bundles(&current_root, &next_root)?;
        let mut storage = self
            .storage
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut next = storage.clone();
        if next.current_root != next_root && next.current_root != next.default_root {
            push_unique_path(&mut next.history, next.current_root.clone());
        }
        if next_root != next.default_root {
            push_unique_path(&mut next.history, next_root.clone());
        }
        next.current_root = next_root;
        next.roots = ordered_roots(&next.current_root, &next.default_root, &next.history);
        if let Err(error) = write_storage_config(&next) {
            rollback_recording_bundles(&moved);
            return Err(error);
        }
        *storage = next;
        let roots = storage.roots.clone();
        drop(storage);
        let mut library = self
            .library
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        library.replace_root(current_root, HashMap::new());
        library.replace_root(roots[0].clone(), scan_recording_root(&roots[0]));
        library.refresh_changed_roots(&roots);
        drop(library);
        // 这里已经按新根集合重建了索引，后续 `list()` 无需再水合。
        self.library_hydrated.store(true, Ordering::Release);
        Ok(self.storage_info())
    }

    /// 首次 `list()` 时建立完整库索引。
    ///
    /// 双重检查 + 库锁保证并发首次调用只扫描一次；已建立后由
    /// `refresh_changed_roots` 负责增量刷新。
    fn ensure_library_hydrated(&self) {
        if self.library_hydrated.load(Ordering::Acquire) {
            return;
        }
        let roots = self.storage_roots();
        let mut library = self
            .library
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if self.library_hydrated.load(Ordering::Acquire) {
            return;
        }
        for root in &roots {
            library.replace_root(root.clone(), scan_recording_root(root));
        }
        self.library_hydrated.store(true, Ordering::Release);
    }

    /// 正在采集或收尾的会话快照。
    ///
    /// 退出保护、侧栏角标与自动录制去重只需要这一份集合，因此单独提供一条
    /// 不触碰库索引、不做磁盘扫描的查询路径。
    pub fn active_items(&self) -> Vec<RecordingItem> {
        let mut items: Vec<RecordingItem> = self
            .tracked_session_states()
            .iter()
            .map(|state| state.snapshot())
            .collect();
        sort_recordings_newest_first(&mut items);
        items
    }

    fn tracked_session_states(&self) -> Vec<Arc<SessionState>> {
        let mut sessions = self
            .sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        self.reap_finished_locked(&mut sessions);
        let mut finalizing = self
            .finalizing
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        Self::reap_finalizing_locked(&mut finalizing);
        sessions
            .values()
            .map(|session| session.active.current())
            .chain(finalizing.values().map(|session| session.state.clone()))
            .collect()
    }

    pub fn list(&self) -> AppResult<Vec<RecordingItem>> {
        self.ensure_library_hydrated();
        let tracked_states = self.tracked_session_states();
        let roots = self.storage_roots();
        let mut library = self
            .library
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        library.refresh_changed_roots(&roots);
        let mut items = library.items(&roots);
        drop(library);
        for state in tracked_states {
            let item = state.snapshot();
            if let Some(existing) = items.iter_mut().find(|entry| entry.id == item.id) {
                *existing = item;
            } else {
                items.push(item);
            }
        }
        sort_recordings_newest_first(&mut items);
        Ok(items)
    }

    /// `max_active` 是本次启动允许的并发录制数，来自设置 `recording_max_concurrent`。
    /// 它随每次启动传入而不是缓存在 manager 上：用户可能在两次启动之间改设置，
    /// 读一次就地用掉最不容易读到旧值。上限本身由设置层钳制到 1 ..= 6。
    pub async fn start_with_ffmpeg_options(
        &self,
        input: RecordingStartInput,
        route: &crate::proxy::ProxyRoute,
        ffmpeg_options: FfmpegRecordingOptions,
        max_active: usize,
    ) -> AppResult<RecordingItem> {
        if self.shutting_down.load(Ordering::Acquire) {
            return Err(AppError::new(
                "recording_shutting_down",
                "应用正在退出，无法开始新的录制",
            ));
        }
        validate_start_input(&input)?;
        let source_key = input.source_key.trim().to_string();
        let include_danmaku = input.include_danmaku.unwrap_or(false);
        // 与命令层相同的默认值，使直接调用 `start` 的行为与 IPC 调用一致，
        // 而不是静默退出后台延续。
        let continue_on_leave = input.continue_on_leave.unwrap_or(CONTINUE_ON_LEAVE_DEFAULT);
        let _danmaku_start_reservation = self.reserve_background_danmaku_start(
            &source_key,
            input.include_danmaku != Some(false) && input.continue_on_leave != Some(false),
        );
        let source_protocol = if input.source.protocol == PlaybackProtocol::Unknown {
            PlaybackProtocol::infer_from_url(&input.source.url)
        } else {
            input.source.protocol
        };
        validate_recording_source(source_protocol, &input.source, route)?;
        // 对启动生命周期串行化，保证去重检查的原子性。会话互斥锁本身在代理构造和
        // 文件系统 I/O 之前就会释放，
        // 因此慢磁盘或代理不会阻塞 stop/list/capture_danmaku。
        let _start_gate = self
            .start_gate
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut sessions = self
            .sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if self.shutting_down.load(Ordering::Acquire) {
            return Err(AppError::new(
                "recording_shutting_down",
                "应用正在退出，无法开始新的录制",
            ));
        }
        self.reap_finished_locked(&mut sessions);
        let mut finalizing = self
            .finalizing
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        Self::reap_finalizing_locked(&mut finalizing);
        let max_active = max_active.max(1);
        if sessions.len() + finalizing.len() >= max_active {
            return Err(AppError::new(
                "recording_limit_reached",
                format!("最多同时录制 {max_active} 路直播"),
            ));
        }
        if sessions
            .values()
            .map(|session| session.active.current())
            .chain(finalizing.values().map(|session| session.state.clone()))
            .any(|state| {
                let item = state.snapshot();
                item.status == RecordingStatus::Recording
                    && (item.source_key == source_key
                        || (input.source_kind.trim() == "live"
                            && item.source_kind == "live"
                            && input.site_id.is_some()
                            && input.room_id.is_some()
                            && item.site_id.as_deref() == input.site_id.as_deref()
                            && item.room_id.as_deref() == input.room_id.as_deref()))
            })
        {
            return Err(AppError::new(
                "recording_already_active",
                "该直播已经在录制中",
            ));
        }
        drop(finalizing);
        drop(sessions);

        // 在创建分卷之前先校验代理。格式错误的代理不得留下看似活动录制、
        // 却没有任务挂载的元数据。
        let stream_client = http_client::recording_stream_client_for_route(route)?;

        let root = self.current_root();
        ensure_sufficient_storage_space(&root)?;
        let started_at = unix_ms();
        let room_dir = recording_bundle_room_dir(&input);
        let session_dir = recording_bundle_session_dir(&input, started_at);
        let (bundle, id) =
            create_recording_bundle(&root, &self.storage_roots(), &room_dir, &session_dir)?;
        let bundle_guard = BundleGuard::new(bundle.clone());
        let title = normalize_text(&input.title, "未命名直播");
        let user_name = normalize_text(&input.user_name, "");
        let file_stem = recording_file_stem(&user_name, &title, started_at);
        let output_protocol = match source_protocol {
            PlaybackProtocol::Hls => PlaybackProtocol::MpegTs,
            protocol => protocol,
        };
        let media_file = media_file_name(output_protocol, &input.source.url, &file_stem);
        let danmaku_file = include_danmaku.then(|| "danmaku.jsonl".to_string());
        let danmaku_writer = if danmaku_file.is_some() {
            Some(
                OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(bundle.join("danmaku.jsonl"))
                    .map_err(|error| {
                        AppError::new(
                            "recording_storage_error",
                            format!("创建弹幕轨文件失败: {error}"),
                        )
                    })?,
            )
        } else {
            None
        };
        let stored = StoredRecording {
            schema_version: RECORDING_METADATA_VERSION,
            id: id.clone(),
            source_key: source_key.clone(),
            source_kind: normalize_text(&input.source_kind, "live"),
            site_id: optional_text(input.site_id),
            room_id: optional_text(input.room_id),
            title,
            user_name,
            cover: normalize_text(&input.cover, ""),
            user_avatar: normalize_text(&input.user_avatar, ""),
            protocol: output_protocol,
            status: RecordingStatus::Recording,
            started_at,
            ended_at: None,
            duration_ms: 0,
            size_bytes: 0,
            include_danmaku,
            continue_on_leave,
            danmaku_count: 0,
            danmaku_file,
            media_file,
            error: None,
        };
        write_metadata(&bundle, &stored)?;
        let state = Arc::new(SessionState {
            root: root.clone(),
            bundle: bundle.clone(),
            stored: Mutex::new(stored),
            bytes: AtomicU64::new(0),
            duration_ms: AtomicU64::new(0),
            danmaku_count: AtomicU64::new(0),
            last_progress_event_ms: AtomicU64::new(0),
            danmaku_writer: Mutex::new(danmaku_writer),
            danmaku_closed: AtomicBool::new(false),
            finished: AtomicBool::new(false),
            finish_lock: Mutex::new(()),
            library: self.library.clone(),
            events: self.events.clone(),
        });
        if self.shutting_down.load(Ordering::Acquire) {
            return Err(AppError::new(
                "recording_shutting_down",
                "应用正在退出，无法开始新的录制",
            ));
        }
        let (cancel, cancel_rx) = watch::channel(false);
        let task_state = state.clone();
        let danmaku_finish_source = include_danmaku.then(|| source_key.clone());
        let route = route.clone();
        let mut source = input.source;
        source.protocol = source_protocol;
        let segment_room_dir = room_dir.clone();
        let segment_storage_roots = self.storage_roots();
        let mut sessions = self
            .sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        // 一旦共享截止时间到期，关机流程可以停止等待缓慢的启动生命周期。
        // 只有在再次检查围栏之后才在会话锁下提交，
        // 使 drain 与 spawn 无法交错穿越。
        if self.shutting_down.load(Ordering::Acquire) {
            return Err(AppError::new(
                "recording_shutting_down",
                "应用正在退出，无法开始新的录制",
            ));
        }
        self.library
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .upsert(
                &root,
                state
                    .stored
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .clone(),
            );
        let active = Arc::new(ActiveSessionState::new(state.clone()));
        let task_active = active.clone();
        let task = tauri::async_runtime::spawn(async move {
            let mut task_state = task_state;
            loop {
                let mut outcome = run_recording_task(
                    stream_client.clone(),
                    source.clone(),
                    route.clone(),
                    ffmpeg_options,
                    task_state.clone(),
                    cancel_rx.clone(),
                )
                .await;
                if outcome.split && !*cancel_rx.borrow() {
                    match create_split_segment(
                        &task_state,
                        &source.url,
                        &segment_room_dir,
                        &segment_storage_roots,
                    ) {
                        Ok(next_state) => {
                            if *cancel_rx.borrow() {
                                discard_unstarted_split_segment(&next_state);
                            } else {
                                task_active.replace(next_state.clone());
                                outcome.split = false;
                                finish_split_segment(&task_state, outcome);
                                let next_id = next_state
                                    .stored
                                    .lock()
                                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                                    .id
                                    .clone();
                                next_state.events.emit(&next_id, RecordingStatus::Recording);
                                task_state = next_state;
                                continue;
                            }
                        }
                        Err(error) => {
                            outcome.status = RecordingStatus::Interrupted;
                            outcome.error = Some(format!(
                                "当前分段已保存，但创建下一分段失败: {}",
                                error.message
                            ));
                        }
                    }
                }
                outcome.split = false;
                if let Some(source_key) = danmaku_finish_source.as_deref() {
                    task_state.events.prepare_danmaku_finish(source_key).await;
                }
                finish_session(&task_state, outcome);
                break;
            }
        });
        let item = state.snapshot();
        // 在该任务构建期间没有其他启动能通过闸门，因此上面检查过的预订仍然有效。
        // 关机流程会在等待闸门之前设置自己的围栏；越过预检查的启动在这里提交，
        // 随后与其他会话一起被 drain。
        sessions.insert(
            Uuid::new_v4().to_string(),
            Session {
                active,
                cancel,
                task,
            },
        );
        bundle_guard.commit();
        drop(sessions);
        drop(_start_gate);
        self.events.emit(&item.id, RecordingStatus::Recording);
        Ok(item)
    }

    /// 把进行中的录制标记为在其播放器页关闭后继续。
    ///
    /// 用户在离开房间时选择"继续录制并离开"时由离开拦截调用。翻转标记会让
    /// `has_background_danmaku_recording` 变为 true，于是房间的弹幕 websocket
    /// 在卸载时被移入后台（会话结束时释放），
    /// 而不是被拆除。
    pub fn set_continue_on_leave(
        &self,
        id: &str,
        continue_on_leave: bool,
    ) -> AppResult<RecordingItem> {
        let state = {
            let sessions = self
                .sessions
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            sessions
                .values()
                .find_map(|session| {
                    session
                        .active
                        .owns_recording_id(id)
                        .then(|| session.active.current())
                })
                .ok_or_else(|| AppError::new("recording_not_found", "录制不存在"))?
        };
        let stored = {
            let mut stored = state
                .stored
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if stored.status != RecordingStatus::Recording {
                return Err(AppError::new(
                    "recording_not_active",
                    "录制已结束，无法切换后台继续录制",
                ));
            }
            stored.continue_on_leave = continue_on_leave;
            stored.clone()
        };
        write_metadata(&state.bundle, &stored)?;
        state
            .library
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .upsert(&state.root, stored);
        Ok(state.snapshot())
    }

    pub async fn stop(&self, id: &str) -> AppResult<RecordingItem> {
        let (state, cancel, task) = {
            let mut sessions = self
                .sessions
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let mut finalizing = self
                .finalizing
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if finalizing.contains_key(id) {
                return Err(AppError::new("recording_stopping", "录制正在停止，请稍候"));
            }
            let session_key = sessions
                .iter()
                .find_map(|(key, session)| {
                    session.active.owns_recording_id(id).then(|| key.clone())
                })
                .ok_or_else(|| AppError::new("recording_not_found", "录制不存在"))?;
            let session = sessions
                .remove(&session_key)
                .expect("recording session exists after lookup");
            let state = session.active.current();
            let current_id = state
                .stored
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .id
                .clone();
            finalizing.insert(
                current_id,
                FinalizingSession {
                    state: state.clone(),
                },
            );
            (state, session.cancel, session.task)
        };
        let _ = cancel.send(true);
        if let Err(error) = task.await {
            if self.shutting_down.load(Ordering::Acquire) || task_join_was_cancelled(&error) {
                tracing::warn!(
                    recording_id = %id,
                    "应用退出已中止录制任务，将在下次启动时恢复临时文件"
                );
            } else {
                finish_interrupted_session(&state, "录制任务意外终止".into());
            }
        }
        let item = state.snapshot();
        self.finalizing
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .retain(|_, session| !Arc::ptr_eq(&session.state, &state));
        Ok(item)
    }

    pub fn delete(&self, id: &str) -> AppResult<()> {
        if !is_safe_recording_id(id) {
            return Err(AppError::new("recording_invalid_id", "录制标识无效"));
        }
        {
            let mut sessions = self
                .sessions
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            self.reap_finished_locked(&mut sessions);
            let mut finalizing = self
                .finalizing
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            Self::reap_finalizing_locked(&mut finalizing);
            let active = sessions.values().any(|session| {
                let state = session.active.current();
                state
                    .stored
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .id
                    == id
            });
            if active || finalizing.contains_key(id) {
                return Err(AppError::new(
                    "recording_still_active",
                    "请先停止录制再删除",
                ));
            }
        }
        // 存储根来自查询结果，而不是 `bundle.parent()`：
        // 一个 id 跨越两级路径，其父目录是房间目录。
        // 库按存储根索引，房间目录会静默匹配不到任何条目，
        // 导致已删除的录制仍留在索引里。
        let Some((root, bundle)) = find_bundle_in_root(&self.storage_roots(), id) else {
            return Ok(());
        };
        std::fs::remove_dir_all(&bundle).map_err(|error| {
            AppError::new("recording_delete_error", format!("删除录制失败: {error}"))
        })?;
        // 清空的房间目录不会作为游离条目残留，
        // 但仍持有其他会话的房间目录必须保留。
        if let Some(room_dir) = bundle.parent()
            && room_dir != root
        {
            let _ = std::fs::remove_dir(room_dir);
        }
        self.library
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&root, id);
        Ok(())
    }

    pub async fn playback_url(&self, id: &str) -> AppResult<String> {
        if !is_safe_recording_id(id) {
            return Err(AppError::new("recording_invalid_id", "录制标识无效"));
        }
        let (root, stored) = find_stored(&self.storage_roots(), id)?;
        if stored.status == RecordingStatus::Recording {
            return Err(AppError::new(
                "recording_still_active",
                "录制结束后才能回放",
            ));
        }
        let media_file = Path::new(&stored.media_file);
        if !safe_relative_path(media_file) {
            return Err(AppError::new(
                "recording_metadata_error",
                "录制媒体路径无效",
            ));
        }
        let file = root.join(id).join(media_file);
        if !file.exists() {
            return Err(AppError::new("recording_media_missing", "录制文件不存在"));
        }
        self.playback.url(id, &stored.media_file).await
    }

    pub async fn danmaku_url(&self, id: &str) -> AppResult<Option<String>> {
        if !is_safe_recording_id(id) {
            return Err(AppError::new("recording_invalid_id", "录制标识无效"));
        }
        let (_root, stored) = find_stored(&self.storage_roots(), id)?;
        if stored.status == RecordingStatus::Recording {
            return Err(AppError::new(
                "recording_still_active",
                "录制结束后才能读取弹幕轨",
            ));
        }
        let Some(file) = stored.danmaku_file.as_deref() else {
            return Ok(None);
        };
        let relative = Path::new(file);
        if !safe_relative_path(relative) {
            return Err(AppError::new("recording_metadata_error", "弹幕轨路径无效"));
        }
        let (root, _) = find_stored(&self.storage_roots(), id)?;
        if !root.join(id).join(relative).is_file() {
            return Ok(None);
        }
        Ok(Some(self.playback.url(id, file).await?))
    }

    /// 把录制的弹幕伴生文件转换为 ASS 字幕并放在媒体文件旁，
    /// 复用媒体词干命名，让 PotPlayer、mpv 等外部播放器自动加载。
    /// 返回写出的路径。
    pub async fn export_danmaku_ass(
        &self,
        id: &str,
        options: AssExportOptions,
    ) -> AppResult<String> {
        if !is_safe_recording_id(id) {
            return Err(AppError::new("recording_invalid_id", "录制标识无效"));
        }
        let (root, stored) = find_stored(&self.storage_roots(), id)?;
        if stored.status == RecordingStatus::Recording {
            return Err(AppError::new(
                "recording_still_active",
                "录制结束后才能导出弹幕字幕",
            ));
        }
        let Some(danmaku_file) = stored.danmaku_file.as_deref() else {
            return Err(AppError::new(
                "recording_danmaku_missing",
                "该录制没有弹幕轨",
            ));
        };
        let danmaku_relative = Path::new(danmaku_file);
        let media_relative = Path::new(&stored.media_file);
        if !safe_relative_path(danmaku_relative) || !safe_relative_path(media_relative) {
            return Err(AppError::new(
                "recording_metadata_error",
                "录制文件路径无效",
            ));
        }
        let bundle = root.join(id);
        let source = bundle.join(danmaku_relative);
        // 复用媒体词干，使字幕以所有桌面播放器都会查找的名字
        // 紧挨着视频文件放置。
        let target = bundle.join(media_relative).with_extension("ass");

        tokio::task::spawn_blocking(move || -> AppResult<String> {
            let _export_guard = ASS_EXPORT_IO_LOCK
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let file = File::open(&source).map_err(|error| {
                AppError::new(
                    "recording_danmaku_missing",
                    format!("读取弹幕轨失败: {error}"),
                )
            })?;
            let count = write_bundle_file_with_sync(&target, |output| {
                let mut writer = BufWriter::new(output);
                let count = ass::write_ass(BufReader::new(file), &mut writer, &options)?;
                writer.flush()?;
                Ok((count > 0).then_some(count))
            })
            .map_err(|error| {
                AppError::new(
                    "recording_ass_export_failed",
                    format!("生成或保存 ASS 字幕失败: {error}"),
                )
            })?;
            if count.is_none() {
                return Err(AppError::new(
                    "recording_danmaku_empty",
                    "按当前弹幕设置过滤后没有可导出的弹幕",
                ));
            }
            Ok(crate::app_paths::path_to_string(&target))
        })
        .await
        .map_err(|error| {
            AppError::new(
                "recording_ass_export_failed",
                format!("导出弹幕字幕任务终止: {error}"),
            )
        })?
    }

    /// 把一批已批量化的弹幕负载追加到每个匹配的活动录制。
    /// 源键围栏防止房间切换把新房间的聊天泄漏进较早的录制。
    pub fn capture_danmaku(&self, source_key: &str, events: &[DanmakuEvent]) {
        if events.is_empty() {
            return;
        }
        let sessions = self
            .sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let finalizing = self
            .finalizing
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let matching_states: Vec<_> = sessions
            .values()
            .map(|session| session.active.current())
            .chain(finalizing.values().map(|session| session.state.clone()))
            .filter_map(|session| {
                let matches = session
                    .stored
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .source_key
                    == source_key;
                matches.then(|| session.clone())
            })
            .collect();
        drop(finalizing);
        drop(sessions);
        for state in matching_states {
            state.append_danmaku(events);
        }
    }

    /// 离开该源时是否必须保留其弹幕 websocket。只有在播放器页关闭后，
    /// 显式配置了伴生采集且后台录制的会话才持有连接。
    pub fn has_background_danmaku_recording(&self, source_key: &str) -> bool {
        if self
            .pending_background_danmaku
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .contains_key(source_key)
        {
            return true;
        }
        let sessions = self
            .sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let finalizing = self
            .finalizing
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        sessions
            .values()
            .map(|session| session.active.current())
            .chain(finalizing.values().map(|session| session.state.clone()))
            .any(|state| {
                !state.finished.load(Ordering::Acquire)
                    && stored_keeps_background_danmaku(
                        &state
                            .stored
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner()),
                        source_key,
                    )
            })
    }

    /// 当前正在采集媒体的任务数量，对应库界面显示为"录制中"的行。
    /// 已在收尾的会话不计入：它们在保存而非录制，
    /// 且关机路径会等待它们完成。
    pub fn active_count(&self) -> usize {
        let mut sessions = self
            .sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        self.reap_finished_locked(&mut sessions);
        sessions.len()
    }

    pub async fn stop_all_graceful(&self) {
        // 立即对新启动设置围栏。之后获取闸门是一道屏障：
        // 已经越过预检查的启动会在 manager drain 会话之前提交任务，
        // 而此后所有的启动都会失败。
        if self.shutting_down.swap(true, Ordering::AcqRel) {
            return;
        }
        let deadline = tokio::time::Instant::now() + GRACEFUL_SHUTDOWN_TIMEOUT;
        if !wait_for_start_gate_until(&self.start_gate, deadline).await {
            tracing::warn!("录制开始流程未在退出期限内结束，未提交的任务将由退出栅栏拒绝");
        }
        let (sessions, already_finalizing): (Vec<_>, Vec<_>) = {
            let mut sessions = self
                .sessions
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            self.reap_finished_locked(&mut sessions);
            let mut finalizing = self
                .finalizing
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            Self::reap_finalizing_locked(&mut finalizing);
            let already_finalizing = finalizing
                .iter()
                .map(|(id, session)| (id.clone(), session.state.clone()))
                .collect();
            let drained: Vec<_> = sessions.drain().collect();
            for (id, session) in &drained {
                let state = session.active.current();
                finalizing.insert(id.clone(), FinalizingSession { state });
            }
            (drained, already_finalizing)
        };
        tokio::join!(
            stop_sessions_until_deadline(sessions, deadline),
            wait_for_finalizing_sessions(already_finalizing, deadline),
        );
        let mut finalizing = self
            .finalizing
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        Self::reap_finalizing_locked(&mut finalizing);
        drop(finalizing);
        self.playback.stop();
    }

    /// 为非异步关机钩子提供的同步兼容包装。
    pub fn stop_all(&self) {
        let result = std::thread::scope(|scope| {
            scope
                .spawn(|| tauri::async_runtime::block_on(self.stop_all_graceful()))
                .join()
        });
        if result.is_err() {
            tracing::error!("录制任务优雅退出线程异常，正在强制停止剩余任务");
            self.shutting_down.store(true, Ordering::Release);
            let sessions: Vec<_> = self
                .sessions
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .drain()
                .map(|(_, session)| session)
                .collect();
            for session in sessions {
                let _ = session.cancel.send(true);
                session.task.abort();
            }
            self.playback.stop();
        }
    }

    fn reap_finished_locked(&self, sessions: &mut HashMap<String, Session>) {
        sessions.retain(|_, session| !session.active.current().finished.load(Ordering::Acquire));
    }

    fn reap_finalizing_locked(finalizing: &mut HashMap<String, FinalizingSession>) {
        finalizing.retain(|_, session| !session.state.finished.load(Ordering::Acquire));
    }

    fn storage_roots(&self) -> Vec<PathBuf> {
        self.storage
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .roots
            .clone()
    }

    fn current_root(&self) -> PathBuf {
        self.storage
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .current_root
            .clone()
    }
}

async fn wait_for_start_gate_until(start_gate: &Mutex<()>, deadline: tokio::time::Instant) -> bool {
    loop {
        match start_gate.try_lock() {
            Ok(guard) => {
                drop(guard);
                return true;
            }
            Err(TryLockError::Poisoned(poisoned)) => {
                drop(poisoned.into_inner());
                return true;
            }
            Err(TryLockError::WouldBlock) => {}
        }
        let now = tokio::time::Instant::now();
        if now >= deadline {
            return false;
        }
        tokio::time::sleep_until(std::cmp::min(deadline, now + Duration::from_millis(25))).await;
    }
}

async fn stop_sessions_until_deadline(
    sessions: Vec<(String, Session)>,
    deadline: tokio::time::Instant,
) {
    for (_, session) in &sessions {
        let _ = session.cancel.send(true);
    }

    loop {
        if sessions
            .iter()
            .all(|(_, session)| session.task.inner().is_finished())
        {
            break;
        }
        let now = tokio::time::Instant::now();
        if now >= deadline {
            break;
        }
        tokio::time::sleep_until(std::cmp::min(deadline, now + Duration::from_millis(25))).await;
    }

    let mut timed_out = HashSet::new();
    for (id, session) in &sessions {
        if !session.task.inner().is_finished() {
            tracing::warn!(recording_id = %id, "录制任务收尾超时，正在强制停止");
            timed_out.insert(id.clone());
            session.task.abort();
        }
    }

    if !timed_out.is_empty() {
        let abort_deadline = tokio::time::Instant::now() + TASK_ABORT_SETTLE_TIMEOUT;
        loop {
            if sessions
                .iter()
                .all(|(_, session)| session.task.inner().is_finished())
            {
                break;
            }
            let now = tokio::time::Instant::now();
            if now >= abort_deadline {
                break;
            }
            tokio::time::sleep_until(std::cmp::min(
                abort_deadline,
                now + Duration::from_millis(10),
            ))
            .await;
        }
    }

    for (id, session) in sessions {
        if !session.task.inner().is_finished() {
            tracing::error!(
                recording_id = %id,
                "强制停止录制任务仍未结束，将在下次启动时恢复临时文件"
            );
            continue;
        }
        if let Err(error) = session.task.await {
            if timed_out.contains(&id) || task_join_was_cancelled(&error) {
                tracing::warn!(
                    recording_id = %id,
                    "应用退出已中止超时录制任务，将在下次启动时恢复临时文件"
                );
            } else {
                tracing::warn!(recording_id = %id, error = %error, "录制任务在应用退出时异常终止");
                finish_interrupted_session(
                    &session.active.current(),
                    format!("录制任务在应用退出时异常终止: {error}"),
                );
            }
        } else if !session.active.current().finished.load(Ordering::Acquire) {
            finish_interrupted_session(&session.active.current(), "录制任务未保存结束状态".into());
        }
    }
}

fn task_join_was_cancelled(error: &tauri::Error) -> bool {
    matches!(error, tauri::Error::JoinError(error) if error.is_cancelled())
}

async fn wait_for_finalizing_sessions(
    sessions: Vec<(String, Arc<SessionState>)>,
    deadline: tokio::time::Instant,
) {
    loop {
        let unfinished: Vec<_> = sessions
            .iter()
            .filter(|(_, state)| !state.finished.load(Ordering::Acquire))
            .map(|(id, _)| id)
            .collect();
        if unfinished.is_empty() {
            return;
        }
        let now = tokio::time::Instant::now();
        if now >= deadline {
            for (id, _state) in sessions
                .iter()
                .filter(|(_, state)| !state.finished.load(Ordering::Acquire))
            {
                tracing::warn!(
                    recording_id = %id,
                    "由其他停止请求持有的录制任务收尾超时，将由进程退出并在下次启动时恢复"
                );
            }
            return;
        }
        tokio::time::sleep_until(std::cmp::min(deadline, now + Duration::from_millis(25))).await;
    }
}

fn finish_interrupted_session(state: &Arc<SessionState>, error: String) {
    finish_session_inner(
        state,
        TaskOutcome {
            status: RecordingStatus::Interrupted,
            error: Some(error),
            split: false,
        },
        true,
        true,
    );
}

/// 接管某个 worker 在正常任务收尾之前终止而遗留的媒体分片。
/// 这里要重新校验元数据路径，
/// 因为异步错误路径也会调用这个辅助函数。
fn salvage_temporary_media_after_worker_failure(state: &Arc<SessionState>) {
    let (recording_id, media_file) = {
        let stored = state
            .stored
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        (stored.id.clone(), stored.media_file.clone())
    };
    let relative = Path::new(&media_file);
    if !safe_relative_path(relative) {
        tracing::warn!(
            recording_id = %recording_id,
            media_file = %media_file,
            "异常终止录制的媒体路径无效，保留临时文件供启动恢复"
        );
        return;
    }
    let part = state.bundle.join(format!("{media_file}.part"));
    let final_path = state.bundle.join(relative);
    if !part.is_file() || final_path.exists() {
        return;
    }
    if let Err(error) = std::fs::rename(&part, &final_path) {
        tracing::warn!(
            recording_id = %recording_id,
            path = %part.display(),
            error = %error,
            "无法保存异常终止录制的临时文件"
        );
    }
}

fn create_split_segment(
    previous_state: &Arc<SessionState>,
    source_url: &str,
    room_dir: &str,
    storage_roots: &[PathBuf],
) -> AppResult<Arc<SessionState>> {
    ensure_sufficient_storage_space(&previous_state.root)?;
    let started_at = unix_ms();
    let previous = previous_state
        .stored
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone();
    // 切分是同一房间的新会话，因此仍在同一个房间目录之下，
    // 只需取新的 `username_starttime` 一级。
    let session_dir = format!(
        "{}_{}",
        sanitize_bundle_component(&previous.user_name, "未知用户", 120),
        recording_timestamp(started_at)
    );
    let (bundle, id) =
        create_recording_bundle(&previous_state.root, storage_roots, room_dir, &session_dir)?;
    let bundle_guard = BundleGuard::new(bundle.clone());
    let file_stem = recording_file_stem(&previous.user_name, &previous.title, started_at);
    let media_file = media_file_name(previous.protocol, source_url, &file_stem);
    let danmaku_writer = if previous.include_danmaku {
        Some(
            OpenOptions::new()
                .create(true)
                .append(true)
                .open(bundle.join("danmaku.jsonl"))
                .map_err(|error| {
                    AppError::new(
                        "recording_storage_error",
                        format!("创建分段弹幕轨文件失败: {error}"),
                    )
                })?,
        )
    } else {
        None
    };
    let stored = StoredRecording {
        id,
        status: RecordingStatus::Recording,
        started_at,
        ended_at: None,
        duration_ms: 0,
        size_bytes: 0,
        danmaku_count: 0,
        media_file,
        error: None,
        ..previous
    };
    write_metadata(&bundle, &stored)?;
    let state = Arc::new(SessionState {
        root: previous_state.root.clone(),
        bundle,
        stored: Mutex::new(stored.clone()),
        bytes: AtomicU64::new(0),
        duration_ms: AtomicU64::new(0),
        danmaku_count: AtomicU64::new(0),
        last_progress_event_ms: AtomicU64::new(0),
        danmaku_writer: Mutex::new(danmaku_writer),
        danmaku_closed: AtomicBool::new(false),
        finished: AtomicBool::new(false),
        finish_lock: Mutex::new(()),
        library: previous_state.library.clone(),
        events: previous_state.events.clone(),
    });
    state
        .library
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .upsert(&state.root, stored);
    bundle_guard.commit();
    Ok(state)
}

fn discard_unstarted_split_segment(state: &Arc<SessionState>) {
    let id = state
        .stored
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .id
        .clone();
    state
        .library
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(&state.root, &id);
    if let Err(error) = std::fs::remove_dir_all(&state.bundle) {
        tracing::warn!(
            recording_id = %id,
            path = %state.bundle.display(),
            error = %error,
            "停止录制时无法清理尚未开始的自动分段"
        );
    }
}

#[derive(Debug)]
struct TaskOutcome {
    status: RecordingStatus,
    error: Option<String>,
    split: bool,
}

async fn run_recording_task(
    stream_client: Client,
    source: PlayUrl,
    route: crate::proxy::ProxyRoute,
    ffmpeg_options: FfmpegRecordingOptions,
    state: Arc<SessionState>,
    cancel: watch::Receiver<bool>,
) -> TaskOutcome {
    match source.protocol {
        PlaybackProtocol::Flv | PlaybackProtocol::Hls | PlaybackProtocol::MpegTs => {
            run_ffmpeg_recording(source, route, ffmpeg_options, state, cancel).await
        }
        PlaybackProtocol::Native => {
            run_direct_recording(stream_client, source, state, cancel).await
        }
        PlaybackProtocol::Unknown => TaskOutcome {
            status: RecordingStatus::Failed,
            error: Some("无法识别录制源协议".into()),
            split: false,
        },
    }
}

async fn run_ffmpeg_recording(
    mut source: PlayUrl,
    route: crate::proxy::ProxyRoute,
    ffmpeg_options: FfmpegRecordingOptions,
    state: Arc<SessionState>,
    mut cancel: watch::Receiver<bool>,
) -> TaskOutcome {
    let twitch_recovery = source.twitch_ad_recovery.clone();
    let needs_twitch_warmup = source.protocol == PlaybackProtocol::Hls && twitch_recovery.is_some();
    // 系统/自定义代理统一由 reqwest 转发每个 URL，避免 libavformat 再读进程
    // no_proxy、忽略 HTTPS 代理，或把清单的代理/绕过规则错误继承给跨域分片。
    if !needs_twitch_warmup && !route.needs_recording_relay() {
        return ffmpeg_backend::run(source, route, ffmpeg_options, state, cancel).await;
    }

    let recording_id = state
        .stored
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .id
        .clone();
    let proxy_session_id = format!("recording:{recording_id}");
    let recording_proxy = crate::stream_proxy::StreamProxy::new();
    let local_url = match recording_proxy
        .start(
            source.url.clone(),
            source.headers.clone(),
            proxy_session_id.clone(),
            StreamProxyStartOptions {
                force_hls: source.protocol == PlaybackProtocol::Hls,
                route: &route,
                twitch_ad_recovery: twitch_recovery,
                ..Default::default()
            },
        )
        .await
    {
        Ok(url) => url,
        Err(error) => {
            return TaskOutcome {
                status: RecordingStatus::Failed,
                error: Some(format!("启动录制网络转发失败: {}", error.message)),
                split: false,
            };
        }
    };

    // `start` 只绑定回环监听器。要等到它真正开始提供带可读分片的播放列表后
    // 再让 ffmpeg 打开：解复用器只探测一次 URL，
    // 否则此刻的广告插播或过期 token 会让整场录制以
    // `Invalid data found when processing input` 失败，
    // 并且不留下任何媒体文件。
    //
    // 下面的 `None` 表示停止赢得了竞争。在此之前到达的取消会让 `changed()`
    // 无事可报，因此先直接读取标志位。
    let warmup = if *cancel.borrow() {
        None
    } else if !needs_twitch_warmup {
        Some(Ok(()))
    } else {
        tokio::select! {
            _ = cancel.changed() => None,
            result = recording_proxy.wait_for_playable_manifest(
                &local_url,
                &proxy_session_id,
                crate::stream_proxy::TWITCH_RECORDING_WARMUP_BUDGET,
            ) => Some(result),
        }
    };
    match warmup {
        Some(Ok(())) => {}
        Some(Err(error)) => {
            recording_proxy.stop_for_session(&proxy_session_id);
            return TaskOutcome {
                status: RecordingStatus::Failed,
                error: Some(format!("等待 Twitch 录制清单失败: {}", error.message)),
                split: false,
            };
        }
        None => {
            recording_proxy.stop_for_session(&proxy_session_id);
            return TaskOutcome {
                status: RecordingStatus::Interrupted,
                error: Some("录制在等待直播清单期间被停止".into()),
                split: false,
            };
        }
    }

    source.url = local_url;
    source.headers.clear();
    source.twitch_ad_recovery = None;
    // 所有远端请求已由本机 stream_proxy 按路由转发，FFmpeg 只连回环地址。
    let outcome = ffmpeg_backend::run(
        source,
        crate::proxy::ProxyRoute::Direct,
        ffmpeg_options,
        state,
        cancel,
    )
    .await;
    recording_proxy.stop_for_session(&proxy_session_id);
    outcome
}

async fn run_direct_recording(
    client: Client,
    source: PlayUrl,
    state: Arc<SessionState>,
    mut cancel: watch::Receiver<bool>,
) -> TaskOutcome {
    let media_file = state
        .stored
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .media_file
        .clone();
    let part = state.bundle.join(format!("{media_file}.part"));
    let final_path = state.bundle.join(media_file);
    let mut file = match tokio::fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&part)
        .await
    {
        Ok(file) => file,
        Err(error) => {
            return TaskOutcome {
                status: RecordingStatus::Failed,
                error: Some(format!("创建录制文件失败: {error}")),
                split: false,
            };
        }
    };
    let mut request = client
        .get(&source.url)
        .header(reqwest::header::ACCEPT_ENCODING, "identity")
        .header(reqwest::header::ACCEPT, "*/*");
    for (name, value) in &source.headers {
        request = request.header(name.as_str(), value.as_str());
    }
    let response = tokio::select! {
        response = request.send() => response,
        _ = cancel.changed() => {
            let _ = tokio::fs::remove_file(&part).await;
            return TaskOutcome {
                status: RecordingStatus::Completed,
                error: None,
                split: false,
            };
        }
    };
    let mut response = match response {
        Ok(response) if response.status().is_success() => response.bytes_stream(),
        Ok(response) => {
            let _ = tokio::fs::remove_file(&part).await;
            return TaskOutcome {
                status: RecordingStatus::Failed,
                error: Some(format!("录制源返回 HTTP {}", response.status().as_u16())),
                split: false,
            };
        }
        Err(error) => {
            let _ = tokio::fs::remove_file(&part).await;
            return TaskOutcome {
                status: RecordingStatus::Failed,
                error: Some(format!("连接录制源失败: {}", error.without_url())),
                split: false,
            };
        }
    };
    let started = Instant::now();
    let mut outcome = TaskOutcome {
        status: RecordingStatus::Completed,
        error: None,
        split: false,
    };
    let mut last_space_check = Instant::now() - STORAGE_SPACE_CHECK_INTERVAL;
    loop {
        if last_space_check.elapsed() >= STORAGE_SPACE_CHECK_INTERVAL {
            last_space_check = Instant::now();
            match available_storage_space(&state.bundle) {
                Ok(available) if storage_space_is_low(available) => {
                    outcome.status = RecordingStatus::Interrupted;
                    outcome.error = Some(format_storage_space_error(available));
                    break;
                }
                Ok(_) => {}
                Err(error) => {
                    tracing::warn!(path = %state.bundle.display(), error = %error, "无法检查录制剩余空间");
                }
            }
        }
        let next = tokio::select! {
            next = response.next() => next,
            _ = cancel.changed() => break,
        };
        let Some(next) = next else { break };
        let chunk = match next {
            Ok(chunk) => chunk,
            Err(error) => {
                outcome.status = if state.bytes.load(Ordering::Relaxed) == 0 {
                    RecordingStatus::Failed
                } else {
                    RecordingStatus::Interrupted
                };
                outcome.error = Some(format!("读取录制源中断: {}", error.without_url()));
                break;
            }
        };
        if chunk.is_empty() {
            continue;
        }
        if let Err(error) = file.write_all(&chunk).await {
            outcome.status = if state.bytes.load(Ordering::Relaxed) == 0 {
                RecordingStatus::Failed
            } else {
                RecordingStatus::Interrupted
            };
            outcome.error = Some(format!("写入录制文件失败: {error}"));
            break;
        }
        state.bytes.fetch_add(chunk.len() as u64, Ordering::Relaxed);
        state.duration_ms.store(
            started.elapsed().as_millis().min(u64::MAX as u128) as u64,
            Ordering::Relaxed,
        );
        state.emit_progress();
    }
    let flush_result = match file.flush().await {
        Ok(()) => file.sync_data().await,
        Err(error) => Err(error),
    };
    if let Err(error) = flush_result {
        outcome.status = if state.bytes.load(Ordering::Relaxed) == 0 {
            RecordingStatus::Failed
        } else {
            RecordingStatus::Interrupted
        };
        outcome.error = Some(format!("完成录制文件失败: {error}"));
    }
    drop(file);
    if state.bytes.load(Ordering::Relaxed) == 0 && outcome.status != RecordingStatus::Completed {
        let _ = tokio::fs::remove_file(&part).await;
        return outcome;
    }
    if final_path.exists()
        && let Err(error) = tokio::fs::remove_file(&final_path).await
    {
        outcome.status = RecordingStatus::Interrupted;
        outcome.error = Some(format!("替换录制文件失败: {error}"));
        return outcome;
    }
    if let Err(error) = tokio::fs::rename(&part, &final_path).await {
        outcome.status = RecordingStatus::Interrupted;
        outcome.error = Some(format!("保存录制文件失败: {error}"));
    }
    outcome
}

fn finish_session(state: &Arc<SessionState>, outcome: TaskOutcome) {
    finish_session_inner(state, outcome, false, true);
}

fn finish_split_segment(state: &Arc<SessionState>, outcome: TaskOutcome) {
    finish_session_inner(state, outcome, false, false);
}

fn finish_session_inner(
    state: &Arc<SessionState>,
    outcome: TaskOutcome,
    salvage_temporary_media: bool,
    release_background_danmaku: bool,
) {
    let _finish_guard = state
        .finish_lock
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if state.finished.load(Ordering::Acquire) {
        return;
    }
    if salvage_temporary_media {
        salvage_temporary_media_after_worker_failure(state);
    }
    // 在发布完成标志之前先关闭伴生文件。已经在途的分发回调要么在这把锁之前
    // 完成，要么观察到关闭标志而跳过，
    // 因此最终元数据计数保持稳定，
    // 也不会向 list() 暴露半写的元数据快照。
    state.danmaku_closed.store(true, Ordering::Release);
    let mut danmaku_writer = state
        .danmaku_writer
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(file) = danmaku_writer.as_mut() {
        let _ = file.flush();
        let _ = file.sync_data();
    }
    drop(danmaku_writer);
    let mut stored = state
        .stored
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    stored.status = outcome.status;
    stored.error = outcome.error;
    stored.ended_at = Some(unix_ms());
    stored.size_bytes = bundle_size(&state.bundle).max(state.bytes.load(Ordering::Relaxed));
    stored.duration_ms = state.duration_ms.load(Ordering::Relaxed);
    stored.danmaku_count = state.danmaku_count.load(Ordering::Relaxed);
    refresh_recording_metadata(&state.bundle, &mut stored);
    if let Err(error) = write_metadata(&state.bundle, &stored) {
        tracing::error!(
            recording_id = %stored.id,
            error = %error,
            "无法保存录制结束状态"
        );
        stored.status = RecordingStatus::Failed;
        stored.error = Some(match stored.error.take() {
            Some(previous) => format!("{previous}; 保存录制结束状态失败: {}", error.message),
            None => format!("保存录制结束状态失败: {}", error.message),
        });
        // 在上一个元数据文件被删除之后，rename 可能瞬时失败。再把失败状态持久化
        // 一次，避免重启时把这个会话误判为活动录制。
        if let Err(retry_error) = write_metadata(&state.bundle, &stored) {
            tracing::error!(
                recording_id = %stored.id,
                error = %retry_error,
                "重试保存录制失败状态仍未成功"
            );
        }
    }
    let recording_id = stored.id.clone();
    let status = stored.status.clone();
    let indexed = stored.clone();
    let background_danmaku_source =
        (stored.include_danmaku && stored.continue_on_leave).then(|| stored.source_key.clone());
    drop(stored);
    state
        .library
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .upsert(&state.root, indexed);
    state.finished.store(true, Ordering::Release);
    state.events.emit(&recording_id, status);
    if release_background_danmaku && let Some(source_key) = background_danmaku_source {
        state.events.release_background_danmaku(&source_key);
    }
}

fn stored_keeps_background_danmaku(stored: &StoredRecording, source_key: &str) -> bool {
    stored.status == RecordingStatus::Recording
        && stored.include_danmaku
        && stored.continue_on_leave
        && stored.source_key == source_key
}

fn validate_start_input(input: &RecordingStartInput) -> AppResult<()> {
    let url = Url::parse(input.source.url.trim())
        .map_err(|_| AppError::new("recording_invalid_url", "播放地址无效"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(AppError::new(
            "recording_invalid_url",
            "录制仅支持 HTTP(S) 播放地址",
        ));
    }
    if input.source_key.trim().is_empty() {
        return Err(AppError::new("recording_invalid_source", "缺少直播身份"));
    }
    Ok(())
}

fn validate_recording_source(
    protocol: PlaybackProtocol,
    source: &PlayUrl,
    route: &crate::proxy::ProxyRoute,
) -> AppResult<()> {
    if !matches!(
        protocol,
        PlaybackProtocol::Flv
            | PlaybackProtocol::Hls
            | PlaybackProtocol::MpegTs
            | PlaybackProtocol::Native
    ) {
        return Err(AppError::new(
            "recording_protocol_unsupported",
            "无法识别录制源协议",
        ));
    }
    for (name, value) in &source.headers {
        if name.trim().is_empty()
            || name.contains(['\0', '\r', '\n', ':'])
            || value.contains(['\0', '\r', '\n'])
        {
            return Err(AppError::new(
                "recording_headers_invalid",
                "直播源请求头无法传递给 Rust FFmpeg 后端",
            ));
        }
    }
    // 自定义地址在这里预校验：格式错误的代理不得留下看似活动录制、
    // 却没有任务挂载的元数据。系统代理与直连由路由解析保证可用性。
    if let crate::proxy::ProxyRoute::Custom(proxy) = route
        && (!matches!(
            Url::parse(proxy).map(|url| url.scheme().to_owned()),
            Ok(ref scheme) if matches!(scheme.as_str(), "http" | "https")
        ) || proxy.contains(['\0', '\r', '\n']))
    {
        return Err(AppError::new(
            "recording_proxy_unsupported",
            "录制网络转发仅支持 HTTP(S) 代理",
        ));
    }
    Ok(())
}

fn media_file_name(protocol: PlaybackProtocol, source_url: &str, file_stem: &str) -> String {
    match protocol {
        PlaybackProtocol::MpegTs => format!("{file_stem}.ts"),
        PlaybackProtocol::Native => {
            let path = Url::parse(source_url)
                .ok()
                .map(|url| url.path().to_ascii_lowercase());
            if path
                .as_deref()
                .is_some_and(|value| value.ends_with(".webm"))
            {
                format!("{file_stem}.webm")
            } else {
                format!("{file_stem}.mp4")
            }
        }
        _ => format!("{file_stem}.flv"),
    }
}

fn recording_file_stem(user_name: &str, title: &str, started_at: i64) -> String {
    let user = sanitize_filename_component(user_name, "未知用户");
    let title = sanitize_filename_component(title, "未命名直播");
    let timestamp = recording_timestamp(started_at);
    format!("{user}_{title}_{timestamp}")
}

/// 外层分卷层级：同一房间的每个会话都落在 `platform_roomid` 之下。
fn recording_bundle_room_dir(input: &RecordingStartInput) -> String {
    let platform = input
        .site_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(&input.source_kind);
    let room = input
        .room_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            input
                .source_key
                .rsplit(':')
                .find(|value| !value.trim().is_empty())
        })
        .unwrap_or(&input.title);
    format!(
        "{}_{}",
        sanitize_bundle_component(platform, "live", 48),
        sanitize_bundle_component(room, "room", 160)
    )
}

/// 内层分卷层级：一次录制会话，命名为 `username_starttime`。时间戳与媒体
/// 文件名携带的 `recording_timestamp` 相同，
/// 因此会话目录与其中的文件相互对应。
fn recording_bundle_session_dir(input: &RecordingStartInput, started_at: i64) -> String {
    format!(
        "{}_{}",
        sanitize_bundle_component(&input.user_name, "未知用户", 120),
        recording_timestamp(started_at)
    )
}

/// 创建 `<root>/<room_dir>/<session_dir>/` 并返回绝对分卷路径及其 id，
/// id 即该分卷相对于 `root` 的路径。
///
/// 房间层级由该房间的所有会话共享，因此只有会话层级
/// 在两场录制同一秒内开始时追加后缀。
fn create_recording_bundle(
    root: &Path,
    known_roots: &[PathBuf],
    room_dir: &str,
    session_dir: &str,
) -> AppResult<(PathBuf, String)> {
    if !is_safe_bundle_segment(room_dir) || !is_safe_bundle_segment(session_dir) {
        return Err(AppError::new("recording_storage_error", "录制目录名称无效"));
    }
    let room_root = root.join(room_dir);
    std::fs::create_dir_all(&room_root).map_err(|error| {
        AppError::new(
            "recording_storage_error",
            format!("创建录制空间失败: {error}"),
        )
    })?;
    for sequence in 0..10_000_u32 {
        let name = match sequence {
            0 => session_dir.to_string(),
            _ => format!("{session_dir}_{sequence}"),
        };
        let id = format!("{room_dir}/{name}");
        if !is_safe_recording_id(&id) {
            return Err(AppError::new("recording_storage_error", "录制目录名称无效"));
        }
        // 录制通过这个相对 id 寻址，所以它在每个已配置的存储根中都必须可用，
        // 而不仅仅是在当前写入的这个根里。
        if known_roots
            .iter()
            .any(|known_root| known_root.join(&id).exists())
        {
            continue;
        }
        let bundle = room_root.join(&name);
        match std::fs::create_dir(&bundle) {
            Ok(()) => return Ok((bundle, id)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(AppError::new(
                    "recording_storage_error",
                    format!("创建录制空间失败: {error}"),
                ));
            }
        }
    }
    Err(AppError::new(
        "recording_storage_error",
        format!("无法为 {room_dir}/{session_dir} 分配不重复的录制目录"),
    ))
}

fn sanitize_bundle_component(value: &str, fallback: &str, max_bytes: usize) -> String {
    let sanitized = sanitize_filename_component(value, fallback);
    let mut bounded = String::new();
    for character in sanitized.chars() {
        if bounded.len() + character.len_utf8() > max_bytes {
            break;
        }
        bounded.push(character);
    }
    if bounded.is_empty() {
        fallback.to_string()
    } else {
        bounded
    }
}

fn recording_timestamp(timestamp_ms: i64) -> String {
    Local
        .timestamp_millis_opt(timestamp_ms)
        .single()
        .map(|value| value.format("%Y%m%d-%H%M%S").to_string())
        .unwrap_or_else(|| timestamp_ms.to_string())
}

fn sanitize_filename_component(value: &str, fallback: &str) -> String {
    let mut sanitized: String = value
        .chars()
        .map(|character| {
            if character.is_control()
                || matches!(
                    character,
                    '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
                )
            {
                '_'
            } else {
                character
            }
        })
        .take(80)
        .collect();
    sanitized = sanitized.trim().trim_matches('.').to_string();
    if sanitized.is_empty() {
        fallback.to_string()
    } else {
        sanitized
    }
}

fn normalize_text(value: &str, fallback: &str) -> String {
    let value = value.trim();
    if value.is_empty() {
        fallback.to_string()
    } else {
        value.chars().take(240).collect()
    }
}

fn optional_text(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let value = value.trim().to_string();
        (!value.is_empty()).then_some(value)
    })
}

fn unix_ms() -> i64 {
    Utc::now().timestamp_millis()
}

/// 校验录制 id，它同时也是相对于某个存储根的路径。
///
/// id 恰好有两段 —— `<platform>_<room>/<user>_<timestamp>` —— 因此一个房间
/// 把它所有会话归为一组。这是防止逃出存储根的唯一守卫，
/// 所以任何不是两个普通名字的内容都会被拒绝：
/// `..`、绝对路径、空段或仅含点的段，
/// 以及除连接两级的单个 `/` 之外的分隔符。
fn is_safe_recording_id(id: &str) -> bool {
    if id.is_empty()
        || id.len() > 360
        || id.trim() != id
        || id.chars().any(|character| {
            character.is_control()
                || matches!(character, '<' | '>' | ':' | '"' | '\\' | '|' | '?' | '*')
        })
    {
        return false;
    }
    let Some((room_dir, session_dir)) = id.split_once('/') else {
        return false;
    };
    if !is_safe_bundle_segment(room_dir) || !is_safe_bundle_segment(session_dir) {
        return false;
    }
    // 房间层级保持 `<platform>_<room>` 形态，库正是按它分组。
    let Some((platform, room)) = room_dir.split_once('_') else {
        return false;
    };
    if platform.is_empty() || room.is_empty() {
        return false;
    }
    // 双保险：解析后的形式必须仍然恰好是两个普通组件，
    // 确保没有 `.`/`..`/前缀绕过文本层面的检查。
    let mut components = Path::new(id).components();
    matches!(components.next(), Some(Component::Normal(_)))
        && matches!(components.next(), Some(Component::Normal(_)))
        && components.next().is_none()
}

/// 分卷路径中的一级：只能是普通目录名，不能有其他内容。
fn is_safe_bundle_segment(segment: &str) -> bool {
    !segment.is_empty()
        && segment.trim() == segment
        && !segment.ends_with('.')
        && !segment.contains('/')
        && segment != "."
        && segment != ".."
}

fn acquire_recording_manager_lock(app_directory: &Path) -> AppResult<File> {
    std::fs::create_dir_all(app_directory).map_err(|error| {
        AppError::new(
            "recording_storage_error",
            format!("创建应用数据目录失败: {error}"),
        )
    })?;
    let path = app_directory.join(RECORDING_MANAGER_LOCK_FILE);
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(&path)
        .map_err(|error| {
            AppError::new(
                "recording_storage_error",
                format!("打开录制管理锁失败: {error}"),
            )
        })?;
    match file.try_lock() {
        Ok(()) => {}
        Err(std::fs::TryLockError::WouldBlock) => {
            return Err(AppError::new(
                "recording_already_running",
                "另一个 rLive 实例正在管理录制任务",
            ));
        }
        Err(std::fs::TryLockError::Error(error)) => {
            return Err(AppError::new(
                "recording_storage_error",
                format!("锁定录制管理器失败: {error}"),
            ));
        }
    }
    file.set_len(0).map_err(|error| {
        AppError::new(
            "recording_storage_error",
            format!("更新录制管理锁失败: {error}"),
        )
    })?;
    file.seek(SeekFrom::Start(0)).map_err(|error| {
        AppError::new(
            "recording_storage_error",
            format!("更新录制管理锁失败: {error}"),
        )
    })?;
    file.write_all(std::process::id().to_string().as_bytes())
        .and_then(|_| file.flush())
        .map_err(|error| {
            AppError::new(
                "recording_storage_error",
                format!("更新录制管理锁失败: {error}"),
            )
        })?;
    Ok(file)
}

fn load_storage_state(app_directory: &Path) -> AppResult<RecordingStorageState> {
    let default_root = prepare_storage_root(&app_directory.join(RECORDINGS_DIRECTORY))?;
    let config_path = app_directory.join(RECORDING_STORAGE_CONFIG_FILE);
    crate::app_paths::recover_recoverable_file(&config_path, valid_recording_storage_config)
        .map_err(|error| {
            AppError::new(
                "recording_storage_error",
                format!("恢复录制目录设置失败: {error}"),
            )
        })?;
    let config = match std::fs::read(&config_path) {
        Ok(bytes) => {
            let config =
                serde_json::from_slice::<RecordingStorageConfig>(&bytes).map_err(|error| {
                    AppError::new(
                        "recording_storage_error",
                        format!("录制目录设置已损坏或版本不受支持: {error}"),
                    )
                })?;
            if config.schema_version != RECORDING_STORAGE_CONFIG_VERSION {
                return Err(AppError::new(
                    "recording_storage_error",
                    format!(
                        "录制目录设置版本 {} 不受支持，当前版本为 {}",
                        config.schema_version, RECORDING_STORAGE_CONFIG_VERSION
                    ),
                ));
            }
            config
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            RecordingStorageConfig::default()
        }
        Err(error) => {
            return Err(AppError::new(
                "recording_storage_error",
                format!("读取录制目录设置失败: {error}"),
            ));
        }
    };

    let mut history = Vec::new();
    for path in config.known_paths {
        let path = PathBuf::from(path);
        if !path.is_absolute() || path == default_root {
            continue;
        }
        let normalized = std::fs::canonicalize(&path).unwrap_or(path);
        push_unique_path(&mut history, normalized);
    }

    let current_root = match config.current_path {
        Some(path) => {
            let candidate = PathBuf::from(path);
            if candidate.is_absolute() {
                prepare_storage_root(&candidate).unwrap_or_else(|error| {
                    tracing::warn!(path = %candidate.display(), error = %error, "录制保存位置不可用，已回退默认目录");
                    default_root.clone()
                })
            } else {
                default_root.clone()
            }
        }
        None => default_root.clone(),
    };
    if current_root != default_root {
        push_unique_path(&mut history, current_root.clone());
    }
    let roots = ordered_roots(&current_root, &default_root, &history);
    Ok(RecordingStorageState {
        default_root,
        current_root,
        roots,
        history,
        config_path,
    })
}

fn valid_recording_storage_config(bytes: &[u8]) -> bool {
    serde_json::from_slice::<RecordingStorageConfig>(bytes)
        .is_ok_and(|config| config.schema_version == RECORDING_STORAGE_CONFIG_VERSION)
}

fn prepare_storage_root(path: &Path) -> AppResult<PathBuf> {
    if path.as_os_str().is_empty() || !path.is_absolute() {
        return Err(AppError::new(
            "recording_storage_path_invalid",
            "录制保存位置必须是绝对目录",
        ));
    }
    // 文件系统根目录对录制库来说过于宽泛，
    // 几乎总是目录选择器的误选结果。
    if path.parent().is_none() {
        return Err(AppError::new(
            "recording_storage_path_invalid",
            "不能将文件系统根目录作为录制保存位置",
        ));
    }
    std::fs::create_dir_all(path).map_err(|error| {
        AppError::new(
            "recording_storage_error",
            format!("创建录制目录失败: {error}"),
        )
    })?;
    let root = std::fs::canonicalize(path).map_err(|error| {
        AppError::new(
            "recording_storage_error",
            format!("解析录制目录失败: {error}"),
        )
    })?;
    if root.parent().is_none() {
        return Err(AppError::new(
            "recording_storage_path_invalid",
            "不能将文件系统根目录作为录制保存位置",
        ));
    }
    if !root.is_dir() {
        return Err(AppError::new(
            "recording_storage_path_invalid",
            "录制保存位置不是目录",
        ));
    }
    let probe = root.join(format!(".rlive-write-test-{}", Uuid::new_v4().simple()));
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&probe)
        .map_err(|error| {
            AppError::new(
                "recording_storage_error",
                format!("录制目录不可写: {error}"),
            )
        })?;
    file.write_all(b"ok").map_err(|error| {
        AppError::new(
            "recording_storage_error",
            format!("录制目录不可写: {error}"),
        )
    })?;
    drop(file);
    let _ = std::fs::remove_file(probe);
    Ok(root)
}

fn migrate_recording_bundles(from: &Path, to: &Path) -> AppResult<Vec<(PathBuf, PathBuf)>> {
    let mut moved = Vec::new();
    // 分卷位于两级之下，因此移动由 id 驱动，
    // 并在需要时于目标根下重建房间层级。
    let candidates = list_bundle_candidates(from).map_err(|error| {
        AppError::new(
            "recording_storage_error",
            format!("读取原录制目录失败: {}", error.message),
        )
    })?;
    for (id, source) in candidates {
        let id = id.as_str();
        let metadata_path = source.join("metadata.json");
        let metadata = match read_metadata_bytes(&metadata_path) {
            Ok(bytes) => bytes,
            Err(error) => {
                tracing::warn!(
                    path = %source.display(),
                    error = %error,
                    "目录切换时跳过无法读取的录制 metadata"
                );
                continue;
            }
        };
        let stored = match parse_stored_recording(&metadata) {
            Ok(stored) => stored,
            Err(error) => {
                tracing::warn!(
                    path = %source.display(),
                    error = %error,
                    "目录切换时跳过版本不受支持或已损坏的录制 metadata"
                );
                continue;
            }
        };
        if stored.id != id {
            tracing::warn!(
                path = %source.display(),
                metadata_id = %stored.id,
                "目录切换时跳过 metadata 标识与目录不一致的录制"
            );
            continue;
        }
        let target = to.join(id);
        if target.exists() {
            rollback_recording_bundles(&moved);
            return Err(AppError::new(
                "recording_storage_conflict",
                format!("目标录制目录已存在: {}", target.display()),
            ));
        }
        // 目标根下可能还没有房间层级。在 rename 之前创建它，
        // 让每次移动对单个分卷而言都是一步原子操作。
        if let Some(parent) = target.parent()
            && let Err(error) = std::fs::create_dir_all(parent)
        {
            rollback_recording_bundles(&moved);
            return Err(AppError::new(
                "recording_storage_error",
                format!("创建目标录制目录失败 {}: {error}", parent.display()),
            ));
        }
        if let Err(error) = std::fs::rename(&source, &target) {
            rollback_recording_bundles(&moved);
            return Err(AppError::new(
                "recording_storage_error",
                format!("迁移录制目录失败 {}: {error}", source.display()),
            ));
        }
        moved.push((source, target));
    }
    Ok(moved)
}

fn rollback_recording_bundles(moved: &[(PathBuf, PathBuf)]) {
    for (source, target) in moved.iter().rev() {
        if let Err(error) = std::fs::rename(target, source) {
            tracing::error!(source = %source.display(), target = %target.display(), error = %error, "回滚录制目录迁移失败");
        }
    }
}

fn push_unique_path(paths: &mut Vec<PathBuf>, path: PathBuf) {
    if !paths.iter().any(|candidate| candidate == &path) {
        paths.push(path);
    }
}

fn ordered_roots(current: &Path, default_root: &Path, history: &[PathBuf]) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    push_unique_path(&mut roots, current.to_path_buf());
    push_unique_path(&mut roots, default_root.to_path_buf());
    for path in history {
        push_unique_path(&mut roots, path.clone());
    }
    roots
}

fn write_storage_config(storage: &RecordingStorageState) -> AppResult<()> {
    let config = RecordingStorageConfig {
        schema_version: RECORDING_STORAGE_CONFIG_VERSION,
        current_path: (storage.current_root != storage.default_root)
            .then(|| crate::app_paths::path_to_string(&storage.current_root)),
        known_paths: storage
            .history
            .iter()
            .filter(|path| **path != storage.default_root)
            .map(|path| crate::app_paths::path_to_string(path))
            .collect(),
    };
    let bytes = serde_json::to_vec_pretty(&config)
        .map_err(|error| AppError::new("recording_storage_error", error.to_string()))?;
    crate::app_paths::write_recoverable_file(
        &storage.config_path,
        &bytes,
        valid_recording_storage_config,
    )
    .map_err(|error| {
        AppError::new(
            "recording_storage_error",
            format!("保存录制目录设置失败: {error}"),
        )
    })
}

/// 定位一场录制，并报告它位于哪个存储根。
///
/// 返回根目录而不是从分卷推导：一个 id 跨越两级路径，
/// `bundle.parent()` 是房间目录而不是存储根。
fn find_bundle_in_root(roots: &[PathBuf], id: &str) -> Option<(PathBuf, PathBuf)> {
    if !is_safe_recording_id(id) {
        return None;
    }
    roots.iter().find_map(|root| {
        let bundle = root.join(id);
        let metadata = bundle.join("metadata.json");
        let bytes = read_metadata_bytes(&metadata).ok()?;
        let stored = parse_stored_recording(&bytes).ok()?;
        (stored.id == id && bundle.is_dir()).then(|| (root.clone(), bundle))
    })
}

fn find_stored(roots: &[PathBuf], id: &str) -> AppResult<(PathBuf, StoredRecording)> {
    let (root, _bundle) = find_bundle_in_root(roots, id)
        .ok_or_else(|| AppError::new("recording_not_found", "录制不存在"))?;
    let stored = read_stored(&root, id)?;
    Ok((root, stored))
}

fn write_metadata(bundle: &Path, stored: &StoredRecording) -> AppResult<()> {
    let _write_guard = METADATA_IO_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let path = bundle.join("metadata.json");
    let bytes = serde_json::to_vec_pretty(stored)
        .map_err(|error| AppError::new("recording_metadata_error", error.to_string()))?;
    write_bundle_file_sync(&path, &bytes).map_err(|error| {
        AppError::new(
            "recording_metadata_error",
            format!("保存录制信息失败: {error}"),
        )
    })
}

fn read_metadata_bytes(path: &Path) -> std::io::Result<Vec<u8>> {
    let _read_guard = METADATA_IO_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    std::fs::read(path)
}

fn write_bundle_file_sync(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    write_bundle_file_with_sync(path, |file| {
        file.write_all(bytes)?;
        Ok(Some(()))
    })?;
    Ok(())
}

/// 经由同级的临时文件写入，仅当 `write` 返回 `Some` 时才发布。
/// `None` 是刻意的放弃，供空的 ASS 导出使用。
fn write_bundle_file_with_sync<T>(
    path: &Path,
    write: impl FnOnce(&mut File) -> std::io::Result<Option<T>>,
) -> std::io::Result<Option<T>> {
    let Some(file_name) = path.file_name().and_then(|value| value.to_str()) else {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "录制文件名无效",
        ));
    };
    let temporary = path.with_file_name(format!("{file_name}.tmp"));
    let backup = path.with_file_name(format!("{file_name}.bak"));
    let _ = std::fs::remove_file(&temporary);
    if backup.exists() {
        if path.exists() {
            std::fs::remove_file(&backup)?;
        } else {
            std::fs::rename(&backup, path)?;
        }
    }

    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)?;
    let result = match write(&mut file) {
        Ok(Some(result)) => result,
        Ok(None) => {
            drop(file);
            let _ = std::fs::remove_file(&temporary);
            return Ok(None);
        }
        Err(error) => {
            drop(file);
            let _ = std::fs::remove_file(&temporary);
            return Err(error);
        }
    };
    if let Err(error) = file.flush().and_then(|_| file.sync_data()) {
        drop(file);
        let _ = std::fs::remove_file(&temporary);
        return Err(error);
    }
    drop(file);

    let had_target = path.exists();
    if had_target && let Err(error) = std::fs::rename(path, &backup) {
        let _ = std::fs::remove_file(&temporary);
        return Err(error);
    }
    match std::fs::rename(&temporary, path) {
        Ok(()) => {
            let _ = std::fs::remove_file(&backup);
            Ok(Some(result))
        }
        Err(error) => {
            if had_target && let Err(rollback_error) = std::fs::rename(&backup, path) {
                return Err(std::io::Error::new(
                    error.kind(),
                    format!("发布录制文件失败: {error}; 恢复原文件失败: {rollback_error}"),
                ));
            }
            Err(error)
        }
    }
}

fn transaction_sidecars(path: &Path) -> std::io::Result<(PathBuf, PathBuf)> {
    let Some(file_name) = path.file_name().and_then(|value| value.to_str()) else {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "录制文件名无效",
        ));
    };
    Ok((
        path.with_file_name(format!("{file_name}.tmp")),
        path.with_file_name(format!("{file_name}.bak")),
    ))
}

fn recover_transaction_sidecars(
    target: &Path,
    validate_temporary: impl FnOnce(&[u8]) -> bool,
) -> std::io::Result<()> {
    let (temporary, backup) = transaction_sidecars(target)?;
    let temporary_bytes = match std::fs::read(&temporary) {
        Ok(bytes) => Some(bytes),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error),
    };
    let temporary_is_valid = temporary_bytes.as_deref().is_some_and(validate_temporary);

    if temporary_is_valid {
        if target.exists() {
            if backup.exists() {
                std::fs::remove_file(&backup)?;
            }
            std::fs::rename(target, &backup)?;
        }
        match std::fs::rename(&temporary, target) {
            Ok(()) => {
                if backup.exists() {
                    std::fs::remove_file(backup)?;
                }
                return Ok(());
            }
            Err(error) => {
                if !target.exists()
                    && backup.exists()
                    && let Err(rollback_error) = std::fs::rename(&backup, target)
                {
                    return Err(std::io::Error::new(
                        error.kind(),
                        format!("恢复录制临时文件失败: {error}; 回滚备份失败: {rollback_error}"),
                    ));
                }
                return Err(error);
            }
        }
    }

    if target.exists() {
        if backup.exists() {
            std::fs::remove_file(&backup)?;
        }
    } else if backup.exists() {
        std::fs::rename(&backup, target)?;
    }
    if temporary_bytes.is_some() {
        std::fs::remove_file(temporary)?;
    }
    Ok(())
}

/// 仅当元数据替换属于本分卷时才接受。
///
/// id 同时跨越分卷的两级，因此要与房间目录和会话目录一起匹配，
/// 而不是只与分卷自身的名字匹配。
fn valid_metadata_replacement(bytes: &[u8], bundle: &Path) -> bool {
    let Ok(stored) = parse_stored_recording(bytes) else {
        return false;
    };
    is_safe_recording_id(&stored.id) && bundle.ends_with(&stored.id)
}

fn recover_bundle_sidecars(bundle: &Path) -> std::io::Result<()> {
    let metadata = bundle.join("metadata.json");
    {
        let _metadata_guard = METADATA_IO_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        recover_transaction_sidecars(&metadata, |bytes| valid_metadata_replacement(bytes, bundle))?;
    }

    let stored = std::fs::read(&metadata)
        .ok()
        .and_then(|bytes| parse_stored_recording(&bytes).ok());
    if let Some(stored) = stored.as_ref()
        && !safe_relative_path(Path::new(&stored.media_file))
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "录制媒体路径无效",
        ));
    }
    Ok(())
}

fn recording_root_modified_at(root: &Path) -> Option<SystemTime> {
    std::fs::metadata(root)
        .and_then(|metadata| metadata.modified())
        .ok()
}

/// 列出某个存储根下的全部 `<room_dir>/<session_dir>` 为 `(id, path)`。
///
/// 恢复流程使用它，需要 id 与目录并存。两级无法构成有效 id 的条目会被跳过，
/// 因此游离目录或嵌套布局之前的单级分卷会被忽略，
/// 而不会被当作一场录制。
fn list_bundle_candidates(root: &Path) -> AppResult<Vec<(String, PathBuf)>> {
    let room_entries = std::fs::read_dir(root)
        .map_err(|error| AppError::new("recording_storage_error", error.to_string()))?;
    let mut candidates = Vec::new();
    for room_entry in room_entries {
        let Ok(room_entry) = room_entry else { continue };
        let room_path = room_entry.path();
        if !room_path.is_dir() {
            continue;
        }
        let room_name = room_entry.file_name().to_string_lossy().to_string();
        let Ok(session_entries) = std::fs::read_dir(&room_path) else {
            continue;
        };
        for session_entry in session_entries {
            let Ok(session_entry) = session_entry else {
                continue;
            };
            let path = session_entry.path();
            if !path.is_dir() {
                continue;
            }
            let session_name = session_entry.file_name().to_string_lossy().to_string();
            let id = format!("{room_name}/{session_name}");
            if !is_safe_recording_id(&id) {
                continue;
            }
            candidates.push((id, path));
        }
    }
    Ok(candidates)
}

/// 扫描 `<root>/<room_dir>/<session_dir>/metadata.json`。
///
/// 分卷位于两级之下，因此外层循环遍历房间目录，内层遍历其会话。
/// 在此布局之前写入的单级目录没有会话层级，自然不会被找到。
fn scan_recording_root(root: &Path) -> HashMap<String, StoredRecording> {
    let mut recordings = HashMap::new();
    let Ok(room_entries) = std::fs::read_dir(root) else {
        return recordings;
    };
    for room_entry in room_entries {
        let Ok(room_entry) = room_entry else { continue };
        let room_path = room_entry.path();
        if !room_path.is_dir() {
            continue;
        }
        let Ok(session_entries) = std::fs::read_dir(&room_path) else {
            continue;
        };
        for session_entry in session_entries {
            let Ok(session_entry) = session_entry else {
                continue;
            };
            let path = session_entry.path();
            if !path.is_dir() {
                continue;
            }
            let bytes = match read_metadata_bytes(&path.join("metadata.json")) {
                Ok(bytes) => bytes,
                Err(error) => {
                    tracing::warn!(
                        path = %path.display(),
                        error = %error,
                        "跳过无法读取的录制 metadata"
                    );
                    continue;
                }
            };
            let stored = match parse_stored_recording(&bytes) {
                Ok(stored) => stored,
                Err(error) => {
                    tracing::warn!(
                        path = %path.display(),
                        error = %error,
                        "跳过版本不受支持或已损坏的录制 metadata"
                    );
                    continue;
                }
            };
            // `Path::ends_with` 按完整组件比较，因此两段的 id
            // 仍必须与房间和会话目录精确匹配。
            if !is_safe_recording_id(&stored.id) || !path.ends_with(&stored.id) {
                continue;
            }
            recordings.insert(stored.id.clone(), stored);
        }
    }
    recordings
}

fn read_stored(root: &Path, id: &str) -> AppResult<StoredRecording> {
    let path = root.join(id).join("metadata.json");
    let bytes = read_metadata_bytes(&path)
        .map_err(|_| AppError::new("recording_not_found", "录制不存在"))?;
    parse_stored_recording(&bytes).map_err(|error| {
        AppError::new(
            "recording_metadata_error",
            format!("录制信息损坏或版本不受支持: {error}"),
        )
    })
}

fn append_recovery_error(stored: &mut StoredRecording, message: impl Into<String>) {
    let message = message.into();
    stored.error = Some(match stored.error.take() {
        Some(previous) if !previous.is_empty() => format!("{previous}; {message}"),
        _ => message,
    });
}

fn recover_stale_recordings(root: &Path) -> AppResult<()> {
    for (id, path) in list_bundle_candidates(root)? {
        let metadata_path = path.join("metadata.json");
        if let Ok(bytes) = read_metadata_bytes(&metadata_path)
            && let Err(error) = parse_stored_recording(&bytes)
        {
            tracing::warn!(
                recording_id = %id,
                error = %error,
                "跳过版本不受支持或已损坏的录制 metadata"
            );
            continue;
        }
        let sidecar_error = recover_bundle_sidecars(&path).err();
        let mut stored = match read_stored(root, &id) {
            Ok(stored) => stored,
            Err(error) => {
                if error.code == "recording_metadata_error" {
                    tracing::warn!(
                        recording_id = %id,
                        error = %error.message,
                        "跳过版本不受支持的录制 metadata"
                    );
                    continue;
                }
                if let Some(sidecar_error) = sidecar_error {
                    return Err(AppError::new(
                        "recording_recovery_error",
                        format!(
                            "恢复录制 {id} 的替换文件失败: {sidecar_error}; 无法读取 metadata: {}",
                            error.message
                        ),
                    ));
                }
                tracing::warn!(recording_id = %id, error = %error, "跳过无法读取的录制目录");
                continue;
            }
        };
        if stored.id != id {
            tracing::warn!(
                recording_id = %id,
                metadata_id = %stored.id,
                "跳过 metadata 标识与目录不一致的录制"
            );
            continue;
        }
        let was_recording = stored.status == RecordingStatus::Recording;
        let media_relative = Path::new(&stored.media_file);
        if !safe_relative_path(media_relative) {
            append_recovery_error(&mut stored, "录制媒体路径无效");
            if was_recording {
                stored.status = RecordingStatus::Interrupted;
                stored.ended_at = Some(unix_ms());
            }
            refresh_recording_metadata(&path, &mut stored);
            write_metadata(&path, &stored).map_err(|error| {
                AppError::new(
                    "recording_recovery_error",
                    format!("保存录制 {id} 的恢复状态失败: {}", error.message),
                )
            })?;
            continue;
        }
        let part = path.join(format!("{}.part", media_relative.display()));
        let final_path = path.join(media_relative);
        let has_orphan_part = part.is_file() && !final_path.is_file();
        if !was_recording && !has_orphan_part {
            if let Some(error) = sidecar_error {
                tracing::warn!(recording_id = %id, error = %error, "历史录制的临时替换文件恢复失败");
            }
            continue;
        }
        if let Some(error) = sidecar_error {
            append_recovery_error(&mut stored, format!("恢复临时替换文件失败: {error}"));
        }
        if has_orphan_part && let Err(error) = std::fs::rename(&part, &final_path) {
            append_recovery_error(&mut stored, format!("恢复临时媒体失败: {error}"));
        }
        if !final_path.is_file() {
            append_recovery_error(&mut stored, "录制媒体文件缺失");
        }
        if was_recording || has_orphan_part && final_path.is_file() {
            stored.status = RecordingStatus::Interrupted;
            if stored.ended_at.is_none() {
                stored.ended_at = Some(unix_ms());
            }
        }
        refresh_recording_metadata(&path, &mut stored);
        write_metadata(&path, &stored).map_err(|error| {
            AppError::new(
                "recording_recovery_error",
                format!("保存录制 {id} 的恢复状态失败: {}", error.message),
            )
        })?;
    }
    Ok(())
}

fn refresh_recording_metadata(bundle: &Path, stored: &mut StoredRecording) {
    stored.size_bytes = bundle_size(bundle);
    let media_relative = Path::new(&stored.media_file);
    if safe_relative_path(media_relative) {
        let media = bundle.join(media_relative);
        if media.is_file()
            && let Ok(duration_ms) = ffmpeg_backend::probe_media_duration(&media)
        {
            stored.duration_ms = duration_ms;
        }
    }
    if let Some(count) = count_recorded_danmaku(bundle, stored) {
        stored.danmaku_count = count;
    }
}

fn count_recorded_danmaku(bundle: &Path, stored: &StoredRecording) -> Option<u64> {
    let relative = stored.danmaku_file.as_deref().map(Path::new)?;
    if !safe_relative_path(relative) {
        return None;
    }
    let file = File::open(bundle.join(relative)).ok()?;
    let mut count = 0_u64;
    for line in BufReader::new(file).lines() {
        let Ok(line) = line else { break };
        if let Ok(batch) = serde_json::from_str::<StoredDanmakuBatchOwned>(&line) {
            count = count.saturating_add(batch.events.len() as u64);
        }
    }
    Some(count)
}

#[derive(Debug, Deserialize)]
struct StoredDanmakuBatchOwned {
    events: Vec<DanmakuEvent>,
}

fn available_storage_space(path: &Path) -> std::io::Result<u64> {
    fs2::available_space(path)
}

fn ensure_sufficient_storage_space(root: &Path) -> AppResult<()> {
    let available = available_storage_space(root).map_err(|error| {
        AppError::new(
            "recording_storage_space_unavailable",
            format!("无法读取录制磁盘剩余空间: {error}"),
        )
    })?;
    if storage_space_is_low(available) {
        return Err(AppError::new(
            "recording_storage_low",
            format_storage_space_error(available),
        ));
    }
    Ok(())
}

fn storage_space_is_low(available: u64) -> bool {
    available < MINIMUM_FREE_SPACE_BYTES
}

fn format_storage_space_error(available: u64) -> String {
    format!(
        "录制磁盘剩余空间不足（当前 {}，至少需要保留 {}）",
        format_storage_bytes(available),
        format_storage_bytes(MINIMUM_FREE_SPACE_BYTES)
    )
}

fn format_storage_bytes(bytes: u64) -> String {
    const GIB: f64 = 1024.0 * 1024.0 * 1024.0;
    const MIB: f64 = 1024.0 * 1024.0;
    if bytes as f64 >= GIB {
        format!("{:.1} GB", bytes as f64 / GIB)
    } else {
        format!("{:.1} MB", bytes as f64 / MIB)
    }
}

fn bundle_size(path: &Path) -> u64 {
    let Ok(entries) = walkdir(path) else { return 0 };
    entries
        .into_iter()
        .filter_map(|entry| entry.metadata().ok())
        .filter(|metadata| metadata.is_file())
        .map(|metadata| metadata.len())
        .sum()
}

fn walkdir(path: &Path) -> std::io::Result<Vec<std::fs::DirEntry>> {
    let mut out = Vec::new();
    fn visit(path: &Path, out: &mut Vec<std::fs::DirEntry>) -> std::io::Result<()> {
        for entry in std::fs::read_dir(path)? {
            let entry = entry?;
            if entry.path().is_dir() {
                visit(&entry.path(), out)?;
            } else {
                out.push(entry);
            }
        }
        Ok(())
    }
    visit(path, &mut out)?;
    Ok(out)
}

struct PlaybackServer {
    storage: Arc<Mutex<RecordingStorageState>>,
    state: Mutex<Option<PlaybackServerInner>>,
}

struct PlaybackServerInner {
    token: String,
    base_url: String,
    shutdown: watch::Sender<bool>,
    task: JoinHandle<()>,
}

impl PlaybackServer {
    fn new(storage: Arc<Mutex<RecordingStorageState>>) -> Self {
        Self {
            storage,
            state: Mutex::new(None),
        }
    }

    async fn url(&self, id: &str, media_file: &str) -> AppResult<String> {
        {
            let state = self
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if let Some(server) = state.as_ref() {
                return local_playback_url(&server.base_url, &server.token, id, media_file);
            }
        }

        // 在同步互斥锁之外绑定。两张库卡片同时打开时，
        // Tauri 命令可能并发调用这里。
        let listener = TcpListener::bind("127.0.0.1:0").await.map_err(|error| {
            AppError::new(
                "recording_server_error",
                format!("启动录制回放服务失败: {error}"),
            )
        })?;
        let port = listener
            .local_addr()
            .map_err(|error| AppError::new("recording_server_error", error.to_string()))?
            .port();
        let token = Uuid::new_v4().simple().to_string();
        let base_url = format!("http://127.0.0.1:{port}");
        let (shutdown, receiver) = watch::channel(false);
        let storage = self.storage.clone();
        let task_token = token.clone();
        let task = tauri::async_runtime::spawn(async move {
            run_playback_server(listener, storage, task_token, receiver).await;
        });
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.is_none() {
            *state = Some(PlaybackServerInner {
                token,
                base_url,
                shutdown,
                task,
            });
        } else {
            let _ = shutdown.send(true);
            task.abort();
        }
        let server = state.as_ref().expect("playback server installed");
        local_playback_url(&server.base_url, &server.token, id, media_file)
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

fn local_playback_url(base_url: &str, token: &str, id: &str, relative: &str) -> AppResult<String> {
    let mut url = Url::parse(base_url).map_err(|error| {
        AppError::new(
            "recording_server_error",
            format!("录制回放地址无效: {error}"),
        )
    })?;
    let mut segments = url
        .path_segments_mut()
        .map_err(|_| AppError::new("recording_server_error", "录制回放地址不支持文件路径"))?;
    segments.clear().push(token);
    // id 占据两级路径，因此贡献两个 URL 段。
    // 服务器按相同顺序把它们重新拆开。
    for level in id.split('/') {
        segments.push(level);
    }
    for component in Path::new(relative).components() {
        let Component::Normal(value) = component else {
            return Err(AppError::new(
                "recording_metadata_error",
                "录制媒体路径无效",
            ));
        };
        let value = value.to_str().ok_or_else(|| {
            AppError::new("recording_metadata_error", "录制媒体路径不是有效 UTF-8")
        })?;
        segments.push(value);
    }
    drop(segments);
    Ok(url.into())
}

async fn run_playback_server(
    listener: TcpListener,
    storage: Arc<Mutex<RecordingStorageState>>,
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
                    let storage = storage.clone();
                    let token = token.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = handle_playback_client(&mut socket, &storage, &token).await;
                    });
                }
                Err(_) => break,
            },
        }
    }
}

async fn handle_playback_client(
    socket: &mut TcpStream,
    storage: &Arc<Mutex<RecordingStorageState>>,
    token: &str,
) -> Result<(), String> {
    let mut buffer = [0_u8; 8192];
    let mut count = 0;
    while count < buffer.len() {
        let read = socket
            .read(&mut buffer[count..])
            .await
            .map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        count += read;
        if buffer[..count]
            .windows(4)
            .any(|window| window == b"\r\n\r\n")
        {
            break;
        }
    }
    if count == 0 {
        return Ok(());
    }
    let head = String::from_utf8_lossy(&buffer[..count]);
    let mut parts = head.lines().next().unwrap_or("").split_whitespace();
    let method = parts.next().unwrap_or("");
    let target = parts.next().unwrap_or("");
    if method == "OPTIONS" {
        socket
            .write_all(b"HTTP/1.1 204 No Content\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, HEAD, OPTIONS\r\nAccess-Control-Allow-Headers: *\r\nConnection: close\r\n\r\n")
            .await
            .map_err(|error| error.to_string())?;
        return Ok(());
    }
    if method != "GET" && method != "HEAD" {
        write_simple_response(socket, 405, "Method Not Allowed", "").await?;
        return Ok(());
    }
    let path = target.split_once('?').map_or(target, |(path, _)| path);
    let mut components = path.trim_start_matches('/').split('/');
    if components.next() != Some(token) {
        write_simple_response(socket, 404, "Not Found", "").await?;
        return Ok(());
    }
    // 录制 id 是两级路径，因此在这里占据两个 URL 段。
    let Some(encoded_room) = components.next() else {
        write_simple_response(socket, 404, "Not Found", "").await?;
        return Ok(());
    };
    let Some(encoded_session) = components.next() else {
        write_simple_response(socket, 404, "Not Found", "").await?;
        return Ok(());
    };
    let (Ok(room), Ok(session)) = (
        percent_decode_str(encoded_room).decode_utf8(),
        percent_decode_str(encoded_session).decode_utf8(),
    ) else {
        write_simple_response(socket, 404, "Not Found", "").await?;
        return Ok(());
    };
    let id = format!("{room}/{session}");
    let id = id.as_str();
    if !is_safe_recording_id(id) {
        write_simple_response(socket, 404, "Not Found", "").await?;
        return Ok(());
    }
    let Some(relative) = decode_playback_relative_path(components) else {
        write_simple_response(socket, 404, "Not Found", "").await?;
        return Ok(());
    };
    let roots = storage
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .roots
        .clone();
    let Some((_root, bundle)) = find_bundle_in_root(&roots, id) else {
        write_simple_response(socket, 404, "Not Found", "").await?;
        return Ok(());
    };
    let file = bundle.join(&relative);
    let canonical_bundle = std::fs::canonicalize(&bundle).map_err(|error| error.to_string())?;
    let canonical_file = match std::fs::canonicalize(&file) {
        Ok(path) => path,
        Err(_) => {
            write_simple_response(socket, 404, "Not Found", "").await?;
            return Ok(());
        }
    };
    if !canonical_file.starts_with(&canonical_bundle) {
        write_simple_response(socket, 404, "Not Found", "").await?;
        return Ok(());
    }
    serve_file(
        socket,
        method == "HEAD",
        &file,
        request_header(&head, "range"),
    )
    .await
}

fn decode_playback_relative_path<'a>(
    segments: impl IntoIterator<Item = &'a str>,
) -> Option<PathBuf> {
    let mut relative = PathBuf::new();
    for encoded in segments {
        let decoded = percent_decode_str(encoded).decode_utf8().ok()?;
        if decoded.is_empty() || decoded.contains('/') || decoded.contains('\\') {
            return None;
        }
        let mut components = Path::new(decoded.as_ref()).components();
        if !matches!(components.next(), Some(Component::Normal(_))) || components.next().is_some() {
            return None;
        }
        relative.push(decoded.as_ref());
    }
    safe_relative_path(&relative).then_some(relative)
}

fn safe_relative_path(path: &Path) -> bool {
    !path.as_os_str().is_empty()
        && path.components().all(|component| {
            matches!(
                component,
                Component::Normal(value)
                    if !value.is_empty()
                        && value != "metadata.json"
                        && value != "metadata.json.tmp"
            )
        })
}

async fn serve_file(
    socket: &mut TcpStream,
    head_only: bool,
    path: &Path,
    range: Option<&str>,
) -> Result<(), String> {
    let metadata = tokio::fs::metadata(path)
        .await
        .map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return write_simple_response(socket, 404, "Not Found", "").await;
    }
    let total = metadata.len();
    let (status, start, end) = match parse_range(range, total) {
        Ok(value) => value,
        Err(_) => {
            let response = format!(
                "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{total}\r\nContent-Length: 0\r\nAccept-Ranges: bytes\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n"
            );
            socket
                .write_all(response.as_bytes())
                .await
                .map_err(|error| error.to_string())?;
            return Ok(());
        }
    };
    let length = if total == 0 {
        0
    } else {
        end.saturating_sub(start).saturating_add(1)
    };
    let content_type = content_type(path);
    let header = if status == 206 {
        format!(
            "HTTP/1.1 206 Partial Content\r\nContent-Type: {content_type}\r\nContent-Length: {length}\r\nContent-Range: bytes {start}-{end}/{total}\r\nAccept-Ranges: bytes\r\nAccess-Control-Allow-Origin: *\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n"
        )
    } else {
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {length}\r\nAccept-Ranges: bytes\r\nAccess-Control-Allow-Origin: *\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n"
        )
    };
    socket
        .write_all(header.as_bytes())
        .await
        .map_err(|error| error.to_string())?;
    if head_only || length == 0 {
        return Ok(());
    }
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|error| error.to_string())?;
    file.seek(std::io::SeekFrom::Start(start))
        .await
        .map_err(|error| error.to_string())?;
    let mut remaining = length;
    let mut chunk = vec![0_u8; 64 * 1024];
    while remaining > 0 {
        let capacity = chunk.len().min(remaining as usize);
        let read = file
            .read(&mut chunk[..capacity])
            .await
            .map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        socket
            .write_all(&chunk[..read])
            .await
            .map_err(|error| error.to_string())?;
        remaining -= read as u64;
    }
    Ok(())
}

fn parse_range(value: Option<&str>, total: u64) -> Result<(u16, u64, u64), String> {
    let Some(value) = value else {
        return Ok((200, 0, total.saturating_sub(1)));
    };
    if total == 0 {
        return Err("range not satisfiable".into());
    }
    let Some(value) = value.strip_prefix("bytes=") else {
        return Ok((200, 0, total - 1));
    };
    if value.contains(',') {
        return Err("multiple ranges are not supported".into());
    }
    let Some((start, end)) = value.split_once('-') else {
        return Ok((200, 0, total - 1));
    };
    let start = start.trim();
    let end = end.trim();
    let (start, end) = if start.is_empty() {
        let suffix = end
            .parse::<u64>()
            .map_err(|_| "invalid range".to_string())?;
        if suffix == 0 {
            return Err("range not satisfiable".into());
        }
        (total.saturating_sub(suffix.min(total)), total - 1)
    } else {
        let start = start
            .parse::<u64>()
            .map_err(|_| "invalid range".to_string())?;
        let end = if end.is_empty() {
            total - 1
        } else {
            end.parse::<u64>()
                .map_err(|_| "invalid range".to_string())?
                .min(total - 1)
        };
        (start, end)
    };
    if start >= total || start > end {
        return Err("range not satisfiable".into());
    }
    Ok((206, start, end))
}

fn content_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "m3u8" => "application/vnd.apple.mpegurl",
        "ts" => "video/mp2t",
        "flv" => "video/x-flv",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "m4s" => "video/iso.segment",
        "aac" => "audio/aac",
        "key" => "application/octet-stream",
        _ => "application/octet-stream",
    }
}

async fn write_simple_response(
    socket: &mut TcpStream,
    status: u16,
    reason: &str,
    body: &str,
) -> Result<(), String> {
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    socket
        .write_all(response.as_bytes())
        .await
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::live::DanmakuKind;
    use std::ops::Deref;
    use std::sync::Barrier;
    use tokio::sync::oneshot;

    const ID: &str = "bilibili_100/主播_20260820-192158";
    const SECOND_ID: &str = "bilibili_100/主播_20260820-193000";
    const SOURCE: &str = "live:bilibili:shutdown";

    struct TestDir(PathBuf);

    impl TestDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("rlive-recording-{}", Uuid::new_v4()));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Deref for TestDir {
        type Target = Path;
        fn deref(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).unwrap();
        }
    }

    // 字段按声明顺序释放，确保目录清理前先释放 manager 的文件锁。
    struct Library {
        manager: RecordingManager,
        root: PathBuf,
        directory: TestDir,
    }

    impl Library {
        fn new() -> Self {
            let directory = TestDir::new();
            let manager = RecordingManager::new(&directory).unwrap();
            let root = PathBuf::from(manager.storage_info().path);
            Self {
                manager,
                root,
                directory,
            }
        }

        fn active(&self) -> Arc<SessionState> {
            let bundle = self.root.join(ID);
            std::fs::create_dir_all(&bundle).unwrap();
            active_session_state(self.root.clone(), bundle, ID.into())
        }

        fn put(&self, stored: &StoredRecording) -> PathBuf {
            let bundle = self.root.join(&stored.id);
            std::fs::create_dir_all(&bundle).unwrap();
            write_metadata(&bundle, stored).unwrap();
            bundle
        }

        async fn start(
            &self,
            input: RecordingStartInput,
            limit: usize,
        ) -> AppResult<RecordingItem> {
            self.start_with_ffmpeg_options(
                input,
                &crate::proxy::ProxyRoute::Direct,
                FfmpegRecordingOptions::default(),
                limit,
            )
            .await
        }
    }

    impl Deref for Library {
        type Target = RecordingManager;
        fn deref(&self) -> &RecordingManager {
            &self.manager
        }
    }

    fn session(
        state: &Arc<SessionState>,
        cancel: watch::Sender<bool>,
        task: JoinHandle<()>,
    ) -> Session {
        Session {
            active: Arc::new(ActiveSessionState::new(state.clone())),
            cancel,
            task,
        }
    }

    fn chat(content: &str) -> DanmakuEvent {
        DanmakuEvent {
            kind: DanmakuKind::Chat,
            user: "viewer".into(),
            is_self: false,
            user_id: None,
            content: content.into(),
            color: None,
            spans: None,
            super_chat: None,
            ts: 1,
        }
    }

    fn enable_danmaku(state: &SessionState) {
        let mut stored = state.stored.lock().unwrap();
        stored.include_danmaku = true;
        stored.continue_on_leave = true;
        stored.danmaku_file = Some("danmaku.jsonl".into());
    }

    fn outcome(status: RecordingStatus) -> TaskOutcome {
        TaskOutcome {
            status,
            error: None,
            split: false,
        }
    }

    #[test]
    fn names_media_and_bundles_without_collisions_across_roots() {
        let stem = recording_file_stem("主播:甲", "标题/测试", 1_700_000_000_000);
        assert!(stem.starts_with("主播_甲_标题_测试_"));
        assert!(!stem.contains([':', '/']));
        for (protocol, url, extension) in [
            (
                PlaybackProtocol::Flv,
                "https://example.test/live.flv",
                "flv",
            ),
            (
                PlaybackProtocol::MpegTs,
                "https://example.test/live.m3u8",
                "ts",
            ),
        ] {
            assert_eq!(
                media_file_name(protocol, url, &stem),
                format!("{stem}.{extension}")
            );
        }
        let root = TestDir::new();
        let history = TestDir::new();
        let mut input = manager_test_input("https://example.test/live.flv", SOURCE, "100");
        let room = recording_bundle_room_dir(&input);
        let name = recording_bundle_session_dir(&input, 1_700_000_000_000);
        assert_eq!(room, "bilibili_100");
        assert!(name.ends_with(&recording_timestamp(1_700_000_000_000)));
        let roots = [root.0.clone(), history.0.clone()];
        for (target, suffix) in [(&root, ""), (&root, "_1"), (&root, "_2"), (&history, "_3")] {
            let (bundle, id) = create_recording_bundle(target, &roots, &room, &name).unwrap();
            assert_eq!(id, format!("{room}/{name}{suffix}"));
            assert_eq!(bundle, target.join(&id));
        }
        input.site_id = None;
        input.room_id = None;
        input.source_kind = "iptv".into();
        input.source_key = "iptv:source:cctv1".into();
        assert_eq!(recording_bundle_room_dir(&input), "iptv_cctv1");
    }

    #[test]
    fn recording_and_playback_paths_reject_traversal() {
        for id in [ID, "iptv_cctv1/未知用户_20260820-192158"] {
            assert!(is_safe_recording_id(id), "{id}");
        }
        for id in [
            "bilibili_100",
            "bilibili_100/user_1/extra",
            "../bilibili_100/user_1",
            "bilibili_100/../../etc",
            "bilibili_100/..",
            "bilibili_100/.",
            "/bilibili_100/user_1",
            "bilibili_100//user_1",
            "bilibili_100/user_1/",
            "bilibili_100\\user_1",
            "bilibili:100/user_1",
            "bilibili/user_1",
            "_100/user_1",
            "bilibili_100/user_1.",
            "bilibili_100./user_1",
            " bilibili_100/user_1",
            "bilibili_100/user_1 ",
        ] {
            assert!(!is_safe_recording_id(id), "{id}");
        }
        for (path, safe) in [
            ("segments/0001.ts", true),
            ("", false),
            ("../metadata.json", false),
            ("metadata.json", false),
        ] {
            assert_eq!(safe_relative_path(Path::new(path)), safe, "{path}");
        }
        for path in [
            vec!["%2E%2E", "metadata.json"],
            vec!["segments%2Fsecret.ts"],
            vec!["segments%5Csecret.ts"],
        ] {
            assert!(decode_playback_relative_path(path).is_none());
        }
    }

    #[test]
    fn local_playback_urls_round_trip_unicode_and_spaces() {
        let id = "斗鱼_房间 100/斗鱼主播_20260816-120000";
        let file = "斗鱼主播_标题 测试_20260816-120000.flv";
        let url = local_playback_url("http://127.0.0.1:1234", "token", id, file).unwrap();
        assert!(url.contains("%E6%96%97%E9%B1%BC_%E6%88%BF%E9%97%B4%20100"));
        let parsed = Url::parse(&url).unwrap();
        let segments: Vec<_> = parsed.path_segments().unwrap().collect();
        let room = percent_decode_str(segments[1]).decode_utf8().unwrap();
        let session = percent_decode_str(segments[2]).decode_utf8().unwrap();
        assert_eq!(format!("{room}/{session}"), id);
        assert!(is_safe_recording_id(id));
        assert!(!segments[1].contains("%2F"));
        assert_eq!(
            decode_playback_relative_path([segments[3]]),
            Some(PathBuf::from(file))
        );
    }

    #[test]
    fn range_and_free_space_boundaries() {
        for (header, size, expected) in [
            (Some("bytes=10-20"), 100, Some((206, 10, 20))),
            (Some("bytes=90-"), 100, Some((206, 90, 99))),
            (Some("bytes=-10"), 100, Some((206, 90, 99))),
            (None, 0, Some((200, 0, 0))),
            (Some("bytes=0-0"), 0, None),
            (Some("bytes=0-1,4-5"), 100, None),
        ] {
            assert_eq!(parse_range(header, size).ok(), expected, "{header:?}");
        }
        for (available, low) in [
            (MINIMUM_FREE_SPACE_BYTES - 1, true),
            (MINIMUM_FREE_SPACE_BYTES, false),
            (MINIMUM_FREE_SPACE_BYTES + 1, false),
        ] {
            assert_eq!(storage_space_is_low(available), low);
        }
    }

    #[test]
    fn scan_and_delete_keep_nested_library_index_consistent() {
        let lib = Library::new();
        for id in [ID, SECOND_ID, "bilibili_legacy"] {
            lib.put(&completed_recording(id.into(), "100"));
        }
        let found = scan_recording_root(&lib.root);
        assert_eq!(found.len(), 2);
        for id in [ID, SECOND_ID] {
            assert!(found.contains_key(id));
            assert_eq!(
                find_bundle_in_root(&[lib.root.clone()], id).unwrap().1,
                lib.root.join(id)
            );
        }
        assert!(find_bundle_in_root(&[lib.root.clone()], "bilibili_legacy").is_none());
        assert_eq!(lib.list().unwrap().len(), 2);
        lib.delete(SECOND_ID).unwrap();
        assert_eq!(
            lib.list()
                .unwrap()
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            [ID]
        );
        assert!(!lib.root.join(SECOND_ID).exists());
        assert!(lib.root.join("bilibili_100").is_dir());
        lib.delete(ID).unwrap();
        assert!(lib.list().unwrap().is_empty());
        assert!(!lib.root.join("bilibili_100").exists());
        lib.delete(SECOND_ID).unwrap();
        assert!(lib.root.join("bilibili_legacy/metadata.json").is_file());
    }

    #[test]
    fn library_index_prioritizes_roots_and_refreshes_external_additions() {
        let primary = TestDir::new();
        let fallback = TestDir::new();
        let roots = [primary.0.clone(), fallback.0.clone()];
        let mut index = RecordingLibraryIndex::default();
        for (root, title) in [(&fallback, "fallback"), (&primary, "primary")] {
            index.replace_root(
                root.0.clone(),
                HashMap::from([(ID.into(), completed_recording(ID.into(), title))]),
            );
        }
        assert_eq!(index.items(&roots).len(), 1);
        assert_eq!(index.items(&roots)[0].title, "primary");
        index.upsert(&primary, completed_recording(ID.into(), "updated"));
        assert_eq!(index.items(&roots)[0].title, "updated");
        index.remove(&primary, ID);
        assert_eq!(index.items(&roots)[0].title, "fallback");

        let bundle = primary.join(ID);
        std::fs::create_dir_all(&bundle).unwrap();
        write_metadata(&bundle, &completed_recording(ID.into(), "external")).unwrap();
        // 不依赖文件系统时间戳精度，但仍走实际过期根刷新分支。
        index.roots.get_mut(&primary.0).unwrap().modified_at = None;
        index.refresh_changed_roots(std::slice::from_ref(&primary.0));
        assert_eq!(index.items(&roots)[0].title, "external");
    }

    #[test]
    fn library_scan_is_lazy_and_active_items_only_include_tracked_sessions() {
        let lib = Library::new();
        lib.put(&completed_recording(SECOND_ID.into(), "historical"));
        assert!(!lib.library_hydrated.load(Ordering::Acquire));
        assert!(lib.active_items().is_empty());
        let state = lib.active();
        lib.sessions.lock().unwrap().insert(
            ID.into(),
            session(
                &state,
                watch::channel(false).0,
                tauri::async_runtime::spawn(async {}),
            ),
        );
        let active = lib.active_items();
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].id, ID);
        assert_eq!(active[0].status, RecordingStatus::Recording);
        assert!(!lib.library_hydrated.load(Ordering::Acquire));
        let listed = lib.list().unwrap();
        assert_eq!(listed.len(), 2);
        assert!(listed.iter().any(|item| item.title == "historical"));
        assert!(lib.library_hydrated.load(Ordering::Acquire));
        assert_eq!(lib.active_items().len(), 1);
    }

    #[test]
    fn concurrent_metadata_writes_and_sidecar_recovery_are_atomic() {
        let lib = Library::new();
        let mut old = completed_recording(ID.into(), "old");
        old.status = RecordingStatus::Recording;
        let bundle = lib.put(&old);
        let barrier = Arc::new(Barrier::new(8));
        let handles: Vec<_> = (0..8)
            .map(|index| {
                let barrier = barrier.clone();
                let bundle = bundle.clone();
                let mut stored = old.clone();
                std::thread::spawn(move || {
                    stored.title = format!("metadata-{index}");
                    barrier.wait();
                    write_metadata(&bundle, &stored).unwrap();
                })
            })
            .collect();
        for handle in handles {
            handle.join().unwrap();
        }
        assert!(
            read_stored(&lib.root, ID)
                .unwrap()
                .title
                .starts_with("metadata-")
        );
        for sidecar in ["metadata.json.tmp", "metadata.json.bak"] {
            assert!(!bundle.join(sidecar).exists());
        }
        std::fs::remove_file(bundle.join("metadata.json")).unwrap();
        let next = completed_recording(ID.into(), "new");
        for (file, stored) in [("metadata.json.bak", old), ("metadata.json.tmp", next)] {
            std::fs::write(bundle.join(file), serde_json::to_vec(&stored).unwrap()).unwrap();
        }
        recover_bundle_sidecars(&bundle).unwrap();
        assert_eq!(read_stored(&lib.root, ID).unwrap().title, "new");
        for sidecar in ["metadata.json.tmp", "metadata.json.bak"] {
            assert!(!bundle.join(sidecar).exists());
        }
    }

    #[test]
    fn sidecars_hide_account_ids_and_count_valid_batches_before_truncated_tail() {
        let lib = Library::new();
        let mut stored = completed_recording(ID.into(), "danmaku");
        stored.include_danmaku = true;
        stored.danmaku_file = Some("danmaku.jsonl".into());
        let bundle = lib.put(&stored);
        let mut own = chat("测试");
        own.is_self = true;
        own.user_id = Some("private-account-id".into());
        let batch = serde_json::to_string(&StoredDanmakuBatch {
            offset_ms: 250,
            events: &[own, chat("second")],
        })
        .unwrap();
        assert!(batch.contains("\"offset_ms\":250"));
        assert!(batch.contains("\"is_self\":true"));
        assert!(!batch.contains("private-account-id"));
        assert!(!batch.contains("user_id"));
        std::fs::write(
            bundle.join("danmaku.jsonl"),
            format!("{batch}\n{{\"offset_ms\":"),
        )
        .unwrap();
        assert_eq!(count_recorded_danmaku(&bundle, &stored), Some(2));
    }

    #[test]
    fn only_background_sidecar_recordings_retain_matching_connections() {
        for (background, danmaku, source, expected) in [
            (true, true, SOURCE, true),
            (false, true, SOURCE, false),
            (true, false, SOURCE, false),
            (true, true, "live:bilibili:other", false),
        ] {
            let mut stored = completed_recording(ID.into(), "shutdown");
            stored.status = RecordingStatus::Recording;
            stored.continue_on_leave = background;
            stored.include_danmaku = danmaku;
            assert_eq!(stored_keeps_background_danmaku(&stored, source), expected);
        }
        let lib = Library::new();
        let danmaku = crate::danmu_rs::DanmakuManager::new();
        assert!(danmaku.begin_connect(100, SOURCE.into(), false));
        {
            let _reservation = lib.reserve_background_danmaku_start(SOURCE, true);
            assert!(lib.has_background_danmaku_recording(SOURCE));
            assert!(danmaku.detach_for_generation(101));
        }
        assert!(!lib.has_background_danmaku_recording(SOURCE));
        assert!(danmaku.disconnect_background_for_source(SOURCE));
    }

    #[tokio::test]
    async fn leave_guard_persists_background_ownership_and_finalizing_accepts_last_batch() {
        let lib = Library::new();
        let state = lib.active();
        enable_danmaku(&state);
        state.stored.lock().unwrap().continue_on_leave = false;
        *state.danmaku_writer.lock().unwrap() = Some(
            OpenOptions::new()
                .create(true)
                .append(true)
                .open(state.bundle.join("danmaku.jsonl"))
                .unwrap(),
        );
        lib.sessions.lock().unwrap().insert(
            ID.into(),
            session(
                &state,
                watch::channel(false).0,
                tauri::async_runtime::spawn(async {}),
            ),
        );
        assert!(!lib.has_background_danmaku_recording(SOURCE));
        assert!(
            lib.set_continue_on_leave(ID, true)
                .unwrap()
                .continue_on_leave
        );
        assert!(lib.has_background_danmaku_recording(SOURCE));
        assert!(read_stored(&lib.root, ID).unwrap().continue_on_leave);

        lib.sessions.lock().unwrap().remove(ID);
        lib.finalizing.lock().unwrap().insert(
            ID.into(),
            FinalizingSession {
                state: state.clone(),
            },
        );
        lib.capture_danmaku(SOURCE, &[chat("final")]);
        assert_eq!(state.danmaku_count.load(Ordering::Acquire), 1);
        assert!(
            !std::fs::read(state.bundle.join("danmaku.jsonl"))
                .unwrap()
                .is_empty()
        );
        finish_session(&state, outcome(RecordingStatus::Completed));
        lib.capture_danmaku(SOURCE, &[chat("too late")]);
        assert_eq!(state.danmaku_count.load(Ordering::Acquire), 1);
        assert_eq!(read_stored(&lib.root, ID).unwrap().danmaku_count, 1);
        *state.danmaku_writer.lock().unwrap() = None;
    }

    #[tokio::test]
    async fn graceful_shutdown_waits_for_finalization_and_is_idempotent() {
        let lib = Library::new();
        let state = lib.active();
        let (cancel, mut rx) = watch::channel(false);
        let task_state = state.clone();
        let task = tauri::async_runtime::spawn(async move {
            if !*rx.borrow() {
                rx.changed().await.unwrap();
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
            finish_session(&task_state, outcome(RecordingStatus::Completed));
        });
        lib.sessions
            .lock()
            .unwrap()
            .insert(ID.into(), session(&state, cancel, task));
        lib.stop_all_graceful().await;
        lib.stop_all_graceful().await;
        assert!(lib.sessions.lock().unwrap().is_empty());
        assert!(state.finished.load(Ordering::Acquire));
        let stored = read_stored(&lib.root, ID).unwrap();
        assert_eq!(stored.status, RecordingStatus::Completed);
        assert!(stored.ended_at.is_some());
    }

    struct TaskDropFlag(Arc<AtomicBool>);
    impl Drop for TaskDropFlag {
        fn drop(&mut self) {
            self.0.store(true, Ordering::Release);
        }
    }

    #[tokio::test]
    async fn shutdown_only_aborts_owned_tasks_and_defers_recovery_to_restart() {
        for owned in [true, false] {
            let lib = Library::new();
            let state = lib.active();
            std::fs::write(state.bundle.join("stream.flv.part"), b"partial-media").unwrap();
            state.bytes.store(13, Ordering::Relaxed);
            let (cancel, rx) = watch::channel(false);
            let dropped = Arc::new(AtomicBool::new(false));
            let flag = dropped.clone();
            let (ready, ready_rx) = oneshot::channel();
            let task = tauri::async_runtime::spawn(async move {
                let _flag = TaskDropFlag(flag);
                let _rx = rx;
                ready.send(()).unwrap();
                std::future::pending::<()>().await;
            });
            ready_rx.await.unwrap();
            let mut other_owner = None;
            if owned {
                stop_sessions_until_deadline(
                    vec![(ID.into(), session(&state, cancel, task))],
                    tokio::time::Instant::now(),
                )
                .await;
            } else {
                // 另一 stop 请求拥有 task；退出等待不能越权取消它。
                other_owner = Some(task);
                wait_for_finalizing_sessions(
                    vec![(ID.into(), state.clone())],
                    tokio::time::Instant::now(),
                )
                .await;
            }
            assert_eq!(dropped.load(Ordering::Acquire), owned);
            assert!(!state.finished.load(Ordering::Acquire));
            assert!(state.bundle.join("stream.flv.part").exists());
            assert!(!state.bundle.join("stream.flv").exists());
            assert_eq!(
                read_stored(&lib.root, ID).unwrap().status,
                RecordingStatus::Recording
            );
            if let Some(task) = other_owner {
                task.abort();
                let _ = task.await;
                assert!(dropped.load(Ordering::Acquire));
            }
            recover_stale_recordings(&lib.root).unwrap();
            assert!(!state.bundle.join("stream.flv.part").exists());
            assert_eq!(
                std::fs::read(state.bundle.join("stream.flv")).unwrap(),
                b"partial-media"
            );
            let stored = read_stored(&lib.root, ID).unwrap();
            assert_eq!(stored.status, RecordingStatus::Interrupted);
            assert!(stored.ended_at.is_some());
        }
    }

    #[test]
    fn recovery_handles_failed_parts_missing_media_and_unsafe_paths() {
        for (status, media, part, error) in [
            (
                RecordingStatus::Failed,
                "stream.flv",
                true,
                "发布录制文件失败",
            ),
            (
                RecordingStatus::Recording,
                "stream.flv",
                false,
                "媒体文件缺失",
            ),
            (
                RecordingStatus::Recording,
                "../outside.flv",
                false,
                "媒体路径无效",
            ),
        ] {
            let lib = Library::new();
            let stored = StoredRecording {
                status,
                media_file: media.into(),
                error: part.then(|| error.into()),
                ..completed_recording(ID.into(), "recovery")
            };
            let bundle = lib.put(&stored);
            if part {
                std::fs::write(bundle.join("stream.flv.part"), b"partial-media").unwrap();
            }
            recover_stale_recordings(&lib.root).unwrap();
            let recovered = read_stored(&lib.root, ID).unwrap();
            assert_eq!(recovered.status, RecordingStatus::Interrupted);
            assert!(recovered.ended_at.is_some());
            assert!(
                recovered
                    .error
                    .as_deref()
                    .is_some_and(|message| message.contains(error))
            );
            assert!(!lib.root.join("outside.flv").exists());
            assert!(!lib.root.join("bilibili_100/outside.flv").exists());
            if part {
                assert!(!bundle.join("stream.flv.part").exists());
                assert_eq!(
                    std::fs::read(bundle.join("stream.flv")).unwrap(),
                    b"partial-media"
                );
            }
        }
    }

    #[test]
    fn worker_failure_salvages_parts_without_overwriting_final_media() {
        let lib = Library::new();
        let state = lib.active();
        for part in [b"partial-media".as_slice(), b"new-partial"] {
            std::fs::write(state.bundle.join("stream.flv.part"), part).unwrap();
            salvage_temporary_media_after_worker_failure(&state);
            assert_eq!(
                std::fs::read(state.bundle.join("stream.flv")).unwrap(),
                b"partial-media"
            );
            if part == b"partial-media" {
                assert!(!state.bundle.join("stream.flv.part").exists());
            } else {
                assert_eq!(
                    std::fs::read(state.bundle.join("stream.flv.part")).unwrap(),
                    part
                );
            }
        }
    }

    #[tokio::test]
    async fn finalizing_sessions_stay_visible_and_fence_mutations() {
        let lib = Library::new();
        let state = lib.active();
        lib.finalizing
            .lock()
            .unwrap()
            .insert(ID.into(), FinalizingSession { state });
        assert_eq!(lib.list().unwrap()[0].status, RecordingStatus::Recording);
        assert_eq!(lib.delete(ID).unwrap_err().code, "recording_still_active");
        assert_eq!(lib.stop(ID).await.unwrap_err().code, "recording_stopping");
        let duplicate = lib
            .start(
                manager_test_input("https://example.test/live.flv", SOURCE, "shutdown"),
                4,
            )
            .await
            .unwrap_err();
        assert_eq!(duplicate.code, "recording_already_active");
        let error = lib
            .set_storage_path(Some(
                lib.directory.join("busy-target").display().to_string(),
            ))
            .unwrap_err();
        assert_eq!(error.code, "recording_storage_busy");
        assert!(lib.root.join(ID).join("metadata.json").is_file());
        assert_eq!(
            lib.storage_info().path,
            crate::app_paths::path_to_string(&lib.root)
        );
    }

    #[test]
    fn input_defaults_preserve_explicit_opt_out_and_metadata_requires_background_flag() {
        const { assert!(CONTINUE_ON_LEAVE_DEFAULT) };
        let input = manager_test_input("https://example.test/live.flv", SOURCE, "shutdown");
        let mut value = serde_json::to_value(&input).unwrap();
        for key in ["includeDanmaku", "continueOnLeave"] {
            value.as_object_mut().unwrap().remove(key);
        }
        let parsed: RecordingStartInput = serde_json::from_value(value).unwrap();
        assert_eq!(
            (parsed.include_danmaku, parsed.continue_on_leave),
            (None, None)
        );
        for default in [false, true] {
            let resolved = parsed.clone().with_recording_defaults(default);
            assert_eq!(resolved.include_danmaku, Some(default));
            assert_eq!(resolved.continue_on_leave, Some(true));
            let explicit = input.clone().with_recording_defaults(default);
            assert_eq!(
                (explicit.include_danmaku, explicit.continue_on_leave),
                (Some(false), Some(false))
            );
        }
        let mut metadata = serde_json::to_value(completed_recording(ID.into(), "legacy")).unwrap();
        metadata
            .as_object_mut()
            .unwrap()
            .remove("continue_on_leave");
        assert!(serde_json::from_value::<StoredRecording>(metadata).is_err());
    }

    #[test]
    fn storage_migration_moves_current_bundles_but_never_changes_legacy_metadata() {
        let lib = Library::new();
        let first = lib.put(&completed_recording(ID.into(), "current"));
        std::fs::write(first.join("stream.flv"), b"media").unwrap();
        std::fs::write(first.join("danmaku.jsonl"), b"{}\n").unwrap();
        let old = lib.put(&completed_recording(SECOND_ID.into(), "legacy"));
        std::fs::write(old.join("stream.flv"), b"old-media").unwrap();
        let mut metadata =
            serde_json::to_value(completed_recording(SECOND_ID.into(), "legacy")).unwrap();
        metadata["schema_version"] = serde_json::json!(1);
        let metadata = serde_json::to_vec(&metadata).unwrap();
        std::fs::write(old.join("metadata.json"), &metadata).unwrap();
        assert_eq!(scan_recording_root(&lib.root).len(), 1);
        let info = lib
            .set_storage_path(Some(
                lib.directory
                    .join("custom-recordings ")
                    .display()
                    .to_string(),
            ))
            .unwrap();
        let target = PathBuf::from(info.path);
        assert!(!first.exists());
        for file in ["stream.flv", "danmaku.jsonl", "metadata.json"] {
            assert!(target.join(ID).join(file).is_file());
        }
        assert!(!target.join(SECOND_ID).exists());
        assert!(old.join("stream.flv").is_file());
        assert_eq!(std::fs::read(old.join("metadata.json")).unwrap(), metadata);
        assert_eq!(lib.list().unwrap().len(), 1);
        let Library {
            manager, directory, ..
        } = lib;
        drop(manager);
        let restarted = RecordingManager::new(&directory).unwrap();
        assert_eq!(restarted.list().unwrap().len(), 1);
    }

    #[test]
    fn storage_conflict_rolls_back_without_losing_media() {
        let lib = Library::new();
        let bundle = lib.put(&completed_recording(ID.into(), "conflict"));
        std::fs::write(bundle.join("stream.flv"), b"media").unwrap();
        let target = lib.directory.join("conflict-target");
        std::fs::create_dir_all(target.join(ID)).unwrap();
        let error = lib
            .set_storage_path(Some(target.display().to_string()))
            .unwrap_err();
        assert_eq!(error.code, "recording_storage_conflict");
        assert_eq!(std::fs::read(bundle.join("stream.flv")).unwrap(), b"media");
        assert_eq!(
            lib.storage_info().path,
            crate::app_paths::path_to_string(&lib.root)
        );
    }

    #[test]
    fn storage_config_recovers_committed_backup_but_reports_corruption() {
        let directory = TestDir::new();
        let path = directory.join(RECORDING_STORAGE_CONFIG_FILE);
        std::fs::write(&path, b"not-json").unwrap();
        let error = load_storage_state(&directory).unwrap_err();
        assert_eq!(error.code, "recording_storage_error");
        assert!(error.message.contains("恢复录制目录设置失败"));
        std::fs::remove_file(&path).unwrap();
        for (suffix, name) in [("bak", "committed"), ("tmp", "uncommitted")] {
            let root = directory.join(name);
            std::fs::create_dir_all(&root).unwrap();
            let config = RecordingStorageConfig {
                schema_version: RECORDING_STORAGE_CONFIG_VERSION,
                current_path: Some(crate::app_paths::path_to_string(&root)),
                known_paths: Vec::new(),
            };
            std::fs::write(
                path.with_extension(format!("json.{suffix}")),
                serde_json::to_vec(&config).unwrap(),
            )
            .unwrap();
        }
        let storage = load_storage_state(&directory).unwrap();
        assert_eq!(
            storage.current_root,
            std::fs::canonicalize(directory.join("committed")).unwrap()
        );
        assert!(path.exists());
        for suffix in ["bak", "tmp"] {
            assert!(!path.with_extension(format!("json.{suffix}")).exists());
        }
    }

    #[cfg(unix)]
    #[test]
    fn storage_rejects_symlinks_to_filesystem_root() {
        let directory = TestDir::new();
        let selected = directory.join("selected");
        std::os::unix::fs::symlink("/", &selected).unwrap();
        assert_eq!(
            prepare_storage_root(&selected).unwrap_err().code,
            "recording_storage_path_invalid"
        );
    }

    #[test]
    fn manager_enforces_exclusive_app_data_ownership() {
        let lib = Library::new();
        assert_eq!(
            RecordingManager::new(&lib.directory).err().unwrap().code,
            "recording_already_running"
        );
    }

    #[tokio::test]
    async fn ass_export_uses_media_stem_and_rejects_missing_danmaku() {
        let lib = Library::new();
        let mut stored = completed_recording(ID.into(), "字幕导出");
        stored.include_danmaku = true;
        stored.danmaku_file = Some("danmaku.jsonl".into());
        let bundle = lib.put(&stored);
        std::fs::write(bundle.join("stream.flv"), b"a").unwrap();
        let batch = serde_json::to_string(&StoredDanmakuBatch {
            offset_ms: 1200,
            events: &[chat("你好")],
        })
        .unwrap();
        std::fs::write(bundle.join("danmaku.jsonl"), format!("{batch}\n")).unwrap();
        let options =
            AssExportOptions::try_from_settings(&crate::models::settings::AppSettings::default())
                .unwrap();
        let path = lib.export_danmaku_ass(ID, options.clone()).await.unwrap();
        assert_eq!(
            path,
            crate::app_paths::path_to_string(&bundle.join("stream.ass"))
        );
        let script = std::fs::read_to_string(path).unwrap();
        for text in ["[Events]", "Dialogue: 0,0:00:01.20,", "你好"] {
            assert!(script.contains(text), "{text}");
        }
        lib.put(&completed_recording(SECOND_ID.into(), "无弹幕"));
        assert_eq!(
            lib.export_danmaku_ass(SECOND_ID, options)
                .await
                .unwrap_err()
                .code,
            "recording_danmaku_missing"
        );
    }

    fn completed_recording(id: String, title: &str) -> StoredRecording {
        StoredRecording {
            schema_version: RECORDING_METADATA_VERSION,
            id,
            source_key: format!("live:bilibili:{title}"),
            source_kind: "live".into(),
            site_id: Some("bilibili".into()),
            room_id: Some(title.into()),
            title: title.into(),
            user_name: "主播".into(),
            cover: String::new(),
            user_avatar: String::new(),
            protocol: PlaybackProtocol::Flv,
            status: RecordingStatus::Completed,
            started_at: 1,
            ended_at: Some(2),
            duration_ms: 1,
            size_bytes: 1,
            include_danmaku: false,
            continue_on_leave: false,
            danmaku_count: 0,
            danmaku_file: None,
            media_file: "stream.flv".into(),
            error: None,
        }
    }

    fn active_session_state(root: PathBuf, bundle: PathBuf, id: String) -> Arc<SessionState> {
        let stored = StoredRecording {
            status: RecordingStatus::Recording,
            ended_at: None,
            duration_ms: 0,
            size_bytes: 0,
            media_file: "stream.flv".into(),
            ..completed_recording(id, "shutdown")
        };
        write_metadata(&bundle, &stored).unwrap();
        Arc::new(SessionState {
            root,
            bundle,
            stored: Mutex::new(stored),
            bytes: AtomicU64::new(0),
            duration_ms: AtomicU64::new(0),
            danmaku_count: AtomicU64::new(0),
            last_progress_event_ms: AtomicU64::new(0),
            danmaku_writer: Mutex::new(None),
            danmaku_closed: AtomicBool::new(false),
            finished: AtomicBool::new(false),
            finish_lock: Mutex::new(()),
            library: Arc::new(Mutex::new(RecordingLibraryIndex::default())),
            events: Arc::new(RecordingEventSink::default()),
        })
    }

    fn manager_test_valid_flv_body() -> Vec<u8> {
        use base64::Engine as _;

        const FLV_FIXTURE: &str = "RkxWAQEAAAAJAAAAABIAALgAAAAAAAAAAgAKb25NZXRhRGF0YQgAAAAIAAhkdXJhdGlvbgBAIAAAAAAAAAAFd2lkdGgAQDAAAAAAAAAABmhlaWdodABAMAAAAAAAAAANdmlkZW9kYXRhcmF0ZQBAaGoAAAAAAAAJZnJhbWVyYXRlAEAAAAAAAAAAAAx2aWRlb2NvZGVjaWQAQAAAAAAAAAAAB2VuY29kZXICAA1MYXZmNjAuMTYuMTAwAAhmaWxlc2l6ZQBAgwAAAAAAAAAACQAAAMMJAAAPAAAAAAAAABIAAIQACAgRJiAgICH//gAAABoJAAAJAAH0AAAAACIAAIQ8CAgxIAAAABQJAAAJAAPoAAAAACIAAIR4CAgxIAAAABQJAAAJAAXcAAAAACIAAIS0CAgxIAAAABQJAAAJAAfQAAAAACIAAITwCAgxIAAAABQJAAAJAAnEAAAAACIAAIUsCAgxIAAAABQJAAAJAAu4AAAAACIAAIVoCAgxIAAAABQJAAAJAA2sAAAAACIAAIWkCAgxIAAAABQJAAAJAA+gAAAAACIAAIXgCAgxIAAAABQJAAAJABGUAAAAACIAAIYcCAgxIAAAABQJAAAJABOIAAAAACIAAIZYCAgxIAAAABQJAAAJABV8AAAAACIAAIaUCAgxIAAAABQJAAAPABdwAAAAABIAAIbQCAgRJiAgICH//gAAABoJAAAJABlkAAAAACIAAIcMCAgxIAAAABQJAAAJABtYAAAAACIAAIdICAgxIAAAABQJAAAJAB1MAAAAACIAAIeECAgxIAAAABQ=";
        let mut body = base64::engine::general_purpose::STANDARD
            .decode(FLV_FIXTURE)
            .unwrap();
        let mut offset = 13;
        let mut final_video_tag = None;
        while body.len().saturating_sub(offset) >= 15 {
            let data_size = (usize::from(body[offset + 1]) << 16)
                | (usize::from(body[offset + 2]) << 8)
                | usize::from(body[offset + 3]);
            let tag_size = 11 + data_size + 4;
            if body.len().saturating_sub(offset) < tag_size {
                break;
            }
            if body[offset] & 0x1f == 9 {
                final_video_tag = Some(body[offset..offset + tag_size].to_vec());
            }
            offset += tag_size;
        }
        let mut video_tag = final_video_tag.unwrap();
        let mut timestamp = 8_000_u32;
        while body.len() < 64 * 1024 {
            timestamp += 500;
            video_tag[4] = (timestamp >> 16) as u8;
            video_tag[5] = (timestamp >> 8) as u8;
            video_tag[6] = timestamp as u8;
            video_tag[7] = (timestamp >> 24) as u8;
            body.extend_from_slice(&video_tag);
        }
        body
    }

    fn manager_test_ts_segments() -> Vec<Vec<u8>> {
        use base64::Engine as _;
        use std::io::Read as _;

        const TS_FIXTURE_GZIP: &str = "H4sIAAAAAAACA9Xbf2wTVRwA8Hf7PRBZ143uh8JNIDhh7V27dW23Yx1jdBhJRjSGGGN9vV7Xc9fe7e6gmxKsxj8IMUQCIRETf0UTNJoM/0H/UId/KFGj0fgHGGMgMUT8A7fEP0gk1O+rJAy7Jkf/sO9tyfXdvffuvvfu3qcve2+xqKsF7VjcjLhzCBW4AuJu5NsmWrmGXbsyhjLV/KhiHlBlRRBzB8e+LtD1E4uiFoTm1xRjR9wieuhM3UcFNn5ikxB7zbynGPtltIi6yWbtZbgL385PXqM79lEkNE4idOzlQ6TdLyGUz9f3oGY/JrvNi2Q7tWNh1c/PcfB8alFxM7H0wDMkI/3dcB4+GuoLhSd+Gb/66ZWLE2dPbrvAX9x47c9Zf7Cf7+Nl3VR4EZJmQBRCfEBUxHAqDBkTXijg2zM5Huvr50cfH4OSSUWGjDHdmNOUlM37BSHQ5xf8ATiYtm0j4vPlcjnvATWp6BrOevUYh1zmlI9cyZu2MxqU0w1b1bNWhJdxAsuSwJtKShL5pJLQdHlaEiLwy+Ms1uYshezxGUVKqpi39icgJfCGNQfFYRs3k5LoFaAIbPiMOqsk4+RcpEbcxNkpRRKDvJw29QyOQ1WRt01F01QLSoRmQ0nZhoQ8k4FtUsHJZ/WsIvnFbaLIp7Blxw2IvdWaVg2oeOskM0ZcT6UshVS00yZUsiBT0/VpnIad+O1jlga9+PYBgc+axcvIagbbJBQ1ayumhqEQHE9o+008F5f1jIGLQUH72CZWs3AKKGhiUiZl4oxCTpVT1Km0bUBqWpmDbMl/KxHPqFnYsWQlC7EH/OiuXzVF3k+uX7wmaUtTsdLkCckSTph8JgENSB5BQoV8uA14ZeDD1jXyHPgZEr8keIOQNEgoxU88KwXDkLBsxYAKqgGPBl4AqNEPj3lGElCevKfK4ZcaTh9fhWr/vh4b5YRctDp9DSJZQJFi/2q8gAtLWrT2jRu/1qBH8AE5KHgDolcU/KhGiN5L8rjnb3AdfOOyJPTV/lPQAa8ahxCFlCzjY/Wxpdt8jJ7iu96FdhcPR+mJdAH1/gvdFbxyY9/R7pyfxthX/+Ug9qjLxfCYwMXwmMDF8JhgwJqEjvvY/+vMMkDWLL3gePxBfH+Re3/TF3l08yb01QCNfXVtjRNnUBB8514N0e67a6+r1Pd+Gtvd1eLI94HjUSobfAGtL96Gez0u63srw763Mux7K8O+DxLfl+6rmu/u+bfuyvfl4/cgjc64f3Tkewh8r9mNaPfd0yKW+j5IY7u3X3Lke4hy3z3XyvvuZth3N8O+uxn2PQy+17z5W9V879TPVTx+D9PoTOfbjnyPEN+vn6fd9+7v95b6HqGx3bvnHfk+RLnv939W3vc2hn1vY9j3NoZ9HwLfayc/qJrvG7yXKx6/D9PozAbTke/D4Hvt6Vdo973n6Eyp7xKN7d6Td+T7dsp933i0vO/tDPvezrDv7Qz7LoHvdciumu8br3GVjt/RdjCybt8+2o3csudYqZEjNBq5eYcjIwUaY98y6Sh28fUo1V2yeEfu4h31PoXv9H0dw76vY9j3dQz7PkJ8nx+umu+9H/ZUPH6nci1E78eOxu8CfDfVN/G0fzf13XOm9LuJynntrV868r2f8vF730/lx+8ehn33MOy7h2HfRfC9/um6qvnu00Yr/vv7AI3O+A478t1PfD/7O+2+i9/8UOo7lfPa4klHvg9S7nvgnfK+dzDsewfDvncw7HsAfG9Y+23VfB/Yiisev4dodGZgnyPfyfr3hql52n0fPLLC+ncq57UHU458j1Due9gu73snw753Mux7J+Pr3xs+P1E138N/VL7+fYhGZ4YedLz+vdEzS7vv0sMrrH+ncl5bCjryXaLc95Gd5X3vYtj3LoZ972J8/Xuj/mTVfB95r/L179tpdGbkuuP1741fRWn3faxZZGRueKzB2dwwO/Or423/mV/tZtj3boZ972Z8/XvThk1V8308Xfn6dyr/T34863j9e1OuiXbfY+dXWP9O5bx27KAj3wOUj993HylzG/8ACyylLrRIAAA=";
        let compressed = base64::engine::general_purpose::STANDARD
            .decode(TS_FIXTURE_GZIP)
            .unwrap();
        let mut ts_stream = Vec::new();
        flate2::read::GzDecoder::new(compressed.as_slice())
            .read_to_end(&mut ts_stream)
            .unwrap();
        const TS_PACKET_SIZE: usize = 188;
        const FIRST_SEGMENT_SIZE: usize = 11 * TS_PACKET_SIZE;
        const FOLLOWING_SEGMENT_SIZE: usize = 8 * TS_PACKET_SIZE;
        assert_eq!(
            (ts_stream.len() - FIRST_SEGMENT_SIZE) % FOLLOWING_SEGMENT_SIZE,
            0
        );
        let mut segments = vec![ts_stream[..FIRST_SEGMENT_SIZE].to_vec()];
        let (following, _) = ts_stream[FIRST_SEGMENT_SIZE..].as_chunks::<FOLLOWING_SEGMENT_SIZE>();
        segments.extend(following.iter().map(|segment| segment.to_vec()));
        segments
    }

    fn manager_test_input(url: &str, source_key: &str, room_id: &str) -> RecordingStartInput {
        RecordingStartInput {
            source: crate::models::live::PlayUrl::inferred(
                format!("test:{room_id}"),
                "测试线路",
                0,
                url.to_string(),
                Default::default(),
            ),
            source_key: source_key.into(),
            source_kind: "live".into(),
            site_id: Some("bilibili".into()),
            room_id: Some(room_id.into()),
            title: "录制契约测试".into(),
            user_name: "测试主播".into(),
            cover: String::new(),
            user_avatar: String::new(),
            include_danmaku: Some(false),
            continue_on_leave: Some(false),
        }
    }

    enum Reply {
        Body(&'static str, Vec<u8>),
        Live(Vec<u8>),
        Stalled,
    }

    struct TestServer {
        url: String,
        task: tokio::task::JoinHandle<()>,
    }

    impl Drop for TestServer {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    async fn serve(handler: impl Fn(&str) -> Option<Reply> + Send + Sync + 'static) -> TestServer {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let handler = Arc::new(handler);
        let task = tokio::spawn(async move {
            // 中止服务器时也取消尚未完成的客户端，避免停滞 HLS 请求泄漏。
            let mut clients = tokio::task::JoinSet::new();
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let handler = handler.clone();
                clients.spawn(async move {
                    let mut request = [0; 4096];
                    let length = socket.read(&mut request).await?;
                    match handler(&String::from_utf8_lossy(&request[..length])) {
                        Some(Reply::Body(kind, body)) => {
                            let headers = format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                body.len()
                            );
                            socket.write_all(headers.as_bytes()).await?;
                            socket.write_all(&body).await?;
                        }
                        Some(reply) => {
                            match reply {
                                Reply::Live(body) => {
                                    socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: video/x-flv\r\nTransfer-Encoding: chunked\r\nConnection: keep-alive\r\n\r\n").await?;
                                    socket.write_all(format!("{:x}\r\n", body.len()).as_bytes()).await?;
                                    socket.write_all(&body).await?;
                                    socket.write_all(b"\r\n").await?;
                                }
                                Reply::Stalled => {
                                    socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: video/mp2t\r\nContent-Length: 1504\r\nConnection: close\r\n\r\n").await?;
                                }
                                Reply::Body(..) => unreachable!(),
                            }
                            socket.read(&mut [0]).await?;
                        }
                        None => {
                            socket.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await?;
                        }
                    }
                    Ok::<_, std::io::Error>(())
                });
                while clients.try_join_next().is_some() {}
            }
        });
        TestServer { url, task }
    }

    async fn wait_until(check: impl Fn() -> bool) {
        tokio::time::timeout(Duration::from_secs(8), async {
            while !check() {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("录制状态应在超时前满足条件");
    }

    async fn wait_for_bytes(lib: &Library, id: &str) {
        wait_until(|| {
            lib.list()
                .unwrap()
                .iter()
                .any(|item| item.id == id && item.size_bytes > 0)
        })
        .await;
    }

    fn assert_completed_file(lib: &Library, stopped: &RecordingItem) -> PathBuf {
        assert_eq!(
            stopped.status,
            RecordingStatus::Completed,
            "{:?}",
            stopped.error
        );
        assert!(stopped.error.is_none());
        assert!(stopped.ended_at.is_some());
        let stored = read_stored(&lib.root, &stopped.id).unwrap();
        assert_eq!(stored.status, RecordingStatus::Completed);
        assert_eq!(stored.ended_at, stopped.ended_at);
        assert_eq!(stored.size_bytes, stopped.size_bytes);
        let bundle = lib.root.join(&stopped.id);
        assert!(!bundle.join(format!("{}.part", stored.media_file)).exists());
        let path = bundle.join(stored.media_file);
        assert!(path.is_file());
        assert_eq!(stopped.file_path, crate::app_paths::path_to_string(&path));
        path
    }

    #[tokio::test]
    async fn manager_persists_start_stop_and_enforces_dynamic_limits_and_source_identity() {
        let body = manager_test_valid_flv_body();
        let server = serve(move |_| Some(Reply::Live(body.clone()))).await;
        let lib = Library::new();
        let mut input = manager_test_input(&format!("{}/live.flv", server.url), SOURCE, "100");
        // Native 路径只检验生命周期；下面另测实际 FFmpeg 重封装。
        input.source.protocol = PlaybackProtocol::Native;
        let active = lib.start(input.clone(), 1).await.unwrap();
        assert_eq!(active.status, RecordingStatus::Recording);
        assert!(active.ended_at.is_none());
        let metadata = read_stored(&lib.root, &active.id).unwrap();
        assert_eq!(metadata.status, RecordingStatus::Recording);
        assert!(metadata.ended_at.is_none());
        let bundle = lib.root.join(&active.id);
        assert!(!bundle.join(&metadata.media_file).exists());
        input.room_id = Some("different-room".into());
        assert_eq!(
            lib.start(input.clone(), 4).await.unwrap_err().code,
            "recording_already_active"
        );
        assert_eq!(lib.active_items().len(), 1);
        input.source_key = "live:bilibili:second".into();
        assert_eq!(
            lib.start(input.clone(), 1).await.unwrap_err().code,
            "recording_limit_reached"
        );
        let second = lib.start(input, 2).await.unwrap();
        wait_for_bytes(&lib, &active.id).await;
        assert!(
            bundle
                .join(format!("{}.part", metadata.media_file))
                .is_file()
        );
        let stopped = lib.stop(&active.id).await.unwrap();
        let path = assert_completed_file(&lib, &stopped);
        assert!(std::fs::read(path).unwrap().starts_with(b"FLV"));
        lib.stop(&second.id).await.unwrap();
    }

    #[tokio::test]
    async fn ffmpeg_remuxes_live_flv_with_headers_and_seek_index() {
        let body = manager_test_valid_flv_body();
        let request = Arc::new(Mutex::new(String::new()));
        let captured = request.clone();
        let server = serve(move |head| {
            *captured.lock().unwrap() = head.into();
            Some(Reply::Live(body.clone()))
        })
        .await;
        let lib = Library::new();
        let mut input = manager_test_input(&format!("{}/live.flv", server.url), SOURCE, "ffmpeg");
        input
            .source
            .headers
            .insert("X-Recording-Test".into(), "ffmpeg".into());
        let active = lib.start(input, 4).await.unwrap();
        wait_for_bytes(&lib, &active.id).await;
        let stopped = lib.stop(&active.id).await.unwrap();
        let path = assert_completed_file(&lib, &stopped);
        assert!(stopped.duration_ms > 0);
        assert!(
            request
                .lock()
                .unwrap()
                .contains("X-Recording-Test: ffmpeg\r\n")
        );
        assert!(
            std::fs::read(&path)
                .unwrap()
                .windows(9)
                .any(|window| window == b"keyframes")
        );
        let output = ffmpeg_next::format::input(&path).unwrap();
        assert!(
            output
                .streams()
                .any(|stream| stream.parameters().medium() == ffmpeg_next::media::Type::Video)
        );
    }

    #[tokio::test]
    async fn ffmpeg_auto_split_continues_and_original_id_stops_the_current_bundle() {
        let body = manager_test_valid_flv_body();
        let server = serve(move |_| Some(Reply::Live(body.clone()))).await;
        let lib = Library::new();
        let initial = lib
            .start_with_ffmpeg_options(
                manager_test_input(&format!("{}/live.flv", server.url), SOURCE, "auto-split"),
                &crate::proxy::ProxyRoute::Direct,
                FfmpegRecordingOptions {
                    split_duration: Some(Duration::from_millis(500)),
                    ..Default::default()
                },
                4,
            )
            .await
            .unwrap();
        wait_until(|| {
            let items = lib.list().unwrap();
            items
                .iter()
                .any(|item| item.id == initial.id && item.status == RecordingStatus::Completed)
                && items.iter().any(|item| {
                    item.id != initial.id
                        && item.status == RecordingStatus::Recording
                        && item.size_bytes > 0
                })
        })
        .await;
        let stopped = lib.stop(&initial.id).await.unwrap();
        assert_ne!(stopped.id, initial.id);
        assert_completed_file(&lib, &stopped);
        let items = lib.list().unwrap();
        assert!(
            !items
                .iter()
                .any(|item| item.status == RecordingStatus::Recording)
        );
        let completed: Vec<_> = items
            .iter()
            .filter(|item| item.status == RecordingStatus::Completed)
            .collect();
        assert!(completed.len() >= 2);
        assert!(
            completed
                .iter()
                .all(|item| Path::new(&item.file_path).is_file())
        );
    }

    struct HlsSource {
        segments: Vec<Vec<u8>>,
        master: bool,
        sequence: [AtomicU64; 2],
        requests: [AtomicU64; 2],
        stall: AtomicBool,
        stalled: AtomicU64,
    }

    impl HlsSource {
        async fn serve(master: bool) -> (Arc<Self>, TestServer) {
            let source = Arc::new(Self {
                segments: manager_test_ts_segments(),
                master,
                sequence: Default::default(),
                requests: Default::default(),
                stall: AtomicBool::new(false),
                stalled: AtomicU64::new(0),
            });
            let served = source.clone();
            let server = serve(move |head| served.reply(head)).await;
            (source, server)
        }

        fn reply(&self, head: &str) -> Option<Reply> {
            let path = head.lines().next()?.split_whitespace().nth(1)?;
            if path == "/master.m3u8" {
                return Some(Reply::Body("application/vnd.apple.mpegurl", b"#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=1280x720\nhigh.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=100000,RESOLUTION=320x180\nlow.m3u8\n".to_vec()));
            }
            let variant = usize::from(path.starts_with("/low"));
            let name = if variant == 0 { "high" } else { "low" };
            if path.ends_with(".m3u8") {
                let sequence = if self.master {
                    self.sequence[variant]
                        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
                            Some((value + 1).min(self.segments.len() as u64 - 3))
                        })
                        .unwrap()
                } else {
                    self.sequence[variant].load(Ordering::Relaxed)
                };
                let mut playlist = format!(
                    "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:{sequence}\n"
                );
                for index in sequence..sequence + if self.master { 3 } else { 1 } {
                    playlist.push_str(&format!("#EXTINF:1.000,\n{name}-segment-{index}.ts\n"));
                }
                return Some(Reply::Body(
                    "application/vnd.apple.mpegurl",
                    playlist.into_bytes(),
                ));
            }
            let index = path
                .strip_suffix(".ts")?
                .rsplit('-')
                .next()?
                .parse::<usize>()
                .ok()?;
            let segment = self.segments.get(index)?;
            self.requests[variant].fetch_add(1, Ordering::Relaxed);
            if self.stall.load(Ordering::Relaxed) {
                self.stalled.fetch_add(1, Ordering::Relaxed);
                return Some(Reply::Stalled);
            }
            if !self.master {
                // 单分片窗口只在实际发送后推进，确保停止时阻塞在新分片读取。
                self.sequence[variant].fetch_max(
                    ((index + 1).min(self.segments.len() - 1)) as u64,
                    Ordering::Relaxed,
                );
            }
            Some(Reply::Body("video/mp2t", segment.clone()))
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn ffmpeg_hls_selects_one_variant_and_stalled_stop_still_completes() {
        for master in [true, false] {
            let (hls, server) = HlsSource::serve(master).await;
            let lib = Library::new();
            let playlist = if master { "master" } else { "live" };
            let input =
                manager_test_input(&format!("{}/{playlist}.m3u8", server.url), SOURCE, "hls");
            let active = lib.start(input, 4).await.unwrap();
            assert_eq!(active.protocol, PlaybackProtocol::MpegTs);
            wait_for_bytes(&lib, &active.id).await;
            if master {
                let high = hls.requests[0].load(Ordering::Relaxed);
                let low = hls.requests[1].load(Ordering::Relaxed);
                wait_until(|| hls.requests[0].load(Ordering::Relaxed) >= high + 2).await;
                assert!(
                    hls.requests[1].load(Ordering::Relaxed) <= low + 1,
                    "未选中的 variant 不应持续下载"
                );
            } else {
                hls.stall.store(true, Ordering::Relaxed);
                wait_until(|| hls.stalled.load(Ordering::Relaxed) > 0).await;
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
            let stopped = lib.stop(&active.id).await.unwrap();
            let path = assert_completed_file(&lib, &stopped);
            let stored = read_stored(&lib.root, &active.id).unwrap();
            assert_eq!(stored.protocol, PlaybackProtocol::MpegTs);
            assert!(stored.media_file.ends_with(".ts"));
            let output = ffmpeg_next::format::input(&path).unwrap();
            for medium in [
                ffmpeg_next::media::Type::Video,
                ffmpeg_next::media::Type::Audio,
            ] {
                assert!(
                    output
                        .streams()
                        .any(|stream| stream.parameters().medium() == medium)
                );
            }
        }
    }
}
