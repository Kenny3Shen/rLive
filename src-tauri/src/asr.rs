//! 本地流式 ASR 模型生命周期与转写服务（CrispASR + Qwen3-ASR 0.6B）。
//!
//! 模型刻意不在应用启动时下载或加载。用户必须在设置中主动开启，
//! `enable` 才会启动后台任务。音频由 Web 播放器以 16 kHz 单声道
//! f32 PCM 提供。
//!
//! CrispASR 运行库按平台在首次启用时下载（见 `runtime`），经 `libloading` 加载。
//! Qwen3-ASR 是离线 encoder-decoder：`stream` 用 Silero VAD 分句，语句进行中只重解码
//! 最近几秒作为在途假设，语句结束时解码整句定稿。启用可选的说话人区分时，
//! 每条定稿语句都会经 TitaNet 声纹模型分类。

mod crispasr;
mod download;
mod runtime;
mod stream;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::Serialize;

use crate::error::{AppError, AppResult};

use self::runtime::RuntimePackage;
use self::stream::{CaptionEngine, CaptionStream, FRAME_SAMPLES, SAMPLE_RATE, StreamConfig};

/// 一个需要下载的模型文件。地址钉在 Hugging Face 的固定 commit 上，
/// 大小与 SHA-256 都在下载时校验。
struct ModelFile {
    label: &'static str,
    file_name: &'static str,
    url: &'static str,
    size: u64,
    sha256: &'static str,
}

impl ModelFile {
    /// 下载中的临时文件名，带摘要前缀：换了固定版本的同名文件不会续传旧数据。
    fn partial_name(&self) -> String {
        format!("{}.{}.part", self.file_name, &self.sha256[..8])
    }
}

const ASR_MODEL: ModelFile = ModelFile {
    label: "Qwen3-ASR 识别模型",
    file_name: "qwen3-asr-0.6b-q4_k.gguf",
    url: "https://huggingface.co/cstr/qwen3-asr-0.6b-GGUF/resolve/58bd3202f835f46b24b17142cb503b0860c737a5/qwen3-asr-0.6b-q4_k.gguf",
    size: 631_026_336,
    sha256: "f63771c02dfa486d9399d41ab6ab8cd2d8ca24e077cd32130ea1f67f4fd8dade",
};

const VAD_MODEL: ModelFile = ModelFile {
    label: "Silero VAD 模型",
    file_name: "ggml-silero-v6.2.0.bin",
    url: "https://huggingface.co/ggml-org/whisper-vad/resolve/9ffd54a1e1ee413ddf265af9913beaf518d1639b/ggml-silero-v6.2.0.bin",
    size: 885_098,
    sha256: "2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987",
};

const SPEAKER_MODEL: ModelFile = ModelFile {
    label: "TitaNet 说话人声纹模型",
    file_name: "titanet-large.gguf",
    url: "https://huggingface.co/cstr/titanet-large-GGUF/resolve/4f58dcc54b17ba738c2aec055f3afe6e46263a64/titanet-large.gguf",
    size: 44_612_960,
    sha256: "ad1a24f074a1a2cbc7492f7a131043713467fb31abd606cff2804bb649c53ada",
};

const RUNTIME_DIR_NAME: &str = "crispasr-runtime";

/// 旧版 sherpa-onnx 留在 `models/asr` 下的资产，切换后不再使用。
const LEGACY_MODEL_ENTRIES: &[&str] = &[
    "sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20",
    "sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12-int8",
    "3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx",
    "3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx.part",
    "streaming-zipformer.tar.bz2.part",
    "punctuation-ct-transformer.tar.bz2.part",
    "hotwords.txt",
    "hotwords.txt.part",
];
/// 旧版 Windows sherpa-onnx CUDA 运行库目录，按版本标记确认后才删除。
const LEGACY_RUNTIME_DIR_NAME: &str = "asr-runtime";
const LEGACY_RUNTIME_MARKER_PREFIX: &str = "sherpa-onnx";

const ASR_PROVIDER_AUTO: &str = "auto";
const ASR_PROVIDER_CPU: &str = "cpu";
const ASR_PROVIDER_CUDA: &str = "cuda";

const ASR_THREAD_LIMIT: usize = 8;
const SPEAKER_THREADS: i32 = 4;
const SPEAKER_MATCH_THRESHOLD: f32 = 0.55;
const SPEAKER_SWITCH_THRESHOLD: f32 = 0.68;
const SPEAKER_NEW_CLUSTER_THRESHOLD: f32 = 0.35;
const SPEAKER_MIN_UTTERANCE_SAMPLES: usize = 9_600;
/// 声纹只取语句中段至多 4 s：TitaNet 在 CPU 上的耗时随音频长度增长，
/// 4 s 已足够稳定区分说话人。
const SPEAKER_MAX_WINDOW_SAMPLES: usize = 4 * SAMPLE_RATE;
const MAX_SPEAKER_CLUSTERS: usize = 8;
const SPEAKER_CENTROID_HISTORY: u32 = 8;

const MAX_PCM_BYTES: usize = 2 * 1024 * 1024;
const MAX_BASE64_PCM_BYTES: usize = MAX_PCM_BYTES.div_ceil(3) * 4;

/// 模型空闲多久后释放常驻会话。
///
/// 字幕开启时每个采集窗口都会调用转写，因此这个阈值只在字幕关闭、
/// 媒体暂停或页面离开之后才会到期；到期后模型转为「已下载」状态，
/// 下一次开启字幕时按需重新加载。
const ASR_IDLE_RELEASE: std::time::Duration = std::time::Duration::from_secs(120);
/// 空闲看门狗的检查间隔。释放仍以 `ASR_IDLE_RELEASE` 为准，
/// 它只决定最坏情况下的延迟。
const ASR_IDLE_WATCHDOG_INTERVAL: std::time::Duration = std::time::Duration::from_secs(15);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AsrModelState {
    NotDownloaded,
    Downloaded,
    Downloading,
    Extracting,
    Loading,
    Ready,
    /// 模型已下载且功能仍启用，但会话因长时间空闲已释放。
    /// 下一次开启字幕时按需重新加载。
    Idle,
    /// 当前平台或 CPU 没有可用的 CrispASR 运行库，原因写在 `message`。
    Unsupported,
    Error,
}

#[derive(Debug, Clone, Serialize)]
pub struct AsrModelStatus {
    pub state: AsrModelState,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub model_size_bytes: u64,
    pub speaker_enabled: bool,
    pub vad_enabled: bool,
    pub punctuation_enabled: bool,
    pub hotwords_count: u32,
    pub speaker_model_downloaded: bool,
    pub speaker_model_size_bytes: u64,
    /// Windows 尚未探测 GPU 时，若探测到可用 NVIDIA GPU 会多下载的 CUDA 运行库体积；
    /// 已确定运行库包或其余平台为 0。
    pub cuda_runtime_extra_bytes: u64,
    pub threads: i32,
    /// 识别模型所使用的推理后端：`cpu` 或 `cuda`。
    pub provider: String,
    pub message: Option<String>,
}

impl AsrModelStatus {
    fn new(options: &AsrRuntimeOptions, snapshot: AssetSnapshot) -> Self {
        let unsupported = runtime::unsupported_reason();
        Self {
            state: if unsupported.is_some() {
                AsrModelState::Unsupported
            } else if snapshot.complete {
                AsrModelState::Downloaded
            } else {
                AsrModelState::NotDownloaded
            },
            downloaded_bytes: snapshot.downloaded_bytes,
            total_bytes: Some(snapshot.total_bytes),
            model_size_bytes: snapshot.total_bytes,
            speaker_enabled: options.speaker_enabled,
            vad_enabled: options.vad_enabled,
            punctuation_enabled: options.punctuation_enabled,
            hotwords_count: options.hotwords.len() as u32,
            speaker_model_downloaded: snapshot.speaker_downloaded,
            speaker_model_size_bytes: SPEAKER_MODEL.size,
            cuda_runtime_extra_bytes: snapshot.cuda_extra_bytes,
            threads: asr_thread_count(),
            // 不在这里解析 provider：`effective_asr_provider` 在 Windows 上会加载
            // NVIDIA 驱动查询 GPU。那属于「真正启用」的代价，不能出现在应用启动路径上。
            provider: asr_provider_placeholder(&options.provider),
            message: unsupported.map(str::to_owned),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AsrRuntimeOptions {
    /// `auto` 在 Windows 上检测到可用 NVIDIA GPU 时选择 CUDA；
    /// Linux 与 macOS 始终使用 CPU。
    pub provider: String,
    pub vad_enabled: bool,
    pub punctuation_enabled: bool,
    pub speaker_enabled: bool,
    pub hotwords: Vec<String>,
}

impl Default for AsrRuntimeOptions {
    fn default() -> Self {
        Self {
            provider: ASR_PROVIDER_AUTO.to_string(),
            vad_enabled: true,
            punctuation_enabled: true,
            speaker_enabled: false,
            hotwords: Vec::new(),
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

/// 一个窗口产生的流式输出：刚刚定稿的语句，以及当前语句仍在演进的假设。
#[derive(Debug, Clone, Serialize)]
pub struct AsrTranscribeResult {
    pub segments: Vec<AsrCaptionSegment>,
    pub partial: Option<String>,
}

/// `models/asr` 下的模型文件路径。
#[derive(Clone)]
struct ModelAssets {
    root: PathBuf,
}

impl ModelAssets {
    fn new(model_dir: &Path) -> Self {
        Self {
            root: model_dir.to_path_buf(),
        }
    }

    fn path(&self, model: &ModelFile) -> PathBuf {
        self.root.join(model.file_name)
    }

    /// 下载时已校验 SHA-256 并原子改名，这里只核对大小；损坏会在加载时暴露。
    fn is_complete(&self, model: &ModelFile) -> bool {
        file_len(&self.path(model)) == Some(model.size)
    }

    fn speaker_is_complete(&self) -> bool {
        self.is_complete(&SPEAKER_MODEL)
    }
}

/// 当前配置需要的模型文件，按下载顺序排列。
fn required_models(options: &AsrRuntimeOptions) -> Vec<&'static ModelFile> {
    let mut models = vec![&ASR_MODEL];
    if options.vad_enabled {
        models.push(&VAD_MODEL);
    }
    if options.speaker_enabled {
        models.push(&SPEAKER_MODEL);
    }
    models
}

/// 运行库包加上当前配置需要的模型文件的总下载体积。
fn configured_download_size(options: &AsrRuntimeOptions, package: Option<&RuntimePackage>) -> u64 {
    package.map_or(0, |package| package.size)
        + required_models(options)
            .into_iter()
            .map(|model| model.size)
            .sum::<u64>()
}

/// 不触发 GPU 探测的资产快照，用于状态展示。
#[derive(Debug, Clone, Copy)]
struct AssetSnapshot {
    complete: bool,
    downloaded_bytes: u64,
    total_bytes: u64,
    speaker_downloaded: bool,
    cuda_extra_bytes: u64,
}

fn asset_snapshot(
    assets: &ModelAssets,
    runtime_dir: &Path,
    options: &AsrRuntimeOptions,
) -> AssetSnapshot {
    let package = runtime::known_package(runtime_dir, prefers_gpu(&options.provider));
    let runtime_installed = package.is_some_and(|package| package.is_installed(runtime_dir));
    let mut complete = runtime_installed;
    let mut downloaded_bytes = if runtime_installed {
        package.map_or(0, |package| package.size)
    } else {
        0
    };
    for model in required_models(options) {
        if assets.is_complete(model) {
            downloaded_bytes += model.size;
        } else {
            complete = false;
        }
    }
    AssetSnapshot {
        complete,
        downloaded_bytes,
        total_bytes: configured_download_size(options, package),
        speaker_downloaded: assets.speaker_is_complete(),
        cuda_extra_bytes: runtime::cuda_extra_bytes(runtime_dir, prefers_gpu(&options.provider)),
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
    last_assignment: Option<u32>,
}

impl SpeakerClusters {
    fn reset(&mut self) {
        self.clusters.clear();
        self.last_assignment = None;
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
            let candidate_id = index as u32 + 1;
            // 当嵌入向量接近聚类边界时保留上一次的标签。第二个明显区分开的声音
            // 仍可立即切换，而带噪的短端点不再让界面上的编号
            // 在两个说话人之间来回跳动。
            let selected_id = self
                .last_assignment
                .filter(|previous| *previous != candidate_id && score < SPEAKER_SWITCH_THRESHOLD)
                .unwrap_or(candidate_id);
            if selected_id != candidate_id {
                return Some(selected_id);
            }
            let cluster = &mut self.clusters[index];
            let history = cluster.observations.min(SPEAKER_CENTROID_HISTORY) as f32;
            for (centroid, sample) in cluster.centroid.iter_mut().zip(&normalized) {
                *centroid = (*centroid * history + sample) / (history + 1.0);
            }
            if let Some(updated) = normalize_embedding(&cluster.centroid) {
                cluster.centroid = updated;
            }
            cluster.observations = cluster.observations.saturating_add(1);
            self.last_assignment = Some(selected_id);
            return Some(selected_id);
        }

        if let Some((_, score)) = best
            && score >= SPEAKER_NEW_CLUSTER_THRESHOLD
            && let Some(previous) = self.last_assignment
        {
            return Some(previous);
        }

        if self.clusters.len() >= MAX_SPEAKER_CLUSTERS {
            return None;
        }
        self.clusters.push(SpeakerCluster {
            centroid: normalized,
            observations: 1,
        });
        let id = self.clusters.len() as u32;
        self.last_assignment = Some(id);
        Some(id)
    }
}

struct NativeSpeakerSession {
    embedder: crispasr::SpeakerEmbedder,
    clusters: SpeakerClusters,
}

impl NativeSpeakerSession {
    fn open(model: &Path) -> Result<Self, String> {
        Ok(Self {
            embedder: crispasr::SpeakerEmbedder::open(model, SPEAKER_THREADS)?,
            clusters: SpeakerClusters::default(),
        })
    }

    fn classify(&mut self, pcm: &[f32]) -> Option<u32> {
        if pcm.len() < SPEAKER_MIN_UTTERANCE_SAMPLES {
            return self.clusters.last_assignment;
        }
        let window = pcm.len().min(SPEAKER_MAX_WINDOW_SAMPLES);
        let start = (pcm.len() - window) / 2;
        let embedding = self.embedder.embed(&pcm[start..start + window])?;
        self.clusters.classify(&embedding)
    }

    fn reset(&mut self) {
        self.clusters.reset();
    }
}

/// 调度器借用的原生能力：识别、VAD 与可选的声纹。
struct NativeEngine {
    asr: crispasr::Session,
    vad: Option<crispasr::Vad>,
    speaker: Option<NativeSpeakerSession>,
}

impl CaptionEngine for NativeEngine {
    fn score(&mut self, pcm: &[f32]) -> Result<Vec<f32>, String> {
        match self.vad.as_mut() {
            Some(vad) => vad.score(pcm),
            None => Ok(vec![1.0; pcm.len() / FRAME_SAMPLES]),
        }
    }

    fn transcribe(&mut self, pcm: &[f32]) -> Result<String, String> {
        self.asr.transcribe(pcm)
    }

    fn classify_speaker(&mut self, pcm: &[f32]) -> Option<u32> {
        self.speaker.as_mut()?.classify(pcm)
    }
}

/// 常驻的识别会话：原生模型加上跨 IPC 窗口累积语句的调度器。
struct NativeAsrSession {
    engine: NativeEngine,
    stream: CaptionStream,
    provider: &'static str,
}

impl NativeAsrSession {
    fn open(
        assets: &ModelAssets,
        threads: i32,
        use_gpu: bool,
        options: &AsrRuntimeOptions,
    ) -> Result<Self, String> {
        let mut asr = crispasr::Session::open(&assets.path(&ASR_MODEL), threads, use_gpu)?;
        let prompt = hotword_prompt(&options.hotwords);
        if !prompt.is_empty() {
            asr.set_hotwords(&prompt)?;
        }
        let vad = if options.vad_enabled {
            Some(crispasr::Vad::open(&assets.path(&VAD_MODEL))?)
        } else {
            None
        };
        let speaker = if options.speaker_enabled {
            Some(NativeSpeakerSession::open(&assets.path(&SPEAKER_MODEL))?)
        } else {
            None
        };
        Ok(Self {
            engine: NativeEngine { asr, vad, speaker },
            stream: CaptionStream::new(StreamConfig::for_device(
                use_gpu,
                options.vad_enabled,
                options.punctuation_enabled,
            )),
            provider: if use_gpu {
                ASR_PROVIDER_CUDA
            } else {
                ASR_PROVIDER_CPU
            },
        })
    }

    /// 丢弃缓冲的音频与 VAD 状态，使新的播放会话绝不会延续上一条 stream 的语句。
    fn reset_stream(&mut self) {
        self.stream.reset();
        if let Some(vad) = self.engine.vad.as_mut() {
            vad.reset();
        }
        if let Some(speaker) = self.engine.speaker.as_mut() {
            speaker.reset();
        }
    }

    /// 喂入一个窗口，返回其间定稿的语句与当前在途假设。
    fn transcribe(&mut self, pcm: &[f32]) -> Result<AsrTranscribeResult, String> {
        match self.stream.push(&mut self.engine, pcm) {
            Ok(output) => Ok(AsrTranscribeResult {
                segments: output.segments,
                partial: output.partial,
            }),
            Err(error) => {
                // VAD 失败后增量状态与缓冲不再对齐，整体重来。
                self.reset_stream();
                Err(error)
            }
        }
    }
}

#[derive(Clone)]
pub struct AsrManager {
    inner: Arc<AsrInner>,
}

struct AsrInner {
    model_dir: PathBuf,
    runtime_dir: PathBuf,
    assets: ModelAssets,
    status: Mutex<AsrModelStatus>,
    requested: std::sync::atomic::AtomicBool,
    request_generation: std::sync::atomic::AtomicU64,
    control: Mutex<()>,
    runtime_options: Mutex<Option<AsrRuntimeOptions>>,
    prepare_lock: tokio::sync::Mutex<()>,
    session: Mutex<Option<NativeAsrSession>>,
    /// 正在使用模型进行识别的播放器数量。
    ///
    /// 大于零时空闲看门狗不会释放会话 —— 字幕开着但媒体暂停是正常的，
    /// 不能因为暂时没有转写请求就把模型卸掉。
    streaming_count: std::sync::atomic::AtomicUsize,
    /// 最近一次转写活动的时间。会话空闲超过 `ASR_IDLE_RELEASE` 后释放。
    last_activity: Mutex<Option<std::time::Instant>>,
    /// 空闲看门狗是否已启动，避免重复 spawn。
    watchdog_started: std::sync::atomic::AtomicBool,
    /// 已收到「用户真的要看字幕」的加载需求。
    ///
    /// 资产尚未就绪时它只登记需求，由正在进行的 `enable` 准备任务在下载完成后
    /// 接着加载会话，避免两个任务同时下载同一份模型。
    load_requested: std::sync::atomic::AtomicBool,
}

impl AsrManager {
    pub fn new(app_directory: &Path) -> Self {
        let model_dir = app_directory.join("models").join("asr");
        let assets = ModelAssets::new(&model_dir);
        let runtime_dir = app_directory.join(RUNTIME_DIR_NAME);
        let default_options = AsrRuntimeOptions::default();
        let status = AsrModelStatus::new(
            &default_options,
            asset_snapshot(&assets, &runtime_dir, &default_options),
        );

        Self {
            inner: Arc::new(AsrInner {
                model_dir,
                runtime_dir,
                assets,
                status: Mutex::new(status),
                requested: std::sync::atomic::AtomicBool::new(false),
                request_generation: std::sync::atomic::AtomicU64::new(0),
                control: Mutex::new(()),
                runtime_options: Mutex::new(None),
                prepare_lock: tokio::sync::Mutex::new(()),
                session: Mutex::new(None),
                streaming_count: std::sync::atomic::AtomicUsize::new(0),
                last_activity: Mutex::new(None),
                watchdog_started: std::sync::atomic::AtomicBool::new(false),
                load_requested: std::sync::atomic::AtomicBool::new(false),
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
        route: crate::proxy::ProxyRoute,
        mut options: AsrRuntimeOptions,
    ) -> AppResult<AsrModelStatus> {
        use std::sync::atomic::Ordering;

        normalize_hotwords(&mut options.hotwords);
        if let Some(reason) = runtime::unsupported_reason() {
            self.update_status(|status| {
                status.state = AsrModelState::Unsupported;
                status.message = Some(reason.to_owned());
            });
            return self.status();
        }
        // Windows 首次启用在这里探测 GPU，下面的完整性判断才按实际需要的运行库包计算。
        #[cfg(all(windows, target_arch = "x86_64"))]
        let _ = runtime::cuda::probe();

        let _control = self
            .inner
            .control
            .lock()
            .map_err(|_| AppError::new("asr_control_lock", "语音字幕状态暂不可用"))?;
        let was_requested = self.inner.requested.swap(true, Ordering::AcqRel);
        let model_exists = self.required_assets_complete(&options);
        // 启用只保证资产就绪：识别会话等用户真的打开字幕时再加载。
        // 但用户已经在看字幕时（`load_requested`）必须保持旧行为：
        // 设置变更要重载会话而不是把它卸载成 `Idle`，否则改一次 VAD
        // 就会把正在看的字幕断掉。
        let wants_session = self.inner.load_requested.load(Ordering::Acquire);
        let next_state = if !model_exists {
            AsrModelState::Downloading
        } else if wants_session {
            AsrModelState::Loading
        } else {
            AsrModelState::Idle
        };

        let generation = {
            let mut status = self
                .inner
                .status
                .lock()
                .map_err(|_| AppError::new("asr_status_lock", "语音字幕状态暂不可用"))?;

            let same_configuration = self
                .inner
                .runtime_options
                .lock()
                .map(|current| current.as_ref() == Some(&options))
                .unwrap_or(false);
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
            self.apply_runtime_options(&mut status, &options);
            status.downloaded_bytes = self.asset_snapshot(&options).downloaded_bytes;
            status.threads = asr_thread_count();
            if let Ok(mut current) = self.inner.runtime_options.lock() {
                *current = Some(options.clone());
            }
            generation
        };

        let manager = self.clone();
        tauri::async_runtime::spawn(async move {
            manager
                .prepare_model(route, generation, options, false)
                .await;
        });

        self.status()
    }

    /// 按实际字幕需求加载会话：用户第一次打开字幕时调用。
    ///
    /// 资产尚未就绪时只登记需求，由正在进行的 `enable` 准备任务在下载完成后
    /// 接着加载，避免两个任务同时下载同一份模型。
    pub fn load_session(&self, route: crate::proxy::ProxyRoute) -> AppResult<AsrModelStatus> {
        use std::sync::atomic::Ordering;

        let _control = self
            .inner
            .control
            .lock()
            .map_err(|_| AppError::new("asr_control_lock", "语音字幕状态暂不可用"))?;
        if !self.is_requested() {
            return Err(AppError::new("asr_disabled", "语音字幕未启用"));
        }
        self.inner.load_requested.store(true, Ordering::Release);
        let options = self
            .inner
            .runtime_options
            .lock()
            .ok()
            .and_then(|options| options.clone())
            .ok_or_else(|| AppError::new("asr_not_ready", "语音字幕正在准备"))?;

        let mut status = self
            .inner
            .status
            .lock()
            .map_err(|_| AppError::new("asr_status_lock", "语音字幕状态暂不可用"))?;
        if matches!(
            status.state,
            AsrModelState::Ready
                | AsrModelState::Loading
                | AsrModelState::Downloading
                | AsrModelState::Extracting
        ) {
            // 已经在加载或正在下载：需求已登记，准备任务会接着完成。
            return Ok(status.clone());
        }
        // 资产已就绪：同步切到 Loading，使前端轮询到最终状态；
        // 真正的会话加载交给后台任务，不阻塞 IPC。
        status.state = AsrModelState::Loading;
        self.apply_runtime_options(&mut status, &options);
        status.threads = asr_thread_count();
        let generation = self.inner.request_generation.load(Ordering::Acquire);
        drop(status);

        let manager = self.clone();
        tauri::async_runtime::spawn(async move {
            manager
                .prepare_model(route, generation, options, true)
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
            self.inner.load_requested.store(false, Ordering::Release);
            if let Ok(mut options) = self.inner.runtime_options.lock() {
                *options = None;
            }
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
            // 销毁会话会释放模型占用的常驻内存，
            // 同时保留已校验的磁盘资源供下次启用使用。
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

    /// 丢弃检测器缓冲的音频但不卸载模型。播放器切换房间或线路时调用，
    /// 使字幕绝不会把两个不同会话的音频拼进同一段。
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

    /// 登记一个正在消费字幕的播放器。
    ///
    /// 字幕开着但媒体暂停、或窗口暂时不可见时不会产生转写请求，
    /// 但那不代表可以卸载模型：下一次采集随时会到来。有活动消费者时
    /// 空闲看门狗不会释放会话。
    pub fn streaming_started(&self) {
        self.inner
            .streaming_count
            .fetch_add(1, std::sync::atomic::Ordering::AcqRel);
        self.touch_activity();
    }

    /// 注销一个播放器。计数饱和到 0，重复的注销不会把后续启动变成负数。
    pub fn streaming_stopped(&self) {
        let _ = self.inner.streaming_count.fetch_update(
            std::sync::atomic::Ordering::AcqRel,
            std::sync::atomic::Ordering::Acquire,
            |count| Some(count.saturating_sub(1)),
        );
        self.touch_activity();
    }

    fn touch_activity(&self) {
        if let Ok(mut last) = self.inner.last_activity.lock() {
            *last = Some(std::time::Instant::now());
        }
    }

    /// 空闲释放：没有播放器在消费字幕，且已超过 `ASR_IDLE_RELEASE` 未发生转写时，
    /// 拆掉常驻会话、回到 `Idle`。模型文件仍留在磁盘上，下次开启字幕时按需重载。
    fn release_idle_session(&self) {
        if !self.is_requested() {
            return;
        }
        if self
            .inner
            .streaming_count
            .load(std::sync::atomic::Ordering::Acquire)
            > 0
        {
            return;
        }
        let idle_for_too_long = self
            .inner
            .last_activity
            .lock()
            .map(|last| last.is_some_and(|instant| instant.elapsed() >= ASR_IDLE_RELEASE))
            .unwrap_or(false);
        if !idle_for_too_long {
            return;
        }
        let is_ready = self
            .inner
            .status
            .lock()
            .map(|status| status.state == AsrModelState::Ready)
            .unwrap_or(false);
        if !is_ready {
            return;
        }
        let session = match self.inner.session.lock() {
            Ok(mut guard) => guard.take(),
            Err(_) => return,
        };
        if session.is_none() {
            return;
        }
        // 在锁外销毁：释放模型可能需要几百毫秒，不能阻塞其他转写请求。
        drop(session);
        // 需求也一并清掉：空闲释放之后再有设置变更不应该重新拉起会话。
        self.inner
            .load_requested
            .store(false, std::sync::atomic::Ordering::Release);
        self.update_status(|status| {
            status.state = AsrModelState::Idle;
            status.message = None;
        });
        tracing::debug!("ASR 会话因空闲已释放，下次开启字幕时按需重载");
    }

    fn start_idle_watchdog(&self) {
        if self
            .inner
            .watchdog_started
            .swap(true, std::sync::atomic::Ordering::AcqRel)
        {
            return;
        }
        let manager = self.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(ASR_IDLE_WATCHDOG_INTERVAL).await;
                let manager = manager.clone();
                // 销毁会话可能阻塞，放到阻塞线程池，避免占住运行时工作线程。
                let _ = tokio::task::spawn_blocking(move || manager.release_idle_session()).await;
            }
        });
    }

    /// 准备模型资产，并在需要时加载识别会话。
    ///
    /// `load_session` 为真表示用户确实要开字幕；为假（启用开关触发的准备）
    /// 只在资产就绪后停在 `Idle`。两者共用同一个 `prepare_lock`，
    /// 因此「启用下载中」与「用户已经点了字幕」不会同时下载同一份模型。
    async fn prepare_model(
        &self,
        route: crate::proxy::ProxyRoute,
        generation: u64,
        options: AsrRuntimeOptions,
        load_session: bool,
    ) {
        use std::sync::atomic::Ordering;

        let _prepare = self.inner.prepare_lock.lock().await;
        if !self.request_is_current(generation) {
            return;
        }

        let model_ready = match self.ensure_model_assets(&route, generation, &options).await {
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

        // 需求可能在下载期间到达（用户先开了开关，下载中又点了字幕）：
        // 资产就绪后重新读一次，避免这轮以 `Idle` 收尾而用户仍在等字幕。
        // 排队等锁期间到达的需求也由这一次读取覆盖。
        let load_session = load_session || self.inner.load_requested.load(Ordering::Acquire);

        if !load_session {
            // 资产已就绪但没有字幕需求：停在 `Idle`，不占模型内存。
            // 功能仍启用，所以不能落到 `Downloaded`（那个状态对应功能已关闭）。
            // 若此时仍持有旧会话（例如同一 generation 的设置变更恰好落在字幕
            // 关闭之后），一并释放，避免常驻会话既不服务也不再被看门狗回收。
            drop(
                self.inner
                    .session
                    .lock()
                    .ok()
                    .and_then(|mut guard| guard.take()),
            );
            self.set_idle_ready_status();
            return;
        }

        self.set_loading_status(generation, &options);
        let manager = self.clone();
        let prefer_gpu = prefers_gpu(&options.provider);
        let package =
            match tokio::task::spawn_blocking(move || manager.load_runtime(prefer_gpu)).await {
                Ok(Ok(package)) => package,
                Ok(Err(error)) => {
                    tracing::warn!(%error, "ASR runtime load failed");
                    self.set_error_status_for_request(
                        generation,
                        &format!("字幕运行库加载失败：{}", error.message),
                    );
                    return;
                }
                Err(error) => {
                    tracing::warn!(%error, "ASR runtime load task failed");
                    self.set_error_status_for_request(generation, "字幕运行库加载任务失败，请重试");
                    return;
                }
            };

        // 运行库包按硬件选定，CPU / CUDA 偏好只决定是否把模型放上 GPU。
        let use_gpu = runtime::package_has_gpu(package)
            && effective_asr_provider(&options.provider) == ASR_PROVIDER_CUDA;
        let assets = self.inner.assets.clone();
        let threads = asr_thread_count();
        let session_options = options.clone();
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
            NativeAsrSession::open(&assets, threads, use_gpu, &session_options)
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
        let active_provider = session.provider;

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
            self.apply_runtime_options(status, &options);
            status.downloaded_bytes = status.model_size_bytes;
            status.provider = active_provider.to_string();
        });
        self.touch_activity();
        self.start_idle_watchdog();
    }

    async fn ensure_model_assets(
        &self,
        route: &crate::proxy::ProxyRoute,
        generation: u64,
        options: &AsrRuntimeOptions,
    ) -> AppResult<bool> {
        if !self.request_is_current(generation) {
            return Ok(false);
        }
        // Windows 首次调用会加载 NVIDIA 驱动探测 GPU，放到阻塞线程池。
        let runtime_dir = self.inner.runtime_dir.clone();
        let prefer_gpu = prefers_gpu(&options.provider);
        let package = tokio::task::spawn_blocking(move || {
            runtime::required_package(&runtime_dir, prefer_gpu)
        })
        .await
        .map_err(|_| AppError::new("asr_runtime_probe", "字幕运行库检测失败"))?
        .map_err(|reason| AppError::new("asr_unsupported", reason))?;
        let runtime_dir = &self.inner.runtime_dir;
        let runtime_installed = package.is_installed(runtime_dir);
        let missing_models: Vec<_> = required_models(options)
            .into_iter()
            .filter(|model| !self.inner.assets.is_complete(model))
            .collect();
        if runtime_installed && missing_models.is_empty() {
            return Ok(true);
        }

        self.remove_legacy_assets().await;
        remove_stale_model_partials(&self.inner.model_dir).await;
        let total_size = configured_download_size(options, Some(package));
        let missing_size = missing_models.iter().map(|model| model.size).sum::<u64>()
            + if runtime_installed { 0 } else { package.size };
        let mut progress = total_size.saturating_sub(missing_size);
        let client = asr_download_client(route)?;

        if !runtime_installed {
            tokio::fs::create_dir_all(runtime_dir)
                .await
                .map_err(|_| AppError::new("asr_runtime_dir", "无法创建字幕运行库目录"))?;
            let archive = runtime_dir.join(package.partial_name());
            let source = download::Source {
                label: "CrispASR 运行库",
                url: &package.url(),
                size: package.size,
                sha256: package.sha256,
            };
            if !self
                .download_asset(&client, generation, &source, &archive, progress, total_size)
                .await?
            {
                return Ok(false);
            }
            self.update_status_for_request(generation, |status| {
                status.state = AsrModelState::Extracting;
                status.downloaded_bytes = progress + package.size;
                status.total_bytes = Some(total_size);
                status.message = Some("正在解压 CrispASR 运行库…".to_owned());
            });
            let runtime_root = runtime_dir.clone();
            let archive_for_install = archive.clone();
            let installed = tokio::task::spawn_blocking(move || {
                runtime::install(package, &archive_for_install, &runtime_root)
            })
            .await
            .map_err(|_| AppError::new("asr_runtime_install", "字幕运行库解压任务失败"));
            // 归档已通过校验；解压失败多半是磁盘问题，重新下载也无济于事，同样删除。
            let _ = download::remove_partial(&archive).await;
            installed??;
            progress += package.size;
            if !self.request_is_current(generation) {
                return Ok(false);
            }
        }
        // 换包（CPU ↔ CUDA）或升级后，旧包目录与未下完的旧归档不再需要。
        let runtime_root = runtime_dir.clone();
        let _ = tokio::task::spawn_blocking(move || {
            runtime::remove_stale_entries(package, &runtime_root);
        })
        .await;

        tokio::fs::create_dir_all(&self.inner.model_dir)
            .await
            .map_err(|_| AppError::new("asr_model_dir", "无法创建模型目录"))?;
        for model in missing_models {
            let target = self.inner.assets.path(model);
            let partial = self.inner.model_dir.join(model.partial_name());
            let source = download::Source {
                label: model.label,
                url: model.url,
                size: model.size,
                sha256: model.sha256,
            };
            if !self
                .download_asset(&client, generation, &source, &partial, progress, total_size)
                .await?
            {
                return Ok(false);
            }
            tokio::fs::rename(&partial, &target)
                .await
                .map_err(|_| AppError::new("asr_model_write", "模型文件替换失败"))?;
            progress += model.size;
            let speaker_downloaded = self.inner.assets.speaker_is_complete();
            self.update_status_for_request(generation, |status| {
                status.speaker_model_downloaded = speaker_downloaded;
                status.downloaded_bytes = progress;
                status.total_bytes = Some(total_size);
            });
        }

        if !self.required_assets_complete(options) {
            return Err(AppError::new("asr_model_download", "字幕模型文件不完整"));
        }
        Ok(self.request_is_current(generation))
    }

    /// 可续传地下载一个资产并把进度写进状态；`Ok(false)` 表示请求已失效。
    async fn download_asset(
        &self,
        client: &reqwest::Client,
        generation: u64,
        source: &download::Source<'_>,
        partial: &Path,
        progress_offset: u64,
        total_size: u64,
    ) -> AppResult<bool> {
        let result = download::download(
            client,
            source,
            partial,
            &|| self.request_is_current(generation),
            &mut |progress| {
                self.update_status_for_request(generation, |status| {
                    status.state = AsrModelState::Downloading;
                    status.total_bytes = Some(total_size);
                    let (written, message) = match progress {
                        download::Progress::Downloading(written) => {
                            (written, format!("正在下载 {}…", source.label))
                        }
                        download::Progress::Retrying(written) => {
                            (written, format!("网络中断，正在续传 {}…", source.label))
                        }
                        download::Progress::Verifying => (
                            status.downloaded_bytes.saturating_sub(progress_offset),
                            format!("正在校验已下载的 {}…", source.label),
                        ),
                    };
                    status.downloaded_bytes = progress_offset.saturating_add(written);
                    status.message = Some(message);
                });
            },
        )
        .await;
        if let Err(error) = &result {
            tracing::warn!(label = source.label, %error, "ASR asset download failed");
        }
        result
    }

    fn required_assets_complete(&self, options: &AsrRuntimeOptions) -> bool {
        self.asset_snapshot(options).complete
    }

    fn asset_snapshot(&self, options: &AsrRuntimeOptions) -> AssetSnapshot {
        asset_snapshot(&self.inner.assets, &self.inner.runtime_dir, options)
    }

    /// 删除旧版 sherpa-onnx 的模型与 Windows 运行库。失败只记日志，不阻断启用。
    async fn remove_legacy_assets(&self) {
        let mut targets: Vec<PathBuf> = LEGACY_MODEL_ENTRIES
            .iter()
            .map(|name| self.inner.model_dir.join(name))
            .collect();
        if let Some(app_directory) = self.inner.runtime_dir.parent() {
            let legacy_runtime = app_directory.join(LEGACY_RUNTIME_DIR_NAME);
            let marker = tokio::fs::read_to_string(legacy_runtime.join(".rlive-runtime-version"))
                .await
                .unwrap_or_default();
            if marker.starts_with(LEGACY_RUNTIME_MARKER_PREFIX) {
                targets.push(legacy_runtime);
            }
            targets.push(app_directory.join("asr-runtime.tar.bz2.part"));
            targets.push(app_directory.join("asr-runtime.extracting"));
        }
        for target in targets {
            let removed = match tokio::fs::metadata(&target).await {
                Ok(metadata) if metadata.is_dir() => tokio::fs::remove_dir_all(&target).await,
                Ok(_) => tokio::fs::remove_file(&target).await,
                Err(_) => continue,
            };
            match removed {
                Ok(()) => tracing::info!(path = %target.display(), "removed legacy ASR asset"),
                Err(error) => {
                    tracing::warn!(path = %target.display(), %error, "failed to remove legacy ASR asset");
                }
            }
        }
    }

    /// 加载已安装的运行库，返回它所属的包。进程内只加载一次。
    fn load_runtime(&self, prefer_gpu: bool) -> AppResult<&'static RuntimePackage> {
        let package = runtime::required_package(&self.inner.runtime_dir, prefer_gpu)
            .map_err(|reason| AppError::new("asr_unsupported", reason))?;
        runtime::load(package, &self.inner.runtime_dir)?;
        Ok(package)
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
        // 转写请求本身就是活动信号：即使状态恰好因竞态被空闲释放，
        // 这次记录也能让看门狗不再重复判定。
        self.touch_activity();
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

    /// 把 `options` 里与会话无关的展示字段同步进状态；`state`、`downloaded_bytes`
    /// 等随场景变化的字段由调用方自行赋值。
    fn apply_runtime_options(&self, status: &mut AsrModelStatus, options: &AsrRuntimeOptions) {
        status.speaker_enabled = options.speaker_enabled;
        status.vad_enabled = options.vad_enabled;
        status.punctuation_enabled = options.punctuation_enabled;
        status.hotwords_count = options.hotwords.len() as u32;
        // 先解析 provider：Windows 上它会完成 GPU 探测，之后的快照才按实际需要的
        // 运行库包计算体积。
        status.provider = effective_asr_provider(&options.provider).to_string();
        status.message = asr_provider_fallback_message(&options.provider);
        let snapshot = self.asset_snapshot(options);
        status.speaker_model_downloaded = snapshot.speaker_downloaded;
        status.cuda_runtime_extra_bytes = snapshot.cuda_extra_bytes;
        status.model_size_bytes = snapshot.total_bytes;
        status.total_bytes = Some(snapshot.total_bytes);
    }

    fn set_loading_status(&self, generation: u64, options: &AsrRuntimeOptions) {
        self.update_status_for_request(generation, |status| {
            status.state = AsrModelState::Loading;
            self.apply_runtime_options(status, options);
            status.downloaded_bytes = status.model_size_bytes;
        });
    }

    /// 功能关闭时的静止状态：已下载的资产保留，会话已释放。
    fn set_idle_status(&self) {
        self.update_status(|status| {
            let options = AsrRuntimeOptions {
                provider: status.provider.clone(),
                vad_enabled: status.vad_enabled,
                punctuation_enabled: status.punctuation_enabled,
                speaker_enabled: status.speaker_enabled,
                hotwords: Vec::new(),
            };
            let snapshot = self.asset_snapshot(&options);
            status.state = if snapshot.complete {
                AsrModelState::Downloaded
            } else {
                AsrModelState::NotDownloaded
            };
            status.speaker_model_downloaded = snapshot.speaker_downloaded;
            status.cuda_runtime_extra_bytes = snapshot.cuda_extra_bytes;
            status.model_size_bytes = snapshot.total_bytes;
            status.downloaded_bytes = snapshot.downloaded_bytes;
            status.total_bytes = Some(snapshot.total_bytes);
            // 关闭功能时不要为了写状态文案去探测 CUDA：用户刚刚选择不用它。
            status.provider = asr_provider_placeholder(&options.provider);
            status.message = None;
        });
    }

    /// 功能仍启用、资产已就绪、但会话未加载（或刚被空闲释放）。
    /// 与 `set_idle_status` 的区别只在 `state`：这里保持 `Idle`，
    /// 让前端知道点字幕即可加载，而不是让用户重新下载。
    fn set_idle_ready_status(&self) {
        self.update_status(|status| {
            status.state = AsrModelState::Idle;
            status.speaker_model_downloaded = self.inner.assets.speaker_is_complete();
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

/// 解码经 Tauri IPC 传输的、长度受限的小端 f32 PCM。
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

    let (samples, _) = bytes.as_chunks::<{ std::mem::size_of::<f32>() }>();
    let pcm: Vec<f32> = samples.iter().copied().map(f32::from_le_bytes).collect();
    if pcm.iter().any(|sample| !sample.is_finite()) {
        return Err(AppError::new("asr_pcm_decode", "音频片段包含无效采样"));
    }
    Ok(pcm)
}

fn normalize_hotwords(hotwords: &mut Vec<String>) {
    let mut seen = std::collections::HashSet::new();
    hotwords.retain_mut(|word| {
        *word = word
            .chars()
            .filter(|character| !character.is_control())
            .collect::<String>()
            .trim()
            .to_owned();
        if word.is_empty() || word.chars().count() > 80 {
            return false;
        }
        seen.insert(word.to_lowercase())
    });
    hotwords.truncate(100);
}

/// Qwen3-ASR 把热词拼进提示词作为上下文。词条以逗号分隔，词条内部的逗号换成空格，
/// 避免把一个词拆成两个。热词越多提示词越长，每次解码的预填充开销也越大。
fn hotword_prompt(hotwords: &[String]) -> String {
    hotwords
        .iter()
        .map(|word| {
            word.replace([',', '，'], " ")
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
        })
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>()
        .join(", ")
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

fn normalize_asr_provider(value: &str) -> &'static str {
    match value.trim().to_ascii_lowercase().as_str() {
        ASR_PROVIDER_CPU => ASR_PROVIDER_CPU,
        ASR_PROVIDER_CUDA => ASR_PROVIDER_CUDA,
        _ => ASR_PROVIDER_AUTO,
    }
}

/// 偏好不是 CPU：Windows 上据此决定是否需要 CUDA 运行库包。
fn prefers_gpu(preference: &str) -> bool {
    normalize_asr_provider(preference) != ASR_PROVIDER_CPU
}

/// 进程内已加载不带 GPU 后端的包：要重启应用才能换成 CUDA 包。
#[cfg(all(windows, target_arch = "x86_64"))]
fn loaded_cpu_only_package() -> bool {
    runtime::loaded().is_some_and(|package| !runtime::package_has_gpu(package))
}

fn effective_asr_provider(preference: &str) -> &'static str {
    #[cfg(all(windows, target_arch = "x86_64"))]
    {
        match normalize_asr_provider(preference) {
            ASR_PROVIDER_CPU => ASR_PROVIDER_CPU,
            _ if loaded_cpu_only_package() => ASR_PROVIDER_CPU,
            _ if runtime::cuda::probe().is_some_and(runtime::cuda::GpuProbe::usable) => {
                ASR_PROVIDER_CUDA
            }
            _ => ASR_PROVIDER_CPU,
        }
    }
    #[cfg(not(all(windows, target_arch = "x86_64")))]
    {
        let _ = preference;
        ASR_PROVIDER_CPU
    }
}

/// 不触发 CUDA 探测的 provider 展示值。
///
/// `effective_asr_provider` 在 Windows 上会加载 `nvcuda.dll` 查询 GPU；
/// 那是「真正启用」才该付的代价。应用启动时的状态快照只需要一个占位值，
/// 解析留给 `enable`。
fn asr_provider_placeholder(preference: &str) -> String {
    if cfg!(all(windows, target_arch = "x86_64")) {
        normalize_asr_provider(preference).to_string()
    } else {
        ASR_PROVIDER_CPU.to_string()
    }
}

fn asr_provider_fallback_message(preference: &str) -> Option<String> {
    #[cfg(all(windows, target_arch = "x86_64"))]
    {
        let normalized = normalize_asr_provider(preference);
        if normalized == ASR_PROVIDER_CPU || effective_asr_provider(normalized) != ASR_PROVIDER_CPU
        {
            None
        } else if runtime::cuda::probe().is_some_and(runtime::cuda::GpuProbe::usable) {
            Some("本次运行已加载 CPU 运行库，重启应用后改用 CUDA".to_owned())
        } else {
            Some(runtime::cuda::fallback_message())
        }
    }
    #[cfg(not(all(windows, target_arch = "x86_64")))]
    {
        let _ = preference;
        None
    }
}

fn asr_thread_count_for_available(available: usize) -> i32 {
    available.clamp(1, ASR_THREAD_LIMIT) as i32
}

fn file_len(path: &Path) -> Option<u64> {
    let metadata = path.metadata().ok()?;
    metadata.is_file().then_some(metadata.len())
}

fn asr_download_client(route: &crate::proxy::ProxyRoute) -> AppResult<reqwest::Client> {
    use std::time::Duration;

    crate::http_client::with_route(
        reqwest::Client::builder()
            .use_native_tls()
            .connect_timeout(Duration::from_secs(15))
            // Reqwest 默认没有总超时。在数百 MiB 的模型与运行库传输过程中，
            // 按读取设置的超时仍能捕捉到卡死的连接。
            .read_timeout(Duration::from_secs(60))
            .user_agent("rLive ASR model downloader"),
        route,
    )?
    .build()
    .map_err(|_| AppError::new("asr_http_client", "模型下载客户端初始化失败"))
}

/// 删除不属于当前任何模型的 `.part`（固定版本更换后留下的半截文件）。
async fn remove_stale_model_partials(model_dir: &Path) {
    let keep: Vec<String> = [&ASR_MODEL, &VAD_MODEL, &SPEAKER_MODEL]
        .iter()
        .map(|model| model.partial_name())
        .collect();
    let Ok(mut entries) = tokio::fs::read_dir(model_dir).await else {
        return;
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.ends_with(".part")
            && !keep.contains(&name)
            && let Err(error) = tokio::fs::remove_file(entry.path()).await
        {
            tracing::warn!(path = %entry.path().display(), %error, "failed to remove stale ASR partial");
        }
    }
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "linux")]
    use super::effective_asr_provider;
    use super::{
        ASR_MODEL, AsrRuntimeOptions, SPEAKER_MODEL, SpeakerClusters, VAD_MODEL,
        asr_thread_count_for_available, configured_download_size, decode_base64_pcm,
        hotword_prompt, normalize_asr_provider, normalize_hotwords,
    };
    use base64::Engine;

    #[test]
    fn decodes_little_endian_pcm() {
        let input = base64::engine::general_purpose::STANDARD.encode([
            0_u8, 0, 128, 63, // 1.0f32 小端
            0, 0, 0, 191, // -0.5f32 小端
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
    fn caps_asr_at_eight_threads() {
        assert_eq!(asr_thread_count_for_available(0), 1);
        assert_eq!(asr_thread_count_for_available(1), 1);
        assert_eq!(asr_thread_count_for_available(8), 8);
        assert_eq!(asr_thread_count_for_available(16), 8);
    }

    #[test]
    fn normalizes_unknown_asr_provider_to_auto() {
        assert_eq!(normalize_asr_provider("cuda"), "cuda");
        assert_eq!(normalize_asr_provider("CPU"), "cpu");
        assert_eq!(normalize_asr_provider("driver-dependent"), "auto");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn always_uses_cpu_provider_on_linux() {
        assert_eq!(effective_asr_provider("auto"), "cpu");
        assert_eq!(effective_asr_provider("cuda"), "cpu");
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
    fn keeps_the_previous_speaker_for_an_ambiguous_embedding() {
        let mut clusters = SpeakerClusters::default();
        assert_eq!(clusters.classify(&[1.0, 0.0]), Some(1));
        assert_eq!(clusters.classify(&[0.5, 0.866]), Some(1));
        assert_eq!(clusters.clusters.len(), 1);
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
    fn download_size_follows_the_optional_models() {
        let default_options = AsrRuntimeOptions::default();
        assert_eq!(
            configured_download_size(&default_options, None),
            ASR_MODEL.size + VAD_MODEL.size
        );
        let vad_off = AsrRuntimeOptions {
            vad_enabled: false,
            ..default_options.clone()
        };
        assert_eq!(configured_download_size(&vad_off, None), ASR_MODEL.size);
        let speaker_on = AsrRuntimeOptions {
            speaker_enabled: true,
            ..default_options
        };
        assert_eq!(
            configured_download_size(&speaker_on, None),
            ASR_MODEL.size + VAD_MODEL.size + SPEAKER_MODEL.size
        );
    }

    #[test]
    fn joins_hotwords_without_splitting_an_entry() {
        assert_eq!(hotword_prompt(&[]), "");
        assert_eq!(
            hotword_prompt(&["主播昵称".into(), "Faker, T1".into(), "一，二".into()]),
            "主播昵称, Faker T1, 一 二"
        );
    }

    /// 用真实运行库与模型跑完整链路：安装归档 → 加载 → VAD 分句 → 识别 → 声纹。
    /// `RLIVE_CRISPASR_ARCHIVE` 指向本平台的运行库归档，`RLIVE_CRISPASR_MODELS`
    /// 是含三个模型文件的目录，`RLIVE_CRISPASR_WAV` 是 16 kHz 单声道 s16 WAV。
    #[test]
    #[ignore = "需要真实 CrispASR 运行库与模型"]
    fn crispasr_end_to_end() {
        let env = |name: &str| std::path::PathBuf::from(std::env::var_os(name).expect(name));
        let runtime_root = std::env::temp_dir().join(format!(
            "rlive-crispasr-e2e-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let package = super::runtime::required_package(&runtime_root, false).unwrap();
        super::runtime::install(package, &env("RLIVE_CRISPASR_ARCHIVE"), &runtime_root).unwrap();
        super::runtime::load(package, &runtime_root).unwrap();

        let options = AsrRuntimeOptions {
            speaker_enabled: true,
            hotwords: vec!["rLive".into()],
            ..AsrRuntimeOptions::default()
        };
        let assets = super::ModelAssets::new(&env("RLIVE_CRISPASR_MODELS"));
        let mut session = super::NativeAsrSession::open(&assets, 8, false, &options).unwrap();

        let wav = std::fs::read(env("RLIVE_CRISPASR_WAV")).unwrap();
        let data = wav.windows(4).position(|window| window == b"data").unwrap() + 8;
        let (samples, _) = wav[data..].as_chunks::<2>();
        let pcm: Vec<f32> = samples
            .iter()
            .map(|sample| i16::from_le_bytes(*sample) as f32 / 32_768.0)
            .collect();

        let mut segments = Vec::new();
        let mut partials = 0;
        for chunk in pcm.chunks(3_200) {
            let result = session.transcribe(chunk).unwrap();
            partials += usize::from(result.partial.is_some());
            segments.extend(result.segments);
        }
        segments.extend(session.transcribe(&vec![0.0; 32_000]).unwrap().segments);
        for segment in &segments {
            println!(
                "[{:>6}-{:>6}] S{:?} {}",
                segment.start_ms, segment.end_ms, segment.speaker_id, segment.text
            );
        }
        std::fs::remove_dir_all(&runtime_root).unwrap();

        assert!(partials > 0);
        assert!(segments.len() >= 5, "only {} segments", segments.len());
        assert!(
            segments
                .iter()
                .all(|segment| !segment.text.trim().is_empty())
        );
        assert!(segments.iter().all(|segment| segment.speaker_id.is_some()));
    }

    #[test]
    fn normalizes_and_bounds_local_hotwords() {
        let mut hotwords = vec![
            " 主播昵称 ".to_string(),
            "主播昵称".to_string(),
            "GAME".to_string(),
            "game".to_string(),
            "\t".to_string(),
        ];
        normalize_hotwords(&mut hotwords);
        assert_eq!(hotwords, vec!["主播昵称", "GAME"]);
    }
}
