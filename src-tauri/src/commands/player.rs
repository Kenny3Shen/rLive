//! Tauri IPC commands for the live player.
//!
//! Session ordering lives in [`crate::player::session`]; media I/O is delegated
//! to [`crate::player::PlayerManager`].

use std::collections::HashMap;
use std::path::PathBuf;

use tauri::{AppHandle, Manager, State, WebviewWindow};

use crate::error::{AppError, AppResult};
use crate::player::session_flow::{
    enter_fullscreen_for_epoch, exit_fullscreen_for_epoch, load_for_epoch,
    open_for_epoch_with_app, stop_for_epoch,
};
use crate::player::{
    resolve_mpv_path, PlayerBounds, PlayerLifecycle, PlayerLifecycleSnapshot, PlayerStatus,
};
use crate::settings;
use crate::state::AppState;

fn lock_db(state: &AppState) -> AppResult<std::sync::MutexGuard<'_, rusqlite::Connection>> {
    state
        .db
        .lock()
        .map_err(|_| AppError::new("db_lock_error", "database mutex poisoned"))
}

fn load_mpv_setting(state: &AppState) -> AppResult<Option<String>> {
    let conn = lock_db(state)?;
    let s = settings::get(&conn)?;
    Ok(s.mpv_path.filter(|p| !p.trim().is_empty()))
}

fn main_window(window: &WebviewWindow) -> WebviewWindow {
    window
        .app_handle()
        .get_webview_window("main")
        .unwrap_or_else(|| window.clone())
}

/// Placeholder path for engines that do not use an external binary.
fn engine_path_hint(settings_path: Option<String>) -> PathBuf {
    resolve_mpv_path(settings_path.as_deref()).unwrap_or_else(|_| PathBuf::from("libmpv"))
}

/// Stop the player before the main WebView is torn down.
pub fn destroy_player(app: &AppHandle) {
    let snap = app
        .try_state::<PlayerLifecycle>()
        .map(|lifecycle| lifecycle.inner().debug_snapshot());
    if let Some(ref s) = snap {
        tracing::info!(?s, "destroy_player lifecycle snapshot");
        if let Ok(json) = serde_json::to_string(s) {
            let path = std::env::temp_dir().join("rlive-player-shutdown.json");
            let _ = std::fs::write(&path, format!("{json}\n"));
        }
    }

    if let Some(lifecycle) = app.try_state::<PlayerLifecycle>() {
        lifecycle.inner().shutdown();
    }
    if let Some(state) = app.try_state::<AppState>() {
        state.inner().player.shutdown();
    }
}

#[tauri::command]
pub fn player_begin(lifecycle: State<'_, PlayerLifecycle>) -> AppResult<u64> {
    if lifecycle.is_shutting_down() {
        return Err(AppError::new(
            "player_shutting_down",
            "cannot start the player while the app is closing",
        ));
    }
    let mut lifecycle_state = lifecycle.lock();
    if lifecycle.is_shutting_down() {
        return Err(AppError::new(
            "player_shutting_down",
            "cannot start the player while the app is closing",
        ));
    }
    lifecycle_state.begin()
}

#[tauri::command(async)]
pub fn player_open(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    lifecycle: State<'_, PlayerLifecycle>,
    epoch: u64,
    url: String,
    headers: HashMap<String, String>,
    title: Option<String>,
    bounds: Option<PlayerBounds>,
    prefer_child: Option<bool>,
) -> AppResult<()> {
    let settings_path = load_mpv_setting(&state)?;
    let mpv = engine_path_hint(settings_path);
    let main = main_window(&window);
    open_for_epoch_with_app(
        lifecycle.inner(),
        &state.player,
        Some(&app),
        Some(&main),
        &mpv,
        epoch,
        &url,
        &headers,
        title.as_deref(),
        bounds,
        prefer_child.unwrap_or(true),
    )
}

#[tauri::command(async)]
pub fn player_load(
    window: WebviewWindow,
    state: State<'_, AppState>,
    lifecycle: State<'_, PlayerLifecycle>,
    epoch: u64,
    url: String,
    headers: HashMap<String, String>,
    title: Option<String>,
    bounds: Option<PlayerBounds>,
    prefer_child: Option<bool>,
) -> AppResult<()> {
    let settings_path = load_mpv_setting(&state)?;
    let mpv = engine_path_hint(settings_path);
    let main = main_window(&window);
    load_for_epoch(
        lifecycle.inner(),
        &state.player,
        Some(&main),
        &mpv,
        epoch,
        &url,
        &headers,
        title.as_deref(),
        bounds,
        prefer_child.unwrap_or(true),
    )
}

#[tauri::command(async)]
pub fn player_stop(
    state: State<'_, AppState>,
    lifecycle: State<'_, PlayerLifecycle>,
    epoch: Option<u64>,
) -> AppResult<()> {
    // Generation-guarded leave path (see session_flow::stop_for_epoch).
    stop_for_epoch(lifecycle.inner(), &state.player, epoch)
}

#[tauri::command]
pub fn player_debug_lifecycle(
    lifecycle: State<'_, PlayerLifecycle>,
) -> AppResult<PlayerLifecycleSnapshot> {
    Ok(lifecycle.debug_snapshot())
}

#[tauri::command]
pub fn player_set_pause(
    state: State<'_, AppState>,
    lifecycle: State<'_, PlayerLifecycle>,
    epoch: u64,
    paused: bool,
) -> AppResult<()> {
    if lifecycle.is_shutting_down() {
        return Ok(());
    }
    let lifecycle_state = lifecycle.lock();
    if lifecycle.is_shutting_down() || !lifecycle_state.accepts_current(epoch) {
        return Ok(());
    }
    state.player.set_pause(paused)
}

#[tauri::command]
pub fn player_set_volume(
    state: State<'_, AppState>,
    lifecycle: State<'_, PlayerLifecycle>,
    epoch: u64,
    volume: u8,
) -> AppResult<()> {
    if lifecycle.is_shutting_down() {
        return Ok(());
    }
    let lifecycle_state = lifecycle.lock();
    if lifecycle.is_shutting_down() || !lifecycle_state.accepts_current(epoch) {
        return Ok(());
    }
    state.player.set_volume(volume)
}

#[tauri::command]
pub fn player_set_bounds(
    window: WebviewWindow,
    state: State<'_, AppState>,
    lifecycle: State<'_, PlayerLifecycle>,
    epoch: u64,
    bounds: PlayerBounds,
) -> AppResult<()> {
    if lifecycle.is_shutting_down() {
        return Ok(());
    }
    let lifecycle_state = lifecycle.lock();
    if lifecycle.is_shutting_down() || !lifecycle_state.accepts_current(epoch) {
        return Ok(());
    }
    state
        .player
        .set_bounds(Some(&main_window(&window)), bounds)
}

#[tauri::command]
pub fn player_show_danmaku(
    state: State<'_, AppState>,
    lifecycle: State<'_, PlayerLifecycle>,
    epoch: Option<u64>,
    text: String,
    duration_ms: Option<u64>,
) -> AppResult<()> {
    let Some(epoch) = epoch else {
        return Ok(());
    };
    if lifecycle.is_shutting_down() {
        return Ok(());
    }
    let lifecycle_state = lifecycle.lock();
    if lifecycle.is_shutting_down() || !lifecycle_state.accepts_current(epoch) {
        return Ok(());
    }
    state
        .player
        .show_osd_text(&text, duration_ms.unwrap_or(3500))
}

#[tauri::command]
pub fn player_status(state: State<'_, AppState>) -> AppResult<PlayerStatus> {
    let settings_path = load_mpv_setting(&state)?;
    Ok(state.player.status(settings_path.as_deref()))
}

#[tauri::command(async)]
pub fn player_enter_fullscreen(
    window: WebviewWindow,
    state: State<'_, AppState>,
    lifecycle: State<'_, PlayerLifecycle>,
    epoch: u64,
    url: String,
    headers: HashMap<String, String>,
    title: Option<String>,
) -> AppResult<()> {
    let _ = window;
    let settings_path = load_mpv_setting(&state)?;
    let mpv = engine_path_hint(settings_path);
    // Rebinds active_generation to the new open gen (see session_flow).
    enter_fullscreen_for_epoch(
        lifecycle.inner(),
        &state.player,
        epoch,
        &mpv,
        &url,
        &headers,
        title.as_deref(),
    )
}

#[tauri::command(async)]
pub fn player_exit_fullscreen(
    window: WebviewWindow,
    state: State<'_, AppState>,
    lifecycle: State<'_, PlayerLifecycle>,
    epoch: u64,
    url: String,
    headers: HashMap<String, String>,
    title: Option<String>,
    bounds: Option<PlayerBounds>,
) -> AppResult<()> {
    let settings_path = load_mpv_setting(&state)?;
    let mpv = engine_path_hint(settings_path);
    let main = main_window(&window);
    exit_fullscreen_for_epoch(
        lifecycle.inner(),
        &state.player,
        Some(&main),
        epoch,
        &mpv,
        &url,
        &headers,
        title.as_deref(),
        bounds,
    )
}
