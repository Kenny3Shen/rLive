//! 本机媒体代理（Web 播放器路径）的 Tauri 命令。

use std::collections::HashMap;

use tauri::State;

use crate::error::AppResult;
use crate::models::live::TwitchAdRecovery;
use crate::state::AppState;
use crate::stream_proxy::StreamProxyTelemetry;

fn configured_proxy(state: &State<'_, AppState>) -> AppResult<Option<String>> {
    let conn = state.conn()?;
    Ok(crate::settings::get(&conn)?.proxy)
}

#[tauri::command(async)]
pub async fn stream_proxy_start(
    state: State<'_, AppState>,
    url: String,
    headers: HashMap<String, String>,
    session_id: String,
    hls: Option<bool>,
    twitch_ad_recovery: Option<TwitchAdRecovery>,
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
    // 浏览器只会连接这个回环监听器。因此它的上游 reqwest 客户端必须显式收到
    // 已保存的代理设置；WebView 自身的网络配置无法为 HLS 子资源提供路由。
    let proxy = configured_proxy(&state)?;
    state
        .stream_proxy
        .start(
            url,
            headers,
            session_id,
            hls.unwrap_or(false),
            proxy.as_deref(),
            twitch_ad_recovery,
        )
        .await
}

#[tauri::command]
pub fn stream_proxy_telemetry(
    state: State<'_, AppState>,
    session_id: String,
) -> AppResult<Option<StreamProxyTelemetry>> {
    if session_id.trim().is_empty() {
        return Ok(None);
    }
    Ok(state.stream_proxy.telemetry_for_session(&session_id))
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
