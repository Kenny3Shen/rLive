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
    hls: Option<bool>,
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
    // The browser only ever connects to this loopback listener. Its upstream
    // reqwest client must therefore receive the saved proxy explicitly; the
    // WebView's own networking configuration cannot route HLS subresources.
    let proxy = {
        let conn = state
            .db
            .lock()
            .map_err(|_| crate::error::AppError::new("db_lock_error", "database mutex poisoned"))?;
        crate::settings::get(&conn)?.proxy
    };
    state
        .stream_proxy
        .start(
            url,
            headers,
            session_id,
            hls.unwrap_or(false),
            proxy.as_deref(),
        )
        .await
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
