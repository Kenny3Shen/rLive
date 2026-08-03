//! Tauri commands for the independent IPTV channel browser.

use tauri::State;

use crate::error::AppResult;
use crate::iptv::{self, IptvChannel, IptvChannelAvailability, IptvChannelCheck};
use crate::state::AppState;

fn configured_proxy(state: &AppState) -> AppResult<Option<String>> {
    let conn = state
        .db
        .lock()
        .map_err(|_| crate::error::AppError::new("db_lock_error", "database mutex poisoned"))?;
    Ok(crate::settings::get(&conn)?.proxy)
}

#[tauri::command(async)]
pub async fn iptv_load_playlist(
    state: State<'_, AppState>,
    source_url: String,
) -> AppResult<Vec<IptvChannel>> {
    let proxy = configured_proxy(state.inner())?;
    iptv::load_playlist(&source_url, proxy.as_deref()).await
}

#[tauri::command(async)]
pub async fn iptv_check_channels(
    state: State<'_, AppState>,
    checks: Vec<IptvChannelCheck>,
) -> AppResult<Vec<IptvChannelAvailability>> {
    let proxy = configured_proxy(state.inner())?;
    iptv::check_channels(checks, proxy.as_deref()).await
}
