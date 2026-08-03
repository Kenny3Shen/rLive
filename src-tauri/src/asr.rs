//! Local Qwen3-ASR model lifecycle and transcription service.
//!
//! The model is deliberately neither downloaded nor loaded at application
//! startup. A user must opt in through Settings before `enable` starts its
//! background task. Audio is supplied by the web player as 16 kHz mono f32 PCM.

use std::ffi::{CStr, CString};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::Serialize;

use crate::error::{AppError, AppResult};

const MODEL_FILE_NAME: &str = "qwen3-asr-0.6b-q4_k.gguf";
const MODEL_URL: &str = "https://huggingface.co/cstr/qwen3-asr-0.6b-GGUF/resolve/58bd3202f835f46b24b17142cb503b0860c737a5/qwen3-asr-0.6b-q4_k.gguf?download=true";
// Published by the model repository. A complete-size check prevents a partial
// transfer from ever being loaded; the final rename makes replacement atomic.
const MODEL_SIZE_BYTES: u64 = 631_026_336;
const VAD_MODEL_FILE_NAME: &str = "ggml-silero-v6.2.0.bin";
const VAD_MODEL_URL: &str = "https://huggingface.co/ggml-org/whisper-vad/resolve/9ffd54a1e1ee413ddf265af9913beaf518d1639b/ggml-silero-v6.2.0.bin?download=true";
const VAD_MODEL_SIZE_BYTES: u64 = 885_098;
const ASR_SAMPLE_RATE: i32 = 16_000;
// Live captions do not need the 512-token offline default. Keeping a bounded
// decode budget prevents a pathological segment from monopolizing the single
// session and lets the bounded latest-window queue preserve live playback.
const LIVE_MAX_NEW_TOKENS: i32 = 256;
const MAX_PCM_BYTES: usize = 2 * 1024 * 1024;
const MAX_BASE64_PCM_BYTES: usize = ((MAX_PCM_BYTES + 2) / 3) * 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AsrModelState {
    NotDownloaded,
    Downloaded,
    Downloading,
    DownloadingVad,
    Loading,
    Ready,
    Error,
}

#[derive(Debug, Clone, Serialize)]
pub struct AsrModelStatus {
    pub state: AsrModelState,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub model_size_bytes: u64,
    pub vad_model_size_bytes: u64,
    pub vad_enabled: bool,
    pub vad_model_downloaded: bool,
    pub threads: i32,
    pub message: Option<String>,
}

impl AsrModelStatus {
    fn new(state: AsrModelState) -> Self {
        Self {
            state,
            downloaded_bytes: 0,
            total_bytes: Some(MODEL_SIZE_BYTES),
            model_size_bytes: MODEL_SIZE_BYTES,
            vad_model_size_bytes: VAD_MODEL_SIZE_BYTES,
            vad_enabled: false,
            vad_model_downloaded: false,
            threads: asr_thread_count(),
            message: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct AsrCaptionSegment {
    pub text: String,
    pub start_ms: u64,
    pub end_ms: u64,
}

/// Minimal owner around CrispASR's CPU session C ABI.
struct NativeAsrSession {
    handle: *mut crispasr_sys::CrispasrSession,
}

unsafe impl Send for NativeAsrSession {}

impl NativeAsrSession {
    fn open(model_path: &Path, threads: i32) -> Result<Self, String> {
        let path = CString::new(model_path.to_string_lossy().as_bytes())
            .map_err(|error| format!("invalid model path: {error}"))?;
        let handle = unsafe { crispasr_sys::crispasr_session_open(path.as_ptr(), threads) };
        if handle.is_null() {
            return Err("CrispASR could not open Qwen3-ASR CPU session".into());
        }
        let max_tokens_rc = unsafe {
            crispasr_sys::crispasr_session_set_max_new_tokens(handle, LIVE_MAX_NEW_TOKENS)
        };
        if max_tokens_rc != 0 {
            unsafe { crispasr_sys::crispasr_session_close(handle) };
            return Err(format!(
                "CrispASR could not configure live decode budget (rc={max_tokens_rc})"
            ));
        }
        Ok(Self { handle })
    }

    fn transcribe(
        &self,
        pcm: &[f32],
        vad_model_path: Option<&Path>,
        vad_threads: i32,
    ) -> Result<Vec<AsrCaptionSegment>, String> {
        let n_samples = i32::try_from(pcm.len()).map_err(|_| "PCM segment is too large")?;
        let result = if let Some(vad_model_path) = vad_model_path {
            let vad_path = CString::new(vad_model_path.to_string_lossy().as_bytes())
                .map_err(|error| format!("invalid VAD model path: {error}"))?;
            // Scale VAD thresholds with the live window so future shorter
            // windows cannot silently inherit an overly large minimum.
            let window_ms = ((n_samples as i64 * 1_000) / ASR_SAMPLE_RATE as i64)
                .clamp(1, i32::MAX as i64) as i32;
            let opts = crispasr_sys::CrispasrVadAbiOpts {
                threshold: 0.5,
                min_speech_duration_ms: (window_ms / 2).clamp(80, 250),
                min_silence_duration_ms: (window_ms / 4).clamp(50, 100),
                speech_pad_ms: 30,
                chunk_seconds: 30,
                n_threads: vad_threads,
            };
            let mut spans = std::ptr::null_mut();
            let slice_count = unsafe {
                crispasr_sys::crispasr_vad_slices(
                    vad_path.as_ptr(),
                    pcm.as_ptr(),
                    n_samples,
                    ASR_SAMPLE_RATE,
                    opts.threshold,
                    opts.min_speech_duration_ms,
                    opts.min_silence_duration_ms,
                    opts.speech_pad_ms,
                    opts.chunk_seconds as f32,
                    opts.n_threads,
                    &mut spans,
                )
            };
            if !spans.is_null() {
                unsafe { crispasr_sys::crispasr_vad_free(spans) };
            }
            if slice_count < 0 {
                return Err(format!("CrispASR VAD failed with code {slice_count}"));
            }
            // The session helper falls back to plain ASR for an empty slice
            // list. Preflight explicitly so silent live chunks skip Qwen3.
            if slice_count == 0 {
                return Ok(Vec::new());
            }
            unsafe {
                crispasr_sys::crispasr_session_transcribe_vad(
                    self.handle,
                    pcm.as_ptr(),
                    n_samples,
                    ASR_SAMPLE_RATE,
                    vad_path.as_ptr(),
                    &opts,
                )
            }
        } else {
            unsafe {
                crispasr_sys::crispasr_session_transcribe(self.handle, pcm.as_ptr(), n_samples)
            }
        };
        if result.is_null() {
            return Err("CrispASR transcription returned no result".into());
        }
        struct ResultGuard(*mut crispasr_sys::CrispasrSessionResult);
        impl Drop for ResultGuard {
            fn drop(&mut self) {
                unsafe { crispasr_sys::crispasr_session_result_free(self.0) };
            }
        }
        let result = ResultGuard(result);
        let count = unsafe { crispasr_sys::crispasr_session_result_n_segments(result.0) }.max(0);
        let mut segments = Vec::with_capacity(count as usize);
        for index in 0..count {
            let text_ptr =
                unsafe { crispasr_sys::crispasr_session_result_segment_text(result.0, index) };
            if text_ptr.is_null() {
                continue;
            }
            let text = unsafe { CStr::from_ptr(text_ptr) }
                .to_string_lossy()
                .trim()
                .to_owned();
            if text.is_empty() {
                continue;
            }
            let start_cs =
                unsafe { crispasr_sys::crispasr_session_result_segment_t0(result.0, index) };
            let end_cs =
                unsafe { crispasr_sys::crispasr_session_result_segment_t1(result.0, index) };
            segments.push(AsrCaptionSegment {
                text,
                start_ms: centiseconds_to_millis(start_cs),
                end_ms: centiseconds_to_millis(end_cs),
            });
        }
        Ok(segments)
    }
}

impl Drop for NativeAsrSession {
    fn drop(&mut self) {
        unsafe { crispasr_sys::crispasr_session_close(self.handle) };
    }
}

#[derive(Clone)]
pub struct AsrManager {
    inner: Arc<AsrInner>,
}

struct AsrInner {
    model_path: PathBuf,
    vad_model_path: PathBuf,
    status: Mutex<AsrModelStatus>,
    requested: std::sync::atomic::AtomicBool,
    request_generation: std::sync::atomic::AtomicU64,
    control: Mutex<()>,
    prepare_lock: tokio::sync::Mutex<()>,
    session: Mutex<Option<NativeAsrSession>>,
}

impl AsrManager {
    pub fn new(app_data_dir: Option<&Path>) -> Self {
        let model_dir = model_directory(app_data_dir);
        let model_path = model_dir.join(MODEL_FILE_NAME);
        let vad_model_path = model_dir.join(VAD_MODEL_FILE_NAME);
        let vad_model_downloaded = vad_model_file_is_complete(&vad_model_path);

        let status = if model_file_is_complete(&model_path) {
            AsrModelStatus {
                state: AsrModelState::Downloaded,
                downloaded_bytes: MODEL_SIZE_BYTES,
                total_bytes: Some(MODEL_SIZE_BYTES),
                model_size_bytes: MODEL_SIZE_BYTES,
                vad_model_size_bytes: VAD_MODEL_SIZE_BYTES,
                vad_enabled: false,
                vad_model_downloaded,
                threads: asr_thread_count(),
                message: None,
            }
        } else {
            let mut status = AsrModelStatus::new(AsrModelState::NotDownloaded);
            status.vad_model_downloaded = vad_model_downloaded;
            status
        };

        Self {
            inner: Arc::new(AsrInner {
                model_path,
                vad_model_path,
                status: Mutex::new(status),
                requested: std::sync::atomic::AtomicBool::new(false),
                request_generation: std::sync::atomic::AtomicU64::new(0),
                control: Mutex::new(()),
                prepare_lock: tokio::sync::Mutex::new(()),
                session: Mutex::new(None),
            }),
        }
    }

    pub fn status(&self) -> AppResult<AsrModelStatus> {
        self.inner
            .status
            .lock()
            .map(|status| status.clone())
            .map_err(|_| AppError::new("asr_status_lock", "语音字幕状态暂不可用"))
    }

    pub fn enable(&self, proxy: Option<String>, vad_enabled: bool) -> AppResult<AsrModelStatus> {
        use std::sync::atomic::Ordering;

        let _control = self
            .inner
            .control
            .lock()
            .map_err(|_| AppError::new("asr_control_lock", "语音字幕状态暂不可用"))?;
        let was_requested = self.inner.requested.swap(true, Ordering::AcqRel);
        let model_exists = model_file_is_complete(&self.inner.model_path);
        let vad_model_exists = vad_model_file_is_complete(&self.inner.vad_model_path);
        let next_state = if model_exists {
            if vad_enabled && !vad_model_exists {
                AsrModelState::DownloadingVad
            } else {
                AsrModelState::Loading
            }
        } else {
            AsrModelState::Downloading
        };

        let generation = {
            let mut status = self
                .inner
                .status
                .lock()
                .map_err(|_| AppError::new("asr_status_lock", "语音字幕状态暂不可用"))?;

            let same_vad = status.vad_enabled == vad_enabled;
            if was_requested && same_vad && status.state == AsrModelState::Ready {
                return Ok(status.clone());
            }
            if was_requested
                && same_vad
                && matches!(
                    status.state,
                    AsrModelState::Downloading
                        | AsrModelState::DownloadingVad
                        | AsrModelState::Loading
                )
            {
                return Ok(status.clone());
            }

            let generation = self
                .inner
                .request_generation
                .fetch_add(1, Ordering::AcqRel)
                .wrapping_add(1);
            status.state = next_state;
            status.downloaded_bytes = if next_state == AsrModelState::Loading {
                MODEL_SIZE_BYTES
            } else {
                0
            };
            status.total_bytes = Some(if next_state == AsrModelState::DownloadingVad {
                VAD_MODEL_SIZE_BYTES
            } else {
                MODEL_SIZE_BYTES
            });
            status.vad_enabled = vad_enabled;
            status.vad_model_downloaded = vad_model_exists;
            status.threads = asr_thread_count();
            status.message = None;
            generation
        };

        let manager = self.clone();
        tauri::async_runtime::spawn(async move {
            manager.prepare_model(proxy, vad_enabled, generation).await;
        });

        self.status()
    }

    pub async fn disable(&self) -> AppResult<AsrModelStatus> {
        use std::sync::atomic::Ordering;

        let generation = {
            let _control = self
                .inner
                .control
                .lock()
                .map_err(|_| AppError::new("asr_control_lock", "语音字幕状态暂不可用"))?;
            self.inner.requested.store(false, Ordering::Release);
            self.inner
                .request_generation
                .fetch_add(1, Ordering::AcqRel)
                .wrapping_add(1)
        };
        let manager = self.clone();
        tokio::task::spawn_blocking(move || {
            let mut session = manager
                .inner
                .session
                .lock()
                .map_err(|_| AppError::new("asr_session_lock", "语音字幕模型暂不可用"))?;
            // Dropping the session releases the model's resident memory while
            // leaving a verified on-disk model available for the next enable.
            *session = None;
            Ok::<(), AppError>(())
        })
        .await
        .map_err(|_| AppError::new("asr_task_failed", "停止语音字幕失败"))??;

        let _control = self
            .inner
            .control
            .lock()
            .map_err(|_| AppError::new("asr_control_lock", "语音字幕状态暂不可用"))?;
        if self.generation_is_current(generation) && !self.is_requested() {
            self.set_idle_status();
        }
        self.status()
    }

    async fn prepare_model(&self, proxy: Option<String>, vad_enabled: bool, generation: u64) {
        let _prepare = self.inner.prepare_lock.lock().await;
        if !self.request_is_current(generation) {
            return;
        }

        let model_ready = match self.ensure_model_file(proxy.as_deref(), generation).await {
            Ok(ready) => ready,
            Err(error) => {
                tracing::warn!(error = %error, "ASR model download failed");
                self.set_error_status_for_request(generation, "模型下载失败，请检查网络后重试");
                return;
            }
        };
        if !model_ready || !self.request_is_current(generation) {
            return;
        }
        if vad_enabled {
            let vad_ready = match self
                .ensure_vad_model_file(proxy.as_deref(), generation)
                .await
            {
                Ok(ready) => ready,
                Err(error) => {
                    tracing::warn!(error = %error, "VAD model download failed");
                    self.set_error_status_for_request(
                        generation,
                        "VAD 模型下载失败，请检查网络后重试",
                    );
                    return;
                }
            };
            if !vad_ready || !self.request_is_current(generation) {
                return;
            }
        }

        self.set_loading_status(generation);
        let model_path = self.inner.model_path.clone();
        let threads = asr_thread_count();
        let manager = self.clone();
        let load_result = tokio::task::spawn_blocking(move || {
            let mut guard = manager
                .inner
                .session
                .lock()
                .map_err(|_| "ASR session lock is unavailable".to_string())?;
            if guard.as_ref().is_some() {
                return Ok(None);
            }
            let previous = guard.take();
            drop(guard);
            drop(previous);
            NativeAsrSession::open(&model_path, threads).map(Some)
        })
        .await;

        let session = match load_result {
            Ok(Ok(session)) => session,
            Ok(Err(error)) => {
                tracing::warn!(%error, "ASR model load failed");
                self.set_error_status_for_request(generation, "模型加载失败，请重新启用后重试");
                return;
            }
            Err(error) => {
                tracing::warn!(%error, "ASR model load task failed");
                self.set_error_status_for_request(generation, "模型加载任务失败，请重新启用后重试");
                return;
            }
        };

        if !self.request_is_current(generation) {
            drop(session);
            return;
        }

        if let Some(session) = session {
            let Ok(mut guard) = self.inner.session.lock() else {
                tracing::warn!("ASR session mutex poisoned while loading model");
                self.set_error_status_for_request(generation, "模型状态暂不可用，请重新启用后重试");
                return;
            };
            if !self.request_is_current(generation) {
                drop(guard);
                drop(session);
                return;
            }
            *guard = Some(session);
        }

        self.update_status_for_request(generation, |status| {
            status.state = AsrModelState::Ready;
            status.downloaded_bytes = MODEL_SIZE_BYTES;
            status.total_bytes = Some(MODEL_SIZE_BYTES);
            status.vad_enabled = vad_enabled;
            status.vad_model_downloaded = vad_model_file_is_complete(&self.inner.vad_model_path);
            status.message = None;
        });
    }

    async fn ensure_model_file(&self, proxy: Option<&str>, generation: u64) -> AppResult<bool> {
        if !self.request_is_current(generation) {
            return Ok(false);
        }
        if model_file_is_complete(&self.inner.model_path) {
            return Ok(true);
        }

        let model_dir = self
            .inner
            .model_path
            .parent()
            .ok_or_else(|| AppError::new("asr_model_path", "模型目录无效"))?;
        tokio::fs::create_dir_all(model_dir)
            .await
            .map_err(|_| AppError::new("asr_model_dir", "无法创建模型目录"))?;

        let partial_path = self.inner.model_path.with_extension("gguf.part");
        remove_file_if_present(&partial_path).await?;
        // Atomic replacement only works on Windows when the target does not
        // already exist. A mismatched final file is never a usable model.
        remove_incomplete_model_file(&self.inner.model_path).await?;

        let result = self
            .download_model_file(proxy, &partial_path, generation)
            .await;
        if result.is_err() {
            if let Err(error) = remove_file_if_present(&partial_path).await {
                tracing::warn!(%error, "failed to clean up ASR partial model");
            }
        }
        result
    }

    async fn ensure_vad_model_file(&self, proxy: Option<&str>, generation: u64) -> AppResult<bool> {
        if !self.request_is_current(generation) {
            return Ok(false);
        }
        if vad_model_file_is_complete(&self.inner.vad_model_path) {
            return Ok(true);
        }

        let model_dir = self
            .inner
            .vad_model_path
            .parent()
            .ok_or_else(|| AppError::new("asr_vad_model_path", "VAD 模型目录无效"))?;
        tokio::fs::create_dir_all(model_dir)
            .await
            .map_err(|_| AppError::new("asr_model_dir", "无法创建模型目录"))?;

        let partial_path = self.inner.vad_model_path.with_extension("bin.part");
        remove_file_if_present(&partial_path).await?;
        remove_incomplete_file(&self.inner.vad_model_path, VAD_MODEL_SIZE_BYTES).await?;

        self.update_status_for_request(generation, |status| {
            status.state = AsrModelState::DownloadingVad;
            status.downloaded_bytes = 0;
            status.total_bytes = Some(VAD_MODEL_SIZE_BYTES);
            status.message = None;
        });

        let result = self
            .download_vad_model_file(proxy, &partial_path, generation)
            .await;
        if result.is_err() {
            if let Err(error) = remove_file_if_present(&partial_path).await {
                tracing::warn!(%error, "failed to clean up partial VAD model");
            }
        }
        result
    }

    async fn download_model_file(
        &self,
        proxy: Option<&str>,
        partial_path: &Path,
        generation: u64,
    ) -> AppResult<bool> {
        if !self.request_is_current(generation) {
            return Ok(false);
        }

        let client = asr_download_client(proxy)?;
        let response = client
            .get(MODEL_URL)
            .send()
            .await
            .map_err(|_| AppError::new("asr_model_download", "模型下载请求失败"))?
            .error_for_status()
            .map_err(|_| AppError::new("asr_model_download", "模型下载服务返回错误"))?;

        if let Some(length) = response.content_length() {
            if length != MODEL_SIZE_BYTES {
                return Err(AppError::new("asr_model_size", "模型文件大小与预期不符"));
            }
        }

        use futures_util::StreamExt;
        use tokio::io::AsyncWriteExt;

        let mut stream = response.bytes_stream();
        let mut file = tokio::fs::File::create(&partial_path)
            .await
            .map_err(|_| AppError::new("asr_model_write", "无法写入模型临时文件"))?;
        let mut downloaded = 0_u64;
        let mut last_progress = std::time::Instant::now() - std::time::Duration::from_secs(1);

        while let Some(chunk) = stream.next().await {
            if !self.request_is_current(generation) {
                drop(file);
                let _ = tokio::fs::remove_file(&partial_path).await;
                return Ok(false);
            }
            let chunk = chunk.map_err(|_| AppError::new("asr_model_download", "模型下载中断"))?;
            downloaded = downloaded.saturating_add(chunk.len() as u64);
            if downloaded > MODEL_SIZE_BYTES {
                drop(file);
                let _ = tokio::fs::remove_file(&partial_path).await;
                return Err(AppError::new("asr_model_size", "模型文件大小超出预期"));
            }
            file.write_all(&chunk)
                .await
                .map_err(|_| AppError::new("asr_model_write", "写入模型文件失败"))?;

            if downloaded == MODEL_SIZE_BYTES
                || last_progress.elapsed() >= std::time::Duration::from_millis(250)
            {
                last_progress = std::time::Instant::now();
                self.update_status_for_request(generation, |status| {
                    status.state = AsrModelState::Downloading;
                    status.downloaded_bytes = downloaded;
                    status.total_bytes = Some(MODEL_SIZE_BYTES);
                    status.message = None;
                });
            }
        }

        file.flush()
            .await
            .map_err(|_| AppError::new("asr_model_write", "保存模型文件失败"))?;
        drop(file);

        if downloaded != MODEL_SIZE_BYTES {
            return Err(AppError::new("asr_model_size", "模型下载不完整"));
        }
        if !self.request_is_current(generation) {
            let _ = tokio::fs::remove_file(&partial_path).await;
            return Ok(false);
        }

        tokio::fs::rename(&partial_path, &self.inner.model_path)
            .await
            .map_err(|_| AppError::new("asr_model_write", "模型文件替换失败"))?;
        Ok(true)
    }

    async fn download_vad_model_file(
        &self,
        proxy: Option<&str>,
        partial_path: &Path,
        generation: u64,
    ) -> AppResult<bool> {
        if !self.request_is_current(generation) {
            return Ok(false);
        }

        let response = asr_download_client(proxy)?
            .get(VAD_MODEL_URL)
            .send()
            .await
            .map_err(|_| AppError::new("asr_vad_download", "VAD 模型下载请求失败"))?
            .error_for_status()
            .map_err(|_| AppError::new("asr_vad_download", "VAD 模型下载服务返回错误"))?;
        if response
            .content_length()
            .is_some_and(|length| length != VAD_MODEL_SIZE_BYTES)
        {
            return Err(AppError::new(
                "asr_vad_model_size",
                "VAD 模型文件大小与预期不符",
            ));
        }

        use futures_util::StreamExt;
        use tokio::io::AsyncWriteExt;

        let mut stream = response.bytes_stream();
        let mut file = tokio::fs::File::create(partial_path)
            .await
            .map_err(|_| AppError::new("asr_vad_model_write", "无法写入 VAD 模型临时文件"))?;
        let mut downloaded = 0_u64;

        while let Some(chunk) = stream.next().await {
            if !self.request_is_current(generation) {
                drop(file);
                let _ = tokio::fs::remove_file(partial_path).await;
                return Ok(false);
            }
            let chunk = chunk.map_err(|_| AppError::new("asr_vad_download", "VAD 模型下载中断"))?;
            downloaded = downloaded.saturating_add(chunk.len() as u64);
            if downloaded > VAD_MODEL_SIZE_BYTES {
                drop(file);
                let _ = tokio::fs::remove_file(partial_path).await;
                return Err(AppError::new(
                    "asr_vad_model_size",
                    "VAD 模型文件大小超出预期",
                ));
            }
            file.write_all(&chunk)
                .await
                .map_err(|_| AppError::new("asr_vad_model_write", "写入 VAD 模型失败"))?;
            self.update_status_for_request(generation, |status| {
                status.state = AsrModelState::DownloadingVad;
                status.downloaded_bytes = downloaded;
                status.total_bytes = Some(VAD_MODEL_SIZE_BYTES);
                status.message = None;
            });
        }

        file.flush()
            .await
            .map_err(|_| AppError::new("asr_vad_model_write", "保存 VAD 模型失败"))?;
        drop(file);
        if downloaded != VAD_MODEL_SIZE_BYTES {
            return Err(AppError::new("asr_vad_model_size", "VAD 模型下载不完整"));
        }
        if !self.request_is_current(generation) {
            let _ = tokio::fs::remove_file(partial_path).await;
            return Ok(false);
        }

        tokio::fs::rename(partial_path, &self.inner.vad_model_path)
            .await
            .map_err(|_| AppError::new("asr_vad_model_write", "VAD 模型文件替换失败"))?;
        self.update_status_for_request(generation, |status| {
            status.vad_model_downloaded = true;
        });
        Ok(true)
    }

    pub async fn transcribe_pcm(&self, pcm: Vec<f32>) -> AppResult<Vec<AsrCaptionSegment>> {
        if pcm.is_empty() {
            return Ok(Vec::new());
        }
        let manager = self.clone();
        tokio::task::spawn_blocking(move || manager.transcribe_pcm_blocking(&pcm))
            .await
            .map_err(|_| AppError::new("asr_task_failed", "语音识别任务失败"))?
    }

    fn transcribe_pcm_blocking(&self, pcm: &[f32]) -> AppResult<Vec<AsrCaptionSegment>> {
        if !self.is_requested() {
            return Err(AppError::new("asr_disabled", "语音字幕未启用"));
        }
        let (vad_enabled, vad_threads) = {
            let status = self
                .inner
                .status
                .lock()
                .map_err(|_| AppError::new("asr_status_lock", "语音字幕状态暂不可用"))?;
            if status.state != AsrModelState::Ready {
                return Err(AppError::new("asr_not_ready", "语音字幕模型正在准备"));
            }
            (status.vad_enabled, status.threads.max(1))
        };
        let session = self
            .inner
            .session
            .lock()
            .map_err(|_| AppError::new("asr_session_lock", "语音字幕模型暂不可用"))?;
        let session = session
            .as_ref()
            .ok_or_else(|| AppError::new("asr_not_ready", "语音字幕模型正在准备"))?;
        let vad_model_path = vad_enabled.then_some(self.inner.vad_model_path.as_path());
        let segments = session
            .transcribe(pcm, vad_model_path, vad_threads)
            .map_err(|error| {
                tracing::warn!(%error, "ASR transcription failed");
                AppError::new("asr_transcribe_failed", "语音识别失败，请稍后重试")
            })?;

        if !self.is_requested() {
            return Err(AppError::new("asr_disabled", "语音字幕已关闭"));
        }

        Ok(segments)
    }

    fn is_requested(&self) -> bool {
        self.inner
            .requested
            .load(std::sync::atomic::Ordering::Acquire)
    }

    fn generation_is_current(&self, generation: u64) -> bool {
        self.inner
            .request_generation
            .load(std::sync::atomic::Ordering::Acquire)
            == generation
    }

    fn request_is_current(&self, generation: u64) -> bool {
        self.is_requested() && self.generation_is_current(generation)
    }

    fn set_loading_status(&self, generation: u64) {
        self.update_status_for_request(generation, |status| {
            status.state = AsrModelState::Loading;
            status.downloaded_bytes = MODEL_SIZE_BYTES;
            status.total_bytes = Some(MODEL_SIZE_BYTES);
            status.message = None;
        });
    }

    fn set_idle_status(&self) {
        let model_exists = model_file_is_complete(&self.inner.model_path);
        let vad_model_exists = vad_model_file_is_complete(&self.inner.vad_model_path);
        self.update_status(|status| {
            status.state = if model_exists {
                AsrModelState::Downloaded
            } else {
                AsrModelState::NotDownloaded
            };
            status.downloaded_bytes = if model_exists { MODEL_SIZE_BYTES } else { 0 };
            status.total_bytes = Some(MODEL_SIZE_BYTES);
            status.vad_model_downloaded = vad_model_exists;
            status.message = None;
        });
    }

    fn set_error_status_for_request(&self, generation: u64, message: &str) {
        self.update_status_for_request(generation, |status| {
            status.state = AsrModelState::Error;
            status.message = Some(message.to_owned());
        });
    }

    fn update_status_for_request(&self, generation: u64, update: impl FnOnce(&mut AsrModelStatus)) {
        if !self.request_is_current(generation) {
            return;
        }
        let Ok(mut status) = self.inner.status.lock() else {
            return;
        };
        if self.request_is_current(generation) {
            update(&mut status);
        }
    }

    fn update_status(&self, update: impl FnOnce(&mut AsrModelStatus)) {
        if let Ok(mut status) = self.inner.status.lock() {
            update(&mut status);
        }
    }
}

/// Decode bounded little-endian f32 PCM transported over Tauri IPC.
pub fn decode_base64_pcm(encoded: &str) -> AppResult<Vec<f32>> {
    use base64::Engine;

    if encoded.is_empty() || encoded.len() > MAX_BASE64_PCM_BYTES {
        return Err(AppError::new("asr_pcm_too_large", "音频片段大小无效"));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| AppError::new("asr_pcm_decode", "音频片段编码无效"))?;
    if bytes.is_empty()
        || bytes.len() > MAX_PCM_BYTES
        || bytes.len() % std::mem::size_of::<f32>() != 0
    {
        return Err(AppError::new("asr_pcm_decode", "音频片段格式无效"));
    }

    let pcm: Vec<f32> = bytes
        .chunks_exact(std::mem::size_of::<f32>())
        .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
        .collect();
    if pcm.iter().any(|sample| !sample.is_finite()) {
        return Err(AppError::new("asr_pcm_decode", "音频片段包含无效采样"));
    }
    Ok(pcm)
}

fn centiseconds_to_millis(centiseconds: i64) -> u64 {
    u64::try_from(centiseconds).unwrap_or(0).saturating_mul(10)
}

fn asr_thread_count() -> i32 {
    let available = std::thread::available_parallelism()
        .map(|count| count.get())
        .unwrap_or(1);
    asr_thread_count_for_available(available)
}

fn asr_thread_count_for_available(available: usize) -> i32 {
    // Calls to one CrispASR session remain serialized, so using the complete
    // logical processor set here does not create concurrent model instances.
    // It gives ggml maximum intra-op parallelism while keeping a single model
    // session serialized, so no additional worker pool is required.
    i32::try_from(available.max(1)).unwrap_or(i32::MAX)
}

fn model_directory(app_data_dir: Option<&Path>) -> PathBuf {
    #[cfg(target_os = "android")]
    {
        return app_data_dir
            .map(|directory| directory.join("rlive"))
            .unwrap_or_else(|| PathBuf::from("."))
            .join("models")
            .join("asr");
    }

    #[cfg(not(target_os = "android"))]
    {
        let _ = app_data_dir;
        dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("rlive")
            .join("models")
            .join("asr")
    }
}

fn model_file_is_complete(path: &Path) -> bool {
    file_has_size(path, MODEL_SIZE_BYTES)
}

fn vad_model_file_is_complete(path: &Path) -> bool {
    file_has_size(path, VAD_MODEL_SIZE_BYTES)
}

fn file_has_size(path: &Path, expected_size: u64) -> bool {
    path.metadata()
        .map(|metadata| metadata.is_file() && metadata.len() == expected_size)
        .unwrap_or(false)
}

fn asr_download_client(proxy: Option<&str>) -> AppResult<reqwest::Client> {
    use std::time::Duration;

    crate::http_client::with_proxy(
        reqwest::Client::builder()
            .use_native_tls()
            .connect_timeout(Duration::from_secs(15))
            // Reqwest has no total timeout by default, which is important for
            // a 631 MB model. A per-read timeout still catches stalled links.
            .read_timeout(Duration::from_secs(60))
            .user_agent("rLive ASR model downloader"),
        proxy,
    )?
    .build()
    .map_err(|_| AppError::new("asr_http_client", "模型下载客户端初始化失败"))
}

async fn remove_file_if_present(path: &Path) -> AppResult<()> {
    match tokio::fs::remove_file(path).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(AppError::new("asr_model_write", "无法清理模型临时文件")),
    }
}

async fn remove_incomplete_model_file(path: &Path) -> AppResult<()> {
    remove_incomplete_file(path, MODEL_SIZE_BYTES).await
}

async fn remove_incomplete_file(path: &Path, expected_size: u64) -> AppResult<()> {
    if !path.exists() || file_has_size(path, expected_size) {
        return Ok(());
    }
    let metadata = tokio::fs::metadata(path)
        .await
        .map_err(|_| AppError::new("asr_model_path", "模型文件状态无效"))?;
    if !metadata.is_file() {
        return Err(AppError::new("asr_model_path", "模型文件路径无效"));
    }
    tokio::fs::remove_file(path)
        .await
        .map_err(|_| AppError::new("asr_model_write", "无法替换不完整模型文件"))
}

#[cfg(test)]
mod tests {
    use super::{asr_thread_count_for_available, centiseconds_to_millis, decode_base64_pcm};
    use base64::Engine;

    #[test]
    fn decodes_little_endian_pcm() {
        let input = base64::engine::general_purpose::STANDARD.encode([
            0_u8, 0, 128, 63, // 1.0f32 LE
            0, 0, 0, 191, // -0.5f32 LE
        ]);
        assert_eq!(decode_base64_pcm(&input).unwrap(), vec![1.0, -0.5]);
    }

    #[test]
    fn rejects_invalid_pcm_payloads() {
        assert!(decode_base64_pcm("not base64!").is_err());
        let unaligned = base64::engine::general_purpose::STANDARD.encode([1_u8, 2, 3]);
        assert!(decode_base64_pcm(&unaligned).is_err());
    }

    #[test]
    fn converts_non_finite_or_negative_times_safely() {
        assert_eq!(centiseconds_to_millis(-1), 0);
        assert_eq!(centiseconds_to_millis(123), 1_230);
    }

    #[test]
    fn uses_all_detected_logical_processors_without_a_fixed_cap() {
        assert_eq!(asr_thread_count_for_available(1), 1);
        assert_eq!(asr_thread_count_for_available(16), 16);
    }

    #[test]
    fn crispasr_vad_options_match_the_c_abi() {
        assert_eq!(std::mem::size_of::<crispasr_sys::CrispasrVadAbiOpts>(), 24);
        assert_eq!(std::mem::align_of::<crispasr_sys::CrispasrVadAbiOpts>(), 4);
    }
}
