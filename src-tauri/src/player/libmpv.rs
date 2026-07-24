//! Windows in-process libmpv backend (dynamically loaded).
//!
//! Default playback path on Windows. No external `mpv.exe` child process.

#![cfg(windows)]

use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::OnceLock;

use tauri::WebviewWindow;
use windows::core::PCWSTR;
use windows::Win32::Foundation::{GetLastError, HMODULE};
use windows::Win32::System::LibraryLoader::{
    GetProcAddress, LoadLibraryExW, LoadLibraryW, LOAD_WITH_ALTERED_SEARCH_PATH,
};

use crate::error::{AppError, AppResult};
use crate::player::embed_host::EmbedHost;
use crate::player::engine::{MediaEngine, OpenRequest};
use crate::player::events as player_events;
use crate::player::{format_mpv_headers, EmbedMode, PlayerBounds, PlayerMode};

/// Opaque mpv client handle. libmpv is thread-safe for the command surface we use.
#[derive(Clone, Copy)]
struct MpvHandle(*mut c_void);
// SAFETY: We only call documented thread-safe libmpv entry points, and the
// handle is owned exclusively by [`LibMpvEngine`] under a mutex in PlayerManager.
unsafe impl Send for MpvHandle {}

type MpvCreate = unsafe extern "C" fn() -> *mut c_void;
type MpvInitialize = unsafe extern "C" fn(*mut c_void) -> c_int;
type MpvTerminateDestroy = unsafe extern "C" fn(*mut c_void);
type MpvSetOptionString =
    unsafe extern "C" fn(*mut c_void, *const c_char, *const c_char) -> c_int;
type MpvSetPropertyString =
    unsafe extern "C" fn(*mut c_void, *const c_char, *const c_char) -> c_int;
type MpvCommand = unsafe extern "C" fn(*mut c_void, *const *const c_char) -> c_int;
type MpvCommandString = unsafe extern "C" fn(*mut c_void, *const c_char) -> c_int;
type MpvWaitEvent = unsafe extern "C" fn(*mut c_void, f64) -> *mut MpvEvent;

#[repr(C)]
struct MpvEvent {
    event_id: c_int,
    error: c_int,
    reply_userdata: u64,
    data: *mut c_void,
}

#[repr(C)]
struct MpvEventEndFile {
    reason: c_int,
    error: c_int,
    // remaining fields ignored
}

// mpv_event_id subset we care about
const MPV_EVENT_NONE: c_int = 0;
const MPV_EVENT_SHUTDOWN: c_int = 1;
const MPV_EVENT_END_FILE: c_int = 7;
const MPV_EVENT_FILE_LOADED: c_int = 8;
const MPV_EVENT_PLAYBACK_RESTART: c_int = 21;
// mpv_end_file_reason
const MPV_END_FILE_REASON_EOF: c_int = 0;
const MPV_END_FILE_REASON_ERROR: c_int = 3;

struct LibMpvApi {
    _module: HMODULE,
    create: MpvCreate,
    initialize: MpvInitialize,
    terminate_destroy: MpvTerminateDestroy,
    set_option_string: MpvSetOptionString,
    set_property_string: MpvSetPropertyString,
    command: MpvCommand,
    command_string: MpvCommandString,
    wait_event: MpvWaitEvent,
}

// SAFETY: libmpv documents concurrent command use from multiple threads as OK
// for the core API we call; we only load the DLL once.
unsafe impl Send for LibMpvApi {}
unsafe impl Sync for LibMpvApi {}

static LIBMPV: OnceLock<Result<LibMpvApi, String>> = OnceLock::new();

fn wide(path: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    path.as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

fn load_libmpv() -> Result<&'static LibMpvApi, AppError> {
    let slot = LIBMPV.get_or_init(|| match load_libmpv_inner() {
        Ok(api) => Ok(api),
        Err(e) => Err(e),
    });
    match slot {
        Ok(api) => Ok(api),
        Err(e) => Err(AppError::new("libmpv_load_error", e.clone()).retryable()),
    }
}

fn push_dll_names(dir: &Path, out: &mut Vec<PathBuf>) {
    for name in ["libmpv-2.dll", "mpv-2.dll", "mpv-1.dll", "libmpv.dll"] {
        out.push(dir.join(name));
    }
}

fn collect_libmpv_candidates() -> Vec<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    // Explicit override (full path to the DLL).
    if let Ok(p) = std::env::var("RLIVE_LIBMPV") {
        let p = p.trim();
        if !p.is_empty() {
            candidates.push(PathBuf::from(p));
        }
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            // Primary: next to rlive.exe (release / dev layout).
            push_dll_names(dir, &mut candidates);
            // Optional vendored layout: <root>/vendor/libmpv-windows/
            // exe is typically <root>/src-tauri/target/release/rlive.exe
            if let Some(root) = dir
                .parent() // release
                .and_then(|p| p.parent()) // target
                .and_then(|p| p.parent()) // src-tauri
                .and_then(|p| p.parent())
            {
                push_dll_names(&root.join("vendor").join("libmpv-windows"), &mut candidates);
            }
        }
    }

    // Next to configured / discovered mpv.exe installs (player packages rarely
    // ship libmpv, but dev drops and scoop builds sometimes do).
    for mpv_exe in [
        r"D:\dev\tools\mpv\mpv.exe",
        r"D:\mpv\mpv.exe",
        r"C:\mpv\mpv.exe",
        r"C:\Program Files\mpv\mpv.exe",
        r"C:\Program Files\MPV Player\mpv.exe",
    ] {
        if let Some(dir) = Path::new(mpv_exe).parent() {
            push_dll_names(dir, &mut candidates);
        }
    }
    candidates.extend([
        PathBuf::from(r"D:\dev\tools\mpv\libmpv-2.dll"),
        PathBuf::from(r"D:\dev\tools\mpv\mpv-2.dll"),
        PathBuf::from(r"D:\mpv\libmpv-2.dll"),
        PathBuf::from(r"C:\mpv\libmpv-2.dll"),
        PathBuf::from(r"C:\Program Files\mpv\libmpv-2.dll"),
        PathBuf::from(r"C:\Program Files\MPV Player\libmpv-2.dll"),
    ]);
    if let Some(home) = dirs::home_dir() {
        push_dll_names(&home.join(r"scoop\apps\mpv\current"), &mut candidates);
    }

    // Bare names — standard loader search path / PATH.
    candidates.push(PathBuf::from("libmpv-2.dll"));
    candidates.push(PathBuf::from("mpv-2.dll"));

    // De-dupe while preserving order.
    let mut seen = std::collections::HashSet::new();
    candidates.retain(|p| seen.insert(p.clone()));
    candidates
}

fn load_library_candidate(path: &Path) -> Result<HMODULE, String> {
    let w = wide(path);
    // Absolute paths: search the DLL's directory for its dependencies.
    let module = if path.is_absolute() {
        unsafe { LoadLibraryExW(PCWSTR(w.as_ptr()), None, LOAD_WITH_ALTERED_SEARCH_PATH) }
    } else {
        unsafe { LoadLibraryW(PCWSTR(w.as_ptr())) }
    };
    match module {
        Ok(m) if !m.is_invalid() => Ok(m),
        Ok(_) | Err(_) => {
            let code = unsafe { GetLastError() }.0;
            let exists = path.exists();
            Err(format!(
                "LoadLibrary failed for {} (exists={exists}, winerr={code})",
                path.display()
            ))
        }
    }
}

fn load_libmpv_inner() -> Result<LibMpvApi, String> {
    let candidates = collect_libmpv_candidates();
    let mut errors: Vec<String> = Vec::new();

    for path in &candidates {
        let module = match load_library_candidate(path) {
            Ok(m) => m,
            Err(e) => {
                // Only keep failures for paths that exist (or the bare names) to
                // keep the final error readable.
                if path.exists() || path.components().count() == 1 {
                    errors.push(e);
                }
                continue;
            }
        };

        unsafe fn sym<T>(module: HMODULE, name: &[u8]) -> Result<T, String> {
            let p = GetProcAddress(module, windows::core::PCSTR(name.as_ptr()));
            let p = p.ok_or_else(|| {
                format!(
                    "missing symbol {}",
                    String::from_utf8_lossy(&name[..name.len().saturating_sub(1)])
                )
            })?;
            Ok(std::mem::transmute_copy(&p))
        }

        let api = unsafe {
            match (|| -> Result<LibMpvApi, String> {
                Ok(LibMpvApi {
                    _module: module,
                    create: sym(module, b"mpv_create\0")?,
                    initialize: sym(module, b"mpv_initialize\0")?,
                    terminate_destroy: sym(module, b"mpv_terminate_destroy\0")?,
                    set_option_string: sym(module, b"mpv_set_option_string\0")?,
                    set_property_string: sym(module, b"mpv_set_property_string\0")?,
                    command: sym(module, b"mpv_command\0")?,
                    command_string: sym(module, b"mpv_command_string\0")?,
                    wait_event: sym(module, b"mpv_wait_event\0")?,
                })
            })() {
                Ok(api) => api,
                Err(e) => {
                    // Leave the module loaded; failed candidates are rare and
                    // FreeLibrary is not always available under our windows-rs feature set.
                    errors.push(format!("{}: {e}", path.display()));
                    continue;
                }
            }
        };
        tracing::info!(path = %path.display(), "loaded libmpv");
        return Ok(api);
    }

    if errors.is_empty() {
        Err(
            "libmpv DLL not found. Place libmpv-2.dll next to rlive.exe \
             (or run scripts/fetch-libmpv-windows.sh)."
                .into(),
        )
    } else {
        Err(format!(
            "libmpv load failed (tried {} candidates). {}",
            candidates.len(),
            errors.join(" | ")
        ))
    }
}

fn cstr(s: &str) -> AppResult<CString> {
    CString::new(s).map_err(|e| AppError::new("libmpv_cstring", e.to_string()))
}

pub struct LibMpvEngine {
    handle: Option<MpvHandle>,
    host: Option<EmbedHost>,
    running: AtomicBool,
    paused: AtomicBool,
    volume: AtomicU8,
    mode: PlayerMode,
    bounds: Option<PlayerBounds>,
    last_url: String,
    dll_path_label: String,
    /// Stops the wait_event observer for the previous handle.
    observer_stop: Option<std::sync::Arc<AtomicBool>>,
    observer_join: Option<std::thread::JoinHandle<()>>,
}

impl Default for LibMpvEngine {
    fn default() -> Self {
        Self {
            handle: None,
            host: None,
            running: AtomicBool::new(false),
            paused: AtomicBool::new(false),
            volume: AtomicU8::new(80),
            mode: PlayerMode::Windowed,
            bounds: None,
            last_url: String::new(),
            dll_path_label: "libmpv".into(),
            observer_stop: None,
            observer_join: None,
        }
    }
}

impl LibMpvEngine {
    pub fn new() -> Self {
        Self::default()
    }

    fn stop_observer(&mut self) {
        if let Some(flag) = self.observer_stop.take() {
            flag.store(true, Ordering::Release);
        }
        if let Some(join) = self.observer_join.take() {
            // wait_event uses a 0.5s timeout; join briefly so we do not call
            // terminate_destroy while another thread is inside wait_event.
            let _ = join.join();
        }
    }

    fn destroy_handle(&mut self) {
        // Signal observer first; terminate_destroy wakes wait_event with SHUTDOWN.
        if let Some(flag) = self.observer_stop.take() {
            flag.store(true, Ordering::Release);
        }
        if let Some(h) = self.handle.take() {
            if let Ok(api) = load_libmpv() {
                // quit + destroy closes any top-level force-window HWND.
                let _ = Self::cmd(api, h, &["quit"]);
                unsafe {
                    (api.terminate_destroy)(h.0);
                }
            }
        }
        if let Some(join) = self.observer_join.take() {
            let _ = join.join();
        }
        self.running.store(false, Ordering::Release);
        self.paused.store(false, Ordering::Release);
        self.mode = PlayerMode::Windowed;
        if let Some(host) = self.host.take() {
            host.dispose();
        }
    }

    /// Background wait_event loop — emits Simple Live–style player_event kinds.
    /// Only this thread may call wait_event for the handle (libmpv rule).
    fn spawn_observer(
        api: &'static LibMpvApi,
        handle: MpvHandle,
        stop: std::sync::Arc<AtomicBool>,
    ) -> Option<std::thread::JoinHandle<()>> {
        let handle_addr = handle.0 as usize;
        std::thread::Builder::new()
            .name("rlive-libmpv-events".into())
            .spawn(move || {
                let raw = handle_addr as *mut c_void;
                loop {
                    if stop.load(Ordering::Acquire) {
                        break;
                    }
                    let ev_ptr = unsafe { (api.wait_event)(raw, 0.25) };
                    if ev_ptr.is_null() {
                        continue;
                    }
                    let ev = unsafe { &*ev_ptr };
                    match ev.event_id {
                        MPV_EVENT_NONE => {}
                        MPV_EVENT_SHUTDOWN => break,
                        MPV_EVENT_FILE_LOADED | MPV_EVENT_PLAYBACK_RESTART => {
                            player_events::emit("playing", None);
                        }
                        MPV_EVENT_END_FILE => {
                            if ev.data.is_null() {
                                player_events::emit("eof", None);
                                continue;
                            }
                            let end = unsafe { &*(ev.data as *const MpvEventEndFile) };
                            match end.reason {
                                MPV_END_FILE_REASON_ERROR => {
                                    player_events::emit(
                                        "error",
                                        Some(format!("mpv end-file error ({})", end.error)),
                                    );
                                }
                                MPV_END_FILE_REASON_EOF => {
                                    player_events::emit("eof", None);
                                }
                                _ => {}
                            }
                        }
                        _ => {}
                    }
                }
            })
            .ok()
    }

    fn set_opt(api: &LibMpvApi, h: MpvHandle, name: &str, value: &str) -> AppResult<()> {
        let n = cstr(name)?;
        let v = cstr(value)?;
        let rc = unsafe { (api.set_option_string)(h.0, n.as_ptr(), v.as_ptr()) };
        if rc < 0 {
            return Err(AppError::new(
                "libmpv_option_error",
                format!("mpv_set_option_string({name}) failed: {rc}"),
            ));
        }
        Ok(())
    }

    fn set_prop(api: &LibMpvApi, h: MpvHandle, name: &str, value: &str) -> AppResult<()> {
        let n = cstr(name)?;
        let v = cstr(value)?;
        let rc = unsafe { (api.set_property_string)(h.0, n.as_ptr(), v.as_ptr()) };
        if rc < 0 {
            return Err(AppError::new(
                "libmpv_property_error",
                format!("mpv_set_property_string({name}) failed: {rc}"),
            ));
        }
        Ok(())
    }

    fn cmd(api: &LibMpvApi, h: MpvHandle, args: &[&str]) -> AppResult<()> {
        let c_args: AppResult<Vec<CString>> = args.iter().map(|s| cstr(s)).collect();
        let c_args = c_args?;
        let mut ptrs: Vec<*const c_char> = c_args.iter().map(|c| c.as_ptr()).collect();
        ptrs.push(std::ptr::null());
        let rc = unsafe { (api.command)(h.0, ptrs.as_ptr()) };
        if rc < 0 {
            return Err(AppError::new(
                "libmpv_command_error",
                format!("mpv_command({:?}) failed: {rc}", args),
            ));
        }
        Ok(())
    }
}

impl MediaEngine for LibMpvEngine {
    fn open(
        &mut self,
        window: Option<&WebviewWindow>,
        req: &OpenRequest,
    ) -> AppResult<()> {
        // Always tear down previous session first (replace semantics).
        self.destroy_handle();

        let api = load_libmpv()?;
        let raw = unsafe { (api.create)() };
        if raw.is_null() {
            return Err(AppError::new("libmpv_create_error", "mpv_create returned null"));
        }
        let handle = MpvHandle(raw);

        // Keep idle until loadfile so option/property setup is valid.
        let _ = Self::set_opt(api, handle, "idle", "yes");
        let _ = Self::set_opt(api, handle, "osc", "no");
        let _ = Self::set_opt(api, handle, "input-default-bindings", "yes");
        let _ = Self::set_opt(api, handle, "keep-open", "yes");
        let _ = Self::set_opt(api, handle, "volume", &req.volume.min(100).to_string());

        if let Some(title) = req.title.as_deref() {
            let safe = title.replace(['\n', '\r'], " ");
            let _ = Self::set_opt(api, handle, "title", &safe);
        }

        if let Some(ua) = req
            .headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case("user-agent"))
            .map(|(_, v)| v.as_str())
        {
            let _ = Self::set_opt(api, handle, "user-agent", ua);
        }
        let header_fields = format_mpv_headers(&req.headers);
        if !header_fields.is_empty() {
            let _ = Self::set_opt(api, handle, "http-header-fields", &header_fields);
        }

        let mut host = None;
        let mut mode = PlayerMode::Windowed;

        if req.fullscreen {
            // Fullscreen intentionally uses a top-level mpv window (no wid).
            let _ = Self::set_opt(api, handle, "force-window", "yes");
            let _ = Self::set_opt(api, handle, "fullscreen", "yes");
            mode = PlayerMode::Fullscreen;
        } else if let (Some(win), Some(b)) = (window, req.bounds) {
            // Windowed playback must embed into the host HWND. A force-window
            // fallback creates a detached top-level window that survives leave-
            // room if teardown races — that is the "extra small window" bug.
            match EmbedHost::create(win, b) {
                Ok(h) => {
                    let wid = h.wid_arg();
                    if let Err(e) = Self::set_opt(api, handle, "wid", &wid) {
                        h.dispose();
                        unsafe {
                            (api.terminate_destroy)(handle.0);
                        }
                        return Err(AppError::new(
                            "libmpv_wid_error",
                            format!("mpv wid embed failed: {e}"),
                        )
                        .retryable());
                    }
                    let _ = Self::set_opt(api, handle, "vo", "gpu");
                    // Never create a free-floating mpv window in windowed mode.
                    let _ = Self::set_opt(api, handle, "force-window", "no");
                    host = Some(h);
                }
                Err(e) => {
                    unsafe {
                        (api.terminate_destroy)(handle.0);
                    }
                    return Err(e);
                }
            }
        } else {
            // No host bounds yet — refuse to open a detached window.
            unsafe {
                (api.terminate_destroy)(handle.0);
            }
            return Err(AppError::new(
                "player_missing_bounds",
                "video host bounds are not ready; cannot embed mpv",
            )
            .retryable());
        }

        let rc = unsafe { (api.initialize)(handle.0) };
        if rc < 0 {
            unsafe {
                (api.terminate_destroy)(handle.0);
            }
            if let Some(h) = host.take() {
                h.dispose();
            }
            return Err(AppError::new(
                "libmpv_init_error",
                format!("mpv_initialize failed: {rc}"),
            )
            .retryable());
        }

        if let Err(e) = Self::cmd(api, handle, &["loadfile", &req.url, "replace"]) {
            unsafe {
                (api.terminate_destroy)(handle.0);
            }
            if let Some(h) = host.take() {
                h.dispose();
            }
            return Err(e.retryable());
        }

        let stop = std::sync::Arc::new(AtomicBool::new(false));
        self.observer_join = Self::spawn_observer(api, handle, stop.clone());
        self.observer_stop = Some(stop);

        self.handle = Some(handle);
        self.host = host;
        self.running.store(true, Ordering::Release);
        self.paused.store(false, Ordering::Release);
        self.volume.store(req.volume.min(100), Ordering::Release);
        self.mode = mode;
        self.bounds = req.bounds;
        self.last_url = req.url.clone();
        Ok(())
    }

    fn stop(&mut self) {
        self.destroy_handle();
    }

    fn set_pause(&mut self, paused: bool) -> AppResult<()> {
        let api = load_libmpv()?;
        let h = self
            .handle
            .ok_or_else(|| AppError::new("player_not_running", "libmpv is not running"))?;
        Self::set_prop(api, h, "pause", if paused { "yes" } else { "no" })?;
        self.paused.store(paused, Ordering::Release);
        Ok(())
    }

    fn set_volume(&mut self, volume: u8) -> AppResult<()> {
        let api = load_libmpv()?;
        let h = self
            .handle
            .ok_or_else(|| AppError::new("player_not_running", "libmpv is not running"))?;
        let volume = volume.min(100);
        Self::set_prop(api, h, "volume", &volume.to_string())?;
        self.volume.store(volume, Ordering::Release);
        Ok(())
    }

    fn set_bounds(
        &mut self,
        _window: Option<&WebviewWindow>,
        bounds: PlayerBounds,
    ) -> AppResult<()> {
        self.bounds = Some(bounds);
        if let Some(host) = self.host.as_ref() {
            host.set_bounds(bounds)?;
        }
        Ok(())
    }

    fn show_osd_text(&mut self, text: &str, duration_ms: u64) -> AppResult<()> {
        let api = load_libmpv()?;
        let h = self
            .handle
            .ok_or_else(|| AppError::new("player_not_running", "libmpv is not running"))?;
        let safe: String = text.chars().take(80).collect();
        let ms = duration_ms.max(500).to_string();
        // show-text <text> <duration_ms>
        let _ = Self::cmd(api, h, &["show-text", &safe, &ms]);
        Ok(())
    }

    fn is_running(&self) -> bool {
        self.running.load(Ordering::Acquire)
    }

    fn is_paused(&self) -> bool {
        self.paused.load(Ordering::Acquire)
    }

    fn volume(&self) -> u8 {
        self.volume.load(Ordering::Acquire)
    }

    fn embed_mode(&self) -> EmbedMode {
        if self.host.is_some() {
            EmbedMode::InProcess
        } else if self.mode == PlayerMode::Fullscreen {
            EmbedMode::Window
        } else {
            EmbedMode::Geometry
        }
    }

    fn mode(&self) -> PlayerMode {
        self.mode
    }

    fn engine_name(&self) -> &'static str {
        "libmpv"
    }

    fn last_path(&self) -> String {
        self.dll_path_label.clone()
    }
}

impl Drop for LibMpvEngine {
    fn drop(&mut self) {
        self.destroy_handle();
    }
}

// Silence unused import warning when CStr not used.
#[allow(dead_code)]
fn _unused_cstr(p: *const c_char) -> String {
    unsafe { CStr::from_ptr(p).to_string_lossy().into_owned() }
}

/// Probe whether libmpv can be loaded (for status / diagnostics).
pub fn libmpv_available() -> bool {
    load_libmpv().is_ok()
}
