//! CrispASR C ABI 的最小运行时绑定。
//!
//! 运行库不是构建输入：首次启用字幕时才从 CrispASR release 下载到应用数据目录，
//! 这里用 `libloading` 按绝对路径加载并常驻到进程结束（ggml 的 GPU 后端不支持
//! 安全卸载）。只声明 rLive 用到的符号：Qwen3-ASR 会话、Silero VAD 增量打分，
//! 以及 TitaNet 说话人嵌入。

use std::ffi::{CStr, CString, c_char, c_int, c_void};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use libloading::Library;

/// `crispasr_open_params_v1`，`abi_version = 2` 时启用 flash_attn 与 n_gpu_layers。
#[repr(C)]
struct OpenParams {
    abi_version: c_int,
    n_threads: c_int,
    use_gpu: c_int,
    verbosity: c_int,
    flash_attn: c_int,
    n_gpu_layers: c_int,
    reserved: [c_int; 6],
}

/// `whisper_vad_context_params`，按值传递。
#[repr(C)]
struct VadContextParams {
    n_threads: c_int,
    use_gpu: bool,
    gpu_device: c_int,
}

type SessionOpen =
    unsafe extern "C" fn(*const c_char, *const c_char, *const OpenParams) -> *mut c_void;
type SessionClose = unsafe extern "C" fn(*mut c_void);
type SessionTranscribe = unsafe extern "C" fn(*mut c_void, *const f32, c_int) -> *mut c_void;
type SessionSetHotwords = unsafe extern "C" fn(*mut c_void, *const c_char, f32) -> c_int;
type ResultSegments = unsafe extern "C" fn(*mut c_void) -> c_int;
type ResultSegmentText = unsafe extern "C" fn(*mut c_void, c_int) -> *const c_char;
type ResultFree = unsafe extern "C" fn(*mut c_void);
type VadInit = unsafe extern "C" fn(*const c_char, VadContextParams) -> *mut c_void;
type VadDetect = unsafe extern "C" fn(*mut c_void, *const f32, c_int) -> bool;
type VadProbCount = unsafe extern "C" fn(*mut c_void) -> c_int;
type VadProbs = unsafe extern "C" fn(*mut c_void) -> *const f32;
type VadFree = unsafe extern "C" fn(*mut c_void);
type TitanetInit = unsafe extern "C" fn(*const c_char, i32) -> *mut c_void;
type TitanetEmbed = unsafe extern "C" fn(*mut c_void, *const f32, i32, *mut f32) -> i32;
type TitanetFree = unsafe extern "C" fn(*mut c_void);

struct Api {
    session_open: SessionOpen,
    session_close: SessionClose,
    session_transcribe: SessionTranscribe,
    session_set_hotwords: SessionSetHotwords,
    result_segments: ResultSegments,
    result_segment_text: ResultSegmentText,
    result_free: ResultFree,
    vad_init: VadInit,
    vad_detect: VadDetect,
    vad_detect_continue: VadDetect,
    vad_prob_count: VadProbCount,
    vad_probs: VadProbs,
    vad_free: VadFree,
    titanet_init: TitanetInit,
    titanet_embed: TitanetEmbed,
    titanet_free: TitanetFree,
}

struct LoadedRuntime {
    path: PathBuf,
    api: Api,
    _library: Library,
}

static RUNTIME: OnceLock<LoadedRuntime> = OnceLock::new();

/// TitaNet-Large 输出 192 维；缓冲区留足余量，按返回的维数截取。
const SPEAKER_EMBEDDING_CAPACITY: usize = 1024;

/// 加载 `library` 并解析全部符号。一个进程只加载一次：再次调用同一路径直接返回，
/// 换路径（例如 CPU 包换成 CUDA 包）需要重启应用。
pub fn load(library: &Path) -> Result<(), String> {
    if let Some(loaded) = RUNTIME.get() {
        return if loaded.path == library {
            Ok(())
        } else {
            Err(format!(
                "已加载 {}，切换运行库需要重启应用",
                loaded.path.display()
            ))
        };
    }
    let handle = open_library(library)?;
    let api = unsafe { resolve(&handle) }?;
    let _ = RUNTIME.set(LoadedRuntime {
        path: library.to_path_buf(),
        api,
        _library: handle,
    });
    Ok(())
}

fn api() -> Result<&'static Api, String> {
    RUNTIME
        .get()
        .map(|loaded| &loaded.api)
        .ok_or_else(|| "CrispASR runtime is not loaded".to_string())
}

#[cfg(windows)]
fn open_library(path: &Path) -> Result<Library, String> {
    use libloading::os::windows::{
        LOAD_LIBRARY_SEARCH_DEFAULT_DIRS, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR,
        Library as WindowsLibrary,
    };
    // 依赖（ggml*.dll、CUDA 运行库）与 crispasr.dll 同目录，从 DLL 所在目录与系统目录解析，
    // 不搜索 PATH 或当前目录，避免误用系统里别的 ggml / CUDA 版本。
    unsafe {
        WindowsLibrary::load_with_flags(
            path,
            LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS,
        )
    }
    .map(Library::from)
    .map_err(|error| format!("加载 {} 失败：{error}", path.display()))
}

#[cfg(unix)]
fn open_library(path: &Path) -> Result<Library, String> {
    use libloading::os::unix::{Library as UnixLibrary, RTLD_LOCAL, RTLD_NOW};
    // 运行库自带 `$ORIGIN` / `@loader_path` 搜索路径，同目录的依赖由动态链接器解析。
    unsafe { UnixLibrary::open(Some(path), RTLD_NOW | RTLD_LOCAL) }
        .map(Library::from)
        .map_err(|error| format!("加载 {} 失败：{error}", path.display()))
}

unsafe fn resolve(library: &Library) -> Result<Api, String> {
    unsafe fn symbol<T: Copy>(library: &Library, name: &[u8]) -> Result<T, String> {
        unsafe { library.get::<T>(name) }.map(|symbol| *symbol).map_err(|error| {
            let name = String::from_utf8_lossy(&name[..name.len().saturating_sub(1)]);
            format!("运行库缺少 {name}：{error}")
        })
    }
    unsafe {
        Ok(Api {
            session_open: symbol(library, b"crispasr_session_open_with_params\0")?,
            session_close: symbol(library, b"crispasr_session_close\0")?,
            session_transcribe: symbol(library, b"crispasr_session_transcribe\0")?,
            session_set_hotwords: symbol(library, b"crispasr_session_set_hotwords\0")?,
            result_segments: symbol(library, b"crispasr_session_result_n_segments\0")?,
            result_segment_text: symbol(library, b"crispasr_session_result_segment_text\0")?,
            result_free: symbol(library, b"crispasr_session_result_free\0")?,
            vad_init: symbol(library, b"whisper_vad_init_from_file_with_params\0")?,
            vad_detect: symbol(library, b"whisper_vad_detect_speech\0")?,
            vad_detect_continue: symbol(library, b"whisper_vad_detect_speech_continue\0")?,
            vad_prob_count: symbol(library, b"whisper_vad_n_probs\0")?,
            vad_probs: symbol(library, b"whisper_vad_probs\0")?,
            vad_free: symbol(library, b"whisper_vad_free\0")?,
            titanet_init: symbol(library, b"crispasr_titanet_init\0")?,
            titanet_embed: symbol(library, b"crispasr_titanet_embed\0")?,
            titanet_free: symbol(library, b"crispasr_titanet_free\0")?,
        })
    }
}

fn path_cstring(path: &Path) -> Result<CString, String> {
    CString::new(path.to_string_lossy().into_owned())
        .map_err(|_| format!("路径包含 NUL：{}", path.display()))
}

fn sample_count(pcm: &[f32]) -> Result<c_int, String> {
    c_int::try_from(pcm.len()).map_err(|_| "音频片段过长".to_string())
}

/// 一个 Qwen3-ASR 识别会话。
pub struct Session {
    handle: *mut c_void,
}

// 会话只在 `AsrManager` 的 Mutex 下使用，同一时刻只有一个线程调用。
unsafe impl Send for Session {}

impl Session {
    pub fn open(model: &Path, threads: i32, use_gpu: bool) -> Result<Self, String> {
        let api = api()?;
        let model = path_cstring(model)?;
        let params = OpenParams {
            abi_version: 2,
            n_threads: threads.max(1),
            use_gpu: c_int::from(use_gpu),
            verbosity: 0,
            flash_attn: 1,
            n_gpu_layers: -1,
            reserved: [0; 6],
        };
        let handle = unsafe { (api.session_open)(model.as_ptr(), c"qwen3".as_ptr(), &params) };
        if handle.is_null() {
            return Err("CrispASR could not open the Qwen3-ASR model".to_string());
        }
        Ok(Self { handle })
    }

    /// 以自动语言识别转写一段 16 kHz 单声道 PCM。Qwen3 自带标点；
    /// 纯噪声通常返回空串。
    pub fn transcribe(&mut self, pcm: &[f32]) -> Result<String, String> {
        let api = api()?;
        let samples = sample_count(pcm)?;
        let result = unsafe { (api.session_transcribe)(self.handle, pcm.as_ptr(), samples) };
        if result.is_null() {
            return Err("CrispASR transcription failed".to_string());
        }
        let count = unsafe { (api.result_segments)(result) }.max(0);
        let mut text = String::new();
        for index in 0..count {
            let segment = unsafe { (api.result_segment_text)(result, index) };
            if !segment.is_null() {
                text.push_str(&unsafe { CStr::from_ptr(segment) }.to_string_lossy());
            }
        }
        unsafe { (api.result_free)(result) };
        Ok(text)
    }

    /// 设置热词。Qwen3 把它们写进系统提示词（"The following words may appear in the
    /// audio: …"），逗号分隔；空串清除。
    pub fn set_hotwords(&mut self, hotwords: &str) -> Result<(), String> {
        let api = api()?;
        let hotwords = CString::new(hotwords).map_err(|_| "热词包含 NUL".to_string())?;
        let status = unsafe { (api.session_set_hotwords)(self.handle, hotwords.as_ptr(), 0.0) };
        if status != 0 {
            return Err(format!("CrispASR rejected hotwords ({status})"));
        }
        Ok(())
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        if let Ok(api) = api() {
            unsafe { (api.session_close)(self.handle) };
        }
    }
}

/// 常驻的 Silero VAD 上下文，逐帧（512 采样）增量打分。
pub struct Vad {
    handle: *mut c_void,
    started: bool,
}

unsafe impl Send for Vad {}

impl Vad {
    pub fn open(model: &Path) -> Result<Self, String> {
        let api = api()?;
        let model = path_cstring(model)?;
        // VAD 图很小，单线程最快；始终在 CPU 上跑，不和识别模型争 GPU。
        let params = VadContextParams {
            n_threads: 1,
            use_gpu: false,
            gpu_device: 0,
        };
        let handle = unsafe { (api.vad_init)(model.as_ptr(), params) };
        if handle.is_null() {
            return Err("CrispASR could not load the Silero VAD model".to_string());
        }
        Ok(Self {
            handle,
            started: false,
        })
    }

    /// 给整帧对齐的 `pcm` 打分，返回每帧的语音概率。首次调用重置 LSTM 状态，
    /// 之后延续上一次的状态与波形上下文；分批打分与一次性打分结果一致。
    pub fn score(&mut self, pcm: &[f32]) -> Result<Vec<f32>, String> {
        if pcm.is_empty() {
            return Ok(Vec::new());
        }
        let api = api()?;
        let samples = sample_count(pcm)?;
        let detect = if self.started {
            api.vad_detect_continue
        } else {
            api.vad_detect
        };
        if !unsafe { detect(self.handle, pcm.as_ptr(), samples) } {
            return Err("CrispASR VAD inference failed".to_string());
        }
        self.started = true;
        let count = usize::try_from(unsafe { (api.vad_prob_count)(self.handle) }).unwrap_or(0);
        let probs = unsafe { (api.vad_probs)(self.handle) };
        if count == 0 || probs.is_null() {
            return Ok(Vec::new());
        }
        Ok(unsafe { std::slice::from_raw_parts(probs, count) }.to_vec())
    }

    /// 下一次打分从干净的状态开始。
    pub fn reset(&mut self) {
        self.started = false;
    }
}

impl Drop for Vad {
    fn drop(&mut self) {
        if let Ok(api) = api() {
            unsafe { (api.vad_free)(self.handle) };
        }
    }
}

/// TitaNet-Large 说话人嵌入（CPU）。
pub struct SpeakerEmbedder {
    handle: *mut c_void,
    buffer: Vec<f32>,
}

unsafe impl Send for SpeakerEmbedder {}

impl SpeakerEmbedder {
    pub fn open(model: &Path, threads: i32) -> Result<Self, String> {
        let api = api()?;
        let model = path_cstring(model)?;
        let handle = unsafe { (api.titanet_init)(model.as_ptr(), threads.max(1)) };
        if handle.is_null() {
            return Err("CrispASR could not load the TitaNet speaker model".to_string());
        }
        Ok(Self {
            handle,
            buffer: vec![0.0; SPEAKER_EMBEDDING_CAPACITY],
        })
    }

    pub fn embed(&mut self, pcm: &[f32]) -> Option<Vec<f32>> {
        let api = api().ok()?;
        let samples = i32::try_from(pcm.len()).ok()?;
        let dim = unsafe {
            (api.titanet_embed)(self.handle, pcm.as_ptr(), samples, self.buffer.as_mut_ptr())
        };
        let dim = usize::try_from(dim).ok()?;
        (dim > 0 && dim <= self.buffer.len()).then(|| self.buffer[..dim].to_vec())
    }
}

impl Drop for SpeakerEmbedder {
    fn drop(&mut self) {
        if let Ok(api) = api() {
            unsafe { (api.titanet_free)(self.handle) };
        }
    }
}
