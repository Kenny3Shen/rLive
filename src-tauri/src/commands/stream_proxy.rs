//! Tauri commands for the localhost media proxy (web player path).

use std::collections::HashMap;

use tauri::State;

use crate::error::AppResult;
use crate::state::AppState;

#[tauri::command(async)]
pub async fn stream_proxy_start(
    state: State<'_, AppState>,
    url: String,
    headers: HashMap<String, String>,
    session_id: String,
) -> AppResult<String> {
    if url.trim().is_empty() {
        return Err(crate::error::AppError::new(
            "stream_proxy_empty_url",
            "play url is empty",
        ));
    }
    if session_id.trim().is_empty() {
        return Err(crate::error::AppError::new(
            "stream_proxy_empty_session",
            "playback session is empty",
        ));
    }
    state.stream_proxy.start(url, headers, session_id).await
}

#[tauri::command]
pub fn stream_proxy_stop(state: State<'_, AppState>, session_id: String) -> AppResult<()> {
    if session_id.trim().is_empty() {
        return Err(crate::error::AppError::new(
            "stream_proxy_empty_session",
            "playback session is empty",
        ));
    }
    state.stream_proxy.stop_for_session(&session_id);
    Ok(())
}
