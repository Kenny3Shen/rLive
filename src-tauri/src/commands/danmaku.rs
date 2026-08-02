use serde::Serialize;
use tauri::{AppHandle, State};

use crate::account;
use crate::danmaku;
use crate::db::danmaku_send_history;
use crate::error::{AppError, AppResult};
use crate::models::live::SiteId;
use crate::sites;
use crate::state::{
    AppState, BilibiliDanmakuSendLimiter, DouyinDanmakuSendLimiter, DouyuDanmakuSendLimiter,
    HuyaDanmakuSendLimiter,
};

#[derive(Debug, Serialize)]
pub struct BilibiliDanmakuSendStatus {
    /// The user has enabled this device-local write capability.
    pub send_enabled: bool,
    /// The local account has both required session/CSRF cookie values.
    pub cookie_ready: bool,
    /// Both checks passed; the composer may accept a message.
    pub available: bool,
    /// Safe user-facing guidance. It intentionally contains no credential data.
    pub message: String,
}

/// Availability of the locally stored Douyu account for one user-initiated
/// ordinary text message. The shared device-local sending permission and the
/// authenticated Cookie are both required before the user can submit it.
#[derive(Debug, Serialize)]
pub struct DouyuDanmakuSendStatus {
    pub send_enabled: bool,
    pub cookie_ready: bool,
    pub available: bool,
    pub message: String,
}

/// Availability of the locally stored Huya web session for one explicit
/// ordinary text message. The websocket verifies the Cookie before every
/// write, so this status is only a local preflight, not an authentication
/// assertion.
#[derive(Debug, Serialize)]
pub struct HuyaDanmakuSendStatus {
    pub send_enabled: bool,
    pub cookie_ready: bool,
    pub available: bool,
    pub message: String,
}

/// Availability of the locally stored Douyin web session for one explicit
/// ordinary text message. The shared device-local sending permission and a
/// non-empty Cookie are both required before the user can submit it.
#[derive(Debug, Serialize)]
pub struct DouyinDanmakuSendStatus {
    pub send_enabled: bool,
    pub cookie_ready: bool,
    pub available: bool,
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

/// Complete deterministic local validation before reserving the manual-send
/// cooldown. In particular, an invalid draft must not consume the cooldown
/// for the next valid user action.
fn validate_and_reserve_douyu_send(
    limiter: &DouyuDanmakuSendLimiter,
    room_id: &str,
    message: &str,
) -> AppResult<(String, String)> {
    let room_id = room_id.trim();
    if room_id.is_empty()
        || room_id.len() > 32
        || !room_id.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(AppError::new("douyu_send_invalid_room", "斗鱼直播间号无效").with_site("douyu"));
    }
    let message = danmaku::douyu::normalize_outgoing_message(message)?;
    limiter.reserve(room_id)?;
    Ok((room_id.to_string(), message))
}

fn validate_huya_send_room(room_id: &str) -> AppResult<String> {
    let room_id = room_id.trim();
    if room_id.is_empty()
        || room_id.len() > 64
        || !room_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return Err(AppError::new("huya_send_invalid_room", "虎牙直播间号无效").with_site("huya"));
    }
    Ok(room_id.to_owned())
}

/// Reserve only after the room lookup has completed. A malformed draft or a
/// room whose metadata cannot be resolved never reaches the authenticated
/// signal write and therefore should not make the next valid action wait.
fn validate_and_reserve_huya_send(
    limiter: &HuyaDanmakuSendLimiter,
    room_id: &str,
    message: &str,
) -> AppResult<(String, String)> {
    let room_id = validate_huya_send_room(room_id)?;
    let message = danmaku::huya::normalize_outgoing_message(message)?;
    limiter.reserve(&room_id)?;
    Ok((room_id, message))
}

fn validate_and_reserve_douyin_send(
    limiter: &DouyinDanmakuSendLimiter,
    room_id: &str,
    message: &str,
) -> AppResult<(String, String)> {
    let room_id = room_id.trim();
    if room_id.is_empty()
        || room_id.len() > 32
        || !room_id.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(
            AppError::new("douyin_send_invalid_room", "抖音直播间号无效").with_site("douyin"),
        );
    }
    let message = danmaku::douyin::normalize_outgoing_message(message)?;
    limiter.reserve(room_id)?;
    Ok((room_id.to_string(), message))
}

/// A successful platform write is the only point at which an outgoing message
/// becomes reusable history. History is convenience data, so a local database
/// failure must never turn an already accepted platform write into a false
/// failure in the UI.
fn record_successful_danmaku_send(state: &AppState, site_id: SiteId, content: &str) {
    let sent_at = chrono::Utc::now().timestamp_millis();
    let result = state
        .db
        .lock()
        .map_err(|_| AppError::new("db_lock_error", "database mutex poisoned"))
        .and_then(|conn| danmaku_send_history::record(&conn, site_id.as_str(), content, sent_at));
    if let Err(error) = result {
        // Do not include the outgoing content in logs. It can be personal,
        // while the app's release log is intentionally failure-only.
        tracing::warn!(site = site_id.as_str(), error_code = %error.code, "could not save danmaku send history");
    }
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
    // The room-detail request is also needed before a websocket can join. Use
    // the same proxy setting as ordinary browsing so Twitch rooms do not fail
    // before their anonymous IRC connection is started.
    let site = sites::site_with_proxy(&site_id, cookie.clone(), settings.proxy.as_deref())?;
    // Bilibili danmaku works without a session. When the saved Cookie is
    // expired, the room detail is still fetched, but the chat connection must
    // fall back to the anonymous mode instead of silently using a dead uid.
    // Probe the session concurrently with the detail request so the room
    // entry latency is unchanged.
    let (detail, cookie_status) = tokio::join!(
        site.get_room_detail(&room_id),
        async {
            match (&site_id, &cookie) {
                (SiteId::Bilibili, Some(value)) if !value.trim().is_empty() => {
                    crate::sites::bilibili::cookie_session_status(
                        value,
                        settings.proxy.as_deref(),
                    )
                    .await
                }
                _ => None,
            }
        },
    );
    let mut detail = detail?;
    let mut identity_cookie = cookie.clone();
    let mut notice: Option<String> = None;
    if cookie_status == Some(false) {
        tracing::warn!(
            room_id = %room_id.trim(),
            "bilibili cookie expired; danmaku falls back to anonymous mode"
        );
        strip_bilibili_danmaku_cookie(&mut detail.raw);
        identity_cookie = None;
        notice = Some(
            "B站 Cookie 已失效，弹幕已切换为匿名模式。请在设置中重新登录。".to_string(),
        );
    }
    // Douyin may derive an anonymous `ttwid` / `msToken` while resolving the
    // room. The WSS handshake needs that same in-memory browser session, but
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
        &danmaku_cookie,
        identity_cookie.as_deref().unwrap_or_default(),
        settings.proxy.as_deref(),
        notice,
    )
    .await
}

/// Remove the account Cookie and viewer identity from cached room detail so a
/// Bilibili chat connection joins anonymously (`uid = 0`, no session cookie).
fn strip_bilibili_danmaku_cookie(raw: &mut serde_json::Value) {
    if let Some(danmaku) = raw.get_mut("danmaku").and_then(serde_json::Value::as_object_mut) {
        danmaku.insert(
            "cookie".to_string(),
            serde_json::Value::String(String::new()),
        );
        danmaku.insert(
            "viewer_uid".to_string(),
            serde_json::Value::Number(0.into()),
        );
    }
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
    let send_enabled = settings.danmaku_send_enabled;
    let message = if !send_enabled {
        "在设置中启用“弹幕发送功能”后可使用".into()
    } else if !cookie_ready {
        "请先保存含 SESSDATA 和 bili_jct 的 B站 Cookie".into()
    } else {
        "可发送单条普通滚动文本。".into()
    };
    Ok(BilibiliDanmakuSendStatus {
        send_enabled,
        cookie_ready,
        available: send_enabled && cookie_ready,
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
    if !settings.danmaku_send_enabled {
        return Err(AppError::new(
            "bilibili_send_disabled",
            "弹幕发送功能尚未启用，请先在设置中确认开启",
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
    // This request carries the user's browser Cookie. A redirect target must
    // never receive it, so the write path deliberately opts out of redirect
    // following for both proxied and direct requests.
    let client = crate::http_client::build_no_redirect_client(settings.proxy.as_deref())?;
    danmaku::bilibili::send_chat(&client, &cookie, &room_id, &message).await?;
    record_successful_danmaku_send(state.inner(), SiteId::Bilibili, &message);
    Ok(())
}

#[tauri::command]
pub fn douyu_danmaku_send_status(state: State<'_, AppState>) -> AppResult<DouyuDanmakuSendStatus> {
    let conn = state
        .db
        .lock()
        .map_err(|_| AppError::new("db_lock_error", "database mutex poisoned"))?;
    let settings = crate::settings::get(&conn)?;
    let cookie = account::get_cookie(&conn, &SiteId::Douyu)?.unwrap_or_default();
    let cookie_ready = danmaku::douyu::has_send_credentials(&cookie);
    let send_enabled = settings.danmaku_send_enabled;
    let message = if !send_enabled {
        "在设置中启用“弹幕发送功能”后可使用".into()
    } else if cookie_ready {
        "可发送单条普通文本。".into()
    } else {
        "请先在设置中扫码登录，或保存含账号、设备和弹幕令牌字段的完整斗鱼 Cookie".into()
    };
    Ok(DouyuDanmakuSendStatus {
        send_enabled,
        cookie_ready,
        available: send_enabled && cookie_ready,
        message,
    })
}

#[tauri::command]
pub async fn douyu_danmaku_send(
    state: State<'_, AppState>,
    room_id: String,
    message: String,
) -> AppResult<()> {
    let (send_enabled, cookie, proxy) = {
        let conn = state
            .db
            .lock()
            .map_err(|_| AppError::new("db_lock_error", "database mutex poisoned"))?;
        let settings = crate::settings::get(&conn)?;
        (
            settings.danmaku_send_enabled,
            account::get_cookie(&conn, &SiteId::Douyu)?.unwrap_or_default(),
            settings.proxy,
        )
    };
    if !send_enabled {
        return Err(AppError::new(
            "douyu_send_disabled",
            "弹幕发送功能尚未启用，请先在设置中确认开启",
        )
        .with_site("douyu"));
    }
    if !danmaku::douyu::has_send_credentials(&cookie) {
        tracing::warn!(
            room_id = %room_id.trim(),
            stage = "preflight",
            "douyu send rejected because the required Cookie fields are absent"
        );
        return Err(AppError::new(
            "douyu_send_cookie_missing",
            "请先在设置中扫码登录，或保存含账号、设备和弹幕令牌字段的完整斗鱼 Cookie",
        )
        .with_site("douyu"));
    }
    let (room_id, message) =
        validate_and_reserve_douyu_send(&state.douyu_send_limiter, &room_id, &message).map_err(
            |error| {
                tracing::warn!(
                    room_id = %room_id.trim(),
                    stage = "preflight",
                    error_code = %error.code,
                    "douyu send rejected by local validation"
                );
                error
            },
        )?;
    danmaku::douyu::send_chat(&cookie, &room_id, &message, proxy.as_deref()).await?;
    record_successful_danmaku_send(state.inner(), SiteId::Douyu, &message);
    Ok(())
}

#[tauri::command]
pub fn huya_danmaku_send_status(state: State<'_, AppState>) -> AppResult<HuyaDanmakuSendStatus> {
    let conn = state
        .db
        .lock()
        .map_err(|_| AppError::new("db_lock_error", "database mutex poisoned"))?;
    let settings = crate::settings::get(&conn)?;
    let cookie = account::get_cookie(&conn, &SiteId::Huya)?.unwrap_or_default();
    let cookie_ready = danmaku::huya::has_send_credentials(&cookie);
    let send_enabled = settings.danmaku_send_enabled;
    let message = if !send_enabled {
        "在设置中启用“弹幕发送功能”后可使用".into()
    } else if cookie_ready {
        "可发送单条普通文本。".into()
    } else {
        "请先在设置中保存含 yyuid 或 udb_uid，且含 udb_n 或 udb_cred 的完整虎牙 Cookie".into()
    };
    Ok(HuyaDanmakuSendStatus {
        send_enabled,
        cookie_ready,
        available: send_enabled && cookie_ready,
        message,
    })
}

#[tauri::command]
pub async fn huya_danmaku_send(
    state: State<'_, AppState>,
    room_id: String,
    message: String,
) -> AppResult<()> {
    let (send_enabled, cookie, proxy) = {
        let conn = state
            .db
            .lock()
            .map_err(|_| AppError::new("db_lock_error", "database mutex poisoned"))?;
        let settings = crate::settings::get(&conn)?;
        (
            settings.danmaku_send_enabled,
            account::get_cookie(&conn, &SiteId::Huya)?.unwrap_or_default(),
            settings.proxy,
        )
    };
    if !send_enabled {
        return Err(AppError::new(
            "huya_send_disabled",
            "弹幕发送功能尚未启用，请先在设置中确认开启",
        )
        .with_site("huya"));
    }
    if !danmaku::huya::has_send_credentials(&cookie) {
        tracing::warn!(
            room_id = %room_id.trim(),
            stage = "preflight",
            error_code = "huya_send_cookie_missing",
            "huya send rejected because the required Cookie fields are absent"
        );
        return Err(AppError::new(
            "huya_send_cookie_missing",
            "请先在设置中保存含 yyuid 或 udb_uid，且含 udb_n 或 udb_cred 的完整虎牙 Cookie",
        )
        .with_site("huya"));
    }
    // Resolve the canonical top/sub/presenter ids instead of using a short
    // public room id directly in the TARS request.
    let room_id = validate_huya_send_room(&room_id)?;
    let site = sites::site_with_proxy(&SiteId::Huya, Some(cookie.clone()), proxy.as_deref())?;
    let detail = site.get_room_detail(&room_id).await?;
    let args = danmaku::huya::args_from_raw(&room_id, &detail.raw)?;
    let (_room_id, message) =
        validate_and_reserve_huya_send(&state.huya_send_limiter, &room_id, &message)?;
    danmaku::huya::send_chat(&cookie, args, &message).await?;
    record_successful_danmaku_send(state.inner(), SiteId::Huya, &message);
    Ok(())
}

#[tauri::command]
pub fn douyin_danmaku_send_status(
    state: State<'_, AppState>,
) -> AppResult<DouyinDanmakuSendStatus> {
    let conn = state
        .db
        .lock()
        .map_err(|_| AppError::new("db_lock_error", "database mutex poisoned"))?;
    let settings = crate::settings::get(&conn)?;
    let cookie = account::get_cookie(&conn, &SiteId::Douyin)?.unwrap_or_default();
    let cookie_ready = !cookie.trim().is_empty();
    let send_enabled = settings.danmaku_send_enabled;
    let message = if !send_enabled {
        "在设置中启用“弹幕发送功能”后可使用".into()
    } else if !cookie_ready {
        "请先在设置中扫码登录，或保存抖音 Cookie".into()
    } else {
        "可发送单条普通滚动文本。".into()
    };
    Ok(DouyinDanmakuSendStatus {
        send_enabled,
        cookie_ready,
        available: send_enabled && cookie_ready,
        message,
    })
}

#[tauri::command]
pub async fn douyin_danmaku_send(
    state: State<'_, AppState>,
    room_id: String,
    message: String,
) -> AppResult<()> {
    let (send_enabled, cookie, proxy) = {
        let conn = state
            .db
            .lock()
            .map_err(|_| AppError::new("db_lock_error", "database mutex poisoned"))?;
        let settings = crate::settings::get(&conn)?;
        (
            settings.danmaku_send_enabled,
            account::get_cookie(&conn, &SiteId::Douyin)?.unwrap_or_default(),
            settings.proxy,
        )
    };
    if !send_enabled {
        return Err(AppError::new(
            "douyin_send_disabled",
            "弹幕发送功能尚未启用，请先在设置中确认开启",
        )
        .with_site("douyin"));
    }
    if cookie.trim().is_empty() {
        tracing::warn!(
            room_id = %room_id.trim(),
            stage = "preflight",
            "douyin send rejected because the required Cookie is absent"
        );
        return Err(AppError::new(
            "douyin_send_cookie_missing",
            "请先在设置中扫码登录，或保存抖音 Cookie",
        )
        .with_site("douyin"));
    }
    // Douyin send needs the internal room id (from room detail raw), not the
    // short public web_rid. Resolve detail first, then reserve the cooldown.
    let site = sites::site_with_proxy(&SiteId::Douyin, Some(cookie.clone()), proxy.as_deref())?;
    let detail = site.get_room_detail(&room_id).await?;
    let actual_room_id = detail
        .raw
        .get("room_id")
        .and_then(|value| match value {
            serde_json::Value::String(value) => Some(value.trim().to_string()),
            serde_json::Value::Number(value) => Some(value.to_string()),
            _ => None,
        })
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| room_id.trim().to_string());
    let (actual_room_id, message) =
        validate_and_reserve_douyin_send(&state.douyin_send_limiter, &actual_room_id, &message)
            .map_err(|error| {
                tracing::warn!(
                    room_id = %room_id.trim(),
                    stage = "preflight",
                    error_code = %error.code,
                    "douyin send rejected by local validation"
                );
                error
            })?;
    // Cookie-bearing write: do not follow redirects.
    let client = crate::http_client::build_no_redirect_client(proxy.as_deref())?;
    danmaku::douyin::send_chat(&client, &cookie, &actual_room_id, &message).await?;
    record_successful_danmaku_send(state.inner(), SiteId::Douyin, &message);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        strip_bilibili_danmaku_cookie, validate_and_reserve_bilibili_send,
        validate_and_reserve_douyin_send, validate_and_reserve_douyu_send,
        validate_and_reserve_huya_send,
    };
    use crate::state::{
        BilibiliDanmakuSendLimiter, DouyinDanmakuSendLimiter, DouyuDanmakuSendLimiter,
        HuyaDanmakuSendLimiter,
    };

    #[test]
    fn invalid_bilibili_draft_does_not_consume_room_cooldown() {
        let limiter = BilibiliDanmakuSendLimiter::new();

        assert!(validate_and_reserve_bilibili_send(&limiter, "123", "\n").is_err());
        // The following valid attempt has no reason to wait: no upstream send
        // was attempted for the invalid draft above.
        assert!(validate_and_reserve_bilibili_send(&limiter, "123", "你好").is_ok());
        assert!(validate_and_reserve_bilibili_send(&limiter, "123", "第二条").is_err());
    }

    #[test]
    fn bilibili_anonymous_strip_removes_cookie_and_viewer_uid() {
        let mut raw = serde_json::json!({
            "room_id": 1,
            "danmaku": {
                "token": "token",
                "cookie": "SESSDATA=secret; bili_jct=csrf",
                "viewer_uid": 42,
                "server_hosts": ["host-a.example"],
            }
        });
        strip_bilibili_danmaku_cookie(&mut raw);

        assert_eq!(raw["danmaku"]["cookie"], "");
        assert_eq!(raw["danmaku"]["viewer_uid"], 0);
        // The connection metadata is untouched: only the session identity is
        // removed, so the anonymous join keeps the shared token and hosts.
        assert_eq!(raw["danmaku"]["token"], "token");
        assert_eq!(raw["danmaku"]["server_hosts"][0], "host-a.example");
    }

    #[test]
    fn invalid_douyu_draft_does_not_consume_room_cooldown() {
        let limiter = DouyuDanmakuSendLimiter::new();

        assert!(validate_and_reserve_douyu_send(&limiter, "123", "\n").is_err());
        assert!(validate_and_reserve_douyu_send(&limiter, "123", "你好").is_ok());
        assert!(validate_and_reserve_douyu_send(&limiter, "123", "第二条").is_err());
    }

    #[test]
    fn invalid_huya_draft_does_not_consume_room_cooldown() {
        let limiter = HuyaDanmakuSendLimiter::new();

        assert!(validate_and_reserve_huya_send(&limiter, "room-1", "\n").is_err());
        assert!(validate_and_reserve_huya_send(&limiter, "room-1", "你好").is_ok());
        assert!(validate_and_reserve_huya_send(&limiter, "room-1", "第二条").is_err());
    }

    #[test]
    fn invalid_douyin_draft_does_not_consume_room_cooldown() {
        let limiter = DouyinDanmakuSendLimiter::new();

        assert!(validate_and_reserve_douyin_send(&limiter, "123", "\n").is_err());
        assert!(validate_and_reserve_douyin_send(&limiter, "123", "你好").is_ok());
        assert!(validate_and_reserve_douyin_send(&limiter, "123", "第二条").is_err());
    }
}
