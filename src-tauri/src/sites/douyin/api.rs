//! 直播与公开作品共用的抖音 Web 请求、签名查询与匿名会话层。
//!
//! 统一限制 Cookie 的发送域和响应更新；进程缓存只保留首页响应贡献的
//! 匿名会话值，已保存的账号 Cookie 不进入缓存。查询先编码再签名，
//! 确保签名覆盖的字符串与实际发送的内容一致。

use std::sync::Mutex;
use std::time::{Duration, Instant};

use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};
use reqwest::Url;
use reqwest::header::{COOKIE, HeaderMap, REFERER, SET_COOKIE, USER_AGENT};
use serde_json::Value;

use super::{DouyinSite, a_bogus, json_i64_opt, json_str};
use crate::error::{AppError, AppResult};

/// 抖音 Web 直播接口使用的浏览器 UA。保持稳定很重要：
/// 部分边缘节点把 `ttwid` 绑定到浏览器家族上。
pub const DEFAULT_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

pub(super) const LIVE_ROOT: &str = "https://live.douyin.com/";
/// Web 客户端在列表请求中发送的 `msToken` 长度。
const MS_TOKEN_LENGTH: usize = 107;
const MS_TOKEN_CHARSET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
/// 匿名直播首页引导 cookie 在进程内保持有效的时长。`ttwid` 本身的寿命长得多；
/// 这个 TTL 只是限制陈旧程度。
const WEB_SESSION_CACHE_TTL: Duration = Duration::from_secs(30 * 60);

/// 进程级缓存直播首页下发的匿名引导 cookie（`ttwid` 等）。站点实例按 IPC 命令
/// 创建，没有这份缓存时，每个列表请求都要重新下载约 1 MB 的首页，
/// 只为重启同一个匿名会话。只缓存首页响应贡献的 cookie，
/// 已保存的账号 Cookie 绝不进入缓存。
struct CachedWebSession {
    cookie_pairs: Vec<(String, String)>,
    expires_at: Instant,
}

static WEB_SESSION_CACHE: Mutex<Option<CachedWebSession>> = Mutex::new(None);

fn cached_web_session_pairs() -> Option<Vec<(String, String)>> {
    let cache = WEB_SESSION_CACHE.lock().ok()?;
    let session = cache.as_ref()?;
    if Instant::now() >= session.expires_at {
        return None;
    }
    Some(session.cookie_pairs.clone())
}

fn store_web_session_pairs(pairs: &[(String, String)]) {
    if pairs.is_empty() {
        return;
    }
    if let Ok(mut cache) = WEB_SESSION_CACHE.lock() {
        *cache = Some(CachedWebSession {
            cookie_pairs: pairs.to_vec(),
            expires_at: Instant::now() + WEB_SESSION_CACHE_TTL,
        });
    }
}

impl DouyinSite {
    pub(super) fn cookie(&self) -> AppResult<String> {
        self.cookie
            .lock()
            .map(|cookie| cookie.clone())
            .map_err(|_| {
                AppError::new("douyin_lock", "Douyin session mutex poisoned").with_site("douyin")
            })
    }

    fn has_cookie(&self, key: &str) -> AppResult<bool> {
        Ok(cookie_pairs(&self.cookie()?)
            .iter()
            .any(|(candidate, value)| candidate.eq_ignore_ascii_case(key) && !value.is_empty()))
    }

    fn web_session_is_initialized(&self) -> AppResult<bool> {
        self.web_session_initialized
            .lock()
            .map(|state| *state)
            .map_err(|_| {
                AppError::new("douyin_lock", "Douyin session mutex poisoned").with_site("douyin")
            })
    }

    fn mark_web_session_initialized(&self) -> AppResult<()> {
        let mut state = self.web_session_initialized.lock().map_err(|_| {
            AppError::new("douyin_lock", "Douyin session mutex poisoned").with_site("douyin")
        })?;
        *state = true;
        Ok(())
    }

    fn remember_response_cookies(&self, headers: &HeaderMap) -> AppResult<()> {
        let mut received = Vec::new();
        for header in headers.get_all(SET_COOKIE) {
            let Ok(header) = header.to_str() else {
                continue;
            };
            let first = header.split(';').next().unwrap_or_default().trim();
            if first.contains('=') {
                received.push(first.to_string());
            }
        }
        // 直播首页目前返回短时效的 `x-ms-token` 头，而不是（或除了）
        // `msToken` Set-Cookie。把它放进同一份内存会话，
        // 因为房间接口接受它作为 `msToken` query 参数。
        // 不接受分隔符/控制字节：
        // 该值稍后会被放入本地会话的 Cookie 头中。
        if let Some(ms_token) = headers
            .get_all("x-ms-token")
            .iter()
            .filter_map(|header| header.to_str().ok())
            .map(str::trim)
            .find(|value| is_safe_session_value(value))
        {
            received.push(format!("msToken={ms_token}"));
        }
        if received.is_empty() {
            return Ok(());
        }

        let mut cookie = self.cookie.lock().map_err(|_| {
            AppError::new("douyin_lock", "Douyin session mutex poisoned").with_site("douyin")
        })?;
        *cookie = merge_cookie_values(&cookie, &received.join("; "));
        Ok(())
    }

    pub(super) async fn get_text(
        &self,
        url: &str,
        params: &[(String, String)],
        referer: &str,
        accept_json: bool,
    ) -> AppResult<String> {
        let cookie = self.cookie()?;
        let mut request = self
            .client
            .get(url)
            .header(USER_AGENT, DEFAULT_USER_AGENT)
            .header(REFERER, referer)
            .header("accept-language", "zh-CN,zh;q=0.9,en;q=0.8")
            .header(
                "accept",
                if accept_json {
                    "application/json, text/plain, */*"
                } else {
                    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
                },
            );
        // 手动保存的 `.douyin.com` Cookie 绝不能被重放到其他可注册域，
        // 例如 `webcast.amemv.com`。
        let sends_douyin_cookie = is_douyin_cookie_url(url);
        if sends_douyin_cookie && !cookie.is_empty() {
            request = request.header(COOKIE, cookie);
        }
        for (key, value) in params {
            request = request.query(&[(key.as_str(), value.as_str())]);
        }

        let response = request
            .send()
            .await
            // `reqwest::Error` 可能包含完整的请求 URL，包括 msToken 等 query 参数。
            // 不要把这些细节带入面向用户的错误信息和 tracing 输出。
            .map_err(|_| Self::err("HTTP request failed"))?;
        let status = response.status();
        let headers = response.headers().clone();
        let text = response
            .text()
            .await
            .map_err(|_| Self::err("HTTP response body failed"))?;
        if sends_douyin_cookie {
            self.remember_response_cookies(&headers)?;
        }

        if !status.is_success() {
            // 响应 body 可能由边缘节点生成，并可能反映请求取值。
            // 这里用状态码做诊断已经足够安全。
            return Err(Self::err(format!("HTTP {status}")));
        }
        if text.trim() == "blocked" {
            return Err(Self::err("请求被抖音风控拦截，请稍后重试或更新 Cookie"));
        }
        Ok(text)
    }

    pub(super) async fn get_json(
        &self,
        url: &str,
        params: &[(String, String)],
        referer: &str,
    ) -> AppResult<Value> {
        let text = self.get_text(url, params, referer, true).await?;
        if text.trim().is_empty() {
            return Err(Self::err("抖音接口返回为空，可能触发访问验证"));
        }
        let value: Value = serde_json::from_str(&text)
            .map_err(|error| Self::parse_err(format!("JSON 响应解析失败: {error}")))?;
        self.ensure_api_success(&value)?;
        Ok(value)
    }

    fn ensure_api_success(&self, value: &Value) -> AppResult<()> {
        let Some(code) = value.get("status_code").and_then(json_i64_opt) else {
            return Ok(());
        };
        if code == 0 {
            return Ok(());
        }
        if code == 2483 {
            return Err(Self::login_required());
        }
        let message = json_str(
            value
                .get("status_msg")
                .or_else(|| value.get("message"))
                .unwrap_or(&Value::Null),
        );
        if code == 101 || code == 444 || message.contains("验证") {
            return Err(AppError::new(
                "douyin_browser_verification",
                "抖音当前要求网页访问验证，应用无法自动完成；请稍后重试或在官方网页观看",
            )
            .with_site("douyin")
            .retryable());
        }
        // 不要展示任意服务器文本：部分网关会回显 query 参数，
        // 可能泄露短时效的 msToken。
        Err(Self::err(format!("抖音接口错误 code={code}")))
    }

    /// 抓取一次直播首页以获得匿名 `ttwid` cookie。此前引导的进程级缓存仍然新鲜时
    /// 可直接短路这次访问；已保存的账号 Cookie 取值始终优先于缓存值。
    pub(super) async fn ensure_web_session(&self) -> AppResult<()> {
        if self.web_session_is_initialized()? {
            return Ok(());
        }
        if let Some(cached) = cached_web_session_pairs() {
            let mut cookie = self.cookie.lock().map_err(|_| {
                AppError::new("douyin_lock", "Douyin session mutex poisoned").with_site("douyin")
            })?;
            // 缓存值补齐缺口；已经持有的取值（保存的登录身份、更早的响应 cookie）
            // 保持优先。
            *cookie = merge_cookie_values(
                &cached
                    .iter()
                    .map(|(k, v)| format!("{k}={v}"))
                    .collect::<Vec<_>>()
                    .join("; "),
                &cookie,
            );
            drop(cookie);
            self.mark_web_session_initialized()?;
            return Ok(());
        }
        let before = self.cookie()?;
        let _ = self.get_text(LIVE_ROOT, &[], LIVE_ROOT, false).await?;
        if self.has_cookie("ttwid")? {
            let gained = changed_cookie_pairs(&before, &self.cookie()?);
            store_web_session_pairs(&gained);
            self.mark_web_session_initialized()?;
            Ok(())
        } else {
            Err(Self::err(
                "未能从抖音直播页获取 ttwid，会话初始化失败，请稍后重试",
            ))
        }
    }

    pub(super) async fn get_ssr_page(&self, path: &str) -> AppResult<String> {
        self.ensure_web_session().await?;
        let url = format!("https://live.douyin.com/{path}");
        self.get_text(&url, &[], LIVE_ROOT, false).await
    }

    /// GET 一个经浏览器签名的抖音 Web API。
    ///
    /// `a_bogus` 覆盖的是实际发送的那条 query 字符串，因此参数在这里编码一次，
    /// 并把签名追加到同一条字符串上，
    /// 而不是作为单独的键值对交给 `reqwest`。
    pub(super) async fn get_signed_json(
        &self,
        url: &str,
        params: &[(String, String)],
        referer: &str,
    ) -> AppResult<Value> {
        let query = encode_query(params);
        let signature = a_bogus::generate_a_bogus(&query, DEFAULT_USER_AGENT);
        let signed = format!("{url}?{query}&a_bogus={}", url_encode(&signature));
        // `get_json` 不会追加任何内容：URL 已携带签名后的 query，
        // 在这里再加参数会使签名失效。
        self.get_json(&signed, &[], referer).await
    }
}

pub(super) fn normalize_cookie(value: &str) -> String {
    merge_cookie_values(
        "",
        value.trim().strip_prefix("Cookie:").unwrap_or(value).trim(),
    )
}

/// 保存的账号 cookie 的作用域限定为抖音自有 Web 主机。保持这条边界显式可见，
/// 因为房间回源 API 托管在 amemv.com 上。
fn is_douyin_cookie_url(value: &str) -> bool {
    Url::parse(value)
        .ok()
        .and_then(|url| url.host_str().map(str::to_ascii_lowercase))
        .is_some_and(|host| host == "douyin.com" || host.ends_with(".douyin.com"))
}

pub(super) fn cookie_pairs(value: &str) -> Vec<(String, String)> {
    value
        .split(';')
        .filter_map(|part| {
            let (key, value) = part.trim().split_once('=')?;
            let key = key.trim();
            if key.is_empty() {
                None
            } else {
                Some((key.to_string(), value.trim().to_string()))
            }
        })
        .collect()
}

/// 本次首页引导相对于访问前的 cookie 新增或刷新了哪些键值对。只有这些匿名
/// 会话取值会进入进程级共享缓存；
/// 已保存的账号取值绝不进入。
fn changed_cookie_pairs(before: &str, after: &str) -> Vec<(String, String)> {
    let previous = cookie_pairs(before);
    cookie_pairs(after)
        .into_iter()
        .filter(|(key, value)| {
            !previous
                .iter()
                .any(|(old_key, old_value)| old_key.eq_ignore_ascii_case(key) && old_value == value)
        })
        .collect()
}

fn merge_cookie_values(base: &str, updates: &str) -> String {
    let mut merged = cookie_pairs(base);
    for (key, value) in cookie_pairs(updates) {
        if let Some((_, previous)) = merged
            .iter_mut()
            .find(|(previous_key, _)| previous_key.eq_ignore_ascii_case(&key))
        {
            *previous = value;
        } else {
            merged.push((key, value));
        }
    }
    merged
        .into_iter()
        .map(|(key, value)| format!("{key}={value}"))
        .collect::<Vec<_>>()
        .join("; ")
}

fn is_safe_session_value(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 4_096
        && !value
            .bytes()
            .any(|byte| byte == b';' || byte.is_ascii_control())
}

/// 对一个 query 组成部分做百分号编码，只保留 unreserved 集合。
///
/// `a_bogus` 签的是字面 query 字符串，因此被签名的取值与实际发送的取值
/// 必须采用完全相同的编码。放在这里可以让两侧共用同一个实现。
fn url_encode(value: &str) -> String {
    utf8_percent_encode(value, UNRESERVED).collect()
}

/// 与原手写实现逐字节等价的 unreserved 集合：字母数字与 `-._~` 之外
/// 一律 `%XX`（大写十六进制）。
const UNRESERVED: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'~');

fn encode_query(params: &[(String, String)]) -> String {
    params
        .iter()
        .map(|(key, value)| format!("{}={}", url_encode(key), url_encode(value)))
        .collect::<Vec<_>>()
        .join("&")
}

/// 构造 Web 客户端在列表调用中发送的一次性 `msToken`。
///
/// 上游取值是不透明的浏览器 token。接口只检查其形态，
/// 因此每个请求生成一条预期长度的随机字符串即可；
/// 它被刻意设计为不持久化、也不作为标识符复用。
pub(super) fn generate_ms_token() -> String {
    // uuid v4 已经是 CSPRNG 支持的来源，而且本来就是依赖，
    // 不必为了填充一次性 token 再引入 `rand`。
    let mut token = String::with_capacity(MS_TOKEN_LENGTH);
    while token.len() < MS_TOKEN_LENGTH {
        for byte in uuid::Uuid::new_v4().as_bytes() {
            if token.len() == MS_TOKEN_LENGTH {
                break;
            }
            let index = usize::from(*byte) % MS_TOKEN_CHARSET.len();
            token.push(char::from(MS_TOKEN_CHARSET[index]));
        }
    }
    token
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpListener;

    use super::*;
    use crate::http_client;
    use crate::sites::traits::LiveSite;

    #[test]
    fn merges_response_cookies_without_losing_saved_cookie() {
        let merged = merge_cookie_values(
            "sessionid=old; ttwid=old",
            "ttwid=new; msToken=token; Path=/; HttpOnly",
        );
        assert!(merged.contains("sessionid=old"));
        assert!(merged.contains("ttwid=new"));
        assert!(merged.contains("msToken=token"));
    }

    #[test]
    fn empty_ttwid_does_not_count_as_an_initialized_web_session() {
        let site = DouyinSite::new(
            http_client::default_client(),
            "sessionid=fixture-session; ttwid=; msToken=fixture-ms-token".into(),
        );

        assert!(!site.has_cookie("ttwid").unwrap());
        assert!(!site.web_session_is_initialized().unwrap());
    }

    #[test]
    fn saved_cookie_still_requires_a_live_home_bootstrap() {
        let saved = DouyinSite::new(http_client::default_client(), "sessionid=fixture".into());

        assert!(!saved.web_session_is_initialized().unwrap());
    }

    #[test]
    fn api_error_does_not_echo_untrusted_status_message() {
        let site = DouyinSite::default();
        let error = site
            .ensure_api_success(&serde_json::json!({
                "status_code": 101,
                "status_msg": "fixture-ms-token-must-not-be-exposed"
            }))
            .unwrap_err();

        assert_eq!(error.code, "douyin_browser_verification");
        assert!(error.message.contains("网页访问验证"));
        assert!(!error.message.contains("fixture-ms-token"));
    }

    #[test]
    fn danmaku_session_cookie_keeps_transient_web_session_in_memory() {
        let site = DouyinSite::new(http_client::default_client(), "sessionid=saved".into());
        let mut headers = HeaderMap::new();
        headers.append(
            SET_COOKIE,
            "ttwid=transient; Path=/; HttpOnly".parse().unwrap(),
        );
        headers.append(SET_COOKIE, "msToken=ephemeral; Path=/".parse().unwrap());
        site.remember_response_cookies(&headers).unwrap();

        let cookie = site.danmaku_session_cookie().unwrap().unwrap();
        assert!(cookie.contains("sessionid=saved"));
        assert!(cookie.contains("ttwid=transient"));
        assert!(cookie.contains("msToken=ephemeral"));
    }

    #[test]
    fn response_ms_token_header_updates_only_the_in_memory_session() {
        let site = DouyinSite::new(
            http_client::default_client(),
            "sessionid=saved; msToken=stale-token".into(),
        );
        let mut headers = HeaderMap::new();
        headers.insert("x-ms-token", "fresh-token".parse().unwrap());
        site.remember_response_cookies(&headers).unwrap();

        assert!(site.cookie().unwrap().contains("msToken=fresh-token"));
        assert!(site.cookie().unwrap().contains("sessionid=saved"));
    }

    #[test]
    fn sends_cookies_only_to_douyin_owned_web_hosts() {
        assert!(is_douyin_cookie_url("https://live.douyin.com/123"));
        assert!(is_douyin_cookie_url("https://www.douyin.com/"));
        assert!(!is_douyin_cookie_url(
            "https://webcast.amemv.com/webcast/room/reflow/info/"
        ));
        assert!(!is_douyin_cookie_url("https://douyin.com.example.test/"));
    }

    #[tokio::test]
    async fn cross_domain_room_request_does_not_replay_saved_cookie() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 2048];
            let length = stream.read(&mut request).unwrap();
            let request = String::from_utf8_lossy(&request[..length]).to_ascii_lowercase();
            assert!(!request.contains("cookie:"));
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
                )
                .unwrap();
        });

        let site = DouyinSite::new(
            reqwest::Client::builder().no_proxy().build().unwrap(),
            "sessionid=fixture-session; msToken=fixture-token".into(),
        );
        let body = site
            .get_text(
                &format!("http://{address}/webcast/room/reflow/info/"),
                &[],
                LIVE_ROOT,
                true,
            )
            .await
            .unwrap();

        assert_eq!(body, "{}");
        server.join().unwrap();
    }

    /// 引导缓存只能保存首页响应贡献的匿名取值；
    /// 已保存的账号 cookie 绝不进入。
    #[test]
    fn changed_cookie_pairs_reports_only_new_or_refreshed_values() {
        let before = "sessionid=secret; ttwid=old";
        let after = "sessionid=secret; ttwid=fresh; UIFID_TEMP=abc";

        let gained = changed_cookie_pairs(before, after);

        let pairs = gained
            .iter()
            .map(|(key, value)| (key.as_str(), value.as_str()))
            .collect::<Vec<_>>();
        assert_eq!(pairs, vec![("ttwid", "fresh"), ("UIFID_TEMP", "abc")]);
    }

    /// 两个行为共用一个测试，因为它们依赖同一个进程级会话缓存；
    /// 并行测试会互相覆盖。
    #[tokio::test]
    async fn cached_web_session_seeds_instances_and_yields_to_saved_login() {
        store_web_session_pairs(&[
            ("ttwid".into(), "cached".into()),
            ("UIFID_TEMP".into(), "fill".into()),
        ]);

        // 匿名实例：缓存的键值对直接播种出可用会话，
        // 无需访问直播首页。
        let anonymous = DouyinSite::new(
            reqwest::Client::builder().no_proxy().build().unwrap(),
            String::new(),
        );
        anonymous.ensure_web_session().await.unwrap();
        assert_eq!(anonymous.cookie().unwrap(), "ttwid=cached; UIFID_TEMP=fill");
        assert!(anonymous.web_session_is_initialized().unwrap());

        // 已登录实例：缓存值补齐缺口，
        // 但已保存的身份始终优先于其缓存对应值。
        let saved = DouyinSite::new(
            reqwest::Client::builder().no_proxy().build().unwrap(),
            "sessionid=secret; ttwid=saved".into(),
        );
        saved.ensure_web_session().await.unwrap();

        let cookie = saved.cookie().unwrap();
        assert!(cookie.contains("sessionid=secret"));
        assert!(cookie.contains("ttwid=saved"));
        assert!(cookie.contains("UIFID_TEMP=fill"));
    }

    #[test]
    fn ms_token_has_the_expected_shape_and_is_not_reused() {
        let token = generate_ms_token();

        assert_eq!(token.len(), MS_TOKEN_LENGTH);
        assert!(token.bytes().all(|byte| MS_TOKEN_CHARSET.contains(&byte)));
        assert_ne!(token, generate_ms_token());
    }

    /// 签名覆盖的是字面 query 字符串，因此编码必须在签名之前完成，
    /// 且 HTTP 客户端绝不能再编码第二次。
    #[test]
    fn query_encoding_escapes_values_once() {
        let query = encode_query(&[
            ("partition".into(), "1010032".into()),
            ("keyword".into(), "a b&c=d".into()),
        ]);

        assert_eq!(query, "partition=1010032&keyword=a%20b%26c%3Dd");
    }

    /// 等价性锚点：编码只保留 unreserved 集合，十六进制为大写。
    #[test]
    fn url_encode_keeps_unreserved_and_uppercase_hex() {
        assert_eq!(url_encode("aZ09-_.~"), "aZ09-_.~");
        assert_eq!(url_encode("a b+c/dé"), "a%20b%2Bc%2Fd%C3%A9");
        assert_eq!(url_encode("中文"), "%E4%B8%AD%E6%96%87");
    }
}
