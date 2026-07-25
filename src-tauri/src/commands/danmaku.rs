use serde::Serialize;
use tauri::{AppHandle, State};

use crate::account;
use crate::danmaku;
use crate::error::{AppError, AppResult};
use crate::models::live::SiteId;
use crate::sites;
use crate::state::{AppState, BilibiliDanmakuSendLimiter};

#[derive(Debug, Serialize)]
pub struct BilibiliDanmakuSendStatus {
    /// The user has explicitly opted into this experimental write capability.
    pub experimental_enabled: bool,
    /// The local account has both required session/CSRF cookie values.
    pub cookie_ready: bool,
    /// Both checks passed; the composer may accept a message.
    pub available: bool,
    /// Safe user-facing guidance. It intentionally contains no credential data.
    pub message: String,
}

/// Complete all deterministic local validation before reserving the short
/// manual-send cooldown. This keeps an invalid draft from behaving like a
/// network attempt while still reserving every request that reaches the
/// remote API (including ambiguous failures).
fn validate_and_reserve_bilibili_send(
    limiter: &BilibiliDanmakuSendLimiter,
    room_id: &str,
    message: &str,
) -> AppResult<(String, String)> {
    let room_id = room_id.trim();
    if room_id.is_empty()
        || room_id.len() > 32
        || !room_id.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(
            AppError::new("bilibili_send_invalid_room", "B站直播间号无效").with_site("bilibili"),
        );
    }
    let message = danmaku::bilibili::normalize_outgoing_message(message)?;
    limiter.reserve(room_id)?;
    Ok((room_id.to_string(), message))
}

#[tauri::command]
pub async fn danmaku_connect(
    app: AppHandle,
    state: State<'_, AppState>,
    site_id: SiteId,
    room_id: String,
    connection_epoch: u64,
) -> AppResult<()> {
    if !state.danmaku.begin_connect(connection_epoch) {
        return Ok(());
    }
    // Read account state and settings in one short DB lock.  A site instance
    // owns its own transient web session afterwards, so no lock spans HTTP or
    // WebSocket work.
    let (cookie, settings) = {
        let conn = state
            .db
            .lock()
            .map_err(|_| AppError::new("db_lock_error", "database mutex poisoned"))?;
        (
            account::get_cookie(&conn, &site_id)?,
            crate::settings::get(&conn)?,
        )
    };
    let site = sites::site(&site_id, cookie.clone())?;
    let detail = site.get_room_detail(&room_id).await?;
    // Douyin may derive an anonymous `ttwid` / `msToken` while resolving the
    // room. The signer needs that *same* in-memory browser session, but those
    // transient values must neither reach the frontend nor be persisted.
    let danmaku_cookie = site
        .danmaku_session_cookie()?
        .unwrap_or_else(|| cookie.clone().unwrap_or_default());
    danmaku::connect(
        app,
        &state.danmaku,
        connection_epoch,
        site_id,
        &room_id,
        &detail.raw,
        settings.douyin_danmaku_sign_service.as_deref(),
        &danmaku_cookie,
        settings.proxy.as_deref(),
    )
    .await
}

#[tauri::command]
pub fn danmaku_disconnect(
    state: State<'_, AppState>,
    connection_epoch: Option<u64>,
) -> AppResult<()> {
    if let Some(epoch) = connection_epoch {
        state.danmaku.disconnect_for_generation(epoch);
    } else {
        state.danmaku.disconnect();
    }
    Ok(())
}

#[tauri::command]
pub fn bilibili_danmaku_send_status(
    state: State<'_, AppState>,
) -> AppResult<BilibiliDanmakuSendStatus> {
    let conn = state
        .db
        .lock()
        .map_err(|_| AppError::new("db_lock_error", "database mutex poisoned"))?;
    let settings = crate::settings::get(&conn)?;
    let cookie = account::get_cookie(&conn, &SiteId::Bilibili)?.unwrap_or_default();
    let cookie_ready = danmaku::bilibili::has_send_credentials(&cookie);
    let experimental_enabled = settings.bilibili_danmaku_send_enabled;
    let message = if !experimental_enabled {
        "在设置中启用“实验性 B站发送弹幕”后可使用".into()
    } else if !cookie_ready {
        "请先保存含 SESSDATA 和 bili_jct 的 B站 Cookie".into()
    } else {
        "发送前仍会二次确认；仅支持普通滚动文本。".into()
    };
    Ok(BilibiliDanmakuSendStatus {
        experimental_enabled,
        cookie_ready,
        available: experimental_enabled && cookie_ready,
        message,
    })
}

#[tauri::command]
pub async fn bilibili_danmaku_send(
    state: State<'_, AppState>,
    room_id: String,
    message: String,
) -> AppResult<()> {
    let (settings, cookie) = {
        let conn = state
            .db
            .lock()
            .map_err(|_| AppError::new("db_lock_error", "database mutex poisoned"))?;
        (
            crate::settings::get(&conn)?,
            account::get_cookie(&conn, &SiteId::Bilibili)?.unwrap_or_default(),
        )
    };
    if !settings.bilibili_danmaku_send_enabled {
        return Err(AppError::new(
            "bilibili_send_disabled",
            "B站实验性发送弹幕尚未启用，请先在设置中确认开启",
        )
        .with_site("bilibili"));
    }
    if !danmaku::bilibili::has_send_credentials(&cookie) {
        return Err(AppError::new(
            "bilibili_send_cookie_missing",
            "请先在设置中保存含 SESSDATA 和 bili_jct 的 B站 Cookie",
        )
        .with_site("bilibili"));
    }
    let (room_id, message) =
        validate_and_reserve_bilibili_send(&state.bilibili_send_limiter, &room_id, &message)?;
    let client = if settings.proxy.is_some() {
        crate::http_client::build_client(settings.proxy.as_deref())?
    } else {
        crate::http_client::default_client()
    };
    danmaku::bilibili::send_chat(&client, &cookie, &room_id, &message).await
}

#[cfg(test)]
mod tests {
    use super::validate_and_reserve_bilibili_send;
    use crate::state::BilibiliDanmakuSendLimiter;

    #[test]
    fn invalid_bilibili_draft_does_not_consume_room_cooldown() {
        let limiter = BilibiliDanmakuSendLimiter::new();

        assert!(validate_and_reserve_bilibili_send(&limiter, "123", "\n").is_err());
        // The following valid attempt has no reason to wait: no upstream send
        // was attempted for the invalid draft above.
        assert!(validate_and_reserve_bilibili_send(&limiter, "123", "你好").is_ok());
        assert!(validate_and_reserve_bilibili_send(&limiter, "123", "第二条").is_err());
    }
}
