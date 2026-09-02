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
use crate::stream_proxy::request_header;

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
const MAX_ACTIVE_RECORDINGS: usize = 4;
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
        let mut library = RecordingLibraryIndex::default();
        for root in &state.roots {
            if let Err(error) = recover_stale_recordings(root) {
                if *root == state.default_root {
                    return Err(error);
                }
                tracing::warn!(path = %root.display(), error = %error, "无法恢复历史录制目录");
            }
            library.replace_root(root.clone(), scan_recording_root(root));
        }
        let storage = Arc::new(Mutex::new(state));
        let library = Arc::new(Mutex::new(library));
        let events = Arc::new(RecordingEventSink::default());
        Ok(Self {
            _instance_lock: instance_lock,
            playback: PlaybackServer::new(storage.clone()),
            storage,
            library,
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
        Ok(self.storage_info())
    }

    pub fn list(&self) -> AppResult<Vec<RecordingItem>> {
        let tracked_states: Vec<_> = {
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
        };
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
        items.sort_by(|left, right| {
            right
                .started_at
                .cmp(&left.started_at)
                .then_with(|| left.id.cmp(&right.id))
        });
        Ok(items)
    }

    pub async fn start_with_ffmpeg_options(
        &self,
        input: RecordingStartInput,
        proxy: Option<&str>,
        ffmpeg_options: FfmpegRecordingOptions,
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
        validate_recording_source(source_protocol, &input.source, proxy)?;
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
        if sessions.len() + finalizing.len() >= MAX_ACTIVE_RECORDINGS {
            return Err(AppError::new(
                "recording_limit_reached",
                format!("最多同时录制 {MAX_ACTIVE_RECORDINGS} 路直播"),
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
        let stream_client = http_client::recording_stream_client_for_proxy(proxy)?;

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
        let proxy = proxy.map(str::to_string);
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
                    proxy.clone(),
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
    proxy: Option<String>,
    ffmpeg_options: FfmpegRecordingOptions,
    state: Arc<SessionState>,
    cancel: watch::Receiver<bool>,
) -> TaskOutcome {
    match source.protocol {
        PlaybackProtocol::Flv | PlaybackProtocol::Hls | PlaybackProtocol::MpegTs => {
            run_ffmpeg_recording(source, proxy, ffmpeg_options, state, cancel).await
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
    proxy: Option<String>,
    ffmpeg_options: FfmpegRecordingOptions,
    state: Arc<SessionState>,
    mut cancel: watch::Receiver<bool>,
) -> TaskOutcome {
    let twitch_recovery = source.twitch_ad_recovery.clone();
    if source.protocol != PlaybackProtocol::Hls || twitch_recovery.is_none() {
        return ffmpeg_backend::run(source, proxy, ffmpeg_options, state, cancel).await;
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
            true,
            proxy.as_deref(),
            twitch_recovery,
        )
        .await
    {
        Ok(url) => url,
        Err(error) => {
            return TaskOutcome {
                status: RecordingStatus::Failed,
                error: Some(format!("启动 Twitch 录制清单代理失败: {}", error.message)),
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
    let outcome = ffmpeg_backend::run(source, None, ffmpeg_options, state, cancel).await;
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
    proxy: Option<&str>,
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
    if let Some(proxy) = proxy.map(str::trim).filter(|value| !value.is_empty()) {
        let proxy_url =
            Url::parse(proxy).map_err(|_| AppError::new("proxy_invalid", "代理地址无效"))?;
        if !matches!(proxy_url.scheme(), "http" | "https") || proxy.contains(['\0', '\r', '\n']) {
            return Err(AppError::new(
                "recording_proxy_unsupported",
                "Rust FFmpeg 实验后端仅支持 HTTP(S) 代理",
            ));
        }
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
    use super::{
        ActiveSessionState, AssExportOptions, CONTINUE_ON_LEAVE_DEFAULT, FfmpegRecordingOptions,
        FinalizingSession, MINIMUM_FREE_SPACE_BYTES, RECORDING_METADATA_VERSION,
        RECORDING_STORAGE_CONFIG_VERSION, RecordingEventSink, RecordingLibraryIndex,
        RecordingManager, RecordingStartInput, RecordingStatus, RecordingStorageConfig, Session,
        SessionState, StoredDanmakuBatch, StoredRecording, TaskOutcome, create_recording_bundle,
        decode_playback_relative_path, find_bundle_in_root, finish_session, is_safe_recording_id,
        load_storage_state, local_playback_url, media_file_name, parse_range, prepare_storage_root,
        read_stored, recording_bundle_room_dir, recording_bundle_session_dir, recording_file_stem,
        recording_timestamp, recover_bundle_sidecars, recover_stale_recordings, safe_relative_path,
        salvage_temporary_media_after_worker_failure, scan_recording_root,
        stop_sessions_until_deadline, storage_space_is_low, stored_keeps_background_danmaku,
        wait_for_finalizing_sessions, write_metadata,
    };
    use crate::models::live::{DanmakuEvent, DanmakuKind, PlaybackProtocol};
    use percent_encoding::percent_decode_str;
    use reqwest::Url;
    use std::collections::HashMap;
    use std::fs::OpenOptions;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::{Arc, Barrier, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::sync::{oneshot, watch};
    use uuid::Uuid;

    /// 磁盘形态的录制 id：`<platform>_<room>/<user>_<time>`。
    /// 手工创建分卷的测试必须自行 `create_dir_all`，
    /// 因为 id 现在跨越房间目录与会话目录。
    fn test_recording_id() -> String {
        format!("bilibili_{}/主播_20260820-192158", Uuid::new_v4())
    }

    #[test]
    fn names_recording_media_from_user_title_and_start_time() {
        let stem = recording_file_stem("主播:甲", "标题/测试", 1_700_000_000_000);

        assert!(stem.starts_with("主播_甲_标题_测试_"));
        assert!(!stem.contains(':'));
        assert!(!stem.contains('/'));
        assert_eq!(
            media_file_name(
                PlaybackProtocol::Flv,
                "https://example.test/live.flv",
                &stem
            ),
            format!("{stem}.flv")
        );
        assert_eq!(
            media_file_name(
                PlaybackProtocol::MpegTs,
                "https://example.test/live.m3u8",
                &stem
            ),
            format!("{stem}.ts")
        );
    }

    #[test]
    fn names_recording_bundles_from_platform_and_room_without_overwriting() {
        let root = std::env::temp_dir().join(format!("rlive-recording-name-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let input = manager_test_input("https://example.test/live.flv", "live:bilibili:100", "100");
        let started_at = 1_700_000_000_000;

        let room_dir = recording_bundle_room_dir(&input);
        assert_eq!(room_dir, "bilibili_100");
        let session_dir = recording_bundle_session_dir(&input, started_at);
        // 会话层级把用户名与媒体文件携带的同一时间戳配对，
        // 因此分卷与其中的文件相互对应。
        assert!(session_dir.ends_with(&recording_timestamp(started_at)));

        let roots = [root.clone()];
        let (first, first_id) =
            create_recording_bundle(&root, &roots, &room_dir, &session_dir).unwrap();
        let (_second, second_id) =
            create_recording_bundle(&root, &roots, &room_dir, &session_dir).unwrap();
        let (_third, third_id) =
            create_recording_bundle(&root, &roots, &room_dir, &session_dir).unwrap();

        // 同一房间的所有会话共享房间目录；只有会话层级
        // 在两者冲突时追加后缀。
        assert_eq!(first, root.join(&room_dir).join(&session_dir));
        assert_eq!(first_id, format!("{room_dir}/{session_dir}"));
        assert_eq!(second_id, format!("{room_dir}/{session_dir}_1"));
        assert_eq!(third_id, format!("{room_dir}/{session_dir}_2"));
        assert!(first.starts_with(root.join(&room_dir)));

        let historical_root =
            root.with_file_name(format!("rlive-recording-name-history-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&historical_root).unwrap();
        let all_roots = [historical_root.clone(), root.clone()];
        let (_historical, historical_id) =
            create_recording_bundle(&historical_root, &all_roots, &room_dir, &session_dir).unwrap();
        // id 在所有存储根中寻址同一场录制，
        // 因此在另一个根中已被占用的名字会被跳过而不是复用。
        assert_eq!(historical_id, format!("{room_dir}/{session_dir}_3"));

        let mut iptv = input;
        iptv.site_id = None;
        iptv.room_id = None;
        iptv.source_kind = "iptv".into();
        iptv.source_key = "iptv:source:cctv1".into();
        assert_eq!(recording_bundle_room_dir(&iptv), "iptv_cctv1");

        std::fs::remove_dir_all(root).unwrap();
        std::fs::remove_dir_all(historical_root).unwrap();
    }

    #[test]
    fn scan_finds_nested_bundles_and_ignores_single_level_ones() {
        let root = std::env::temp_dir().join(format!("rlive-recording-scan-{}", Uuid::new_v4()));

        // 同一房间的两个会话共用一个房间目录。
        let first_id = "bilibili_100/主播_20260820-192158".to_string();
        let second_id = "bilibili_100/主播_20260820-193000".to_string();
        for id in [&first_id, &second_id] {
            let bundle = root.join(id);
            std::fs::create_dir_all(&bundle).unwrap();
            write_metadata(&bundle, &completed_recording(id.clone(), "100")).unwrap();
        }

        // 嵌套布局之前的单级分卷：它的元数据在上一级，
        // 两级扫描不会触及它。文件原样留在磁盘上。
        let legacy = root.join("bilibili_legacy");
        std::fs::create_dir_all(&legacy).unwrap();
        write_metadata(
            &legacy,
            &completed_recording("bilibili_legacy".into(), "legacy"),
        )
        .unwrap();

        let found = scan_recording_root(&root);
        assert_eq!(found.len(), 2);
        assert!(found.contains_key(&first_id));
        assert!(found.contains_key(&second_id));
        assert!(!found.contains_key("bilibili_legacy"));
        assert!(legacy.join("metadata.json").is_file());

        // 两个会话都能通过 id 解析回各自的分卷。
        let roots = [root.clone()];
        assert_eq!(
            find_bundle_in_root(&roots, &first_id).unwrap().1,
            root.join(&first_id)
        );
        assert!(find_bundle_in_root(&roots, "bilibili_legacy").is_none());

        std::fs::remove_dir_all(root).unwrap();
    }

    /// 删除时也要把该录制从缓存的库索引中去掉。
    ///
    /// 索引按存储根索引。在嵌套布局下从 `bundle.parent()` 推导出的
    /// 是房间目录，匹配不到任何索引条目，
    /// 于是被删除的卡片在每次刷新时都会重新出现。
    #[test]
    fn deleting_a_recording_also_drops_it_from_the_library_index() {
        let app_directory =
            std::env::temp_dir().join(format!("rlive-recording-delete-{}", Uuid::new_v4()));
        let manager = RecordingManager::new(&app_directory).unwrap();
        let root = PathBuf::from(manager.storage_info().path);

        // 同一房间的两个会话，因此房间目录必须在第一次删除后存活，
        // 只在第二次删除时消失。
        let kept_id = "bilibili_100/主播_20260820-192158".to_string();
        let removed_id = "bilibili_100/主播_20260820-193000".to_string();
        for id in [&kept_id, &removed_id] {
            let bundle = root.join(id);
            std::fs::create_dir_all(&bundle).unwrap();
            write_metadata(&bundle, &completed_recording(id.clone(), "100")).unwrap();
        }

        // 先执行列表操作，正是它填充缓存的索引。
        let listed = manager.list().unwrap();
        assert_eq!(listed.len(), 2);

        manager.delete(&removed_id).unwrap();
        let after = manager.list().unwrap();
        assert_eq!(
            after
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            [kept_id.as_str()],
            "删除后的录制不应继续出现在列表中"
        );
        assert!(!root.join(&removed_id).exists());
        // 留存下来的会话保留共享的房间目录。
        assert!(root.join("bilibili_100").is_dir());

        manager.delete(&kept_id).unwrap();
        assert!(manager.list().unwrap().is_empty());
        // 房间的最后一个会话删除时带走被清空的房间目录。
        assert!(!root.join("bilibili_100").exists());

        // 删除已经不存在的内容仍然视为成功。
        manager.delete(&removed_id).unwrap();

        drop(manager);
        std::fs::remove_dir_all(app_directory).ok();
    }

    #[test]
    fn recording_id_accepts_two_levels_and_rejects_traversal() {
        assert!(is_safe_recording_id("bilibili_100/user_20260820-192158"));
        assert!(is_safe_recording_id("iptv_cctv1/未知用户_20260820-192158"));

        // 单级属于嵌套之前的布局，已不再构成有效 id。
        assert!(!is_safe_recording_id("bilibili_100"));
        // 三级会让某个分卷藏到其房间目录之下。
        assert!(!is_safe_recording_id("bilibili_100/user_1/extra"));
        assert!(!is_safe_recording_id(&Uuid::new_v4().to_string()));

        // 路径穿越、绝对路径和仅含点的层级仍然被拒绝：
        // 这是把播放与删除限制在存储根之内的唯一守卫。
        assert!(!is_safe_recording_id("../bilibili_100/user_1"));
        assert!(!is_safe_recording_id("bilibili_100/../../etc"));
        assert!(!is_safe_recording_id("bilibili_100/.."));
        assert!(!is_safe_recording_id("bilibili_100/."));
        assert!(!is_safe_recording_id("/bilibili_100/user_1"));
        assert!(!is_safe_recording_id("bilibili_100//user_1"));
        assert!(!is_safe_recording_id("bilibili_100/user_1/"));
        assert!(!is_safe_recording_id("bilibili_100\\user_1"));
        assert!(!is_safe_recording_id("bilibili:100/user_1"));
        // 房间层级仍必须符合 `<platform>_<room>` 形态。
        assert!(!is_safe_recording_id("bilibili/user_1"));
        assert!(!is_safe_recording_id("_100/user_1"));
        // 末尾的点号和首尾空白会破坏 Windows 路径。
        assert!(!is_safe_recording_id("bilibili_100/user_1."));
        assert!(!is_safe_recording_id("bilibili_100./user_1"));
        assert!(!is_safe_recording_id(" bilibili_100/user_1"));
        assert!(!is_safe_recording_id("bilibili_100/user_1 "));
    }

    #[test]
    fn recording_space_guard_keeps_its_reserve_boundary() {
        assert!(storage_space_is_low(MINIMUM_FREE_SPACE_BYTES - 1));
        assert!(!storage_space_is_low(MINIMUM_FREE_SPACE_BYTES));
        assert!(!storage_space_is_low(MINIMUM_FREE_SPACE_BYTES + 1));
    }

    #[test]
    fn recovery_counts_valid_danmaku_before_an_incomplete_tail() {
        let root = std::env::temp_dir().join(format!("rlive-danmaku-count-{}", Uuid::new_v4()));
        let id = test_recording_id();
        let bundle = root.join(&id);
        std::fs::create_dir_all(&bundle).unwrap();
        let mut stored = completed_recording(id, "danmaku-count");
        stored.include_danmaku = true;
        stored.danmaku_file = Some("danmaku.jsonl".into());
        let events = vec![
            DanmakuEvent {
                kind: DanmakuKind::Chat,
                user: "viewer-1".into(),
                is_self: false,
                user_id: None,
                content: "first".into(),
                color: None,
                spans: None,
                super_chat: None,
                ts: 1,
            },
            DanmakuEvent {
                kind: DanmakuKind::Chat,
                user: "viewer-2".into(),
                is_self: false,
                user_id: None,
                content: "second".into(),
                color: None,
                spans: None,
                super_chat: None,
                ts: 2,
            },
        ];
        let batch = serde_json::to_string(&StoredDanmakuBatch {
            offset_ms: 10,
            events: &events,
        })
        .unwrap();
        std::fs::write(
            bundle.join("danmaku.jsonl"),
            format!("{batch}\n{{\"offset_ms\":"),
        )
        .unwrap();

        assert_eq!(super::count_recorded_danmaku(&bundle, &stored), Some(2));

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn concurrent_metadata_replacements_leave_a_valid_bundle() {
        let root = std::env::temp_dir().join(format!("rlive-metadata-write-{}", Uuid::new_v4()));
        let id = test_recording_id();
        let bundle = root.join(&id);
        std::fs::create_dir_all(&bundle).unwrap();
        let stored = completed_recording(id, "metadata");
        write_metadata(&bundle, &stored).unwrap();

        let barrier = Arc::new(Barrier::new(8));
        let handles: Vec<_> = (0..8)
            .map(|index| {
                let barrier = barrier.clone();
                let bundle = bundle.clone();
                let mut stored = stored.clone();
                stored.title = format!("metadata-{index}");
                std::thread::spawn(move || {
                    barrier.wait();
                    write_metadata(&bundle, &stored).unwrap();
                })
            })
            .collect();
        for handle in handles {
            handle.join().unwrap();
        }

        let persisted: StoredRecording =
            serde_json::from_slice(&std::fs::read(bundle.join("metadata.json")).unwrap()).unwrap();
        assert!(persisted.title.starts_with("metadata-"));
        assert!(!bundle.join("metadata.json.tmp").exists());
        assert!(!bundle.join("metadata.json.bak").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn startup_recovery_prefers_valid_metadata_tmp_over_old_backup() {
        let root = std::env::temp_dir().join(format!("rlive-metadata-recovery-{}", Uuid::new_v4()));
        let id = test_recording_id();
        let bundle = root.join(&id);
        std::fs::create_dir_all(&bundle).unwrap();
        // id 跨越分卷的两级，因此不可能来自 `file_name()`。
        let mut old = completed_recording(id, "old");
        old.status = RecordingStatus::Recording;
        let mut next = old.clone();
        next.status = RecordingStatus::Completed;
        next.title = "new".into();
        std::fs::write(
            bundle.join("metadata.json.bak"),
            serde_json::to_vec_pretty(&old).unwrap(),
        )
        .unwrap();
        std::fs::write(
            bundle.join("metadata.json.tmp"),
            serde_json::to_vec_pretty(&next).unwrap(),
        )
        .unwrap();

        recover_bundle_sidecars(&bundle).unwrap();

        let recovered: StoredRecording =
            serde_json::from_slice(&std::fs::read(bundle.join("metadata.json")).unwrap()).unwrap();
        assert_eq!(recovered.title, "new");
        assert!(!bundle.join("metadata.json.bak").exists());
        assert!(!bundle.join("metadata.json.tmp").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn parses_ranges_and_suffix_ranges() {
        assert_eq!(
            parse_range(Some("bytes=10-20"), 100).unwrap(),
            (206, 10, 20)
        );
        assert_eq!(parse_range(Some("bytes=90-"), 100).unwrap(), (206, 90, 99));
        assert_eq!(parse_range(Some("bytes=-10"), 100).unwrap(), (206, 90, 99));
        assert_eq!(parse_range(None, 0).unwrap(), (200, 0, 0));
        assert!(parse_range(Some("bytes=0-0"), 0).is_err());
        assert!(parse_range(Some("bytes=0-1,4-5"), 100).is_err());
    }

    #[test]
    fn local_playback_paths_stay_inside_the_recording_bundle() {
        assert!(safe_relative_path(
            PathBuf::from("segments/0001.ts").as_path()
        ));
        assert!(!safe_relative_path(PathBuf::new().as_path()));
        assert!(!safe_relative_path(
            PathBuf::from("../metadata.json").as_path()
        ));
        assert!(!safe_relative_path(
            PathBuf::from("metadata.json").as_path()
        ));
    }

    #[test]
    fn local_playback_urls_round_trip_unicode_and_spaces() {
        let id = "斗鱼_房间 100/斗鱼主播_20260816-120000";
        let file = "斗鱼主播_标题 测试_20260816-120000.flv";
        let url = local_playback_url("http://127.0.0.1:1234", "token", id, file).unwrap();

        assert!(url.contains("%E6%96%97%E9%B1%BC_%E6%88%BF%E9%97%B4%20100"));
        assert!(url.contains("%E6%96%97%E9%B1%BC%E4%B8%BB%E6%92%AD"));
        assert!(url.contains("%20"));
        let parsed = Url::parse(&url).unwrap();
        let segments = parsed.path_segments().unwrap().collect::<Vec<_>>();
        // id 在 token 之后占据两段，回放服务器恰好重新拼接这两段。
        // 编码端与解析端必须在此一致，
        // 否则每场录制都会以 404 播放。
        let room = percent_decode_str(segments[1]).decode_utf8().unwrap();
        let session = percent_decode_str(segments[2]).decode_utf8().unwrap();
        assert_eq!(format!("{room}/{session}"), id);
        assert!(is_safe_recording_id(&format!("{room}/{session}")));
        // id 内部的分隔符不能原样保留，否则两级会坍缩成一个不可用的段。
        assert!(!segments[1].contains("%2F"));
        let encoded = segments.last().unwrap().to_string();
        assert_eq!(
            decode_playback_relative_path([encoded.as_str()]),
            Some(PathBuf::from(file))
        );
    }

    #[test]
    fn encoded_playback_paths_cannot_add_separators_or_parent_segments() {
        assert!(decode_playback_relative_path(["%2E%2E", "metadata.json"]).is_none());
        assert!(decode_playback_relative_path(["segments%2Fsecret.ts"]).is_none());
        assert!(decode_playback_relative_path(["segments%5Csecret.ts"]).is_none());
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

    #[test]
    fn recording_library_index_respects_root_priority_and_incremental_updates() {
        let primary_root = PathBuf::from("primary");
        let fallback_root = PathBuf::from("fallback");
        let id = test_recording_id();
        let fallback = completed_recording(id.clone(), "fallback");
        let primary = completed_recording(id.clone(), "primary");
        let mut index = RecordingLibraryIndex::default();
        index.replace_root(
            fallback_root.clone(),
            HashMap::from([(id.clone(), fallback)]),
        );
        index.replace_root(primary_root.clone(), HashMap::from([(id.clone(), primary)]));

        let items = index.items(&[primary_root.clone(), fallback_root.clone()]);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].title, "primary");

        let updated = completed_recording(id.clone(), "updated");
        index.upsert(&primary_root, updated);
        assert_eq!(
            index.items(&[primary_root.clone(), fallback_root.clone()])[0].title,
            "updated"
        );

        index.remove(&primary_root, &id);
        assert_eq!(
            index.items(&[primary_root, fallback_root])[0].title,
            "fallback"
        );
    }

    #[test]
    fn recording_library_index_rebuilds_after_external_bundle_addition() {
        let root = std::env::temp_dir().join(format!("rlive-recording-index-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let mut index = RecordingLibraryIndex::default();
        index.replace_root(root.clone(), scan_recording_root(&root));
        assert!(index.items(std::slice::from_ref(&root)).is_empty());

        let stored = completed_recording(test_recording_id(), "external");
        let bundle = root.join(&stored.id);
        std::fs::create_dir_all(&bundle).unwrap();
        std::fs::write(bundle.join("stream.flv"), b"media").unwrap();
        write_metadata(&bundle, &stored).unwrap();
        // 单元测试中避免依赖文件系统的时间戳精度，
        // 同时仍然走生产代码使用的同一个过期根分支。
        index.roots.get_mut(&root).unwrap().modified_at = None;

        index.refresh_changed_roots(std::slice::from_ref(&root));

        let items = index.items(std::slice::from_ref(&root));
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].title, "external");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn recording_scan_skips_an_old_metadata_version_without_modifying_it() {
        let root =
            std::env::temp_dir().join(format!("rlive-recording-old-metadata-{}", Uuid::new_v4()));
        let stored = completed_recording(test_recording_id(), "old-metadata");
        let bundle = root.join(&stored.id);
        std::fs::create_dir_all(&bundle).unwrap();
        std::fs::write(bundle.join(&stored.media_file), b"old-media").unwrap();
        let mut value = serde_json::to_value(stored).unwrap();
        value["schema_version"] = serde_json::json!(1);
        let metadata = serde_json::to_vec_pretty(&value).unwrap();
        std::fs::write(bundle.join("metadata.json"), &metadata).unwrap();

        assert!(scan_recording_root(&root).is_empty());
        assert_eq!(
            std::fs::read(bundle.join("metadata.json")).unwrap(),
            metadata
        );
        assert!(bundle.join("stream.flv").is_file());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn only_background_sidecar_recordings_retain_danmaku_connections() {
        let mut stored = completed_recording("recording".into(), "room");
        stored.status = RecordingStatus::Recording;
        stored.include_danmaku = true;
        stored.continue_on_leave = true;
        assert!(stored_keeps_background_danmaku(
            &stored,
            "live:bilibili:room"
        ));

        stored.continue_on_leave = false;
        assert!(!stored_keeps_background_danmaku(
            &stored,
            "live:bilibili:room"
        ));
        stored.continue_on_leave = true;
        stored.include_danmaku = false;
        assert!(!stored_keeps_background_danmaku(
            &stored,
            "live:bilibili:room"
        ));
        stored.include_danmaku = true;
        assert!(!stored_keeps_background_danmaku(
            &stored,
            "live:bilibili:other"
        ));
    }

    #[test]
    fn pending_background_start_retains_danmaku_before_session_commit() {
        let app_directory = std::env::temp_dir().join(format!(
            "rlive-recording-pending-danmaku-{}",
            Uuid::new_v4()
        ));
        let manager = RecordingManager::new(&app_directory).unwrap();
        let danmaku = crate::danmu_rs::DanmakuManager::new();
        let source = "live:bilibili:pending-start";

        assert!(danmaku.begin_connect(100, source.into(), false));
        {
            let _reservation = manager.reserve_background_danmaku_start(source, true);
            assert!(manager.has_background_danmaku_recording(source));
            // 这与录制启动路径仍在进行文件系统/后端初始化时
            // danmaku_disconnect 做出的决定一致。
            assert!(danmaku.detach_for_generation(101));
        }
        assert!(!manager.has_background_danmaku_recording(source));
        assert!(danmaku.disconnect_background_for_source(source));

        drop(manager);
        std::fs::remove_dir_all(app_directory).unwrap();
    }

    #[tokio::test]
    async fn continue_on_leave_flag_retains_background_danmaku_after_leave_guard() {
        let app_directory = std::env::temp_dir().join(format!(
            "rlive-recording-continue-on-leave-{}",
            Uuid::new_v4()
        ));
        let manager = RecordingManager::new(&app_directory).unwrap();
        let root = PathBuf::from(manager.storage_info().path);
        let id = test_recording_id();
        let bundle = root.join(&id);
        std::fs::create_dir_all(&bundle).unwrap();
        let state = active_session_state(root.clone(), bundle.clone(), id.clone());
        {
            let mut stored = state.stored.lock().unwrap();
            stored.source_key = "live:douyu:100".into();
            stored.include_danmaku = true;
            stored.continue_on_leave = false;
            stored.danmaku_file = Some("danmaku.jsonl".into());
        }
        let (cancel, _cancel_rx) = watch::channel(false);
        let task = tauri::async_runtime::spawn(std::future::pending::<()>());
        manager.sessions.lock().unwrap().insert(
            id.clone(),
            Session {
                active: Arc::new(ActiveSessionState::new(state.clone())),
                cancel,
                task,
            },
        );

        // 未选择后台延续的房间录制不会保留任何弹幕连接，
        // 直到离开拦截翻转标记。
        assert!(!manager.has_background_danmaku_recording("live:douyu:100"));
        let item = manager.set_continue_on_leave(&id, true).unwrap();
        assert!(item.continue_on_leave);
        assert!(manager.has_background_danmaku_recording("live:douyu:100"));
        // 持久化的元数据携带新标记，重启后仍遵循同一契约。
        assert!(read_stored(&root, &id).unwrap().continue_on_leave);

        drop(manager);
        std::fs::remove_dir_all(app_directory).unwrap();
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

    #[test]
    fn finalizing_session_accepts_the_last_danmaku_batch() {
        let app_directory =
            std::env::temp_dir().join(format!("rlive-recording-final-danmaku-{}", Uuid::new_v4()));
        let manager = RecordingManager::new(&app_directory).unwrap();
        let root = PathBuf::from(manager.storage_info().path);
        let id = test_recording_id();
        let bundle = root.join(&id);
        std::fs::create_dir_all(&bundle).unwrap();
        let state = active_session_state(root, bundle.clone(), id.clone());
        let source = "live:bilibili:final-batch";
        {
            let mut stored = state.stored.lock().unwrap();
            stored.source_key = source.into();
            stored.include_danmaku = true;
            stored.continue_on_leave = true;
            stored.danmaku_file = Some("danmaku.jsonl".into());
        }
        *state.danmaku_writer.lock().unwrap() = Some(
            OpenOptions::new()
                .create(true)
                .append(true)
                .open(bundle.join("danmaku.jsonl"))
                .unwrap(),
        );
        manager.finalizing.lock().unwrap().insert(
            id,
            FinalizingSession {
                state: state.clone(),
            },
        );

        manager.capture_danmaku(
            source,
            &[DanmakuEvent {
                kind: DanmakuKind::Chat,
                user: "viewer".into(),
                is_self: false,
                user_id: None,
                content: "final".into(),
                color: None,
                spans: None,
                super_chat: None,
                ts: 1,
            }],
        );

        assert_eq!(state.danmaku_count.load(Ordering::Acquire), 1);
        assert!(
            !std::fs::read(bundle.join("danmaku.jsonl"))
                .unwrap()
                .is_empty()
        );

        drop(manager);
        *state.danmaku_writer.lock().unwrap() = None;
        drop(state);
        std::fs::remove_dir_all(app_directory).unwrap();
    }

    struct TaskDropFlag(Arc<AtomicBool>);

    impl Drop for TaskDropFlag {
        fn drop(&mut self) {
            self.0.store(true, Ordering::Release);
        }
    }

    #[tokio::test]
    async fn graceful_shutdown_waits_for_recording_finalization() {
        let app_directory =
            std::env::temp_dir().join(format!("rlive-recording-shutdown-{}", Uuid::new_v4()));
        let manager = RecordingManager::new(&app_directory).unwrap();
        let root = PathBuf::from(manager.storage_info().path);
        let id = test_recording_id();
        let bundle = root.join(&id);
        std::fs::create_dir_all(&bundle).unwrap();
        let state = active_session_state(root, bundle.clone(), id.clone());
        let (cancel, mut cancel_rx) = watch::channel(false);
        let task_state = state.clone();
        let task = tauri::async_runtime::spawn(async move {
            if !*cancel_rx.borrow() {
                let _ = cancel_rx.changed().await;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            finish_session(
                &task_state,
                TaskOutcome {
                    status: RecordingStatus::Completed,
                    error: None,
                    split: false,
                },
            );
        });
        manager.sessions.lock().unwrap().insert(
            id.clone(),
            Session {
                active: Arc::new(ActiveSessionState::new(state.clone())),
                cancel,
                task,
            },
        );

        manager.stop_all_graceful().await;
        manager.stop_all_graceful().await;

        assert!(manager.sessions.lock().unwrap().is_empty());
        assert!(state.finished.load(Ordering::Acquire));
        let stored = super::read_stored(&PathBuf::from(manager.storage_info().path), &id).unwrap();
        assert_eq!(stored.status, RecordingStatus::Completed);
        assert!(stored.ended_at.is_some());
        drop(manager);
        std::fs::remove_dir_all(app_directory).unwrap();
    }

    #[tokio::test]
    async fn graceful_shutdown_defers_hard_abort_recovery_until_restart() {
        let root = std::env::temp_dir().join(format!("rlive-recording-timeout-{}", Uuid::new_v4()));
        let id = test_recording_id();
        let bundle = root.join(&id);
        std::fs::create_dir_all(&bundle).unwrap();
        let state = active_session_state(root.clone(), bundle.clone(), id.clone());
        std::fs::write(bundle.join("stream.flv.part"), b"partial-media").unwrap();
        state.bytes.store(13, Ordering::Relaxed);
        let (cancel, cancel_rx) = watch::channel(false);
        let task_dropped = Arc::new(AtomicBool::new(false));
        let task_drop_flag = task_dropped.clone();
        let (task_started, task_started_rx) = oneshot::channel();
        let task = tauri::async_runtime::spawn(async move {
            let _drop_flag = TaskDropFlag(task_drop_flag);
            let _cancel_rx = cancel_rx;
            let _ = task_started.send(());
            std::future::pending::<()>().await;
        });
        task_started_rx.await.unwrap();

        stop_sessions_until_deadline(
            vec![(
                id.clone(),
                Session {
                    active: Arc::new(ActiveSessionState::new(state.clone())),
                    cancel,
                    task,
                },
            )],
            tokio::time::Instant::now(),
        )
        .await;

        assert!(task_dropped.load(Ordering::Acquire));
        assert!(!state.finished.load(Ordering::Acquire));
        assert!(bundle.join("stream.flv.part").exists());
        assert!(!bundle.join("stream.flv").exists());
        assert_eq!(
            super::read_stored(&root, &id).unwrap().status,
            RecordingStatus::Recording
        );

        recover_stale_recordings(&root).unwrap();

        assert!(!bundle.join("stream.flv.part").exists());
        assert_eq!(
            std::fs::read(bundle.join("stream.flv")).unwrap(),
            b"partial-media"
        );
        let stored = super::read_stored(&root, &id).unwrap();
        assert_eq!(stored.status, RecordingStatus::Interrupted);
        assert!(stored.ended_at.is_some());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn recovery_adopts_a_media_part_left_by_a_failed_recording_task() {
        let root = std::env::temp_dir().join(format!("rlive-recording-orphan-{}", Uuid::new_v4()));
        let id = test_recording_id();
        let bundle = root.join(&id);
        std::fs::create_dir_all(&bundle).unwrap();
        let stored = StoredRecording {
            id: id.clone(),
            status: RecordingStatus::Failed,
            media_file: "stream.flv".into(),
            error: Some("发布录制文件失败".into()),
            ..completed_recording(id.clone(), "orphan")
        };
        std::fs::write(bundle.join("stream.flv.part"), b"partial-media").unwrap();
        write_metadata(&bundle, &stored).unwrap();

        recover_stale_recordings(&root).unwrap();

        assert!(!bundle.join("stream.flv.part").exists());
        assert_eq!(
            std::fs::read(bundle.join("stream.flv")).unwrap(),
            b"partial-media"
        );
        let recovered = read_stored(&root, &id).unwrap();
        assert_eq!(recovered.status, RecordingStatus::Interrupted);
        assert!(recovered.ended_at.is_some());
        assert!(recovered.error.is_some());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn worker_failure_salvages_a_safe_media_part_without_overwriting_final_media() {
        let root =
            std::env::temp_dir().join(format!("rlive-recording-worker-failure-{}", Uuid::new_v4()));
        let id = test_recording_id();
        let bundle = root.join(&id);
        std::fs::create_dir_all(&bundle).unwrap();
        let state = active_session_state(root.clone(), bundle.clone(), id);
        std::fs::write(bundle.join("stream.flv.part"), b"partial-media").unwrap();

        salvage_temporary_media_after_worker_failure(&state);

        assert!(!bundle.join("stream.flv.part").exists());
        assert_eq!(
            std::fs::read(bundle.join("stream.flv")).unwrap(),
            b"partial-media"
        );
        std::fs::write(bundle.join("stream.flv.part"), b"new-partial").unwrap();
        salvage_temporary_media_after_worker_failure(&state);
        assert_eq!(
            std::fs::read(bundle.join("stream.flv")).unwrap(),
            b"partial-media"
        );
        assert_eq!(
            std::fs::read(bundle.join("stream.flv.part")).unwrap(),
            b"new-partial"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn recovery_marks_missing_active_media_as_interrupted() {
        let root = std::env::temp_dir().join(format!("rlive-recording-missing-{}", Uuid::new_v4()));
        let id = test_recording_id();
        let bundle = root.join(&id);
        std::fs::create_dir_all(&bundle).unwrap();
        let stored = StoredRecording {
            id: id.clone(),
            status: RecordingStatus::Recording,
            media_file: "stream.flv".into(),
            ..completed_recording(id.clone(), "missing")
        };
        write_metadata(&bundle, &stored).unwrap();

        recover_stale_recordings(&root).unwrap();

        let recovered = read_stored(&root, &id).unwrap();
        assert_eq!(recovered.status, RecordingStatus::Interrupted);
        assert!(recovered.ended_at.is_some());
        assert!(
            recovered
                .error
                .as_deref()
                .is_some_and(|error| error.contains("媒体文件缺失"))
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn recovery_rejects_a_media_path_that_escapes_the_bundle() {
        let root = std::env::temp_dir().join(format!("rlive-recording-path-{}", Uuid::new_v4()));
        let id = test_recording_id();
        let bundle = root.join(&id);
        std::fs::create_dir_all(&bundle).unwrap();
        let stored = StoredRecording {
            id: id.clone(),
            status: RecordingStatus::Recording,
            media_file: "../outside.flv".into(),
            ..completed_recording(id.clone(), "invalid path")
        };
        write_metadata(&bundle, &stored).unwrap();

        recover_stale_recordings(&root).unwrap();

        let recovered = read_stored(&root, &id).unwrap();
        assert_eq!(recovered.status, RecordingStatus::Interrupted);
        assert!(
            recovered
                .error
                .as_deref()
                .is_some_and(|error| error.contains("媒体路径无效"))
        );
        assert!(!root.join("outside.flv").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn graceful_shutdown_leaves_another_stop_request_for_process_exit() {
        let root = std::env::temp_dir().join(format!(
            "rlive-recording-finalize-timeout-{}",
            Uuid::new_v4()
        ));
        let id = test_recording_id();
        let bundle = root.join(&id);
        std::fs::create_dir_all(&bundle).unwrap();
        let state = active_session_state(root.clone(), bundle.clone(), id.clone());
        std::fs::write(bundle.join("stream.flv.part"), b"partial-media").unwrap();
        state.bytes.store(13, Ordering::Relaxed);
        let task_dropped = Arc::new(AtomicBool::new(false));
        let task_drop_flag = task_dropped.clone();
        let (task_started_tx, task_started_rx) = oneshot::channel();
        let task = tauri::async_runtime::spawn(async move {
            let _drop_flag = TaskDropFlag(task_drop_flag);
            let _ = task_started_tx.send(());
            std::future::pending::<()>().await;
        });
        task_started_rx.await.unwrap();
        wait_for_finalizing_sessions(
            vec![(id.clone(), state.clone())],
            tokio::time::Instant::now(),
        )
        .await;
        assert!(!task_dropped.load(Ordering::Acquire));
        assert!(!state.finished.load(Ordering::Acquire));
        assert!(bundle.join("stream.flv.part").exists());
        assert_eq!(
            super::read_stored(&root, &id).unwrap().status,
            RecordingStatus::Recording
        );

        task.abort();
        let _ = task.await;
        assert!(
            task_dropped.load(Ordering::Acquire),
            "测试应模拟进程退出释放停止请求持有的任务"
        );
        recover_stale_recordings(&root).unwrap();

        assert_eq!(
            super::read_stored(&root, &id).unwrap().status,
            RecordingStatus::Interrupted
        );
        assert_eq!(
            std::fs::read(bundle.join("stream.flv")).unwrap(),
            b"partial-media"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn finalizing_session_remains_visible_and_fences_mutations() {
        let app_directory =
            std::env::temp_dir().join(format!("rlive-recording-finalizing-{}", Uuid::new_v4()));
        let manager = RecordingManager::new(&app_directory).unwrap();
        let root = PathBuf::from(manager.storage_info().path);
        let id = test_recording_id();
        let bundle = root.join(&id);
        std::fs::create_dir_all(&bundle).unwrap();
        let state = active_session_state(root, bundle, id.clone());
        let (_cancel, cancel_rx) = watch::channel(false);
        let task = tauri::async_runtime::spawn(async move {
            let _cancel_rx = cancel_rx;
            std::future::pending::<()>().await;
        });
        manager
            .finalizing
            .lock()
            .unwrap()
            .insert(id.clone(), FinalizingSession { state });

        let listed = manager
            .list()
            .unwrap()
            .into_iter()
            .find(|item| item.id == id)
            .unwrap();
        assert_eq!(listed.status, RecordingStatus::Recording);
        assert_eq!(
            manager.delete(&id).unwrap_err().code,
            "recording_still_active"
        );
        assert_eq!(
            manager.stop(&id).await.unwrap_err().code,
            "recording_stopping"
        );
        task.abort();

        let duplicate = manager
            .start_with_ffmpeg_options(
                RecordingStartInput {
                    source: crate::models::live::PlayUrl::inferred(
                        "test:shutdown",
                        "测试线路",
                        0,
                        "https://example.test/live.flv".into(),
                        Default::default(),
                    ),
                    source_key: "live:bilibili:shutdown".into(),
                    source_kind: "live".into(),
                    site_id: Some("bilibili".into()),
                    room_id: Some("shutdown".into()),
                    title: "停止中录制".into(),
                    user_name: "主播".into(),
                    cover: String::new(),
                    user_avatar: String::new(),
                    include_danmaku: Some(false),
                    continue_on_leave: Some(false),
                },
                None,
                FfmpegRecordingOptions::default(),
            )
            .await
            .unwrap_err();
        assert_eq!(duplicate.code, "recording_already_active");

        manager.finalizing.lock().unwrap().remove(&id);
        drop(manager);
        std::fs::remove_dir_all(app_directory).unwrap();
    }

    #[test]
    fn recording_start_input_resolves_missing_options_from_configured_defaults() {
        let mut value = serde_json::to_value(manager_test_input(
            "https://example.test/live.flv",
            "live:bilibili:defaults",
            "defaults",
        ))
        .unwrap();
        let object = value.as_object_mut().unwrap();
        object.remove("includeDanmaku");
        object.remove("continueOnLeave");

        let parsed: RecordingStartInput = serde_json::from_value(value).unwrap();
        assert_eq!(parsed.include_danmaku, None);
        assert_eq!(parsed.continue_on_leave, None);

        // 后台延续已无可配置默认值，未指定的请求总是解析为保持任务存活。
        let resolved = parsed.with_recording_defaults(true);
        assert_eq!(resolved.include_danmaku, Some(true));
        assert_eq!(resolved.continue_on_leave, Some(true));

        let explicit = manager_test_input(
            "https://example.test/live.flv",
            "live:bilibili:explicit",
            "explicit",
        )
        .with_recording_defaults(true);
        assert_eq!(explicit.include_danmaku, Some(false));
        assert_eq!(explicit.continue_on_leave, Some(false));
    }

    #[test]
    fn continue_on_leave_default_is_unconditional() {
        // `Manager::start` 解析出与命令层相同的默认值，因此跳过
        // `with_recording_defaults` 的调用方仍获得后台延续，
        // 而不是静默退出。
        const { assert!(CONTINUE_ON_LEAVE_DEFAULT) };

        let mut unspecified = manager_test_input("https://example.test/live.flv", "live:a", "a");
        unspecified.continue_on_leave = None;
        assert_eq!(
            unspecified
                .clone()
                .with_recording_defaults(false)
                .continue_on_leave,
            Some(CONTINUE_ON_LEAVE_DEFAULT)
        );

        let mut opted_out = unspecified;
        opted_out.continue_on_leave = Some(false);
        assert_eq!(
            opted_out.with_recording_defaults(false).continue_on_leave,
            Some(false)
        );
    }

    #[test]
    fn stored_recording_rejects_missing_background_continuation() {
        let mut legacy_metadata =
            serde_json::to_value(completed_recording("legacy".into(), "legacy")).unwrap();
        let metadata = legacy_metadata.as_object_mut().unwrap();
        metadata.remove("continue_on_leave");
        assert!(serde_json::from_value::<StoredRecording>(legacy_metadata).is_err());
    }

    #[test]
    fn storage_switch_migrates_existing_recordings() {
        let app_directory =
            std::env::temp_dir().join(format!("rlive-recording-storage-{}", Uuid::new_v4()));
        let manager = RecordingManager::new(&app_directory).unwrap();
        let default_root = PathBuf::from(manager.storage_info().path);
        let first = completed_recording(test_recording_id(), "default");
        let first_bundle = default_root.join(&first.id);
        std::fs::create_dir_all(&first_bundle).unwrap();
        std::fs::write(first_bundle.join("stream.flv"), b"a").unwrap();
        std::fs::write(first_bundle.join("danmaku.jsonl"), b"{}\n").unwrap();
        write_metadata(&first_bundle, &first).unwrap();

        let custom_root = app_directory.join("custom-recordings ");
        let custom_info = manager
            .set_storage_path(Some(custom_root.display().to_string()))
            .unwrap();
        let migrated_bundle = PathBuf::from(&custom_info.path).join(&first.id);
        assert!(!first_bundle.exists());
        assert!(migrated_bundle.join("stream.flv").is_file());
        assert!(migrated_bundle.join("danmaku.jsonl").is_file());
        assert!(migrated_bundle.join("metadata.json").is_file());
        assert_eq!(manager.list().unwrap().len(), 1);

        drop(manager);
        let restarted = RecordingManager::new(&app_directory).unwrap();
        assert_eq!(restarted.list().unwrap().len(), 1);
        drop(restarted);
        std::fs::remove_dir_all(app_directory).unwrap();
    }

    #[test]
    fn storage_switch_leaves_an_old_metadata_bundle_in_place() {
        let app_directory =
            std::env::temp_dir().join(format!("rlive-recording-storage-old-{}", Uuid::new_v4()));
        let manager = RecordingManager::new(&app_directory).unwrap();
        let default_root = PathBuf::from(manager.storage_info().path);
        let old = completed_recording(test_recording_id(), "old metadata");
        let bundle = default_root.join(&old.id);
        std::fs::create_dir_all(&bundle).unwrap();
        std::fs::write(bundle.join("stream.flv"), b"old").unwrap();
        let mut value = serde_json::to_value(old).unwrap();
        value["schema_version"] = serde_json::json!(1);
        let id = value["id"].as_str().unwrap().to_owned();
        std::fs::write(
            bundle.join("metadata.json"),
            serde_json::to_vec_pretty(&value).unwrap(),
        )
        .unwrap();

        let custom_root = app_directory.join("custom-recordings");
        let custom_info = manager
            .set_storage_path(Some(custom_root.display().to_string()))
            .unwrap();

        assert!(bundle.is_dir());
        assert!(!PathBuf::from(custom_info.path).join(id).exists());
        assert!(manager.list().unwrap().is_empty());

        drop(manager);
        std::fs::remove_dir_all(app_directory).unwrap();
    }

    #[test]
    fn storage_switch_is_rejected_while_a_recording_is_finalizing() {
        let app_directory =
            std::env::temp_dir().join(format!("rlive-recording-storage-busy-{}", Uuid::new_v4()));
        let manager = RecordingManager::new(&app_directory).unwrap();
        let default_root = PathBuf::from(manager.storage_info().path);
        let id = test_recording_id();
        let bundle = default_root.join(&id);
        std::fs::create_dir_all(&bundle).unwrap();
        let stored = completed_recording(id.clone(), "收尾中");
        write_metadata(&bundle, &stored).unwrap();
        let state = active_session_state(default_root.clone(), bundle.clone(), id.clone());
        manager
            .finalizing
            .lock()
            .unwrap()
            .insert(id.clone(), FinalizingSession { state });

        let custom_root = app_directory.join("busy-target");
        let error = manager
            .set_storage_path(Some(custom_root.display().to_string()))
            .unwrap_err();
        assert_eq!(error.code, "recording_storage_busy");
        assert!(bundle.join("metadata.json").is_file());
        assert_eq!(
            manager.storage_info().path,
            crate::app_paths::path_to_string(&default_root)
        );

        manager.finalizing.lock().unwrap().remove(&id);
        drop(manager);
        std::fs::remove_dir_all(app_directory).unwrap();
    }

    #[tokio::test]
    async fn danmaku_ass_export_writes_a_subtitle_beside_the_media() {
        let app_directory =
            std::env::temp_dir().join(format!("rlive-recording-ass-{}", Uuid::new_v4()));
        let manager = RecordingManager::new(&app_directory).unwrap();
        let root = PathBuf::from(manager.storage_info().path);
        let mut stored = completed_recording(test_recording_id(), "字幕导出");
        stored.include_danmaku = true;
        stored.danmaku_file = Some("danmaku.jsonl".into());
        let bundle = root.join(&stored.id);
        std::fs::create_dir_all(&bundle).unwrap();
        std::fs::write(bundle.join("stream.flv"), b"a").unwrap();
        std::fs::write(
            bundle.join("danmaku.jsonl"),
            br#"{"offset_ms":1200,"events":[{"kind":"chat","user":"viewer","is_self":false,"content":"\u4f60\u597d","color":null,"ts":1}]}
"#,
        )
        .unwrap();
        write_metadata(&bundle, &stored).unwrap();

        let options =
            AssExportOptions::try_from_settings(&crate::models::settings::AppSettings::default())
                .unwrap();
        let path = manager
            .export_danmaku_ass(&stored.id, options.clone())
            .await
            .unwrap();

        // 名字由媒体词干驱动，使外部播放器自动加载。
        assert_eq!(
            path,
            crate::app_paths::path_to_string(&bundle.join("stream.ass"))
        );
        let script = std::fs::read_to_string(bundle.join("stream.ass")).unwrap();
        assert!(script.contains("[Events]"));
        assert!(script.contains("Dialogue: 0,0:00:01.20,"));
        assert!(script.contains("你好"));

        // 没有伴生文件的录制报告一个专门的错误，
        // 而不是写出空字幕。
        let mut plain = completed_recording(test_recording_id(), "无弹幕");
        plain.include_danmaku = false;
        let plain_bundle = root.join(&plain.id);
        std::fs::create_dir_all(&plain_bundle).unwrap();
        write_metadata(&plain_bundle, &plain).unwrap();
        let error = manager
            .export_danmaku_ass(&plain.id, options)
            .await
            .unwrap_err();
        assert_eq!(error.code, "recording_danmaku_missing");

        drop(manager);
        std::fs::remove_dir_all(app_directory).unwrap();
    }

    #[test]
    fn storage_switch_rolls_back_when_the_target_already_holds_the_bundle() {
        let app_directory = std::env::temp_dir().join(format!(
            "rlive-recording-storage-conflict-{}",
            Uuid::new_v4()
        ));
        let manager = RecordingManager::new(&app_directory).unwrap();
        let default_root = PathBuf::from(manager.storage_info().path);
        let stored = completed_recording(test_recording_id(), "冲突");
        let bundle = default_root.join(&stored.id);
        std::fs::create_dir_all(&bundle).unwrap();
        std::fs::write(bundle.join("stream.flv"), b"a").unwrap();
        write_metadata(&bundle, &stored).unwrap();

        let custom_root = app_directory.join("conflict-target");
        std::fs::create_dir_all(custom_root.join(&stored.id)).unwrap();
        let error = manager
            .set_storage_path(Some(custom_root.display().to_string()))
            .unwrap_err();
        assert_eq!(error.code, "recording_storage_conflict");
        assert!(bundle.join("stream.flv").is_file());
        assert_eq!(
            manager.storage_info().path,
            crate::app_paths::path_to_string(&default_root)
        );

        drop(manager);
        std::fs::remove_dir_all(app_directory).unwrap();
    }

    #[test]
    fn storage_config_recovers_the_committed_backup_after_an_interrupted_write() {
        let app_directory = std::env::temp_dir().join(format!(
            "rlive-recording-storage-recovery-{}",
            Uuid::new_v4()
        ));
        let committed_root = app_directory.join("committed");
        let uncommitted_root = app_directory.join("uncommitted");
        std::fs::create_dir_all(&committed_root).unwrap();
        std::fs::create_dir_all(&uncommitted_root).unwrap();
        let config_path = app_directory.join(super::RECORDING_STORAGE_CONFIG_FILE);
        let temporary = config_path.with_file_name("recording-storage-v2.json.tmp");
        let backup = config_path.with_file_name("recording-storage-v2.json.bak");
        std::fs::write(
            &backup,
            serde_json::to_vec_pretty(&RecordingStorageConfig {
                schema_version: RECORDING_STORAGE_CONFIG_VERSION,
                current_path: Some(crate::app_paths::path_to_string(&committed_root)),
                known_paths: Vec::new(),
            })
            .unwrap(),
        )
        .unwrap();
        std::fs::write(
            &temporary,
            serde_json::to_vec_pretty(&RecordingStorageConfig {
                schema_version: RECORDING_STORAGE_CONFIG_VERSION,
                current_path: Some(crate::app_paths::path_to_string(&uncommitted_root)),
                known_paths: Vec::new(),
            })
            .unwrap(),
        )
        .unwrap();

        let storage = load_storage_state(&app_directory).unwrap();
        assert_eq!(
            storage.current_root,
            std::fs::canonicalize(&committed_root).unwrap()
        );
        assert!(config_path.exists());
        assert!(!temporary.exists());
        assert!(!backup.exists());

        std::fs::remove_dir_all(app_directory).unwrap();
    }

    #[test]
    fn corrupt_storage_config_is_reported_instead_of_silently_reset() {
        let app_directory = std::env::temp_dir().join(format!(
            "rlive-recording-storage-corrupt-{}",
            Uuid::new_v4()
        ));
        std::fs::create_dir_all(&app_directory).unwrap();
        std::fs::write(
            app_directory.join(super::RECORDING_STORAGE_CONFIG_FILE),
            b"not-json",
        )
        .unwrap();

        let error = load_storage_state(&app_directory).unwrap_err();
        assert_eq!(error.code, "recording_storage_error");
        assert!(error.message.contains("恢复录制目录设置失败"));

        std::fs::remove_dir_all(app_directory).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn recording_storage_rejects_a_symlink_to_the_filesystem_root() {
        use std::os::unix::fs::symlink;

        let base =
            std::env::temp_dir().join(format!("rlive-recording-root-symlink-{}", Uuid::new_v4()));
        let selected = base.join("selected");
        std::fs::create_dir_all(&base).unwrap();
        symlink("/", &selected).unwrap();

        let error = prepare_storage_root(&selected).unwrap_err();
        assert_eq!(error.code, "recording_storage_path_invalid");

        std::fs::remove_file(selected).unwrap();
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn recording_manager_rejects_a_second_instance_for_the_same_app_data() {
        let app_directory =
            std::env::temp_dir().join(format!("rlive-recording-instance-lock-{}", Uuid::new_v4()));
        let first = RecordingManager::new(&app_directory).unwrap();
        let second = RecordingManager::new(&app_directory);
        assert_eq!(
            second.err().map(|error| error.code),
            Some("recording_already_running".to_string())
        );
        drop(first);
        std::fs::remove_dir_all(app_directory).unwrap();
    }

    #[test]
    fn recorded_danmaku_sidecar_never_serializes_backend_account_ids() {
        let events = [DanmakuEvent {
            kind: DanmakuKind::Chat,
            user: "本地用户".into(),
            is_self: true,
            user_id: Some("private-account-id".into()),
            content: "测试".into(),
            color: Some("#ffffff".into()),
            spans: None,
            super_chat: None,
            ts: 1,
        }];
        let json = serde_json::to_string(&StoredDanmakuBatch {
            offset_ms: 250,
            events: &events,
        })
        .unwrap();

        assert!(json.contains("\"offset_ms\":250"));
        assert!(json.contains("\"is_self\":true"));
        assert!(!json.contains("private-account-id"));
        assert!(!json.contains("user_id"));
    }

    fn manager_test_flv_body() -> Vec<u8> {
        fn tag(timestamp: u32, payload: &[u8]) -> Vec<u8> {
            let mut value = vec![9, 0, 0, payload.len() as u8];
            value.extend_from_slice(&[
                (timestamp >> 16) as u8,
                (timestamp >> 8) as u8,
                timestamp as u8,
                (timestamp >> 24) as u8,
                0,
                0,
                0,
            ]);
            value.extend_from_slice(payload);
            value.extend_from_slice(&((payload.len() + 11) as u32).to_be_bytes());
            value
        }

        let mut body = b"FLV\x01\x05\x00\x00\x00\x09\x00\x00\x00\x00".to_vec();
        body.extend_from_slice(&tag(0, b"first"));
        body.extend_from_slice(&tag(1_000, b"second"));
        body
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

    async fn spawn_manager_test_flv_server(body: Vec<u8>) -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    break;
                };
                let mut request = [0_u8; 2048];
                let Ok(length) = socket.read(&mut request).await else {
                    continue;
                };
                if length == 0 {
                    continue;
                }
                let response = "HTTP/1.1 200 OK\r\nContent-Type: video/x-flv\r\nTransfer-Encoding: chunked\r\nConnection: keep-alive\r\n\r\n";
                if socket.write_all(response.as_bytes()).await.is_err() {
                    continue;
                }
                if socket
                    .write_all(format!("{:x}\r\n", body.len()).as_bytes())
                    .await
                    .is_err()
                {
                    continue;
                }
                if socket.write_all(&body).await.is_err()
                    || socket.write_all(b"\r\n").await.is_err()
                {
                    continue;
                }
                let mut closed = [0_u8; 1];
                let _ = socket.read(&mut closed).await;
            }
        });
        (format!("http://{address}/live.flv"), server)
    }

    async fn spawn_manager_test_valid_flv_server(
        body: Vec<u8>,
    ) -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    break;
                };
                let mut request = [0_u8; 4096];
                let Ok(length) = socket.read(&mut request).await else {
                    continue;
                };
                if length == 0 {
                    continue;
                }
                if socket
                    .write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Type: video/x-flv\r\nTransfer-Encoding: chunked\r\nConnection: keep-alive\r\n\r\n",
                    )
                    .await
                    .is_err()
                    || socket
                        .write_all(format!("{:x}\r\n", body.len()).as_bytes())
                        .await
                        .is_err()
                    || socket.write_all(&body).await.is_err()
                    || socket.write_all(b"\r\n").await.is_err()
                {
                    continue;
                }
                let mut closed = [0_u8; 1];
                let _ = socket.read(&mut closed).await;
            }
        });
        (format!("http://{address}/live.flv"), server)
    }

    /// 十二个一秒长的 H.264/AAC MPEG-TS 分片，可直接作为 HLS 媒体列表提供服务。
    /// 第一个分片携带 PAT/PMT，因此比其余分片更长。
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

    fn manager_lifecycle_test_input(
        url: &str,
        source_key: &str,
        room_id: &str,
    ) -> RecordingStartInput {
        let mut input = manager_test_input(url, source_key, room_id);
        // Manager 生命周期测试检验会话归属与收尾。
        // 合法的 FLV 重封装在下方有专门的集成夹具。
        input.source.protocol = PlaybackProtocol::Native;
        input
    }

    async fn wait_for_manager_recording_bytes(manager: &RecordingManager, id: &str, minimum: u64) {
        let result = tokio::time::timeout(std::time::Duration::from_secs(8), async {
            loop {
                let bytes = manager
                    .list()
                    .unwrap()
                    .into_iter()
                    .find(|item| item.id == id)
                    .map(|item| item.size_bytes)
                    .unwrap_or(0);
                if bytes >= minimum {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await;
        if result.is_err() {
            let item = manager
                .list()
                .unwrap()
                .into_iter()
                .find(|item| item.id == id);
            panic!("录制任务应在超时前写入测试媒体: {item:?}");
        }
    }

    #[tokio::test]
    async fn ffmpeg_manager_remuxes_headers_and_finishes_a_live_flv() {
        let body = manager_test_valid_flv_body();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (request_tx, request_rx) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 4096];
            let length = socket.read(&mut request).await.unwrap();
            let _ = request_tx.send(String::from_utf8_lossy(&request[..length]).into_owned());
            socket
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: video/x-flv\r\nTransfer-Encoding: chunked\r\nConnection: keep-alive\r\n\r\n",
                )
                .await
                .unwrap();
            socket
                .write_all(format!("{:x}\r\n", body.len()).as_bytes())
                .await
                .unwrap();
            socket.write_all(&body).await.unwrap();
            socket.write_all(b"\r\n").await.unwrap();
            let mut closed = [0_u8; 1];
            let _ = socket.read(&mut closed).await;
        });

        let app_directory =
            std::env::temp_dir().join(format!("rlive-recording-ffmpeg-{}", Uuid::new_v4()));
        let manager = RecordingManager::new(&app_directory).unwrap();
        let mut input = manager_test_input(
            &format!("http://{address}/live.flv"),
            "live:bilibili:ffmpeg-manager",
            "ffmpeg",
        );
        input
            .source
            .headers
            .insert("X-Recording-Test".into(), "ffmpeg".into());
        let active = manager
            .start_with_ffmpeg_options(input, None, FfmpegRecordingOptions::default())
            .await
            .unwrap();
        wait_for_manager_recording_bytes(&manager, &active.id, 1).await;

        let stopped = manager.stop(&active.id).await.unwrap();
        assert_eq!(stopped.status, RecordingStatus::Completed);
        assert!(stopped.error.is_none());
        assert!(stopped.duration_ms > 0);
        let request = request_rx.await.unwrap();
        assert!(request.contains("X-Recording-Test: ffmpeg\r\n"));

        let root = PathBuf::from(manager.storage_info().path);
        let stored = super::read_stored(&root, &active.id).unwrap();
        let final_path = root.join(&active.id).join(stored.media_file);
        assert!(final_path.is_file());
        let bytes = std::fs::read(&final_path).unwrap();
        assert!(
            bytes
                .windows(b"keyframes".len())
                .any(|window| window == b"keyframes"),
            "FLV 回放需要关键帧索引支持 Range 跳转"
        );
        let output = ffmpeg_next::format::input(&final_path).unwrap();
        assert!(
            output
                .streams()
                .any(|stream| { stream.parameters().medium() == ffmpeg_next::media::Type::Video })
        );

        server.abort();
        let _ = server.await;
        drop(manager);
        std::fs::remove_dir_all(app_directory).unwrap();
    }

    #[tokio::test]
    async fn ffmpeg_manager_auto_split_continues_in_a_new_bundle() {
        let (url, server) =
            spawn_manager_test_valid_flv_server(manager_test_valid_flv_body()).await;
        let app_directory =
            std::env::temp_dir().join(format!("rlive-recording-split-{}", Uuid::new_v4()));
        let manager = RecordingManager::new(&app_directory).unwrap();
        let initial = manager
            .start_with_ffmpeg_options(
                manager_test_input(&url, "live:bilibili:auto-split", "auto-split"),
                None,
                FfmpegRecordingOptions {
                    split_duration: Some(std::time::Duration::from_millis(500)),
                    ..FfmpegRecordingOptions::default()
                },
            )
            .await
            .unwrap();

        tokio::time::timeout(std::time::Duration::from_secs(8), async {
            loop {
                let items = manager.list().unwrap();
                let has_completed_initial = items
                    .iter()
                    .any(|item| item.id == initial.id && item.status == RecordingStatus::Completed);
                let has_next_active = items.iter().any(|item| {
                    item.id != initial.id
                        && item.status == RecordingStatus::Recording
                        && item.size_bytes > 0
                });
                if has_completed_initial && has_next_active {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("自动分割应完成当前 bundle 并继续下一段");

        let stopped = manager.stop(&initial.id).await.unwrap();
        assert_ne!(stopped.id, initial.id);
        assert_eq!(stopped.status, RecordingStatus::Completed);
        let items = manager.list().unwrap();
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
                .all(|item| PathBuf::from(&item.file_path).is_file())
        );

        server.abort();
        let _ = server.await;
        drop(manager);
        std::fs::remove_dir_all(app_directory).unwrap();
    }

    #[tokio::test]
    async fn ffmpeg_manager_remuxes_hls_master_without_following_unused_variant() {
        let segments = Arc::new(manager_test_ts_segments());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let high_revision = Arc::new(AtomicU64::new(0));
        let low_revision = Arc::new(AtomicU64::new(0));
        let high_segment_requests = Arc::new(AtomicU64::new(0));
        let low_segment_requests = Arc::new(AtomicU64::new(0));
        let server_high_requests = high_segment_requests.clone();
        let server_low_requests = low_segment_requests.clone();
        let server = tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    break;
                };
                let segments = segments.clone();
                let high_revision = high_revision.clone();
                let low_revision = low_revision.clone();
                let high_segment_requests = server_high_requests.clone();
                let low_segment_requests = server_low_requests.clone();
                tokio::spawn(async move {
                    let mut request = [0_u8; 4096];
                    let Ok(length) = socket.read(&mut request).await else {
                        return;
                    };
                    let head = String::from_utf8_lossy(&request[..length]);
                    let path = head
                        .lines()
                        .next()
                        .and_then(|line| line.split_whitespace().nth(1))
                        .unwrap_or("");
                    let (content_type, body) = if path == "/master.m3u8" {
                        (
                            "application/vnd.apple.mpegurl",
                            b"#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=1280x720\nhigh.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=100000,RESOLUTION=320x180\nlow.m3u8\n"
                                .to_vec(),
                        )
                    } else if matches!(path, "/high.m3u8" | "/low.m3u8") {
                        let final_sequence = segments.len().saturating_sub(3) as u64;
                        let (variant, revision) = if path == "/high.m3u8" {
                            ("high", &high_revision)
                        } else {
                            ("low", &low_revision)
                        };
                        let sequence = revision
                            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |sequence| {
                                Some((sequence + 1).min(final_sequence))
                            })
                            .unwrap();
                        (
                            "application/vnd.apple.mpegurl",
                            format!(
                                "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:{sequence}\n#EXTINF:1.000,\n{variant}-segment-{sequence}.ts\n#EXTINF:1.000,\n{variant}-segment-{}.ts\n#EXTINF:1.000,\n{variant}-segment-{}.ts\n",
                                sequence + 1,
                                sequence + 2
                            )
                            .into_bytes(),
                        )
                    } else {
                        let requested_segment = [
                            ("/high-segment-", &high_segment_requests),
                            ("/low-segment-", &low_segment_requests),
                        ]
                        .into_iter()
                        .find_map(|(prefix, requests)| {
                            path.strip_prefix(prefix)
                                .and_then(|path| path.strip_suffix(".ts"))
                                .and_then(|index| index.parse::<usize>().ok())
                                .and_then(|index| segments.get(index))
                                .map(|segment| (requests, segment))
                        });
                        let Some((requests, segment)) = requested_segment else {
                            let _ = socket
                                .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                                .await;
                            return;
                        };
                        requests.fetch_add(1, Ordering::Relaxed);
                        ("video/mp2t", segment.clone())
                    };
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    );
                    if socket.write_all(response.as_bytes()).await.is_ok() {
                        let _ = socket.write_all(&body).await;
                    }
                });
            }
        });

        let app_directory =
            std::env::temp_dir().join(format!("rlive-recording-hls-{}", Uuid::new_v4()));
        let manager = RecordingManager::new(&app_directory).unwrap();
        let active = manager
            .start_with_ffmpeg_options(
                manager_test_input(
                    &format!("http://{address}/master.m3u8"),
                    "live:bilibili:hls-manager",
                    "hls",
                ),
                None,
                FfmpegRecordingOptions::default(),
            )
            .await
            .unwrap();
        assert_eq!(active.protocol, PlaybackProtocol::MpegTs);
        wait_for_manager_recording_bytes(&manager, &active.id, 1).await;
        let low_after_probe = low_segment_requests.load(Ordering::Relaxed);
        let high_after_probe = high_segment_requests.load(Ordering::Relaxed);
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while high_segment_requests.load(Ordering::Relaxed) < high_after_probe + 2 {
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("选中的 HLS variant 应继续下载媒体分片");
        assert!(
            low_segment_requests.load(Ordering::Relaxed) <= low_after_probe + 1,
            "未选择的 HLS variant 不应在探测结束后持续下载"
        );

        let stopped = manager.stop(&active.id).await.unwrap();
        assert_eq!(stopped.status, RecordingStatus::Completed);
        assert!(stopped.error.is_none());
        let root = PathBuf::from(manager.storage_info().path);
        let stored = super::read_stored(&root, &active.id).unwrap();
        assert_eq!(stored.protocol, PlaybackProtocol::MpegTs);
        assert!(stored.media_file.ends_with(".ts"));
        let final_path = root.join(&active.id).join(stored.media_file);
        assert!(final_path.is_file());
        let output = ffmpeg_next::format::input(&final_path).unwrap();
        assert!(
            output
                .streams()
                .any(|stream| { stream.parameters().medium() == ffmpeg_next::media::Type::Video })
        );
        assert!(
            output
                .streams()
                .any(|stream| { stream.parameters().medium() == ffmpeg_next::media::Type::Audio })
        );

        server.abort();
        let _ = server.await;
        drop(manager);
        std::fs::remove_dir_all(app_directory).unwrap();
    }

    /// 停止 HLS 录制必须报告「已保存」，而不是「已中断」，
    /// 即使此时没有任何数据到达。
    ///
    /// 停止请求经中断回调抵达 libavformat 时，某个分片抓取正被阻塞，
    /// 而真实录制正是在这种情况下以 `Interrupted` 和
    /// 「直播流已结束」收场的：HLS 解复用器把被中止的抓取上报为
    /// `AVERROR_EOF`，worker 把它读成了直播结束。
    ///
    /// 这里验证的是端到端契约，而不是那个分类本身。被中止的读取最终报错还是
    /// 冲刷出最后一个数据包由 libavformat 内部决定，而在分片这么小的情况下它会
    /// 冲刷，于是循环在自己的取消检查处结束。分类行为由
    /// `recording_ffmpeg` 中 `classify_read_failure` 的单元测试固定。
    #[tokio::test(flavor = "multi_thread")]
    async fn stopping_an_hls_recording_while_a_fetch_is_stalled_completes_it() {
        let segments = Arc::new(manager_test_ts_segments());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let sequence = Arc::new(AtomicU64::new(0));
        // 媒体落盘后翻转一次。从那时起分片抓取不再应答，
        // 停止请求必须打断一次阻塞中的读取。
        let stall = Arc::new(AtomicBool::new(false));
        let stalled_fetches = Arc::new(AtomicU64::new(0));
        let server_stall = stall.clone();
        let server_stalled = stalled_fetches.clone();
        let server = tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    break;
                };
                let segments = segments.clone();
                let sequence = sequence.clone();
                let stall = server_stall.clone();
                let stalled = server_stalled.clone();
                tokio::spawn(async move {
                    let mut request = [0_u8; 4096];
                    let Ok(length) = socket.read(&mut request).await else {
                        return;
                    };
                    let head = String::from_utf8_lossy(&request[..length]);
                    let path = head
                        .lines()
                        .next()
                        .and_then(|line| line.split_whitespace().nth(1))
                        .unwrap_or("");
                    let (content_type, body) = if path == "/live.m3u8" {
                        // 单分片滑动窗口：解复用器在每个分片之后都必须回来重新加载，
                        // 而不能靠缓冲窗口一路领先。
                        let current = sequence.load(Ordering::Relaxed);
                        (
                            "application/vnd.apple.mpegurl",
                            format!(
                                "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:{current}\n#EXTINF:1.000,\nsegment-{current}.ts\n"
                            )
                            .into_bytes(),
                        )
                    } else {
                        let requested = path
                            .strip_prefix("/segment-")
                            .and_then(|path| path.strip_suffix(".ts"))
                            .and_then(|index| index.parse::<usize>().ok())
                            .and_then(|index| Some((index, segments.get(index)?)));
                        let Some((index, segment)) = requested else {
                            let _ = socket
                                .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                                .await;
                            return;
                        };
                        if stall.load(Ordering::Relaxed) {
                            // 只有响应头，然后陷入沉默，
                            // 使停止请求到达时解复用器正好阻塞在这场抓取里。
                            let _ = socket
                                .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: video/mp2t\r\nContent-Length: 1504\r\nConnection: close\r\n\r\n")
                                .await;
                            stalled.fetch_add(1, Ordering::Relaxed);
                            std::future::pending::<()>().await;
                            return;
                        }
                        // 只有分片真正被服务过才推进窗口，保证任何分片都不会被跳过。
                        let last = segments.len().saturating_sub(1) as u64;
                        let next = ((index as u64) + 1).min(last);
                        let _ = sequence.fetch_update(
                            Ordering::Relaxed,
                            Ordering::Relaxed,
                            |sequence| Some(sequence.max(next)),
                        );
                        ("video/mp2t", segment.clone())
                    };
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    );
                    if socket.write_all(response.as_bytes()).await.is_ok() {
                        let _ = socket.write_all(&body).await;
                    }
                });
            }
        });

        let app_directory =
            std::env::temp_dir().join(format!("rlive-recording-hls-stop-{}", Uuid::new_v4()));
        let manager = RecordingManager::new(&app_directory).unwrap();
        let active = manager
            .start_with_ffmpeg_options(
                manager_test_input(
                    &format!("http://{address}/live.m3u8"),
                    "live:bilibili:hls-stop",
                    "hls-stop",
                ),
                None,
                FfmpegRecordingOptions::default(),
            )
            .await
            .unwrap();
        wait_for_manager_recording_bytes(&manager, &active.id, 1).await;
        stall.store(true, Ordering::Relaxed);
        tokio::time::timeout(std::time::Duration::from_secs(8), async {
            while stalled_fetches.load(Ordering::Relaxed) == 0 {
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("测试服务器应开始一次会被停止打断的分片请求");
        // 足够让解复用器排空已抓取的内容，
        // 并阻塞在这个停滞的请求内部。
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;

        let stopped = manager.stop(&active.id).await.unwrap();
        assert_eq!(
            stopped.status,
            RecordingStatus::Completed,
            "停止 HLS 录制应保存而非中断: {:?}",
            stopped.error
        );
        assert!(stopped.error.is_none(), "{:?}", stopped.error);
        let root = PathBuf::from(manager.storage_info().path);
        let stored = super::read_stored(&root, &active.id).unwrap();
        let final_path = root.join(&active.id).join(stored.media_file);
        assert!(final_path.is_file());

        server.abort();
        let _ = server.await;
        drop(manager);
        std::fs::remove_dir_all(app_directory).unwrap();
    }

    #[tokio::test]
    async fn manager_start_stop_persists_completed_recording() {
        let body = manager_test_flv_body();
        let (url, server) = spawn_manager_test_flv_server(body.clone()).await;
        let app_directory =
            std::env::temp_dir().join(format!("rlive-recording-manager-{}", Uuid::new_v4()));
        let manager = RecordingManager::new(&app_directory).unwrap();

        let active = manager
            .start_with_ffmpeg_options(
                manager_lifecycle_test_input(&url, "live:bilibili:manager-start-stop", "100"),
                None,
                FfmpegRecordingOptions::default(),
            )
            .await
            .unwrap();
        assert_eq!(active.status, RecordingStatus::Recording);
        assert!(active.ended_at.is_none());

        let root = PathBuf::from(manager.storage_info().path);
        let bundle = root.join(&active.id);
        let active_metadata = super::read_stored(&root, &active.id).unwrap();
        assert_eq!(active_metadata.status, RecordingStatus::Recording);
        assert!(active_metadata.ended_at.is_none());
        let final_path = bundle.join(&active_metadata.media_file);
        let part_path = bundle.join(format!("{}.part", active_metadata.media_file));
        assert!(!final_path.exists());

        wait_for_manager_recording_bytes(&manager, &active.id, 1).await;
        assert!(part_path.is_file());

        let stopped = manager.stop(&active.id).await.unwrap();
        assert_eq!(stopped.status, RecordingStatus::Completed);
        assert!(stopped.ended_at.is_some());
        assert!(stopped.error.is_none());
        assert!(!part_path.exists());
        assert!(final_path.is_file());
        assert!(std::fs::read(&final_path).unwrap().starts_with(b"FLV"));

        let completed_metadata = super::read_stored(&root, &active.id).unwrap();
        assert_eq!(completed_metadata.status, RecordingStatus::Completed);
        assert_eq!(completed_metadata.ended_at, stopped.ended_at);
        assert_eq!(completed_metadata.size_bytes, stopped.size_bytes);
        assert_eq!(stopped.file_path, final_path.display().to_string());

        server.abort();
        let _ = server.await;
        drop(manager);
        std::fs::remove_dir_all(app_directory).unwrap();
    }

    #[tokio::test]
    async fn manager_rejects_duplicate_source_key() {
        let body = manager_test_flv_body();
        let (url, server) = spawn_manager_test_flv_server(body.clone()).await;
        let app_directory =
            std::env::temp_dir().join(format!("rlive-recording-duplicate-{}", Uuid::new_v4()));
        let manager = RecordingManager::new(&app_directory).unwrap();
        let source_key = "live:stable:duplicate";

        let first = manager
            .start_with_ffmpeg_options(
                manager_lifecycle_test_input(&url, source_key, "100"),
                None,
                FfmpegRecordingOptions::default(),
            )
            .await
            .unwrap();
        let duplicate = manager
            .start_with_ffmpeg_options(
                manager_lifecycle_test_input(&url, source_key, "different-room"),
                None,
                FfmpegRecordingOptions::default(),
            )
            .await
            .unwrap_err();

        assert_eq!(duplicate.code, "recording_already_active");
        assert_eq!(
            manager
                .list()
                .unwrap()
                .into_iter()
                .filter(|item| item.status == RecordingStatus::Recording)
                .count(),
            1
        );

        wait_for_manager_recording_bytes(&manager, &first.id, 1).await;
        manager.stop(&first.id).await.unwrap();
        server.abort();
        let _ = server.await;
        drop(manager);
        std::fs::remove_dir_all(app_directory).unwrap();
    }
}
