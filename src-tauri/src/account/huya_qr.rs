//! 用户扫码的虎牙 Web 登录。
//!
//! 对齐 `www.huya.com` 使用的公开 UDB 流程：
//! - `POST /qrLgn/getQrId` 分配一个短时效的 QR id
//! - `GET  /qrLgn/getQrImg?k=` 提供手机 App 扫描的 PNG
//! - `POST /qrLgn/tryQrLogin` 上报扫码/确认进度
//!
//! 成功时响应可能包含 `domainUrlList` 这类用于播种 cookie 的 URL。这些 URL
//! 用进程内的 cookie jar 抓取，以便保存最终的 Cookie header 供发送弹幕使用。
//! 上游 QR id 绝不会作为单独的值离开本进程；UI 只拿到本地的不透明句柄
//! 以及渲染二维码所需的图片 URL。

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use reqwest::cookie::{CookieStore, Jar};
use reqwest::header::{ACCEPT, ACCEPT_LANGUAGE, CONTENT_TYPE, ORIGIN, REFERER, USER_AGENT};
use reqwest::{Client, Url};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::error::{AppError, AppResult};

const LOGIN_ORIGIN: &str = "https://udblgn.huya.com";
const WEB_ORIGIN: &str = "https://www.huya.com/";
const GET_QR_ID_URL: &str = "https://udblgn.huya.com/qrLgn/getQrId";
const TRY_QR_LOGIN_URL: &str = "https://udblgn.huya.com/qrLgn/tryQrLogin";
const GET_QR_IMG_PATH: &str = "https://udblgn.huya.com/qrLgn/getQrImg";
const USER_AGENT_VALUE: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
/// 虎牙公开的 Web UDB app id。
const APP_ID: &str = "5002";
const UDB_VERSION: &str = "1.0";
const LCID: &str = "2052";
const BY_PASS: &str = "3";
const URI_GET_QR_ID: &str = "70001";
const URI_TRY_QR_LOGIN: &str = "70003";

const SESSION_TTL: Duration = Duration::from_secs(5 * 60);
const MAX_ACTIVE_SESSIONS: usize = 16;
const MAX_REDIRECTS: usize = 8;
const MAX_QR_ID_LEN: usize = 128;
const MAX_COOKIE_LEN: usize = 16 * 1024;
const MAX_DOMAIN_URLS: usize = 16;

/// 客户端渲染虎牙登录二维码所需的数据。
pub struct QrLoginStart {
    /// 二维码 PNG 的 HTTPS 图片地址。设置界面用 `<img>` 渲染它。
    pub qr_code_url: String,
    /// 不透明的进程内句柄，而不是虎牙真正的 `qrId`。
    pub qr_key: String,
}

/// 一次扫码轮询结果。Cookie 内容绝不跨出 webview 边界。
pub enum QrLoginPoll {
    Pending,
    Scanned,
    Expired,
    Success { cookie: String },
}

#[derive(Clone)]
struct QrSession {
    qr_id: String,
    client: Client,
    jar: Arc<Jar>,
    created_at: Instant,
}

static ACTIVE_SESSIONS: OnceLock<Mutex<HashMap<String, QrSession>>> = OnceLock::new();

fn active_sessions() -> &'static Mutex<HashMap<String, QrSession>> {
    ACTIVE_SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 启动虎牙公开的 Web 扫码流程。
pub async fn start() -> AppResult<QrLoginStart> {
    let jar = Arc::new(Jar::default());
    let client = build_login_client(Arc::clone(&jar))?;
    let body = udb_request(
        URI_GET_QR_ID,
        json!({
            "behavior": "",
            "page": WEB_ORIGIN,
        }),
    );
    let response = client
        .post(GET_QR_ID_URL)
        .header(ACCEPT, "application/json, text/plain, */*")
        .header(ACCEPT_LANGUAGE, "zh-CN,zh;q=0.9,en;q=0.8")
        .header(CONTENT_TYPE, "application/json;charset=UTF-8")
        .header(ORIGIN, "https://www.huya.com")
        .header(REFERER, WEB_ORIGIN)
        .header(USER_AGENT, USER_AGENT_VALUE)
        .json(&body)
        .send()
        .await
        .map_err(|_| qr_network_error("huya_qr_generate"))?;
    let response = parse_json_response(response, "huya_qr_generate").await?;
    let qr_id = parse_qr_id(&response)?;
    let qr_code_url = format!("{GET_QR_IMG_PATH}?k={qr_id}");

    let qr_key = Uuid::new_v4().simple().to_string();
    insert_session(
        qr_key.clone(),
        QrSession {
            qr_id,
            client,
            jar,
            created_at: Instant::now(),
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
        return Err(
            AppError::new("huya_qr_invalid_key", "二维码登录凭据无效，请刷新二维码")
                .with_site("huya"),
        );
    }

    let session = get_session(qr_key)?;
    let body = udb_request(
        URI_TRY_QR_LOGIN,
        json!({
            "qrId": session.qr_id,
            "remember": "1",
            "behavior": "",
            "page": WEB_ORIGIN,
        }),
    );
    let response = session
        .client
        .post(TRY_QR_LOGIN_URL)
        .header(ACCEPT, "application/json, text/plain, */*")
        .header(ACCEPT_LANGUAGE, "zh-CN,zh;q=0.9,en;q=0.8")
        .header(CONTENT_TYPE, "application/json;charset=UTF-8")
        .header(ORIGIN, "https://www.huya.com")
        .header(REFERER, WEB_ORIGIN)
        .header(USER_AGENT, USER_AGENT_VALUE)
        .json(&body)
        .send()
        .await
        .map_err(|_| qr_network_error("huya_qr_poll"))?;
    let response = parse_json_response(response, "huya_qr_poll").await?;

    match parse_poll_response(&response)? {
        PollState::Pending => Ok(QrLoginPoll::Pending),
        PollState::Scanned => Ok(QrLoginPoll::Scanned),
        PollState::Expired => {
            remove_session(qr_key)?;
            Ok(QrLoginPoll::Expired)
        }
        PollState::Success { domain_urls } => {
            finish_login(&session, &domain_urls).await?;
            let cookie = cookie_from_jar(&session.jar).ok_or_else(|| {
                AppError::new(
                    "huya_qr_cookie_missing",
                    "登录已确认，但未取得可用 Cookie；请刷新二维码后重试",
                )
                .with_site("huya")
                .retryable()
            })?;
            remove_session(qr_key)?;
            Ok(QrLoginPoll::Success { cookie })
        }
    }
}

fn build_login_client(jar: Arc<Jar>) -> AppResult<Client> {
    Client::builder()
        .use_native_tls()
        .cookie_provider(jar)
        // 扫码认证携带的是临时登录会话。不要让它走应用的浏览代理。
        .no_proxy()
        .timeout(Duration::from_secs(20))
        .connect_timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if can_follow_redirect(attempt.url(), attempt.previous().len()) {
                attempt.follow()
            } else {
                attempt.stop()
            }
        }))
        .build()
        .map_err(|_| {
            AppError::new("huya_qr_client", "二维码登录网络客户端初始化失败").with_site("huya")
        })
}

fn udb_request(uri: &str, data: Value) -> Value {
    json!({
        "uri": uri,
        "version": UDB_VERSION,
        "context": format!("WB-{}--", &Uuid::new_v4().simple().to_string()[..12]),
        "appId": APP_ID,
        "smid": "",
        "lcid": LCID,
        "byPass": BY_PASS,
        "sdid": "",
        "requestId": chrono::Utc::now().timestamp_millis().to_string(),
        "data": data,
    })
}

async fn parse_json_response(response: reqwest::Response, code: &str) -> AppResult<Value> {
    if !response.status().is_success() {
        return Err(
            AppError::new(code, "虎牙二维码登录服务暂不可用，请稍后重试")
                .with_site("huya")
                .retryable(),
        );
    }
    response.json::<Value>().await.map_err(|_| {
        AppError::new(code, "虎牙二维码登录服务返回了无法识别的数据")
            .with_site("huya")
            .retryable()
    })
}

fn parse_qr_id(response: &Value) -> AppResult<String> {
    ensure_api_success(response, "huya_qr_generate")?;
    let data = response
        .get("data")
        .ok_or_else(|| invalid_response("huya_qr_generate"))?;
    let qr_id = required_text(data, &["qrId", "qr_id"], MAX_QR_ID_LEN)?;
    if !is_safe_qr_id(&qr_id) {
        return Err(invalid_response("huya_qr_generate"));
    }
    Ok(qr_id)
}

enum PollState {
    Pending,
    Scanned,
    Expired,
    Success { domain_urls: Vec<String> },
}

fn parse_poll_response(response: &Value) -> AppResult<PollState> {
    // 已对照官方 Web 客户端确认：
    // stage 0/4 = 等待，1 = 已扫码，2/3 = 已确认，5/6/7 = 二维码失效。
    ensure_api_success(response, "huya_qr_poll")?;
    let data = response
        .get("data")
        .ok_or_else(|| invalid_response("huya_qr_poll"))?;
    let stage = value_as_i64(data.get("stage").unwrap_or(&Value::Null)).unwrap_or(-1);
    match stage {
        0 | 4 => Ok(PollState::Pending),
        1 => Ok(PollState::Scanned),
        2 | 3 => {
            let domain_urls = domain_url_list(data);
            Ok(PollState::Success { domain_urls })
        }
        5..=7 => Ok(PollState::Expired),
        8 => Err(
            AppError::new("huya_qr_account", "扫码账号异常，请更换账号后重试")
                .with_site("huya")
                .retryable(),
        ),
        _ => Err(
            AppError::new("huya_qr_poll", "二维码登录状态异常，请刷新二维码后重试")
                .with_site("huya")
                .retryable(),
        ),
    }
}

fn domain_url_list(data: &Value) -> Vec<String> {
    data.get("domainUrlList")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|value| {
            let raw = value
                .as_str()
                .or_else(|| value.get("url").and_then(Value::as_str))?
                .trim();
            if raw.is_empty() || raw.len() > 2_048 {
                return None;
            }
            let url = parse_trusted_huya_url(raw)?;
            is_trusted_huya_url(&url).then(|| url.to_string())
        })
        .take(MAX_DOMAIN_URLS)
        .collect()
}

async fn finish_login(session: &QrSession, domain_urls: &[String]) -> AppResult<()> {
    // 浏览器正是通过访问 UDB 的 cookie 播种 URL，才在确认扫码后拿到
    // yyuid / udb_* 字段。这里先限制主机与协议。
    for raw in domain_urls {
        let url = parse_trusted_huya_url(raw).ok_or_else(|| {
            AppError::new(
                "huya_qr_redirect_invalid",
                "虎牙登录跳转地址无效或不受信任，请刷新二维码后重试",
            )
            .with_site("huya")
            .retryable()
        })?;
        if !is_trusted_huya_url(&url) {
            return Err(AppError::new(
                "huya_qr_redirect_invalid",
                "虎牙登录跳转地址无效或不受信任，请刷新二维码后重试",
            )
            .with_site("huya")
            .retryable());
        }
        let response = session
            .client
            .get(url)
            .header(
                ACCEPT,
                "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            )
            .header(ACCEPT_LANGUAGE, "zh-CN,zh;q=0.9,en;q=0.8")
            .header(REFERER, WEB_ORIGIN)
            .header(USER_AGENT, USER_AGENT_VALUE)
            .send()
            .await
            .map_err(|_| qr_network_error("huya_qr_complete"))?;
        // 刻意丢弃响应 body，只有 Set-Cookie 的副作用有意义。
        let _ = response.bytes().await;
    }
    Ok(())
}

fn ensure_api_success(response: &Value, code: &str) -> AppResult<()> {
    match value_as_i64(response.get("returnCode").unwrap_or(&Value::Null)) {
        Some(0) => Ok(()),
        Some(_) => Err(
            AppError::new(code, "虎牙二维码登录服务拒绝了请求，请刷新二维码后重试")
                .with_site("huya")
                .retryable(),
        ),
        None => Err(invalid_response(code)),
    }
}

fn value_as_i64(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_u64().and_then(|value| i64::try_from(value).ok()))
        .or_else(|| value.as_str()?.trim().parse::<i64>().ok())
}

fn required_text(data: &Value, keys: &[&str], max_len: usize) -> AppResult<String> {
    optional_text(data, keys, max_len).ok_or_else(|| invalid_response("huya_qr_response_invalid"))
}

fn optional_text(data: &Value, keys: &[&str], max_len: usize) -> Option<String> {
    keys.iter().find_map(|key| {
        let value = data.get(*key)?.as_str()?.trim();
        (!value.is_empty() && value.len() <= max_len && !value.contains(['\r', '\n']))
            .then(|| value.to_string())
    })
}

fn cookie_from_jar(jar: &Arc<Jar>) -> Option<String> {
    // 优先使用主站视角的 jar；UDB 登录也会在 udblgn/lgn 主机上写 cookie，
    // 而 reqwest 的 jar 在查询相关 URL 时会合并这些主机的 cookie。
    let candidates = [WEB_ORIGIN, LOGIN_ORIGIN, "https://lgn.huya.com/"];
    let mut parts = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for origin in candidates {
        let Ok(url) = Url::parse(origin) else {
            continue;
        };
        let Some(header) = jar.cookies(&url) else {
            continue;
        };
        let Ok(value) = header.to_str() else {
            continue;
        };
        for pair in value.split(';') {
            let pair = pair.trim();
            if pair.is_empty() {
                continue;
            }
            let Some((name, _)) = pair.split_once('=') else {
                continue;
            };
            let name = name.trim();
            if seen.insert(name.to_ascii_lowercase()) {
                parts.push(pair.to_string());
            }
        }
    }
    if parts.is_empty() {
        return None;
    }
    let value = parts.join("; ");
    if value.len() > MAX_COOKIE_LEN || value.contains(['\r', '\n']) {
        return None;
    }

    // 与发送路径的凭据校验保持一致，这样"成功"的扫码登录
    // 之后确实能授权发送弹幕。
    has_send_credentials(&value).then_some(value)
}

fn has_send_credentials(cookie: &str) -> bool {
    let names = cookie
        .split(';')
        .filter_map(|pair| pair.split_once('='))
        .filter_map(|(name, value)| (!value.trim().is_empty()).then_some(name.trim()))
        .collect::<Vec<_>>();
    let has_uid = ["yyuid", "udb_uid"]
        .iter()
        .any(|required| names.iter().any(|name| name.eq_ignore_ascii_case(required)));
    let has_proof = ["udb_n", "udb_cred", "udb_biztoken"]
        .iter()
        .any(|required| names.iter().any(|name| name.eq_ignore_ascii_case(required)));
    has_uid && has_proof
}

fn parse_trusted_huya_url(value: &str) -> Option<Url> {
    match Url::parse(value) {
        Ok(url) => Some(url),
        Err(_) => Url::parse(LOGIN_ORIGIN).ok()?.join(value).ok(),
    }
}

fn is_trusted_huya_url(url: &Url) -> bool {
    if url.scheme() != "https"
        || url.port_or_known_default() != Some(443)
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return false;
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    let host = host.to_ascii_lowercase();
    host == "huya.com"
        || host.ends_with(".huya.com")
        || host == "yy.com"
        || host.ends_with(".yy.com")
}

fn can_follow_redirect(url: &Url, prior_redirects: usize) -> bool {
    prior_redirects < MAX_REDIRECTS && is_trusted_huya_url(url)
}

fn is_valid_session_key(value: &str) -> bool {
    value.len() == 32 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn is_safe_qr_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_QR_ID_LEN
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn insert_session(key: String, session: QrSession) -> AppResult<()> {
    let mut sessions = active_sessions().lock().map_err(|_| {
        AppError::new("huya_qr_session", "二维码登录会话初始化失败，请重试").with_site("huya")
    })?;
    prune_sessions(&mut sessions);
    if sessions.len() >= MAX_ACTIVE_SESSIONS
        && let Some(oldest_key) = sessions
            .iter()
            .min_by_key(|(_, session)| session.created_at)
            .map(|(key, _)| key.clone())
    {
        sessions.remove(&oldest_key);
    }
    sessions.insert(key, session);
    Ok(())
}

fn get_session(key: &str) -> AppResult<QrSession> {
    let mut sessions = active_sessions().lock().map_err(|_| {
        AppError::new("huya_qr_session", "二维码登录会话读取失败，请重试").with_site("huya")
    })?;
    prune_sessions(&mut sessions);
    sessions.get(key).cloned().ok_or_else(|| {
        AppError::new(
            "huya_qr_expired",
            "二维码登录会话已过期，请刷新二维码后重试",
        )
        .with_site("huya")
    })
}

fn remove_session(key: &str) -> AppResult<()> {
    let mut sessions = active_sessions().lock().map_err(|_| {
        AppError::new("huya_qr_session", "二维码登录会话清理失败，请重试").with_site("huya")
    })?;
    sessions.remove(key);
    Ok(())
}

fn prune_sessions(sessions: &mut HashMap<String, QrSession>) {
    let now = Instant::now();
    sessions.retain(|_, session| now.duration_since(session.created_at) < SESSION_TTL);
}

fn invalid_response(code: &str) -> AppError {
    AppError::new(code, "虎牙二维码登录服务未返回有效数据")
        .with_site("huya")
        .retryable()
}

fn qr_network_error(code: &str) -> AppError {
    AppError::new(code, "无法连接虎牙二维码登录服务，请检查网络后重试")
        .with_site("huya")
        .retryable()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{
        PollState, has_send_credentials, is_safe_qr_id, is_trusted_huya_url, is_valid_session_key,
        parse_poll_response, parse_qr_id, parse_trusted_huya_url,
    };

    #[test]
    fn parses_current_public_qr_id_payload() {
        let body = json!({
            "uri": 70002,
            "returnCode": 0,
            "data": { "qrId": "oSCnTjpjouascpntncc" }
        });
        assert_eq!(parse_qr_id(&body).unwrap(), "oSCnTjpjouascpntncc");
    }

    #[test]
    fn rejects_unsafe_qr_id_values() {
        let body = json!({
            "returnCode": 0,
            "data": { "qrId": "bad id with spaces" }
        });
        assert!(parse_qr_id(&body).is_err());
        assert!(!is_safe_qr_id("a/b"));
    }

    #[test]
    fn poll_states_follow_udb_sdk_stages() {
        let pending = json!({ "returnCode": 0, "data": { "stage": 0 } });
        assert!(matches!(
            parse_poll_response(&pending).unwrap(),
            PollState::Pending
        ));

        let scanned = json!({ "returnCode": 0, "data": { "stage": 1 } });
        assert!(matches!(
            parse_poll_response(&scanned).unwrap(),
            PollState::Scanned
        ));

        let expired = json!({ "returnCode": 0, "data": { "stage": 5 } });
        assert!(matches!(
            parse_poll_response(&expired).unwrap(),
            PollState::Expired
        ));

        let success = json!({
            "returnCode": 0,
            "data": {
                "stage": 2,
                "domainUrlList": [
                    "https://udblgn.huya.com/web/cookieExchange?x=1",
                    "https://evil.example/steal"
                ]
            }
        });
        match parse_poll_response(&success).unwrap() {
            PollState::Success { domain_urls } => {
                assert_eq!(
                    domain_urls,
                    vec!["https://udblgn.huya.com/web/cookieExchange?x=1".to_string()]
                );
            }
            _ => panic!("expected success poll state"),
        }
    }

    #[test]
    fn trusts_only_huya_and_yy_https_hosts() {
        let ok = parse_trusted_huya_url("https://udblgn.huya.com/web/x").unwrap();
        assert!(is_trusted_huya_url(&ok));
        let bad = parse_trusted_huya_url("https://not-huya.example/x").unwrap();
        assert!(!is_trusted_huya_url(&bad));
        assert!(!is_trusted_huya_url(
            &parse_trusted_huya_url("http://www.huya.com/").unwrap()
        ));
    }

    #[test]
    fn cookie_gate_matches_send_path_minimum() {
        assert!(has_send_credentials(
            "yyuid=12345; udb_uid=12345; udb_n=viewer; guid=test"
        ));
        assert!(has_send_credentials(
            "udb_uid=12345; udb_biztoken=token-value; guid=test"
        ));
        assert!(!has_send_credentials("udb_uid=12345; guid=test"));
        assert!(is_valid_session_key("0123456789abcdef0123456789abcdef"));
        assert!(!is_valid_session_key("short"));
    }
}
