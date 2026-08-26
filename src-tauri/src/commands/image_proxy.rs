//! 本机图片防盗链代理的 Tauri 命令。

use tauri::State;

use crate::error::AppResult;
use crate::state::AppState;

#[tauri::command]
pub async fn image_proxy_url(state: State<'_, AppState>) -> AppResult<String> {
    state.image_proxy.start().await
}
