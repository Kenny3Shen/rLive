pub mod bilibili;
pub mod douyin;
pub mod douyin_sign;
pub mod douyu;
pub mod huya;
pub mod reconnect;
pub mod tars;
pub mod twitch;

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
#[cfg(not(target_os = "android"))]
use tauri::Manager;
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, oneshot};
use tokio::time::{self, MissedTickBehavior};

use crate::error::{AppError, AppResult};
use crate::models::live::{DanmakuEvent, DanmakuKind, SiteId};

/// The frontend receives at most one danmaku event payload every 50ms.  A
/// bounded ingress queue keeps a sudden busy-room burst from growing without
/// limit while the webview is busy rendering a previous batch.
const DANMAKU_EVENT_CHANNEL_CAPACITY: usize = 2_048;
const DANMAKU_BATCH_MAX_EVENTS: usize = 512;
const DANMAKU_BATCH_INTERVAL: Duration = Duration::from_millis(50);
#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
const DANMAKU_FINAL_FLUSH_TIMEOUT: Duration = Duration::from_secs(1);
const MAX_ACCOUNT_ID_CHARS: usize = 128;
const MAX_ACCOUNT_NAME_CHARS: usize = 128;

/// Cookie-derived identity for one active site connection.
///
/// This is intentionally backend-only: the event dispatcher turns it into a
/// boolean `is_self` flag, while account IDs, usernames, and Cookie values
/// never cross the Tauri IPC boundary.
#[derive(Clone, Default)]
struct SelfDanmakuIdentity {
    user_ids: HashSet<String>,
    user_names: HashSet<String>,
}

impl SelfDanmakuIdentity {
    fn from_cookie(site_id: &SiteId, cookie: &str) -> Self {
        let (id_keys, site_name_keys): (&[&str], &[&str]) = match site_id {
            // Bilibili's browser Cookie has a stable account mid but normally
            // does not contain a display name.
            SiteId::Bilibili => (&["DedeUserID"], &["DedeUserName"]),
            // Douyu's QR/browser Cookie carries both the account uid and
            // display name, so names remain useful when a relay omits uid.
            SiteId::Douyu => (&["acf_uid", "uid"], &["acf_username"]),
            // Huya uses either uid key depending on the authentication flow;
            // `udb_n` is its browser account-name field.
            SiteId::Huya => (&["yyuid", "udb_uid"], &["udb_n"]),
            // Do not infer an identity from opaque Douyin/Twitch session
            // tokens. A human-readable explicit name remains a safe fallback.
            SiteId::Douyin | SiteId::Twitch => (&[], &[]),
        };
        const GENERIC_NAME_KEYS: &[&str] =
            &["username", "user_name", "nickname", "nick", "display_name"];

        let mut identity = Self::default();
        for value in cookie_values(cookie, id_keys) {
            if let Some(user_id) = normalize_user_id(&value) {
                identity.user_ids.insert(user_id);
            }
        }
        for value in cookie_values(cookie, site_name_keys)
            .into_iter()
            .chain(cookie_values(cookie, GENERIC_NAME_KEYS))
        {
            if let Some(user_name) = normalize_user_name(&value) {
                identity.user_names.insert(user_name);
            }
        }
        identity
    }

    fn matches(&self, event: &DanmakuEvent) -> bool {
        if matches!(&event.kind, DanmakuKind::System) {
            return false;
        }

        // An event ID is authoritative when the Cookie yielded an ID as well.
        // Falling back to the display name in that case could highlight a
        // different user whose visible nickname happens to match ours.
        if let Some(event_id) = event.user_id.as_deref().and_then(normalize_user_id)
            && !self.user_ids.is_empty()
        {
            return self.user_ids.contains(&event_id);
        }

        normalize_user_name(&event.user).is_some_and(|name| self.user_names.contains(&name))
    }

    fn mark(&self, event: &mut DanmakuEvent) {
        event.is_self = self.matches(event);
    }
}

fn cookie_values(cookie: &str, names: &[&str]) -> Vec<String> {
    if names.is_empty() {
        return Vec::new();
    }
    let cookie = cookie.trim();
    let cookie = cookie
        .strip_prefix("Cookie:")
        .or_else(|| cookie.strip_prefix("cookie:"))
        .unwrap_or(cookie);

    cookie
        .split(';')
        .filter_map(|pair| pair.trim().split_once('='))
        .filter(|(name, _)| {
            names
                .iter()
                .any(|expected| name.trim().eq_ignore_ascii_case(expected))
        })
        .filter_map(|(_, value)| {
            let value = value.trim().trim_matches('"');
            (value.len() <= MAX_ACCOUNT_NAME_CHARS * 4).then(|| percent_decode_cookie_value(value))
        })
        .collect()
}

/// Cookie values encode a display name with percent escapes on several web
/// login flows. Cookie encoding treats `+` literally, unlike URL forms.
fn percent_decode_cookie_value(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let high = (bytes[index + 1] as char).to_digit(16);
            let low = (bytes[index + 2] as char).to_digit(16);
            if let (Some(high), Some(low)) = (high, low) {
                decoded.push((high * 16 + low) as u8);
                index += 3;
                continue;
            }
        }
        decoded.push(bytes[index]);
        index += 1;
    }
    String::from_utf8(decoded).unwrap_or_else(|_| value.to_owned())
}

fn normalize_user_id(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty() && value != "0" && value.chars().count() <= MAX_ACCOUNT_ID_CHARS)
        .then(|| value.to_owned())
}

fn normalize_user_name(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty() && value.chars().count() <= MAX_ACCOUNT_NAME_CHARS)
        .then(|| value.to_lowercase())
}

/// Non-blocking handle used by site websocket loops to forward decoded
/// danmaku to the batched Tauri event dispatcher.
#[derive(Clone)]
pub struct DanmakuEventSender {
    sender: mpsc::Sender<DanmakuEvent>,
    identity: SelfDanmakuIdentity,
}

#[derive(Clone, Serialize)]
struct DanmakuBatch<'a> {
    connection_epoch: u64,
    events: &'a [DanmakuEvent],
}

impl DanmakuEventSender {
    fn new(sender: mpsc::Sender<DanmakuEvent>, identity: SelfDanmakuIdentity) -> Self {
        Self { sender, identity }
    }

    fn send(&self, mut event: DanmakuEvent) {
        self.identity.mark(&mut event);
        // Receiving must never wait on the webview.  When an exceptional
        // burst fills the bounded queue, keeping the live connection healthy
        // matters more than retaining every already-stale chat message.
        let _ = self.sender.try_send(event);
    }
}

/// Manages the room page's active danmaku connection plus connections retained
/// by background recordings. Background batches still carry their original
/// generation, so the frontend ignores them while the recording sidecar keeps
/// receiving events by `source_key`.
pub struct DanmakuManager {
    inner: Mutex<DanmakuConnectionState>,
}

#[derive(Default)]
struct DanmakuTasks {
    connection_handle: Option<JoinHandle<()>>,
    batch_handle: Option<JoinHandle<()>>,
    // Only the desktop flush path reads this sender back, but every platform
    // must keep it alive: dropping it closes the control channel, which makes
    // `dispatch_batches` observe `None` and stop delivering danmaku at once.
    #[cfg_attr(
        not(any(target_os = "windows", target_os = "linux", target_os = "macos")),
        expect(dead_code)
    )]
    batch_control: Option<mpsc::UnboundedSender<DanmakuBatchControl>>,
}

impl DanmakuTasks {
    fn abort(mut self) {
        if let Some(handle) = self.connection_handle.take() {
            handle.abort();
        }
        if let Some(handle) = self.batch_handle.take() {
            handle.abort();
        }
    }

    /// Flushes the batch task before teardown so a recording sidecar keeps the
    /// final queued events. Only the desktop recording path needs this.
    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
    async fn stop_and_flush(mut self) {
        if let Some(handle) = self.connection_handle.take() {
            handle.abort();
            let _ = handle.await;
        }
        if let Some(control) = self.batch_control.take() {
            let _ = control.send(DanmakuBatchControl::StopAndFlush);
        }
        if let Some(mut handle) = self.batch_handle.take()
            && time::timeout(DANMAKU_FINAL_FLUSH_TIMEOUT, &mut handle)
                .await
                .is_err()
        {
            handle.abort();
            let _ = handle.await;
        }
    }
}

// `dispatch_batches` matches both variants on every platform; only the desktop
// recording path constructs them, so mobile builds keep the shape without the
// dead-code warning.
#[cfg_attr(
    not(any(target_os = "windows", target_os = "linux", target_os = "macos")),
    expect(dead_code)
)]
enum DanmakuBatchControl {
    Flush(oneshot::Sender<()>),
    StopAndFlush,
}

struct BackgroundDanmakuConnection {
    generation: u64,
    tasks: DanmakuTasks,
}

struct DanmakuConnectionState {
    /// The newest route-level connection request accepted by the backend.
    generation: u64,
    active_source_key: Option<String>,
    active_tasks: DanmakuTasks,
    background_tasks: HashMap<String, BackgroundDanmakuConnection>,
}

impl Default for DanmakuManager {
    fn default() -> Self {
        Self {
            inner: Mutex::new(DanmakuConnectionState {
                generation: 0,
                active_source_key: None,
                active_tasks: DanmakuTasks::default(),
                background_tasks: HashMap::new(),
            }),
        }
    }
}

impl DanmakuManager {
    pub fn new() -> Self {
        Self::default()
    }

    fn abort_active_tasks(state: &mut DanmakuConnectionState) {
        std::mem::take(&mut state.active_tasks).abort();
    }

    fn clear_active(state: &mut DanmakuConnectionState) {
        Self::abort_active_tasks(state);
        state.active_source_key = None;
    }

    fn move_active_to_background(state: &mut DanmakuConnectionState) -> Option<String> {
        let source_key = state.active_source_key.take()?;
        let tasks = std::mem::take(&mut state.active_tasks);
        let connection = BackgroundDanmakuConnection {
            generation: state.generation,
            tasks,
        };
        if let Some(previous) = state
            .background_tasks
            .insert(source_key.clone(), connection)
        {
            previous.tasks.abort();
        }
        Some(source_key)
    }

    /// Marks a route request as the only connection allowed to install a task.
    ///
    /// `danmaku_connect` has to fetch room metadata before it can open the
    /// websocket. A slow request from a room that was already left must not
    /// install itself after a newer route is active, hence the caller-provided
    /// monotonically increasing generation.
    pub fn begin_connect(
        &self,
        generation: u64,
        source_key: String,
        preserve_active: bool,
    ) -> bool {
        let Ok(mut state) = self.inner.lock() else {
            return false;
        };
        if generation < state.generation {
            return false;
        }
        if preserve_active {
            Self::move_active_to_background(&mut state);
        } else {
            Self::clear_active(&mut state);
        }
        state.generation = generation;
        // Revisiting a room replaces its retained connection instead of
        // delivering duplicate websocket batches to the same sidecar.
        if let Some(previous) = state.background_tasks.remove(&source_key) {
            previous.tasks.abort();
        }
        state.active_source_key = Some(source_key);
        true
    }

    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
    pub fn active_source_key(&self) -> Option<String> {
        self.inner
            .lock()
            .ok()
            .and_then(|state| state.active_source_key.clone())
    }

    /// Returns the active source only when this cleanup is new enough to
    /// affect it. The caller can then decide whether to stop or retain it.
    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
    pub fn source_key_for_generation(&self, generation: u64) -> Option<String> {
        self.inner.lock().ok().and_then(|state| {
            (generation >= state.generation)
                .then(|| state.active_source_key.clone())
                .flatten()
        })
    }

    #[cfg(test)]
    pub fn is_current(&self, generation: u64) -> bool {
        self.inner
            .lock()
            .map(|state| state.generation == generation)
            .unwrap_or(false)
    }

    fn accepts_connection_generation(&self, generation: u64) -> bool {
        self.inner
            .lock()
            .map(|state| {
                (state.generation == generation && state.active_source_key.is_some())
                    || state
                        .background_tasks
                        .values()
                        .any(|connection| connection.generation == generation)
            })
            .unwrap_or(false)
    }

    /// Detaches the current page without stopping its websocket. The tasks
    /// remain keyed by their recording source until that recording finishes.
    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos", test))]
    pub fn detach_for_generation(&self, generation: u64) -> bool {
        let Ok(mut state) = self.inner.lock() else {
            return false;
        };
        if generation < state.generation {
            return false;
        }
        let detached = Self::move_active_to_background(&mut state).is_some();
        state.generation = generation;
        detached
    }

    /// Stops only requests at or before `generation`; an older frontend
    /// cleanup therefore cannot terminate a newer room's connection.
    pub fn disconnect_for_generation(&self, generation: u64) -> bool {
        let Ok(mut state) = self.inner.lock() else {
            return false;
        };
        if generation < state.generation {
            return false;
        }
        state.generation = generation;
        Self::clear_active(&mut state);
        true
    }

    /// Stops a retained connection only. An identical room that is currently
    /// open owns the active connection and must survive a recording stop.
    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos", test))]
    pub fn disconnect_background_for_source(&self, source_key: &str) -> bool {
        let Ok(mut state) = self.inner.lock() else {
            return false;
        };
        let Some(connection) = state.background_tasks.remove(source_key) else {
            return false;
        };
        connection.tasks.abort();
        true
    }

    /// Stops a recording-owned connection after its receiver has emitted the
    /// final queued batch. Pending connection slots are removed as well, so an
    /// in-flight metadata request cannot install itself after recording ended.
    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
    pub(crate) async fn finish_recording_source(&self, source_key: &str) -> bool {
        let background = self
            .inner
            .lock()
            .ok()
            .and_then(|mut state| state.background_tasks.remove(source_key));
        if let Some(connection) = background {
            connection.tasks.stop_and_flush().await;
            return true;
        }

        let control = self.inner.lock().ok().and_then(|state| {
            (state.active_source_key.as_deref() == Some(source_key))
                .then(|| state.active_tasks.batch_control.clone())
                .flatten()
        });
        let flushed = if let Some(control) = control {
            request_batch_flush(control).await
        } else {
            false
        };

        // The page may have detached while the active flush was in flight.
        let background = self
            .inner
            .lock()
            .ok()
            .and_then(|mut state| state.background_tasks.remove(source_key));
        if let Some(connection) = background {
            connection.tasks.stop_and_flush().await;
            return true;
        }
        flushed
    }

    pub fn disconnect(&self) {
        if let Ok(mut state) = self.inner.lock() {
            state.generation = state.generation.saturating_add(1);
            Self::clear_active(&mut state);
            for (_, connection) in state.background_tasks.drain() {
                connection.tasks.abort();
            }
        }
    }

    /// Installs the task only when the request is still current. Returns false
    /// and aborts the task if another room superseded it while its metadata was
    /// loading.
    fn set_tasks_if_current(
        &self,
        generation: u64,
        connection_task: JoinHandle<()>,
        batch_task: JoinHandle<()>,
        batch_control: mpsc::UnboundedSender<DanmakuBatchControl>,
    ) -> bool {
        let Ok(mut state) = self.inner.lock() else {
            connection_task.abort();
            batch_task.abort();
            return false;
        };
        let tasks = DanmakuTasks {
            connection_handle: Some(connection_task),
            batch_handle: Some(batch_task),
            batch_control: Some(batch_control),
        };
        if state.generation == generation && state.active_source_key.is_some() {
            Self::abort_active_tasks(&mut state);
            state.active_tasks = tasks;
            return true;
        }
        if let Some(connection) = state
            .background_tasks
            .values_mut()
            .find(|connection| connection.generation == generation)
        {
            std::mem::replace(&mut connection.tasks, tasks).abort();
            return true;
        }
        tasks.abort();
        false
    }
}

#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
async fn request_batch_flush(control: mpsc::UnboundedSender<DanmakuBatchControl>) -> bool {
    let (ack_tx, ack_rx) = oneshot::channel();
    if control.send(DanmakuBatchControl::Flush(ack_tx)).is_err() {
        return false;
    }
    time::timeout(DANMAKU_FINAL_FLUSH_TIMEOUT, ack_rx)
        .await
        .is_ok()
}

#[allow(clippy::too_many_arguments)]
fn spawn_loop<F, Fut>(
    app: AppHandle,
    manager: &DanmakuManager,
    generation: u64,
    site: &'static str,
    source_key: String,
    identity: SelfDanmakuIdentity,
    notice: Option<String>,
    fut: F,
) where
    F: FnOnce(DanmakuEventSender) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = AppResult<()>> + Send + 'static,
{
    let (event_tx, event_rx) = mpsc::channel(DANMAKU_EVENT_CHANNEL_CAPACITY);
    let (batch_control_tx, batch_control_rx) = mpsc::unbounded_channel();
    let batch_task = tauri::async_runtime::spawn(dispatch_batches(
        app.clone(),
        generation,
        source_key,
        event_rx,
        batch_control_rx,
    ));
    // Do not let the task run until its generation is installed. Without this
    // gate a route switch in the tiny window between `spawn` and manager
    // registration could still emit a stale room's first event.
    let (start_tx, start_rx) = tokio::sync::oneshot::channel::<()>();
    let sender = DanmakuEventSender::new(event_tx, identity);
    let error_sender = sender.clone();
    let connection_task = tauri::async_runtime::spawn(async move {
        if start_rx.await.is_err() {
            return;
        }
        // An account-level notice (e.g. "Cookie expired, anonymous mode") is
        // the first thing a fresh room sees, before any chat from the wire.
        if let Some(content) = notice {
            emit_event(
                &sender,
                DanmakuEvent {
                    kind: crate::models::live::DanmakuKind::System,
                    user: "system".into(),
                    is_self: false,
                    user_id: None,
                    content,
                    color: None,
                    spans: None,
                    super_chat: None,
                    ts: chrono::Utc::now().timestamp_millis(),
                },
            );
        }
        if let Err(e) = fut(sender).await {
            tracing::warn!("{site} danmaku ended: {e}");
            emit_event(
                &error_sender,
                DanmakuEvent {
                    kind: crate::models::live::DanmakuKind::System,
                    user: "system".into(),
                    is_self: false,
                    user_id: None,
                    content: format!("弹幕连接断开: {e}"),
                    color: None,
                    spans: None,
                    super_chat: None,
                    ts: chrono::Utc::now().timestamp_millis(),
                },
            );
        }
    });
    if manager.set_tasks_if_current(generation, connection_task, batch_task, batch_control_tx) {
        let _ = start_tx.send(());
    }
}

async fn dispatch_batches(
    app: AppHandle,
    generation: u64,
    source_key: String,
    mut receiver: mpsc::Receiver<DanmakuEvent>,
    mut control: mpsc::UnboundedReceiver<DanmakuBatchControl>,
) {
    let mut ticker = time::interval(DANMAKU_BATCH_INTERVAL);
    ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
    // `interval` ticks immediately by design.  Wait one full period before
    // the first delivery so several events from the same websocket frame are
    // coalesced too.
    ticker.tick().await;

    let mut batch = Vec::with_capacity(DANMAKU_BATCH_MAX_EVENTS);
    loop {
        tokio::select! {
            event = receiver.recv() => match event {
                Some(event) => {
                    // Preserve the 20fps upper bound even for an extreme
                    // burst.  Additional chat is intentionally shed rather
                    // than creating a giant serialization/DOM workload.
                    if batch.len() < DANMAKU_BATCH_MAX_EVENTS {
                        batch.push(event);
                    }
                }
                None => {
                    emit_batch(&app, generation, &source_key, &mut batch);
                    return;
                }
            },
            _ = ticker.tick() => emit_batch(&app, generation, &source_key, &mut batch),
            command = control.recv() => match command {
                Some(DanmakuBatchControl::Flush(ack)) => {
                    drain_ready_events(&mut receiver, &mut batch);
                    emit_batch(&app, generation, &source_key, &mut batch);
                    let _ = ack.send(());
                }
                Some(DanmakuBatchControl::StopAndFlush) | None => {
                    drain_ready_events(&mut receiver, &mut batch);
                    emit_batch(&app, generation, &source_key, &mut batch);
                    return;
                }
            },
        }
    }
}

fn drain_ready_events(receiver: &mut mpsc::Receiver<DanmakuEvent>, batch: &mut Vec<DanmakuEvent>) {
    while let Ok(event) = receiver.try_recv() {
        if batch.len() < DANMAKU_BATCH_MAX_EVENTS {
            batch.push(event);
        }
    }
}

// `source_key` only feeds the desktop recording capture path, so mobile builds
// compile it out instead of dropping the parameter from the shared signature.
#[cfg_attr(
    not(any(target_os = "windows", target_os = "linux", target_os = "macos")),
    expect(unused_variables)
)]
fn emit_batch(app: &AppHandle, generation: u64, source_key: &str, batch: &mut Vec<DanmakuEvent>) {
    if batch.is_empty() {
        return;
    }
    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
    if let Some(state) = app.try_state::<crate::state::AppState>() {
        state.recording.capture_danmaku(source_key, batch);
    }
    // The frontend owns retention and rendering policy. The tiny envelope
    // retains the connection fence while carrying all events for this tick,
    // so ordinary chat, Super Chat, and floating-layer listeners each process one
    // native callback instead of one callback per message.
    let _ = app.emit(
        "danmaku-batch",
        DanmakuBatch {
            connection_epoch: generation,
            events: &*batch,
        },
    );
    batch.clear();
}

pub(crate) struct DanmakuConnectRequest<'a> {
    pub(crate) generation: u64,
    pub(crate) site_id: SiteId,
    pub(crate) room_id: &'a str,
    pub(crate) detail_raw: &'a serde_json::Value,
    pub(crate) cookie: &'a str,
    pub(crate) identity_cookie: &'a str,
    pub(crate) proxy: Option<&'a str>,
    pub(crate) notice: Option<String>,
}

pub async fn connect(
    app: AppHandle,
    manager: &DanmakuManager,
    request: DanmakuConnectRequest<'_>,
) -> AppResult<()> {
    let DanmakuConnectRequest {
        generation,
        site_id,
        room_id,
        detail_raw,
        cookie,
        identity_cookie,
        proxy,
        notice,
    } = request;
    if !manager.accepts_connection_generation(generation) {
        return Ok(());
    }

    let identity = SelfDanmakuIdentity::from_cookie(&site_id, identity_cookie);
    let source_key = format!("live:{}:{}", site_id.as_str(), room_id.trim());

    match site_id {
        SiteId::Bilibili => {
            let args = bilibili::args_from_raw(room_id, detail_raw)?;
            if args.token.is_empty() {
                return Err(
                    AppError::new("danmaku_missing_token", "弹幕 token 缺失，无法连接")
                        .with_site("bilibili"),
                );
            }
            spawn_loop(
                app.clone(),
                manager,
                generation,
                "bilibili",
                source_key.clone(),
                identity,
                notice,
                move |events| bilibili::run_loop(events, args),
            );
            Ok(())
        }
        SiteId::Douyu => {
            let args = douyu::args_from_raw(room_id, detail_raw)?;
            spawn_loop(
                app.clone(),
                manager,
                generation,
                "douyu",
                source_key.clone(),
                identity,
                notice,
                move |events| douyu::run_loop(events, args),
            );
            Ok(())
        }
        SiteId::Huya => {
            let args = huya::args_from_raw(room_id, detail_raw)?;
            spawn_loop(
                app.clone(),
                manager,
                generation,
                "huya",
                source_key.clone(),
                identity,
                notice,
                move |events| huya::run_loop(events, args),
            );
            Ok(())
        }
        SiteId::Twitch => {
            let args = twitch::args_from_raw(room_id, detail_raw)?;
            let proxy = proxy.map(str::to_owned);
            spawn_loop(
                app.clone(),
                manager,
                generation,
                "twitch",
                source_key.clone(),
                identity,
                notice,
                move |events| twitch::run_loop(events, args, proxy),
            );
            Ok(())
        }
        SiteId::Douyin => {
            // Local MSSDK signing is CPU-bound JS eval; keep it off the hot
            // path relative to room transitions by checking generation after.
            let args = douyin::build_connection(room_id, detail_raw, cookie)?;
            if !manager.accepts_connection_generation(generation) {
                return Ok(());
            }
            spawn_loop(
                app.clone(),
                manager,
                generation,
                "douyin",
                source_key,
                identity,
                notice,
                move |events| douyin::run_loop(events, args),
            );
            Ok(())
        }
    }
}

pub fn emit_event(sender: &DanmakuEventSender, event: DanmakuEvent) {
    sender.send(event);
}

#[cfg(test)]
mod tests {
    use super::{
        DanmakuBatch, DanmakuBatchControl, DanmakuManager, DanmakuTasks, SelfDanmakuIdentity,
    };
    use crate::models::live::{DanmakuEvent, DanmakuKind};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};
    use tokio::sync::mpsc;

    #[test]
    fn newer_connection_epochs_fence_stale_connects_and_cleanups() {
        let manager = DanmakuManager::new();

        assert!(manager.begin_connect(100, "live:bilibili:100".into(), false));
        assert!(manager.begin_connect(101, "live:bilibili:101".into(), false));
        assert!(!manager.begin_connect(100, "live:bilibili:100".into(), false));
        assert!(manager.is_current(101));

        // A delayed cleanup from the old room must leave the newer room alive.
        assert!(!manager.disconnect_for_generation(100));
        assert!(manager.is_current(101));

        assert!(manager.disconnect_for_generation(102));
        assert!(manager.is_current(102));

        // The frontend uses a lower stop fence followed by a higher connect
        // epoch. If the stop IPC arrives late, it must not tear down the
        // newer connection that has already claimed the manager.
        assert!(manager.begin_connect(103, "live:bilibili:103".into(), false));
        assert!(!manager.disconnect_for_generation(102));
        assert!(manager.is_current(103));
    }

    #[tokio::test]
    async fn detached_recording_connection_survives_a_new_room_until_released() {
        let manager = DanmakuManager::new();
        let source = "live:bilibili:100";

        assert!(manager.begin_connect(100, source.into(), false));
        let connection = tauri::async_runtime::spawn(std::future::pending::<()>());
        let batch = tauri::async_runtime::spawn(std::future::pending::<()>());
        let (control, _receiver) = mpsc::unbounded_channel();
        assert!(manager.set_tasks_if_current(100, connection, batch, control));
        assert!(manager.detach_for_generation(101));
        assert!(manager.begin_connect(102, "live:huya:200".into(), false));
        assert!(
            manager
                .inner
                .lock()
                .unwrap()
                .background_tasks
                .contains_key(source)
        );

        assert!(manager.disconnect_background_for_source(source));
        assert!(!manager.disconnect_background_for_source(source));
        assert!(manager.is_current(102));

        // A replacement connect can arrive before the old page's cleanup IPC.
        // It must retain the old room atomically when recording still owns it.
        let connection = tauri::async_runtime::spawn(std::future::pending::<()>());
        let batch = tauri::async_runtime::spawn(std::future::pending::<()>());
        let (control, _receiver) = mpsc::unbounded_channel();
        assert!(manager.set_tasks_if_current(102, connection, batch, control));
        assert!(manager.begin_connect(103, "live:douyu:300".into(), true));
        assert!(
            manager
                .inner
                .lock()
                .unwrap()
                .background_tasks
                .contains_key("live:huya:200")
        );
        assert!(manager.disconnect_background_for_source("live:huya:200"));
        manager.disconnect();
    }

    #[tokio::test]
    async fn pending_connect_installs_into_background_after_route_detaches() {
        let manager = DanmakuManager::new();
        let source = "live:bilibili:pending";

        assert!(manager.begin_connect(200, source.into(), false));
        assert!(manager.detach_for_generation(201));
        assert!(manager.accepts_connection_generation(200));
        {
            let state = manager.inner.lock().unwrap();
            let pending = state.background_tasks.get(source).unwrap();
            assert_eq!(pending.generation, 200);
            assert!(pending.tasks.connection_handle.is_none());
        }

        let connection = tauri::async_runtime::spawn(std::future::pending::<()>());
        let batch = tauri::async_runtime::spawn(std::future::pending::<()>());
        let (control, _receiver) = mpsc::unbounded_channel();
        assert!(manager.set_tasks_if_current(200, connection, batch, control));
        assert!(
            manager
                .inner
                .lock()
                .unwrap()
                .background_tasks
                .get(source)
                .unwrap()
                .tasks
                .connection_handle
                .is_some()
        );
        assert!(manager.disconnect_background_for_source(source));
    }

    #[tokio::test]
    async fn graceful_background_stop_requests_final_batch_flush() {
        let flushed = Arc::new(AtomicBool::new(false));
        let batch_flushed = flushed.clone();
        let (control, mut commands) = mpsc::unbounded_channel();
        let batch = tauri::async_runtime::spawn(async move {
            if matches!(
                commands.recv().await,
                Some(DanmakuBatchControl::StopAndFlush)
            ) {
                batch_flushed.store(true, Ordering::Release);
            }
        });
        let connection = tauri::async_runtime::spawn(std::future::pending::<()>());
        let tasks = DanmakuTasks {
            connection_handle: Some(connection),
            batch_handle: Some(batch),
            batch_control: Some(control),
        };

        tasks.stop_and_flush().await;
        assert!(flushed.load(Ordering::Acquire));
    }

    #[test]
    fn batch_payload_keeps_the_frontend_transport_contract() {
        let events = [DanmakuEvent {
            kind: DanmakuKind::Chat,
            user: "viewer".into(),
            is_self: false,
            user_id: Some("42".into()),
            content: "hello".into(),
            color: None,
            spans: None,
            super_chat: None,
            ts: 1,
        }];
        let value = serde_json::to_value(DanmakuBatch {
            connection_epoch: 42,
            events: &events,
        })
        .unwrap();

        assert_eq!(value["connection_epoch"], 42);
        assert_eq!(value["events"].as_array().map(Vec::len), Some(1));
        assert_eq!(value["events"][0]["is_self"], false);
        assert!(value["events"][0].get("user_id").is_none());
    }

    #[test]
    fn cookie_identity_prefers_platform_user_id_and_keeps_name_as_a_fallback() {
        let identity = SelfDanmakuIdentity::from_cookie(
            &crate::models::live::SiteId::Douyu,
            "acf_uid=42; acf_username=%E5%B0%8F%E6%98%8E",
        );
        let mut event = DanmakuEvent {
            kind: DanmakuKind::Chat,
            user: "小明".into(),
            is_self: false,
            user_id: Some("42".into()),
            content: "hello".into(),
            color: None,
            spans: None,
            super_chat: None,
            ts: 1,
        };
        identity.mark(&mut event);
        assert!(event.is_self);

        // A same-name event with a conflicting authoritative UID is another
        // viewer, not the local account.
        event.user_id = Some("99".into());
        identity.mark(&mut event);
        assert!(!event.is_self);

        // Some relay payloads omit uid, so the decoded Cookie username is the
        // deliberate safe fallback in that specific case.
        event.user_id = None;
        identity.mark(&mut event);
        assert!(event.is_self);
    }
}
