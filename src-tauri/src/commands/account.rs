use reqwest::header::{COOKIE, REFERER, USER_AGENT};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

use crate::account::qr::QrLoginPoll;
use crate::account::{
    bilibili_app, bilibili_qr, cookie_header_value, douyin_profile, douyin_qr, douyu_qr, huya_qr,
};
use crate::error::AppResult;
use crate::models::live::SiteId;
use crate::proxy::ProxyRoute;
use crate::state::AppState;

/// 在等待网络请求之前把设置里的模式与地址快照成路由，
/// 使一次登录会话的每个请求都遵循同一份设置。
fn qr_route(state: &AppState) -> AppResult<ProxyRoute> {
    let conn = state.conn()?;
    Ok(crate::settings::get(&conn)?.proxy_route())
}

// 该响应包含一次性的二维码内容及其本地轮询句柄。避免让它进入无意的
// `Debug` 日志；这两项在用户扫码登录流程之外都不需要。
#[derive(Serialize)]
pub struct AccountQrLoginStart {
    pub qr_code_url: String,
    pub qr_key: String,
    pub mode: &'static str,
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

/// 供设置界面使用的非敏感账号摘要。Cookie 内容留在本地数据库中，
/// 绝不包含在这个 IPC 响应里。
#[derive(Debug, Serialize)]
pub struct AccountProfile {
    pub username: Option<String>,
    pub has_cookie: bool,
    pub status: AccountStatus,
}

/// 应用在本地所能判断出的 Cookie 会话状态。没有低成本有效性检查的平台，
/// 在存在 Cookie 时报告 `Unknown`。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AccountStatus {
    /// 该站点没有保存 Cookie。
    None,
    /// 平台接受了该会话。
    Valid,
    /// 平台明确拒绝了该会话（已过期／已登出）。
    /// 弹幕将回退到匿名模式，并禁用发送。
    Expired,
    /// 无法验证该会话（网络失败或平台不支持）。
    Unknown,
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
    if site_id == SiteId::Douyin {
        douyin_qr::cancel_all()?;
    }
    crate::account::set_cookie(&conn, &site_id, &cookie)
}

#[tauri::command]
pub fn account_clear_cookie(state: State<'_, AppState>, site_id: SiteId) -> AppResult<()> {
    let conn = state.db.lock().map_err(|e| {
        crate::error::AppError::new("db_lock_error", format!("account_clear_cookie: {e}"))
    })?;
    if site_id == SiteId::Douyin {
        douyin_qr::cancel_all()?;
    }
    crate::account::clear_cookie(&conn, &site_id)
}

/// 读取已保存账号的安全展示摘要，同时不把其 Cookie 暴露给 webview。
/// Bilibili、抖音请求第一方当前账号接口验证会话并获取显示名；
/// 其他平台的显示名来自 Cookie，登录态由各自的探针确认。
#[tauri::command(async)]
pub async fn account_get_profile(
    state: State<'_, AppState>,
    site_id: SiteId,
) -> AppResult<AccountProfile> {
    // 在等待网络请求之前先快照查询所需的全部值。跨 await 持有 SQLite 互斥锁
    // 会阻塞其他所有设置与账号操作。
    let (cookie, route) = {
        let conn = state.db.lock().map_err(|e| {
            crate::error::AppError::new("db_lock_error", format!("account_get_profile: {e}"))
        })?;
        (
            crate::account::get_cookie(&conn, &site_id)?.unwrap_or_default(),
            crate::settings::get(&conn)?.proxy_route(),
        )
    };

    let has_cookie = !cookie.trim().is_empty();
    let cookie_username = crate::account::display_name_from_cookie(&site_id, &cookie);
    let (username, status) = match site_id {
        SiteId::Bilibili if has_cookie => {
            match bilibili_profile_lookup(&cookie, &route).await {
                // 平台确认登录：显示名可能缺失，但状态是确定的 Valid。
                BilibiliProfileLookup::Valid(username) => {
                    (username.or(cookie_username), AccountStatus::Valid)
                }
                // 只有平台明确说未登录才降为 Expired；前端据此清理 Cookie。
                BilibiliProfileLookup::Rejected => (None, AccountStatus::Expired),
                // 网络或验证挑战导致的失败不应遮蔽部分浏览器导出中
                // 存在的可选字段 DedeUserName，也不应升级成“已登录”的确定事实。
                BilibiliProfileLookup::Unavailable => (cookie_username, AccountStatus::Unknown),
            }
        }
        SiteId::Douyin if has_cookie => match douyin_profile::lookup(&cookie, &route).await {
            douyin_profile::ProfileLookup::Valid(username) => {
                (username.or(cookie_username), AccountStatus::Valid)
            }
            douyin_profile::ProfileLookup::Rejected => (None, AccountStatus::Expired),
            douyin_profile::ProfileLookup::Unavailable => (cookie_username, AccountStatus::Unknown),
        },
        // 斗鱼的显示名来自 Cookie 自身而不是某次查询，因此探针失败时它仍然可用；
        // 只有平台明确拒绝该会话才报告已失效。
        SiteId::Douyu if has_cookie => {
            let status = match crate::sites::douyu::cookie_session_status(&cookie, &route).await {
                Some(true) => AccountStatus::Valid,
                Some(false) => AccountStatus::Expired,
                None => AccountStatus::Unknown,
            };
            (cookie_username, status)
        }
        // 虎牙的显示名同样来自 Cookie 的 `udb_n`，探针只决定登录态徽标。它走信令
        // 网关的 `verifyCookie`（与发送弹幕前的校验同一条链路），因为虎牙的 Web
        // 业务接口不接受浏览器 Cookie 单独作为凭据，恒回「Token验证不通过」，
        // 与会话是否有效无关。该链路与接收、发送共用应用代理路由。
        SiteId::Huya if has_cookie => {
            let status = match crate::danmu_rs::huya::cookie_session_status(&cookie, &route).await {
                Some(true) => AccountStatus::Valid,
                Some(false) => AccountStatus::Expired,
                None => AccountStatus::Unknown,
            };
            (cookie_username, status)
        }
        _ => {
            let status = if has_cookie {
                AccountStatus::Unknown
            } else {
                AccountStatus::None
            };
            (cookie_username, status)
        }
    };

    Ok(AccountProfile {
        username,
        has_cookie,
        status,
    })
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AccountLoginKind {
    #[default]
    Web,
    BilibiliApp,
}

/// APP 凭据只返回身份摘要；不复用可读取 Web Cookie 的 IPC。
#[derive(Serialize)]
pub struct BilibiliAppProfile {
    pub status: AccountStatus,
    pub has_token: bool,
    pub mid: Option<String>,
    pub expires_at: Option<i64>,
}

/// 供设置界面与启动期检查共用的状态判定。
///
/// 先走 [`bilibili_app::authorize`]：临近到期或已被服务端拒绝时会自动续期，
/// 续期结果落库（轮换了 `refresh_token`，不落库下次仍用旧值重试）。续期让
/// 「已过期」不再等于「必须重新扫码」：只有 `refresh_token` 也失效时才报失效。
///
/// 服务端确认有效时用权威寿命校正本地 `expires_at`；校正失败（如数据库锁冲突）
/// 不影响本次状态结论。
async fn app_profile_from_credential(
    state: &AppState,
    credential: &bilibili_app::AppCredential,
) -> BilibiliAppProfile {
    // 凭据校验/续期必须与其余请求走同一条出口。这里读不到设置时退回直连：
    // 校验失败只影响登录态展示，不该让整个账号页报错。
    let route = qr_route(state).unwrap_or(crate::proxy::ProxyRoute::Direct);
    let (status, expires_at) = match bilibili_app::authorize(credential.clone(), &route).await {
        Ok(authorization) => {
            let mut expires_at = authorization.credential.expires_at;
            if let Ok(conn) = state.conn() {
                // 续期已轮换凭据，必须落库；否则下次仍拿旧 `refresh_token` 重试。
                let to_save = if authorization.renewed {
                    Some(authorization.credential)
                } else if let Some(authoritative) = authorization.expires_at
                    && authoritative != credential.expires_at
                {
                    let mut corrected = credential.clone();
                    corrected.expires_at = authoritative;
                    Some(corrected)
                } else {
                    None
                };
                if let Some(next) = to_save
                    && bilibili_app::save(&conn, &next).is_ok()
                {
                    expires_at = next.expires_at;
                }
            }
            (AccountStatus::Valid, Some(expires_at))
        }
        Err(error) if error.code == "bilibili_app_auth_required" => {
            (AccountStatus::Expired, Some(credential.expires_at))
        }
        Err(_) => (AccountStatus::Unknown, Some(credential.expires_at)),
    };
    BilibiliAppProfile {
        status,
        has_token: true,
        mid: Some(credential.mid.clone()),
        expires_at,
    }
}

#[tauri::command(async)]
pub async fn account_bilibili_app_profile(
    state: State<'_, AppState>,
) -> AppResult<BilibiliAppProfile> {
    let credential = {
        let conn = state.conn()?;
        bilibili_app::load(&conn)?
    };
    let Some(credential) = credential else {
        return Ok(BilibiliAppProfile {
            status: AccountStatus::None,
            has_token: false,
            mid: None,
            expires_at: None,
        });
    };
    Ok(app_profile_from_credential(&state, &credential).await)
}

#[tauri::command]
pub fn account_bilibili_app_clear(state: State<'_, AppState>) -> AppResult<()> {
    let conn = state.conn()?;
    let tx = conn
        .unchecked_transaction()
        .map_err(crate::db::schema::map_db_err)?;
    bilibili_app::cancel_all()?;
    bilibili_app::clear(&tx)?;
    tx.commit().map_err(crate::db::schema::map_db_err)?;
    Ok(())
}

#[tauri::command(async)]
pub async fn account_qr_login_start(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    site_id: SiteId,
    login_kind: Option<AccountLoginKind>,
) -> AppResult<AccountQrLoginStart> {
    if matches!(login_kind, Some(AccountLoginKind::BilibiliApp)) {
        if site_id != SiteId::Bilibili {
            return Err(qr_login_unsupported(&site_id));
        }
        let session = bilibili_app::start(&qr_route(state.inner())?).await?;
        return Ok(AccountQrLoginStart {
            qr_code_url: session.qr_code_url,
            qr_key: session.qr_key,
            mode: "qr",
        });
    }
    match &site_id {
        SiteId::Bilibili => {
            let session = bilibili_qr::start(&qr_route(state.inner())?).await?;
            Ok(AccountQrLoginStart {
                qr_code_url: session.qr_code_url,
                qr_key: session.qr_key,
                mode: "qr",
            })
        }
        SiteId::Douyin => {
            // 扫码登录与其他抖音请求使用同一份代理路由。在等待网络请求之前
            // 先解析它，保证数据库互斥锁不会跨 await 点被持有。
            let route = qr_route(state.inner())?;
            let session = douyin_qr::start(app, &route).await?;
            Ok(AccountQrLoginStart {
                qr_code_url: session.qr_code_url,
                qr_key: session.qr_key,
                mode: "browser",
            })
        }
        SiteId::Douyu => {
            let session = douyu_qr::start(&qr_route(state.inner())?).await?;
            Ok(AccountQrLoginStart {
                qr_code_url: session.qr_code_url,
                qr_key: session.qr_key,
                mode: "qr",
            })
        }
        SiteId::Huya => {
            let session = huya_qr::start(&qr_route(state.inner())?).await?;
            Ok(AccountQrLoginStart {
                qr_code_url: session.qr_code_url,
                qr_key: session.qr_key,
                mode: "qr",
            })
        }
        _ => Err(qr_login_unsupported(&site_id)),
    }
}

/// 目前只有抖音官方窗口有需要主动回收的浏览器资源。
#[tauri::command(async)]
pub async fn account_qr_login_cancel(site_id: SiteId, qr_key: String) -> AppResult<()> {
    if site_id == SiteId::Douyin {
        douyin_qr::cancel(&qr_key)?;
    }
    Ok(())
}

#[tauri::command(async)]
pub async fn account_qr_login_poll(
    state: State<'_, AppState>,
    site_id: SiteId,
    qr_key: String,
    login_kind: Option<AccountLoginKind>,
) -> AppResult<AccountQrLoginPoll> {
    if matches!(login_kind, Some(AccountLoginKind::BilibiliApp)) {
        if site_id != SiteId::Bilibili {
            return Err(qr_login_unsupported(&site_id));
        }
        let (status, message) = match bilibili_app::poll(&qr_key, &qr_route(state.inner())?).await?
        {
            bilibili_app::AppQrPoll::Pending => (
                AccountQrLoginStatus::Pending,
                "请使用 B站 App 扫码，并确认 TV 登录",
            ),
            bilibili_app::AppQrPoll::Scanned => (
                AccountQrLoginStatus::Scanned,
                "已扫码，请在手机确认 TV 登录",
            ),
            bilibili_app::AppQrPoll::Expired => (
                AccountQrLoginStatus::Expired,
                "二维码已失效，请刷新后重新扫描",
            ),
            bilibili_app::AppQrPoll::Success(credential) => {
                let conn = state.conn()?;
                bilibili_app::finish(&qr_key)?;
                bilibili_app::save(&conn, &credential)?;
                (
                    AccountQrLoginStatus::Success,
                    "App 授权已保存到本机，原有 Web Cookie 未改动",
                )
            }
        };
        return Ok(AccountQrLoginPoll {
            status,
            message: message.into(),
        });
    }
    let result = match &site_id {
        SiteId::Bilibili => bilibili_qr::poll(&qr_key).await?,
        SiteId::Douyin => douyin_qr::poll(&qr_key).await?,
        SiteId::Douyu => douyu_qr::poll(&qr_key).await?,
        SiteId::Huya => huya_qr::poll(&qr_key).await?,
        _ => return Err(qr_login_unsupported(&site_id)),
    };
    match result {
        QrLoginPoll::Pending => Ok(AccountQrLoginPoll {
            status: AccountQrLoginStatus::Pending,
            message: if site_id == SiteId::Douyin {
                "请在抖音官方窗口点击登录并扫码；验证成功后会自动保存并关闭窗口".into()
            } else {
                format!("请使用{} App 扫描二维码", qr_login_site_name(&site_id))
            },
        }),
        QrLoginPoll::Scanned => Ok(AccountQrLoginPoll {
            status: AccountQrLoginStatus::Scanned,
            message: "已扫描，请在手机上确认登录".into(),
        }),
        QrLoginPoll::Expired => Ok(AccountQrLoginPoll {
            status: AccountQrLoginStatus::Expired,
            message: if site_id == SiteId::Douyin {
                "登录窗口已关闭或会话已过期，原账号未更改；可重新打开窗口".into()
            } else {
                "二维码已失效，请刷新后重新扫描".into()
            },
        }),
        QrLoginPoll::Success { cookie } => {
            let conn = state.db.lock().map_err(|e| {
                crate::error::AppError::new("db_lock_error", format!("account_qr_login_poll: {e}"))
            })?;
            if site_id == SiteId::Douyin {
                douyin_qr::finish(&qr_key, || {
                    crate::account::set_cookie(&conn, &site_id, &cookie)
                })?;
            } else {
                crate::account::set_cookie(&conn, &site_id, &cookie)?;
            }
            Ok(AccountQrLoginPoll {
                status: AccountQrLoginStatus::Success,
                message: "登录成功，Cookie 已安全保存到本机".into(),
            })
        }
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
    /// 平台确认了会话。`None` 仅表示它没给出可展示的显示名
    /// （例如接口只回 `isLogin` 而不回 `uname`），**不是**失效。
    Valid(Option<String>),
    /// 平台明确报告未登录／会话已过期（`-101` 或 `isLogin=false`）。
    /// 这是唯一允许把状态降为 `Expired` 的结果。
    Rejected,
    /// 请求未能完成，或者应答不是可识别的登录判定（风控、限流、
    /// 异常结构、未知业务码）。调用方保留 Cookie 并报告 `Unknown`。
    Unavailable,
}

async fn bilibili_profile_lookup(
    cookie: &str,
    route: &crate::proxy::ProxyRoute,
) -> BilibiliProfileLookup {
    let Some(cookie) = cookie_header_value(cookie) else {
        return BilibiliProfileLookup::Unavailable;
    };
    let Ok(client) = crate::http_client::client_for_route(route) else {
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

fn parse_bilibili_profile(body: &str) -> BilibiliProfileLookup {
    let Ok(response) = serde_json::from_str::<Value>(body) else {
        return BilibiliProfileLookup::Unavailable;
    };
    let Some(code) = response.get("code").and_then(Value::as_i64) else {
        return BilibiliProfileLookup::Unavailable;
    };
    if code != 0 {
        // 只有 -101（账号未登录）是明确的会话失效证据。其余非零码
        // （-412 风控、-509 限流、-400 参数、-403 权限、未知码）都可能
        // 在会话仍有效时出现，把任何一个当成失效都会误删可用凭据。
        return if code == -101 {
            BilibiliProfileLookup::Rejected
        } else {
            BilibiliProfileLookup::Unavailable
        };
    }
    let Some(data) = response.get("data") else {
        return BilibiliProfileLookup::Unavailable;
    };
    let Some(is_logged_in) = json_bool(data.get("isLogin")) else {
        return BilibiliProfileLookup::Unavailable;
    };
    if !is_logged_in {
        return BilibiliProfileLookup::Rejected;
    }
    // `isLogin=true` 已经足以确认登录；`uname` 只是展示字段，
    // 缺失或不可展示不构成失效。
    BilibiliProfileLookup::Valid(json_display_name(data.get("uname")))
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
            BilibiliProfileLookup::Valid(Some(name)) if name == "小明"
        ));
    }

    #[test]
    fn a_logged_in_session_without_a_display_name_is_still_valid() {
        // `isLogin=true` 但 uname 缺失/不可展示：登录成立，只是没有名字。
        // 旧行为把它归入 Verified(None)，上层当失效处理并清 Cookie。
        for body in [
            r#"{"code":0,"data":{"isLogin":true}}"#,
            r#"{"code":0,"data":{"isLogin":1,"uname":""}}"#,
            r#"{"code":0,"data":{"isLogin":true,"uname":"\u0000bad"}}"#,
            r#"{"code":0,"data":{"isLogin":true,"uname":"x"}}"#,
        ] {
            assert!(
                matches!(
                    parse_bilibili_profile(body),
                    BilibiliProfileLookup::Valid(_)
                ),
                "isLogin=true 但无可展示名字不应判为失效: {body}"
            );
        }
    }

    #[test]
    fn only_an_explicit_not_logged_in_answer_expires_the_session() {
        assert!(matches!(
            parse_bilibili_profile(r#"{"code":-101,"message":"账号未登录"}"#),
            BilibiliProfileLookup::Rejected
        ));
        assert!(matches!(
            parse_bilibili_profile(r#"{"code":0,"data":{"isLogin":false}}"#),
            BilibiliProfileLookup::Rejected
        ));
    }

    #[test]
    fn risk_control_and_unknown_codes_do_not_count_as_expiry() {
        // 风控/限流/参数错误/未知业务码都可能在会话仍有效时出现；
        // 把它们当成失效会误删可用凭据。
        for body in [
            r#"{"code":-412,"message":"请求被拦截"}"#,
            r#"{"code":-509,"message":"请求过于频繁"}"#,
            r#"{"code":-400,"message":"请求错误"}"#,
            r#"{"code":-403,"message":"访问权限不足"}"#,
            r#"{"code":-9999,"message":"未知"}"#,
            // 结构异常：缺 code、缺 data、isLogin 类型不对。
            r#"{"message":"no code"}"#,
            r#"{"code":0}"#,
            r#"{"code":0,"data":{}}"#,
            r#"{"code":0,"data":{"isLogin":"yes"}}"#,
            "not json at all",
        ] {
            assert!(
                matches!(
                    parse_bilibili_profile(body),
                    BilibiliProfileLookup::Unavailable
                ),
                "非登录证据不得判为失效: {body}"
            );
        }
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
