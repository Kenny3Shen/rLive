//! Media engine abstraction.
//!
//! Windows ships an in-process libmpv backend by default. Non-Windows keeps a
//! process-based fallback. Tests inject [`FakeEngine`] through the same
//! [`PlayerManager`] entry points used in production.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::Mutex;

use tauri::WebviewWindow;

use crate::error::{AppError, AppResult};
use crate::player::{EmbedMode, PlayerBounds, PlayerMode};

/// Everything needed to start or replace a stream.
#[derive(Debug, Clone)]
pub struct OpenRequest {
    pub url: String,
    pub headers: HashMap<String, String>,
    pub title: Option<String>,
    pub bounds: Option<PlayerBounds>,
    pub volume: u8,
    pub fullscreen: bool,
}

/// Backend-agnostic player control surface.
pub trait MediaEngine: Send {
    fn open(
        &mut self,
        window: Option<&WebviewWindow>,
        req: &OpenRequest,
    ) -> AppResult<()>;

    /// Detach media immediately. Must not block the UI thread on process waits.
    fn stop(&mut self);

    fn set_pause(&mut self, paused: bool) -> AppResult<()>;
    fn set_volume(&mut self, volume: u8) -> AppResult<()>;
    fn set_bounds(
        &mut self,
        window: Option<&WebviewWindow>,
        bounds: PlayerBounds,
    ) -> AppResult<()>;
    fn show_osd_text(&mut self, text: &str, duration_ms: u64) -> AppResult<()>;

    fn is_running(&self) -> bool;
    fn is_paused(&self) -> bool;
    fn volume(&self) -> u8;
    fn embed_mode(&self) -> EmbedMode;
    fn mode(&self) -> PlayerMode;
    fn engine_name(&self) -> &'static str;
    fn last_path(&self) -> String;
}

/// In-memory engine used by unit tests and as a deterministic stop/shutdown path.
///
/// This is **shipped** code (not a test double reimplementation of stop logic
/// inside a test): [`PlayerManager`] calls the same `stop` / `open` methods.
pub struct FakeEngine {
    running: AtomicBool,
    paused: AtomicBool,
    volume: AtomicU8,
    mode: Mutex<PlayerMode>,
    bounds: Mutex<Option<PlayerBounds>>,
    last_url: Mutex<String>,
    open_count: Mutex<u32>,
    stop_count: Mutex<u32>,
}

impl Default for FakeEngine {
    fn default() -> Self {
        Self {
            running: AtomicBool::new(false),
            paused: AtomicBool::new(false),
            volume: AtomicU8::new(80),
            mode: Mutex::new(PlayerMode::Windowed),
            bounds: Mutex::new(None),
            last_url: Mutex::new(String::new()),
            open_count: Mutex::new(0),
            stop_count: Mutex::new(0),
        }
    }
}

impl FakeEngine {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn open_count(&self) -> u32 {
        *self.open_count.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub fn stop_count(&self) -> u32 {
        *self.stop_count.lock().unwrap_or_else(|p| p.into_inner())
    }
}

impl MediaEngine for FakeEngine {
    fn open(
        &mut self,
        _window: Option<&WebviewWindow>,
        req: &OpenRequest,
    ) -> AppResult<()> {
        if req.url.is_empty() {
            return Err(AppError::new("player_empty_url", "play url is empty"));
        }
        // Replace semantics: prior session is considered stopped.
        self.running.store(true, Ordering::Release);
        self.paused.store(false, Ordering::Release);
        self.volume.store(req.volume.min(100), Ordering::Release);
        *self.mode.lock().unwrap_or_else(|p| p.into_inner()) = if req.fullscreen {
            PlayerMode::Fullscreen
        } else {
            PlayerMode::Windowed
        };
        *self.bounds.lock().unwrap_or_else(|p| p.into_inner()) = req.bounds;
        *self.last_url.lock().unwrap_or_else(|p| p.into_inner()) = req.url.clone();
        *self.open_count.lock().unwrap_or_else(|p| p.into_inner()) += 1;
        Ok(())
    }

    fn stop(&mut self) {
        self.running.store(false, Ordering::Release);
        self.paused.store(false, Ordering::Release);
        *self.mode.lock().unwrap_or_else(|p| p.into_inner()) = PlayerMode::Windowed;
        *self.stop_count.lock().unwrap_or_else(|p| p.into_inner()) += 1;
    }

    fn set_pause(&mut self, paused: bool) -> AppResult<()> {
        if !self.is_running() {
            return Err(AppError::new("player_not_running", "player is not running"));
        }
        self.paused.store(paused, Ordering::Release);
        Ok(())
    }

    fn set_volume(&mut self, volume: u8) -> AppResult<()> {
        if !self.is_running() {
            return Err(AppError::new("player_not_running", "player is not running"));
        }
        self.volume.store(volume.min(100), Ordering::Release);
        Ok(())
    }

    fn set_bounds(
        &mut self,
        _window: Option<&WebviewWindow>,
        bounds: PlayerBounds,
    ) -> AppResult<()> {
        *self.bounds.lock().unwrap_or_else(|p| p.into_inner()) = Some(bounds);
        Ok(())
    }

    fn show_osd_text(&mut self, _text: &str, _duration_ms: u64) -> AppResult<()> {
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
        EmbedMode::InProcess
    }

    fn mode(&self) -> PlayerMode {
        *self.mode.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn engine_name(&self) -> &'static str {
        "fake"
    }

    fn last_path(&self) -> String {
        self.last_url
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }
}
