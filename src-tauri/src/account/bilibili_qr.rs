//! Bilibili 的用户扫码登录流程。
//!
//! 桌面端只展示 Bilibili 返回的二维码 URL，并轮询对应的公开状态接口。
//! Bilibili 通过轮询请求的 `Set-Cookie` 响应头下发 Web 会话，并在回调 URL
//! 的 query 中重复其中部分字段。两个来源都用进程内的 cookie jar 收集，
//! 这样即使回调 URL 缺少这些字段，也不会把已确认的扫码判为失败；
//! 二维码 key 与 cookie 都不会写入日志。

use std::collections::HashMap;
use std::sync::Arc;

use reqwest::cookie::{CookieStore, Jar};
use reqwest::header::{ACCEPT, ACCEPT_LANGUAGE, REFERER, USER_AGENT};
use reqwest::{Client, Url};
use serde::Deserialize;
use uuid::Uuid;

use crate::account::qr::{QrSessionStore, QrSite, build_login_client, is_valid_session_key};
use crate::error::{AppError, AppResult};

pub use crate::account::qr::{QrLoginPoll, QrLoginStart};

/// B 站的历史错误文案不带站名，因此 `display` 为空串。
const SITE: QrSite = QrSite {
    id: "bilibili",
    display: "",
};
const TRUSTED_SUFFIXES: &[&str] = &["bilibili.com"];

const PASSPORT_ORIGIN: &str = "https://passport.bilibili.com/";
const WEB_ORIGIN: &str = "https://www.bilibili.com/";
const QR_GENERATE_URL: &str = "https://passport.bilibili.com/x/passport-login/web/qrcode/generate";
const QR_POLL_URL: &str = "https://passport.bilibili.com/x/passport-login/web/qrcode/poll";
const USER_AGENT_VALUE: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

const MAX_QR_KEY_LEN: usize = 512;
const MAX_COOKIE_LEN: usize = 16 * 1024;

/// Bilibili Web API 依赖的 Cookie 字段，按存储的 header 顺序排列。
const COOKIE_KEYS: &[&str] = &[
    "SESSDATA",
    "bili_jct",
    "DedeUserID",
    "DedeUserID__ckMd5",
    "sid",
    "buvid3",
    "buvid4",
];

#[derive(Clone)]
struct QrSession {
    qrcode_key: String,
    client: Client,
    jar: Arc<Jar>,
}

static BILIBILI_SESSIONS: QrSessionStore<QrSession> = QrSessionStore::new(SITE);

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
    let jar = Arc::new(Jar::default());
    let client = build_login_client(SITE, Arc::clone(&jar), TRUSTED_SUFFIXES, true, None)?;
    let response = client
        .get(QR_GENERATE_URL)
        .header(ACCEPT, "application/json, text/plain, */*")
        .header(ACCEPT_LANGUAGE, "zh-CN,zh;q=0.9,en;q=0.8")
        .header(REFERER, PASSPORT_ORIGIN)
        .header(USER_AGENT, USER_AGENT_VALUE)
        .send()
        .await
        .map_err(|_| SITE.network_error("bilibili_qr_generate"))?;

    let response: ApiResponse<GenerateData> = response
        .json()
        .await
        .map_err(|_| SITE.retryable_error("generate", "二维码服务返回了无法识别的数据"))?;
    if response.code != 0 {
        return Err(qr_api_error("generate", &response.message));
    }

    let data = response
        .data
        .ok_or_else(|| SITE.retryable_error("generate", "二维码服务未返回登录地址"))?;
    if data.url.trim().is_empty()
        || data.qrcode_key.trim().is_empty()
        || data.qrcode_key.len() > MAX_QR_KEY_LEN
    {
        return Err(SITE.retryable_error("generate", "二维码服务返回了不完整的登录信息"));
    }

    let qr_key = Uuid::new_v4().simple().to_string();
    BILIBILI_SESSIONS.insert(
        qr_key.clone(),
        QrSession {
            qrcode_key: data.qrcode_key,
            client,
            jar,
        },
    )?;

    Ok(QrLoginStart {
        qr_code_url: data.url,
        qr_key,
    })
}

pub async fn poll(qr_key: &str) -> AppResult<QrLoginPoll> {
    if !is_valid_session_key(qr_key) {
        return Err(SITE.error("invalid_key", "二维码登录凭据无效，请刷新二维码"));
    }

    let session = BILIBILI_SESSIONS.get(qr_key)?;
    let response = session
        .client
        .get(QR_POLL_URL)
        .query(&[("qrcode_key", session.qrcode_key.as_str())])
        .header(ACCEPT, "application/json, text/plain, */*")
        .header(ACCEPT_LANGUAGE, "zh-CN,zh;q=0.9,en;q=0.8")
        .header(REFERER, PASSPORT_ORIGIN)
        .header(USER_AGENT, USER_AGENT_VALUE)
        .send()
        .await
        .map_err(|_| SITE.network_error("bilibili_qr_poll"))?;

    // 读取 body 会消费掉响应，所以此时 jar 中必须已经持有 `Set-Cookie` 字段；
    // reqwest 的 cookie store 之所以能在此之前填充完毕，
    // 正是因为客户端在构建时带上了 cookie provider。
    let response: ApiResponse<PollData> = response
        .json()
        .await
        .map_err(|_| SITE.retryable_error("poll", "二维码状态服务返回了无法识别的数据"))?;
    if response.code != 0 {
        return Err(qr_api_error("poll", &response.message));
    }

    let data = response
        .data
        .ok_or_else(|| SITE.retryable_error("poll", "二维码状态服务未返回登录状态"))?;
    match data.code {
        0 => {
            let cookie = login_cookie(&session.jar, &data.url).ok_or_else(|| {
                SITE.retryable_error(
                    "cookie_missing",
                    "登录已确认，但未取得可用 Cookie；请刷新二维码后重试",
                )
            })?;
            BILIBILI_SESSIONS.remove(qr_key)?;
            Ok(QrLoginPoll::Success { cookie })
        }
        86_101 => Ok(QrLoginPoll::Pending),
        86_090 => Ok(QrLoginPoll::Scanned),
        86_038 => {
            BILIBILI_SESSIONS.remove(qr_key)?;
            Ok(QrLoginPoll::Expired)
        }
        _ => Err(SITE.retryable_error("poll", "二维码登录暂不可用，请刷新二维码后重试")),
    }
}

fn qr_api_error(suffix: &str, message: &str) -> AppError {
    let message = if message.trim().is_empty() {
        "二维码登录服务暂不可用，请稍后重试"
    } else {
        "二维码登录服务拒绝了请求，请刷新二维码后重试"
    };
    SITE.retryable_error(suffix, message)
}

/// 合并 Bilibili 两种下发途径中已确认登录的 Cookie。
///
/// 轮询响应的 `Set-Cookie` 头是主要来源；回调 URL 的 query 只重复其中一部分，
/// 作为字段仅出现在那里时的兜底。冲突时以 jar 中的值为准，
/// 因为那才是浏览器自身会存储的内容。
fn login_cookie(jar: &Arc<Jar>, callback_url: &str) -> Option<String> {
    let mut values = cookies_from_jar(jar);
    for (key, value) in cookies_from_callback_url(callback_url) {
        values.entry(key).or_insert(value);
    }

    // `SESSDATA` 是本应用所用 Bilibili API 需要的最小凭据。
    // 不要写入看似成功却不完整的登录结果。
    if !values.contains_key("SESSDATA") {
        return None;
    }

    let cookie = COOKIE_KEYS
        .iter()
        .filter_map(|key| values.get(*key).map(|value| format!("{key}={value}")))
        .collect::<Vec<_>>()
        .join("; ");
    if cookie.is_empty() || cookie.len() > MAX_COOKIE_LEN || cookie.contains(['\r', '\n']) {
        return None;
    }
    Some(cookie)
}

/// 读取轮询请求存入 cookie jar 的已知登录字段。
///
/// 取值完全按 Bilibili 下发的原样保存。reqwest 的 jar 不会对 cookie 值做
/// 百分号解码，而 `SESSDATA` 必须以原始编码形式送达 Web API，
/// 所以在这里重新编码会破坏它。
fn cookies_from_jar(jar: &Arc<Jar>) -> HashMap<&'static str, String> {
    let mut values = HashMap::new();
    for origin in [PASSPORT_ORIGIN, WEB_ORIGIN] {
        let Ok(url) = Url::parse(origin) else {
            continue;
        };
        let Some(header) = jar.cookies(&url) else {
            continue;
        };
        let Ok(header) = header.to_str() else {
            continue;
        };
        for pair in header.split(';') {
            let Some((key, value)) = pair.trim().split_once('=') else {
                continue;
            };
            let value = value.trim();
            if value.is_empty() {
                continue;
            }
            if !is_safe_cookie_value(value) {
                continue;
            }
            let Some(key) = COOKIE_KEYS
                .iter()
                .find(|known| known.eq_ignore_ascii_case(key.trim()))
            else {
                continue;
            };
            values.entry(*key).or_insert_with(|| value.to_string());
        }
    }
    values
}

/// 读取 Bilibili 扫码回调 URL 携带的已知登录字段。
///
/// 取值刻意保持百分号编码状态：Bilibili 的 cookie 值（如 `SESSDATA`）
/// 常包含 `%2C`，解码再编码可能改变 Web API 认可的那个不透明取值。
fn cookies_from_callback_url(callback_url: &str) -> HashMap<&'static str, String> {
    let mut values = HashMap::new();
    let Some(query) = callback_url
        .split_once('?')
        .map(|(_, query)| query.split('#').next().unwrap_or_default())
    else {
        return values;
    };
    for pair in query.split('&') {
        let Some((key, value)) = pair.split_once('=') else {
            continue;
        };
        if !is_safe_cookie_value(value) {
            continue;
        }
        if let Some(key) = COOKIE_KEYS.iter().find(|known| **known == key) {
            values.entry(*key).or_insert_with(|| value.to_string());
        }
    }
    values
}

/// 只接受可以原样写入 Cookie 请求头的非空取值。
///
/// Bilibili 的取值已经是百分号编码的 ASCII；任何包含分隔符或控制字节的内容
/// 都可能让被构造的响应注入第二个 cookie 字段，
/// 因此直接丢弃而不是转义。
fn is_safe_cookie_value(value: &str) -> bool {
    !value.is_empty()
        && value.is_ascii()
        && !value.bytes().any(|byte| {
            byte.is_ascii_control() || matches!(byte, b';' | b',' | b'"' | b'\\' | b' ')
        })
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use reqwest::Url;
    use reqwest::cookie::Jar;

    use super::{
        PASSPORT_ORIGIN, TRUSTED_SUFFIXES, cookies_from_jar, is_safe_cookie_value, login_cookie,
    };
    use crate::account::qr::{can_follow_redirect, is_trusted_url};

    /// 这个修复依赖 reqwest 在 body 被消费之前就把 `Set-Cookie` 存入 jar。
    /// 用真实响应验证这一点，而不是假定它成立。
    #[tokio::test]
    async fn the_jar_is_populated_before_the_json_body_is_read() {
        use std::io::{Read, Write};
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 1024];
            let _ = stream.read(&mut request);
            let body = br#"{"code":0,"data":{"code":0,"url":""}}"#;
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nSet-Cookie: SESSDATA=abc%2Cdef; Path=/\r\nSet-Cookie: bili_jct=csrf; Path=/\r\nContent-Length: 37\r\nConnection: close\r\n\r\n",
                )
                .unwrap();
            stream.write_all(body).unwrap();
        });

        let jar = Arc::new(Jar::default());
        let client = reqwest::Client::builder()
            .cookie_provider(Arc::clone(&jar))
            .build()
            .unwrap();
        let response = client
            .get(format!("http://{address}/poll"))
            .send()
            .await
            .unwrap();
        // 与 `poll` 完全一致地消费响应 body。
        let _ = response.text().await.unwrap();

        let url = Url::parse(&format!("http://{address}/")).unwrap();
        let stored = cookies_from_jar_at(&jar, &url);
        assert!(stored.contains("SESSDATA=abc%2Cdef"), "got: {stored}");
        assert!(stored.contains("bili_jct=csrf"), "got: {stored}");
        server.join().unwrap();
    }

    /// 按任意 origin 读取 jar；`cookies_from_jar` 被限定在 Bilibili 自有主机上，
    /// 而回环测试服务器无法使用那些主机。
    fn cookies_from_jar_at(jar: &Arc<Jar>, url: &Url) -> String {
        use reqwest::cookie::CookieStore;
        jar.cookies(url)
            .map(|header| header.to_str().unwrap_or_default().to_string())
            .unwrap_or_default()
    }

    #[test]
    fn only_bilibili_origins_are_read_from_the_jar() {
        // 由无关主机设置的 cookie 绝不能进入存储的 header。
        let jar = Arc::new(Jar::default());
        jar.add_cookie_str(
            "SESSDATA=evil; Path=/",
            &Url::parse("https://evil.test/").unwrap(),
        );
        assert!(cookies_from_jar(&jar).is_empty());
    }

    fn jar_with(cookies: &[&str]) -> Arc<Jar> {
        let jar = Arc::new(Jar::default());
        let url = Url::parse(PASSPORT_ORIGIN).unwrap();
        for cookie in cookies {
            jar.add_cookie_str(cookie, &url);
        }
        jar
    }

    #[test]
    fn poll_set_cookie_headers_alone_complete_the_login() {
        // 回归场景：Bilibili 确认了扫码，但返回的回调 URL 不带凭据，
        // 此时只有 `Set-Cookie` 携带会话信息。
        let jar = jar_with(&[
            "SESSDATA=abc%2Cdef%2Cghi; Domain=.bilibili.com; Path=/",
            "bili_jct=csrf; Domain=.bilibili.com; Path=/",
            "DedeUserID=42; Domain=.bilibili.com; Path=/",
        ]);

        let cookie = login_cookie(&jar, "https://www.bilibili.com/").unwrap();

        assert_eq!(
            cookie,
            "SESSDATA=abc%2Cdef%2Cghi; bili_jct=csrf; DedeUserID=42"
        );
    }

    #[test]
    fn callback_url_still_works_when_the_jar_is_empty() {
        let url = "https://passport.bilibili.com/account/api/login/sso?DedeUserID=42&SESSDATA=abc%2Cdef%2Cghi&bili_jct=csrf&gourl=https%3A%2F%2Fwww.bilibili.com";

        let cookie = login_cookie(&jar_with(&[]), url).unwrap();

        assert_eq!(
            cookie,
            "SESSDATA=abc%2Cdef%2Cghi; bili_jct=csrf; DedeUserID=42"
        );
    }

    #[test]
    fn jar_and_callback_fields_are_merged_with_the_jar_winning() {
        let jar = jar_with(&["SESSDATA=from-jar; Domain=.bilibili.com; Path=/"]);
        let url =
            "https://passport.bilibili.com/?SESSDATA=from-url&bili_jct=csrf&DedeUserID__ckMd5=md5";

        let cookie = login_cookie(&jar, url).unwrap();

        assert_eq!(
            cookie,
            "SESSDATA=from-jar; bili_jct=csrf; DedeUserID__ckMd5=md5"
        );
    }

    #[test]
    fn login_requires_sessdata_from_either_source() {
        let jar = jar_with(&["buvid3=tracking-only; Domain=.bilibili.com; Path=/"]);
        assert!(login_cookie(&jar, "https://passport.bilibili.com/?DedeUserID=42").is_none());
    }

    #[test]
    fn unknown_cookie_fields_are_not_stored() {
        let jar = jar_with(&[
            "SESSDATA=abc; Domain=.bilibili.com; Path=/",
            "unrelated=value; Domain=.bilibili.com; Path=/",
        ]);

        let cookie = login_cookie(&jar, "https://passport.bilibili.com/?other=value").unwrap();

        assert_eq!(cookie, "SESSDATA=abc");
    }

    #[test]
    fn jar_values_are_stored_without_re_encoding() {
        // reqwest 的 jar 不会解码 cookie 值，因此 `SESSDATA` 必须原样透传；
        // 再编码一次会得到 `%252C`。
        let jar = jar_with(&["SESSDATA=abc%2Cdef%2Cghi; Domain=.bilibili.com; Path=/"]);

        assert_eq!(
            login_cookie(&jar, "https://www.bilibili.com/").unwrap(),
            "SESSDATA=abc%2Cdef%2Cghi"
        );
    }

    #[test]
    fn cookie_values_that_could_inject_a_second_field_are_dropped() {
        assert!(is_safe_cookie_value("abc%2Cdef"));
        assert!(!is_safe_cookie_value(""));
        assert!(!is_safe_cookie_value("abc; DedeUserID=1"));
        assert!(!is_safe_cookie_value("abc\r\nSet-Cookie: x=y"));

        // 已经编码过的取值仍然可用。
        assert!(is_safe_cookie_value("a%20b"));

        // 被构造的回调 URL 不得把额外字段偷偷塞进存储的 header。
        let jar = jar_with(&["SESSDATA=abc; Domain=.bilibili.com; Path=/"]);
        let cookie = login_cookie(&jar, "https://passport.bilibili.com/?bili_jct=a b").unwrap();
        assert_eq!(cookie, "SESSDATA=abc");
    }

    #[test]
    fn only_bilibili_https_hosts_are_followed() {
        let trusted = Url::parse("https://passport.bilibili.com/x/").unwrap();
        assert!(is_trusted_url(&trusted, TRUSTED_SUFFIXES));
        assert!(can_follow_redirect(&trusted, 0, TRUSTED_SUFFIXES));
        assert!(!can_follow_redirect(&trusted, 8, TRUSTED_SUFFIXES));
        assert!(!is_trusted_url(
            &Url::parse("http://passport.bilibili.com/").unwrap(),
            TRUSTED_SUFFIXES
        ));
        assert!(!is_trusted_url(
            &Url::parse("https://bilibili.com.evil.test/").unwrap(),
            TRUSTED_SUFFIXES
        ));
    }
}
