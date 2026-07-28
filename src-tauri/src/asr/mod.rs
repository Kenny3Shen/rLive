//! Local, CPU-first Whisper live-caption manager.
//!
//! This module intentionally has no network client and never persists raw
//! audio or recognized text. It owns one bounded ingress queue and one native
//! worker thread so Whisper inference cannot occupy Tauri's async runtime.

use std::collections::VecDeque;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;

use candle_core::{Device, IndexOp, Tensor};
use candle_transformers::{
    models::whisper::{self, audio},
    quantized_var_builder,
};
use ferrous_opencc::{OpenCC, config::BuiltinConfig};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, path::BaseDirectory};
#[cfg(target_os = "android")]
use tauri_plugin_fs::{FsExt, OpenOptions};
use tokenizers::Tokenizer;

use crate::error::{AppError, AppResult};

pub const ASR_SAMPLE_RATE_HZ: u32 = 16_000;
pub const BUNDLED_MODEL_NAME: &str = "Whisper tiny Q4_0（多语言）";
/// Candle-compatible GGUF weights from `lmz/candle-whisper`.
pub const BUNDLED_MODEL_RESOURCE_PATH: &str = "models/whisper-tiny/model-tiny-q40.gguf";
pub const BUNDLED_MODEL_SIZE_BYTES: u64 = 23_252_000;
pub const BUNDLED_CONFIG_RESOURCE_PATH: &str = "models/whisper-tiny/config-tiny.json";
pub const BUNDLED_CONFIG_SIZE_BYTES: u64 = 1_983;
pub const BUNDLED_TOKENIZER_RESOURCE_PATH: &str = "models/whisper-tiny/tokenizer-tiny.json";
pub const BUNDLED_TOKENIZER_SIZE_BYTES: u64 = 2_480_452;
/// The 80-bin Whisper mel filter bank used by Candle's audio preprocessor.
pub const BUNDLED_MEL_FILTERS_RESOURCE_PATH: &str = "models/whisper-tiny/melfilters.bytes";
pub const BUNDLED_MEL_FILTERS_SIZE_BYTES: u64 = 64_320;
/// Android packages bundled resources inside the APK. Candle's GGUF reader and
/// tokenizer need native filesystem paths, so resources are copied lazily to
/// the OS-managed cache and recreated if Android clears that cache.
#[cfg(target_os = "android")]
const ANDROID_BUNDLED_MODEL_CACHE_DIR: &str = "rlive-candle-whisper-v2";

/// The worklet normally submits 250–1000 ms chunks. Keeping only sixteen
/// chunks bounds latency and memory even when a CPU model cannot keep up.
const ASR_QUEUE_CAPACITY: usize = 16;
const MAX_AUDIO_CHUNK_BYTES: usize = ASR_SAMPLE_RATE_HZ as usize * 2 * 4;
const PARTIAL_WINDOW_SAMPLES: usize = ASR_SAMPLE_RATE_HZ as usize * 2;
const FINAL_WINDOW_SAMPLES: usize = ASR_SAMPLE_RATE_HZ as usize * 4;
const MAX_SESSION_ID_BYTES: usize = 160;
const CAPTION_EVENT_NAME: &str = "asr-caption";
/// A small energy gate prevents Whisper from decoding fully silent live
/// windows. It replaces the former native VAD sidecar while keeping the
/// model runtime entirely Rust.
const MIN_SPEECH_RMS: f32 = 0.008;
const GGUF_FILE_MAGIC_BYTES: [u8; 4] = *b"GGUF";
const MEL_FILTER_COEFFICIENTS: usize = 80 * (whisper::N_FFT / 2 + 1);

/// Whisper's multilingual language tokens. Candle exposes the decoder rather
/// than a high-level ASR helper, so language selection is done locally before
/// every caption window and remains independent of the renderer locale.
const WHISPER_LANGUAGE_CODES: [&str; 99] = [
    "en", "zh", "de", "es", "ru", "ko", "fr", "ja", "pt", "tr", "pl", "ca", "nl", "ar", "sv", "it",
    "id", "hi", "fi", "vi", "he", "uk", "el", "ms", "cs", "ro", "da", "hu", "ta", "no", "th", "ur",
    "hr", "bg", "lt", "la", "mi", "ml", "cy", "sk", "te", "fa", "lv", "bn", "sr", "az", "sl", "kn",
    "et", "mk", "br", "eu", "is", "hy", "ne", "mn", "bs", "kk", "sq", "sw", "gl", "mr", "pa", "si",
    "km", "sn", "yo", "so", "af", "oc", "ka", "be", "tg", "sd", "gu", "am", "yi", "lo", "uz", "fo",
    "ht", "ps", "tk", "nn", "mt", "sa", "lb", "my", "bo", "tl", "mg", "as", "tt", "haw", "ln",
    "ha", "ba", "jw", "su",
];

/// Resolved native paths for the complete Candle Whisper model pack.
#[derive(Debug, Clone)]
pub(crate) struct BundledModelPaths {
    weights: PathBuf,
    config: PathBuf,
    tokenizer: PathBuf,
    mel_filters: PathBuf,
}

impl BundledModelPaths {
    /// The primary model artifact is retained in status so Settings can show
    /// exactly which bundled pack is currently mapped without exposing the
    /// auxiliary tokenizer or filter-bank paths.
    pub(crate) fn weights_path(&self) -> PathBuf {
        self.weights.clone()
    }
}

#[derive(Clone, Copy)]
struct LanguageToken {
    code: &'static str,
    id: u32,
}

pub(crate) struct CandleWhisperModel {
    model: whisper::quantized_model::Whisper,
    tokenizer: Tokenizer,
    device: Device,
    mel_filters: Vec<f32>,
    suppress_tokens: Tensor,
    sot_token: u32,
    transcribe_token: u32,
    eot_token: u32,
    no_timestamps_token: u32,
    language_tokens: Vec<LanguageToken>,
}

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
    // Candle uses a small RMS speech gate in front of decoding. It avoids
    // spending a CPU window on silence without a native VAD sidecar, and is
    // enabled whenever a model is loaded.
    pub speech_gate_active: bool,
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
    // Candle's decoder owns a KV cache and therefore needs mutable access
    // during inference. The one native worker serializes decoding; the mutex
    // also keeps a stale worker from touching a model while it is replaced.
    model: Option<Arc<Mutex<CandleWhisperModel>>>,
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

    pub(crate) fn complete_model_load(
        &self,
        operation: u64,
        path: PathBuf,
        model: CandleWhisperModel,
        bundled: bool,
    ) -> AppResult<AsrModelStatus> {
        let mut state = lock_state(&self.inner)?;
        if state.model_operation != operation || !state.model_loading {
            return Err(AppError::new(
                "asr_model_load_superseded",
                "本地字幕模型加载已被新的操作取消",
            ));
        }
        state.model = Some(Arc::new(Mutex::new(model)));
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
                    "请先在设置－播放中加载本地字幕模型",
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
            .name("rlive-candle-cpu".into())
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

/// Resolves the complete Candle model pack and verifies all bundled files
/// before any weights are loaded. This runs only when the user enables local
/// captions; application startup never maps the model.
pub(crate) fn bundled_model_paths(app: &AppHandle) -> AppResult<BundledModelPaths> {
    let resolve = |resource_path| {
        bundled_resource_native_path(app, resource_path).map_err(|_| {
            AppError::new(
                "asr_default_model_unavailable",
                format!("内置 {BUNDLED_MODEL_NAME} 不可用，请重新安装 rLive"),
            )
        })
    };
    let paths = BundledModelPaths {
        weights: resolve(BUNDLED_MODEL_RESOURCE_PATH)?,
        config: resolve(BUNDLED_CONFIG_RESOURCE_PATH)?,
        tokenizer: resolve(BUNDLED_TOKENIZER_RESOURCE_PATH)?,
        mel_filters: resolve(BUNDLED_MEL_FILTERS_RESOURCE_PATH)?,
    };
    if !valid_gguf_file(&paths.weights, BUNDLED_MODEL_SIZE_BYTES)
        || !valid_resource_file(&paths.config, BUNDLED_CONFIG_SIZE_BYTES)
        || !valid_resource_file(&paths.tokenizer, BUNDLED_TOKENIZER_SIZE_BYTES)
        || !valid_resource_file(&paths.mel_filters, BUNDLED_MEL_FILTERS_SIZE_BYTES)
    {
        return Err(AppError::new(
            "asr_default_model_invalid",
            format!("内置 {BUNDLED_MODEL_NAME} 文件不完整，请重新安装 rLive"),
        ));
    }
    Ok(paths)
}

/// Resolves a bundled resource to a native filesystem path. Desktop resources
/// already have one; Android assets are copied atomically to app cache before
/// Candle opens them, so an interrupted copy cannot poison a later load.
fn bundled_resource_native_path(app: &AppHandle, resource_path: &str) -> AppResult<PathBuf> {
    #[cfg(not(target_os = "android"))]
    {
        app.path()
            .resolve(resource_path, BaseDirectory::Resource)
            .map_err(|_| AppError::new("asr_bundled_resource_unavailable", "内置模型资源不可用"))
    }

    #[cfg(target_os = "android")]
    {
        let asset_path = app
            .path()
            .resolve(resource_path, BaseDirectory::Resource)
            .map_err(|_| AppError::new("asr_bundled_resource_unavailable", "内置模型资源不可用"))?;
        let cache_path = app
            .path()
            .app_cache_dir()
            .map_err(|_| AppError::new("asr_bundled_resource_unavailable", "无法访问本地模型缓存"))?
            .join(ANDROID_BUNDLED_MODEL_CACHE_DIR)
            .join(resource_path);
        if valid_bundled_resource(&cache_path, resource_path) {
            return Ok(cache_path);
        }

        let parent = cache_path.parent().ok_or_else(|| {
            AppError::new("asr_bundled_resource_unavailable", "本地模型缓存路径无效")
        })?;
        fs::create_dir_all(parent).map_err(|_| {
            AppError::new("asr_bundled_resource_unavailable", "无法创建本地模型缓存")
        })?;
        let mut source = app.fs().open(asset_path, OpenOptions::new()).map_err(|_| {
            AppError::new("asr_bundled_resource_unavailable", "无法读取内置模型资源")
        })?;
        let temporary_path = cache_path.with_extension("part");
        let mut temporary = fs::File::create(&temporary_path).map_err(|_| {
            AppError::new("asr_bundled_resource_unavailable", "无法写入本地模型缓存")
        })?;
        std::io::copy(&mut source, &mut temporary).map_err(|_| {
            AppError::new("asr_bundled_resource_unavailable", "复制内置模型资源失败")
        })?;
        temporary.sync_all().map_err(|_| {
            AppError::new("asr_bundled_resource_unavailable", "无法完成本地模型缓存")
        })?;
        drop(temporary);

        if !valid_bundled_resource(&temporary_path, resource_path) {
            let _ = fs::remove_file(&temporary_path);
            return Err(AppError::new(
                "asr_bundled_resource_invalid",
                "内置模型资源损坏",
            ));
        }
        fs::rename(&temporary_path, &cache_path).map_err(|_| {
            AppError::new("asr_bundled_resource_unavailable", "无法启用本地模型缓存")
        })?;
        Ok(cache_path)
    }
}

#[cfg(target_os = "android")]
fn bundled_resource_size(resource_path: &str) -> Option<u64> {
    match resource_path {
        BUNDLED_MODEL_RESOURCE_PATH => Some(BUNDLED_MODEL_SIZE_BYTES),
        BUNDLED_CONFIG_RESOURCE_PATH => Some(BUNDLED_CONFIG_SIZE_BYTES),
        BUNDLED_TOKENIZER_RESOURCE_PATH => Some(BUNDLED_TOKENIZER_SIZE_BYTES),
        BUNDLED_MEL_FILTERS_RESOURCE_PATH => Some(BUNDLED_MEL_FILTERS_SIZE_BYTES),
        _ => None,
    }
}

#[cfg(target_os = "android")]
fn valid_bundled_resource(path: &Path, resource_path: &str) -> bool {
    let Some(expected_size) = bundled_resource_size(resource_path) else {
        return false;
    };
    if resource_path == BUNDLED_MODEL_RESOURCE_PATH {
        valid_gguf_file(path, expected_size)
    } else {
        valid_resource_file(path, expected_size)
    }
}

fn valid_resource_file(path: &Path, expected_size: u64) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    metadata.is_file() && metadata.len() == expected_size
}

fn valid_gguf_file(path: &Path, expected_size: u64) -> bool {
    if !valid_resource_file(path, expected_size) {
        return false;
    }
    let Ok(mut file) = fs::File::open(path) else {
        return false;
    };
    let mut magic = [0; GGUF_FILE_MAGIC_BYTES.len()];
    std::io::Read::read_exact(&mut file, &mut magic).is_ok() && magic == GGUF_FILE_MAGIC_BYTES
}

/// Loads the CPU-only Candle GGUF model and all local preprocessing assets.
/// No `whisper.cpp`, bindgen, Whisper FFI, GPU backend, or network client is
/// involved in this path.
pub(crate) fn load_cpu_model(paths: &BundledModelPaths) -> AppResult<CandleWhisperModel> {
    let config: whisper::Config = serde_json::from_str(
        &fs::read_to_string(&paths.config)
            .map_err(|_| AppError::new("asr_model_load_failed", "无法读取本地字幕模型配置"))?,
    )
    .map_err(|_| AppError::new("asr_model_load_failed", "本地字幕模型配置无效"))?;
    if config.num_mel_bins != 80 {
        return Err(AppError::new(
            "asr_model_load_failed",
            "内置字幕模型的 Mel 特征配置不受支持",
        ));
    }

    let tokenizer = Tokenizer::from_file(&paths.tokenizer)
        .map_err(|_| AppError::new("asr_model_load_failed", "本地字幕模型分词器无效"))?;
    let mel_filters = load_mel_filters(&paths.mel_filters)?;
    let device = Device::Cpu;
    let vb = quantized_var_builder::VarBuilder::from_gguf(&paths.weights, &device)
        .map_err(|_| AppError::new("asr_model_load_failed", "无法读取 Candle GGUF 字幕模型"))?;
    let model = whisper::quantized_model::Whisper::load(&vb, config.clone()).map_err(|_| {
        AppError::new(
            "asr_model_load_failed",
            "无法加载 Candle Whisper 字幕模型，请确认模型文件完整",
        )
    })?;

    let sot_token = required_token_id(&tokenizer, whisper::SOT_TOKEN)?;
    let transcribe_token = required_token_id(&tokenizer, whisper::TRANSCRIBE_TOKEN)?;
    let eot_token = required_token_id(&tokenizer, whisper::EOT_TOKEN)?;
    let no_timestamps_token = required_token_id(&tokenizer, whisper::NO_TIMESTAMPS_TOKEN)?;
    let language_tokens = WHISPER_LANGUAGE_CODES
        .iter()
        .filter_map(|code| {
            tokenizer
                .token_to_id(&format!("<|{code}|>"))
                .map(|id| LanguageToken { code, id })
        })
        .collect::<Vec<_>>();
    if language_tokens.is_empty() {
        return Err(AppError::new(
            "asr_model_load_failed",
            "本地字幕模型不包含多语言识别标记",
        ));
    }

    let mut suppressed = vec![0f32; config.vocab_size];
    for token in config.suppress_tokens {
        if let Some(value) = suppressed.get_mut(token as usize) {
            *value = f32::NEG_INFINITY;
        }
    }
    // Captions deliberately omit timestamp markers. Suppressing their range
    // avoids special-token output when a short live window is ambiguous.
    for value in suppressed.iter_mut().skip(no_timestamps_token as usize) {
        *value = f32::NEG_INFINITY;
    }
    let suppress_tokens = Tensor::from_vec(suppressed, config.vocab_size, &device)
        .map_err(|_| AppError::new("asr_model_load_failed", "无法初始化本地字幕解码器"))?;

    Ok(CandleWhisperModel {
        model,
        tokenizer,
        device,
        mel_filters,
        suppress_tokens,
        sot_token,
        transcribe_token,
        eot_token,
        no_timestamps_token,
        language_tokens,
    })
}

fn load_mel_filters(path: &Path) -> AppResult<Vec<f32>> {
    let bytes = fs::read(path)
        .map_err(|_| AppError::new("asr_model_load_failed", "无法读取本地字幕音频特征"))?;
    if bytes.len() != BUNDLED_MEL_FILTERS_SIZE_BYTES as usize
        || bytes.len() != MEL_FILTER_COEFFICIENTS * std::mem::size_of::<f32>()
    {
        return Err(AppError::new(
            "asr_model_load_failed",
            "本地字幕音频特征文件无效",
        ));
    }
    Ok(bytes
        .chunks_exact(std::mem::size_of::<f32>())
        .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
        .collect())
}

fn required_token_id(tokenizer: &Tokenizer, token: &str) -> AppResult<u32> {
    tokenizer
        .token_to_id(token)
        .ok_or_else(|| AppError::new("asr_model_load_failed", "本地字幕模型缺少必要的解码标记"))
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
        backend: "candle",
        cpu_only: true,
        // A lightweight local RMS gate skips completely silent live windows.
        // It has no native sidecar and is active whenever a model is loaded.
        speech_gate_active: state.model.is_some(),
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
        // Keep inference failures generic: error logging must never accidentally
        // retain recognized text or raw PCM in the desktop log.
        Err(()) => emit_status_if_current(inner, session_id, generation, "recognition_error"),
    }
}

/// Returns the shared Candle model for the still-current session, taking the
/// state lock only once so a model swap cannot hand a stale worker new weights.
fn current_model_for_session(
    inner: &AsrInner,
    session_id: &str,
    generation: u64,
) -> Option<Arc<Mutex<CandleWhisperModel>>> {
    let state = inner.state.lock().ok()?;
    let active = state.active_session.as_ref()?;
    if active.id != session_id || active.generation != generation || state.model_loading {
        return None;
    }
    state.model.clone()
}

fn transcribe(model: &Arc<Mutex<CandleWhisperModel>>, samples: &[i16]) -> Result<String, ()> {
    if !has_speech_energy(samples) {
        return Ok(String::new());
    }
    let mut model = model.lock().map_err(|_| ())?;
    model.transcribe(samples)
}

impl CandleWhisperModel {
    fn transcribe(&mut self, samples: &[i16]) -> Result<String, ()> {
        let audio: Vec<f32> = samples
            .iter()
            // Keep the signed PCM range inside [-1.0, 1.0); dividing by
            // i16::MAX would turn the minimum sample into a value below -1.
            .map(|sample| f32::from(*sample) / 32_768.0)
            .collect();
        let mel_values = audio::pcm_to_mel(&self.model.config, &audio, &self.mel_filters);
        let mel_frames = mel_values.len() / self.model.config.num_mel_bins;
        if mel_frames == 0 || mel_frames > self.model.config.max_source_positions * 2 {
            return Err(());
        }
        let mel = Tensor::from_vec(
            mel_values,
            (1, self.model.config.num_mel_bins, mel_frames),
            &self.device,
        )
        .map_err(|_| ())?;

        // A new caption window never inherits text or attention from a prior
        // room/window. Candle also flushes the decoder cache on its first pass.
        self.model.reset_kv_cache();
        let audio_features = self.model.encoder.forward(&mel, true).map_err(|_| ())?;
        let language = self.detect_language(&audio_features)?;
        let mut tokens = vec![self.sot_token];
        if let Some(language) = language {
            tokens.push(language.id);
        }
        tokens.push(self.transcribe_token);
        tokens.push(self.no_timestamps_token);

        let max_steps = self.model.config.max_target_positions / 2;
        for step in 0..max_steps {
            let tokens_t = Tensor::new(tokens.as_slice(), &self.device)
                .and_then(|tokens| tokens.unsqueeze(0))
                .map_err(|_| ())?;
            let hidden = self
                .model
                .decoder
                .forward(&tokens_t, &audio_features, step == 0)
                .map_err(|_| ())?;
            let (_, sequence_length, _) = hidden.dims3().map_err(|_| ())?;
            let logits = self
                .model
                .decoder
                .final_linear(&hidden.i((..1, sequence_length - 1..)).map_err(|_| ())?)
                .and_then(|logits| logits.i(0))
                .and_then(|logits| logits.i(0))
                .and_then(|logits| logits.broadcast_add(&self.suppress_tokens))
                .map_err(|_| ())?;
            let next_token = greedy_token(&logits)?;
            tokens.push(next_token);
            if next_token == self.eot_token
                || tokens.len() >= self.model.config.max_target_positions
            {
                break;
            }
        }

        let text = self.tokenizer.decode(&tokens, true).map_err(|_| ())?;
        let text = text.trim();
        Ok(if language.is_some_and(|language| language.code == "zh") {
            simplify_chinese_caption(text)
        } else {
            text.to_owned()
        })
    }

    fn detect_language(&mut self, audio_features: &Tensor) -> Result<Option<LanguageToken>, ()> {
        let tokens = Tensor::new(&[[self.sot_token]], &self.device).map_err(|_| ())?;
        let hidden = self
            .model
            .decoder
            .forward(&tokens, audio_features, true)
            .map_err(|_| ())?;
        let logits = self
            .model
            .decoder
            .final_linear(&hidden.i(..1).map_err(|_| ())?)
            .and_then(|logits| logits.i(0))
            .and_then(|logits| logits.i(0))
            .map_err(|_| ())?
            .to_vec1::<f32>()
            .map_err(|_| ())?;
        Ok(self
            .language_tokens
            .iter()
            .copied()
            .filter_map(|language| {
                logits
                    .get(language.id as usize)
                    .copied()
                    .map(|score| (language, score))
            })
            .max_by(|(_, left), (_, right)| left.total_cmp(right))
            .map(|(language, _)| language))
    }
}

fn greedy_token(logits: &Tensor) -> Result<u32, ()> {
    logits
        .to_vec1::<f32>()
        .map_err(|_| ())?
        .iter()
        .enumerate()
        .max_by(|(_, left), (_, right)| left.total_cmp(right))
        .map(|(index, _)| index as u32)
        .ok_or(())
}

fn has_speech_energy(samples: &[i16]) -> bool {
    if samples.is_empty() {
        return false;
    }
    let sum_squares = samples.iter().fold(0f64, |sum, sample| {
        let normalized = f64::from(*sample) / 32_768.0;
        sum + normalized * normalized
    });
    (sum_squares / samples.len() as f64).sqrt() >= f64::from(MIN_SPEECH_RMS)
}

/// Keep Chinese captions readable for the primary Chinese UI without touching
/// transcripts that Whisper identified as another language.
fn simplify_chinese_caption(text: &str) -> String {
    OpenCC::from_config(BuiltinConfig::T2s)
        .map(|converter| converter.convert(text))
        .unwrap_or_else(|_| text.to_owned())
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
    fn energy_gate_skips_silence_but_keeps_voice() {
        assert!(!has_speech_energy(&[0; ASR_SAMPLE_RATE_HZ as usize / 4]));
        assert!(has_speech_energy(&[1_024; ASR_SAMPLE_RATE_HZ as usize / 4]));
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
    fn bundled_model_pack_is_present_and_uses_gguf() {
        let resource_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources");
        let weights = resource_root.join(BUNDLED_MODEL_RESOURCE_PATH);
        assert!(valid_gguf_file(&weights, BUNDLED_MODEL_SIZE_BYTES));
        assert!(valid_resource_file(
            &resource_root.join(BUNDLED_CONFIG_RESOURCE_PATH),
            BUNDLED_CONFIG_SIZE_BYTES,
        ));
        assert!(valid_resource_file(
            &resource_root.join(BUNDLED_TOKENIZER_RESOURCE_PATH),
            BUNDLED_TOKENIZER_SIZE_BYTES,
        ));
        assert!(valid_resource_file(
            &resource_root.join(BUNDLED_MEL_FILTERS_RESOURCE_PATH),
            BUNDLED_MEL_FILTERS_SIZE_BYTES,
        ));
    }

    #[test]
    fn bundled_model_loads_with_the_cpu_backend() {
        let resource_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources");
        let paths = BundledModelPaths {
            weights: resource_root.join(BUNDLED_MODEL_RESOURCE_PATH),
            config: resource_root.join(BUNDLED_CONFIG_RESOURCE_PATH),
            tokenizer: resource_root.join(BUNDLED_TOKENIZER_RESOURCE_PATH),
            mel_filters: resource_root.join(BUNDLED_MEL_FILTERS_RESOURCE_PATH),
        };
        load_cpu_model(&paths).expect("the bundled GGUF model must load with Candle");
    }

    #[test]
    fn session_identifiers_are_bounded() {
        assert!(validate_session_id("room:1:playback").is_ok());
        assert!(validate_session_id("").is_err());
        assert!(validate_session_id(&"x".repeat(MAX_SESSION_ID_BYTES + 1)).is_err());
    }
}
