//! 本机媒体代理（Web 播放器路径）的 Tauri 命令。

use std::collections::HashMap;

use tauri::State;

use crate::error::AppResult;
use crate::models::live::{DouyuFlvRecovery, SiteId, TwitchAdRecovery};
use crate::state::AppState;
use crate::stream_proxy::{DouyuFlvRecoveryContext, StreamProxyStartOptions, StreamProxyTelemetry};

fn configured_route(state: &State<'_, AppState>) -> AppResult<crate::proxy::ProxyRoute> {
    let conn = state.conn()?;
    Ok(crate::settings::get(&conn)?.proxy_route())
}

#[tauri::command(async)]
pub async fn stream_proxy_start(
    state: State<'_, AppState>,
    url: String,
    headers: HashMap<String, String>,
    session_id: String,
    hls: Option<bool>,
    twitch_ad_recovery: Option<TwitchAdRecovery>,
    douyu_flv_recovery: Option<DouyuFlvRecovery>,
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
    let route = configured_route(&state)?;
    let douyu_flv_recovery = match douyu_flv_recovery {
        Some(recovery) if recovery.room_id.trim().is_empty() || recovery.cdn.trim().is_empty() => {
            return Err(crate::error::AppError::new(
                "douyu_flv_recovery_invalid",
                "斗鱼续流上下文不完整",
            ));
        }
        Some(recovery) => {
            let recovery_client = crate::stream_proxy::build_stream_client(&route)?;
            let cookie = {
                let conn = state.conn()?;
                crate::account::get_cookie(&conn, &SiteId::Douyu)?
            };
            let site = crate::sites::douyu::DouyuSite::new_with_cookie(
                crate::http_client::client_for_route(&route)?,
                cookie.unwrap_or_default(),
            );
            Some(DouyuFlvRecoveryContext::new(
                site,
                recovery_client,
                headers.clone(),
                recovery,
            ))
        }
        None => None,
    };
    state
        .stream_proxy
        .start(
            url,
            headers,
            session_id,
            StreamProxyStartOptions {
                force_hls: hls.unwrap_or(false),
                route: &route,
                twitch_ad_recovery,
                douyu_flv_recovery,
                ..Default::default()
            },
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
