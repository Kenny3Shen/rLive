//! Local streaming ASR model lifecycle and transcription service (sherpa-onnx).
//!
//! The model is deliberately neither downloaded nor loaded at application
//! startup. A user must opt in through Settings before `enable` starts its
//! background task. Audio is supplied by the web player as 16 kHz mono f32 PCM.
//!
//! This uses a streaming zipformer transducer through `OnlineRecognizer`. One
//! long-lived stream accumulates state across IPC windows, so every window
//! returns the evolving hypothesis for the current utterance plus any
//! utterances that endpointing just finalized. Silero VAD is not needed:
//! endpoint rules already decide where an utterance ends. When optional speaker
//! differentiation is enabled, each finalized utterance is classified from its
//! cached PCM with a CAMPPlus speaker embedding model.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use sherpa_onnx::{
    OfflinePunctuation, OfflinePunctuationConfig, OnlineRecognizer, OnlineRecognizerConfig,
    OnlineStream, SpeakerEmbeddingExtractor, SpeakerEmbeddingExtractorConfig,
};

use crate::error::{AppError, AppResult};

const MODEL_DIR_NAME: &str = "sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20";
const MODEL_ARCHIVE_URL: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20.tar.bz2";
const MODEL_ARCHIVE_SIZE_BYTES: u64 = 511_274_346;

const PUNCTUATION_DIR_NAME: &str =
    "sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12-int8";
const PUNCTUATION_ARCHIVE_URL: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download/punctuation-models/sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12-int8.tar.bz2";
const PUNCTUATION_ARCHIVE_SIZE_BYTES: u64 = 64_717_756;
const MODEL_SIZE_BYTES: u64 = MODEL_ARCHIVE_SIZE_BYTES + PUNCTUATION_ARCHIVE_SIZE_BYTES;

const SPEAKER_MODEL_FILE: &str = "3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx";
const SPEAKER_MODEL_URL: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx";
const SPEAKER_MODEL_SIZE_BYTES: u64 = 28_281_164;

const ENCODER_FILE: &str = "encoder-epoch-99-avg-1.int8.onnx";
const DECODER_FILE: &str = "decoder-epoch-99-avg-1.onnx";
const JOINER_FILE: &str = "joiner-epoch-99-avg-1.int8.onnx";
const TOKENS_FILE: &str = "tokens.txt";
const PUNCTUATION_FILE: &str = "model.int8.onnx";

const ASR_SAMPLE_RATE: i32 = 16_000;
const ASR_THREAD_LIMIT: usize = 8;
const SPEAKER_MATCH_THRESHOLD: f32 = 0.55;
const MAX_SPEAKER_CLUSTERS: usize = 8;
const SPEAKER_CENTROID_HISTORY: u32 = 8;

// Endpoint rules. `OnlineRecognizerConfig::default()` leaves these at 0.0,
// which disables endpointing entirely, so they must be set explicitly.
// rule1 fires on trailing silence with no decoded text, rule2 on trailing
// silence after text, rule3 on a maximum utterance length.
const ENDPOINT_RULE1_MIN_TRAILING_SILENCE: f32 = 2.4;
const ENDPOINT_RULE2_MIN_TRAILING_SILENCE: f32 = 0.8;
const ENDPOINT_RULE3_MIN_UTTERANCE_LENGTH: f32 = 20.0;

const MAX_PCM_BYTES: usize = 2 * 1024 * 1024;
const MAX_BASE64_PCM_BYTES: usize = ((MAX_PCM_BYTES + 2) / 3) * 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AsrModelState {
    NotDownloaded,
    Downloaded,
    Downloading,
    Extracting,
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
    pub speaker_enabled: bool,
    pub speaker_model_downloaded: bool,
    pub speaker_model_size_bytes: u64,
    pub threads: i32,
    pub message: Option<String>,
}

impl AsrModelStatus {
    fn new(state: AsrModelState, speaker_enabled: bool, speaker_model_downloaded: bool) -> Self {
        let model_size_bytes = configured_model_size(speaker_enabled);
        Self {
            state,
            downloaded_bytes: 0,
            total_bytes: Some(model_size_bytes),
            model_size_bytes,
            speaker_enabled,
            speaker_model_downloaded,
            speaker_model_size_bytes: SPEAKER_MODEL_SIZE_BYTES,
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
    pub speaker_id: Option<u32>,
}

/// One window's worth of streaming output: utterances that endpointing just
/// finalized, plus the still-evolving hypothesis for the current utterance.
#[derive(Debug, Clone, Serialize)]
pub struct AsrTranscribeResult {
    pub segments: Vec<AsrCaptionSegment>,
    pub partial: Option<String>,
}

/// Paths to every asset the recognizer needs. Kept together so readiness is a
/// single check rather than four independent ones scattered across the file.
#[derive(Clone)]
struct ModelAssets {
    root: PathBuf,
    encoder: PathBuf,
    decoder: PathBuf,
    joiner: PathBuf,
    tokens: PathBuf,
    punctuation_root: PathBuf,
    punctuation: PathBuf,
    speaker: PathBuf,
}

impl ModelAssets {
    fn new(model_dir: &Path) -> Self {
        let root = model_dir.join(MODEL_DIR_NAME);
        let punctuation_root = model_dir.join(PUNCTUATION_DIR_NAME);
        Self {
            encoder: root.join(ENCODER_FILE),
            decoder: root.join(DECODER_FILE),
            joiner: root.join(JOINER_FILE),
            tokens: root.join(TOKENS_FILE),
            punctuation: punctuation_root.join(PUNCTUATION_FILE),
            speaker: model_dir.join(SPEAKER_MODEL_FILE),
            punctuation_root,
            root,
        }
    }

    /// Every graph and the token table must be a non-empty file. The archive
    /// carries no per-file manifest, so presence plus non-emptiness is the
    /// strongest cheap check available; a corrupt graph surfaces at load.
    fn is_complete(&self) -> bool {
        [
            &self.encoder,
            &self.decoder,
            &self.joiner,
            &self.tokens,
            &self.punctuation,
        ]
        .iter()
        .all(|path| file_is_non_empty(path))
    }

    fn recognizer_is_complete(&self) -> bool {
        [&self.encoder, &self.decoder, &self.joiner, &self.tokens]
            .iter()
            .all(|path| file_is_non_empty(path))
    }

    fn punctuation_is_complete(&self) -> bool {
        file_is_non_empty(&self.punctuation)
    }

    fn speaker_is_complete(&self) -> bool {
        file_has_size(&self.speaker, SPEAKER_MODEL_SIZE_BYTES)
    }

    fn required_assets_complete(&self, speaker_enabled: bool) -> bool {
        self.is_complete() && (!speaker_enabled || self.speaker_is_complete())
    }

    fn downloaded_bytes(&self, speaker_enabled: bool) -> u64 {
        let recognizer = if self.recognizer_is_complete() {
            MODEL_ARCHIVE_SIZE_BYTES
        } else {
            0
        };
        let punctuation = if self.punctuation_is_complete() {
            PUNCTUATION_ARCHIVE_SIZE_BYTES
        } else {
            0
        };
        let speaker = if speaker_enabled && self.speaker_is_complete() {
            SPEAKER_MODEL_SIZE_BYTES
        } else {
            0
        };
        recognizer + punctuation + speaker
    }

    fn as_string(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }
}

#[derive(Debug)]
struct SpeakerCluster {
    centroid: Vec<f32>,
    observations: u32,
}

#[derive(Debug, Default)]
struct SpeakerClusters {
    clusters: Vec<SpeakerCluster>,
}

impl SpeakerClusters {
    fn reset(&mut self) {
        self.clusters.clear();
    }

    fn classify(&mut self, embedding: &[f32]) -> Option<u32> {
        let normalized = normalize_embedding(embedding)?;
        let best = self
            .clusters
            .iter()
            .enumerate()
            .map(|(index, cluster)| (index, cosine_similarity(&cluster.centroid, &normalized)))
            .max_by(|left, right| left.1.total_cmp(&right.1));

        if let Some((index, score)) = best
            && score >= SPEAKER_MATCH_THRESHOLD
        {
            let cluster = &mut self.clusters[index];
            let history = cluster.observations.min(SPEAKER_CENTROID_HISTORY) as f32;
            for (centroid, sample) in cluster.centroid.iter_mut().zip(&normalized) {
                *centroid = (*centroid * history + sample) / (history + 1.0);
            }
            if let Some(updated) = normalize_embedding(&cluster.centroid) {
                cluster.centroid = updated;
            }
            cluster.observations = cluster.observations.saturating_add(1);
            return Some(index as u32 + 1);
        }

        if self.clusters.len() >= MAX_SPEAKER_CLUSTERS {
            return None;
        }
        self.clusters.push(SpeakerCluster {
            centroid: normalized,
            observations: 1,
        });
        Some(self.clusters.len() as u32)
    }
}

struct NativeSpeakerSession {
    extractor: SpeakerEmbeddingExtractor,
    clusters: SpeakerClusters,
}

impl NativeSpeakerSession {
    fn open(model: &Path, threads: i32) -> Result<Self, String> {
        let config = SpeakerEmbeddingExtractorConfig {
            model: Some(ModelAssets::as_string(model)),
            num_threads: threads.clamp(1, 2),
            debug: false,
            provider: Some("cpu".to_string()),
        };
        let extractor = SpeakerEmbeddingExtractor::create(&config)
            .ok_or_else(|| "sherpa-onnx could not create the speaker model".to_string())?;
        Ok(Self {
            extractor,
            clusters: SpeakerClusters::default(),
        })
    }

    fn classify(&mut self, pcm: &[f32]) -> Option<u32> {
        let stream = self.extractor.create_stream()?;
        stream.accept_waveform(ASR_SAMPLE_RATE, pcm);
        stream.input_finished();
        if !self.extractor.is_ready(&stream) {
            return None;
        }
        let embedding = self.extractor.compute(&stream)?;
        self.clusters.classify(&embedding)
    }

    fn reset(&mut self) {
        self.clusters.reset();
    }
}

/// Owns the recognizer plus the single long-lived stream that carries decoder
/// state across IPC windows.
///
/// A streaming transducer only produces incremental text if one stream is fed
/// continuously, so the stream is created once at load and reset only at an
/// endpoint or when the player switches sources.
struct NativeAsrSession {
    recognizer: OnlineRecognizer,
    stream: OnlineStream,
    punctuation: OfflinePunctuation,
    speaker: Option<NativeSpeakerSession>,
    /// Total samples accepted since the last reset, used to place captions on a
    /// timeline relative to the start of the current stream.
    accepted_samples: u64,
    /// Sample position where the current utterance began.
    utterance_start_samples: u64,
    /// PCM since the last endpoint. It is bounded by endpoint rule 3 and is
    /// consumed only after a final sentence exists.
    utterance_pcm: Vec<f32>,
}

unsafe impl Send for NativeAsrSession {}

impl NativeAsrSession {
    fn open(assets: &ModelAssets, threads: i32, speaker_enabled: bool) -> Result<Self, String> {
        let mut config = OnlineRecognizerConfig::default();
        config.model_config.transducer.encoder = Some(ModelAssets::as_string(&assets.encoder));
        config.model_config.transducer.decoder = Some(ModelAssets::as_string(&assets.decoder));
        config.model_config.transducer.joiner = Some(ModelAssets::as_string(&assets.joiner));
        config.model_config.tokens = Some(ModelAssets::as_string(&assets.tokens));
        config.model_config.num_threads = threads;
        config.model_config.debug = false;
        // Greedy decoding keeps per-window latency predictable; beam search
        // would raise cost on exactly the devices that are already marginal.
        config.decoding_method = Some("greedy_search".to_string());
        // Defaults leave every rule at 0.0, which disables endpointing
        // entirely, so the utterance boundaries must be configured explicitly.
        config.enable_endpoint = true;
        config.rule1_min_trailing_silence = ENDPOINT_RULE1_MIN_TRAILING_SILENCE;
        config.rule2_min_trailing_silence = ENDPOINT_RULE2_MIN_TRAILING_SILENCE;
        config.rule3_min_utterance_length = ENDPOINT_RULE3_MIN_UTTERANCE_LENGTH;

        let recognizer = OnlineRecognizer::create(&config)
            .ok_or_else(|| "sherpa-onnx could not create the streaming recognizer".to_string())?;
        let stream = recognizer.create_stream();

        let mut punctuation_config = OfflinePunctuationConfig::default();
        punctuation_config.model.ct_transformer = Some(ModelAssets::as_string(&assets.punctuation));
        punctuation_config.model.num_threads = threads.clamp(1, 2);
        punctuation_config.model.debug = false;
        let punctuation = OfflinePunctuation::create(&punctuation_config)
            .ok_or_else(|| "sherpa-onnx could not create the punctuation model".to_string())?;
        let speaker = if speaker_enabled {
            Some(NativeSpeakerSession::open(&assets.speaker, threads)?)
        } else {
            None
        };

        Ok(Self {
            recognizer,
            stream,
            punctuation,
            speaker,
            accepted_samples: 0,
            utterance_start_samples: 0,
            utterance_pcm: Vec::new(),
        })
    }

    /// Drop decoder state so a new playback session never continues the
    /// previous stream's utterance.
    fn reset_stream(&mut self) {
        self.recognizer.reset(&self.stream);
        self.accepted_samples = 0;
        self.utterance_start_samples = 0;
        self.utterance_pcm.clear();
        if let Some(speaker) = self.speaker.as_mut() {
            speaker.reset();
        }
    }

    /// Feed one window and drain whatever the recognizer can decode from it.
    ///
    /// Returns any utterance finalized by endpointing during this window along
    /// with the current hypothesis, which the UI renders as provisional text.
    fn transcribe(&mut self, pcm: &[f32]) -> Result<AsrTranscribeResult, String> {
        if pcm.is_empty() {
            return Ok(AsrTranscribeResult {
                segments: Vec::new(),
                partial: None,
            });
        }

        self.stream.accept_waveform(ASR_SAMPLE_RATE, pcm);
        self.accepted_samples = self.accepted_samples.saturating_add(pcm.len() as u64);
        self.utterance_pcm.extend_from_slice(pcm);

        let mut segments = Vec::new();
        // Decode everything currently buffered. A single window can cross an
        // endpoint, so the boundary check happens inside the loop.
        while self.recognizer.is_ready(&self.stream) {
            self.recognizer.decode(&self.stream);

            if self.recognizer.is_endpoint(&self.stream) {
                let text = self.current_text();
                let trimmed = text.trim();
                if !trimmed.is_empty() {
                    let speaker_id = self
                        .speaker
                        .as_mut()
                        .and_then(|speaker| speaker.classify(&self.utterance_pcm));
                    segments.push(AsrCaptionSegment {
                        text: self.add_punctuation(trimmed),
                        start_ms: samples_to_millis(self.utterance_start_samples),
                        end_ms: samples_to_millis(self.accepted_samples),
                        speaker_id,
                    });
                }
                self.recognizer.reset(&self.stream);
                self.utterance_start_samples = self.accepted_samples;
                self.utterance_pcm.clear();
            }
        }

        let text = self.current_text();
        let trimmed = text.trim();
        let partial = if trimmed.is_empty() {
            None
        } else {
            Some(self.add_punctuation(trimmed))
        };

        Ok(AsrTranscribeResult { segments, partial })
    }

    fn current_text(&self) -> String {
        self.recognizer
            .get_result(&self.stream)
            .map(|result| result.text)
            .unwrap_or_default()
    }

    fn add_punctuation(&self, text: &str) -> String {
        self.punctuation
            .add_punctuation(text)
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| text.to_owned())
    }
}

#[derive(Clone)]
pub struct AsrManager {
    inner: Arc<AsrInner>,
}

struct AsrInner {
    model_dir: PathBuf,
    assets: ModelAssets,
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
        let assets = ModelAssets::new(&model_dir);

        let speaker_model_downloaded = assets.speaker_is_complete();
        let mut status = AsrModelStatus::new(
            if assets.is_complete() {
                AsrModelState::Downloaded
            } else {
                AsrModelState::NotDownloaded
            },
            false,
            speaker_model_downloaded,
        );
        status.downloaded_bytes = assets.downloaded_bytes(false);

        Self {
            inner: Arc::new(AsrInner {
                model_dir,
                assets,
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

    pub fn enable(
        &self,
        proxy: Option<String>,
        speaker_enabled: bool,
    ) -> AppResult<AsrModelStatus> {
        use std::sync::atomic::Ordering;

        let _control = self
            .inner
            .control
            .lock()
            .map_err(|_| AppError::new("asr_control_lock", "语音字幕状态暂不可用"))?;
        let was_requested = self.inner.requested.swap(true, Ordering::AcqRel);
        let model_exists = self.inner.assets.required_assets_complete(speaker_enabled);
        let next_state = if model_exists {
            AsrModelState::Loading
        } else {
            AsrModelState::Downloading
        };

        let generation = {
            let mut status = self
                .inner
                .status
                .lock()
                .map_err(|_| AppError::new("asr_status_lock", "语音字幕状态暂不可用"))?;

            let same_configuration = status.speaker_enabled == speaker_enabled;
            if was_requested && same_configuration && status.state == AsrModelState::Ready {
                return Ok(status.clone());
            }
            if was_requested
                && same_configuration
                && matches!(
                    status.state,
                    AsrModelState::Downloading | AsrModelState::Extracting | AsrModelState::Loading
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
            status.speaker_enabled = speaker_enabled;
            status.speaker_model_downloaded = self.inner.assets.speaker_is_complete();
            status.model_size_bytes = configured_model_size(speaker_enabled);
            status.downloaded_bytes = self.inner.assets.downloaded_bytes(speaker_enabled);
            status.total_bytes = Some(status.model_size_bytes);
            status.threads = asr_thread_count();
            status.message = None;
            generation
        };

        let manager = self.clone();
        tauri::async_runtime::spawn(async move {
            manager
                .prepare_model(proxy, generation, speaker_enabled)
                .await;
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
            // leaving verified on-disk assets available for the next enable.
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

    /// Drop buffered detector audio without unloading the model. Called when
    /// the player switches rooms or streams so captions never splice audio
    /// from two different sessions into one segment.
    pub fn reset_stream(&self) -> AppResult<()> {
        let mut session = self
            .inner
            .session
            .lock()
            .map_err(|_| AppError::new("asr_session_lock", "语音字幕模型暂不可用"))?;
        if let Some(session) = session.as_mut() {
            session.reset_stream();
        }
        Ok(())
    }

    async fn prepare_model(&self, proxy: Option<String>, generation: u64, speaker_enabled: bool) {
        let _prepare = self.inner.prepare_lock.lock().await;
        if !self.request_is_current(generation) {
            return;
        }

        let model_ready = match self
            .ensure_model_assets(proxy.as_deref(), generation, speaker_enabled)
            .await
        {
            Ok(ready) => ready,
            Err(error) => {
                tracing::warn!(error = %error, "ASR model preparation failed");
                self.set_error_status_for_request(
                    generation,
                    "模型准备失败，请检查网络或存储空间后重试",
                );
                return;
            }
        };
        if !model_ready || !self.request_is_current(generation) {
            return;
        }

        self.set_loading_status(generation, speaker_enabled);
        let assets = self.inner.assets.clone();
        let threads = asr_thread_count();
        let manager = self.clone();
        let load_result = tokio::task::spawn_blocking(move || {
            let mut guard = manager
                .inner
                .session
                .lock()
                .map_err(|_| "ASR session lock is unavailable".to_string())?;
            let previous = guard.take();
            drop(guard);
            drop(previous);
            NativeAsrSession::open(&assets, threads, speaker_enabled)
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
        drop(guard);

        self.update_status_for_request(generation, |status| {
            status.state = AsrModelState::Ready;
            status.speaker_enabled = speaker_enabled;
            status.speaker_model_downloaded = self.inner.assets.speaker_is_complete();
            status.model_size_bytes = configured_model_size(speaker_enabled);
            status.downloaded_bytes = status.model_size_bytes;
            status.total_bytes = Some(status.model_size_bytes);
            status.message = None;
        });
    }

    async fn ensure_model_assets(
        &self,
        proxy: Option<&str>,
        generation: u64,
        speaker_enabled: bool,
    ) -> AppResult<bool> {
        if !self.request_is_current(generation) {
            return Ok(false);
        }
        if self.inner.assets.required_assets_complete(speaker_enabled) {
            return Ok(true);
        }

        let total_size = configured_model_size(speaker_enabled);

        tokio::fs::create_dir_all(&self.inner.model_dir)
            .await
            .map_err(|_| AppError::new("asr_model_dir", "无法创建模型目录"))?;

        if !self.inner.assets.recognizer_is_complete()
            && !self
                .download_and_extract_archive(
                    proxy,
                    generation,
                    MODEL_ARCHIVE_URL,
                    MODEL_ARCHIVE_SIZE_BYTES,
                    0,
                    "streaming-zipformer.tar.bz2.part",
                    &self.inner.assets.root,
                    "Zipformer 识别模型",
                    total_size,
                )
                .await?
        {
            return Ok(false);
        }
        if !self.inner.assets.recognizer_is_complete() {
            return Err(AppError::new(
                "asr_model_extract",
                "Zipformer 模型解压结果不完整",
            ));
        }

        if !self.request_is_current(generation) {
            return Ok(false);
        }

        if !self.inner.assets.punctuation_is_complete()
            && !self
                .download_and_extract_archive(
                    proxy,
                    generation,
                    PUNCTUATION_ARCHIVE_URL,
                    PUNCTUATION_ARCHIVE_SIZE_BYTES,
                    MODEL_ARCHIVE_SIZE_BYTES,
                    "punctuation-ct-transformer.tar.bz2.part",
                    &self.inner.assets.punctuation_root,
                    "中英标点模型",
                    total_size,
                )
                .await?
        {
            return Ok(false);
        }
        if !self.inner.assets.punctuation_is_complete() {
            return Err(AppError::new("asr_model_extract", "标点模型解压结果不完整"));
        }

        if !self.inner.assets.is_complete() {
            return Err(AppError::new("asr_model_extract", "字幕模型解压结果不完整"));
        }

        if speaker_enabled && !self.inner.assets.speaker_is_complete() {
            let partial_path = self
                .inner
                .model_dir
                .join(format!("{SPEAKER_MODEL_FILE}.part"));
            remove_file_if_present(&partial_path).await?;
            remove_file_if_present(&self.inner.assets.speaker).await?;
            let downloaded = self
                .download_model_file(
                    proxy,
                    SPEAKER_MODEL_URL,
                    &partial_path,
                    SPEAKER_MODEL_SIZE_BYTES,
                    MODEL_SIZE_BYTES,
                    total_size,
                    generation,
                    "说话人声纹模型",
                )
                .await;
            match downloaded {
                Ok(true) => {}
                Ok(false) => {
                    let _ = remove_file_if_present(&partial_path).await;
                    return Ok(false);
                }
                Err(error) => {
                    if let Err(cleanup_error) = remove_file_if_present(&partial_path).await {
                        tracing::warn!(%cleanup_error, "failed to clean up speaker model download");
                    }
                    return Err(error);
                }
            }
            if !self.request_is_current(generation) {
                let _ = remove_file_if_present(&partial_path).await;
                return Ok(false);
            }
            tokio::fs::rename(&partial_path, &self.inner.assets.speaker)
                .await
                .map_err(|_| AppError::new("asr_model_write", "说话人声纹模型文件替换失败"))?;
            self.update_status_for_request(generation, |status| {
                status.speaker_model_downloaded = true;
                status.downloaded_bytes = total_size;
                status.total_bytes = Some(total_size);
            });
        }

        if !self.inner.assets.required_assets_complete(speaker_enabled) {
            return Err(AppError::new("asr_model_download", "字幕模型文件不完整"));
        }
        Ok(true)
    }

    #[allow(clippy::too_many_arguments)]
    async fn download_and_extract_archive(
        &self,
        proxy: Option<&str>,
        generation: u64,
        url: &str,
        expected_size: u64,
        progress_offset: u64,
        archive_name: &str,
        extracted_root: &Path,
        label: &str,
        total_size: u64,
    ) -> AppResult<bool> {
        let archive_path = self.inner.model_dir.join(archive_name);
        remove_file_if_present(&archive_path).await?;
        // Never mix files from an interrupted extraction with a fresh archive.
        remove_dir_if_present(extracted_root).await?;

        let result = self
            .download_model_file(
                proxy,
                url,
                &archive_path,
                expected_size,
                progress_offset,
                total_size,
                generation,
                label,
            )
            .await;
        match result {
            Ok(true) => {}
            Ok(false) => {
                let _ = remove_file_if_present(&archive_path).await;
                return Ok(false);
            }
            Err(error) => {
                if let Err(cleanup_error) = remove_file_if_present(&archive_path).await {
                    tracing::warn!(%cleanup_error, "failed to clean up ASR partial archive");
                }
                return Err(error);
            }
        }

        self.update_status_for_request(generation, |status| {
            status.state = AsrModelState::Extracting;
            status.downloaded_bytes = progress_offset.saturating_add(expected_size);
            status.total_bytes = Some(total_size);
            status.message = Some(format!("正在解压{label}…"));
        });

        let model_dir = self.inner.model_dir.clone();
        let archive = archive_path.clone();
        let extracted = tokio::task::spawn_blocking(move || extract_tar_bz2(&archive, &model_dir))
            .await
            .map_err(|_| AppError::new("asr_model_extract", "模型解压任务失败"))?;
        let _ = remove_file_if_present(&archive_path).await;
        extracted?;
        Ok(self.request_is_current(generation))
    }

    #[allow(clippy::too_many_arguments)]
    async fn download_model_file(
        &self,
        proxy: Option<&str>,
        url: &str,
        partial_path: &Path,
        expected_size: u64,
        progress_offset: u64,
        total_size: u64,
        generation: u64,
        label: &str,
    ) -> AppResult<bool> {
        if !self.request_is_current(generation) {
            return Ok(false);
        }

        let client = asr_download_client(proxy)?;
        let response = client
            .get(url)
            .send()
            .await
            .map_err(|_| AppError::new("asr_model_download", "模型下载请求失败"))?
            .error_for_status()
            .map_err(|_| AppError::new("asr_model_download", "模型下载服务返回错误"))?;
        if response
            .content_length()
            .is_some_and(|length| length != expected_size)
        {
            return Err(AppError::new("asr_model_size", "模型文件大小与预期不符"));
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
            if downloaded > expected_size {
                drop(file);
                let _ = tokio::fs::remove_file(partial_path).await;
                return Err(AppError::new("asr_model_size", "模型文件大小超出预期"));
            }
            file.write_all(&chunk)
                .await
                .map_err(|_| AppError::new("asr_model_write", "写入模型文件失败"))?;

            if last_progress.elapsed() >= std::time::Duration::from_millis(250) {
                last_progress = std::time::Instant::now();
                self.update_status_for_request(generation, |status| {
                    status.state = AsrModelState::Downloading;
                    status.downloaded_bytes = progress_offset.saturating_add(downloaded);
                    status.total_bytes = Some(total_size);
                    status.message = Some(format!("正在下载{label}…"));
                });
            }
        }

        file.flush()
            .await
            .map_err(|_| AppError::new("asr_model_write", "保存模型文件失败"))?;
        drop(file);

        if downloaded != expected_size {
            return Err(AppError::new("asr_model_size", "模型文件下载不完整"));
        }
        if !self.request_is_current(generation) {
            let _ = tokio::fs::remove_file(&partial_path).await;
            return Ok(false);
        }
        Ok(true)
    }

    pub async fn transcribe_pcm(&self, pcm: Vec<f32>) -> AppResult<AsrTranscribeResult> {
        if pcm.is_empty() {
            return Ok(AsrTranscribeResult {
                segments: Vec::new(),
                partial: None,
            });
        }
        let manager = self.clone();
        tokio::task::spawn_blocking(move || manager.transcribe_pcm_blocking(&pcm))
            .await
            .map_err(|_| AppError::new("asr_task_failed", "语音识别任务失败"))?
    }

    fn transcribe_pcm_blocking(&self, pcm: &[f32]) -> AppResult<AsrTranscribeResult> {
        if !self.is_requested() {
            return Err(AppError::new("asr_disabled", "语音字幕未启用"));
        }
        {
            let status = self
                .inner
                .status
                .lock()
                .map_err(|_| AppError::new("asr_status_lock", "语音字幕状态暂不可用"))?;
            if status.state != AsrModelState::Ready {
                return Err(AppError::new("asr_not_ready", "语音字幕模型正在准备"));
            }
        }
        let mut session = self
            .inner
            .session
            .lock()
            .map_err(|_| AppError::new("asr_session_lock", "语音字幕模型暂不可用"))?;
        let session = session
            .as_mut()
            .ok_or_else(|| AppError::new("asr_not_ready", "语音字幕模型正在准备"))?;
        let result = session.transcribe(pcm).map_err(|error| {
            tracing::warn!(%error, "ASR transcription failed");
            AppError::new("asr_transcribe_failed", "语音识别失败，请稍后重试")
        })?;

        if !self.is_requested() {
            return Err(AppError::new("asr_disabled", "语音字幕已关闭"));
        }

        Ok(result)
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

    fn set_loading_status(&self, generation: u64, speaker_enabled: bool) {
        let total_size = configured_model_size(speaker_enabled);
        self.update_status_for_request(generation, |status| {
            status.state = AsrModelState::Loading;
            status.speaker_enabled = speaker_enabled;
            status.speaker_model_downloaded = self.inner.assets.speaker_is_complete();
            status.model_size_bytes = total_size;
            status.downloaded_bytes = total_size;
            status.total_bytes = Some(total_size);
            status.message = None;
        });
    }

    fn set_idle_status(&self) {
        self.update_status(|status| {
            let speaker_enabled = status.speaker_enabled;
            let model_exists = self.inner.assets.required_assets_complete(speaker_enabled);
            let total_size = configured_model_size(speaker_enabled);
            status.state = if model_exists {
                AsrModelState::Downloaded
            } else {
                AsrModelState::NotDownloaded
            };
            status.speaker_model_downloaded = self.inner.assets.speaker_is_complete();
            status.model_size_bytes = total_size;
            status.downloaded_bytes = self.inner.assets.downloaded_bytes(speaker_enabled);
            status.total_bytes = Some(total_size);
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

fn samples_to_millis(samples: u64) -> u64 {
    samples.saturating_mul(1_000) / ASR_SAMPLE_RATE as u64
}

fn configured_model_size(speaker_enabled: bool) -> u64 {
    MODEL_SIZE_BYTES
        + if speaker_enabled {
            SPEAKER_MODEL_SIZE_BYTES
        } else {
            0
        }
}

fn normalize_embedding(embedding: &[f32]) -> Option<Vec<f32>> {
    if embedding.is_empty() || embedding.iter().any(|value| !value.is_finite()) {
        return None;
    }
    let norm_squared = embedding.iter().map(|value| value * value).sum::<f32>();
    if !norm_squared.is_finite() || norm_squared <= f32::EPSILON {
        return None;
    }
    let norm = norm_squared.sqrt();
    Some(embedding.iter().map(|value| value / norm).collect())
}

fn cosine_similarity(left: &[f32], right: &[f32]) -> f32 {
    if left.is_empty() || left.len() != right.len() {
        return f32::NEG_INFINITY;
    }
    left.iter()
        .zip(right)
        .map(|(left, right)| left * right)
        .sum()
}

fn asr_thread_count() -> i32 {
    let available = std::thread::available_parallelism()
        .map(|count| count.get())
        .unwrap_or(1);
    asr_thread_count_for_available(available)
}

fn asr_thread_count_for_available(available: usize) -> i32 {
    available.clamp(1, ASR_THREAD_LIMIT) as i32
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

fn extract_tar_bz2(archive: &Path, destination: &Path) -> AppResult<()> {
    let file = std::fs::File::open(archive)
        .map_err(|_| AppError::new("asr_model_extract", "无法打开模型压缩包"))?;
    let decoder = bzip2::read::BzDecoder::new(std::io::BufReader::new(file));
    let mut tar = tar::Archive::new(decoder);
    tar.unpack(destination)
        .map_err(|_| AppError::new("asr_model_extract", "模型解压失败"))
}

fn file_is_non_empty(path: &Path) -> bool {
    path.metadata()
        .map(|metadata| metadata.is_file() && metadata.len() > 0)
        .unwrap_or(false)
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
            // Reqwest has no total timeout by default. A per-read timeout still
            // catches stalled links during the roughly 550 MiB model transfer.
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

async fn remove_dir_if_present(path: &Path) -> AppResult<()> {
    match tokio::fs::remove_dir_all(path).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(AppError::new("asr_model_write", "无法清理旧模型目录")),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        MODEL_SIZE_BYTES, SPEAKER_MODEL_SIZE_BYTES, SpeakerClusters,
        asr_thread_count_for_available, configured_model_size, decode_base64_pcm,
        samples_to_millis,
    };
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
    fn converts_sample_positions_to_milliseconds() {
        assert_eq!(samples_to_millis(0), 0);
        assert_eq!(samples_to_millis(16_000), 1_000);
        assert_eq!(samples_to_millis(8_000), 500);
    }

    #[test]
    fn caps_asr_at_eight_threads() {
        assert_eq!(asr_thread_count_for_available(0), 1);
        assert_eq!(asr_thread_count_for_available(1), 1);
        assert_eq!(asr_thread_count_for_available(8), 8);
        assert_eq!(asr_thread_count_for_available(16), 8);
    }

    #[test]
    fn groups_similar_speaker_embeddings() {
        let mut clusters = SpeakerClusters::default();
        assert_eq!(clusters.classify(&[1.0, 0.0, 0.0]), Some(1));
        assert_eq!(clusters.classify(&[0.99, 0.08, 0.0]), Some(1));
        assert_eq!(clusters.clusters.len(), 1);
    }

    #[test]
    fn creates_a_new_speaker_for_orthogonal_embeddings() {
        let mut clusters = SpeakerClusters::default();
        assert_eq!(clusters.classify(&[1.0, 0.0]), Some(1));
        assert_eq!(clusters.classify(&[0.0, 1.0]), Some(2));
    }

    #[test]
    fn rejects_invalid_speaker_embeddings() {
        let mut clusters = SpeakerClusters::default();
        assert_eq!(clusters.classify(&[]), None);
        assert_eq!(clusters.classify(&[0.0, 0.0]), None);
        assert_eq!(clusters.classify(&[f32::NAN, 1.0]), None);
        assert!(clusters.clusters.is_empty());
    }

    #[test]
    fn resets_speaker_numbering_for_a_new_stream() {
        let mut clusters = SpeakerClusters::default();
        assert_eq!(clusters.classify(&[1.0, 0.0]), Some(1));
        assert_eq!(clusters.classify(&[0.0, 1.0]), Some(2));
        clusters.reset();
        assert_eq!(clusters.classify(&[0.0, 1.0]), Some(1));
    }

    #[test]
    fn includes_the_optional_speaker_model_in_download_size() {
        assert_eq!(configured_model_size(false), MODEL_SIZE_BYTES);
        assert_eq!(
            configured_model_size(true),
            MODEL_SIZE_BYTES + SPEAKER_MODEL_SIZE_BYTES
        );
    }
}
