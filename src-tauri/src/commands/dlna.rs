use std::collections::HashMap;

use tauri::State;

use crate::dlna::{DlnaCastStatus, DlnaDevice};
use crate::error::AppResult;
use crate::state::AppState;

#[tauri::command(async)]
pub async fn dlna_search_devices(state: State<'_, AppState>) -> AppResult<Vec<DlnaDevice>> {
    state.dlna.search_devices().await
}

#[tauri::command(async)]
pub async fn dlna_cast(
    state: State<'_, AppState>,
    location: String,
    url: String,
    headers: HashMap<String, String>,
    title: String,
) -> AppResult<DlnaCastStatus> {
    state.dlna.cast(location, url, headers, title).await
}

#[tauri::command(async)]
pub async fn dlna_stop(state: State<'_, AppState>) -> AppResult<()> {
    state.dlna.stop().await
}

#[tauri::command]
pub fn dlna_status(state: State<'_, AppState>) -> AppResult<Option<DlnaCastStatus>> {
    Ok(state.dlna.status())
}
