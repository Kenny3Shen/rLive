use serde::Serialize;
use tauri::{AppHandle, State};

use crate::account;
use crate::danmu_rs;
use crate::db::{danmaku_send_history, history};
use crate::error::{AppError, AppResult};
use crate::models::live::SiteId;
use crate::sites;
use crate::state::{AppState, DanmakuSendLimiter};

/// 手动发送单条弹幕前的本地预检结果。用户提交之前，需要同时具备共享的
/// 本机发送权限和已认证的 Cookie；这只是本地预检，并不是认证结论。
#[derive(Debug, Serialize)]
pub struct DanmakuSendStatus {
    /// 用户已启用这项仅限本机的写入能力。
    pub send_enabled: bool,
    /// 本地账号同时具备发送所需的凭据字段。
    pub cookie_ready: bool,
    /// 两项检查都通过；输入框可以接受消息。
    pub available: bool,
    /// 面向用户的安全提示文案。其中刻意不包含任何凭据数据。
    pub message: String,
}

/// 在占用短暂的手动发送冷却之前，先完成所有确定性的本地校验。这样既能让
/// 无效草稿不表现为一次网络尝试，又能为每个真正到达远端 API 的请求
/// （包括结果不明的失败）都占用冷却。Bilibili 与斗鱼共用数字房间号规则；
/// 站点差异（错误码与文案、消息规范化）由 limiter 实例携带。
fn validate_and_reserve_send(
    limiter: &DanmakuSendLimiter,
    room_id: &str,
    message: &str,
) -> AppResult<(String, String)> {
    let room_id = room_id.trim();
    if room_id.is_empty()
        || room_id.len() > 32
        || !room_id.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(AppError::new(
            format!("{}_send_invalid_room", limiter.site),
            format!("{}直播间号无效", limiter.label),
        )
        .with_site(limiter.site));
    }
    let message = (limiter.normalize)(message)?;
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

/// 只有在房间信息查询完成之后才占用冷却。格式错误的草稿，或元数据无法解析的
/// 房间，都不会走到已认证的信令写入，
/// 因此不应让下一次有效操作等待。
fn validate_and_reserve_huya_send(
    limiter: &DanmakuSendLimiter,
    room_id: &str,
    message: &str,
) -> AppResult<(String, String)> {
    let room_id = validate_huya_send_room(room_id)?;
    let message = (limiter.normalize)(message)?;
    limiter.reserve(&room_id)?;
    Ok((room_id, message))
}

/// 只有平台写入成功，发出的消息才会成为可复用的历史记录。历史属于便利数据，
/// 因此本地数据库失败绝不能把平台已接受的写入
/// 在 UI 上变成一次假失败。
///
/// 房间元数据尽力而为。当前播放器提供它已渲染出的详情；
/// 观看历史补齐缺失字段，
/// 不会在成功发送路径上增加网络请求。
fn record_successful_danmaku_send(
    state: &AppState,
    site_id: SiteId,
    content: &str,
    room_id: &str,
    room_title: Option<&str>,
    room_user_name: Option<&str>,
) {
    let sent_at = chrono::Utc::now().timestamp_millis();
    let result = state.conn().and_then(|conn| {
            let mut title = room_title.unwrap_or_default().trim().to_owned();
            let mut user_name = room_user_name.unwrap_or_default().trim().to_owned();
            if (title.is_empty() || user_name.is_empty())
                && let Some((history_title, history_user_name)) =
                    history::metadata_for_room(&conn, site_id.as_str(), room_id).unwrap_or_default()
            {
                if title.is_empty() {
                    title = history_title;
                }
                if user_name.is_empty() {
                    user_name = history_user_name;
                }
            }
            danmaku_send_history::record(
                &conn,
                site_id.as_str(),
                content,
                room_id,
                &title,
                &user_name,
                sent_at,
            )
        });
    if let Err(error) = result {
        // 不要把发出的内容写入日志。它可能涉及个人信息，
        // 而应用的发布版日志刻意只记录失败。
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
    let source_key = format!("live:{}:{}", site_id.as_str(), room_id.trim());
    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
    let retained_source = state
        .danmaku
        .active_source_key()
        .filter(|source_key| state.recording.has_background_danmaku_recording(source_key));
    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
    let retained_source: Option<String> = None;
    if !state
        .danmaku
        .begin_connect(connection_epoch, source_key, retained_source.is_some())
    {
        return Ok(());
    }
    // 消除"完成与路由清理"的竞争：如果录制在第一次检查之后、
    // 连接被分离之前完成，它的完成回调此时还看不到后台任务。
    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
    if let Some(source_key) = retained_source
        && !state
            .recording
            .has_background_danmaku_recording(&source_key)
    {
        state.danmaku.disconnect_background_for_source(&source_key);
    }
    // 在一次短暂的数据库加锁中读完账号状态与设置。之后站点实例自行持有
    // 临时的 Web 会话，因此没有任何锁会跨越 HTTP 或
    // WebSocket 操作。
    let (cookie, settings) = {
        let conn = state.conn()?;
        (
            account::get_cookie(&conn, &site_id)?,
            crate::settings::get(&conn)?,
        )
    };
    // websocket 加入房间前同样需要房间详情请求。这里使用与普通浏览相同的
    // 代理设置，避免 Twitch 房间在匿名 IRC 连接启动前就失败。
    let site = sites::site_with_proxy(&site_id, cookie.clone(), settings.proxy.as_deref())?;
    // Bilibili 弹幕在没有会话时也能工作。当保存的 Cookie 已过期时，房间详情
    // 仍会被拉取，但聊天连接必须回退到匿名模式，
    // 而不是悄悄使用一个失效的 uid。
    // 会话探测与详情请求并发进行，
    // 使进入房间的耗时保持不变。
    let (detail, cookie_status) = tokio::join!(site.get_room_detail(&room_id), async {
        match (&site_id, &cookie) {
            (SiteId::Bilibili, Some(value)) if !value.trim().is_empty() => {
                crate::sites::bilibili::cookie_session_status(value, settings.proxy.as_deref())
                    .await
            }
            _ => None,
        }
    },);
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
        notice = Some("B站 Cookie 已失效，弹幕已切换为匿名模式。请在设置中重新登录。".to_string());
    }
    // 抖音在解析房间时可能派生出匿名的 `ttwid` / `msToken`。WSS 握手需要同一份
    // 内存中的浏览器会话，但这些临时值既不能到达前端也不能被持久化。
    let danmaku_cookie = site
        .danmaku_session_cookie()?
        .unwrap_or_else(|| cookie.clone().unwrap_or_default());
    danmu_rs::connect(
        app,
        &state.danmaku,
        danmu_rs::DanmakuConnectRequest {
            generation: connection_epoch,
            site_id,
            room_id: &room_id,
            detail_raw: &detail.raw,
            cookie: &danmaku_cookie,
            identity_cookie: identity_cookie.as_deref().unwrap_or_default(),
            proxy: settings.proxy.as_deref(),
            notice,
        },
    )
    .await
}

/// 从缓存的房间详情中移除账号 Cookie 与观众身份，
/// 使 Bilibili 聊天连接以匿名方式加入（`uid = 0`，不带 session cookie）。
fn strip_bilibili_danmaku_cookie(raw: &mut serde_json::Value) {
    if let Some(danmaku) = raw
        .get_mut("danmaku")
        .and_then(serde_json::Value::as_object_mut)
    {
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
        #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
        if let Some(source_key) = state.danmaku.source_key_for_generation(epoch)
            && state
                .recording
                .has_background_danmaku_recording(&source_key)
        {
            let detached = state.danmaku.detach_for_generation(epoch);
            // 分离后重新检查，原因与 `danmaku_connect` 相同：
            // 录制收尾与路由清理会并发执行。
            if detached
                && !state
                    .recording
                    .has_background_danmaku_recording(&source_key)
            {
                state.danmaku.disconnect_background_for_source(&source_key);
            }
            return Ok(());
        }
        state.danmaku.disconnect_for_generation(epoch);
    } else {
        state.danmaku.disconnect();
    }
    Ok(())
}

#[tauri::command]
pub fn bilibili_danmaku_send_status(state: State<'_, AppState>) -> AppResult<DanmakuSendStatus> {
    let conn = state.conn()?;
    let settings = crate::settings::get(&conn)?;
    let cookie = account::get_cookie(&conn, &SiteId::Bilibili)?.unwrap_or_default();
    let cookie_ready = danmu_rs::bilibili::has_send_credentials(&cookie);
    let send_enabled = settings.danmaku_send_enabled;
    let message = if !send_enabled {
        "在设置中启用“弹幕发送功能”后可使用".into()
    } else if !cookie_ready {
        "请先保存含 SESSDATA 和 bili_jct 的 B站 Cookie".into()
    } else {
        "可发送单条弹幕。".into()
    };
    Ok(DanmakuSendStatus {
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
    room_title: Option<String>,
    room_user_name: Option<String>,
) -> AppResult<()> {
    let (settings, cookie) = {
        let conn = state.conn()?;
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
    if !danmu_rs::bilibili::has_send_credentials(&cookie) {
        return Err(AppError::new(
            "bilibili_send_cookie_missing",
            "请先在设置中保存含 SESSDATA 和 bili_jct 的 B站 Cookie",
        )
        .with_site("bilibili"));
    }
    let (room_id, message) =
        validate_and_reserve_send(&state.bilibili_send_limiter, &room_id, &message)?;
    // 该请求携带用户的浏览器 Cookie。重定向目标绝不能收到它，
    // 因此写入路径对代理请求和直连请求都刻意关闭了重定向跟随。
    let client = crate::http_client::build_no_redirect_client(settings.proxy.as_deref())?;
    danmu_rs::bilibili::send_chat(&client, &cookie, &room_id, &message).await?;
    record_successful_danmaku_send(
        state.inner(),
        SiteId::Bilibili,
        &message,
        &room_id,
        room_title.as_deref(),
        room_user_name.as_deref(),
    );
    Ok(())
}

#[tauri::command]
pub fn douyu_danmaku_send_status(state: State<'_, AppState>) -> AppResult<DanmakuSendStatus> {
    let conn = state.conn()?;
    let settings = crate::settings::get(&conn)?;
    let cookie = account::get_cookie(&conn, &SiteId::Douyu)?.unwrap_or_default();
    let cookie_ready = danmu_rs::douyu::has_send_credentials(&cookie);
    let send_enabled = settings.danmaku_send_enabled;
    let message = if !send_enabled {
        "在设置中启用“弹幕发送功能”后可使用".into()
    } else if cookie_ready {
        "可发送单条弹幕。".into()
    } else {
        "请先在设置中扫码登录，或保存含账号、设备和弹幕令牌字段的完整斗鱼 Cookie".into()
    };
    Ok(DanmakuSendStatus {
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
    room_title: Option<String>,
    room_user_name: Option<String>,
) -> AppResult<()> {
    let (send_enabled, cookie, proxy) = {
        let conn = state.conn()?;
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
    if !danmu_rs::douyu::has_send_credentials(&cookie) {
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
        validate_and_reserve_send(&state.douyu_send_limiter, &room_id, &message)
            .inspect_err(|error| {
                tracing::warn!(
                    room_id = %room_id.trim(),
                    stage = "preflight",
                    error_code = %error.code,
                    "douyu send rejected by local validation"
                );
            })?;
    danmu_rs::douyu::send_chat(&cookie, &room_id, &message, proxy.as_deref()).await?;
    record_successful_danmaku_send(
        state.inner(),
        SiteId::Douyu,
        &message,
        &room_id,
        room_title.as_deref(),
        room_user_name.as_deref(),
    );
    Ok(())
}

#[tauri::command]
pub fn huya_danmaku_send_status(state: State<'_, AppState>) -> AppResult<DanmakuSendStatus> {
    let conn = state.conn()?;
    let settings = crate::settings::get(&conn)?;
    let cookie = account::get_cookie(&conn, &SiteId::Huya)?.unwrap_or_default();
    let cookie_ready = danmu_rs::huya::has_send_credentials(&cookie);
    let send_enabled = settings.danmaku_send_enabled;
    let message = if !send_enabled {
        "在设置中启用“弹幕发送功能”后可使用".into()
    } else if cookie_ready {
        "可发送单条普通文本。".into()
    } else {
        "请先在设置中保存含 yyuid 或 udb_uid，且含 udb_n 或 udb_cred 的完整虎牙 Cookie".into()
    };
    Ok(DanmakuSendStatus {
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
    room_title: Option<String>,
    room_user_name: Option<String>,
) -> AppResult<()> {
    let (send_enabled, cookie, proxy) = {
        let conn = state.conn()?;
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
    if !danmu_rs::huya::has_send_credentials(&cookie) {
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
    // 解析出规范的 top/sub/presenter id，
    // 而不是把短公开房间号直接用于 TARS 请求。
    let room_id = validate_huya_send_room(&room_id)?;
    let site = sites::site_with_proxy(&SiteId::Huya, Some(cookie.clone()), proxy.as_deref())?;
    let detail = site.get_room_detail(&room_id).await?;
    let args = danmu_rs::huya::args_from_raw(&room_id, &detail.raw)?;
    let (_room_id, message) =
        validate_and_reserve_huya_send(&state.huya_send_limiter, &room_id, &message)?;
    danmu_rs::huya::send_chat(&cookie, args, &message).await?;
    record_successful_danmaku_send(
        state.inner(),
        SiteId::Huya,
        &message,
        &room_id,
        if detail.title.trim().is_empty() {
            room_title.as_deref()
        } else {
            Some(&detail.title)
        },
        if detail.user_name.trim().is_empty() {
            room_user_name.as_deref()
        } else {
            Some(&detail.user_name)
        },
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        strip_bilibili_danmaku_cookie, validate_and_reserve_huya_send, validate_and_reserve_send,
    };
    use crate::danmu_rs;
    use crate::state::DanmakuSendLimiter;

    #[test]
    fn invalid_bilibili_draft_does_not_consume_room_cooldown() {
        let limiter = DanmakuSendLimiter::new(
            "bilibili",
            "B站",
            danmu_rs::bilibili::normalize_outgoing_message,
        );

        assert!(validate_and_reserve_send(&limiter, "123", "\n").is_err());
        // 随后的有效尝试没有理由等待：
        // 上面那份无效草稿并没有向上游发起任何发送。
        assert!(validate_and_reserve_send(&limiter, "123", "你好").is_ok());
        assert!(validate_and_reserve_send(&limiter, "123", "第二条").is_err());
        let error = validate_and_reserve_send(&limiter, "abc", "你好").unwrap_err();
        assert_eq!(error.code, "bilibili_send_invalid_room");
        assert_eq!(error.site.as_deref(), Some("bilibili"));
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
        // 连接元数据保持不变：只移除会话身份，
        // 因此匿名加入仍沿用共享的 token 与主机列表。
        assert_eq!(raw["danmaku"]["token"], "token");
        assert_eq!(raw["danmaku"]["server_hosts"][0], "host-a.example");
    }

    #[test]
    fn invalid_douyu_draft_does_not_consume_room_cooldown() {
        let limiter = DanmakuSendLimiter::new(
            "douyu",
            "斗鱼",
            danmu_rs::douyu::normalize_outgoing_message,
        );

        assert!(validate_and_reserve_send(&limiter, "123", "\n").is_err());
        assert!(validate_and_reserve_send(&limiter, "123", "你好").is_ok());
        assert!(validate_and_reserve_send(&limiter, "123", "第二条").is_err());
        let error = validate_and_reserve_send(&limiter, "abc", "你好").unwrap_err();
        assert_eq!(error.code, "douyu_send_invalid_room");
        assert_eq!(error.site.as_deref(), Some("douyu"));
    }

    #[test]
    fn invalid_huya_draft_does_not_consume_room_cooldown() {
        let limiter = DanmakuSendLimiter::new(
            "huya",
            "虎牙",
            danmu_rs::huya::normalize_outgoing_message,
        );

        assert!(validate_and_reserve_huya_send(&limiter, "room-1", "\n").is_err());
        assert!(validate_and_reserve_huya_send(&limiter, "room-1", "你好").is_ok());
        assert!(validate_and_reserve_huya_send(&limiter, "room-1", "第二条").is_err());
    }
}
