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
) -> AppResult<String> {
    if url.trim().is_empty() {
        return Err(crate::error::AppError::new(
            "stream_proxy_empty_url",
            "play url is empty",
        ));
    }
    state.stream_proxy.start(url, headers).await
}

#[tauri::command]
pub fn stream_proxy_stop(state: State<'_, AppState>) -> AppResult<()> {
    state.stream_proxy.stop();
    Ok(())
}
