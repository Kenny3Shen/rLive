use serde::Serialize;
use tauri::State;

use crate::account::{bilibili_qr, douyin_qr, douyu_qr};
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
        _ => "当前平台",
    }
}
