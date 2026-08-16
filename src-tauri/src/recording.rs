//! Desktop live-stream recorder and local playback service.
//!
//! Recordings deliberately live outside the SQLite database. A recording is a
//! small self-contained bundle (metadata plus media, or an HLS playlist and
//! its segments), so it remains recoverable when the application is killed and
//! can be inspected or copied by the user without a database export.

#![cfg(not(target_os = "android"))]

use std::collections::{HashMap, HashSet};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use futures_util::StreamExt;
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use tauri::async_runtime::JoinHandle;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::http_client;
use crate::models::live::{DanmakuEvent, PlayUrl, PlaybackProtocol};

const RECORDINGS_DIRECTORY: &str = "recordings";
const RECORDING_STORAGE_CONFIG_FILE: &str = "recording-storage.json";
const MAX_ACTIVE_RECORDINGS: usize = 4;
const MAX_MANIFEST_BYTES: usize = 4 * 1024 * 1024;
const MAX_SEGMENT_BYTES: usize = 256 * 1024 * 1024;
const MAX_KEY_BYTES: usize = 64 * 1024;
const HLS_ERROR_LIMIT: u32 = 10;
const HLS_RETRY_DELAY: Duration = Duration::from_secs(2);

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
    /// Stable content identity used to prevent accidental duplicate sessions.
    pub source_key: String,
    pub source_kind: String,
    pub site_id: Option<String>,
    pub room_id: Option<String>,
    pub title: String,
    pub user_name: String,
    pub cover: String,
    pub protocol: PlaybackProtocol,
    pub status: RecordingStatus,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub duration_ms: u64,
    pub size_bytes: u64,
    /// Whether a local, separately switchable danmaku track was requested.
    pub include_danmaku: bool,
    /// Whether this session may keep recording after its player page closes.
    pub continue_on_leave: bool,
    /// Number of danmaku events successfully written to the sidecar so far.
    pub danmaku_count: u64,
    /// Relative sidecar path inside the recording bundle, when enabled.
    pub danmaku_file: Option<String>,
    /// Absolute path of the playable entry (or the HLS index) for the native
    /// file reveal action. The playback URL itself is intentionally separate.
    pub file_path: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingStartInput {
    pub source: PlayUrl,
    pub source_key: String,
    pub source_kind: String,
    #[serde(default)]
    pub site_id: Option<String>,
    #[serde(default)]
    pub room_id: Option<String>,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub user_name: String,
    #[serde(default)]
    pub cover: String,
    /// Save the active danmaku connection as a synchronized sidecar track.
    #[serde(default)]
    pub include_danmaku: bool,
    /// Keep the media task alive when the current player page is left.
    #[serde(default)]
    pub continue_on_leave: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct RecordingStorageInfo {
    pub path: String,
    pub default_path: String,
    pub is_default: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecordingStorageConfig {
    #[serde(default)]
    current_path: Option<String>,
    #[serde(default)]
    known_paths: Vec<String>,
}

#[derive(Debug, Clone)]
struct RecordingStorageState {
    default_root: PathBuf,
    current_root: PathBuf,
    /// Includes the current and default roots, followed by historical roots.
    roots: Vec<PathBuf>,
    history: Vec<PathBuf>,
    config_path: PathBuf,
}

impl RecordingStorageState {
    fn info(&self) -> RecordingStorageInfo {
        RecordingStorageInfo {
            path: self.current_root.display().to_string(),
            default_path: self.default_root.display().to_string(),
            is_default: self.current_root == self.default_root,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredRecording {
    id: String,
    source_key: String,
    source_kind: String,
    site_id: Option<String>,
    room_id: Option<String>,
    title: String,
    user_name: String,
    cover: String,
    protocol: PlaybackProtocol,
    status: RecordingStatus,
    started_at: i64,
    ended_at: Option<i64>,
    duration_ms: u64,
    size_bytes: u64,
    #[serde(default)]
    include_danmaku: bool,
    #[serde(default)]
    continue_on_leave: bool,
    #[serde(default)]
    danmaku_count: u64,
    #[serde(default)]
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
            file_path: reveal_path.display().to_string(),
            error: self.error.clone(),
        }
    }
}

struct SessionState {
    root: PathBuf,
    bundle: PathBuf,
    stored: Mutex<StoredRecording>,
    bytes: AtomicU64,
    duration_ms: AtomicU64,
    danmaku_count: AtomicU64,
    danmaku_writer: Mutex<Option<std::fs::File>>,
    danmaku_closed: AtomicBool,
    finished: AtomicBool,
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
    }
}

struct Session {
    state: Arc<SessionState>,
    cancel: watch::Sender<bool>,
    task: JoinHandle<()>,
}

/// A process-wide manager. It owns recording tasks and lazily starts the
/// loopback file server used by the in-app recording player.
pub struct RecordingManager {
    storage: Arc<Mutex<RecordingStorageState>>,
    sessions: Mutex<HashMap<String, Session>>,
    playback: PlaybackServer,
}

impl RecordingManager {
    pub fn new(app_directory: &Path) -> AppResult<Self> {
        let state = load_storage_state(app_directory)?;
        for root in &state.roots {
            if let Err(error) = recover_stale_recordings(root) {
                if *root == state.default_root {
                    return Err(error);
                }
                tracing::warn!(path = %root.display(), error = %error, "无法恢复历史录制目录");
            }
        }
        let storage = Arc::new(Mutex::new(state));
        Ok(Self {
            playback: PlaybackServer::new(storage.clone()),
            storage,
            sessions: Mutex::new(HashMap::new()),
        })
    }

    pub fn storage_path(&self) -> String {
        self.storage_info().path
    }

    pub fn storage_info(&self) -> RecordingStorageInfo {
        self.storage
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .info()
    }

    pub fn set_storage_path(&self, requested: Option<String>) -> AppResult<RecordingStorageInfo> {
        let next_root = match requested {
            Some(path) => prepare_storage_root(Path::new(path.trim()))?,
            None => self
                .storage
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .default_root
                .clone(),
        };
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
        write_storage_config(&next)?;
        *storage = next;
        Ok(storage.info())
    }

    pub fn list(&self) -> AppResult<Vec<RecordingItem>> {
        self.reap_finished();
        let roots = self.storage_roots();
        let mut by_id = HashMap::<String, RecordingItem>::new();
        for root in roots {
            let Ok(entries) = std::fs::read_dir(&root) else {
                continue;
            };
            for entry in entries {
                let Ok(entry) = entry else { continue };
                let path = entry.path();
                if !path.is_dir() {
                    continue;
                }
                let metadata_path = path.join("metadata.json");
                let Ok(bytes) = std::fs::read(&metadata_path) else {
                    continue;
                };
                let Ok(stored) = serde_json::from_slice::<StoredRecording>(&bytes) else {
                    continue;
                };
                if !is_safe_recording_id(&stored.id) || !path.ends_with(&stored.id) {
                    continue;
                }
                by_id
                    .entry(stored.id.clone())
                    .or_insert_with(|| stored.item(&root));
            }
        }
        let mut items: Vec<_> = by_id.into_values().collect();
        let sessions = self
            .sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        for session in sessions.values() {
            let item = session.state.snapshot();
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

    pub async fn start(
        &self,
        input: RecordingStartInput,
        proxy: Option<&str>,
    ) -> AppResult<RecordingItem> {
        validate_start_input(&input)?;
        let source_key = input.source_key.trim().to_string();
        let mut sessions = self
            .sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        self.reap_finished_locked(&mut sessions);
        if sessions.len() >= MAX_ACTIVE_RECORDINGS {
            return Err(AppError::new(
                "recording_limit_reached",
                format!("最多同时录制 {MAX_ACTIVE_RECORDINGS} 路直播"),
            ));
        }
        if sessions.values().any(|session| {
            let item = session.state.snapshot();
            item.status == RecordingStatus::Recording
                && (item.source_key == source_key
                    || (input.source_kind.trim() == "live"
                        && item.source_kind == "live"
                        && input.site_id.is_some()
                        && input.room_id.is_some()
                        && item.site_id.as_deref() == input.site_id.as_deref()
                        && item.room_id.as_deref() == input.room_id.as_deref()))
        }) {
            return Err(AppError::new(
                "recording_already_active",
                "该直播已经在录制中",
            ));
        }

        // Validate the proxy before creating a bundle. A malformed proxy must
        // not leave behind metadata that looks like an active recording but
        // has no task attached to it.
        let client = http_client::client_for_proxy(proxy)?;

        let id = Uuid::new_v4().to_string();
        let protocol = if input.source.protocol == PlaybackProtocol::Unknown {
            PlaybackProtocol::infer_from_url(&input.source.url)
        } else {
            input.source.protocol
        };
        let root = self.current_root();
        let media_file = media_file_name(protocol, &input.source.url);
        let bundle = root.join(&id);
        std::fs::create_dir_all(&bundle).map_err(|error| {
            AppError::new(
                "recording_storage_error",
                format!("创建录制空间失败: {error}"),
            )
        })?;
        if protocol == PlaybackProtocol::Hls {
            for directory in ["segments", "keys", "maps"] {
                std::fs::create_dir_all(bundle.join(directory)).map_err(|error| {
                    AppError::new(
                        "recording_storage_error",
                        format!("创建 HLS 目录失败: {error}"),
                    )
                })?;
            }
        }

        let danmaku_file = input.include_danmaku.then(|| "danmaku.jsonl".to_string());
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
            id: id.clone(),
            source_key,
            source_kind: normalize_text(&input.source_kind, "live"),
            site_id: optional_text(input.site_id),
            room_id: optional_text(input.room_id),
            title: normalize_text(&input.title, "未命名直播"),
            user_name: normalize_text(&input.user_name, ""),
            cover: normalize_text(&input.cover, ""),
            protocol,
            status: RecordingStatus::Recording,
            started_at: unix_ms(),
            ended_at: None,
            duration_ms: 0,
            size_bytes: 0,
            include_danmaku: input.include_danmaku,
            continue_on_leave: input.continue_on_leave,
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
            danmaku_writer: Mutex::new(danmaku_writer),
            danmaku_closed: AtomicBool::new(false),
            finished: AtomicBool::new(false),
        });
        let (cancel, cancel_rx) = watch::channel(false);
        let task_state = state.clone();
        let source = input.source;
        let task = tauri::async_runtime::spawn(async move {
            let outcome = run_recording_task(client, source, task_state.clone(), cancel_rx).await;
            finish_session(&task_state, outcome);
        });
        let item = state.snapshot();
        sessions.insert(
            id,
            Session {
                state,
                cancel,
                task,
            },
        );
        Ok(item)
    }

    pub async fn stop(&self, id: &str) -> AppResult<RecordingItem> {
        let (state, cancel, task) = {
            let mut sessions = self
                .sessions
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let session = sessions
                .remove(id)
                .ok_or_else(|| AppError::new("recording_not_found", "录制不存在"))?;
            (session.state, session.cancel, session.task)
        };
        let _ = cancel.send(true);
        if task.await.is_err() && !state.finished.load(Ordering::Acquire) {
            finish_session(
                &state,
                TaskOutcome {
                    status: RecordingStatus::Interrupted,
                    error: Some("录制任务意外终止".into()),
                },
            );
        }
        Ok(state.snapshot())
    }

    pub fn delete(&self, id: &str) -> AppResult<()> {
        if !is_safe_recording_id(id) {
            return Err(AppError::new("recording_invalid_id", "录制标识无效"));
        }
        {
            let sessions = self
                .sessions
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if sessions.contains_key(id) {
                return Err(AppError::new(
                    "recording_still_active",
                    "请先停止录制再删除",
                ));
            }
        }
        let Some(bundle) = find_bundle(&self.storage_roots(), id) else {
            return Ok(());
        };
        std::fs::remove_dir_all(&bundle).map_err(|error| {
            AppError::new("recording_delete_error", format!("删除录制失败: {error}"))
        })
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

    /// Appends one already-batched danmaku payload to every matching active
    /// recording. The source key fence prevents a room switch from leaking
    /// the new room's chat into an older recording.
    pub fn capture_danmaku(&self, source_key: &str, events: &[DanmakuEvent]) {
        if events.is_empty() {
            return;
        }
        let sessions = self
            .sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let matching_states: Vec<_> = sessions
            .values()
            .filter_map(|session| {
                let matches = session
                    .state
                    .stored
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .source_key
                    == source_key;
                matches.then(|| session.state.clone())
            })
            .collect();
        drop(sessions);
        for state in matching_states {
            state.append_danmaku(events);
        }
    }

    pub fn stop_all(&self) {
        let sessions = self
            .sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        for session in sessions.values() {
            let _ = session.cancel.send(true);
            session.task.abort();
        }
        self.playback.stop();
    }

    fn reap_finished(&self) {
        let mut sessions = self
            .sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        self.reap_finished_locked(&mut sessions);
    }

    fn reap_finished_locked(&self, sessions: &mut HashMap<String, Session>) {
        sessions.retain(|_, session| !session.state.finished.load(Ordering::Acquire));
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

#[derive(Debug)]
struct TaskOutcome {
    status: RecordingStatus,
    error: Option<String>,
}

async fn run_recording_task(
    client: Client,
    source: PlayUrl,
    state: Arc<SessionState>,
    cancel: watch::Receiver<bool>,
) -> TaskOutcome {
    let protocol = state
        .stored
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .protocol;
    match protocol {
        PlaybackProtocol::Hls => run_hls_recording(client, source, state, cancel).await,
        _ => run_direct_recording(client, source, state, cancel).await,
    }
}

async fn run_direct_recording(
    client: Client,
    source: PlayUrl,
    state: Arc<SessionState>,
    mut cancel: watch::Receiver<bool>,
) -> TaskOutcome {
    let media_file_name = {
        state
            .stored
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .media_file
            .clone()
    };
    let part = state.bundle.join(format!("{media_file_name}.part"));
    let final_path = state.bundle.join(media_file_name);
    let response = match build_request(&client, &source).send().await {
        Ok(response) if response.status().is_success() => response,
        Ok(response) => {
            return TaskOutcome {
                status: RecordingStatus::Failed,
                error: Some(format!("直播源返回 HTTP {}", response.status().as_u16())),
            };
        }
        Err(error) => {
            return TaskOutcome {
                status: RecordingStatus::Failed,
                error: Some(format!("连接直播源失败: {}", error.without_url())),
            };
        }
    };
    let mut file = match tokio::fs::File::create(&part).await {
        Ok(file) => file,
        Err(error) => {
            return TaskOutcome {
                status: RecordingStatus::Failed,
                error: Some(format!("创建录制文件失败: {error}")),
            };
        }
    };
    let started = Instant::now();
    let mut stream = response.bytes_stream();
    let mut cancelled = false;
    loop {
        let next = tokio::select! {
            value = stream.next() => value,
            changed = cancel.changed() => {
                if changed.is_ok() && *cancel.borrow() {
                    cancelled = true;
                }
                None
            }
        };
        let Some(next) = next else { break };
        let chunk = match next {
            Ok(chunk) => chunk,
            Err(error) => {
                let _ = file.flush().await;
                let _ = finalize_part(&part, &final_path).await;
                return TaskOutcome {
                    status: RecordingStatus::Interrupted,
                    error: Some(format!("读取直播流中断: {}", error.without_url())),
                };
            }
        };
        if chunk.is_empty() {
            continue;
        }
        if let Err(error) = file.write_all(&chunk).await {
            let _ = file.flush().await;
            let _ = finalize_part(&part, &final_path).await;
            return TaskOutcome {
                status: RecordingStatus::Failed,
                error: Some(format!("写入录制文件失败: {error}")),
            };
        }
        state.bytes.fetch_add(chunk.len() as u64, Ordering::Relaxed);
        state.duration_ms.store(
            started.elapsed().as_millis().min(u64::MAX as u128) as u64,
            Ordering::Relaxed,
        );
        if cancelled {
            break;
        }
    }
    let _ = file.flush().await;
    let _ = file.sync_data().await;
    if let Err(error) = finalize_part(&part, &final_path).await {
        return TaskOutcome {
            status: RecordingStatus::Failed,
            error: Some(format!("完成录制文件失败: {error}")),
        };
    }
    TaskOutcome {
        status: RecordingStatus::Completed,
        error: None,
    }
}

async fn finalize_part(part: &Path, final_path: &Path) -> std::io::Result<()> {
    if !part.exists() {
        return Ok(());
    }
    if final_path.exists() {
        tokio::fs::remove_file(final_path).await?;
    }
    tokio::fs::rename(part, final_path).await
}

fn build_request(client: &Client, source: &PlayUrl) -> reqwest::RequestBuilder {
    let mut request = client
        .get(&source.url)
        .header(reqwest::header::ACCEPT_ENCODING, "identity")
        .header(reqwest::header::ACCEPT, "*/*");
    for (name, value) in &source.headers {
        request = request.header(name.as_str(), value.as_str());
    }
    request
}

fn finish_session(state: &Arc<SessionState>, outcome: TaskOutcome) {
    // Close the sidecar before publishing the finished flag. A dispatcher
    // callback that was already in flight either completes before this lock
    // or observes the close flag and skips, so the final metadata count is
    // stable without exposing a half-written metadata snapshot to list().
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
    let _ = write_metadata(&state.bundle, &stored);
    state.finished.store(true, Ordering::Release);
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

fn media_file_name(protocol: PlaybackProtocol, source_url: &str) -> String {
    match protocol {
        PlaybackProtocol::Hls => "index.m3u8".into(),
        PlaybackProtocol::MpegTs => "stream.ts".into(),
        PlaybackProtocol::Native => {
            let path = Url::parse(source_url)
                .ok()
                .map(|url| url.path().to_ascii_lowercase());
            if path
                .as_deref()
                .is_some_and(|value| value.ends_with(".webm"))
            {
                "stream.webm".into()
            } else {
                "stream.mp4".into()
            }
        }
        _ => "stream.flv".into(),
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
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

fn is_safe_recording_id(id: &str) -> bool {
    Uuid::parse_str(id).is_ok() && !id.contains('/') && !id.contains('\\')
}

fn load_storage_state(app_directory: &Path) -> AppResult<RecordingStorageState> {
    let default_root = prepare_storage_root(&app_directory.join(RECORDINGS_DIRECTORY))?;
    let config_path = app_directory.join(RECORDING_STORAGE_CONFIG_FILE);
    let config = std::fs::read(&config_path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<RecordingStorageConfig>(&bytes).ok())
        .unwrap_or_default();

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

fn prepare_storage_root(path: &Path) -> AppResult<PathBuf> {
    if path.as_os_str().is_empty() || !path.is_absolute() {
        return Err(AppError::new(
            "recording_storage_path_invalid",
            "录制保存位置必须是绝对目录",
        ));
    }
    // A filesystem root is too broad for a recording library and is almost
    // always an accidental directory-picker selection.
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
        current_path: (storage.current_root != storage.default_root)
            .then(|| storage.current_root.display().to_string()),
        known_paths: storage
            .history
            .iter()
            .filter(|path| **path != storage.default_root)
            .map(|path| path.display().to_string())
            .collect(),
    };
    let bytes = serde_json::to_vec_pretty(&config)
        .map_err(|error| AppError::new("recording_storage_error", error.to_string()))?;
    let temporary = storage.config_path.with_extension("json.tmp");
    std::fs::write(&temporary, bytes).map_err(|error| {
        AppError::new(
            "recording_storage_error",
            format!("保存录制目录设置失败: {error}"),
        )
    })?;
    if storage.config_path.exists() {
        let _ = std::fs::remove_file(&storage.config_path);
    }
    std::fs::rename(&temporary, &storage.config_path).map_err(|error| {
        AppError::new(
            "recording_storage_error",
            format!("保存录制目录设置失败: {error}"),
        )
    })
}

fn find_bundle(roots: &[PathBuf], id: &str) -> Option<PathBuf> {
    if !is_safe_recording_id(id) {
        return None;
    }
    roots.iter().find_map(|root| {
        let bundle = root.join(id);
        let metadata = bundle.join("metadata.json");
        let bytes = std::fs::read(metadata).ok()?;
        let stored = serde_json::from_slice::<StoredRecording>(&bytes).ok()?;
        (stored.id == id && bundle.is_dir()).then_some(bundle)
    })
}

fn find_stored(roots: &[PathBuf], id: &str) -> AppResult<(PathBuf, StoredRecording)> {
    let bundle =
        find_bundle(roots, id).ok_or_else(|| AppError::new("recording_not_found", "录制不存在"))?;
    let root = bundle
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| AppError::new("recording_not_found", "录制不存在"))?;
    let stored = read_stored(&root, id)?;
    Ok((root, stored))
}

fn write_metadata(bundle: &Path, stored: &StoredRecording) -> AppResult<()> {
    let path = bundle.join("metadata.json");
    let temporary = bundle.join("metadata.json.tmp");
    let bytes = serde_json::to_vec_pretty(stored)
        .map_err(|error| AppError::new("recording_metadata_error", error.to_string()))?;
    std::fs::write(&temporary, bytes).map_err(|error| {
        AppError::new(
            "recording_metadata_error",
            format!("写入录制信息失败: {error}"),
        )
    })?;
    if path.exists() {
        let _ = std::fs::remove_file(&path);
    }
    std::fs::rename(&temporary, &path).map_err(|error| {
        AppError::new(
            "recording_metadata_error",
            format!("保存录制信息失败: {error}"),
        )
    })
}

fn read_stored(root: &Path, id: &str) -> AppResult<StoredRecording> {
    let path = root.join(id).join("metadata.json");
    let bytes =
        std::fs::read(path).map_err(|_| AppError::new("recording_not_found", "录制不存在"))?;
    serde_json::from_slice(&bytes)
        .map_err(|_| AppError::new("recording_metadata_error", "录制信息损坏"))
}

fn recover_stale_recordings(root: &Path) -> AppResult<()> {
    let entries = std::fs::read_dir(root)
        .map_err(|error| AppError::new("recording_storage_error", error.to_string()))?;
    for entry in entries {
        let Ok(entry) = entry else { continue };
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let id = entry.file_name().to_string_lossy().to_string();
        if !is_safe_recording_id(&id) {
            continue;
        }
        let Ok(mut stored) = read_stored(root, &id) else {
            continue;
        };
        if stored.status != RecordingStatus::Recording {
            continue;
        }
        let part = path.join(format!("{}.part", stored.media_file));
        let final_path = path.join(&stored.media_file);
        if part.exists() && !final_path.exists() {
            let _ = std::fs::rename(&part, &final_path);
        }
        if stored.protocol == PlaybackProtocol::Hls {
            finalize_hls_manifest(&path.join(&stored.media_file));
        }
        stored.status = RecordingStatus::Interrupted;
        stored.ended_at = Some(unix_ms());
        stored.size_bytes = bundle_size(&path);
        let _ = write_metadata(&path, &stored);
    }
    Ok(())
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

fn finalize_hls_manifest(path: &Path) {
    let Ok(mut text) = std::fs::read_to_string(path) else {
        return;
    };
    if text.contains("#EXT-X-ENDLIST") {
        return;
    }
    text = text.replace("#EXT-X-PLAYLIST-TYPE:EVENT", "#EXT-X-PLAYLIST-TYPE:VOD");
    if !text.ends_with('\n') {
        text.push('\n');
    }
    text.push_str("#EXT-X-ENDLIST\n");
    let _ = std::fs::write(path, text);
}

// -------------------------------------------------------------------------
// HLS archive

#[derive(Debug, Clone)]
struct HlsKey {
    method: String,
    uri: String,
    iv: Option<String>,
}

#[derive(Debug, Clone)]
struct HlsMap {
    uri: String,
    range: Option<String>,
}

#[derive(Debug, Clone)]
struct HlsSegment {
    uri: Url,
    sequence: u64,
    duration: f64,
    identity: String,
    key: Option<HlsKey>,
    map: Option<HlsMap>,
    range: Option<String>,
    discontinuity: bool,
    gap: bool,
}

#[derive(Debug, Default)]
struct ParsedPlaylist {
    media_sequence: u64,
    target_duration: f64,
    end_list: bool,
    segments: Vec<HlsSegment>,
}

#[derive(Debug, Clone)]
struct ArchiveEntry {
    file: String,
    duration: f64,
    key: Option<String>,
    key_iv: Option<String>,
    map: Option<String>,
    discontinuity: bool,
}

struct HlsArchive {
    bundle: PathBuf,
    entries: Vec<ArchiveEntry>,
    seen: HashSet<String>,
    keys: HashMap<String, String>,
    maps: HashMap<String, String>,
    target_duration: f64,
    next_segment: u64,
}

impl HlsArchive {
    fn new(bundle: PathBuf) -> Self {
        Self {
            bundle,
            entries: Vec::new(),
            seen: HashSet::new(),
            keys: HashMap::new(),
            maps: HashMap::new(),
            target_duration: 6.0,
            next_segment: 0,
        }
    }

    async fn append_segments(
        &mut self,
        client: &Client,
        playlist: &ParsedPlaylist,
        headers: &HashMap<String, String>,
        state: &SessionState,
    ) -> Result<usize, String> {
        self.target_duration = self.target_duration.max(playlist.target_duration);
        let mut appended = 0;
        for segment in &playlist.segments {
            if segment.gap || self.seen.contains(&segment.identity) {
                continue;
            }
            let key_file = if let Some(key) = &segment.key {
                Some(self.ensure_key(client, key, headers, state).await?)
            } else {
                None
            };
            let map_file = if let Some(map) = &segment.map {
                Some(self.ensure_map(client, map, headers, state).await?)
            } else {
                None
            };
            let bytes = fetch_bytes(
                client,
                &segment.uri,
                headers,
                segment.range.as_deref(),
                MAX_SEGMENT_BYTES,
            )
            .await?;
            if bytes.is_empty() {
                continue;
            }
            let extension = segment_extension(&segment.uri, &bytes);
            let file = format!("segments/{:08}.{}", self.next_segment, extension);
            self.next_segment = self.next_segment.saturating_add(1);
            let path = self.bundle.join(&file);
            tokio::fs::write(&path, &bytes)
                .await
                .map_err(|error| format!("写入 HLS 分片失败: {error}"))?;
            state.bytes.fetch_add(bytes.len() as u64, Ordering::Relaxed);
            let duration = if segment.duration.is_finite() {
                segment.duration.max(0.0)
            } else {
                0.0
            };
            state
                .duration_ms
                .fetch_add((duration * 1000.0).round() as u64, Ordering::Relaxed);
            self.entries.push(ArchiveEntry {
                file,
                duration,
                key: key_file,
                key_iv: segment.key.as_ref().map(|key| {
                    key.iv
                        .clone()
                        .unwrap_or_else(|| hls_media_sequence_iv(segment.sequence))
                }),
                map: map_file,
                discontinuity: segment.discontinuity,
            });
            self.seen.insert(segment.identity.clone());
            appended += 1;
        }
        self.write_manifest(false)
            .await
            .map_err(|error| error.to_string())?;
        Ok(appended)
    }

    async fn ensure_key(
        &mut self,
        client: &Client,
        key: &HlsKey,
        headers: &HashMap<String, String>,
        state: &SessionState,
    ) -> Result<String, String> {
        if key.method.eq_ignore_ascii_case("NONE") {
            return Ok(String::new());
        }
        if let Some(file) = self.keys.get(&key.uri) {
            return Ok(file.clone());
        }
        let url = Url::parse(&key.uri).map_err(|error| format!("HLS 密钥地址无效: {error}"))?;
        let bytes = fetch_bytes(client, &url, headers, None, MAX_KEY_BYTES).await?;
        let file = format!("keys/{:016x}.key", stable_hash(&key.uri));
        tokio::fs::write(self.bundle.join(&file), &bytes)
            .await
            .map_err(|error| format!("保存 HLS 密钥失败: {error}"))?;
        state.bytes.fetch_add(bytes.len() as u64, Ordering::Relaxed);
        self.keys.insert(key.uri.clone(), file.clone());
        Ok(file)
    }

    async fn ensure_map(
        &mut self,
        client: &Client,
        map: &HlsMap,
        headers: &HashMap<String, String>,
        state: &SessionState,
    ) -> Result<String, String> {
        let identity = format!("{}|{}", map.uri, map.range.as_deref().unwrap_or(""));
        if let Some(file) = self.maps.get(&identity) {
            return Ok(file.clone());
        }
        let url =
            Url::parse(&map.uri).map_err(|error| format!("HLS 初始化片段地址无效: {error}"))?;
        let bytes = fetch_bytes(
            client,
            &url,
            headers,
            map.range.as_deref(),
            MAX_SEGMENT_BYTES,
        )
        .await?;
        let file = format!("maps/{:016x}.map", stable_hash(&identity));
        tokio::fs::write(self.bundle.join(&file), &bytes)
            .await
            .map_err(|error| format!("保存 HLS 初始化片段失败: {error}"))?;
        state.bytes.fetch_add(bytes.len() as u64, Ordering::Relaxed);
        self.maps.insert(identity, file.clone());
        Ok(file)
    }

    fn render_manifest(&self, end_list: bool) -> String {
        let mut text = String::from("#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-PLAYLIST-TYPE:");
        text.push_str(if end_list { "VOD\n" } else { "EVENT\n" });
        text.push_str(&format!(
            "#EXT-X-TARGETDURATION:{}\n",
            self.target_duration.ceil().max(1.0) as u64
        ));
        text.push_str("#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-INDEPENDENT-SEGMENTS\n");
        let mut previous_key: Option<(&str, Option<&str>)> = None;
        let mut previous_map: Option<&str> = None;
        for entry in &self.entries {
            if entry.discontinuity {
                text.push_str("#EXT-X-DISCONTINUITY\n");
            }
            let key = entry
                .key
                .as_deref()
                .map(|value| (value, entry.key_iv.as_deref()));
            if key != previous_key {
                if let Some((key, iv)) = key {
                    text.push_str(&format!("#EXT-X-KEY:METHOD=AES-128,URI=\"{key}\""));
                    if let Some(iv) = iv {
                        text.push_str(&format!(",IV={iv}"));
                    }
                    text.push('\n');
                } else if previous_key.is_some() {
                    text.push_str("#EXT-X-KEY:METHOD=NONE\n");
                }
                previous_key = key;
            }
            if entry.map.as_deref() != previous_map {
                if let Some(map) = entry.map.as_deref() {
                    text.push_str(&format!("#EXT-X-MAP:URI=\"{map}\"\n"));
                }
                previous_map = entry.map.as_deref();
            }
            text.push_str(&format!("#EXTINF:{:.3},\n{}\n", entry.duration, entry.file));
        }
        if end_list {
            text.push_str("#EXT-X-ENDLIST\n");
        }
        text
    }

    async fn write_manifest(&self, end_list: bool) -> std::io::Result<()> {
        tokio::fs::write(
            self.bundle.join("index.m3u8"),
            self.render_manifest(end_list),
        )
        .await
    }
}

async fn run_hls_recording(
    client: Client,
    source: PlayUrl,
    state: Arc<SessionState>,
    mut cancel: watch::Receiver<bool>,
) -> TaskOutcome {
    let mut manifest_url = match Url::parse(&source.url) {
        Ok(url) => url,
        Err(error) => {
            return TaskOutcome {
                status: RecordingStatus::Failed,
                error: Some(error.to_string()),
            };
        }
    };
    let mut archive = HlsArchive::new(state.bundle.clone());
    let mut initialized = false;
    let mut errors = 0;
    loop {
        if *cancel.borrow() {
            let _ = archive.write_manifest(true).await;
            return TaskOutcome {
                status: RecordingStatus::Completed,
                error: None,
            };
        }
        let (body, effective_url) = match fetch_text(&client, &manifest_url, &source.headers).await
        {
            Ok(value) => value,
            Err(error) => {
                errors += 1;
                if errors >= HLS_ERROR_LIMIT {
                    let _ = archive.write_manifest(true).await;
                    return TaskOutcome {
                        status: RecordingStatus::Interrupted,
                        error: Some(error),
                    };
                }
                if wait_or_cancel(&mut cancel, HLS_RETRY_DELAY).await {
                    let _ = archive.write_manifest(true).await;
                    return TaskOutcome {
                        status: RecordingStatus::Completed,
                        error: None,
                    };
                }
                continue;
            }
        };
        if let Some(master) = select_master_variant(&body, &effective_url) {
            manifest_url = master;
            continue;
        }
        let parsed = match parse_media_playlist(&body, &effective_url) {
            Ok(parsed) => parsed,
            Err(error) => {
                let _ = archive.write_manifest(true).await;
                return TaskOutcome {
                    status: if archive.entries.is_empty() {
                        RecordingStatus::Failed
                    } else {
                        RecordingStatus::Interrupted
                    },
                    error: Some(error),
                };
            }
        };
        if parsed.segments.is_empty() {
            errors = 0;
            if parsed.end_list {
                let _ = archive.write_manifest(true).await;
                return TaskOutcome {
                    status: RecordingStatus::Completed,
                    error: None,
                };
            }
            if wait_or_cancel(&mut cancel, target_delay(parsed.target_duration)).await {
                let _ = archive.write_manifest(true).await;
                return TaskOutcome {
                    status: RecordingStatus::Completed,
                    error: None,
                };
            }
            continue;
        }
        let candidates: Vec<HlsSegment> = if initialized {
            parsed.segments.clone()
        } else {
            parsed.segments.last().cloned().into_iter().collect()
        };
        initialized = true;
        let candidate_playlist = ParsedPlaylist {
            media_sequence: parsed.media_sequence,
            target_duration: parsed.target_duration,
            end_list: parsed.end_list,
            segments: candidates,
        };
        match archive
            .append_segments(&client, &candidate_playlist, &source.headers, &state)
            .await
        {
            Ok(_) => errors = 0,
            Err(error) => {
                errors += 1;
                if errors >= HLS_ERROR_LIMIT {
                    let _ = archive.write_manifest(true).await;
                    return TaskOutcome {
                        status: RecordingStatus::Interrupted,
                        error: Some(error),
                    };
                }
            }
        }
        if parsed.end_list {
            let _ = archive.write_manifest(true).await;
            return TaskOutcome {
                status: RecordingStatus::Completed,
                error: None,
            };
        }
        if wait_or_cancel(&mut cancel, target_delay(parsed.target_duration)).await {
            let _ = archive.write_manifest(true).await;
            return TaskOutcome {
                status: RecordingStatus::Completed,
                error: None,
            };
        }
    }
}

async fn fetch_text(
    client: &Client,
    url: &Url,
    headers: &HashMap<String, String>,
) -> Result<(String, Url), String> {
    let source = PlayUrl {
        source_id: String::new(),
        label: String::new(),
        protocol: PlaybackProtocol::Hls,
        priority: 0,
        url: url.to_string(),
        headers: headers.clone(),
        twitch_ad_recovery: None,
    };
    let response = build_request(client, &source)
        .send()
        .await
        .map_err(|error| format!("读取 HLS 清单失败: {}", error.without_url()))?;
    if !response.status().is_success() {
        return Err(format!("HLS 清单返回 HTTP {}", response.status().as_u16()));
    }
    let effective = response.url().clone();
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| format!("读取 HLS 清单失败: {}", error.without_url()))?;
        if bytes.len().saturating_add(chunk.len()) > MAX_MANIFEST_BYTES {
            return Err("HLS 清单过大".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let body = String::from_utf8(bytes).map_err(|_| "HLS 清单不是 UTF-8 文本".to_string())?;
    Ok((body, effective))
}

async fn fetch_bytes(
    client: &Client,
    url: &Url,
    headers: &HashMap<String, String>,
    range: Option<&str>,
    max_bytes: usize,
) -> Result<Vec<u8>, String> {
    let requested_range = range.map(http_byte_range_bounds).transpose()?;
    let source = PlayUrl {
        source_id: String::new(),
        label: String::new(),
        protocol: PlaybackProtocol::Unknown,
        priority: 0,
        url: url.to_string(),
        headers: headers.clone(),
        twitch_ad_recovery: None,
    };
    let mut request = build_request(client, &source);
    if let Some(range) = range {
        request = request.header(reqwest::header::RANGE, format!("bytes={range}"));
    }
    let response = request
        .send()
        .await
        .map_err(|error| format!("读取 HLS 资源失败: {}", error.without_url()))?;
    if !response.status().is_success() {
        return Err(format!("HLS 资源返回 HTTP {}", response.status().as_u16()));
    }
    let response_status = response.status();
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| format!("读取 HLS 资源失败: {}", error.without_url()))?;
        if bytes.len().saturating_add(chunk.len()) > max_bytes {
            return Err("HLS 资源过大".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    if let Some((start, end)) = requested_range {
        let expected = end
            .checked_sub(start)
            .and_then(|length| length.checked_add(1))
            .ok_or_else(|| "HLS BYTERANGE 超出支持范围".to_string())?;
        let received = bytes.len() as u64;
        if response_status == reqwest::StatusCode::PARTIAL_CONTENT {
            if received != expected {
                return Err("HLS BYTERANGE 返回长度不匹配".into());
            }
        } else if received != expected {
            if received <= end {
                return Err("HLS 资源未返回完整的 BYTERANGE 内容".into());
            }
            let start =
                usize::try_from(start).map_err(|_| "HLS BYTERANGE 超出支持范围".to_string())?;
            let end = usize::try_from(end).map_err(|_| "HLS BYTERANGE 超出支持范围".to_string())?;
            bytes = bytes[start..=end].to_vec();
        }
    }
    Ok(bytes)
}

fn http_byte_range_bounds(value: &str) -> Result<(u64, u64), String> {
    let (start, end) = value
        .split_once('-')
        .ok_or_else(|| "HLS BYTERANGE 格式无效".to_string())?;
    let start = start
        .trim()
        .parse::<u64>()
        .map_err(|_| "HLS BYTERANGE 起点无效".to_string())?;
    let end = end
        .trim()
        .parse::<u64>()
        .map_err(|_| "HLS BYTERANGE 终点无效".to_string())?;
    if start > end {
        return Err("HLS BYTERANGE 起点不能大于终点".into());
    }
    Ok((start, end))
}

async fn wait_or_cancel(cancel: &mut watch::Receiver<bool>, duration: Duration) -> bool {
    tokio::select! {
        _ = tokio::time::sleep(duration) => false,
        changed = cancel.changed() => changed.is_ok() && *cancel.borrow(),
    }
}

fn target_delay(target: f64) -> Duration {
    Duration::from_secs_f64(target.clamp(1.0, 10.0) / 2.0)
}

fn select_master_variant(body: &str, base: &Url) -> Option<Url> {
    if !body
        .lines()
        .any(|line| line.trim_start().starts_with("#EXT-X-STREAM-INF"))
    {
        return None;
    }
    let mut best: Option<(u64, Url)> = None;
    let mut bandwidth = 0_u64;
    let mut waiting = false;
    for line in body.lines() {
        let line = line.trim();
        if let Some(attrs) = line.strip_prefix("#EXT-X-STREAM-INF:") {
            bandwidth = attribute_value(attrs, "BANDWIDTH")
                .and_then(|value| value.parse().ok())
                .unwrap_or(0);
            waiting = true;
            continue;
        }
        if waiting && !line.is_empty() && !line.starts_with('#') {
            if let Ok(url) = base.join(line)
                && best
                    .as_ref()
                    .is_none_or(|(current, _)| bandwidth >= *current)
            {
                best = Some((bandwidth, url));
            }
            waiting = false;
        }
    }
    best.map(|(_, url)| url)
}

fn parse_media_playlist(body: &str, base: &Url) -> Result<ParsedPlaylist, String> {
    let header = body
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(|line| line.trim_start_matches('\u{feff}'));
    if header != Some("#EXTM3U") {
        return Err("HLS 清单缺少 #EXTM3U 头".into());
    }
    let mut playlist = ParsedPlaylist::default();
    let mut current_key: Option<HlsKey> = None;
    let mut current_map: Option<HlsMap> = None;
    let mut next_duration: Option<f64> = None;
    let mut next_range: Option<String> = None;
    let mut discontinuity = false;
    let mut gap = false;
    let mut sequence = 0_u64;
    let mut previous_segment_range: Option<(String, u64)> = None;
    let mut previous_map_range: Option<(String, u64)> = None;
    for line in body.lines().map(str::trim) {
        if line.is_empty() {
            continue;
        }
        if let Some(value) = line.strip_prefix("#EXT-X-MEDIA-SEQUENCE:") {
            playlist.media_sequence = value.parse().unwrap_or(0);
            sequence = playlist.media_sequence;
            continue;
        }
        if let Some(value) = line.strip_prefix("#EXT-X-TARGETDURATION:") {
            playlist.target_duration = value.parse().unwrap_or(0.0);
            continue;
        }
        if line == "#EXT-X-ENDLIST" {
            playlist.end_list = true;
            continue;
        }
        if line == "#EXT-X-DISCONTINUITY" {
            discontinuity = true;
            continue;
        }
        if line == "#EXT-X-GAP" {
            gap = true;
            continue;
        }
        if let Some(value) = line.strip_prefix("#EXTINF:") {
            next_duration = value.split(',').next().and_then(|value| value.parse().ok());
            continue;
        }
        if let Some(value) = line.strip_prefix("#EXT-X-BYTERANGE:") {
            next_range = Some(value.trim().to_string());
            continue;
        }
        if let Some(value) = line.strip_prefix("#EXT-X-KEY:") {
            let method = attribute_value(value, "METHOD")
                .unwrap_or_else(|| "NONE".into())
                .to_ascii_uppercase();
            if method == "NONE" {
                current_key = None;
                continue;
            }
            if method != "AES-128" {
                return Err(format!("暂不支持 HLS 加密方式 {method}"));
            }
            let key_format =
                attribute_value(value, "KEYFORMAT").unwrap_or_else(|| "identity".into());
            if !key_format.eq_ignore_ascii_case("identity") {
                return Err(format!("暂不支持 HLS 密钥格式 {key_format}"));
            }
            let uri = attribute_value(value, "URI")
                .ok_or_else(|| "HLS AES-128 密钥缺少 URI".to_string())?;
            current_key = Some(HlsKey {
                method,
                uri: base.join(&uri).map(|url| url.to_string()).unwrap_or(uri),
                iv: attribute_value(value, "IV"),
            });
            continue;
        }
        if let Some(value) = line.strip_prefix("#EXT-X-MAP:") {
            let raw_uri = attribute_value(value, "URI")
                .ok_or_else(|| "HLS 初始化片段缺少 URI".to_string())?;
            let uri = base
                .join(&raw_uri)
                .map(|url| url.to_string())
                .unwrap_or(raw_uri);
            let range = if let Some(value) = attribute_value(value, "BYTERANGE") {
                let implicit_start = previous_map_range
                    .as_ref()
                    .filter(|(previous_uri, _)| previous_uri == &uri)
                    .map(|(_, end)| *end);
                let (range, end) = hls_http_byte_range(&value, implicit_start)?;
                previous_map_range = Some((uri.clone(), end));
                Some(range)
            } else {
                previous_map_range = None;
                None
            };
            current_map = Some(HlsMap { uri, range });
            continue;
        }
        if line.starts_with('#') {
            continue;
        }
        let Ok(uri) = base.join(line) else { continue };
        let range = if let Some(value) = next_range.take() {
            let uri_text = uri.to_string();
            let implicit_start = previous_segment_range
                .as_ref()
                .filter(|(previous_uri, _)| previous_uri == &uri_text)
                .map(|(_, end)| *end);
            let (range, end) = hls_http_byte_range(&value, implicit_start)?;
            previous_segment_range = Some((uri_text, end));
            Some(range)
        } else {
            previous_segment_range = None;
            None
        };
        let identity = format!("{}|{}|{}", sequence, uri, range.as_deref().unwrap_or(""));
        playlist.segments.push(HlsSegment {
            uri,
            sequence,
            duration: next_duration.unwrap_or(0.0),
            identity,
            key: current_key.clone(),
            map: current_map.clone(),
            range,
            discontinuity,
            gap,
        });
        sequence = sequence.saturating_add(1);
        next_duration = None;
        discontinuity = false;
        gap = false;
    }
    Ok(playlist)
}

/// HLS uses `length@offset`; HTTP uses an inclusive `start-end` range.
/// An omitted offset continues immediately after the previous range for the
/// same resource, as required by RFC 8216.
fn hls_http_byte_range(value: &str, implicit_start: Option<u64>) -> Result<(String, u64), String> {
    let value = value.trim().trim_matches('"');
    let (length, explicit_start) = value
        .split_once('@')
        .map_or((value, None), |(length, start)| (length, Some(start)));
    let length = length
        .trim()
        .parse::<u64>()
        .map_err(|_| format!("HLS BYTERANGE 长度无效: {value}"))?;
    if length == 0 {
        return Err("HLS BYTERANGE 长度不能为 0".into());
    }
    let start = match explicit_start {
        Some(start) => start
            .trim()
            .parse::<u64>()
            .map_err(|_| format!("HLS BYTERANGE 偏移无效: {value}"))?,
        None => implicit_start.ok_or_else(|| "HLS BYTERANGE 缺少可推导的偏移".to_string())?,
    };
    let end_exclusive = start
        .checked_add(length)
        .ok_or_else(|| "HLS BYTERANGE 超出支持范围".to_string())?;
    Ok((format!("{start}-{}", end_exclusive - 1), end_exclusive))
}

fn hls_media_sequence_iv(sequence: u64) -> String {
    format!("0x{sequence:032x}")
}

fn parse_attribute_list(value: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut start = 0;
    let mut quoted = false;
    for (index, character) in value.char_indices() {
        match character {
            '"' => quoted = !quoted,
            ',' if !quoted => {
                push_attribute(&mut out, &value[start..index]);
                start = index + 1;
            }
            _ => {}
        }
    }
    push_attribute(&mut out, &value[start..]);
    out
}

fn push_attribute(out: &mut Vec<(String, String)>, value: &str) {
    if let Some((key, value)) = value.split_once('=') {
        out.push((
            key.trim().to_ascii_uppercase(),
            value.trim().trim_matches('"').to_string(),
        ));
    }
}

fn attribute_value(value: &str, key: &str) -> Option<String> {
    parse_attribute_list(value)
        .into_iter()
        .find(|(name, _)| name == &key.to_ascii_uppercase())
        .map(|(_, value)| value)
}

fn segment_extension(url: &Url, bytes: &[u8]) -> &'static str {
    let path = url.path().to_ascii_lowercase();
    if path.ends_with(".m4s") {
        "m4s"
    } else if path.ends_with(".mp4") {
        "mp4"
    } else if path.ends_with(".aac") {
        "aac"
    } else if bytes.first() == Some(&0x47) {
        "ts"
    } else {
        "bin"
    }
}

fn stable_hash(value: &str) -> u64 {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

// -------------------------------------------------------------------------
// Local playback server

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
                return Ok(format!(
                    "{}/{}/{}/{}",
                    server.base_url, server.token, id, media_file
                ));
            }
        }

        // Bind outside the synchronous mutex. Tauri commands may call this
        // concurrently when two library cards are opened at once.
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
        Ok(format!(
            "{}/{}/{}/{}",
            server.base_url, server.token, id, media_file
        ))
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
    let Some(id) = components.next() else {
        write_simple_response(socket, 404, "Not Found", "").await?;
        return Ok(());
    };
    if !is_safe_recording_id(id) {
        write_simple_response(socket, 404, "Not Found", "").await?;
        return Ok(());
    }
    let relative: PathBuf = components
        .collect::<Vec<_>>()
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect();
    if relative.as_os_str().is_empty() || !safe_relative_path(&relative) {
        write_simple_response(socket, 404, "Not Found", "").await?;
        return Ok(());
    }
    let roots = storage
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .roots
        .clone();
    let Some(bundle) = find_bundle(&roots, id) else {
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

fn request_header<'a>(head: &'a str, name: &str) -> Option<&'a str> {
    head.lines().skip(1).find_map(|line| {
        let (key, value) = line.split_once(':')?;
        key.trim()
            .eq_ignore_ascii_case(name)
            .then_some(value.trim())
            .filter(|value| !value.is_empty())
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
        ArchiveEntry, HlsArchive, RecordingManager, RecordingStartInput, RecordingStatus,
        StoredDanmakuBatch, StoredRecording, attribute_value, hls_media_sequence_iv,
        http_byte_range_bounds, parse_media_playlist, parse_range, safe_relative_path,
        select_master_variant, write_metadata,
    };
    use crate::models::live::{DanmakuEvent, DanmakuKind, PlaybackProtocol};
    use reqwest::Url;
    use std::collections::HashSet;
    use std::path::PathBuf;
    use uuid::Uuid;

    #[test]
    fn parses_hls_attributes_with_quoted_commas() {
        assert_eq!(
            attribute_value("METHOD=AES-128,URI=\"keys/a,b\",IV=0x01", "URI").as_deref(),
            Some("keys/a,b")
        );
    }

    #[test]
    fn selects_the_highest_bandwidth_master_variant() {
        let base = Url::parse("https://example.test/master.m3u8").unwrap();
        let url = select_master_variant(
            "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=500\nhigh.m3u8\n",
            &base,
        )
        .unwrap();
        assert_eq!(url.as_str(), "https://example.test/high.m3u8");
    }

    #[test]
    fn parses_media_sequence_and_relative_segments() {
        let base = Url::parse("https://example.test/live/index.m3u8").unwrap();
        let playlist = parse_media_playlist(
            "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:12\n#EXT-X-TARGETDURATION:4\n#EXTINF:3.5,\nseg.ts\n#EXTINF:4,\nnext.ts\n",
            &base,
        )
        .unwrap();
        assert_eq!(playlist.media_sequence, 12);
        assert_eq!(playlist.segments.len(), 2);
        assert_eq!(
            playlist.segments[0].identity,
            "12|https://example.test/live/seg.ts|"
        );
    }

    #[test]
    fn rejects_a_non_hls_response_before_polling_it_forever() {
        let base = Url::parse("https://example.test/live/index.m3u8").unwrap();
        let error = parse_media_playlist("<html>sign in</html>", &base).unwrap_err();

        assert!(error.contains("#EXTM3U"));
    }

    #[test]
    fn converts_explicit_and_implicit_hls_byte_ranges() {
        let base = Url::parse("https://example.test/live/index.m3u8").unwrap();
        let playlist = parse_media_playlist(
            "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:7\n#EXT-X-MAP:URI=\"media.mp4\",BYTERANGE=\"8@0\"\n#EXTINF:2,\n#EXT-X-BYTERANGE:4@8\nmedia.mp4\n#EXTINF:2,\n#EXT-X-BYTERANGE:3\nmedia.mp4\n",
            &base,
        )
        .unwrap();

        assert_eq!(
            playlist.segments[0].map.as_ref().unwrap().range.as_deref(),
            Some("0-7")
        );
        assert_eq!(playlist.segments[0].range.as_deref(), Some("8-11"));
        assert_eq!(playlist.segments[1].range.as_deref(), Some("12-14"));
        assert_eq!(http_byte_range_bounds("12-14").unwrap(), (12, 14));
        assert!(http_byte_range_bounds("14-12").is_err());
    }

    #[test]
    fn derives_aes_iv_from_the_original_media_sequence() {
        let base = Url::parse("https://example.test/live/index.m3u8").unwrap();
        let playlist = parse_media_playlist(
            "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:12\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"\n#EXTINF:4,\nsegment.ts\n",
            &base,
        )
        .unwrap();

        assert_eq!(playlist.segments[0].sequence, 12);
        assert_eq!(playlist.segments[0].key.as_ref().unwrap().iv, None);
        assert_eq!(
            hls_media_sequence_iv(12),
            "0x0000000000000000000000000000000c"
        );
    }

    #[test]
    fn rejects_unsupported_hls_encryption_methods() {
        let base = Url::parse("https://example.test/live/index.m3u8").unwrap();
        let error = parse_media_playlist(
            "#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI=\"key.bin\"\n#EXTINF:4,\nsegment.ts\n",
            &base,
        )
        .unwrap_err();

        assert!(error.contains("SAMPLE-AES"));
    }

    #[test]
    fn renders_hls_manifest_with_key_map_and_endlist_in_order() {
        let mut archive = HlsArchive::new(PathBuf::new());
        archive.target_duration = 4.0;
        archive.entries = vec![
            ArchiveEntry {
                file: "segments/00000000.ts".into(),
                duration: 2.5,
                key: Some("keys/0000000000000001.key".into()),
                key_iv: Some("0x0000000000000000000000000000000c".into()),
                map: Some("maps/0000000000000002.map".into()),
                discontinuity: false,
            },
            ArchiveEntry {
                file: "segments/00000001.ts".into(),
                duration: 3.0,
                key: Some("keys/0000000000000001.key".into()),
                key_iv: Some("0x0000000000000000000000000000000c".into()),
                map: Some("maps/0000000000000002.map".into()),
                discontinuity: false,
            },
            ArchiveEntry {
                file: "segments/00000002.ts".into(),
                duration: 1.0,
                key: None,
                key_iv: None,
                map: None,
                discontinuity: true,
            },
        ];

        let manifest = archive.render_manifest(true);
        let key_at = manifest.find("#EXT-X-KEY:METHOD=AES-128").unwrap();
        let map_at = manifest.find("#EXT-X-MAP:").unwrap();
        let segment_at = manifest.find("#EXTINF:2.500").unwrap();
        assert!(key_at < map_at && map_at < segment_at);
        assert!(manifest.contains("IV=0x0000000000000000000000000000000c"));
        assert!(manifest.contains("#EXT-X-DISCONTINUITY\n"));
        assert!(manifest.contains("#EXT-X-KEY:METHOD=NONE\n"));
        assert!(manifest.ends_with("#EXT-X-ENDLIST\n"));
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

    fn completed_recording(id: String, title: &str) -> StoredRecording {
        StoredRecording {
            id,
            source_key: format!("live:bilibili:{title}"),
            source_kind: "live".into(),
            site_id: Some("bilibili".into()),
            room_id: Some(title.into()),
            title: title.into(),
            user_name: "主播".into(),
            cover: String::new(),
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
    fn background_continuation_defaults_to_disabled() {
        let input: RecordingStartInput = serde_json::from_value(serde_json::json!({
            "source": {
                "url": "https://example.test/live.flv",
                "headers": {}
            },
            "sourceKey": "live:bilibili:100",
            "sourceKind": "live"
        }))
        .unwrap();
        assert!(!input.continue_on_leave);

        let mut legacy_metadata =
            serde_json::to_value(completed_recording("legacy".into(), "legacy")).unwrap();
        legacy_metadata
            .as_object_mut()
            .unwrap()
            .remove("continue_on_leave");
        let stored: StoredRecording = serde_json::from_value(legacy_metadata).unwrap();
        assert!(!stored.continue_on_leave);
    }

    #[test]
    fn storage_switch_keeps_default_and_historical_recordings_visible() {
        let app_directory =
            std::env::temp_dir().join(format!("rlive-recording-storage-{}", Uuid::new_v4()));
        let manager = RecordingManager::new(&app_directory).unwrap();
        let default_root = PathBuf::from(manager.storage_path());
        let first = completed_recording(Uuid::new_v4().to_string(), "default");
        let first_bundle = default_root.join(&first.id);
        std::fs::create_dir_all(&first_bundle).unwrap();
        std::fs::write(first_bundle.join("stream.flv"), b"a").unwrap();
        write_metadata(&first_bundle, &first).unwrap();

        let custom_root = app_directory.join("custom-recordings");
        let custom_info = manager
            .set_storage_path(Some(custom_root.display().to_string()))
            .unwrap();
        assert!(!custom_info.is_default);
        let second = completed_recording(Uuid::new_v4().to_string(), "custom");
        let second_bundle = PathBuf::from(&custom_info.path).join(&second.id);
        std::fs::create_dir_all(&second_bundle).unwrap();
        std::fs::write(second_bundle.join("stream.flv"), b"b").unwrap();
        write_metadata(&second_bundle, &second).unwrap();

        let titles: HashSet<_> = manager
            .list()
            .unwrap()
            .into_iter()
            .map(|item| item.title)
            .collect();
        assert_eq!(titles, HashSet::from(["default".into(), "custom".into()]));

        let default_info = manager.set_storage_path(None).unwrap();
        assert!(default_info.is_default);
        drop(manager);

        let restarted = RecordingManager::new(&app_directory).unwrap();
        let titles: HashSet<_> = restarted
            .list()
            .unwrap()
            .into_iter()
            .map(|item| item.title)
            .collect();
        assert_eq!(titles, HashSet::from(["default".into(), "custom".into()]));
        drop(restarted);
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
}
