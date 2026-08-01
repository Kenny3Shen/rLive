//! Tauri command for the localhost image hotlink proxy.

use tauri::State;

use crate::error::AppResult;
use crate::state::AppState;

#[tauri::command]
pub async fn image_proxy_url(state: State<'_, AppState>) -> AppResult<String> {
    state.image_proxy.start().await
}
