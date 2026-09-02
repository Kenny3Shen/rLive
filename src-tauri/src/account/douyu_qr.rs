//! 用户扫码的斗鱼 Web 登录。
//!
//! 这里对齐斗鱼当前 passport 页面使用的公开扫码流程：
//! `scan/generateCode` 生成手机 App 可扫的二维码内容，随后
//! `japi/scan/auth` 上报其状态。一次性的上游 scan code 和 Cookie jar
//! 都保持在进程内。只有校验通过的成功 Cookie header 才会返回给账号命令
//! 用于本地持久化。

use std::sync::Arc;

use reqwest::cookie::{CookieStore, Jar};
use reqwest::header::{ACCEPT, ACCEPT_LANGUAGE, ORIGIN, REFERER, USER_AGENT};
use reqwest::{Client, Url};
use serde_json::Value;
use uuid::Uuid;

use crate::account::qr::{
    QrSessionStore, QrSite, build_login_client, is_trusted_url, is_valid_session_key,
    optional_text, value_as_i64,
};
use crate::error::{AppError, AppResult};

pub use crate::account::qr::{QrLoginPoll, QrLoginStart};

const SITE: QrSite = QrSite {
    id: "douyu",
    display: "斗鱼",
};
const TRUSTED_SUFFIXES: &[&str] = &["douyu.com"];

const PASSPORT_ORIGIN: &str = "https://passport.douyu.com/";
const WEB_ORIGIN: &str = "https://www.douyu.com/";
const QR_GENERATE_URL: &str = "https://passport.douyu.com/scan/generateCode";
const QR_POLL_URL: &str = "https://passport.douyu.com/japi/scan/auth";
const JSONP_CALLBACK: &str = "rlive_douyu_qr_callback";
const USER_AGENT_VALUE: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const MAX_QR_PAYLOAD_LEN: usize = 8 * 1024;
const MAX_SCAN_CODE_LEN: usize = 512;
const MAX_COOKIE_LEN: usize = 16 * 1024;

#[derive(Clone)]
struct QrSession {
    scan_code: String,
    client: Client,
    jar: Arc<Jar>,
}

static DOUYU_SESSIONS: QrSessionStore<QrSession> = QrSessionStore::new(SITE);

/// 启动斗鱼公开的 Web 扫码流程。
pub async fn start() -> AppResult<QrLoginStart> {
    let jar = Arc::new(Jar::default());
    let client = build_login_client(SITE, Arc::clone(&jar), TRUSTED_SUFFIXES, false, None)?;
    let response = client
        .post(QR_GENERATE_URL)
        .form(&[("client_id", "1"), ("isMultiAccount", "0")])
        .header(ACCEPT, "application/json, text/javascript, */*; q=0.01")
        .header(ACCEPT_LANGUAGE, "zh-CN,zh;q=0.9,en;q=0.8")
        .header(ORIGIN, "https://passport.douyu.com")
        .header(REFERER, PASSPORT_ORIGIN)
        .header("x-requested-with", "XMLHttpRequest")
        .header(USER_AGENT, USER_AGENT_VALUE)
        .send()
        .await
        .map_err(|_| SITE.network_error("douyu_qr_generate"))?;
    let body = parse_json_response(response, "douyu_qr_generate").await?;
    let (qr_code_url, scan_code) = parse_start_response(&body)?;

    // UI 必然会拿到用于渲染的二维码内容，但 scan code 从不作为单独的值返回。
    // 它始终与引导用的 Cookie jar 一起留在本进程内。
    let qr_key = Uuid::new_v4().simple().to_string();
    DOUYU_SESSIONS.insert(
        qr_key.clone(),
        QrSession {
            scan_code,
            client,
            jar,
        },
    )?;

    Ok(QrLoginStart {
        qr_code_url,
        qr_key,
    })
}

/// 轮询先前发起的扫码登录流程。
pub async fn poll(qr_key: &str) -> AppResult<QrLoginPoll> {
    if !is_valid_session_key(qr_key) {
        return Err(SITE.error("invalid_key", "二维码登录凭据无效，请刷新二维码"));
    }

    let session = DOUYU_SESSIONS.get(qr_key)?;
    let now_ms = chrono::Utc::now().timestamp_millis().to_string();
    let response = session
        .client
        .get(QR_POLL_URL)
        .query(&[
            ("code", session.scan_code.as_str()),
            ("time", now_ms.as_str()),
        ])
        .header(ACCEPT, "application/json, text/javascript, */*; q=0.01")
        .header(ACCEPT_LANGUAGE, "zh-CN,zh;q=0.9,en;q=0.8")
        .header(REFERER, PASSPORT_ORIGIN)
        .header("x-requested-with", "XMLHttpRequest")
        .header(USER_AGENT, USER_AGENT_VALUE)
        .send()
        .await
        .map_err(|_| SITE.network_error("douyu_qr_poll"))?;
    let body = parse_json_response(response, "douyu_qr_poll").await?;

    match parse_poll_response(&body)? {
        PollState::Pending => Ok(QrLoginPoll::Pending),
        PollState::Scanned => Ok(QrLoginPoll::Scanned),
        PollState::Expired => {
            DOUYU_SESSIONS.remove(qr_key)?;
            Ok(QrLoginPoll::Expired)
        }
        PollState::Success { completion_url } => {
            let cookie = finish_login(&session, &completion_url).await?;
            DOUYU_SESSIONS.remove(qr_key)?;
            Ok(QrLoginPoll::Success { cookie })
        }
    }
}

async fn parse_json_response(response: reqwest::Response, code: &str) -> AppResult<Value> {
    if !response.status().is_success() {
        return Err(
            AppError::new(code, "斗鱼二维码登录服务暂不可用，请稍后重试")
                .with_site("douyu")
                .retryable(),
        );
    }
    response.json::<Value>().await.map_err(|_| {
        AppError::new(code, "斗鱼二维码登录服务返回了无法识别的数据")
            .with_site("douyu")
            .retryable()
    })
}

fn parse_start_response(response: &Value) -> AppResult<(String, String)> {
    ensure_api_success(response, "douyu_qr_generate")?;
    let data = response
        .get("data")
        .ok_or_else(|| SITE.invalid_response("douyu_qr_generate"))?;
    let qr_code_url = required_text(data, &["url", "qr_url", "qrcode_url"], MAX_QR_PAYLOAD_LEN)?;
    let qr_url = parse_trusted_douyu_url(&qr_code_url).ok_or_else(|| {
        SITE.retryable_error(
            "response_invalid",
            "斗鱼二维码服务返回了不受信任的二维码地址",
        )
    })?;
    if !is_trusted_url(&qr_url, TRUSTED_SUFFIXES) {
        return Err(SITE.retryable_error(
            "response_invalid",
            "斗鱼二维码服务返回了不受信任的二维码地址",
        ));
    }
    let scan_code = required_text(data, &["code", "scan_code"], MAX_SCAN_CODE_LEN)?;
    Ok((qr_url.to_string(), scan_code))
}

enum PollState {
    Pending,
    Scanned,
    Expired,
    Success { completion_url: String },
}

fn parse_poll_response(response: &Value) -> AppResult<PollState> {
    let error = api_error_code(response).ok_or_else(|| SITE.invalid_response("douyu_qr_poll"))?;
    match error {
        // 已对照当前公开 passport 页面确认：`-2` 表示 App 尚未扫码；
        // `1` 表示已扫码、等待确认；`-1` 表示二维码已过期或无效。
        -2 => Ok(PollState::Pending),
        1 => Ok(PollState::Scanned),
        -1 => Ok(PollState::Expired),
        0 => {
            let data = response
                .get("data")
                .ok_or_else(|| SITE.invalid_response("douyu_qr_poll"))?;
            let completion_url = required_text(data, &["url", "login_url"], MAX_QR_PAYLOAD_LEN)?;
            Ok(PollState::Success { completion_url })
        }
        _ => Err(SITE.retryable_error("poll", "二维码登录状态异常，请刷新二维码后重试")),
    }
}

async fn finish_login(session: &QrSession, completion_url: &str) -> AppResult<String> {
    let completion_url = parse_trusted_douyu_url(completion_url).ok_or_else(|| {
        SITE.retryable_error(
            "redirect_invalid",
            "斗鱼登录跳转地址无效或不受信任，请刷新二维码后重试",
        )
    })?;
    if !is_trusted_url(&completion_url, TRUSTED_SUFFIXES) {
        return Err(SITE.retryable_error(
            "redirect_invalid",
            "斗鱼登录跳转地址无效或不受信任，请刷新二维码后重试",
        ));
    }

    let completion_url = with_jsonp_callback(completion_url);
    let response = session
        .client
        .get(completion_url)
        .header(
            ACCEPT,
            "application/javascript, application/json, text/javascript, */*; q=0.01",
        )
        .header(ACCEPT_LANGUAGE, "zh-CN,zh;q=0.9,en;q=0.8")
        .header(REFERER, PASSPORT_ORIGIN)
        .header(USER_AGENT, USER_AGENT_VALUE)
        .send()
        .await
        .map_err(|_| SITE.network_error("douyu_qr_complete"))?;
    if !response.status().is_success() {
        return Err(SITE.retryable_error("complete", "斗鱼登录确认失败，请刷新二维码后重试"));
    }
    let body = response.text().await.map_err(|_| {
        SITE.retryable_error("complete", "斗鱼登录确认响应读取失败，请刷新二维码后重试")
    })?;
    let response = parse_json_or_jsonp(&body, JSONP_CALLBACK)?;
    ensure_api_success(&response, "douyu_qr_complete")?;

    cookie_from_jar(&session.jar).ok_or_else(|| {
        SITE.retryable_error(
            "cookie_missing",
            "登录已确认，但未取得可用 Cookie；请刷新二维码后重试",
        )
    })
}

fn ensure_api_success(response: &Value, code: &str) -> AppResult<()> {
    match api_error_code(response) {
        Some(0) => Ok(()),
        Some(_) => Err(
            AppError::new(code, "斗鱼二维码登录服务拒绝了请求，请刷新二维码后重试")
                .with_site("douyu")
                .retryable(),
        ),
        None => Err(SITE.invalid_response(code)),
    }
}

fn api_error_code(response: &Value) -> Option<i64> {
    ["error", "code"]
        .iter()
        .find_map(|key| value_as_i64(response.get(*key)?))
}

fn required_text(data: &Value, keys: &[&str], max_len: usize) -> AppResult<String> {
    optional_text(data, keys, max_len)
        .ok_or_else(|| SITE.invalid_response("douyu_qr_response_invalid"))
}

fn parse_json_or_jsonp(body: &str, callback: &str) -> AppResult<Value> {
    let body = body.trim_start_matches('\u{feff}').trim();
    if let Ok(json) = serde_json::from_str(body) {
        return Ok(json);
    }

    // 斗鱼的完成接口在其 Web 客户端里是 JSONP 回调。只接受本模块自己选定的
    // 回调名，而不接受服务端返回的任意 JavaScript 函数名。
    let body = body.strip_prefix("/**/").unwrap_or(body).trim();
    let prefix = format!("{callback}(");
    let json = body.strip_prefix(&prefix).and_then(|rest| {
        rest.strip_suffix(");")
            .or_else(|| rest.strip_suffix(')'))
            .map(str::trim)
    });
    json.and_then(|json| serde_json::from_str(json).ok())
        .ok_or_else(|| SITE.retryable_error("complete", "斗鱼登录确认服务返回了无法识别的数据"))
}

fn cookie_from_jar(jar: &Arc<Jar>) -> Option<String> {
    let url = Url::parse(WEB_ORIGIN).ok()?;
    let cookie_header = jar.cookies(&url)?;
    let value = cookie_header.to_str().ok()?.trim();
    if value.is_empty() || value.len() > MAX_COOKIE_LEN || value.contains(['\r', '\n']) {
        return None;
    }

    // 这些是斗鱼 Web API 要求的已认证 Cookie 字段。存储的 header 中保留其他
    // 所有 Web Cookie 字段，但绝不接受缺少这三个凭据、
    // 只是看起来成功的登录结果。
    const REQUIRED_COOKIES: [&str; 3] = ["acf_username", "acf_stk", "acf_ltkid"];
    let names = value
        .split(';')
        .filter_map(|pair| pair.split_once('='))
        .filter_map(|(name, cookie_value)| (!cookie_value.trim().is_empty()).then_some(name.trim()))
        .collect::<Vec<_>>();
    REQUIRED_COOKIES
        .iter()
        .all(|required| names.iter().any(|name| name.eq_ignore_ascii_case(required)))
        .then(|| value.to_string())
}

fn parse_trusted_douyu_url(value: &str) -> Option<Url> {
    match Url::parse(value) {
        Ok(url) => Some(url),
        Err(_) => Url::parse(PASSPORT_ORIGIN).ok()?.join(value).ok(),
    }
}

fn with_jsonp_callback(mut url: Url) -> Url {
    let existing_pairs = url
        .query_pairs()
        .filter(|(key, _)| key != "callback")
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect::<Vec<_>>();
    url.set_query(None);
    {
        let mut pairs = url.query_pairs_mut();
        for (key, value) in existing_pairs {
            pairs.append_pair(&key, &value);
        }
        pairs.append_pair("callback", JSONP_CALLBACK);
    }
    url
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use reqwest::Url;
    use reqwest::cookie::Jar;
    use serde_json::json;

    use super::{
        PollState, TRUSTED_SUFFIXES, cookie_from_jar, parse_json_or_jsonp, parse_poll_response,
        parse_start_response, with_jsonp_callback,
    };
    use crate::account::qr::{can_follow_redirect, is_trusted_url};

    #[test]
    fn parses_current_public_qr_payload() {
        let body = json!({
            "error": 0,
            "data": {
                "expire": 300,
                "url": "https://m.douyu.com/topic/scan-login-middle-page?scan_code=example",
                "code": "0123456789abcdef0123456789abcdef"
            }
        });

        assert_eq!(
            parse_start_response(&body).unwrap(),
            (
                "https://m.douyu.com/topic/scan-login-middle-page?scan_code=example".to_string(),
                "0123456789abcdef0123456789abcdef".to_string()
            )
        );
    }

    #[test]
    fn rejects_an_untrusted_qr_payload_url() {
        let body = json!({
            "error": 0,
            "data": {
                "url": "https://not-douyu.example/scan",
                "code": "0123456789abcdef0123456789abcdef"
            }
        });

        let error = parse_start_response(&body).unwrap_err();
        assert_eq!(error.code, "douyu_qr_response_invalid");
    }

    #[test]
    fn poll_states_follow_the_public_passport_protocol() {
        let pending = json!({ "error": -2, "msg": "客户端还未扫码" });
        assert!(matches!(
            parse_poll_response(&pending).unwrap(),
            PollState::Pending
        ));

        let scanned = json!({ "error": 1 });
        assert!(matches!(
            parse_poll_response(&scanned).unwrap(),
            PollState::Scanned
        ));

        let expired = json!({ "error": -1 });
        assert!(matches!(
            parse_poll_response(&expired).unwrap(),
            PollState::Expired
        ));
    }

    #[test]
    fn success_requires_a_completion_url() {
        let body = json!({
            "error": 0,
            "data": { "url": "https://www.douyu.com/member/login" }
        });
        let state = parse_poll_response(&body).unwrap();
        assert!(matches!(state, PollState::Success { .. }));

        let missing = json!({ "error": 0, "data": {} });
        assert!(parse_poll_response(&missing).is_err());
    }

    #[test]
    fn accepts_only_the_expected_jsonp_callback() {
        let jsonp = r#"/**/rlive_douyu_qr_callback({"error":0});"#;
        assert_eq!(
            parse_json_or_jsonp(jsonp, "rlive_douyu_qr_callback")
                .unwrap()
                .get("error")
                .and_then(|value| value.as_i64()),
            Some(0)
        );
        assert!(
            parse_json_or_jsonp("other_callback({\"error\":0});", "rlive_douyu_qr_callback")
                .is_err()
        );
    }

    #[test]
    fn completion_callback_is_replaced_not_appended() {
        let url = Url::parse("https://www.douyu.com/login?ticket=abc&callback=other").unwrap();
        let url = with_jsonp_callback(url);
        let pairs = url.query_pairs().collect::<Vec<_>>();

        assert!(
            pairs
                .iter()
                .any(|(key, value)| key == "ticket" && value == "abc")
        );
        assert_eq!(
            pairs
                .iter()
                .filter(|(key, _)| key == "callback")
                .map(|(_, value)| value.as_ref())
                .collect::<Vec<_>>(),
            vec!["rlive_douyu_qr_callback"]
        );
    }

    #[test]
    fn login_cookie_requires_the_douyu_session_trio() {
        let jar = Arc::new(Jar::default());
        let url = Url::parse("https://www.douyu.com/").unwrap();
        jar.add_cookie_str("acf_username=viewer; Domain=.douyu.com; Path=/", &url);
        jar.add_cookie_str("acf_stk=token; Domain=.douyu.com; Path=/", &url);
        assert!(cookie_from_jar(&jar).is_none());

        jar.add_cookie_str("acf_ltkid=login-token; Domain=.douyu.com; Path=/", &url);
        let cookie = cookie_from_jar(&jar).unwrap();
        assert!(
            cookie
                .split(';')
                .any(|pair| pair.trim() == "acf_username=viewer")
        );
        assert!(cookie.split(';').any(|pair| pair.trim() == "acf_stk=token"));
        assert!(
            cookie
                .split(';')
                .any(|pair| pair.trim() == "acf_ltkid=login-token")
        );
    }

    #[test]
    fn only_https_douyu_redirects_are_trusted() {
        assert!(is_trusted_url(
            &Url::parse("https://passport.douyu.com/login").unwrap(),
            TRUSTED_SUFFIXES
        ));
        assert!(!is_trusted_url(
            &Url::parse("http://passport.douyu.com/login").unwrap(),
            TRUSTED_SUFFIXES
        ));
        assert!(!is_trusted_url(
            &Url::parse("https://douyu.com.example.test/login").unwrap(),
            TRUSTED_SUFFIXES
        ));
        assert!(!is_trusted_url(
            &Url::parse("https://user@www.douyu.com/login").unwrap(),
            TRUSTED_SUFFIXES
        ));
        assert!(!is_trusted_url(
            &Url::parse("https://www.douyu.com:8443/login").unwrap(),
            TRUSTED_SUFFIXES
        ));
    }

    #[test]
    fn redirect_policy_limits_hops_and_only_allows_douyu() {
        let trusted = Url::parse("https://passport.douyu.com/login").unwrap();
        let untrusted = Url::parse("https://example.test/login").unwrap();

        assert!(can_follow_redirect(&trusted, 0, TRUSTED_SUFFIXES));
        assert!(!can_follow_redirect(&trusted, 8, TRUSTED_SUFFIXES));
        assert!(!can_follow_redirect(&untrusted, 0, TRUSTED_SUFFIXES));
    }
}
