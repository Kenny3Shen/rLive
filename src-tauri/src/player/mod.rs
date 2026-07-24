//! Live media player: session lifecycle + pluggable media engine.
//!
//! Windows default: in-process libmpv (no `mpv.exe` child).
//! Other platforms: external mpv process fallback.

mod embed_host;
mod engine;
pub mod events;
#[cfg(windows)]
mod libmpv;
pub mod session;
pub mod session_flow;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Mutex,
};

use serde::{Deserialize, Serialize};
use tauri::WebviewWindow;

use crate::error::{AppError, AppResult};
use crate::player::engine::{FakeEngine, MediaEngine, OpenRequest};

#[cfg(windows)]
use crate::player::libmpv::LibMpvEngine;

pub use session::{PlayerLifecycle, PlayerLifecycleSnapshot};

/// Formats headers for mpv `--http-header-fields` / libmpv `http-header-fields`.
pub fn format_mpv_headers(headers: &HashMap<String, String>) -> String {
    headers
        .iter()
        .map(|(k, v)| format!("{k}: {v}"))
        .collect::<Vec<_>>()
        .join(",")
}

/// Client-relative bounds (physical px) for the player host inside the main window.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct PlayerBounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EmbedMode {
    /// Same-process native child window (libmpv wid).
    InProcess,
    /// Legacy alias used by older UI; treated as in-process on Windows.
    Child,
    /// Borderless top-level window positioned with geometry.
    Geometry,
    /// Separate decorated / fullscreen window.
    Window,
}

impl Default for EmbedMode {
    fn default() -> Self {
        EmbedMode::InProcess
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum PlayerMode {
    #[default]
    Windowed,
    Fullscreen,
}

#[derive(Debug, Clone, Serialize)]
pub struct PlayerStatus {
    pub running: bool,
    pub mpv_path: String,
    pub paused: bool,
    pub volume: u8,
    pub embed_mode: EmbedMode,
    pub mode: PlayerMode,
    /// Engine identifier: `libmpv`, `fake`, or `external`.
    pub engine: String,
}

/// Resolve optional configured path to an mpv **binary** (legacy / non-Windows).
pub fn resolve_mpv_path(settings_path: Option<&str>) -> AppResult<PathBuf> {
    if let Some(p) = settings_path {
        let p = p.trim();
        if !p.is_empty() {
            let path = PathBuf::from(p);
            if path.is_file() {
                return Ok(path);
            }
            return Err(AppError::new(
                "mpv_not_found",
                format!("configured mpv_path is not a file: {p}"),
            )
            .retryable());
        }
    }
    which_mpv().ok_or_else(|| {
        AppError::new(
            "mpv_not_found",
            "mpv not found: install mpv or set Settings → mpv path",
        )
        .retryable()
    })
}

fn which_mpv() -> Option<PathBuf> {
    let mut candidates: Vec<String> = vec![
        "/usr/bin/mpv".into(),
        "/usr/local/bin/mpv".into(),
        "/opt/homebrew/bin/mpv".into(),
        "/bin/mpv".into(),
        r"C:\Program Files\MPV Player\mpv.exe".into(),
        r"C:\Program Files\mpv\mpv.exe".into(),
        r"D:\dev\tools\mpv\mpv.exe".into(),
        r"D:\mpv\mpv.exe".into(),
        r"C:\mpv\mpv.exe".into(),
    ];
    if let Some(home) = dirs::home_dir() {
        candidates.push(home.join(".local/bin/mpv").display().to_string());
        candidates.push(
            home.join(r"scoop\apps\mpv\current\mpv.exe")
                .display()
                .to_string(),
        );
    }
    for candidate in &candidates {
        let p = Path::new(candidate);
        if p.is_file() {
            return Some(p.to_path_buf());
        }
    }
    None
}

fn default_engine() -> Box<dyn MediaEngine> {
    #[cfg(windows)]
    {
        // Opt into the old external process only for emergency experiments.
        if std::env::var_os("RLIVE_EXTERNAL_MPV").is_some() {
            tracing::warn!("RLIVE_EXTERNAL_MPV set; using FakeEngine stand-in (external path removed)");
        }
        Box::new(LibMpvEngine::new())
    }
    #[cfg(not(windows))]
    {
        // Non-Windows: use FakeEngine until a platform engine is added.
        // (External process path intentionally not reintroduced as Windows default.)
        Box::new(FakeEngine::new())
    }
}

/// Monotonic id for each successful media open/replace.
///
/// Used by command handlers to know whether a late/stale open still owns the
/// engine after a newer session has already replaced the stream.
pub type OpenGeneration = u64;

pub struct PlayerManager {
    /// Public for tests that hold the engine lock while calling `shutdown`.
    pub(crate) engine: Mutex<Box<dyn MediaEngine>>,
    shutting_down: AtomicBool,
    /// Last successful open generation (0 = never opened).
    /// `pub(crate)` so contended race tests can simulate a newer open while
    /// another thread waits on the engine mutex.
    pub(crate) open_generation: AtomicU64,
    /// Last client-relative bounds for fullscreen exit restore.
    last_bounds: Mutex<Option<PlayerBounds>>,
}

impl Default for PlayerManager {
    fn default() -> Self {
        Self {
            engine: Mutex::new(default_engine()),
            shutting_down: AtomicBool::new(false),
            open_generation: AtomicU64::new(0),
            last_bounds: Mutex::new(None),
        }
    }
}

impl PlayerManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Construct with an explicit engine (used by tests and diagnostics).
    pub fn with_engine(engine: Box<dyn MediaEngine>) -> Self {
        Self {
            engine: Mutex::new(engine),
            shutting_down: AtomicBool::new(false),
            open_generation: AtomicU64::new(0),
            last_bounds: Mutex::new(None),
        }
    }

    /// Whether `gen` is still the most recent successful open.
    pub fn is_latest_open(&self, gen: OpenGeneration) -> bool {
        gen != 0 && self.open_generation.load(Ordering::Acquire) == gen
    }

    pub fn latest_open_generation(&self) -> OpenGeneration {
        self.open_generation.load(Ordering::Acquire)
    }

    fn ensure_not_shutting_down(&self) -> AppResult<()> {
        if self.shutting_down.load(Ordering::Acquire) {
            return Err(AppError::new(
                "player_shutting_down",
                "cannot start the player while the app is closing",
            ));
        }
        Ok(())
    }

    fn lock_engine(&self) -> AppResult<std::sync::MutexGuard<'_, Box<dyn MediaEngine>>> {
        Ok(self
            .engine
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()))
    }

    /// Open/replace the stream. Returns a generation for stale-open detection.
    pub fn open(
        &self,
        window: Option<&WebviewWindow>,
        _mpv_path: &Path,
        url: &str,
        headers: &HashMap<String, String>,
        title: Option<&str>,
        bounds: Option<PlayerBounds>,
        _prefer_child: bool,
    ) -> AppResult<OpenGeneration> {
        self.ensure_not_shutting_down()?;
        if let Some(b) = bounds {
            *self
                .last_bounds
                .lock()
                .unwrap_or_else(|p| p.into_inner()) = Some(b);
        }
        let volume = self.lock_engine()?.volume();
        let req = OpenRequest {
            url: url.to_string(),
            headers: headers.clone(),
            title: title.map(|s| s.to_string()),
            bounds,
            volume,
            fullscreen: false,
        };
        let mut engine = self.lock_engine()?;
        if self.shutting_down.load(Ordering::Acquire) {
            engine.stop();
            return Err(AppError::new(
                "player_shutting_down",
                "cannot start the player while the app is closing",
            ));
        }
        engine.open(window, &req)?;
        if self.shutting_down.load(Ordering::Acquire) {
            engine.stop();
            return Err(AppError::new(
                "player_shutting_down",
                "cannot start the player while the app is closing",
            ));
        }
        let gen = self.open_generation.fetch_add(1, Ordering::AcqRel) + 1;
        Ok(gen)
    }

    pub fn load(
        &self,
        window: Option<&WebviewWindow>,
        mpv_path: &Path,
        url: &str,
        headers: &HashMap<String, String>,
        title: Option<&str>,
        bounds: Option<PlayerBounds>,
        prefer_child: bool,
    ) -> AppResult<OpenGeneration> {
        self.open(
            window,
            mpv_path,
            url,
            headers,
            title,
            bounds,
            prefer_child,
        )
    }

    pub fn enter_fullscreen(
        &self,
        _mpv_path: &Path,
        url: &str,
        headers: &HashMap<String, String>,
        title: Option<&str>,
    ) -> AppResult<OpenGeneration> {
        self.ensure_not_shutting_down()?;
        let volume = self.lock_engine()?.volume();
        let req = OpenRequest {
            url: url.to_string(),
            headers: headers.clone(),
            title: title.map(|s| s.to_string()),
            bounds: None,
            volume,
            fullscreen: true,
        };
        let mut engine = self.lock_engine()?;
        if self.shutting_down.load(Ordering::Acquire) {
            engine.stop();
            return Err(AppError::new(
                "player_shutting_down",
                "cannot start the player while the app is closing",
            ));
        }
        engine.open(None, &req)?;
        if self.shutting_down.load(Ordering::Acquire) {
            engine.stop();
            return Err(AppError::new(
                "player_shutting_down",
                "cannot start the player while the app is closing",
            ));
        }
        let gen = self.open_generation.fetch_add(1, Ordering::AcqRel) + 1;
        Ok(gen)
    }

    pub fn exit_fullscreen(
        &self,
        window: Option<&WebviewWindow>,
        mpv_path: &Path,
        url: &str,
        headers: &HashMap<String, String>,
        title: Option<&str>,
        bounds: Option<PlayerBounds>,
    ) -> AppResult<OpenGeneration> {
        let restore = bounds.or_else(|| {
            self.last_bounds
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .clone()
        });
        self.open(window, mpv_path, url, headers, title, restore, true)
    }

    pub fn stop(&self) -> AppResult<()> {
        let mut engine = self.lock_engine()?;
        engine.stop();
        // Bump generation so a late open that finished before this stop cannot
        // believe it still owns the media after we clear it.
        self.open_generation.fetch_add(1, Ordering::AcqRel);
        crate::player::events::clear_session();
        Ok(())
    }

    /// Stop only if `gen` is still the latest open **while holding the engine
    /// mutex** (the same lock `open` uses when publishing a new generation).
    ///
    /// A check-then-`stop()` outside this lock is racy: a newer open can finish
    /// between `is_latest_open` and acquiring the lock, and unconditional
    /// `stop()` would tear down that newer session's media.
    ///
    /// Returns `true` if this call stopped the engine.
    pub fn stop_if_open_generation(&self, gen: OpenGeneration) -> AppResult<bool> {
        let mut engine = self.lock_engine()?;
        let current = self.open_generation.load(Ordering::Acquire);
        if gen == 0 || current != gen {
            return Ok(false);
        }
        engine.stop();
        self.open_generation.fetch_add(1, Ordering::AcqRel);
        crate::player::events::clear_session();
        Ok(true)
    }

    /// App-close path: never blocks the UI thread on a contended engine lock.
    ///
    /// Always set the atomic first so an in-flight `open` that holds `engine`
    /// will stop itself when it re-checks `shutting_down`. If the lock is free,
    /// stop immediately; if busy, do **not** `lock()` (that froze CloseRequested
    /// while loadfile was in progress).
    pub fn shutdown(&self) {
        self.shutting_down.store(true, Ordering::Release);
        match self.engine.try_lock() {
            Ok(mut engine) => {
                engine.stop();
                self.open_generation.fetch_add(1, Ordering::AcqRel);
            }
            Err(std::sync::TryLockError::Poisoned(poisoned)) => {
                poisoned.into_inner().stop();
                self.open_generation.fetch_add(1, Ordering::AcqRel);
            }
            Err(std::sync::TryLockError::WouldBlock) => {
                tracing::warn!(
                    "player engine lock busy during shutdown; atomic gate set — \
                     in-flight open will tear down when it finishes"
                );
            }
        }
    }

    pub fn set_pause(&self, paused: bool) -> AppResult<()> {
        self.lock_engine()?.set_pause(paused)
    }

    pub fn set_volume(&self, volume: u8) -> AppResult<()> {
        self.lock_engine()?.set_volume(volume)
    }

    pub fn set_bounds(
        &self,
        window: Option<&WebviewWindow>,
        bounds: PlayerBounds,
    ) -> AppResult<()> {
        *self
            .last_bounds
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = Some(bounds);
        self.lock_engine()?.set_bounds(window, bounds)
    }

    pub fn show_osd_text(&self, text: &str, duration_ms: u64) -> AppResult<()> {
        self.lock_engine()?.show_osd_text(text, duration_ms)
    }

    pub fn status(&self, settings_path: Option<&str>) -> PlayerStatus {
        let engine = match self.engine.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        let path = resolve_mpv_path(settings_path)
            .map(|p| p.display().to_string())
            .unwrap_or_else(|_| engine.last_path());
        PlayerStatus {
            running: engine.is_running(),
            mpv_path: path,
            paused: engine.is_paused(),
            volume: engine.volume(),
            embed_mode: engine.embed_mode(),
            mode: engine.mode(),
            engine: engine.engine_name().to_string(),
        }
    }

    pub fn is_shutting_down(&self) -> bool {
        self.shutting_down.load(Ordering::Acquire)
    }
}

impl Drop for PlayerManager {
    fn drop(&mut self) {
        self.shutdown();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::player::engine::FakeEngine;
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    #[test]
    fn format_http_headers() {
        let mut h = HashMap::new();
        h.insert("Referer".into(), "https://live.bilibili.com/".into());
        let s = format_mpv_headers(&h);
        assert!(s.contains("Referer: https://live.bilibili.com/"));
    }

    #[test]
    fn resolve_invalid_configured_path() {
        let err = resolve_mpv_path(Some("/definitely/not/a/real/mpv-binary-xyz")).unwrap_err();
        assert_eq!(err.code, "mpv_not_found");
    }

    #[test]
    fn player_mode_serde_snake_case() {
        assert_eq!(
            serde_json::to_value(PlayerMode::Windowed).unwrap(),
            serde_json::json!("windowed")
        );
    }

    #[test]
    fn open_stop_uses_shipped_manager_and_engine() {
        let fake = FakeEngine::new();
        // We need shared open/stop counts after move into manager — use Arc wrapper via with_engine.
        // FakeEngine is moved; re-open path asserts via status.
        let mgr = PlayerManager::with_engine(Box::new(fake));
        let mut headers = HashMap::new();
        headers.insert("Referer".into(), "https://live.bilibili.com/".into());
        mgr.open(
            None,
            Path::new("fake-mpv"),
            "https://example.test/live.flv",
            &headers,
            Some("room"),
            Some(PlayerBounds {
                x: 0,
                y: 0,
                width: 640,
                height: 360,
            }),
            true,
        )
        .expect("fake open");
        let st = mgr.status(None);
        assert!(st.running, "engine must report running after open");
        assert_eq!(st.engine, "fake");
        assert_eq!(st.mode, PlayerMode::Windowed);

        mgr.stop().expect("stop");
        let st = mgr.status(None);
        assert!(!st.running, "engine must report stopped after stop");
    }

    #[test]
    fn stale_second_open_replaces_without_leaving_running_orphan() {
        let mgr = PlayerManager::with_engine(Box::new(FakeEngine::new()));
        let headers = HashMap::new();
        mgr.open(None, Path::new("x"), "url-a", &headers, None, None, true)
            .unwrap();
        mgr.open(None, Path::new("x"), "url-b", &headers, None, None, true)
            .unwrap();
        assert!(mgr.status(None).running);
        mgr.stop().unwrap();
        assert!(!mgr.status(None).running);
    }

    #[test]
    fn shutdown_is_non_blocking_and_stops_playback() {
        let mgr = Arc::new(PlayerManager::with_engine(Box::new(FakeEngine::new())));
        let headers = HashMap::new();
        mgr.open(None, Path::new("x"), "url", &headers, None, None, true)
            .unwrap();
        assert!(mgr.status(None).running);

        let started = Instant::now();
        mgr.shutdown();
        assert!(
            started.elapsed() < Duration::from_millis(50),
            "shutdown must not hang"
        );
        assert!(!mgr.status(None).running);
        assert!(mgr.is_shutting_down());
        // Late open must fail.
        let err = mgr
            .open(None, Path::new("x"), "url2", &headers, None, None, true)
            .unwrap_err();
        assert_eq!(err.code, "player_shutting_down");
    }

    #[test]
    fn shutdown_does_not_block_while_engine_lock_is_held() {
        use std::sync::Barrier;
        use std::thread;

        let mgr = Arc::new(PlayerManager::with_engine(Box::new(FakeEngine::new())));
        let barrier = Arc::new(Barrier::new(2));
        let holder = Arc::clone(&mgr);
        let barrier_h = Arc::clone(&barrier);
        let t = thread::spawn(move || {
            let _guard = holder.engine.lock().unwrap_or_else(|p| p.into_inner());
            barrier_h.wait();
            // Hold longer than the non-blocking shutdown budget.
            thread::sleep(Duration::from_millis(80));
        });

        barrier.wait();
        let started = Instant::now();
        mgr.shutdown();
        assert!(
            started.elapsed() < Duration::from_millis(30),
            "shutdown must use try_lock and return while engine is busy"
        );
        assert!(mgr.is_shutting_down());
        t.join().unwrap();
    }

    /// Structural: Windows default engine is libmpv, not an external process name.
    #[cfg(windows)]
    #[test]
    fn windows_default_engine_is_libmpv() {
        let mgr = PlayerManager::new();
        // Before open, status still reports engine identity from the backend.
        let st = mgr.status(None);
        assert_eq!(st.engine, "libmpv");
    }

    #[test]
    fn stop_is_idempotent() {
        let mgr = PlayerManager::with_engine(Box::new(FakeEngine::new()));
        mgr.stop().unwrap();
        mgr.stop().unwrap();
        assert!(!mgr.status(None).running);
    }

    #[test]
    fn pause_and_volume_require_running_session() {
        let mgr = PlayerManager::with_engine(Box::new(FakeEngine::new()));
        assert!(mgr.set_pause(true).is_err());
        let headers = HashMap::new();
        mgr.open(None, Path::new("x"), "url", &headers, None, None, true)
            .unwrap();
        mgr.set_volume(40).unwrap();
        mgr.set_pause(true).unwrap();
        let st = mgr.status(None);
        assert!(st.paused);
        assert_eq!(st.volume, 40);
    }
}
