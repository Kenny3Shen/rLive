//! Local, CPU-first Whisper live-caption manager.
//!
//! This module intentionally has no network client and never persists raw
//! audio or recognized text. It owns one bounded ingress queue and one native
//! worker thread so Whisper inference cannot occupy Tauri's async runtime.

use std::collections::VecDeque;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;

use ferrous_opencc::{OpenCC, config::BuiltinConfig};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, path::BaseDirectory};
use whisper_rs::{
    FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters, get_lang_str,
};

use crate::error::{AppError, AppResult};

pub const ASR_SAMPLE_RATE_HZ: u32 = 16_000;
pub const BUNDLED_MODEL_NAME: &str = "Whisper tiny Q5_1（多语言）";
pub const BUNDLED_MODEL_RESOURCE_PATH: &str = "models/ggml-tiny-q5_1.bin";
pub const BUNDLED_MODEL_SIZE_BYTES: u64 = 32_152_673;

/// The worklet normally submits 250–1000 ms chunks. Keeping only sixteen
/// chunks bounds latency and memory even when a CPU model cannot keep up.
const ASR_QUEUE_CAPACITY: usize = 16;
const MAX_AUDIO_CHUNK_BYTES: usize = ASR_SAMPLE_RATE_HZ as usize * 2 * 4;
const PARTIAL_WINDOW_SAMPLES: usize = ASR_SAMPLE_RATE_HZ as usize * 2;
const FINAL_WINDOW_SAMPLES: usize = ASR_SAMPLE_RATE_HZ as usize * 4;
const MAX_SESSION_ID_BYTES: usize = 160;
const CAPTION_EVENT_NAME: &str = "asr-caption";
// Let Whisper select the spoken language for each live-caption window. When
// that language is Chinese, its finished transcript is converted to Simplified
// Chinese before it is emitted to the overlay.
// In whisper.cpp, `detect_language` means detection-only: it returns before
// decoding a transcript, so it must remain disabled for captions.
const CAPTION_LANGUAGE: Option<&str> = None;
const CAPTION_DETECTION_ONLY: bool = false;
// whisper.cpp reads the native `GGML_FILE_MAGIC` u32. GGML files therefore
// begin with this little-endian byte sequence (`lmgg` on disk).
const GGML_FILE_MAGIC_BYTES: [u8; 4] = [0x6c, 0x6d, 0x67, 0x67];

/// Public model/session state consumed by Settings and the room player.
#[derive(Debug, Clone, Serialize)]
pub struct AsrModelStatus {
    pub loaded: bool,
    pub loading: bool,
    pub bundled: bool,
    pub path: Option<String>,
    pub active_session_id: Option<String>,
    pub queue_depth: usize,
    pub queue_capacity: usize,
    pub sample_rate_hz: u32,
    pub backend: &'static str,
    pub cpu_only: bool,
}

/// Returned by the high-frequency raw PCM command. Stale audio is accepted as
/// a no-op, so a delayed browser callback cannot surface a noisy user error
/// after the player has moved to another room.
#[derive(Debug, Clone, Serialize)]
pub struct AsrAudioPushResult {
    pub accepted: bool,
    pub dropped_chunks: usize,
    pub queue_depth: usize,
}

#[derive(Debug, Clone, Serialize)]
struct AsrCaptionEvent {
    session_id: String,
    sequence: u64,
    kind: &'static str,
    start_ms: u64,
    end_ms: u64,
    text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    status: Option<String>,
}

struct EventDelivery {
    app: AppHandle,
    event: AsrCaptionEvent,
}

struct AudioChunk {
    session_id: String,
    generation: u64,
    start_ms: u64,
    samples: Vec<i16>,
}

struct ActiveSession {
    id: String,
    generation: u64,
    next_sequence: u64,
    app: AppHandle,
}

struct AsrState {
    model: Option<Arc<WhisperContext>>,
    model_path: Option<PathBuf>,
    model_is_bundled: bool,
    model_loading: bool,
    model_operation: u64,
    active_session: Option<ActiveSession>,
    session_generation: u64,
    queue: VecDeque<AudioChunk>,
    worker_started: bool,
    shutting_down: bool,
}

impl Default for AsrState {
    fn default() -> Self {
        Self {
            model: None,
            model_path: None,
            model_is_bundled: false,
            model_loading: false,
            model_operation: 0,
            active_session: None,
            session_generation: 0,
            queue: VecDeque::with_capacity(ASR_QUEUE_CAPACITY),
            worker_started: false,
            shutting_down: false,
        }
    }
}

struct AsrInner {
    state: Mutex<AsrState>,
    wake: Condvar,
}

/// App-owned manager for a single local Whisper model and one active room
/// session. One model instance is deliberately shared to avoid multi-gigabyte
/// duplicate allocations on CPU-only machines.
pub struct AsrManager {
    inner: Arc<AsrInner>,
}

impl Default for AsrManager {
    fn default() -> Self {
        Self::new()
    }
}

impl AsrManager {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(AsrInner {
                state: Mutex::new(AsrState::default()),
                wake: Condvar::new(),
            }),
        }
    }

    pub fn model_status(&self) -> AppResult<AsrModelStatus> {
        let state = lock_state(&self.inner)?;
        Ok(status_from(&state))
    }

    /// Marks the model loader as active and fences any live session before a
    /// replacement model is created. The old model remains resident until the
    /// new one loads successfully, so a bad file selection is recoverable.
    pub fn begin_model_load(&self) -> AppResult<u64> {
        let delivery = {
            let mut state = lock_state(&self.inner)?;
            if state.model_loading {
                return Err(AppError::new(
                    "asr_model_load_in_progress",
                    "本地字幕模型正在加载",
                ));
            }
            state.model_loading = true;
            state.model_operation = state.model_operation.saturating_add(1);
            state.queue.clear();
            let delivery = stop_active_session_locked(&mut state, "model_loading");
            (state.model_operation, delivery)
        };
        self.inner.wake.notify_all();
        emit_optional(delivery.1);
        Ok(delivery.0)
    }

    pub fn complete_model_load(
        &self,
        operation: u64,
        path: PathBuf,
        model: WhisperContext,
        bundled: bool,
    ) -> AppResult<AsrModelStatus> {
        let mut state = lock_state(&self.inner)?;
        if state.model_operation != operation || !state.model_loading {
            return Err(AppError::new(
                "asr_model_load_superseded",
                "本地字幕模型加载已被新的操作取消",
            ));
        }
        state.model = Some(Arc::new(model));
        state.model_path = Some(path);
        state.model_is_bundled = bundled;
        state.model_loading = false;
        Ok(status_from(&state))
    }

    pub fn fail_model_load(&self, operation: u64) {
        if let Ok(mut state) = self.inner.state.lock()
            && state.model_operation == operation
        {
            state.model_loading = false;
        }
    }

    pub fn unload_model(&self) -> AppResult<AsrModelStatus> {
        let (status, delivery) = {
            let mut state = lock_state(&self.inner)?;
            state.model_operation = state.model_operation.saturating_add(1);
            state.model_loading = false;
            state.model = None;
            state.model_path = None;
            state.model_is_bundled = false;
            state.queue.clear();
            let delivery = stop_active_session_locked(&mut state, "model_unloaded");
            (status_from(&state), delivery)
        };
        self.inner.wake.notify_all();
        emit_optional(delivery);
        Ok(status)
    }

    pub fn start_session(&self, app: AppHandle, session_id: String) -> AppResult<AsrModelStatus> {
        validate_session_id(&session_id)?;
        self.ensure_worker()?;

        let (status, old_delivery, start_delivery) = {
            let mut state = lock_state(&self.inner)?;
            if state.model_loading {
                return Err(AppError::new(
                    "asr_model_load_in_progress",
                    "请等待本地字幕模型加载完成",
                ));
            }
            if state.model.is_none() {
                return Err(AppError::new(
                    "asr_model_not_loaded",
                    "请先在设置－播放中加载本地 Whisper 模型",
                ));
            }

            state.queue.clear();
            let old_delivery = stop_active_session_locked(&mut state, "replaced");
            state.session_generation = state.session_generation.saturating_add(1);
            let mut active = ActiveSession {
                id: session_id,
                generation: state.session_generation,
                next_sequence: 0,
                app,
            };
            let start_delivery =
                next_event(&mut active, "status", 0, 0, String::new(), Some("started"));
            state.active_session = Some(active);
            (status_from(&state), old_delivery, start_delivery)
        };
        self.inner.wake.notify_all();
        emit_optional(old_delivery);
        emit(start_delivery);
        Ok(status)
    }

    pub fn stop_session(&self, session_id: &str) -> AppResult<AsrModelStatus> {
        validate_session_id(session_id)?;
        let (status, delivery) = {
            let mut state = lock_state(&self.inner)?;
            let delivery = match state.active_session.as_ref() {
                Some(active) if active.id == session_id => {
                    state.queue.clear();
                    stop_active_session_locked(&mut state, "stopped")
                }
                // A previous room's delayed effect cleanup must never affect
                // the session that replaced it.
                _ => None,
            };
            (status_from(&state), delivery)
        };
        self.inner.wake.notify_all();
        emit_optional(delivery);
        Ok(status)
    }

    pub fn push_audio(
        &self,
        session_id: &str,
        start_ms: u64,
        bytes: &[u8],
    ) -> AppResult<AsrAudioPushResult> {
        validate_session_id(session_id)?;
        let samples = decode_pcm_i16le(bytes)?;

        let result = {
            let mut state = lock_state(&self.inner)?;
            let Some(active) = state.active_session.as_ref() else {
                return Ok(AsrAudioPushResult {
                    accepted: false,
                    dropped_chunks: 0,
                    queue_depth: 0,
                });
            };
            if active.id != session_id || state.model.is_none() || state.model_loading {
                return Ok(AsrAudioPushResult {
                    accepted: false,
                    dropped_chunks: 0,
                    queue_depth: state.queue.len(),
                });
            }

            let generation = active.generation;
            let dropped_chunks = push_bounded(
                &mut state.queue,
                AudioChunk {
                    session_id: session_id.to_owned(),
                    generation,
                    start_ms,
                    samples,
                },
                ASR_QUEUE_CAPACITY,
            );
            AsrAudioPushResult {
                accepted: true,
                dropped_chunks,
                queue_depth: state.queue.len(),
            }
        };
        self.inner.wake.notify_one();
        Ok(result)
    }

    /// Clears local live-caption state while the application is shutting down.
    /// There is intentionally no event emission here: the owning WebView may
    /// already be gone, and caption text must never be written to a fallback
    /// log sink.
    pub fn stop_all(&self) {
        if let Ok(mut state) = self.inner.state.lock() {
            state.queue.clear();
            state.active_session = None;
            state.session_generation = state.session_generation.saturating_add(1);
            state.shutting_down = true;
        }
        self.inner.wake.notify_all();
    }

    fn ensure_worker(&self) -> AppResult<()> {
        {
            let mut state = lock_state(&self.inner)?;
            if state.shutting_down {
                return Err(AppError::new(
                    "asr_worker_unavailable",
                    "本地字幕服务正在关闭",
                ));
            }
            if state.worker_started {
                return Ok(());
            }
            state.worker_started = true;
        }

        let inner = Arc::clone(&self.inner);
        if thread::Builder::new()
            .name("rlive-whisper-cpu".into())
            .spawn(move || worker_loop(inner))
            .is_err()
        {
            if let Ok(mut state) = self.inner.state.lock() {
                state.worker_started = false;
            }
            return Err(AppError::new(
                "asr_worker_start_failed",
                "无法启动本地字幕识别线程",
            ));
        }
        Ok(())
    }
}

/// Resolves the model packaged with rLive and verifies that the resource was
/// copied intact. This runs only when the user asks to load local captions;
/// the model is never mapped during application startup.
pub fn bundled_model_path(app: &AppHandle) -> AppResult<PathBuf> {
    let path = app
        .path()
        .resolve(BUNDLED_MODEL_RESOURCE_PATH, BaseDirectory::Resource)
        .map_err(|_| {
            AppError::new(
                "asr_default_model_unavailable",
                format!("内置 {BUNDLED_MODEL_NAME} 不可用，请重新安装 rLive"),
            )
        })?;
    let metadata = fs::metadata(&path).map_err(|_| {
        AppError::new(
            "asr_default_model_unavailable",
            format!("内置 {BUNDLED_MODEL_NAME} 不可用，请重新安装 rLive"),
        )
    })?;
    if !metadata.is_file() || metadata.len() != BUNDLED_MODEL_SIZE_BYTES {
        return Err(AppError::new(
            "asr_default_model_invalid",
            format!("内置 {BUNDLED_MODEL_NAME} 损坏，请重新安装 rLive"),
        ));
    }

    let mut file = fs::File::open(&path).map_err(|_| {
        AppError::new(
            "asr_default_model_unavailable",
            format!("内置 {BUNDLED_MODEL_NAME} 不可用，请重新安装 rLive"),
        )
    })?;
    let mut magic = [0; GGML_FILE_MAGIC_BYTES.len()];
    file.read_exact(&mut magic).map_err(|_| {
        AppError::new(
            "asr_default_model_invalid",
            format!("内置 {BUNDLED_MODEL_NAME} 损坏，请重新安装 rLive"),
        )
    })?;
    if magic != GGML_FILE_MAGIC_BYTES {
        return Err(AppError::new(
            "asr_default_model_invalid",
            format!("内置 {BUNDLED_MODEL_NAME} 格式不正确，请重新安装 rLive"),
        ));
    }

    let path_text = path.to_string_lossy();
    validate_model_path(&path_text).map_err(|_| {
        AppError::new(
            "asr_default_model_invalid",
            format!("内置 {BUNDLED_MODEL_NAME} 不可用，请重新安装 rLive"),
        )
    })
}

/// Validates the user-selected model path before handing it to native code.
/// The canonical path is kept only in memory and returned to the settings UI;
/// no model content or source audio is copied into application storage.
pub fn validate_model_path(path: &str) -> AppResult<PathBuf> {
    let path = path.trim();
    if path.is_empty() {
        return Err(AppError::new(
            "asr_model_path_empty",
            "请选择本地 Whisper 模型文件",
        ));
    }

    let canonical = fs::canonicalize(Path::new(path))
        .map_err(|_| AppError::new("asr_model_path_unavailable", "模型文件不存在或无法访问"))?;
    let metadata = fs::metadata(&canonical)
        .map_err(|_| AppError::new("asr_model_path_unavailable", "模型文件不存在或无法访问"))?;
    if !metadata.is_file() {
        return Err(AppError::new(
            "asr_model_not_file",
            "请选择模型文件，而不是文件夹",
        ));
    }
    if metadata.len() == 0 {
        return Err(AppError::new("asr_model_empty", "模型文件为空"));
    }
    let extension = canonical
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.to_ascii_lowercase());
    if !matches!(extension.as_deref(), Some("bin")) {
        return Err(AppError::new(
            "asr_model_extension",
            "请选择 .bin 格式的 Whisper GGML 模型",
        ));
    }
    Ok(canonical)
}

/// Creates the context with GPU explicitly disabled, even on a system where a
/// downstream whisper.cpp build happens to detect a GPU runtime.
pub fn load_cpu_model(path: &Path) -> AppResult<WhisperContext> {
    let mut parameters = WhisperContextParameters::default();
    parameters.use_gpu(false);
    // whisper-rs 0.11 accepts a UTF-8 path string. Lossy conversion preserves
    // Windows Unicode filenames for the native loader while avoiding a second
    // unsupported-path branch at the UI boundary.
    let model_path = path.to_string_lossy();
    WhisperContext::new_with_params(&model_path, parameters).map_err(|_| {
        AppError::new(
            "asr_model_load_failed",
            "无法加载该 Whisper 模型，请确认文件完整且与 whisper.cpp 兼容",
        )
    })
}

fn lock_state(inner: &AsrInner) -> AppResult<std::sync::MutexGuard<'_, AsrState>> {
    inner
        .state
        .lock()
        .map_err(|_| AppError::new("asr_state_unavailable", "本地字幕状态暂不可用"))
}

fn status_from(state: &AsrState) -> AsrModelStatus {
    AsrModelStatus {
        loaded: state.model.is_some(),
        loading: state.model_loading,
        bundled: state.model_is_bundled,
        path: state
            .model_path
            .as_ref()
            .map(|path| path.to_string_lossy().into_owned()),
        active_session_id: state
            .active_session
            .as_ref()
            .map(|active| active.id.clone()),
        queue_depth: state.queue.len(),
        queue_capacity: ASR_QUEUE_CAPACITY,
        sample_rate_hz: ASR_SAMPLE_RATE_HZ,
        backend: "whisper-rs",
        cpu_only: true,
    }
}

fn validate_session_id(session_id: &str) -> AppResult<()> {
    if session_id.trim().is_empty() || session_id.len() > MAX_SESSION_ID_BYTES {
        return Err(AppError::new("asr_invalid_session", "本地字幕播放会话无效"));
    }
    Ok(())
}

fn decode_pcm_i16le(bytes: &[u8]) -> AppResult<Vec<i16>> {
    if bytes.is_empty() {
        return Err(AppError::new("asr_audio_empty", "字幕音频数据为空"));
    }
    if bytes.len() > MAX_AUDIO_CHUNK_BYTES {
        return Err(AppError::new(
            "asr_audio_chunk_too_large",
            "字幕音频分段过大，请缩短采样批次",
        ));
    }
    if !bytes.len().is_multiple_of(2) {
        return Err(AppError::new(
            "asr_audio_alignment",
            "字幕音频不是有效的 16 位 PCM 数据",
        ));
    }
    Ok(bytes
        .chunks_exact(2)
        .map(|sample| i16::from_le_bytes([sample[0], sample[1]]))
        .collect())
}

fn push_bounded<T>(queue: &mut VecDeque<T>, item: T, capacity: usize) -> usize {
    let mut dropped = 0;
    while queue.len() >= capacity {
        queue.pop_front();
        dropped += 1;
    }
    queue.push_back(item);
    dropped
}

fn stop_active_session_locked(state: &mut AsrState, status: &'static str) -> Option<EventDelivery> {
    let mut active = state.active_session.take()?;
    Some(next_event(
        &mut active,
        "status",
        0,
        0,
        String::new(),
        Some(status),
    ))
}

fn next_event(
    active: &mut ActiveSession,
    kind: &'static str,
    start_ms: u64,
    end_ms: u64,
    text: String,
    status: Option<&str>,
) -> EventDelivery {
    active.next_sequence = active.next_sequence.saturating_add(1);
    EventDelivery {
        app: active.app.clone(),
        event: AsrCaptionEvent {
            session_id: active.id.clone(),
            sequence: active.next_sequence,
            kind,
            start_ms,
            end_ms,
            text,
            status: status.map(str::to_owned),
        },
    }
}

fn emit(delivery: EventDelivery) {
    // A window can disappear while a native inference completes. Event loss in
    // that case is expected; the session fence still prevents cross-room text.
    let _ = delivery.app.emit(CAPTION_EVENT_NAME, delivery.event);
}

fn emit_optional(delivery: Option<EventDelivery>) {
    if let Some(delivery) = delivery {
        emit(delivery);
    }
}

fn worker_loop(inner: Arc<AsrInner>) {
    let mut pending: Option<PendingAudio> = None;
    while let Some(chunk) = take_next_chunk(&inner) {
        let reset = pending.as_ref().is_none_or(|pending| {
            pending.session_id != chunk.session_id || pending.generation != chunk.generation
        });
        if reset {
            pending = Some(PendingAudio::from_chunk(chunk));
        } else if let Some(pending) = pending.as_mut() {
            pending.push(chunk);
        }

        let Some(pending_audio) = pending.as_mut() else {
            continue;
        };

        if !pending_audio.partial_emitted && pending_audio.samples.len() >= PARTIAL_WINDOW_SAMPLES {
            let start_ms = pending_audio.start_ms;
            let end_ms = start_ms.saturating_add(samples_to_ms(PARTIAL_WINDOW_SAMPLES));
            let samples = pending_audio.samples[..PARTIAL_WINDOW_SAMPLES].to_vec();
            pending_audio.partial_emitted = true;
            recognize_and_emit(
                &inner,
                &pending_audio.session_id,
                pending_audio.generation,
                "partial",
                start_ms,
                end_ms,
                samples,
            );
        }

        if pending_audio.samples.len() >= FINAL_WINDOW_SAMPLES {
            let start_ms = pending_audio.start_ms;
            let end_ms = start_ms.saturating_add(samples_to_ms(FINAL_WINDOW_SAMPLES));
            let samples: Vec<i16> = pending_audio
                .samples
                .drain(..FINAL_WINDOW_SAMPLES)
                .collect();
            pending_audio.start_ms = end_ms;
            pending_audio.partial_emitted = false;
            recognize_and_emit(
                &inner,
                &pending_audio.session_id,
                pending_audio.generation,
                "final",
                start_ms,
                end_ms,
                samples,
            );
        }
    }
}

fn take_next_chunk(inner: &AsrInner) -> Option<AudioChunk> {
    let mut state = match inner.state.lock() {
        Ok(state) => state,
        Err(_) => return None,
    };
    loop {
        if state.shutting_down {
            return None;
        }
        if let Some(chunk) = state.queue.pop_front() {
            return Some(chunk);
        }
        state = match inner.wake.wait(state) {
            Ok(state) => state,
            Err(_) => return None,
        };
    }
}

struct PendingAudio {
    session_id: String,
    generation: u64,
    start_ms: u64,
    samples: Vec<i16>,
    partial_emitted: bool,
}

impl PendingAudio {
    fn from_chunk(chunk: AudioChunk) -> Self {
        Self {
            session_id: chunk.session_id,
            generation: chunk.generation,
            start_ms: chunk.start_ms,
            samples: chunk.samples,
            partial_emitted: false,
        }
    }

    fn push(&mut self, chunk: AudioChunk) {
        // A sizeable timestamp gap means the bounded queue shed stale data or
        // the media element restarted. Restart the local window instead of
        // pretending unrelated audio is contiguous.
        let expected_start = self
            .start_ms
            .saturating_add(samples_to_ms(self.samples.len()));
        if chunk.start_ms > expected_start.saturating_add(500)
            || expected_start > chunk.start_ms.saturating_add(500)
        {
            *self = Self::from_chunk(chunk);
            return;
        }
        self.samples.extend(chunk.samples);
    }
}

fn recognize_and_emit(
    inner: &AsrInner,
    session_id: &str,
    generation: u64,
    kind: &'static str,
    start_ms: u64,
    end_ms: u64,
    samples: Vec<i16>,
) {
    let Some(model) = current_model_for_session(inner, session_id, generation) else {
        return;
    };
    match transcribe(&model, &samples) {
        Ok(text) if !text.is_empty() => {
            emit_caption_if_current(inner, session_id, generation, kind, start_ms, end_ms, text);
        }
        Ok(_) => {}
        // Keep native failures generic: error logging must never accidentally
        // retain recognized text or raw PCM in the desktop log.
        Err(()) => emit_status_if_current(inner, session_id, generation, "recognition_error"),
    }
}

fn current_model_for_session(
    inner: &AsrInner,
    session_id: &str,
    generation: u64,
) -> Option<Arc<WhisperContext>> {
    let state = inner.state.lock().ok()?;
    let active = state.active_session.as_ref()?;
    (active.id == session_id && active.generation == generation && !state.model_loading)
        .then(|| state.model.clone())
        .flatten()
}

fn transcribe(model: &WhisperContext, samples: &[i16]) -> Result<String, ()> {
    let audio: Vec<f32> = samples
        .iter()
        // Keep the signed PCM range inside [-1.0, 1.0); dividing by i16::MAX
        // would turn the minimum sample into a value smaller than -1.0.
        .map(|sample| f32::from(*sample) / 32_768.0)
        .collect();
    let mut state = model.create_state().map_err(|_| ())?;
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_n_threads(cpu_thread_count());
    params.set_language(CAPTION_LANGUAGE);
    params.set_detect_language(CAPTION_DETECTION_ONLY);
    params.set_no_context(true);
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    params.set_suppress_blank(true);
    params.set_suppress_non_speech_tokens(true);
    state.full(params, &audio).map_err(|_| ())?;

    let is_chinese = state
        .full_lang_id_from_state()
        .ok()
        .and_then(get_lang_str)
        .is_some_and(|language| language == "zh");

    let count = state.full_n_segments().map_err(|_| ())?;
    let mut text = String::new();
    for segment in 0..count {
        text.push_str(&state.full_get_segment_text(segment).map_err(|_| ())?);
    }
    let text = text.trim();
    Ok(if is_chinese {
        simplify_chinese_caption(text)
    } else {
        text.to_owned()
    })
}

/// Keep Chinese captions readable for the primary Chinese UI without touching
/// transcripts that Whisper identified as another language.
fn simplify_chinese_caption(text: &str) -> String {
    OpenCC::from_config(BuiltinConfig::T2s)
        .map(|converter| converter.convert(text))
        .unwrap_or_else(|_| text.to_owned())
}

fn cpu_thread_count() -> i32 {
    std::thread::available_parallelism()
        .map(|parallelism| parallelism.get().clamp(1, 4) as i32)
        .unwrap_or(2)
}

fn samples_to_ms(samples: usize) -> u64 {
    (samples as u64).saturating_mul(1_000) / u64::from(ASR_SAMPLE_RATE_HZ)
}

fn emit_caption_if_current(
    inner: &AsrInner,
    session_id: &str,
    generation: u64,
    kind: &'static str,
    start_ms: u64,
    end_ms: u64,
    text: String,
) {
    let delivery = {
        let Ok(mut state) = inner.state.lock() else {
            return;
        };
        let Some(active) = state.active_session.as_mut() else {
            return;
        };
        if active.id != session_id || active.generation != generation {
            return;
        }
        next_event(active, kind, start_ms, end_ms, text, None)
    };
    emit(delivery);
}

fn emit_status_if_current(
    inner: &AsrInner,
    session_id: &str,
    generation: u64,
    status: &'static str,
) {
    let delivery = {
        let Ok(mut state) = inner.state.lock() else {
            return;
        };
        let Some(active) = state.active_session.as_mut() else {
            return;
        };
        if active.id != session_id || active.generation != generation {
            return;
        }
        next_event(active, "status", 0, 0, String::new(), Some(status))
    };
    emit(delivery);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pcm_little_endian_decode_and_alignment_are_checked() {
        assert_eq!(
            decode_pcm_i16le(&[0, 0, 255, 127, 0, 128]).unwrap(),
            vec![0, 32767, -32768]
        );
        assert_eq!(decode_pcm_i16le(&[]).unwrap_err().code, "asr_audio_empty");
        assert_eq!(
            decode_pcm_i16le(&[0]).unwrap_err().code,
            "asr_audio_alignment"
        );
    }

    #[test]
    fn automatic_caption_language_is_not_detection_only() {
        // `None` keeps automatic language selection. Keeping the separate
        // detection-only flag false is what allows Whisper to emit subtitle
        // segments.
        assert_eq!(CAPTION_LANGUAGE, None);
        assert!(!CAPTION_DETECTION_ONLY);
    }

    #[test]
    fn chinese_caption_text_is_simplified() {
        assert_eq!(simplify_chinese_caption("繁體中文與我們"), "繁体中文与我们");
        assert_eq!(
            simplify_chinese_caption("Simplified English 123"),
            "Simplified English 123"
        );
    }

    #[test]
    fn bounded_queue_sheds_oldest_chunks() {
        let mut queue = VecDeque::new();
        assert_eq!(push_bounded(&mut queue, 1, 2), 0);
        assert_eq!(push_bounded(&mut queue, 2, 2), 0);
        assert_eq!(push_bounded(&mut queue, 3, 2), 1);
        assert_eq!(queue.into_iter().collect::<Vec<_>>(), vec![2, 3]);
    }

    #[test]
    fn model_path_must_be_a_nonempty_supported_file() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("rlive-asr-test-{}.bin", uuid::Uuid::new_v4()));
        fs::write(&path, b"not-a-real-model").unwrap();
        let validated = validate_model_path(path.to_str().unwrap()).unwrap();
        assert_eq!(validated, fs::canonicalize(&path).unwrap());
        fs::remove_file(&path).unwrap();

        let unsupported = dir.join(format!("rlive-asr-test-{}.txt", uuid::Uuid::new_v4()));
        fs::write(&unsupported, b"model").unwrap();
        assert_eq!(
            validate_model_path(unsupported.to_str().unwrap())
                .unwrap_err()
                .code,
            "asr_model_extension"
        );
        fs::remove_file(&unsupported).unwrap();

        let gguf = dir.join(format!("rlive-asr-test-{}.gguf", uuid::Uuid::new_v4()));
        fs::write(&gguf, b"model").unwrap();
        assert_eq!(
            validate_model_path(gguf.to_str().unwrap())
                .unwrap_err()
                .code,
            "asr_model_extension"
        );
        fs::remove_file(&gguf).unwrap();
    }

    #[test]
    fn bundled_model_is_present_and_uses_ggml() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join(BUNDLED_MODEL_RESOURCE_PATH);
        assert_eq!(fs::metadata(&path).unwrap().len(), BUNDLED_MODEL_SIZE_BYTES);

        let mut file = fs::File::open(path).unwrap();
        let mut magic = [0; GGML_FILE_MAGIC_BYTES.len()];
        file.read_exact(&mut magic).unwrap();
        assert_eq!(magic, GGML_FILE_MAGIC_BYTES);
    }

    #[test]
    fn bundled_model_loads_with_the_cpu_backend() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join(BUNDLED_MODEL_RESOURCE_PATH);
        load_cpu_model(&path).expect("the bundled GGML model must load with whisper-rs");
    }

    #[test]
    fn session_identifiers_are_bounded() {
        assert!(validate_session_id("room:1:playback").is_ok());
        assert!(validate_session_id("").is_err());
        assert!(validate_session_id(&"x".repeat(MAX_SESSION_ID_BYTES + 1)).is_err());
    }
}
