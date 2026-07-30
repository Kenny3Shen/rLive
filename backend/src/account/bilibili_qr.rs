//! Bilibili's user-operated QR login flow.
//!
//! The desktop app only displays the QR URL returned by Bilibili and polls the
//! matching public status endpoint.  A successful callback contains the
//! browser-cookie fields we need for the user's local account store; neither
//! the QR key nor the cookie is logged.

use serde::Deserialize;

use crate::error::{AppError, AppResult};

const QR_GENERATE_URL: &str = "https://passport.bilibili.com/x/passport-login/web/qrcode/generate";
const QR_POLL_URL: &str = "https://passport.bilibili.com/x/passport-login/web/qrcode/poll";

/// Data required to render a Bilibili login QR code in the client.
pub struct QrLoginStart {
    pub qr_code_url: String,
    pub qr_key: String,
}

/// A poll result.  Cookie material is returned only inside the Rust process so
/// the command can persist it directly into the local SQLite account store.
pub enum QrLoginPoll {
    Pending,
    Scanned,
    Expired,
    Success { cookie: String },
}

#[derive(Debug, Deserialize)]
struct ApiResponse<T> {
    code: i64,
    #[serde(default)]
    message: String,
    data: Option<T>,
}

#[derive(Debug, Deserialize)]
struct GenerateData {
    url: String,
    qrcode_key: String,
}

#[derive(Debug, Deserialize)]
struct PollData {
    code: i64,
    #[serde(default)]
    url: String,
}

pub async fn start() -> AppResult<QrLoginStart> {
    let response = crate::http_client::default_client()
        .get(QR_GENERATE_URL)
        .header("referer", "https://passport.bilibili.com/")
        .send()
        .await
        .map_err(|_| qr_network_error("bilibili_qr_generate"))?;

    let response: ApiResponse<GenerateData> = response.json().await.map_err(|_| {
        AppError::new("bilibili_qr_generate", "二维码服务返回了无法识别的数据")
            .with_site("bilibili")
            .retryable()
    })?;
    if response.code != 0 {
        return Err(qr_api_error("bilibili_qr_generate", &response.message));
    }

    let data = response.data.ok_or_else(|| {
        AppError::new("bilibili_qr_generate", "二维码服务未返回登录地址")
            .with_site("bilibili")
            .retryable()
    })?;
    if data.url.trim().is_empty() || data.qrcode_key.trim().is_empty() {
        return Err(
            AppError::new("bilibili_qr_generate", "二维码服务返回了不完整的登录信息")
                .with_site("bilibili")
                .retryable(),
        );
    }

    Ok(QrLoginStart {
        qr_code_url: data.url,
        qr_key: data.qrcode_key,
    })
}

pub async fn poll(qr_key: &str) -> AppResult<QrLoginPoll> {
    if qr_key.trim().is_empty() || qr_key.len() > 512 {
        return Err(AppError::new(
            "bilibili_qr_invalid_key",
            "二维码登录凭据无效，请刷新二维码",
        )
        .with_site("bilibili"));
    }

    let response = crate::http_client::default_client()
        .get(QR_POLL_URL)
        .query(&[("qrcode_key", qr_key)])
        .header("referer", "https://passport.bilibili.com/")
        .send()
        .await
        .map_err(|_| qr_network_error("bilibili_qr_poll"))?;

    let response: ApiResponse<PollData> = response.json().await.map_err(|_| {
        AppError::new("bilibili_qr_poll", "二维码状态服务返回了无法识别的数据")
            .with_site("bilibili")
            .retryable()
    })?;
    if response.code != 0 {
        return Err(qr_api_error("bilibili_qr_poll", &response.message));
    }

    let data = response.data.ok_or_else(|| {
        AppError::new("bilibili_qr_poll", "二维码状态服务未返回登录状态")
            .with_site("bilibili")
            .retryable()
    })?;
    match data.code {
        0 => {
            let cookie = cookie_from_callback_url(&data.url).ok_or_else(|| {
                AppError::new(
                    "bilibili_qr_cookie_missing",
                    "登录已确认，但未取得可用 Cookie；请刷新二维码后重试",
                )
                .with_site("bilibili")
                .retryable()
            })?;
            Ok(QrLoginPoll::Success { cookie })
        }
        86_101 => Ok(QrLoginPoll::Pending),
        86_090 => Ok(QrLoginPoll::Scanned),
        86_038 => Ok(QrLoginPoll::Expired),
        _ => Err(
            AppError::new("bilibili_qr_poll", "二维码登录暂不可用，请刷新二维码后重试")
                .with_site("bilibili")
                .retryable(),
        ),
    }
}

fn qr_network_error(code: &str) -> AppError {
    AppError::new(code, "无法连接二维码登录服务，请检查网络后重试")
        .with_site("bilibili")
        .retryable()
}

fn qr_api_error(code: &str, message: &str) -> AppError {
    let message = if message.trim().is_empty() {
        "二维码登录服务暂不可用，请稍后重试"
    } else {
        "二维码登录服务拒绝了请求，请刷新二维码后重试"
    };
    AppError::new(code, message)
        .with_site("bilibili")
        .retryable()
}

/// Build a standard Cookie request header from Bilibili's QR callback URL.
///
/// Values deliberately remain percent-encoded: Bilibili cookie values such as
/// `SESSDATA` commonly use `%2C`, and decoding/re-encoding them can change the
/// opaque value accepted by the web APIs.
fn cookie_from_callback_url(callback_url: &str) -> Option<String> {
    const COOKIE_KEYS: &[&str] = &[
        "SESSDATA",
        "bili_jct",
        "DedeUserID",
        "DedeUserID__ckMd5",
        "sid",
        "buvid3",
        "buvid4",
    ];

    let query = callback_url
        .split_once('?')?
        .1
        .split('#')
        .next()
        .unwrap_or_default();
    let mut values = std::collections::HashMap::new();
    for pair in query.split('&') {
        let Some((key, value)) = pair.split_once('=') else {
            continue;
        };
        if COOKIE_KEYS.contains(&key) && !value.is_empty() {
            values.entry(key).or_insert(value);
        }
    }

    // `SESSDATA` is the minimum credential needed by the Bilibili APIs used
    // in this application.  Do not write a partial successful-looking login.
    if !values.contains_key("SESSDATA") {
        return None;
    }

    let cookies = COOKIE_KEYS
        .iter()
        .filter_map(|key| values.get(key).map(|value| format!("{key}={value}")))
        .collect::<Vec<_>>();
    (!cookies.is_empty()).then(|| cookies.join("; "))
}

#[cfg(test)]
mod tests {
    use super::cookie_from_callback_url;

    #[test]
    fn callback_cookie_keeps_encoded_session_value_and_known_fields() {
        let url = "https://passport.bilibili.com/account/api/login/sso?DedeUserID=42&SESSDATA=abc%2Cdef%2Cghi&bili_jct=csrf&gourl=https%3A%2F%2Fwww.bilibili.com";
        let cookie = cookie_from_callback_url(url).unwrap();

        assert_eq!(
            cookie,
            "SESSDATA=abc%2Cdef%2Cghi; bili_jct=csrf; DedeUserID=42"
        );
    }

    #[test]
    fn callback_cookie_requires_sessdata() {
        assert!(cookie_from_callback_url("https://example.test/?DedeUserID=42").is_none());
    }
}
