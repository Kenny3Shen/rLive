use tauri::{AppHandle, State};

use crate::error::AppResult;
use crate::state::AppState;
use crate::web_bridge::WebBridgeInfo;

/// Starts the browser-facing bridge and returns the URL to open.
///
/// `allow_lan` binds every interface instead of loopback, which lets a phone on
/// the same network use this machine's rLive. That also means anyone who can
/// reach the port drives this machine's database and saved accounts, so the
/// bridge issues a shared token in that mode and the UI has to surface it.
#[tauri::command(async)]
pub async fn web_bridge_start(
    app: AppHandle,
    state: State<'_, AppState>,
    allow_lan: Option<bool>,
) -> AppResult<WebBridgeInfo> {
    state
        .web_bridge
        .start(app, allow_lan.unwrap_or(false))
        .await
}

#[tauri::command]
pub fn web_bridge_stop(state: State<'_, AppState>) {
    state.web_bridge.stop();
}

#[tauri::command]
pub fn web_bridge_status(state: State<'_, AppState>) -> Option<WebBridgeInfo> {
    state.web_bridge.status()
}
