//! 四个平台扫码登录共用的会话存储、网络客户端与响应解析原语。
//!
//! 每个平台的协议各不相同（B 站是带数字状态码的轮询、斗鱼是 JSONP 完成回调、
//! 虎牙是 UDB SDK 分阶段、抖音是 SSO 重定向），因此这里**只**收敛真正逐字节
//! 重复的部分：会话表、客户端构建、可信主机判定与文本字段提取。协议本身留在
//! 各自模块里。
//!
//! 错误码沿用 `<site>_qr_<suffix>` 的既有拼法，由 `QrSite::error` 生成，
//! 与合并前逐字节一致。

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use reqwest::cookie::Jar;
use reqwest::{Client, Url};
use serde_json::Value;

use crate::error::{AppError, AppResult};

const SESSION_TTL: Duration = Duration::from_secs(5 * 60);
/// 每个平台各自的上限。四个平台各持一份 `QrSessionStore`，
/// 因此这里是「每平台 16 路」，与合并前的四份独立 static 语义相同。
const MAX_ACTIVE_SESSIONS: usize = 16;
const MAX_REDIRECTS: usize = 8;

/// 客户端渲染登录二维码所需的数据。
pub struct QrLoginStart {
    /// 二维码内容或二维码图片地址，由各平台决定语义。
    pub qr_code_url: String,
    /// 不透明的进程内句柄，绝不是上游平台真正的 key/token。
    pub qr_key: String,
}

/// 一次轮询结果。Cookie 内容只在 Rust 进程内返回，
/// 以便命令层直接把它持久化到本地 SQLite 账号存储。
pub enum QrLoginPoll {
    Pending,
    Scanned,
    Expired,
    Success { cookie: String },
}

/// 站点标识与其用户可见名称。名称用于拼接错误文案；
/// B 站的历史文案不含站名，因此它的 `display` 为空串。
#[derive(Clone, Copy)]
pub struct QrSite {
    /// 错误码前缀与 `AppError::with_site` 的取值，如 `bilibili`。
    pub id: &'static str,
    /// 错误文案里的中文站名，如 `斗鱼`。B 站为空串（其原文案不带站名）。
    pub display: &'static str,
}

impl QrSite {
    /// 生成 `<id>_qr_<suffix>` 错误码，并附带站点与可重试标记。
    ///
    /// `retryable` 交由调用方决定：会话过期与凭据无效在合并前**不带**
    /// 可重试标记，其余大多带。
    pub fn error(self, suffix: &str, message: impl Into<String>) -> AppError {
        AppError::new(format!("{}_qr_{suffix}", self.id), message).with_site(self.id)
    }

    /// 与 `error` 相同但附加 `retryable()`。
    pub fn retryable_error(self, suffix: &str, message: impl Into<String>) -> AppError {
        self.error(suffix, message).retryable()
    }

    /// `无法连接{站名}二维码登录服务，请检查网络后重试`。
    ///
    /// 传入完整错误码而非后缀：调用点用的是 `bilibili_qr_generate`
    /// 这类已存在的码，而不是统一的新码。
    pub fn network_error(self, code: &str) -> AppError {
        AppError::new(
            code,
            format!(
                "无法连接{}二维码登录服务，请检查网络后重试",
                self.display
            ),
        )
        .with_site(self.id)
        .retryable()
    }

    /// `{站名}二维码登录服务未返回有效数据`。
    pub fn invalid_response(self, code: &str) -> AppError {
        AppError::new(
            code,
            format!("{}二维码登录服务未返回有效数据", self.display),
        )
        .with_site(self.id)
        .retryable()
    }
}

/// 一个平台的活跃扫码会话表。
///
/// `P` 是该平台需要随会话保存的载荷（上游 key/token、client、cookie jar）。
/// 每个平台声明自己的 `static`，因此 `MAX_ACTIVE_SESSIONS` 是每平台独立的，
/// 平台之间不会互相驱逐会话。
pub struct QrSessionStore<P: Clone + Send + 'static> {
    site: QrSite,
    cell: OnceLock<Mutex<HashMap<String, (P, Instant)>>>,
}

impl<P: Clone + Send + 'static> QrSessionStore<P> {
    pub const fn new(site: QrSite) -> Self {
        Self {
            site,
            cell: OnceLock::new(),
        }
    }

    fn map(&self) -> &Mutex<HashMap<String, (P, Instant)>> {
        self.cell.get_or_init(|| Mutex::new(HashMap::new()))
    }

    /// 存入新会话。超过上限时驱逐最旧的一路，并顺带清掉已过期的。
    pub fn insert(&self, key: String, payload: P) -> AppResult<()> {
        let mut sessions = self
            .map()
            .lock()
            .map_err(|_| self.site.error("session", "二维码登录会话初始化失败，请重试"))?;
        Self::prune(&mut sessions);
        if sessions.len() >= MAX_ACTIVE_SESSIONS
            && let Some(oldest_key) = sessions
                .iter()
                .min_by_key(|(_, (_, created_at))| *created_at)
                .map(|(key, _)| key.clone())
        {
            sessions.remove(&oldest_key);
        }
        sessions.insert(key, (payload, Instant::now()));
        Ok(())
    }

    pub fn get(&self, key: &str) -> AppResult<P> {
        let mut sessions = self
            .map()
            .lock()
            .map_err(|_| self.site.error("session", "二维码登录会话读取失败，请重试"))?;
        Self::prune(&mut sessions);
        sessions
            .get(key)
            .map(|(payload, _)| payload.clone())
            .ok_or_else(|| {
                self.site
                    .error("expired", "二维码登录会话已过期，请刷新二维码后重试")
            })
    }

    pub fn remove(&self, key: &str) -> AppResult<()> {
        let mut sessions = self
            .map()
            .lock()
            .map_err(|_| self.site.error("session", "二维码登录会话清理失败，请重试"))?;
        sessions.remove(key);
        Ok(())
    }

    fn prune(sessions: &mut HashMap<String, (P, Instant)>) {
        let now = Instant::now();
        sessions.retain(|_, (_, created_at)| now.duration_since(*created_at) < SESSION_TTL);
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.map().lock().map(|sessions| sessions.len()).unwrap_or(0)
    }
}

/// 会话句柄必须是本地生成的 uuid simple 形式，而不是上游的 key。
pub fn is_valid_session_key(value: &str) -> bool {
    value.len() == 32 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// 只信任指定站点自有的 HTTPS 主机，且不接受 URL 内嵌凭据。
///
/// `suffixes` 逐项按「完全相等或以 `.suffix` 结尾」匹配，
/// 虎牙需要同时信任 `huya.com` 与 `yy.com`。
pub fn is_trusted_url(url: &Url, suffixes: &[&str]) -> bool {
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
    suffixes
        .iter()
        .any(|suffix| host == *suffix || host.ends_with(&format!(".{suffix}")))
}

/// 重定向是否可跟随：跳数未超上限，且目标仍是站点自有的可信主机。
///
/// 导出它而不是只在 `build_login_client` 的闭包里内联，是为了让各站点的测试
/// 断言与生产路径共用同一个表达式；否则测试只能镜像一份 `< 8`，
/// 上限一改就会静默失配。
pub fn can_follow_redirect(url: &Url, prior_redirects: usize, suffixes: &[&str]) -> bool {
    prior_redirects < MAX_REDIRECTS && is_trusted_url(url, suffixes)
}

/// 构建扫码登录专用的 HTTP 客户端。
///
/// 登录完成过程只允许在站点自有的 HTTPS 主机之间跳转，这样服务端返回的 URL
/// 就无法把该客户端变成指向任意目标的已认证请求。
///
/// - `compression`：仅 B 站开启 gzip/brotli，保持与合并前一致。
/// - `proxy`：仅抖音传入应用显式代理；`None` 时 `with_proxy` 是空操作，
///   `no_proxy()` 依然生效，因此其余站点行为不变。
pub fn build_login_client(
    site: QrSite,
    jar: Arc<Jar>,
    trusted_suffixes: &'static [&'static str],
    compression: bool,
    proxy: Option<&str>,
) -> AppResult<Client> {
    let mut builder = Client::builder()
        .use_native_tls()
        .cookie_provider(jar)
        // 扫码认证携带的是临时登录会话。不要让它走进程级 HTTP(S) 代理
        // 或应用的浏览代理。
        .no_proxy()
        .timeout(Duration::from_secs(20))
        .connect_timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::custom(move |attempt| {
            if can_follow_redirect(attempt.url(), attempt.previous().len(), trusted_suffixes) {
                attempt.follow()
            } else {
                attempt.stop()
            }
        }));
    if compression {
        builder = builder.gzip(true).brotli(true);
    }
    crate::http_client::with_proxy(builder, proxy)?
        .build()
        .map_err(|_| site.error("client", "二维码登录网络客户端初始化失败"))
}

/// 按候选键顺序取第一个可用的短文本字段。
///
/// 拒绝空串、超长值与含 CR/LF 的值：这些字段会进入 URL 或 Cookie，
/// 换行会让构造出的响应注入额外字段。
pub fn optional_text(data: &Value, keys: &[&str], max_len: usize) -> Option<String> {
    keys.iter().find_map(|key| {
        let value = data.get(*key)?.as_str()?.trim();
        (!value.is_empty() && value.len() <= max_len && !value.contains(['\r', '\n']))
            .then(|| value.to_string())
    })
}

/// 宽容读取整数：接受 JSON number（i64/u64）与十进制字符串。
pub fn value_as_i64(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_u64().and_then(|value| i64::try_from(value).ok()))
        .or_else(|| value.as_str()?.trim().parse::<i64>().ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    const BILIBILI: QrSite = QrSite {
        id: "bilibili",
        display: "",
    };
    const DOUYU: QrSite = QrSite {
        id: "douyu",
        display: "斗鱼",
    };

    #[derive(Clone, Debug, PartialEq)]
    struct Payload(&'static str);

    static BILIBILI_SESSIONS: QrSessionStore<Payload> = QrSessionStore::new(BILIBILI);
    static DOUYU_SESSIONS: QrSessionStore<Payload> = QrSessionStore::new(DOUYU);

    /// 等价性锚点：错误码与文案必须与四份手写实现逐字节一致。
    #[test]
    fn error_codes_keep_the_per_site_spelling() {
        let error = DOUYU.error("session", "二维码登录会话初始化失败，请重试");
        assert_eq!(error.code, "douyu_qr_session");
        assert_eq!(error.site.as_deref(), Some("douyu"));
        assert!(!error.retryable);

        let expired = BILIBILI.error("expired", "二维码登录会话已过期，请刷新二维码后重试");
        assert_eq!(expired.code, "bilibili_qr_expired");

        // 网络与无效响应文案带站名；B 站历史文案不带，因此 display 为空串。
        assert_eq!(
            DOUYU.network_error("douyu_qr_generate").message,
            "无法连接斗鱼二维码登录服务，请检查网络后重试"
        );
        assert_eq!(
            BILIBILI.network_error("bilibili_qr_generate").message,
            "无法连接二维码登录服务，请检查网络后重试"
        );
        assert_eq!(
            DOUYU.invalid_response("douyu_qr_poll").message,
            "斗鱼二维码登录服务未返回有效数据"
        );
        assert!(DOUYU.network_error("douyu_qr_poll").retryable);
    }

    /// 上限是每平台独立的：塞满一个平台不影响另一个。
    /// 合并前四份 static 就是这个语义，共用一张表会让平台互相驱逐。
    #[test]
    fn session_caps_are_per_site() {
        for index in 0..MAX_ACTIVE_SESSIONS + 4 {
            BILIBILI_SESSIONS
                .insert(format!("{index:032}"), Payload("bilibili"))
                .unwrap();
        }
        DOUYU_SESSIONS
            .insert("d".repeat(32), Payload("douyu"))
            .unwrap();

        assert_eq!(BILIBILI_SESSIONS.len(), MAX_ACTIVE_SESSIONS);
        assert_eq!(DOUYU_SESSIONS.len(), 1);
        assert_eq!(
            DOUYU_SESSIONS.get(&"d".repeat(32)).unwrap(),
            Payload("douyu")
        );

        DOUYU_SESSIONS.remove(&"d".repeat(32)).unwrap();
        assert_eq!(
            DOUYU_SESSIONS.get(&"d".repeat(32)).unwrap_err().code,
            "douyu_qr_expired"
        );
    }

    #[test]
    fn session_handles_must_be_opaque_uuid_hex() {
        assert!(is_valid_session_key("0123456789abcdef0123456789abcdef"));
        assert!(!is_valid_session_key("short"));
        assert!(!is_valid_session_key("0123456789abcdef0123456789abcdeZ"));
    }

    #[test]
    fn only_https_site_hosts_without_credentials_are_trusted() {
        let bilibili = ["bilibili.com"];
        assert!(is_trusted_url(
            &Url::parse("https://passport.bilibili.com/x").unwrap(),
            &bilibili
        ));
        assert!(is_trusted_url(
            &Url::parse("https://bilibili.com/").unwrap(),
            &bilibili
        ));
        // 后缀必须在点边界上匹配，`evil-bilibili.com` 不是子域。
        assert!(!is_trusted_url(
            &Url::parse("https://evil-bilibili.com/").unwrap(),
            &bilibili
        ));
        assert!(!is_trusted_url(
            &Url::parse("http://passport.bilibili.com/").unwrap(),
            &bilibili
        ));
        assert!(!is_trusted_url(
            &Url::parse("https://user:pass@passport.bilibili.com/").unwrap(),
            &bilibili
        ));
        assert!(!is_trusted_url(
            &Url::parse("https://passport.bilibili.com:8443/").unwrap(),
            &bilibili
        ));

        // 虎牙同时信任两个后缀。
        let huya = ["huya.com", "yy.com"];
        assert!(is_trusted_url(
            &Url::parse("https://udblgn.huya.com/").unwrap(),
            &huya
        ));
        assert!(is_trusted_url(
            &Url::parse("https://lgn.yy.com/").unwrap(),
            &huya
        ));
        assert!(!is_trusted_url(
            &Url::parse("https://example.com/").unwrap(),
            &huya
        ));
    }

    #[test]
    fn redirects_stop_at_the_hop_limit_and_outside_trusted_hosts() {
        let bilibili = ["bilibili.com"];
        let trusted = Url::parse("https://passport.bilibili.com/x/").unwrap();
        let untrusted = Url::parse("https://example.test/").unwrap();

        assert!(can_follow_redirect(&trusted, 0, &bilibili));
        assert!(can_follow_redirect(
            &trusted,
            MAX_REDIRECTS - 1,
            &bilibili
        ));
        assert!(!can_follow_redirect(&trusted, MAX_REDIRECTS, &bilibili));
        assert!(!can_follow_redirect(&untrusted, 0, &bilibili));
    }

    #[test]
    fn text_fields_reject_blank_oversized_and_newline_values() {
        let data = serde_json::json!({
            "url": "https://example.com/qr",
            "blank": "   ",
            "newline": "https://example.com/\r\nSet-Cookie: x=1",
            "second": "fallback",
        });
        assert_eq!(
            optional_text(&data, &["url"], 64).as_deref(),
            Some("https://example.com/qr")
        );
        // 按候选键顺序回退。
        assert_eq!(
            optional_text(&data, &["missing", "second"], 64).as_deref(),
            Some("fallback")
        );
        assert_eq!(optional_text(&data, &["blank"], 64), None);
        assert_eq!(optional_text(&data, &["newline"], 4096), None);
        assert_eq!(optional_text(&data, &["url"], 4), None);
        assert_eq!(optional_text(&data, &["absent"], 64), None);
    }

    #[test]
    fn integers_are_read_from_numbers_and_strings() {
        assert_eq!(value_as_i64(&serde_json::json!(-2)), Some(-2));
        assert_eq!(value_as_i64(&serde_json::json!(86_101)), Some(86_101));
        assert_eq!(value_as_i64(&serde_json::json!(" 1 ")), Some(1));
        assert_eq!(value_as_i64(&serde_json::json!("abc")), None);
        assert_eq!(value_as_i64(&serde_json::json!(null)), None);
        // u64 超出 i64 上限时不静默截断。
        assert_eq!(value_as_i64(&serde_json::json!(u64::MAX)), None);
    }
}
