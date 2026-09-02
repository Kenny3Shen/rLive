//! 用户扫码的抖音 Web 登录。
//!
//! 整个流程只与抖音的 Web SSO 接口通信。二维码内容由客户端渲染，
//! 但上游 token 和临时 cookie jar 都留在本进程内。确认登录后，
//! 生成的 Cookie 返回给账号命令，仅用于持久化到本地账号数据库。
//!
//! 会话表、客户端构建、可信主机判定与文本提取由共享的 `super::qr` 提供，
//! 这里只保留抖音 SSO 协议本身。

use std::sync::Arc;

use reqwest::cookie::{CookieStore, Jar};
use reqwest::header::{ACCEPT, ACCEPT_LANGUAGE, REFERER, USER_AGENT};
use reqwest::{Client, Url};
use serde_json::Value;
use uuid::Uuid;

use crate::account::qr::{self, QrSessionStore, QrSite};
use crate::error::{AppError, AppResult};
use crate::sites::douyin::DEFAULT_USER_AGENT;

pub use crate::account::qr::{QrLoginPoll, QrLoginStart};

const QR_GENERATE_URL: &str = "https://sso.douyin.com/get_qrcode/";
const QR_POLL_URL: &str = "https://sso.douyin.com/check_qrconnect/";
const WEB_ORIGIN: &str = "https://www.douyin.com/";
const MAX_QR_PAYLOAD_LEN: usize = 8 * 1024;
const MAX_COOKIE_LEN: usize = 16 * 1024;

const SITE: QrSite = QrSite {
    id: "douyin",
    display: "抖音",
};
const TRUSTED_SUFFIXES: &[&str] = &["douyin.com"];

#[derive(Clone)]
struct QrSession {
    token: String,
    client: Client,
    jar: Arc<Jar>,
}

static SESSIONS: QrSessionStore<QrSession> = QrSessionStore::new(SITE);

/// 通过抖音公开的 Web SSO API 创建二维码内容。
pub async fn start(proxy: Option<&str>) -> AppResult<QrLoginStart> {
    let jar = Arc::new(Jar::default());
    let client = qr::build_login_client(SITE, Arc::clone(&jar), TRUSTED_SUFFIXES, false, proxy)?;
    let response = client
        .get(QR_GENERATE_URL)
        .query(&web_sso_params())
        .header(ACCEPT, "application/json, text/plain, */*")
        .header(ACCEPT_LANGUAGE, "zh-CN,zh;q=0.9,en;q=0.8")
        .header(REFERER, WEB_ORIGIN)
        .header(USER_AGENT, DEFAULT_USER_AGENT)
        .send()
        .await
        .map_err(|_| SITE.network_error("douyin_qr_generate"))?;
    let response = parse_json_response(response, "douyin_qr_generate").await?;
    let (qr_code_url, token) = parse_start_response(&response)?;

    // 二维码内容本身必须交给 UI 渲染，但不要把 SSO token 作为单独的值返回。
    // 把它与引导用的 cookie jar 保存在一起，
    // 可以在 SSO 把 token 绑定到该临时会话时让轮询请求依然可用。
    let qr_key = Uuid::new_v4().simple().to_string();
    let session = QrSession { token, client, jar };
    SESSIONS.insert(qr_key.clone(), session)?;

    Ok(QrLoginStart {
        qr_code_url,
        qr_key,
    })
}

/// 轮询先前发起的扫码登录流程。
pub async fn poll(qr_key: &str) -> AppResult<QrLoginPoll> {
    if !qr::is_valid_session_key(qr_key) {
        return Err(SITE.error("invalid_key", "二维码登录凭据无效，请刷新二维码"));
    }

    let session = SESSIONS.get(qr_key)?;
    let mut params = web_sso_params();
    params.push(("token", session.token.clone()));
    let response = session
        .client
        .get(QR_POLL_URL)
        .query(&params)
        .header(ACCEPT, "application/json, text/plain, */*")
        .header(ACCEPT_LANGUAGE, "zh-CN,zh;q=0.9,en;q=0.8")
        .header(REFERER, WEB_ORIGIN)
        .header(USER_AGENT, DEFAULT_USER_AGENT)
        .send()
        .await
        .map_err(|_| SITE.network_error("douyin_qr_poll"))?;
    let response = parse_json_response(response, "douyin_qr_poll").await?;

    match parse_poll_response(&response)? {
        PollState::Pending => Ok(QrLoginPoll::Pending),
        PollState::Scanned => Ok(QrLoginPoll::Scanned),
        PollState::Expired => {
            SESSIONS.remove(qr_key)?;
            Ok(QrLoginPoll::Expired)
        }
        PollState::Success { redirect_url } => {
            let cookie = finish_login(&session, &redirect_url).await?;
            SESSIONS.remove(qr_key)?;
            Ok(QrLoginPoll::Success { cookie })
        }
    }
}

fn web_sso_params() -> Vec<(&'static str, String)> {
    // 这些是抖音 Web 登录页使用的稳定公开参数。两个请求都不发送签名、
    // 设备 id、第三方接口地址或已保存的 Cookie。
    vec![
        ("service", WEB_ORIGIN.to_string()),
        ("need_logo", "false".to_string()),
        ("need_short_url", "true".to_string()),
        ("device_platform", "web_app".to_string()),
        ("aid", "6383".to_string()),
        ("account_sdk_source", "sso".to_string()),
        ("sdk_version", "2.2.5".to_string()),
        ("language", "zh".to_string()),
    ]
}

async fn parse_json_response(response: reqwest::Response, code: &str) -> AppResult<Value> {
    let status = response.status();
    if !status.is_success() {
        return Err(
            AppError::new(code, "抖音二维码登录服务暂不可用，请稍后重试")
                .with_site("douyin")
                .retryable(),
        );
    }
    let body = response.text().await.map_err(|_| {
        AppError::new(code, "抖音二维码登录服务返回了无法读取的数据")
            .with_site("douyin")
            .retryable()
    })?;
    parse_json_body(&body, code)
}

fn parse_json_body(body: &str, code: &str) -> AppResult<Value> {
    serde_json::from_str(body).map_err(|_| {
        // 当边缘节点要求交互式浏览器验证时，公开 SSO 接口可能返回 200 的 HTML 页面。
        // 原生客户端不应尝试模仿或求解该验证；这里给出可操作的恢复路径，
        // 而不是报出一个含义不明的 JSON 解析失败。
        let message = if looks_like_html_document(body) {
            "抖音当前要求在浏览器完成访问验证，应用内无法取得二维码。请检查应用代理后重试，或使用手动 Cookie 登录"
        } else {
            "抖音二维码登录服务返回了无法识别的数据"
        };
        AppError::new(code, message).with_site("douyin").retryable()
    })
}

fn looks_like_html_document(body: &str) -> bool {
    let body = body.trim_start();
    body.starts_with("<!DOCTYPE html")
        || body.starts_with("<!doctype html")
        || body.starts_with("<html")
        || body.starts_with("<HTML")
}

fn parse_start_response(response: &Value) -> AppResult<(String, String)> {
    let data = successful_data(response, "douyin_qr_generate")?;
    let qr_code_url = required_text(data, &["qrcode", "qr_code", "qrcode_url"], "二维码地址")?;
    let parsed_qr_url = Url::parse(&qr_code_url).map_err(|_| {
        SITE.retryable_error("response_invalid", "抖音二维码服务返回了无效二维码地址")
    })?;
    if !qr::is_trusted_url(&parsed_qr_url, TRUSTED_SUFFIXES) {
        return Err(SITE.retryable_error(
            "response_invalid",
            "抖音二维码服务返回了不受信任的二维码地址",
        ));
    }
    let token = required_text(data, &["token", "qr_token"], "二维码登录凭据")?;
    Ok((qr_code_url, token))
}

enum PollState {
    Pending,
    Scanned,
    Expired,
    Success { redirect_url: String },
}

fn parse_poll_response(response: &Value) -> AppResult<PollState> {
    let data = successful_data(response, "douyin_qr_poll")?;
    let redirect_url =
        qr::optional_text(data, &["redirect_url", "redirectUrl"], MAX_QR_PAYLOAD_LEN);
    if let Some(redirect_url) = redirect_url {
        // 抖音只在用户确认登录之后才提供这个字段。它比数值状态更可靠，
        // 因为后者可能随 Web SSO 版本变化。
        return Ok(PollState::Success { redirect_url });
    }

    let status = qr::optional_text(data, &["status", "status_code"], MAX_QR_PAYLOAD_LEN)
        .or_else(|| optional_number_as_text(data, &["status", "status_code"]))
        .unwrap_or_default();
    match status.trim().to_ascii_lowercase().as_str() {
        // 公开 Web 接口历来用 1/2/3/4 分别表示等待、已扫码、已确认和已过期。
        // 把 0 也当作等待：少数灰度版本在首次扫码前不返回状态。
        "" | "0" | "1" | "pending" | "waiting" | "wait" => Ok(PollState::Pending),
        "2" | "scanned" | "scan" => Ok(PollState::Scanned),
        "4" | "5" | "expired" | "cancelled" | "canceled" => Ok(PollState::Expired),
        "3" | "success" | "confirmed" | "confirm" => Err(SITE.retryable_error(
            "redirect_missing",
            "已确认登录但未取得跳转地址，请刷新二维码后重试",
        )),
        _ => Err(SITE.retryable_error("poll", "二维码登录状态异常，请刷新二维码后重试")),
    }
}

async fn finish_login(session: &QrSession, redirect_url: &str) -> AppResult<String> {
    let redirect_url = Url::parse(redirect_url.trim()).map_err(|_| {
        SITE.retryable_error(
            "redirect_invalid",
            "二维码登录跳转地址无效，请刷新二维码后重试",
        )
    })?;
    if !qr::is_trusted_url(&redirect_url, TRUSTED_SUFFIXES) {
        return Err(SITE.retryable_error(
            "redirect_invalid",
            "二维码登录跳转地址不受信任，请刷新二维码后重试",
        ));
    }

    let response = session
        .client
        .get(redirect_url)
        .header(
            ACCEPT,
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        )
        .header(ACCEPT_LANGUAGE, "zh-CN,zh;q=0.9,en;q=0.8")
        .header(REFERER, WEB_ORIGIN)
        .header(USER_AGENT, DEFAULT_USER_AGENT)
        .send()
        .await
        .map_err(|_| SITE.network_error("douyin_qr_complete"))?;
    if !response.status().is_success() {
        return Err(SITE.retryable_error("complete", "抖音登录确认失败，请刷新二维码后重试"));
    }

    cookie_from_jar(&session.jar).ok_or_else(|| {
        SITE.retryable_error(
            "cookie_missing",
            "登录已确认，但未取得可用 Cookie；请刷新二维码后重试",
        )
    })
}

fn successful_data<'a>(response: &'a Value, code: &str) -> AppResult<&'a Value> {
    // 抖音在 Web SSO 响应中用过 `status_code` 也用过 `code`。只有顶层非零值
    // 才是 API 错误；`data.status` 是由 `parse_poll_response` 单独处理的
    // 二维码状态值。
    let api_code = optional_number_as_text(response, &["status_code", "code"])
        .or_else(|| qr::optional_text(response, &["status_code", "code"], MAX_QR_PAYLOAD_LEN));
    if let Some(api_code) = api_code
        && api_code.trim() != "0"
        && !api_code.trim().is_empty()
    {
        return Err(
            AppError::new(code, "抖音二维码登录服务拒绝了请求，请刷新二维码后重试")
                .with_site("douyin")
                .retryable(),
        );
    }
    let data = response.get("data").unwrap_or(response);
    if !data.is_object() {
        return Err(SITE.invalid_response(code));
    }
    Ok(data)
}

fn required_text(data: &Value, keys: &[&str], label: &str) -> AppResult<String> {
    // 抖音的错误文案需要指出缺失的字段（如「二维码地址」），
    // 因此不能使用共享 `QrSite::invalid_response` 的固定文案。
    qr::optional_text(data, keys, MAX_QR_PAYLOAD_LEN).ok_or_else(|| {
        SITE.retryable_error(
            "response_invalid",
            format!("抖音二维码服务未返回有效{label}"),
        )
    })
}

fn optional_number_as_text(data: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| data.get(*key)?.as_i64().map(|value| value.to_string()))
}

fn cookie_from_jar(jar: &Arc<Jar>) -> Option<String> {
    let url = Url::parse(WEB_ORIGIN).ok()?;
    let cookie_header = jar.cookies(&url)?;
    let value = cookie_header.to_str().ok()?.trim();
    if value.is_empty() || value.len() > MAX_COOKIE_LEN || value.contains(['\r', '\n']) {
        return None;
    }
    let has_login_session = value.split(';').any(|pair| {
        let Some((key, cookie_value)) = pair.split_once('=') else {
            return false;
        };
        !cookie_value.trim().is_empty()
            && (key.trim().eq_ignore_ascii_case("sessionid")
                || key.trim().eq_ignore_ascii_case("sessionid_ss"))
    });
    has_login_session.then(|| value.to_string())
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::Arc;

    use reqwest::Url;
    use reqwest::cookie::Jar;
    use serde_json::json;

    use super::{
        PollState, SITE, TRUSTED_SUFFIXES, cookie_from_jar, parse_json_body, parse_poll_response,
        parse_start_response,
    };
    use crate::account::qr;

    #[test]
    fn reports_a_browser_verification_page_without_echoing_its_contents() {
        let error = parse_json_body(
            "<!doctype html><html><body>browser verification</body></html>",
            "douyin_qr_generate",
        )
        .unwrap_err();

        assert_eq!(error.code, "douyin_qr_generate");
        assert!(error.message.contains("浏览器完成访问验证"));
        assert!(!error.message.contains("browser verification"));
    }

    #[tokio::test]
    async fn configured_proxy_receives_qr_client_requests() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 2048];
            let length = stream.read(&mut request).unwrap();
            let request = String::from_utf8_lossy(&request[..length]);
            assert!(request.starts_with("GET http://sso.douyin.invalid/get_qrcode/ HTTP/1.1"));
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
                )
                .unwrap();
        });

        let proxy = format!("http://{address}");
        let client = qr::build_login_client(
            SITE,
            Arc::new(Jar::default()),
            TRUSTED_SUFFIXES,
            false,
            Some(&proxy),
        )
        .unwrap();
        let response = client
            .get("http://sso.douyin.invalid/get_qrcode/")
            .send()
            .await
            .unwrap();

        assert_eq!(response.status(), reqwest::StatusCode::OK);
        server.join().unwrap();
    }

    #[test]
    fn parses_public_web_qr_payload() {
        let body = json!({
            "status_code": 0,
            "data": {
                "qrcode": "https://sso.douyin.com/scan_qr/?token=abc",
                "token": "qr-token"
            }
        });

        assert_eq!(
            parse_start_response(&body).unwrap(),
            (
                "https://sso.douyin.com/scan_qr/?token=abc".to_string(),
                "qr-token".to_string()
            )
        );
    }

    #[test]
    fn rejects_an_untrusted_qr_payload_url() {
        let body = json!({
            "status_code": 0,
            "data": {
                "qrcode": "https://not-douyin.example/scan?token=abc",
                "token": "qr-token"
            }
        });

        let error = parse_start_response(&body).unwrap_err();
        assert_eq!(error.code, "douyin_qr_response_invalid");
    }

    #[test]
    fn poll_states_follow_the_public_web_protocol() {
        let pending = json!({ "status_code": 0, "data": { "status": "1" } });
        assert!(matches!(
            parse_poll_response(&pending).unwrap(),
            PollState::Pending
        ));

        let scanned = json!({ "status_code": 0, "data": { "status": 2 } });
        assert!(matches!(
            parse_poll_response(&scanned).unwrap(),
            PollState::Scanned
        ));

        let expired = json!({ "status_code": 0, "data": { "status": "4" } });
        assert!(matches!(
            parse_poll_response(&expired).unwrap(),
            PollState::Expired
        ));
    }

    #[test]
    fn redirect_is_the_success_signal() {
        let body = json!({
            "status_code": 0,
            "data": {
                "status": "3",
                "redirect_url": "https://www.douyin.com/passport/web/login/?token=abc"
            }
        });
        let state = parse_poll_response(&body).unwrap();
        assert!(matches!(state, PollState::Success { .. }));
    }

    #[test]
    fn login_cookie_requires_a_session_cookie() {
        let jar = Arc::new(Jar::default());
        let url = Url::parse("https://www.douyin.com/").unwrap();
        jar.add_cookie_str("ttwid=anonymous; Domain=.douyin.com; Path=/", &url);
        assert!(cookie_from_jar(&jar).is_none());

        jar.add_cookie_str("sessionid=logged-in; Domain=.douyin.com; Path=/", &url);
        let cookie = cookie_from_jar(&jar).unwrap();
        assert!(
            cookie
                .split(';')
                .any(|pair| pair.trim() == "sessionid=logged-in")
        );
        assert!(
            cookie
                .split(';')
                .any(|pair| pair.trim() == "ttwid=anonymous")
        );

        let empty_session = Arc::new(Jar::default());
        empty_session.add_cookie_str("sessionid=; Domain=.douyin.com; Path=/", &url);
        assert!(cookie_from_jar(&empty_session).is_none());
    }

    #[test]
    fn only_https_douyin_redirects_are_trusted() {
        assert!(qr::is_trusted_url(
            &Url::parse("https://sso.douyin.com/login").unwrap(),
            TRUSTED_SUFFIXES
        ));
        assert!(!qr::is_trusted_url(
            &Url::parse("http://sso.douyin.com/login").unwrap(),
            TRUSTED_SUFFIXES
        ));
        assert!(!qr::is_trusted_url(
            &Url::parse("https://douyin.com.example.test/login").unwrap(),
            TRUSTED_SUFFIXES
        ));
        assert!(!qr::is_trusted_url(
            &Url::parse("https://user@www.douyin.com/login").unwrap(),
            TRUSTED_SUFFIXES
        ));
        assert!(!qr::is_trusted_url(
            &Url::parse("https://www.douyin.com:8443/login").unwrap(),
            TRUSTED_SUFFIXES
        ));
    }

    #[test]
    fn redirect_policy_limits_hops_and_only_allows_douyin() {
        let trusted = Url::parse("https://sso.douyin.com/login").unwrap();
        let untrusted = Url::parse("https://example.test/login").unwrap();

        assert!(qr::can_follow_redirect(&trusted, 0, TRUSTED_SUFFIXES));
        assert!(!qr::can_follow_redirect(&trusted, 8, TRUSTED_SUFFIXES));
        assert!(!qr::can_follow_redirect(&untrusted, 0, TRUSTED_SUFFIXES));
    }
}
