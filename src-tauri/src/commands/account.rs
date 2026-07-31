use reqwest::header::{COOKIE, REFERER, USER_AGENT};
use serde::Serialize;
use serde_json::Value;
use tauri::State;

use crate::account::{bilibili_qr, douyin_qr, douyu_qr, huya_qr};
use crate::error::AppResult;
use crate::models::live::SiteId;
use crate::state::AppState;

// This response contains a one-time QR payload and its local polling handle.
// Keep it out of accidental `Debug` logs; neither item is needed outside the
// user-operated login flow.
#[derive(Serialize)]
pub struct AccountQrLoginStart {
    pub qr_code_url: String,
    pub qr_key: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AccountQrLoginStatus {
    Pending,
    Scanned,
    Expired,
    Success,
}

#[derive(Debug, Serialize)]
pub struct AccountQrLoginPoll {
    pub status: AccountQrLoginStatus,
    pub message: String,
}

/// Non-sensitive account summary for the settings UI.  Cookie material stays
/// in the local database and is never included in this IPC response.
#[derive(Debug, Serialize)]
pub struct AccountProfile {
    pub username: Option<String>,
    pub has_cookie: bool,
}

enum QrLoginPollResult {
    Pending,
    Scanned,
    Expired,
    Success { cookie: String },
}

#[tauri::command]
pub fn account_get_cookie(
    state: State<'_, AppState>,
    site_id: SiteId,
) -> AppResult<Option<String>> {
    let conn = state.db.lock().map_err(|e| {
        crate::error::AppError::new("db_lock_error", format!("account_get_cookie: {e}"))
    })?;
    crate::account::get_cookie(&conn, &site_id)
}

#[tauri::command]
pub fn account_set_cookie(
    state: State<'_, AppState>,
    site_id: SiteId,
    cookie: String,
) -> AppResult<()> {
    let conn = state.db.lock().map_err(|e| {
        crate::error::AppError::new("db_lock_error", format!("account_set_cookie: {e}"))
    })?;
    crate::account::set_cookie(&conn, &site_id, &cookie)
}

#[tauri::command]
pub fn account_clear_cookie(state: State<'_, AppState>, site_id: SiteId) -> AppResult<()> {
    let conn = state.db.lock().map_err(|e| {
        crate::error::AppError::new("db_lock_error", format!("account_clear_cookie: {e}"))
    })?;
    crate::account::clear_cookie(&conn, &site_id)
}

/// Read a safe display summary for a saved account without exposing its
/// Cookie to the webview.  Bilibili is checked against its first-party nav
/// endpoint because its QR-login callback Cookie has no username field;
/// platforms that carry a trusted name field use that local value directly.
#[tauri::command(async)]
pub async fn account_get_profile(
    state: State<'_, AppState>,
    site_id: SiteId,
) -> AppResult<AccountProfile> {
    // Snapshot every value needed for the lookup before awaiting a network
    // request. Holding the SQLite mutex across an await would block all other
    // settings and account operations.
    let (cookie, proxy) = {
        let conn = state.db.lock().map_err(|e| {
            crate::error::AppError::new("db_lock_error", format!("account_get_profile: {e}"))
        })?;
        (
            crate::account::get_cookie(&conn, &site_id)?.unwrap_or_default(),
            crate::settings::get(&conn)?.proxy,
        )
    };

    let has_cookie = !cookie.trim().is_empty();
    let cookie_username = crate::account::display_name_from_cookie(&site_id, &cookie);
    let username = match site_id {
        SiteId::Bilibili if has_cookie => {
            match bilibili_profile_lookup(&cookie, proxy.as_deref()).await {
                // A completed first-party lookup is authoritative: an
                // expired Cookie must not keep showing an old cached name.
                BilibiliProfileLookup::Verified(username) => username,
                // Network/challenge failures should not hide the optional
                // DedeUserName field present in some browser exports.
                BilibiliProfileLookup::Unavailable => cookie_username,
            }
        }
        _ => cookie_username,
    };

    Ok(AccountProfile {
        username,
        has_cookie,
    })
}

#[tauri::command(async)]
pub async fn account_qr_login_start(
    state: State<'_, AppState>,
    site_id: SiteId,
) -> AppResult<AccountQrLoginStart> {
    match &site_id {
        SiteId::Bilibili => {
            let session = bilibili_qr::start().await?;
            Ok(AccountQrLoginStart {
                qr_code_url: session.qr_code_url,
                qr_key: session.qr_key,
            })
        }
        SiteId::Douyin => {
            // QR login uses the same explicit application proxy as other
            // Douyin requests. Read it before awaiting the network request so
            // the database mutex is never held across an await point.
            let proxy = {
                let conn = state.db.lock().map_err(|e| {
                    crate::error::AppError::new(
                        "db_lock_error",
                        format!("account_qr_login_start: {e}"),
                    )
                })?;
                crate::settings::get(&conn)?.proxy
            };
            let session = douyin_qr::start(proxy.as_deref()).await?;
            Ok(AccountQrLoginStart {
                qr_code_url: session.qr_code_url,
                qr_key: session.qr_key,
            })
        }
        SiteId::Douyu => {
            let session = douyu_qr::start().await?;
            Ok(AccountQrLoginStart {
                qr_code_url: session.qr_code_url,
                qr_key: session.qr_key,
            })
        }
        SiteId::Huya => {
            let session = huya_qr::start().await?;
            Ok(AccountQrLoginStart {
                qr_code_url: session.qr_code_url,
                qr_key: session.qr_key,
            })
        }
        _ => Err(qr_login_unsupported(&site_id)),
    }
}

#[tauri::command(async)]
pub async fn account_qr_login_poll(
    state: State<'_, AppState>,
    site_id: SiteId,
    qr_key: String,
) -> AppResult<AccountQrLoginPoll> {
    let result = match &site_id {
        SiteId::Bilibili => map_bilibili_qr_poll(bilibili_qr::poll(&qr_key).await?),
        SiteId::Douyin => map_douyin_qr_poll(douyin_qr::poll(&qr_key).await?),
        SiteId::Douyu => map_douyu_qr_poll(douyu_qr::poll(&qr_key).await?),
        SiteId::Huya => map_huya_qr_poll(huya_qr::poll(&qr_key).await?),
        _ => return Err(qr_login_unsupported(&site_id)),
    };
    match result {
        QrLoginPollResult::Pending => Ok(AccountQrLoginPoll {
            status: AccountQrLoginStatus::Pending,
            message: format!("请使用{} App 扫描二维码", qr_login_site_name(&site_id)),
        }),
        QrLoginPollResult::Scanned => Ok(AccountQrLoginPoll {
            status: AccountQrLoginStatus::Scanned,
            message: "已扫描，请在手机上确认登录".into(),
        }),
        QrLoginPollResult::Expired => Ok(AccountQrLoginPoll {
            status: AccountQrLoginStatus::Expired,
            message: "二维码已失效，请刷新后重新扫描".into(),
        }),
        QrLoginPollResult::Success { cookie } => {
            let conn = state.db.lock().map_err(|e| {
                crate::error::AppError::new("db_lock_error", format!("account_qr_login_poll: {e}"))
            })?;
            crate::account::set_cookie(&conn, &site_id, &cookie)?;
            Ok(AccountQrLoginPoll {
                status: AccountQrLoginStatus::Success,
                message: "登录成功，Cookie 已安全保存到本机".into(),
            })
        }
    }
}

fn map_bilibili_qr_poll(result: bilibili_qr::QrLoginPoll) -> QrLoginPollResult {
    match result {
        bilibili_qr::QrLoginPoll::Pending => QrLoginPollResult::Pending,
        bilibili_qr::QrLoginPoll::Scanned => QrLoginPollResult::Scanned,
        bilibili_qr::QrLoginPoll::Expired => QrLoginPollResult::Expired,
        bilibili_qr::QrLoginPoll::Success { cookie } => QrLoginPollResult::Success { cookie },
    }
}

fn map_douyin_qr_poll(result: douyin_qr::QrLoginPoll) -> QrLoginPollResult {
    match result {
        douyin_qr::QrLoginPoll::Pending => QrLoginPollResult::Pending,
        douyin_qr::QrLoginPoll::Scanned => QrLoginPollResult::Scanned,
        douyin_qr::QrLoginPoll::Expired => QrLoginPollResult::Expired,
        douyin_qr::QrLoginPoll::Success { cookie } => QrLoginPollResult::Success { cookie },
    }
}

fn map_douyu_qr_poll(result: douyu_qr::QrLoginPoll) -> QrLoginPollResult {
    match result {
        douyu_qr::QrLoginPoll::Pending => QrLoginPollResult::Pending,
        douyu_qr::QrLoginPoll::Scanned => QrLoginPollResult::Scanned,
        douyu_qr::QrLoginPoll::Expired => QrLoginPollResult::Expired,
        douyu_qr::QrLoginPoll::Success { cookie } => QrLoginPollResult::Success { cookie },
    }
}

fn map_huya_qr_poll(result: huya_qr::QrLoginPoll) -> QrLoginPollResult {
    match result {
        huya_qr::QrLoginPoll::Pending => QrLoginPollResult::Pending,
        huya_qr::QrLoginPoll::Scanned => QrLoginPollResult::Scanned,
        huya_qr::QrLoginPoll::Expired => QrLoginPollResult::Expired,
        huya_qr::QrLoginPoll::Success { cookie } => QrLoginPollResult::Success { cookie },
    }
}

fn qr_login_unsupported(site_id: &SiteId) -> crate::error::AppError {
    crate::error::AppError::new(
        "account_qr_login_unsupported",
        "当前平台暂不支持二维码登录，请使用手动 Cookie 输入",
    )
    .with_site(site_id.as_str())
}

fn qr_login_site_name(site_id: &SiteId) -> &'static str {
    match site_id {
        SiteId::Bilibili => "哔哩哔哩",
        SiteId::Douyin => "抖音",
        SiteId::Douyu => "斗鱼",
        SiteId::Huya => "虎牙",
        _ => "当前平台",
    }
}

enum BilibiliProfileLookup {
    /// The upstream response was valid. `None` means it explicitly reported
    /// an unauthenticated/expired session or omitted a usable display name.
    Verified(Option<String>),
    /// The request could not be completed or was not a recognized API
    /// response. Callers may safely use a Cookie-derived fallback instead.
    Unavailable,
}

async fn bilibili_profile_lookup(cookie: &str, proxy: Option<&str>) -> BilibiliProfileLookup {
    let Some(cookie) = cookie_header_value(cookie) else {
        return BilibiliProfileLookup::Unavailable;
    };
    let Ok(client) = crate::http_client::client_for_proxy(proxy) else {
        return BilibiliProfileLookup::Unavailable;
    };
    let Ok(response) = client
        .get("https://api.bilibili.com/x/web-interface/nav")
        .header(USER_AGENT, crate::sites::bilibili::DEFAULT_USER_AGENT)
        .header(REFERER, crate::sites::bilibili::DEFAULT_REFERER)
        .header(COOKIE, cookie)
        .send()
        .await
    else {
        return BilibiliProfileLookup::Unavailable;
    };
    if !response.status().is_success() {
        return BilibiliProfileLookup::Unavailable;
    }
    let Ok(body) = response.text().await else {
        return BilibiliProfileLookup::Unavailable;
    };
    parse_bilibili_profile(&body)
}

/// Keep copied Cookie headers bounded and free of control bytes before they
/// are passed to reqwest. A manual Cookie may include a literal `Cookie:`
/// prefix, which must not become part of the first cookie name.
fn cookie_header_value(value: &str) -> Option<&str> {
    const MAX_COOKIE_BYTES: usize = 16 * 1024;

    let value = value.trim();
    let value = value
        .get(..7)
        .filter(|prefix| prefix.eq_ignore_ascii_case("cookie:"))
        .map(|_| &value[7..])
        .unwrap_or(value)
        .trim();
    (!value.is_empty()
        && value.len() <= MAX_COOKIE_BYTES
        && value.is_ascii()
        && !value.bytes().any(|byte| byte.is_ascii_control()))
    .then_some(value)
}

fn parse_bilibili_profile(body: &str) -> BilibiliProfileLookup {
    let Ok(response) = serde_json::from_str::<Value>(body) else {
        return BilibiliProfileLookup::Unavailable;
    };
    let Some(code) = response.get("code").and_then(Value::as_i64) else {
        return BilibiliProfileLookup::Unavailable;
    };
    if code != 0 {
        // Bilibili uses a non-zero API code (commonly -101) for a rejected or
        // expired session. This is a completed answer, not a network failure.
        return BilibiliProfileLookup::Verified(None);
    }
    let Some(data) = response.get("data") else {
        return BilibiliProfileLookup::Unavailable;
    };
    let Some(is_logged_in) = json_bool(data.get("isLogin")) else {
        return BilibiliProfileLookup::Unavailable;
    };
    if !is_logged_in {
        return BilibiliProfileLookup::Verified(None);
    }
    BilibiliProfileLookup::Verified(json_display_name(data.get("uname")))
}

fn json_bool(value: Option<&Value>) -> Option<bool> {
    value.and_then(|value| {
        value
            .as_bool()
            .or_else(|| value.as_i64().map(|number| number != 0))
    })
}

fn json_display_name(value: Option<&Value>) -> Option<String> {
    let value = value?.as_str()?.trim();
    (!value.is_empty() && value.chars().count() <= 128 && !value.chars().any(char::is_control))
        .then(|| value.to_owned())
}

#[cfg(test)]
mod tests {
    use super::{BilibiliProfileLookup, cookie_header_value, parse_bilibili_profile};

    #[test]
    fn parses_a_logged_in_bilibili_account_name() {
        let result = parse_bilibili_profile(r#"{"code":0,"data":{"isLogin":true,"uname":"小明"}}"#);
        assert!(matches!(
            result,
            BilibiliProfileLookup::Verified(Some(name)) if name == "小明"
        ));
    }

    #[test]
    fn recognizes_an_expired_bilibili_session() {
        let result = parse_bilibili_profile(r#"{"code":-101,"message":"账号未登录"}"#);
        assert!(matches!(result, BilibiliProfileLookup::Verified(None)));
    }

    #[test]
    fn refuses_malformed_cookie_headers() {
        assert_eq!(
            cookie_header_value("Cookie: SESSDATA=abc; bili_jct=csrf"),
            Some("SESSDATA=abc; bili_jct=csrf")
        );
        assert_eq!(cookie_header_value("Cookie: a=b\r\nc=d"), None);
    }
}
