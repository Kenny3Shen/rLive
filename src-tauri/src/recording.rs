//! Desktop live-stream recorder and local playback service.
//!
//! Recordings deliberately live outside the SQLite database. A recording is a
//! small self-contained bundle (metadata plus media, or an HLS playlist and
//! its segments), so it remains recoverable when the application is killed and
//! can be inspected or copied by the user without a database export.

#![cfg(not(target_os = "android"))]

use std::collections::{HashMap, HashSet};
use std::fs::OpenOptions;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use chrono::{Local, TimeZone};
use futures_util::StreamExt;
use percent_encoding::percent_decode_str;
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use tauri::async_runtime::JoinHandle;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::http_client;
use crate::models::live::{DanmakuEvent, PlayUrl, PlaybackProtocol, TwitchAdRecovery};

const RECORDINGS_DIRECTORY: &str = "recordings";
const RECORDING_STORAGE_CONFIG_FILE: &str = "recording-storage.json";
const MAX_ACTIVE_RECORDINGS: usize = 4;
const MAX_MANIFEST_BYTES: usize = 4 * 1024 * 1024;
const MAX_SEGMENT_BYTES: usize = 256 * 1024 * 1024;
const MAX_KEY_BYTES: usize = 64 * 1024;
const HLS_ERROR_LIMIT: u32 = 10;
const HLS_RETRY_DELAY: Duration = Duration::from_secs(2);
const TWITCH_HLS_REFRESH_RETRY_DELAY: Duration = Duration::from_secs(8);
const TWITCH_EMPTY_PLAYLIST_REFRESH_LIMIT: u32 = 3;
const DIRECT_ERROR_LIMIT: u32 = 10;
const DIRECT_RETRY_DELAY: Duration = Duration::from_secs(1);
const DIRECT_MAX_RETRY_DELAY: Duration = Duration::from_secs(8);
const FLV_HEADER_BYTES: usize = 13;

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
        let stream_client = http_client::recording_stream_client_for_proxy(proxy)?;

        let id = Uuid::new_v4().to_string();
        let protocol = if input.source.protocol == PlaybackProtocol::Unknown {
            PlaybackProtocol::infer_from_url(&input.source.url)
        } else {
            input.source.protocol
        };
        let root = self.current_root();
        let started_at = unix_ms();
        let title = normalize_text(&input.title, "未命名直播");
        let user_name = normalize_text(&input.user_name, "");
        let file_stem = recording_file_stem(&user_name, &title, started_at);
        let media_file = media_file_name(protocol, &input.source.url, &file_stem);
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
            title,
            user_name,
            cover: normalize_text(&input.cover, ""),
            protocol,
            status: RecordingStatus::Recording,
            started_at,
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
            let outcome =
                run_recording_task(client, stream_client, source, task_state.clone(), cancel_rx)
                    .await;
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
        if stored.protocol == PlaybackProtocol::Flv {
            let normalize_path = file.clone();
            match tokio::task::spawn_blocking(move || normalize_flv_timestamps(&normalize_path))
                .await
            {
                Ok(Ok(Some(duration_ms))) if duration_ms > 0 => {
                    if stored.duration_ms != duration_ms {
                        let mut updated = stored.clone();
                        updated.duration_ms = duration_ms;
                        updated.size_bytes = bundle_size(&root.join(id));
                        let _ = write_metadata(&root.join(id), &updated);
                    }
                }
                Ok(Ok(_)) => {}
                Ok(Err(error)) => {
                    tracing::warn!(error = %error, "无法修复历史 FLV 时间戳，继续使用原始录制文件");
                }
                Err(error) => {
                    tracing::warn!(error = %error, "历史 FLV 修复任务未完成，继续使用原始录制文件");
                }
            }
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
    stream_client: Client,
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
        _ => run_direct_recording(stream_client, source, state, cancel).await,
    }
}

async fn run_direct_recording(
    client: Client,
    source: PlayUrl,
    state: Arc<SessionState>,
    mut cancel: watch::Receiver<bool>,
) -> TaskOutcome {
    let (media_file_name, protocol, site_id) = {
        let stored = state
            .stored
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        (
            stored.media_file.clone(),
            stored.protocol,
            stored.site_id.clone(),
        )
    };
    let part = state.bundle.join(format!("{media_file_name}.part"));
    let final_path = state.bundle.join(media_file_name);
    let mut file = match tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&part)
        .await
    {
        Ok(file) => file,
        Err(error) => {
            return TaskOutcome {
                status: RecordingStatus::Failed,
                error: Some(format!("创建录制文件失败: {error}")),
            };
        }
    };
    let started = Instant::now();
    let candidates = direct_source_candidates(&source, site_id.as_deref());
    let mut preferred_candidate = 0_usize;
    let mut errors = 0_u32;
    let mut last_error = "直播流连接已关闭".to_string();

    loop {
        if *cancel.borrow() {
            return finalize_direct_recording(
                file,
                &part,
                &final_path,
                &state,
                TaskOutcome {
                    status: RecordingStatus::Completed,
                    error: None,
                },
            )
            .await;
        }

        let mut round_error = None;
        let mut round_retryable = false;
        let mut opened_stream = false;

        for offset in 0..candidates.len() {
            let candidate_index = (preferred_candidate + offset) % candidates.len();
            let candidate = &candidates[candidate_index];
            let response = tokio::select! {
                response = build_request(&client, candidate).send() => response,
                changed = cancel.changed() => {
                    if changed.is_err() || *cancel.borrow() {
                        return finalize_direct_recording(
                            file,
                            &part,
                            &final_path,
                            &state,
                            TaskOutcome {
                                status: RecordingStatus::Completed,
                                error: None,
                            },
                        ).await;
                    }
                    continue;
                }
            };

            let response = match response {
                Ok(response) if response.status().is_success() => response,
                Ok(response) => {
                    let status = response.status();
                    round_retryable |= retryable_direct_status(status);
                    round_error
                        .get_or_insert_with(|| format!("直播源返回 HTTP {}", status.as_u16()));
                    continue;
                }
                Err(error) => {
                    round_retryable = true;
                    round_error
                        .get_or_insert_with(|| format!("连接直播源失败: {}", error.without_url()));
                    continue;
                }
            };

            opened_stream = true;
            preferred_candidate = candidate_index;
            let mut stream = response.bytes_stream();
            let mut flv_stream = (protocol == PlaybackProtocol::Flv)
                .then(|| FlvResponseBuffer::new(state.bytes.load(Ordering::Relaxed) == 0));
            let mut received_media = false;
            let mut cancelled = false;
            let stream_error = loop {
                let next = tokio::select! {
                    value = stream.next() => value,
                    changed = cancel.changed() => {
                        if changed.is_err() || *cancel.borrow() {
                            cancelled = true;
                        }
                        None
                    }
                };
                let Some(next) = next else {
                    break "直播流连接已关闭".to_string();
                };
                let chunk = match next {
                    Ok(chunk) => chunk,
                    Err(error) => {
                        break format!("读取直播流中断: {}", error.without_url());
                    }
                };
                if chunk.is_empty() {
                    continue;
                }
                match write_direct_chunk(&mut file, &chunk, &mut flv_stream).await {
                    Ok(written) => {
                        if written > 0 {
                            received_media = true;
                            errors = 0;
                            state.bytes.fetch_add(written as u64, Ordering::Relaxed);
                            state.duration_ms.store(
                                started.elapsed().as_millis().min(u64::MAX as u128) as u64,
                                Ordering::Relaxed,
                            );
                        }
                    }
                    Err(error) => {
                        return finalize_direct_recording(
                            file,
                            &part,
                            &final_path,
                            &state,
                            TaskOutcome {
                                status: RecordingStatus::Failed,
                                error: Some(format!("写入录制文件失败: {error}")),
                            },
                        )
                        .await;
                    }
                }
            };

            if let Some(stream) = flv_stream.as_ref()
                && !stream.pending.is_empty()
            {
                tracing::debug!(
                    discarded_bytes = stream.pending.len(),
                    "丢弃连接末尾不完整的 FLV tag"
                );
            }

            if cancelled {
                return finalize_direct_recording(
                    file,
                    &part,
                    &final_path,
                    &state,
                    TaskOutcome {
                        status: RecordingStatus::Completed,
                        error: None,
                    },
                )
                .await;
            }

            round_retryable = true;
            round_error = Some(stream_error);
            if received_media {
                // Data from this connection proves the URL is still valid. On
                // the next reconnect, retry this candidate before fallbacks.
                errors = 0;
            }
            break;
        }

        if let Some(error) = round_error {
            last_error = error;
        }

        if !round_retryable {
            let status = direct_failure_status(&state);
            return finalize_direct_recording(
                file,
                &part,
                &final_path,
                &state,
                TaskOutcome {
                    status,
                    error: Some(last_error),
                },
            )
            .await;
        }

        errors = errors.saturating_add(1);
        if errors >= DIRECT_ERROR_LIMIT {
            let status = direct_failure_status(&state);
            return finalize_direct_recording(
                file,
                &part,
                &final_path,
                &state,
                TaskOutcome {
                    status,
                    error: Some(last_error),
                },
            )
            .await;
        }

        tracing::warn!(
            attempt = errors,
            opened_stream,
            error = %last_error,
            "直播录制连接中断，准备重连"
        );
        if wait_or_cancel(&mut cancel, direct_retry_delay(errors)).await {
            return finalize_direct_recording(
                file,
                &part,
                &final_path,
                &state,
                TaskOutcome {
                    status: RecordingStatus::Completed,
                    error: None,
                },
            )
            .await;
        }
    }
}

struct FlvResponseBuffer {
    pending: Vec<u8>,
    header_processed: bool,
    keep_header: bool,
}

impl FlvResponseBuffer {
    fn new(keep_header: bool) -> Self {
        Self {
            pending: Vec::new(),
            header_processed: false,
            keep_header,
        }
    }
}

async fn write_direct_chunk(
    file: &mut tokio::fs::File,
    chunk: &[u8],
    flv_stream: &mut Option<FlvResponseBuffer>,
) -> std::io::Result<usize> {
    let Some(stream) = flv_stream.as_mut() else {
        file.write_all(chunk).await?;
        return Ok(chunk.len());
    };
    stream.pending.extend_from_slice(chunk);

    if !stream.header_processed {
        if stream.pending.len() < FLV_HEADER_BYTES {
            return Ok(0);
        }
        if !stream.pending.starts_with(b"FLV") {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "FLV 响应缺少文件头",
            ));
        }
        stream.header_processed = true;
        if !stream.keep_header {
            stream.pending.drain(..FLV_HEADER_BYTES);
        }
    }

    let mut offset = if stream.keep_header {
        FLV_HEADER_BYTES
    } else {
        0
    };
    let first_tag_offset = offset;
    loop {
        if stream.pending.len().saturating_sub(offset) < 11 {
            break;
        }
        let tag_type = stream.pending[offset] & 0x1f;
        if !matches!(tag_type, 8 | 9 | 18) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "FLV tag 类型无效",
            ));
        }
        let data_size = (usize::from(stream.pending[offset + 1]) << 16)
            | (usize::from(stream.pending[offset + 2]) << 8)
            | usize::from(stream.pending[offset + 3]);
        let tag_size = 11_usize
            .checked_add(data_size)
            .and_then(|size| size.checked_add(4))
            .ok_or_else(|| {
                std::io::Error::new(std::io::ErrorKind::InvalidData, "FLV tag 长度溢出")
            })?;
        if tag_size > MAX_SEGMENT_BYTES {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "FLV tag 超过大小限制",
            ));
        }
        if stream.pending.len().saturating_sub(offset) < tag_size {
            break;
        }
        offset += tag_size;
    }
    if offset == first_tag_offset {
        return Ok(0);
    }

    file.write_all(&stream.pending[..offset]).await?;
    stream.pending.drain(..offset);
    stream.keep_header = false;
    Ok(offset)
}

async fn finalize_direct_recording(
    mut file: tokio::fs::File,
    part: &Path,
    final_path: &Path,
    state: &SessionState,
    outcome: TaskOutcome,
) -> TaskOutcome {
    let flush_error = file.flush().await.err().or(file.sync_data().await.err());
    drop(file);

    if state.bytes.load(Ordering::Relaxed) == 0 && outcome.status != RecordingStatus::Completed {
        let _ = tokio::fs::remove_file(part).await;
        return outcome;
    }
    if let Some(error) = flush_error {
        return TaskOutcome {
            status: RecordingStatus::Failed,
            error: Some(format!("完成录制文件失败: {error}")),
        };
    }
    let is_flv = state
        .stored
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .protocol
        == PlaybackProtocol::Flv;
    if is_flv {
        let normalize_path = part.to_path_buf();
        match tokio::task::spawn_blocking(move || normalize_flv_timestamps(&normalize_path)).await {
            Ok(Ok(Some(duration_ms))) if duration_ms > 0 => {
                state.duration_ms.store(duration_ms, Ordering::Relaxed);
            }
            Ok(Ok(_)) => {}
            Ok(Err(error)) => {
                tracing::warn!(error = %error, "无法连续化 FLV 时间戳，保留原始录制文件");
            }
            Err(error) => {
                tracing::warn!(error = %error, "FLV 时间戳处理任务未完成，保留原始录制文件");
            }
        }
    }
    // FLV normalization can discard a replayed GOP, so refresh the live byte
    // counter from the normalized part before publishing the finished item.
    if let Ok(metadata) = tokio::fs::metadata(part).await {
        state.bytes.store(metadata.len(), Ordering::Relaxed);
    }
    if let Err(error) = finalize_part(part, final_path).await {
        return TaskOutcome {
            status: RecordingStatus::Failed,
            error: Some(format!("完成录制文件失败: {error}")),
        };
    }
    outcome
}

const FLV_RESYNC_SCAN_BYTES: u64 = 16 * 1024 * 1024;
const FLV_ABSOLUTE_CLOCK_THRESHOLD_MS: u32 = 1_000_000;

#[derive(Clone, Copy)]
enum FlvReplayCutoff {
    Inactive,
    AbsoluteClock,
    Timestamp(u32),
}

fn flv_media_track(tag_type: u8) -> Option<usize> {
    match tag_type {
        8 => Some(0),
        9 => Some(1),
        _ => None,
    }
}

fn flv_payload_is_codec_sequence_header(tag_type: u8, payload: &[u8]) -> bool {
    let Some(&media_header) = payload.first() else {
        return false;
    };
    match tag_type {
        8 if media_header >> 4 == 10 => payload.get(1) == Some(&0),
        9 if media_header & 0x80 != 0 => media_header & 0x0f == 0,
        9 if matches!(media_header & 0x0f, 7 | 12) => payload.get(1) == Some(&0),
        _ => false,
    }
}

fn flv_tag_length(bytes: &[u8], offset: usize) -> Option<usize> {
    if bytes.len().saturating_sub(offset) < 11 {
        return None;
    }
    let tag_type = bytes[offset] & 0x1f;
    if !matches!(tag_type, 8 | 9 | 18) {
        return None;
    }
    let data_size = (usize::from(bytes[offset + 1]) << 16)
        | (usize::from(bytes[offset + 2]) << 8)
        | usize::from(bytes[offset + 3]);
    let total = 11_usize.checked_add(data_size)?.checked_add(4)?;
    (total <= MAX_SEGMENT_BYTES && bytes.len().saturating_sub(offset) >= total).then_some(total)
}

fn flv_tag_timestamp(bytes: &[u8], offset: usize) -> Option<u32> {
    (bytes.len().saturating_sub(offset) >= 8).then(|| {
        (u32::from(bytes[offset + 4]) << 16)
            | (u32::from(bytes[offset + 5]) << 8)
            | u32::from(bytes[offset + 6])
            | (u32::from(bytes[offset + 7]) << 24)
    })
}

fn find_flv_resync(
    input: &mut std::fs::File,
    start: u64,
    file_len: u64,
) -> std::io::Result<Option<u64>> {
    if start >= file_len {
        return Ok(None);
    }
    let scan_len = (file_len - start).min(FLV_RESYNC_SCAN_BYTES) as usize;
    input.seek(SeekFrom::Start(start))?;
    let mut scan = vec![0_u8; scan_len];
    input.read_exact(&mut scan)?;
    for offset in 0..=scan.len().saturating_sub(15) {
        let Some(tag_len) = flv_tag_length(&scan, offset) else {
            continue;
        };
        let previous_size = u32::from_be_bytes(
            scan[offset + tag_len - 4..offset + tag_len]
                .try_into()
                .expect("FLV previous tag size is four bytes"),
        );
        if previous_size != (tag_len - 4) as u32 {
            continue;
        }
        let absolute = start + offset as u64;
        // Require a second tag when there is enough data. This rejects almost
        // all byte patterns inside H.264 payloads without scanning unboundedly.
        let mut cursor = offset + tag_len;
        let mut previous_timestamp = flv_tag_timestamp(&scan, offset);
        let mut sequence_tags = 1;
        while sequence_tags < 3 {
            let Some(next_len) = flv_tag_length(&scan, cursor) else {
                break;
            };
            let Some(next_timestamp) = flv_tag_timestamp(&scan, cursor) else {
                break;
            };
            if previous_timestamp
                .is_some_and(|previous| previous.abs_diff(next_timestamp) > 120_000)
            {
                sequence_tags = 0;
                break;
            }
            previous_timestamp = Some(next_timestamp);
            cursor += next_len;
            sequence_tags += 1;
        }
        if sequence_tags < 2 && offset + tag_len != scan.len() {
            continue;
        }
        return Ok(Some(absolute));
    }
    Ok(None)
}

fn has_future_flv_media_timestamp(
    input: &mut std::fs::File,
    start: u64,
    file_len: u64,
    threshold: u32,
) -> std::io::Result<bool> {
    if start >= file_len {
        return Ok(false);
    }
    let original_position = input.stream_position()?;
    let scan_len = (file_len - start).min(FLV_RESYNC_SCAN_BYTES) as usize;
    input.seek(SeekFrom::Start(start))?;
    let mut scan = vec![0_u8; scan_len];
    input.read_exact(&mut scan)?;
    let mut offset = 0;
    let mut found = false;
    while offset + 11 <= scan.len() {
        let tag_type = scan[offset] & 0x1f;
        let data_size = (usize::from(scan[offset + 1]) << 16)
            | (usize::from(scan[offset + 2]) << 8)
            | usize::from(scan[offset + 3]);
        let Some(total) = 11_usize
            .checked_add(data_size)
            .and_then(|size| size.checked_add(4))
        else {
            offset += 1;
            continue;
        };
        if !matches!(tag_type, 8 | 9 | 18)
            || total > MAX_SEGMENT_BYTES
            || offset + total > scan.len()
        {
            offset += 1;
            continue;
        }
        let previous_size = u32::from_be_bytes(
            scan[offset + total - 4..offset + total]
                .try_into()
                .expect("FLV previous tag size is four bytes"),
        );
        if previous_size != (total - 4) as u32 {
            offset += 1;
            continue;
        }
        if matches!(tag_type, 8 | 9) {
            let timestamp = (u32::from(scan[offset + 4]) << 16)
                | (u32::from(scan[offset + 5]) << 8)
                | u32::from(scan[offset + 6])
                | (u32::from(scan[offset + 7]) << 24);
            if timestamp > threshold {
                found = true;
                break;
            }
        }
        offset += total;
    }
    input.seek(SeekFrom::Start(original_position))?;
    Ok(found)
}

/// Reconnectable FLV sources may replay a previously delivered GOP before the
/// live edge, or restart their timestamp clock at zero for every response.
/// Keep codec sequence headers at the boundary, drop ordinary media tags that
/// are already covered on their track, and rebase true clock resets onto the
/// previous timeline. A reconnect can also leave a partial tag before the next
/// response's metadata; bounded resynchronization drops that fragment and
/// continues with the next valid tag.
fn normalize_flv_timestamps(path: &Path) -> std::io::Result<Option<u64>> {
    let mut input = std::fs::File::open(path)?;
    let mut header = [0_u8; 9];
    input.read_exact(&mut header)?;
    if &header[..3] != b"FLV" {
        return Ok(None);
    }
    let mut previous_tag_size = [0_u8; 4];
    input.read_exact(&mut previous_tag_size)?;

    let mut temporary_name = path.file_name().unwrap_or_default().to_os_string();
    temporary_name.push(format!(".normalized-{}", Uuid::new_v4().simple()));
    let temporary = path.with_file_name(temporary_name);
    let mut output = std::fs::File::create(&temporary)?;
    output.write_all(&header)?;
    output.write_all(&previous_tag_size)?;

    let mut previous_input_timestamps = [None, None];
    let mut timestamp_offset = 0_i64;
    let mut first_output_timestamp = None;
    let mut last_output_timestamp = 0_u32;
    let mut changed = false;
    let mut replay_cutoffs = [FlvReplayCutoff::Inactive; 2];
    let mut shared_epoch_guard = false;

    let file_len = input.metadata()?.len();
    loop {
        let tag_start = input.stream_position()?;
        let mut tag_header = [0_u8; 11];
        let read = input.read(&mut tag_header)?;
        if read == 0 {
            break;
        }
        if read != tag_header.len() {
            changed = true;
            break;
        }

        let tag_type = tag_header[0] & 0x1f;
        let data_size = (usize::from(tag_header[1]) << 16)
            | (usize::from(tag_header[2]) << 8)
            | usize::from(tag_header[3]);
        if !matches!(tag_type, 8 | 9 | 18) || data_size > MAX_SEGMENT_BYTES {
            changed = true;
            let Some(resync) = find_flv_resync(&mut input, tag_start + 1, file_len)? else {
                if file_len.saturating_sub(tag_start + 1) > FLV_RESYNC_SCAN_BYTES {
                    let _ = std::fs::remove_file(&temporary);
                    return Ok(None);
                }
                break;
            };
            input.seek(SeekFrom::Start(resync))?;
            continue;
        }
        let data_start = tag_start + 11;
        let previous_size_position = data_start + data_size as u64;
        if previous_size_position + 4 > file_len {
            changed = true;
            break;
        }
        let mut payload_prefix = [0_u8; 2];
        let prefix_len = data_size.min(payload_prefix.len());
        input.read_exact(&mut payload_prefix[..prefix_len])?;
        input.seek(SeekFrom::Start(previous_size_position))?;
        let mut actual_previous_size = [0_u8; 4];
        input.read_exact(&mut actual_previous_size)?;
        if u32::from_be_bytes(actual_previous_size) != (data_size as u32).saturating_add(11) {
            changed = true;
            let Some(resync) = find_flv_resync(&mut input, tag_start + 1, file_len)? else {
                if file_len.saturating_sub(tag_start + 1) > FLV_RESYNC_SCAN_BYTES {
                    let _ = std::fs::remove_file(&temporary);
                    return Ok(None);
                }
                break;
            };
            input.seek(SeekFrom::Start(resync))?;
            continue;
        }

        let input_timestamp = (u32::from(tag_header[4]) << 16)
            | (u32::from(tag_header[5]) << 8)
            | u32::from(tag_header[6])
            | (u32::from(tag_header[7]) << 24);
        let media_track = flv_media_track(tag_type);
        let is_media_tag = media_track.is_some();
        let is_codec_sequence_header =
            flv_payload_is_codec_sequence_header(tag_type, &payload_prefix[..prefix_len]);
        let mut pinned_codec_header = false;
        if let Some(track) = media_track {
            let still_replayed = match replay_cutoffs[track] {
                FlvReplayCutoff::Inactive => false,
                FlvReplayCutoff::AbsoluteClock => input_timestamp < FLV_ABSOLUTE_CLOCK_THRESHOLD_MS,
                FlvReplayCutoff::Timestamp(cutoff) => input_timestamp <= cutoff,
            };
            if still_replayed {
                changed = true;
                if is_codec_sequence_header {
                    pinned_codec_header = true;
                } else {
                    continue;
                }
            } else if !matches!(replay_cutoffs[track], FlvReplayCutoff::Inactive) {
                replay_cutoffs[track] = FlvReplayCutoff::Inactive;
            }

            if pinned_codec_header || is_codec_sequence_header {
                // Codec setup stays at the current output boundary and never
                // advances either media track's input clock.
                pinned_codec_header = true;
            } else if let Some(previous) = previous_input_timestamps[track] {
                if input_timestamp <= previous {
                    let repeats_replayed_preamble = previous > FLV_ABSOLUTE_CLOCK_THRESHOLD_MS
                        && has_future_flv_media_timestamp(
                            &mut input,
                            previous_size_position + 4,
                            file_len,
                            previous.saturating_sub(10_000),
                        )?;
                    if repeats_replayed_preamble {
                        replay_cutoffs = previous_input_timestamps.map(|timestamp| {
                            timestamp
                                .map_or(FlvReplayCutoff::AbsoluteClock, FlvReplayCutoff::Timestamp)
                        });
                        changed = true;
                        continue;
                    } else {
                        timestamp_offset = i64::from(last_output_timestamp)
                            .saturating_add(1)
                            .saturating_sub(i64::from(input_timestamp));
                        previous_input_timestamps = [None, None];
                        replay_cutoffs = [FlvReplayCutoff::Inactive; 2];
                        shared_epoch_guard = true;
                        changed = true;
                    }
                }
            } else if previous_input_timestamps[track].is_none()
                && previous_input_timestamps.iter().any(Option::is_some)
                && !shared_epoch_guard
                && input_timestamp < 1_000
                && previous_input_timestamps
                    .iter()
                    .flatten()
                    .copied()
                    .max()
                    .is_some_and(|known| {
                        known > FLV_ABSOLUTE_CLOCK_THRESHOLD_MS && input_timestamp < known
                    })
            {
                // A response can introduce a previously absent track after
                // the other track has already established the source epoch.
                // If a later absolute-clock tag is present, this is only the
                // replayed preamble for the late track. Keep the established
                // epoch and discard the ordinary replay tag. A genuinely new
                // epoch has no such future high-clock tag and needs one shared
                // offset for both tracks.
                let known_clock = previous_input_timestamps.iter().flatten().copied().max();
                let replay_threshold = known_clock
                    .filter(|timestamp| *timestamp > FLV_ABSOLUTE_CLOCK_THRESHOLD_MS)
                    .map_or(FLV_ABSOLUTE_CLOCK_THRESHOLD_MS, |timestamp| {
                        timestamp.saturating_sub(10_000)
                    });
                let replayed_preamble = known_clock
                    .is_some_and(|timestamp| timestamp > FLV_ABSOLUTE_CLOCK_THRESHOLD_MS)
                    && has_future_flv_media_timestamp(
                        &mut input,
                        previous_size_position + 4,
                        file_len,
                        replay_threshold,
                    )?;
                if replayed_preamble {
                    replay_cutoffs[track] = FlvReplayCutoff::AbsoluteClock;
                    changed = true;
                    continue;
                }
                timestamp_offset = i64::from(last_output_timestamp)
                    .saturating_add(1)
                    .saturating_sub(i64::from(input_timestamp));
                previous_input_timestamps = [None, None];
                replay_cutoffs = [FlvReplayCutoff::Inactive; 2];
                shared_epoch_guard = true;
                changed = true;
            } else if previous_input_timestamps.iter().all(Option::is_none)
                && input_timestamp < 1_000
                && has_future_flv_media_timestamp(
                    &mut input,
                    previous_size_position + 4,
                    file_len,
                    FLV_ABSOLUTE_CLOCK_THRESHOLD_MS,
                )?
            {
                replay_cutoffs = [FlvReplayCutoff::AbsoluteClock; 2];
                changed = true;
                continue;
            } else if first_output_timestamp.is_none() {
                // FLV timestamps may start at the source's absolute clock
                // (several hours into uptime). Normalize that base to zero so
                // MediaSource duration and seek math remain bounded.
                timestamp_offset = -i64::from(input_timestamp);
                changed |= input_timestamp != 0;
            }
        }
        // Reconnected FLV responses commonly insert an onMetaData tag at zero
        // even when audio/video keep their absolute source clock. Do not let
        // that script tag shift every subsequent media timestamp by an entire
        // source-clock epoch.
        let output_timestamp = if pinned_codec_header
            || (!is_media_tag && input_timestamp == 0 && first_output_timestamp.is_some())
        {
            i64::from(last_output_timestamp)
        } else {
            i64::from(input_timestamp).saturating_add(timestamp_offset)
        };
        if !(0..=i64::from(u32::MAX)).contains(&output_timestamp) {
            let _ = std::fs::remove_file(&temporary);
            return Ok(None);
        }
        let output_timestamp = output_timestamp as u32;
        changed |= output_timestamp != input_timestamp;
        tag_header[4] = (output_timestamp >> 16) as u8;
        tag_header[5] = (output_timestamp >> 8) as u8;
        tag_header[6] = output_timestamp as u8;
        tag_header[7] = (output_timestamp >> 24) as u8;
        output.write_all(&tag_header)?;
        input.seek(SeekFrom::Start(data_start))?;
        let copied = std::io::copy(
            &mut std::io::Read::by_ref(&mut input).take(data_size as u64),
            &mut output,
        )?;
        if copied != data_size as u64 {
            changed = true;
            break;
        }
        let read = input.read(&mut previous_tag_size)?;
        if read != previous_tag_size.len() {
            changed = true;
            break;
        }
        output.write_all(&((data_size as u32).saturating_add(11)).to_be_bytes())?;

        if let Some(track) = media_track.filter(|_| !pinned_codec_header) {
            previous_input_timestamps[track] = Some(input_timestamp);
            if shared_epoch_guard && input_timestamp >= 1_000 {
                shared_epoch_guard = false;
            }
            first_output_timestamp.get_or_insert(output_timestamp);
            last_output_timestamp = last_output_timestamp.max(output_timestamp);
        }
    }

    let duration_ms = first_output_timestamp.map(|first| u64::from(last_output_timestamp - first));
    drop(input);
    output.flush()?;
    output.sync_data()?;
    drop(output);
    if changed {
        let mut backup_name = path.file_name().unwrap_or_default().to_os_string();
        backup_name.push(format!(".original-{}", Uuid::new_v4().simple()));
        let backup = path.with_file_name(backup_name);
        std::fs::rename(path, &backup)?;
        if let Err(error) = std::fs::rename(&temporary, path) {
            let _ = std::fs::rename(&backup, path);
            let _ = std::fs::remove_file(&temporary);
            return Err(error);
        }
        let _ = std::fs::remove_file(backup);
    } else {
        let _ = std::fs::remove_file(&temporary);
    }
    Ok(duration_ms)
}

fn direct_failure_status(state: &SessionState) -> RecordingStatus {
    if state.bytes.load(Ordering::Relaxed) == 0 {
        RecordingStatus::Failed
    } else {
        RecordingStatus::Interrupted
    }
}

fn retryable_direct_status(status: reqwest::StatusCode) -> bool {
    status == reqwest::StatusCode::FORBIDDEN
        || status == reqwest::StatusCode::NOT_FOUND
        || status == reqwest::StatusCode::REQUEST_TIMEOUT
        || status == reqwest::StatusCode::TOO_MANY_REQUESTS
        || status.is_server_error()
}

fn direct_retry_delay(errors: u32) -> Duration {
    let multiplier = 1_u64 << errors.saturating_sub(1).min(3);
    Duration::from_secs(
        DIRECT_RETRY_DELAY
            .as_secs()
            .saturating_mul(multiplier)
            .min(DIRECT_MAX_RETRY_DELAY.as_secs()),
    )
}

fn direct_source_candidates(source: &PlayUrl, site_id: Option<&str>) -> Vec<PlayUrl> {
    let mut candidates = vec![source.clone()];
    if site_id != Some("huya") {
        return candidates;
    }
    let Ok(mut alternate_url) = Url::parse(&source.url) else {
        return candidates;
    };
    let Some(host) = alternate_url.host_str() else {
        return candidates;
    };
    if host != "huya.com" && !host.ends_with(".huya.com") {
        return candidates;
    }
    let alternate_scheme = match alternate_url.scheme() {
        "http" => "https",
        "https" => "http",
        _ => return candidates,
    };
    if alternate_url.set_scheme(alternate_scheme).is_ok() {
        let mut alternate = source.clone();
        alternate.url = alternate_url.to_string();
        candidates.push(alternate);
    }
    candidates
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

fn media_file_name(protocol: PlaybackProtocol, source_url: &str, file_stem: &str) -> String {
    match protocol {
        PlaybackProtocol::Hls => format!("{file_stem}.m3u8"),
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
    let timestamp = Local
        .timestamp_millis_opt(started_at)
        .single()
        .map(|value| value.format("%Y%m%d-%H%M%S").to_string())
        .unwrap_or_else(|| started_at.to_string());
    format!("{user}_{title}_{timestamp}")
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
    /// Absolute epoch when the playlist declares DISCONTINUITY-SEQUENCE.
    /// Without that tag this stays None; the explicit marker below is the
    /// only boundary that can be carried safely across rolling windows.
    discontinuity_sequence: Option<u64>,
    discontinuity: bool,
    gap: bool,
}

#[derive(Debug, Default)]
struct ParsedPlaylist {
    media_sequence: u64,
    discontinuity_sequence: Option<u64>,
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
    playlist_file: String,
    entries: Vec<ArchiveEntry>,
    seen: HashSet<String>,
    keys: HashMap<String, String>,
    maps: HashMap<String, String>,
    target_duration: f64,
    next_segment: u64,
    last_discontinuity_sequence: Option<u64>,
    pending_discontinuity: bool,
}

#[derive(Debug, Default)]
struct TwitchHlsRefreshState {
    last_attempt: Option<Instant>,
    /// Profile zero is the normal `site/web` token; subsequent attempts walk
    /// the same fallback profiles used by the playback proxy so an ad-bound
    /// token does not get renewed forever with the same player type.
    next_profile: usize,
}

#[derive(Debug)]
enum TwitchHlsRefreshResult {
    /// A newly signed child playlist URL is ready to probe.
    Refreshed(Url),
    /// Twitch explicitly says the channel is no longer live.
    NotLive,
    /// No Twitch recovery context exists (ordinary HLS recording).
    Unavailable,
    /// The refresh request is still inside its backoff window.
    Throttled,
}

impl HlsArchive {
    fn new(bundle: PathBuf, playlist_file: String) -> Self {
        Self {
            bundle,
            playlist_file,
            entries: Vec::new(),
            seen: HashSet::new(),
            keys: HashMap::new(),
            maps: HashMap::new(),
            target_duration: 6.0,
            next_segment: 0,
            last_discontinuity_sequence: None,
            pending_discontinuity: false,
        }
    }

    /// The first playlist is a rolling live window. Recording starts at its
    /// newest segment, so older entries in that same window must be treated as
    /// consumed or the next poll would append them behind the live edge.
    fn skip_before_live_edge(&mut self, segments: &[HlsSegment]) {
        // Keep the previous source epoch as the archive cursor. If the live
        // edge follows a discontinuity (including a GAP segment), the first
        // segment we actually save must carry that boundary into the local
        // playlist even though the earlier segment is intentionally skipped.
        if let Some(previous) = segments.get(segments.len().saturating_sub(2))
            && let Some(sequence) = previous.discontinuity_sequence
        {
            self.last_discontinuity_sequence = Some(sequence);
        }
        for segment in segments.iter().take(segments.len().saturating_sub(1)) {
            self.skip_segment(segment);
        }
    }

    fn skip_segment(&mut self, segment: &HlsSegment) {
        // A boundary attached to a GAP has no bytes to archive, but it still
        // applies to the next real segment in the source timeline.
        self.pending_discontinuity |= segment.discontinuity;
        self.seen.insert(segment.identity.clone());
    }

    fn advance_discontinuity_sequence(&mut self, sequence: Option<u64>) -> bool {
        let Some(sequence) = sequence else {
            return false;
        };
        let discontinuity = self
            .last_discontinuity_sequence
            .is_some_and(|previous| previous != sequence);
        self.last_discontinuity_sequence = Some(sequence);
        discontinuity
    }

    fn take_segment_discontinuity(&mut self, segment: &HlsSegment) -> bool {
        let epoch_changed = self.advance_discontinuity_sequence(segment.discontinuity_sequence);
        std::mem::take(&mut self.pending_discontinuity) || segment.discontinuity || epoch_changed
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
            if self.seen.contains(&segment.identity) {
                continue;
            }
            if segment.gap {
                self.skip_segment(segment);
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
            let discontinuity = self.take_segment_discontinuity(segment);
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
                discontinuity,
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
            self.bundle.join(&self.playlist_file),
            self.render_manifest(end_list),
        )
        .await
    }
}

async fn refresh_twitch_hls_url(
    client: &Client,
    recovery: Option<&TwitchAdRecovery>,
    refresh_state: &mut TwitchHlsRefreshState,
) -> Result<TwitchHlsRefreshResult, String> {
    let Some(recovery) = recovery else {
        return Ok(TwitchHlsRefreshResult::Unavailable);
    };
    if refresh_state
        .last_attempt
        .is_some_and(|attempt| attempt.elapsed() < TWITCH_HLS_REFRESH_RETRY_DELAY)
    {
        return Ok(TwitchHlsRefreshResult::Throttled);
    }
    refresh_state.last_attempt = Some(Instant::now());
    let fallback_profiles = crate::sites::twitch::TWITCH_AD_FALLBACK_PROFILES;
    let profile_count = fallback_profiles.len() + 1;
    let profile_index = refresh_state.next_profile % profile_count;
    refresh_state.next_profile = (profile_index + 1) % profile_count;
    let (player_type, platform) = if profile_index == 0 {
        crate::sites::twitch::TWITCH_PRIMARY_PLAYER_TYPE
    } else {
        fallback_profiles[profile_index - 1]
    };
    let url = match crate::sites::twitch::twitch_ad_fallback_url(
        client.clone(),
        recovery,
        player_type,
        platform,
    )
    .await
    {
        Ok(url) => url,
        Err(error) if error.code == "twitch_not_live" && profile_index == 0 => {
            return Ok(TwitchHlsRefreshResult::NotLive);
        }
        Err(error) => {
            return Err(format!(
                "刷新 Twitch 录制地址失败 [{}]: {}",
                error.code, error.message
            ));
        }
    };
    Url::parse(&url)
        .map(TwitchHlsRefreshResult::Refreshed)
        .map_err(|error| format!("刷新后的 Twitch 录制地址无效: {error}"))
}

enum TwitchEndlistDecision {
    Continue,
    Complete,
    Interrupted(String),
}

/// A live Twitch child playlist should not be trusted just because one poll
/// contains `#EXT-X-ENDLIST`: an expired token and a stitched ad response can
/// briefly look like a finished VOD. Probe a freshly signed URL first and only
/// accept the terminal state when Twitch explicitly reports the channel offline.
async fn handle_twitch_endlist(
    client: &Client,
    recovery: Option<&TwitchAdRecovery>,
    refresh_state: &mut TwitchHlsRefreshState,
    archive: &mut HlsArchive,
    manifest_url: &mut Url,
    cancel: &mut watch::Receiver<bool>,
    refreshes: &mut u32,
    refresh_errors: &mut u32,
) -> TwitchEndlistDecision {
    let Some(recovery) = recovery else {
        return TwitchEndlistDecision::Complete;
    };
    match refresh_twitch_hls_url(client, Some(recovery), refresh_state).await {
        Ok(TwitchHlsRefreshResult::Refreshed(refreshed_url)) => {
            *refreshes = (*refreshes).saturating_add(1);
            *refresh_errors = 0;
            *manifest_url = refreshed_url;
            archive.pending_discontinuity = true;
            tracing::info!(
                attempt = *refreshes,
                "Twitch 清单意外包含 ENDLIST，已刷新地址确认直播状态"
            );
            TwitchEndlistDecision::Continue
        }
        Ok(TwitchHlsRefreshResult::NotLive) => TwitchEndlistDecision::Complete,
        Ok(TwitchHlsRefreshResult::Throttled) => {
            if wait_or_cancel(cancel, HLS_RETRY_DELAY).await {
                TwitchEndlistDecision::Complete
            } else {
                TwitchEndlistDecision::Continue
            }
        }
        Ok(TwitchHlsRefreshResult::Unavailable) => TwitchEndlistDecision::Complete,
        Err(error) => {
            *refresh_errors = (*refresh_errors).saturating_add(1);
            tracing::warn!(
                attempt = *refresh_errors,
                error = %error,
                "Twitch ENDLIST 状态确认失败，准备重试"
            );
            if *refresh_errors >= HLS_ERROR_LIMIT {
                TwitchEndlistDecision::Interrupted(error)
            } else if wait_or_cancel(cancel, HLS_RETRY_DELAY).await {
                TwitchEndlistDecision::Complete
            } else {
                TwitchEndlistDecision::Continue
            }
        }
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
    let twitch_recovery = source.twitch_ad_recovery.clone();
    let playlist_file = state
        .stored
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .media_file
        .clone();
    let mut archive = HlsArchive::new(state.bundle.clone(), playlist_file);
    let mut initialized = false;
    let mut errors = 0;
    let mut twitch_refresh = TwitchHlsRefreshState::default();
    let mut empty_playlists = 0_u32;
    let mut twitch_endlist_refreshes = 0_u32;
    let mut twitch_endlist_errors = 0_u32;
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
                match refresh_twitch_hls_url(&client, twitch_recovery.as_ref(), &mut twitch_refresh)
                    .await
                {
                    Ok(TwitchHlsRefreshResult::Refreshed(refreshed_url)) => {
                        manifest_url = refreshed_url;
                        archive.pending_discontinuity = true;
                        tracing::info!("Twitch 录制地址已刷新");
                        continue;
                    }
                    Ok(TwitchHlsRefreshResult::NotLive) => {
                        let _ = archive.write_manifest(true).await;
                        return TaskOutcome {
                            status: RecordingStatus::Completed,
                            error: None,
                        };
                    }
                    Ok(TwitchHlsRefreshResult::Unavailable | TwitchHlsRefreshResult::Throttled) => {
                    }
                    Err(refresh_error) => {
                        tracing::warn!(error = %refresh_error, "无法刷新 Twitch 录制地址");
                    }
                }
                tracing::warn!(attempt = errors, error = %error, "HLS 录制清单读取失败，准备重试");
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
        manifest_url = effective_url.clone();
        let twitch_ad_manifest =
            twitch_recovery.is_some() && crate::stream_proxy::is_twitch_ad_manifest(&body);
        if twitch_ad_manifest {
            match refresh_twitch_hls_url(&client, twitch_recovery.as_ref(), &mut twitch_refresh)
                .await
            {
                Ok(TwitchHlsRefreshResult::Refreshed(refreshed_url)) => {
                    manifest_url = refreshed_url;
                    archive.pending_discontinuity = true;
                    tracing::info!("Twitch 广告时段已切换到新的录制地址");
                    continue;
                }
                Ok(TwitchHlsRefreshResult::NotLive) => {
                    let _ = archive.write_manifest(true).await;
                    return TaskOutcome {
                        status: RecordingStatus::Completed,
                        error: None,
                    };
                }
                Ok(TwitchHlsRefreshResult::Unavailable | TwitchHlsRefreshResult::Throttled) => {}
                Err(refresh_error) => {
                    tracing::warn!(error = %refresh_error, "Twitch 广告时段刷新录制地址失败");
                }
            }
            // Twitch can return a 200 text response or a stitched ad playlist
            // for longer than the ordinary retry budget. This is temporary
            // platform content, not an ended live stream; keep the EVENT open
            // and resume from the next clean child playlist.
            if wait_or_cancel(&mut cancel, HLS_RETRY_DELAY).await {
                let _ = archive.write_manifest(true).await;
                return TaskOutcome {
                    status: RecordingStatus::Completed,
                    error: None,
                };
            }
            continue;
        }
        if let Some(master) = select_master_variant(&body, &effective_url) {
            manifest_url = master;
            continue;
        }
        let parsed = match parse_media_playlist_with_identity(
            &body,
            &effective_url,
            twitch_recovery.is_some(),
        ) {
            Ok(parsed) => parsed,
            Err(error) => {
                if !retryable_hls_playlist_error(&error) {
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
                errors += 1;
                if errors >= HLS_ERROR_LIMIT {
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
                match refresh_twitch_hls_url(&client, twitch_recovery.as_ref(), &mut twitch_refresh)
                    .await
                {
                    Ok(TwitchHlsRefreshResult::Refreshed(refreshed_url)) => {
                        manifest_url = refreshed_url;
                        archive.pending_discontinuity = true;
                        tracing::info!("Twitch 录制清单异常后已刷新地址");
                        continue;
                    }
                    Ok(TwitchHlsRefreshResult::NotLive) => {
                        let _ = archive.write_manifest(true).await;
                        return TaskOutcome {
                            status: RecordingStatus::Completed,
                            error: None,
                        };
                    }
                    Ok(TwitchHlsRefreshResult::Unavailable | TwitchHlsRefreshResult::Throttled) => {
                    }
                    Err(refresh_error) => {
                        tracing::warn!(error = %refresh_error, "Twitch 录制清单异常且刷新失败");
                    }
                }
                tracing::warn!(attempt = errors, error = %error, "HLS 录制清单暂时不可解析，准备重试");
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
        if parsed.segments.is_empty() {
            if !parsed.end_list {
                errors = 0;
            }
            empty_playlists = empty_playlists.saturating_add(1);
            if parsed.end_list {
                match handle_twitch_endlist(
                    &client,
                    twitch_recovery.as_ref(),
                    &mut twitch_refresh,
                    &mut archive,
                    &mut manifest_url,
                    &mut cancel,
                    &mut twitch_endlist_refreshes,
                    &mut twitch_endlist_errors,
                )
                .await
                {
                    TwitchEndlistDecision::Continue => continue,
                    TwitchEndlistDecision::Complete => {
                        let _ = archive.write_manifest(true).await;
                        return TaskOutcome {
                            status: RecordingStatus::Completed,
                            error: None,
                        };
                    }
                    TwitchEndlistDecision::Interrupted(error) => {
                        let _ = archive.write_manifest(true).await;
                        return TaskOutcome {
                            status: RecordingStatus::Interrupted,
                            error: Some(error),
                        };
                    }
                }
            }
            if twitch_recovery.is_some() && empty_playlists >= TWITCH_EMPTY_PLAYLIST_REFRESH_LIMIT {
                match refresh_twitch_hls_url(&client, twitch_recovery.as_ref(), &mut twitch_refresh)
                    .await
                {
                    Ok(TwitchHlsRefreshResult::Refreshed(refreshed_url)) => {
                        manifest_url = refreshed_url;
                        archive.pending_discontinuity = true;
                        empty_playlists = 0;
                        tracing::info!("Twitch 空清单持续出现，已刷新录制地址");
                        continue;
                    }
                    Ok(TwitchHlsRefreshResult::NotLive) => {
                        let _ = archive.write_manifest(true).await;
                        return TaskOutcome {
                            status: RecordingStatus::Completed,
                            error: None,
                        };
                    }
                    Ok(TwitchHlsRefreshResult::Unavailable | TwitchHlsRefreshResult::Throttled) => {
                    }
                    Err(refresh_error) => {
                        tracing::warn!(error = %refresh_error, "Twitch 空清单且刷新地址失败");
                    }
                }
                empty_playlists = 0;
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
        empty_playlists = 0;
        if !initialized {
            archive.skip_before_live_edge(&parsed.segments);
        }
        let candidates: Vec<HlsSegment> = if initialized {
            parsed.segments.clone()
        } else {
            parsed.segments.last().cloned().into_iter().collect()
        };
        initialized = true;
        let candidate_playlist = ParsedPlaylist {
            media_sequence: parsed.media_sequence,
            discontinuity_sequence: parsed.discontinuity_sequence,
            target_duration: parsed.target_duration,
            end_list: parsed.end_list,
            segments: candidates,
        };
        match archive
            .append_segments(&client, &candidate_playlist, &source.headers, &state)
            .await
        {
            Ok(appended) => {
                if appended > 0 {
                    errors = 0;
                    if !parsed.end_list {
                        // A refreshed URL is only considered healthy after a
                        // complete new segment has been archived.
                        twitch_refresh.last_attempt = None;
                        twitch_refresh.next_profile = 0;
                        twitch_endlist_refreshes = 0;
                        twitch_endlist_errors = 0;
                    }
                }
            }
            Err(error) => {
                errors += 1;
                if errors >= HLS_ERROR_LIMIT {
                    let _ = archive.write_manifest(true).await;
                    return TaskOutcome {
                        status: RecordingStatus::Interrupted,
                        error: Some(error),
                    };
                }
                match refresh_twitch_hls_url(&client, twitch_recovery.as_ref(), &mut twitch_refresh)
                    .await
                {
                    Ok(TwitchHlsRefreshResult::Refreshed(refreshed_url)) => {
                        manifest_url = refreshed_url;
                        archive.pending_discontinuity = true;
                        // Keep the retry budget until a refreshed playlist
                        // actually contributes a complete segment.
                        tracing::info!("Twitch 分片读取失败后已刷新录制地址");
                        continue;
                    }
                    Ok(TwitchHlsRefreshResult::NotLive) => {
                        let _ = archive.write_manifest(true).await;
                        return TaskOutcome {
                            status: RecordingStatus::Completed,
                            error: None,
                        };
                    }
                    Ok(TwitchHlsRefreshResult::Unavailable | TwitchHlsRefreshResult::Throttled) => {
                    }
                    Err(refresh_error) => {
                        tracing::warn!(error = %refresh_error, "Twitch 分片读取失败且刷新地址失败");
                    }
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
        }
        if parsed.end_list {
            match handle_twitch_endlist(
                &client,
                twitch_recovery.as_ref(),
                &mut twitch_refresh,
                &mut archive,
                &mut manifest_url,
                &mut cancel,
                &mut twitch_endlist_refreshes,
                &mut twitch_endlist_errors,
            )
            .await
            {
                TwitchEndlistDecision::Continue => continue,
                TwitchEndlistDecision::Complete => {
                    let _ = archive.write_manifest(true).await;
                    return TaskOutcome {
                        status: RecordingStatus::Completed,
                        error: None,
                    };
                }
                TwitchEndlistDecision::Interrupted(error) => {
                    let _ = archive.write_manifest(true).await;
                    return TaskOutcome {
                        status: RecordingStatus::Interrupted,
                        error: Some(error),
                    };
                }
            }
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

fn retryable_hls_playlist_error(error: &str) -> bool {
    // A CDN or ad server can briefly answer a child-playlist request with
    // plain text or HTML. Structural errors inside an actual manifest (for
    // example unsupported encryption or an invalid BYTERANGE) are permanent
    // for that source and should still fail immediately.
    error == "HLS 清单缺少 #EXTM3U 头"
}

#[cfg(test)]
fn parse_media_playlist(body: &str, base: &Url) -> Result<ParsedPlaylist, String> {
    parse_media_playlist_with_identity(body, base, false)
}

fn parse_media_playlist_with_identity(
    body: &str,
    base: &Url,
    stable_sequence_identity: bool,
) -> Result<ParsedPlaylist, String> {
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
    let mut next_program_date_time: Option<String> = None;
    let mut discontinuity_sequence: Option<u64> = None;
    let mut next_discontinuity = false;
    let mut gap = false;
    let mut sequence = 0_u64;
    let mut media_sequence_declared = false;
    let mut previous_segment_range: Option<(String, u64)> = None;
    let mut previous_map_range: Option<(String, u64)> = None;
    for line in body.lines().map(str::trim) {
        if line.is_empty() {
            continue;
        }
        if let Some(value) = line.strip_prefix("#EXT-X-MEDIA-SEQUENCE:") {
            playlist.media_sequence = value.parse().unwrap_or(0);
            sequence = playlist.media_sequence;
            media_sequence_declared = true;
            continue;
        }
        if let Some(value) = line.strip_prefix("#EXT-X-TARGETDURATION:") {
            playlist.target_duration = value.parse().unwrap_or(0.0);
            continue;
        }
        if let Some(value) = line.strip_prefix("#EXT-X-DISCONTINUITY-SEQUENCE:") {
            let sequence = value.parse().unwrap_or(0);
            playlist.discontinuity_sequence = Some(sequence);
            discontinuity_sequence = Some(sequence);
            continue;
        }
        if line == "#EXT-X-ENDLIST" {
            playlist.end_list = true;
            continue;
        }
        if line == "#EXT-X-DISCONTINUITY" {
            next_discontinuity = true;
            if let Some(sequence) = discontinuity_sequence.as_mut() {
                *sequence = sequence.saturating_add(1);
            }
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
        if let Some(value) = line.strip_prefix("#EXT-X-PROGRAM-DATE-TIME:") {
            next_program_date_time = Some(value.trim().to_string());
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
        let identity = if stable_sequence_identity && media_sequence_declared {
            // Signed Twitch URLs change when their short-lived playback token
            // is renewed. RFC media and absolute discontinuity sequence
            // numbers remain stable even if PROGRAM-DATE-TIME is sparse or
            // changes textual precision between overlapping windows.
            format!(
                "sequence|{}|{}|{}",
                discontinuity_sequence
                    .map_or_else(|| "relative".to_string(), |sequence| sequence.to_string()),
                sequence,
                range.as_deref().unwrap_or("")
            )
        } else if stable_sequence_identity
            && let Some(program_date_time) = next_program_date_time.as_deref()
        {
            // A nonstandard Twitch playlist without MEDIA-SEQUENCE can still
            // use its wall-clock timestamp as a stable fallback identity.
            format!(
                "program-date-time|{}|{}|{}",
                discontinuity_sequence
                    .map_or_else(|| "relative".to_string(), |sequence| sequence.to_string()),
                program_date_time,
                range.as_deref().unwrap_or("")
            )
        } else {
            format!("{}|{}|{}", sequence, uri, range.as_deref().unwrap_or(""))
        };
        next_program_date_time = None;
        playlist.segments.push(HlsSegment {
            uri,
            sequence,
            duration: next_duration.unwrap_or(0.0),
            identity,
            key: current_key.clone(),
            map: current_map.clone(),
            range,
            discontinuity_sequence,
            discontinuity: next_discontinuity,
            gap,
        });
        sequence = sequence.saturating_add(1);
        next_duration = None;
        next_discontinuity = false;
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
                return local_playback_url(&server.base_url, &server.token, id, media_file);
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
    segments.clear().push(token).push(id);
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
    let Some(id) = components.next() else {
        write_simple_response(socket, 404, "Not Found", "").await?;
        return Ok(());
    };
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
        SessionState, StoredDanmakuBatch, StoredRecording, attribute_value,
        decode_playback_relative_path, direct_source_candidates,
        flv_payload_is_codec_sequence_header, hls_media_sequence_iv, http_byte_range_bounds,
        local_playback_url, media_file_name, normalize_flv_timestamps, parse_media_playlist,
        parse_media_playlist_with_identity, parse_range, recording_file_stem,
        retryable_hls_playlist_error, run_direct_recording, run_hls_recording, safe_relative_path,
        select_master_variant, write_metadata,
    };
    use crate::models::live::{DanmakuEvent, DanmakuKind, PlaybackProtocol};
    use reqwest::Url;
    use std::collections::HashSet;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::sync::watch;
    use uuid::Uuid;

    #[test]
    fn parses_hls_attributes_with_quoted_commas() {
        assert_eq!(
            attribute_value("METHOD=AES-128,URI=\"keys/a,b\",IV=0x01", "URI").as_deref(),
            Some("keys/a,b")
        );
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
                PlaybackProtocol::Hls,
                "https://example.test/live.m3u8",
                &stem
            ),
            format!("{stem}.m3u8")
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
    fn keeps_hls_identity_stable_when_twitch_renews_signed_urls() {
        let first_base = Url::parse("https://video-a.example.test/token-one/index.m3u8").unwrap();
        let second_base = Url::parse("https://video-b.example.test/token-two/index.m3u8").unwrap();
        let first = parse_media_playlist_with_identity(
            "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:12\n#EXTINF:2,live\nfirst.m4s\n",
            &first_base,
            true,
        )
        .unwrap();
        let renewed = parse_media_playlist_with_identity(
            "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:12\n#EXTINF:2,live\nrenewed.m4s\n",
            &second_base,
            true,
        )
        .unwrap();
        let restarted = parse_media_playlist_with_identity(
            "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:2,live\nrestart.m4s\n",
            &second_base,
            true,
        )
        .unwrap();

        assert_eq!(first.segments[0].identity, renewed.segments[0].identity);
        assert_ne!(first.segments[0].identity, restarted.segments[0].identity);
    }

    #[test]
    fn includes_the_discontinuity_epoch_in_program_date_time_identity() {
        let base = Url::parse("https://example.test/live/index.m3u8").unwrap();
        let first = parse_media_playlist_with_identity(
            "#EXTM3U\n#EXT-X-DISCONTINUITY-SEQUENCE:2\n#EXT-X-PROGRAM-DATE-TIME:2026-08-17T00:00:00Z\n#EXTINF:2,live\nfirst.m4s\n",
            &base,
            true,
        )
        .unwrap();
        let next_epoch = parse_media_playlist_with_identity(
            "#EXTM3U\n#EXT-X-DISCONTINUITY-SEQUENCE:3\n#EXT-X-PROGRAM-DATE-TIME:2026-08-17T00:00:00Z\n#EXTINF:2,live\nnext.m4s\n",
            &base,
            true,
        )
        .unwrap();

        assert_ne!(first.segments[0].identity, next_epoch.segments[0].identity);
    }

    #[test]
    fn tracks_hls_discontinuity_epoch_across_gaps_and_rolling_windows() {
        let base = Url::parse("https://example.test/live/index.m3u8").unwrap();
        let playlist = parse_media_playlist(
            "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:100\n#EXT-X-DISCONTINUITY-SEQUENCE:7\n#EXTINF:2,live\nfirst.ts\n#EXT-X-DISCONTINUITY\n#EXTINF:2,ad\n#EXT-X-GAP\ngap.ts\n#EXTINF:2,live\nsecond.ts\n",
            &base,
        )
        .unwrap();
        let rolled = parse_media_playlist(
            "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:103\n#EXT-X-DISCONTINUITY-SEQUENCE:8\n#EXTINF:2,live\nthird.ts\n",
            &base,
        )
        .unwrap();

        assert_eq!(playlist.discontinuity_sequence, Some(7));
        assert_eq!(
            playlist
                .segments
                .iter()
                .map(|segment| segment.discontinuity_sequence)
                .collect::<Vec<_>>(),
            [Some(7), Some(8), Some(8)]
        );
        assert!(playlist.segments[1].gap);
        assert_eq!(rolled.segments[0].discontinuity_sequence, Some(8));
    }

    #[test]
    fn archive_marks_the_first_saved_segment_after_a_skipped_hls_epoch() {
        let mut archive = HlsArchive::new(PathBuf::new(), "index.m3u8".into());

        assert!(!archive.advance_discontinuity_sequence(Some(7)));
        // A GAP segment in epoch 8 is not written and therefore must not move
        // the archive cursor. The next real segment crosses the boundary.
        assert!(archive.advance_discontinuity_sequence(Some(8)));
        assert!(!archive.advance_discontinuity_sequence(Some(8)));
    }

    #[test]
    fn marks_the_initial_hls_window_before_the_live_edge_as_consumed() {
        let base = Url::parse("https://example.test/live/index.m3u8").unwrap();
        let playlist = parse_media_playlist(
            "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:10\n#EXTINF:2,\nold-a.ts\n#EXTINF:2,\nold-b.ts\n#EXTINF:2,\nedge.ts\n",
            &base,
        )
        .unwrap();
        let mut archive = HlsArchive::new(PathBuf::new(), "index.m3u8".into());

        archive.skip_before_live_edge(&playlist.segments);

        assert!(archive.seen.contains(&playlist.segments[0].identity));
        assert!(archive.seen.contains(&playlist.segments[1].identity));
        assert!(!archive.seen.contains(&playlist.segments[2].identity));
    }

    #[test]
    fn carries_an_initial_discontinuity_to_the_first_saved_live_edge() {
        let base = Url::parse("https://example.test/live/index.m3u8").unwrap();
        let playlist = parse_media_playlist(
            "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:10\n#EXT-X-DISCONTINUITY-SEQUENCE:4\n#EXTINF:2,old\nold.ts\n#EXT-X-DISCONTINUITY\n#EXTINF:2,edge\nedge.ts\n",
            &base,
        )
        .unwrap();
        let mut archive = HlsArchive::new(PathBuf::new(), "index.m3u8".into());

        archive.skip_before_live_edge(&playlist.segments);

        assert_eq!(archive.last_discontinuity_sequence, Some(4));
        assert!(archive.advance_discontinuity_sequence(Some(5)));
    }

    #[test]
    fn does_not_compare_relative_discontinuity_counts_across_windows() {
        let base = Url::parse("https://example.test/live/index.m3u8").unwrap();
        let first = parse_media_playlist(
            "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:10\n#EXTINF:2,old\nold.ts\n#EXT-X-DISCONTINUITY\n#EXTINF:2,edge\nedge.ts\n",
            &base,
        )
        .unwrap();
        let next = parse_media_playlist(
            "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:11\n#EXTINF:2,new\nnew.ts\n",
            &base,
        )
        .unwrap();
        let mut archive = HlsArchive::new(PathBuf::new(), "index.m3u8".into());

        archive.skip_before_live_edge(&first.segments);

        assert!(first.segments[1].discontinuity);
        assert!(!archive.advance_discontinuity_sequence(next.segments[0].discontinuity_sequence));
    }

    #[test]
    fn carries_an_explicit_gap_boundary_without_an_absolute_sequence() {
        let base = Url::parse("https://example.test/live/index.m3u8").unwrap();
        let playlist = parse_media_playlist(
            "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:10\n#EXT-X-DISCONTINUITY\n#EXTINF:2,gap\n#EXT-X-GAP\ngap.ts\n#EXTINF:2,live\nlive.ts\n",
            &base,
        )
        .unwrap();
        let mut archive = HlsArchive::new(PathBuf::new(), "index.m3u8".into());

        archive.skip_before_live_edge(&playlist.segments);

        assert!(playlist.segments[0].gap);
        assert!(!playlist.segments[1].discontinuity);
        assert!(archive.take_segment_discontinuity(&playlist.segments[1]));
        assert!(!archive.pending_discontinuity);
    }

    #[tokio::test]
    async fn hls_recording_recovers_after_a_temporary_non_manifest_response() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let playlist_requests = Arc::new(AtomicUsize::new(0));
        let requested_paths = Arc::new(Mutex::new(Vec::<String>::new()));
        let server_playlist_requests = playlist_requests.clone();
        let server_requested_paths = requested_paths.clone();
        let server = tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = [0_u8; 4096];
                let length = socket.read(&mut request).await.unwrap();
                let request = String::from_utf8_lossy(&request[..length]);
                let path = request
                    .lines()
                    .next()
                    .and_then(|line| line.split_whitespace().nth(1))
                    .unwrap_or("/")
                    .to_string();
                server_requested_paths.lock().unwrap().push(path.clone());
                let (content_type, body): (&str, Vec<u8>) = match path.as_str() {
                    "/live.m3u8" => {
                        let attempt = server_playlist_requests.fetch_add(1, Ordering::Relaxed);
                        let text = match attempt {
                            0 => {
                                "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:10\n#EXT-X-TARGETDURATION:1\n#EXTINF:2,\nold.ts\n#EXTINF:2,\nedge.ts\n"
                            }
                            1 => "Commercial break in progress. Please wait.",
                            _ => {
                                "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:11\n#EXT-X-TARGETDURATION:1\n#EXTINF:2,\nedge.ts\n#EXTINF:2,\nnew.ts\n"
                            }
                        };
                        ("application/vnd.apple.mpegurl", text.as_bytes().to_vec())
                    }
                    "/old.ts" => ("video/mp2t", b"\x47old".to_vec()),
                    "/edge.ts" => ("video/mp2t", b"\x47edge".to_vec()),
                    "/new.ts" => ("video/mp2t", b"\x47new".to_vec()),
                    _ => ("text/plain", b"missing".to_vec()),
                };
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                socket.write_all(response.as_bytes()).await.unwrap();
                socket.write_all(&body).await.unwrap();
            }
        });

        let root = std::env::temp_dir().join(format!("rlive-hls-retry-{}", Uuid::new_v4()));
        let bundle = root.join(Uuid::new_v4().to_string());
        std::fs::create_dir_all(bundle.join("segments")).unwrap();
        for directory in ["keys", "maps"] {
            std::fs::create_dir_all(bundle.join(directory)).unwrap();
        }
        let stored = completed_recording(
            bundle.file_name().unwrap().to_string_lossy().into_owned(),
            "hls-retry",
        );
        let state = Arc::new(SessionState {
            root: root.clone(),
            bundle: bundle.clone(),
            stored: Mutex::new(StoredRecording {
                protocol: PlaybackProtocol::Hls,
                status: RecordingStatus::Recording,
                media_file: "index.m3u8".into(),
                ..stored
            }),
            bytes: AtomicU64::new(0),
            duration_ms: AtomicU64::new(0),
            danmaku_count: AtomicU64::new(0),
            danmaku_writer: Mutex::new(None),
            danmaku_closed: AtomicBool::new(false),
            finished: AtomicBool::new(false),
        });
        let source = crate::models::live::PlayUrl::inferred(
            "test:hls",
            "测试 HLS",
            0,
            format!("http://{address}/live.m3u8"),
            Default::default(),
        );
        let client = crate::http_client::client_for_proxy(None).unwrap();
        let (cancel_tx, cancel_rx) = watch::channel(false);
        let task_state = state.clone();
        let task =
            tokio::spawn(
                async move { run_hls_recording(client, source, task_state, cancel_rx).await },
            );

        tokio::time::timeout(std::time::Duration::from_secs(15), async {
            while state.duration_ms.load(Ordering::Relaxed) < 4_000 {
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        cancel_tx.send(true).unwrap();
        let outcome = task.await.unwrap();
        server.abort();
        let _ = server.await;

        assert_eq!(outcome.status, RecordingStatus::Completed);
        assert_eq!(outcome.error, None);
        let manifest = std::fs::read_to_string(bundle.join("index.m3u8")).unwrap();
        assert_eq!(manifest.matches("#EXTINF:").count(), 2);
        assert_eq!(
            std::fs::read(bundle.join("segments/00000000.ts")).unwrap(),
            b"\x47edge"
        );
        assert_eq!(
            std::fs::read(bundle.join("segments/00000001.ts")).unwrap(),
            b"\x47new"
        );
        assert!(
            !requested_paths
                .lock()
                .unwrap()
                .iter()
                .any(|path| path == "/old.ts")
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_a_non_hls_response_before_polling_it_forever() {
        let base = Url::parse("https://example.test/live/index.m3u8").unwrap();
        let error = parse_media_playlist("<html>sign in</html>", &base).unwrap_err();

        assert!(error.contains("#EXTM3U"));
        assert!(retryable_hls_playlist_error(&error));
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
    fn keeps_twitch_identity_stable_when_program_date_time_is_sparse() {
        let base = Url::parse("https://example.test/live/index.m3u8").unwrap();
        let with_timestamp = parse_media_playlist_with_identity(
            "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:12\n#EXT-X-PROGRAM-DATE-TIME:2026-08-17T00:00:00.000Z\n#EXTINF:2,live\nfirst.m4s\n",
            &base,
            true,
        )
        .unwrap();
        let without_timestamp = parse_media_playlist_with_identity(
            "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:12\n#EXTINF:2,live\nrenewed.m4s\n",
            &base,
            true,
        )
        .unwrap();

        assert_eq!(
            with_timestamp.segments[0].identity,
            without_timestamp.segments[0].identity
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
        assert!(!retryable_hls_playlist_error(&error));
    }

    #[test]
    fn renders_hls_manifest_with_key_map_and_endlist_in_order() {
        let mut archive = HlsArchive::new(PathBuf::new(), "index.m3u8".into());
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

    #[test]
    fn local_playback_urls_round_trip_unicode_and_spaces() {
        let file = "斗鱼主播_标题 测试_20260816-120000.flv";
        let url = local_playback_url("http://127.0.0.1:1234", "token", "id", file).unwrap();

        assert!(url.contains("%E6%96%97%E9%B1%BC%E4%B8%BB%E6%92%AD"));
        assert!(url.contains("%20"));
        let encoded = Url::parse(&url)
            .unwrap()
            .path_segments()
            .unwrap()
            .last()
            .unwrap()
            .to_string();
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

    #[test]
    fn rebases_flv_timestamps_after_a_stream_reconnect() {
        fn append_tag(file: &mut Vec<u8>, timestamp: u32) {
            file.push(9);
            file.extend_from_slice(&[0, 0, 1]);
            file.push((timestamp >> 16) as u8);
            file.push((timestamp >> 8) as u8);
            file.push(timestamp as u8);
            file.push((timestamp >> 24) as u8);
            file.extend_from_slice(&[0, 0, 0]);
            file.push(0);
            file.extend_from_slice(&[0, 0, 0, 12]);
        }

        fn timestamp_at(file: &[u8], offset: usize) -> u32 {
            (u32::from(file[offset + 4]) << 16)
                | (u32::from(file[offset + 5]) << 8)
                | u32::from(file[offset + 6])
                | (u32::from(file[offset + 7]) << 24)
        }

        let path = std::env::temp_dir().join(format!(
            "rlive-flv-normalize-{}.flv",
            Uuid::new_v4().simple()
        ));
        let mut file = b"FLV\x01\x05\x00\x00\x00\x09\x00\x00\x00\x00".to_vec();
        append_tag(&mut file, 0);
        append_tag(&mut file, 1000);
        append_tag(&mut file, 0);
        append_tag(&mut file, 1000);
        std::fs::write(&path, file).unwrap();

        assert_eq!(normalize_flv_timestamps(&path).unwrap(), Some(2001));
        let normalized = std::fs::read(&path).unwrap();
        assert_eq!(timestamp_at(&normalized, 13), 0);
        assert_eq!(timestamp_at(&normalized, 29), 1000);
        assert_eq!(timestamp_at(&normalized, 45), 1001);
        assert_eq!(timestamp_at(&normalized, 61), 2001);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn drops_a_partial_tag_before_a_reconnect_tag() {
        fn append_tag(file: &mut Vec<u8>, timestamp: u32, payload: &[u8]) {
            file.push(9);
            file.extend_from_slice(&[
                0,
                0,
                payload.len() as u8,
                (timestamp >> 16) as u8,
                (timestamp >> 8) as u8,
                timestamp as u8,
                (timestamp >> 24) as u8,
                0,
                0,
                0,
            ]);
            file.extend_from_slice(payload);
            file.extend_from_slice(&((payload.len() + 11) as u32).to_be_bytes());
        }

        let path =
            std::env::temp_dir().join(format!("rlive-flv-resync-{}.flv", Uuid::new_v4().simple()));
        let mut file = b"FLV\x01\x05\x00\x00\x00\x09\x00\x00\x00\x00".to_vec();
        append_tag(&mut file, 0, b"first");
        // The reconnect cuts this tag after three payload bytes. The next
        // response starts with a complete tag at a new timestamp.
        file.extend_from_slice(&[9, 0, 0, 10, 0, 0, 1, 0, 0, 0, 0]);
        file.extend_from_slice(b"bad");
        append_tag(&mut file, 1000, b"second");
        std::fs::write(&path, file).unwrap();

        assert_eq!(normalize_flv_timestamps(&path).unwrap(), Some(1000));
        let normalized = std::fs::read(&path).unwrap();
        assert_eq!(normalized.len(), 13 + (11 + 5 + 4) + (11 + 6 + 4));
        assert_eq!(normalized[13], 9);
        assert_eq!(normalized[33], 9);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn normalizes_absolute_flv_clock_after_replayed_preamble() {
        fn append_tag(file: &mut Vec<u8>, tag_type: u8, timestamp: u32, payload: &[u8]) {
            file.extend_from_slice(&[
                tag_type,
                0,
                (payload.len() >> 8) as u8,
                payload.len() as u8,
                (timestamp >> 16) as u8,
                (timestamp >> 8) as u8,
                timestamp as u8,
                (timestamp >> 24) as u8,
                0,
                0,
                0,
            ]);
            file.extend_from_slice(payload);
            file.extend_from_slice(&((payload.len() + 11) as u32).to_be_bytes());
        }

        let path =
            std::env::temp_dir().join(format!("rlive-flv-clock-{}.flv", Uuid::new_v4().simple()));
        let mut file = b"FLV\x01\x05\x00\x00\x00\x09\x00\x00\x00\x00".to_vec();
        append_tag(&mut file, 9, 12, &[0x17, 0]);
        append_tag(&mut file, 8, 6_559, &[0xaf, 0]);
        append_tag(&mut file, 9, 2_000_000, &[0x17, 1]);
        append_tag(&mut file, 8, 2_001_000, &[0xaf, 1]);
        std::fs::write(&path, file).unwrap();

        assert_eq!(normalize_flv_timestamps(&path).unwrap(), Some(1000));
        let normalized = std::fs::read(&path).unwrap();
        assert_eq!(normalized.len(), 13 + (11 + 2 + 4) * 4);
        for offset in [13, 30, 47] {
            assert_eq!(
                (u32::from(normalized[offset + 4]) << 16)
                    | (u32::from(normalized[offset + 5]) << 8)
                    | u32::from(normalized[offset + 6])
                    | (u32::from(normalized[offset + 7]) << 24),
                0
            );
        }
        assert_eq!(
            (u32::from(normalized[68]) << 16)
                | (u32::from(normalized[69]) << 8)
                | u32::from(normalized[70])
                | (u32::from(normalized[71]) << 24),
            1000
        );
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn drops_replayed_douyu_media_until_each_track_passes_its_old_clock() {
        fn append_tag(file: &mut Vec<u8>, tag_type: u8, timestamp: u32, payload: &[u8]) {
            file.extend_from_slice(&[
                tag_type,
                (payload.len() >> 16) as u8,
                (payload.len() >> 8) as u8,
                payload.len() as u8,
                (timestamp >> 16) as u8,
                (timestamp >> 8) as u8,
                timestamp as u8,
                (timestamp >> 24) as u8,
                0,
                0,
                0,
            ]);
            file.extend_from_slice(payload);
            file.extend_from_slice(&((payload.len() + 11) as u32).to_be_bytes());
        }

        fn tags(file: &[u8]) -> Vec<(u8, u32, Vec<u8>)> {
            let mut result = Vec::new();
            let mut offset = 13;
            while offset + 15 <= file.len() {
                let data_size = (usize::from(file[offset + 1]) << 16)
                    | (usize::from(file[offset + 2]) << 8)
                    | usize::from(file[offset + 3]);
                let timestamp = (u32::from(file[offset + 4]) << 16)
                    | (u32::from(file[offset + 5]) << 8)
                    | u32::from(file[offset + 6])
                    | (u32::from(file[offset + 7]) << 24);
                result.push((
                    file[offset] & 0x1f,
                    timestamp,
                    file[offset + 11..offset + 11 + data_size].to_vec(),
                ));
                offset += 11 + data_size + 4;
            }
            result
        }

        let path = std::env::temp_dir().join(format!(
            "rlive-flv-douyu-overlap-{}.flv",
            Uuid::new_v4().simple()
        ));
        let mut file = b"FLV\x01\x05\x00\x00\x00\x09\x00\x00\x00\x00".to_vec();
        append_tag(&mut file, 8, 33, &[0xaf, 0, 0xa0]);
        append_tag(&mut file, 9, 8_370, &[0x17, 0, 0, 0, 0, 0xa1]);
        append_tag(&mut file, 9, 2_000_000, &[0x17, 1, 0, 0, 0, 0x10]);
        append_tag(&mut file, 8, 2_000_020, &[0xaf, 1, 0x11]);
        append_tag(&mut file, 8, 2_004_980, &[0xaf, 1, 0x12]);
        append_tag(&mut file, 9, 2_005_000, &[0x27, 1, 0, 0, 0, 0x13]);

        append_tag(&mut file, 8, 33, &[0xaf, 0, 0xb0]);
        append_tag(&mut file, 9, 8_370, &[0x17, 0, 0, 0, 0, 0xb1]);
        // The reconnect starts only 200ms behind the previous edge. This is
        // below the old 500ms tolerance and must still be treated as replay.
        append_tag(&mut file, 9, 2_004_800, &[0x17, 1, 0, 0, 0, 0x20]);
        append_tag(&mut file, 8, 2_004_820, &[0xaf, 1, 0x21]);
        append_tag(&mut file, 8, 2_004_960, &[0xaf, 1, 0x22]);
        append_tag(&mut file, 9, 2_004_980, &[0x27, 1, 0, 0, 0, 0x23]);
        append_tag(&mut file, 8, 2_005_000, &[0xaf, 1, 0x30]);
        append_tag(&mut file, 9, 2_005_020, &[0x27, 1, 0, 0, 0, 0x31]);
        std::fs::write(&path, file).unwrap();

        assert_eq!(normalize_flv_timestamps(&path).unwrap(), Some(5_020));
        let normalized = std::fs::read(&path).unwrap();
        let tags = tags(&normalized);
        let sequence_timestamps = tags
            .iter()
            .filter(|(tag_type, _, payload)| {
                flv_payload_is_codec_sequence_header(*tag_type, payload)
            })
            .map(|(_, timestamp, _)| *timestamp)
            .collect::<Vec<_>>();
        assert_eq!(sequence_timestamps, [0, 0, 5_000, 5_000]);

        let audio_timestamps = tags
            .iter()
            .filter(|(tag_type, _, payload)| {
                *tag_type == 8 && !flv_payload_is_codec_sequence_header(*tag_type, payload)
            })
            .map(|(_, timestamp, _)| *timestamp)
            .collect::<Vec<_>>();
        let video_timestamps = tags
            .iter()
            .filter(|(tag_type, _, payload)| {
                *tag_type == 9 && !flv_payload_is_codec_sequence_header(*tag_type, payload)
            })
            .map(|(_, timestamp, _)| *timestamp)
            .collect::<Vec<_>>();
        assert_eq!(audio_timestamps, [20, 4_980, 5_000]);
        assert_eq!(video_timestamps, [0, 5_000, 5_020]);
        assert!(audio_timestamps.windows(2).all(|pair| pair[0] < pair[1]));
        assert!(video_timestamps.windows(2).all(|pair| pair[0] < pair[1]));
        assert!(
            tags.iter()
                .all(|(_, _, payload)| !matches!(payload.last(), Some(0x20 | 0x21 | 0x22 | 0x23)))
        );
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn starts_one_shared_epoch_when_both_tracks_restart_from_zero() {
        fn append_tag(file: &mut Vec<u8>, tag_type: u8, timestamp: u32, payload: &[u8]) {
            file.extend_from_slice(&[
                tag_type,
                (payload.len() >> 16) as u8,
                (payload.len() >> 8) as u8,
                payload.len() as u8,
                (timestamp >> 16) as u8,
                (timestamp >> 8) as u8,
                timestamp as u8,
                (timestamp >> 24) as u8,
                0,
                0,
                0,
            ]);
            file.extend_from_slice(payload);
            file.extend_from_slice(&((payload.len() + 11) as u32).to_be_bytes());
        }

        fn media_timestamps(file: &[u8], wanted_type: u8) -> Vec<u32> {
            let mut result = Vec::new();
            let mut offset = 13;
            while offset + 15 <= file.len() {
                let tag_type = file[offset] & 0x1f;
                let data_size = (usize::from(file[offset + 1]) << 16)
                    | (usize::from(file[offset + 2]) << 8)
                    | usize::from(file[offset + 3]);
                let payload = &file[offset + 11..offset + 11 + data_size];
                if tag_type == wanted_type
                    && !flv_payload_is_codec_sequence_header(tag_type, payload)
                {
                    result.push(
                        (u32::from(file[offset + 4]) << 16)
                            | (u32::from(file[offset + 5]) << 8)
                            | u32::from(file[offset + 6])
                            | (u32::from(file[offset + 7]) << 24),
                    );
                }
                offset += 11 + data_size + 4;
            }
            result
        }

        let path = std::env::temp_dir().join(format!(
            "rlive-flv-shared-reset-{}.flv",
            Uuid::new_v4().simple()
        ));
        let mut file = b"FLV\x01\x05\x00\x00\x00\x09\x00\x00\x00\x00".to_vec();
        append_tag(&mut file, 8, 33, &[0xaf, 0]);
        append_tag(&mut file, 9, 8_370, &[0x17, 0]);
        append_tag(&mut file, 9, 2_000_000, &[0x17, 1]);
        append_tag(&mut file, 8, 2_000_018, &[0xaf, 1]);
        append_tag(&mut file, 9, 2_001_000, &[0x27, 1]);
        append_tag(&mut file, 8, 2_001_018, &[0xaf, 1]);

        append_tag(&mut file, 18, 0, &[0]);
        append_tag(&mut file, 8, 33, &[0xaf, 0]);
        append_tag(&mut file, 9, 8_370, &[0x17, 0]);
        append_tag(&mut file, 9, 0, &[0x17, 1]);
        append_tag(&mut file, 8, 18, &[0xaf, 1]);
        append_tag(&mut file, 9, 1_000, &[0x27, 1]);
        append_tag(&mut file, 8, 1_018, &[0xaf, 1]);
        std::fs::write(&path, file).unwrap();

        assert_eq!(normalize_flv_timestamps(&path).unwrap(), Some(2_037));
        let normalized = std::fs::read(&path).unwrap();
        assert_eq!(media_timestamps(&normalized, 9), [0, 1_000, 1_019, 2_019]);
        assert_eq!(media_timestamps(&normalized, 8), [18, 1_018, 1_037, 2_037]);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn keeps_normal_late_track_start_in_the_same_epoch() {
        fn append_tag(file: &mut Vec<u8>, tag_type: u8, timestamp: u32, payload: &[u8]) {
            file.extend_from_slice(&[
                tag_type,
                0,
                0,
                payload.len() as u8,
                (timestamp >> 16) as u8,
                (timestamp >> 8) as u8,
                timestamp as u8,
                (timestamp >> 24) as u8,
                0,
                0,
                0,
            ]);
            file.extend_from_slice(payload);
            file.extend_from_slice(&((payload.len() + 11) as u32).to_be_bytes());
        }

        fn timestamps(file: &[u8]) -> Vec<(u8, u32)> {
            let mut result = Vec::new();
            let mut offset = 13;
            while offset + 15 <= file.len() {
                let data_size = (usize::from(file[offset + 1]) << 16)
                    | (usize::from(file[offset + 2]) << 8)
                    | usize::from(file[offset + 3]);
                result.push((
                    file[offset] & 0x1f,
                    (u32::from(file[offset + 4]) << 16)
                        | (u32::from(file[offset + 5]) << 8)
                        | u32::from(file[offset + 6])
                        | (u32::from(file[offset + 7]) << 24),
                ));
                offset += 11 + data_size + 4;
            }
            result
        }

        let path = std::env::temp_dir().join(format!(
            "rlive-flv-normal-start-{}.flv",
            Uuid::new_v4().simple()
        ));
        let mut file = b"FLV\x01\x05\x00\x00\x00\x09\x00\x00\x00\x00".to_vec();
        append_tag(&mut file, 8, 0, &[0xaf, 1]);
        append_tag(&mut file, 9, 33, &[0x27, 1]);
        append_tag(&mut file, 8, 23, &[0xaf, 1]);
        append_tag(&mut file, 9, 50, &[0x27, 1]);
        std::fs::write(&path, file).unwrap();

        assert_eq!(normalize_flv_timestamps(&path).unwrap(), Some(50));
        let normalized = std::fs::read(&path).unwrap();
        assert_eq!(timestamps(&normalized), [(8, 0), (9, 33), (8, 23), (9, 50)]);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn aligns_a_late_track_before_the_other_track_restarts() {
        fn append_tag(file: &mut Vec<u8>, tag_type: u8, timestamp: u32, payload: &[u8]) {
            file.extend_from_slice(&[
                tag_type,
                (payload.len() >> 16) as u8,
                (payload.len() >> 8) as u8,
                payload.len() as u8,
                (timestamp >> 16) as u8,
                (timestamp >> 8) as u8,
                timestamp as u8,
                (timestamp >> 24) as u8,
                0,
                0,
                0,
            ]);
            file.extend_from_slice(payload);
            file.extend_from_slice(&((payload.len() + 11) as u32).to_be_bytes());
        }

        fn media_timestamps(file: &[u8], wanted_type: u8) -> Vec<u32> {
            let mut result = Vec::new();
            let mut offset = 13;
            while offset + 15 <= file.len() {
                let tag_type = file[offset] & 0x1f;
                let data_size = (usize::from(file[offset + 1]) << 16)
                    | (usize::from(file[offset + 2]) << 8)
                    | usize::from(file[offset + 3]);
                let payload = &file[offset + 11..offset + 11 + data_size];
                if tag_type == wanted_type
                    && !flv_payload_is_codec_sequence_header(tag_type, payload)
                {
                    result.push(
                        (u32::from(file[offset + 4]) << 16)
                            | (u32::from(file[offset + 5]) << 8)
                            | u32::from(file[offset + 6])
                            | (u32::from(file[offset + 7]) << 24),
                    );
                }
                offset += 11 + data_size + 4;
            }
            result
        }

        let path = std::env::temp_dir().join(format!(
            "rlive-flv-late-track-{}.flv",
            Uuid::new_v4().simple()
        ));
        let mut file = b"FLV\x01\x05\x00\x00\x00\x09\x00\x00\x00\x00".to_vec();
        // The first response has video only and establishes an absolute epoch.
        append_tag(&mut file, 9, 8_370, &[0x17, 0]);
        append_tag(&mut file, 9, 2_000_000, &[0x27, 1, 0x10]);
        append_tag(&mut file, 9, 2_001_000, &[0x27, 1, 0x11]);

        // On reconnect audio arrives first at the reset clock. Both tracks
        // must then use the one new shared offset, not rebase independently.
        append_tag(&mut file, 18, 0, &[0]);
        append_tag(&mut file, 8, 33, &[0xaf, 0]);
        append_tag(&mut file, 9, 8_370, &[0x17, 0]);
        append_tag(&mut file, 8, 0, &[0xaf, 1, 0x21]);
        append_tag(&mut file, 9, 0, &[0x27, 1, 0x22]);
        append_tag(&mut file, 8, 18, &[0xaf, 1, 0x23]);
        append_tag(&mut file, 9, 1_000, &[0x27, 1, 0x24]);
        std::fs::write(&path, file).unwrap();

        assert_eq!(normalize_flv_timestamps(&path).unwrap(), Some(2_001));
        let normalized = std::fs::read(&path).unwrap();
        assert_eq!(media_timestamps(&normalized, 8), [1_001, 1_019]);
        assert_eq!(media_timestamps(&normalized, 9), [0, 1_000, 1_001, 2_001]);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn drops_late_track_replay_before_absolute_clock_returns() {
        fn append_tag(file: &mut Vec<u8>, tag_type: u8, timestamp: u32, payload: &[u8]) {
            file.extend_from_slice(&[
                tag_type,
                (payload.len() >> 16) as u8,
                (payload.len() >> 8) as u8,
                payload.len() as u8,
                (timestamp >> 16) as u8,
                (timestamp >> 8) as u8,
                timestamp as u8,
                (timestamp >> 24) as u8,
                0,
                0,
                0,
            ]);
            file.extend_from_slice(payload);
            file.extend_from_slice(&((payload.len() + 11) as u32).to_be_bytes());
        }

        fn media_payloads(file: &[u8], wanted_type: u8) -> Vec<Vec<u8>> {
            let mut result = Vec::new();
            let mut offset = 13;
            while offset + 15 <= file.len() {
                let tag_type = file[offset] & 0x1f;
                let data_size = (usize::from(file[offset + 1]) << 16)
                    | (usize::from(file[offset + 2]) << 8)
                    | usize::from(file[offset + 3]);
                if offset + 11 + data_size + 4 > file.len() {
                    break;
                }
                if tag_type == wanted_type {
                    result.push(file[offset + 11..offset + 11 + data_size].to_vec());
                }
                offset += 11 + data_size + 4;
            }
            result
        }

        let path = std::env::temp_dir().join(format!(
            "rlive-flv-late-track-replay-{}.flv",
            Uuid::new_v4().simple()
        ));
        let mut file = b"FLV\x01\x05\x00\x00\x00\x09\x00\x00\x00\x00".to_vec();

        // The first response has video only at the source's absolute clock.
        append_tag(&mut file, 9, 8_370, &[0x17, 0]);
        append_tag(&mut file, 9, 2_000_000, &[0x27, 1, 0x10]);
        append_tag(&mut file, 9, 2_001_000, &[0x27, 1, 0x11]);

        // Reconnect preamble: audio appears for the first time and replays a
        // low-clock packet before the stream returns to its absolute clock.
        append_tag(&mut file, 18, 0, &[0]);
        append_tag(&mut file, 8, 33, &[0xaf, 0]);
        append_tag(&mut file, 8, 50, &[0xaf, 1, 0xa1]);
        append_tag(&mut file, 9, 8_370, &[0x17, 0]);
        append_tag(&mut file, 9, 0, &[0x27, 1, 0xb1]);
        append_tag(&mut file, 8, 80, &[0xaf, 1, 0xa2]);

        // The high-clock media proves the low audio/video tags above were a
        // replayed preamble. Only these packets should survive the boundary.
        append_tag(&mut file, 9, 2_002_000, &[0x27, 1, 0xc1]);
        append_tag(&mut file, 8, 2_002_018, &[0xaf, 1, 0xc2]);
        std::fs::write(&path, file).unwrap();

        assert_eq!(normalize_flv_timestamps(&path).unwrap(), Some(2_018));
        let normalized = std::fs::read(&path).unwrap();
        let audio = media_payloads(&normalized, 8);
        let video = media_payloads(&normalized, 9);
        assert_eq!(audio, [vec![0xaf, 0], vec![0xaf, 1, 0xc2]]);
        assert_eq!(
            video,
            [
                vec![0x17, 0],
                vec![0x27, 1, 0x10],
                vec![0x27, 1, 0x11],
                vec![0x17, 0],
                vec![0x27, 1, 0xc1],
            ]
        );
        assert!(audio.iter().all(|payload| payload.last() != Some(&0xa1)));
        assert!(audio.iter().all(|payload| payload.last() != Some(&0xa2)));
        assert!(video.iter().all(|payload| payload.last() != Some(&0xb1)));
        let _ = std::fs::remove_file(path);
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
    fn huya_direct_recording_can_fall_back_between_http_schemes() {
        let source = crate::models::live::PlayUrl::inferred(
            "huya:AL",
            "线路1",
            0,
            "https://al.flv.huya.com/src/live.flv?token=secret".into(),
            Default::default(),
        );
        let candidates = direct_source_candidates(&source, Some("huya"));

        assert_eq!(candidates.len(), 2);
        assert_eq!(candidates[0].url, source.url);
        assert!(candidates[1].url.starts_with("http://al.flv.huya.com/"));
        assert_eq!(candidates[1].headers, source.headers);
        assert_eq!(direct_source_candidates(&source, Some("douyu")).len(), 1);
    }

    #[tokio::test]
    async fn direct_recording_reconnects_after_eof_until_cancelled() {
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

        let header = b"FLV\x01\x05\x00\x00\x00\x09\x00\x00\x00\x00";
        let first_tag = tag(0, b"first");
        let mut incomplete_tag = tag(500, b"discard-me");
        incomplete_tag.truncate(incomplete_tag.len() - 4);
        let mut first_response = header.to_vec();
        first_response.extend_from_slice(&first_tag);
        first_response.extend_from_slice(&incomplete_tag);
        let mut second_response = header.to_vec();
        let second_tag = tag(1000, b"second");
        second_response.extend_from_slice(&second_tag);
        let expected_size = header.len() + first_tag.len() + second_tag.len();

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            for body in [first_response, second_response] {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = [0_u8; 2048];
                let _ = socket.read(&mut request).await.unwrap();
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: video/x-flv\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                socket.write_all(response.as_bytes()).await.unwrap();
                socket.write_all(&body).await.unwrap();
            }
        });

        let root = std::env::temp_dir().join(format!("rlive-direct-retry-{}", Uuid::new_v4()));
        let bundle = root.join(Uuid::new_v4().to_string());
        std::fs::create_dir_all(&bundle).unwrap();
        let stored = completed_recording(
            bundle.file_name().unwrap().to_string_lossy().into_owned(),
            "retry",
        );
        let state = Arc::new(SessionState {
            root: root.clone(),
            bundle: bundle.clone(),
            stored: Mutex::new(StoredRecording {
                status: RecordingStatus::Recording,
                media_file: "stream.flv".into(),
                ..stored
            }),
            bytes: AtomicU64::new(0),
            duration_ms: AtomicU64::new(0),
            danmaku_count: AtomicU64::new(0),
            danmaku_writer: Mutex::new(None),
            danmaku_closed: AtomicBool::new(false),
            finished: AtomicBool::new(false),
        });
        let source = crate::models::live::PlayUrl::inferred(
            "test:1",
            "测试线路",
            0,
            format!("http://{address}/live.flv"),
            Default::default(),
        );
        let client = crate::http_client::recording_stream_client_for_proxy(None).unwrap();
        let (cancel_tx, cancel_rx) = watch::channel(false);
        let task_state = state.clone();
        let task = tokio::spawn(async move {
            run_direct_recording(client, source, task_state, cancel_rx).await
        });

        tokio::time::timeout(std::time::Duration::from_secs(4), async {
            while state.bytes.load(std::sync::atomic::Ordering::Relaxed) < expected_size as u64 {
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        cancel_tx.send(true).unwrap();
        let outcome = task.await.unwrap();
        server.await.unwrap();

        assert_eq!(outcome.status, RecordingStatus::Completed);
        assert_eq!(outcome.error, None);
        let mut expected = header.to_vec();
        expected.extend_from_slice(&first_tag);
        expected.extend_from_slice(&second_tag);
        assert_eq!(std::fs::read(bundle.join("stream.flv")).unwrap(), expected);
        std::fs::remove_dir_all(root).unwrap();
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
