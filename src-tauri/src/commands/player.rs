use std::collections::HashMap;

use tauri::State;

use crate::error::{AppError, AppResult};
use crate::player::{resolve_mpv_path, PlayerBounds, PlayerStatus};
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

#[tauri::command]
pub fn player_open(
    state: State<'_, AppState>,
    url: String,
    headers: HashMap<String, String>,
    title: Option<String>,
    bounds: Option<PlayerBounds>,
    embed: Option<bool>,
) -> AppResult<()> {
    let settings_path = load_mpv_setting(&state)?;
    let mpv = resolve_mpv_path(settings_path.as_deref())?;
    state.player.open(
        &mpv,
        &url,
        &headers,
        title.as_deref(),
        bounds,
        embed.unwrap_or(true),
    )
}

#[tauri::command]
pub fn player_load(
    state: State<'_, AppState>,
    url: String,
    headers: HashMap<String, String>,
    title: Option<String>,
    bounds: Option<PlayerBounds>,
    embed: Option<bool>,
) -> AppResult<()> {
    let settings_path = load_mpv_setting(&state)?;
    let mpv = resolve_mpv_path(settings_path.as_deref())?;
    state.player.load(
        &mpv,
        &url,
        &headers,
        title.as_deref(),
        bounds,
        embed.unwrap_or(true),
    )
}

#[tauri::command]
pub fn player_stop(state: State<'_, AppState>) -> AppResult<()> {
    state.player.stop()
}

#[tauri::command]
pub fn player_set_pause(state: State<'_, AppState>, paused: bool) -> AppResult<()> {
    state.player.set_pause(paused)
}

#[tauri::command]
pub fn player_set_volume(state: State<'_, AppState>, volume: u8) -> AppResult<()> {
    state.player.set_volume(volume)
}

#[tauri::command]
pub fn player_set_bounds(state: State<'_, AppState>, bounds: PlayerBounds) -> AppResult<()> {
    state.player.set_bounds(bounds)
}

#[tauri::command]
pub fn player_show_danmaku(
    state: State<'_, AppState>,
    text: String,
    duration_ms: Option<u64>,
) -> AppResult<()> {
    state
        .player
        .show_osd_text(&text, duration_ms.unwrap_or(3500))
}

#[tauri::command]
pub fn player_status(state: State<'_, AppState>) -> AppResult<PlayerStatus> {
    let settings_path = load_mpv_setting(&state)?;
    Ok(state.player.status(settings_path.as_deref()))
}
