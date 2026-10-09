//! 应用级代理路由：把设置里的「自动 / 关闭 / 自定义」解析成运行时表示。
//!
//! 所有出站路径共用这一份解析结果：reqwest 客户端、FFmpeg 录制、弹幕
//! WebSocket 的 CONNECT 隧道，以及前端经 Tauri 发出的 HTTP 请求。
//! 抖音官方登录 WebView 的自动模式仍由原生网络栈管理（可能支持 PAC），
//! 无法强制关闭的桌面平台拒绝该模式下开窗，避免静默使用系统代理。
//!
//! 「自动」的解析顺序是环境变量优先、操作系统设置兜底：
//! - 环境变量：`ALL_PROXY` / `HTTPS_PROXY` / `HTTP_PROXY` 与 `NO_PROXY`
//!   （大小写都认，与 curl 一致）；
//! - Windows：`Internet Settings` 里的 `ProxyEnable` / `ProxyServer` /
//!   `ProxyOverride`；
//! - macOS：`scutil --proxy` 的输出；
//! - 其他平台（含 Android）只看环境变量。
//!
//! 本项目的 TLS 栈没有启用 socks 支持，因此非 HTTP(S) 的代理取值会被忽略并
//! 记录一条告警，而不是让整条请求链在构建客户端时失败。

use std::net::IpAddr;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::models::settings::ProxyMode;

/// 系统代理的缓存时长。用户改完系统代理不必重启应用，但也不该每次请求都去读
/// 注册表或拉起 `scutil`。
const SYSTEM_PROXY_TTL: Duration = Duration::from_secs(5);

/// 传给 FFmpeg 的「确定直连」哨兵值。
///
/// 它不需要是 FFmpeg 认识的关键字：`http.c` 与 `tls.c` 只判断取值是否以
/// `http://` 开头。用一个非空、语义自明的取值是为了让 HLS 子分片也拿到它，
/// 从而连环境变量里的 `http_proxy` 一起被忽略。
///
/// 只有桌面录制链路会把它交给 FFmpeg；移动端没有录制，因此随桌面平台一同编译
/// （测试在任何平台都编译，两个方法也一并保留回归）。
#[cfg(any(desktop, test))]
pub const DIRECT_FFMPEG_PROXY: &str = "direct";

/// 从系统解析出的代理配置。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SystemProxy {
    pub http: Option<String>,
    pub https: Option<String>,
    /// 不经过代理的主机模式。
    pub bypass: Vec<String>,
}

impl SystemProxy {
    fn is_empty(&self) -> bool {
        self.http.is_none() && self.https.is_none()
    }
}

/// 一次出站请求实际要走的代理路由。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProxyRoute {
    /// 跟随系统；`None` 表示系统当前没有可用的 HTTP(S) 代理。
    System(Option<SystemProxy>),
    /// 始终直连：忽略环境变量、系统代理与自定义地址。
    Direct,
    /// 使用自定义代理地址。
    Custom(String),
}

impl ProxyRoute {
    /// 解析持久化的模式与地址。
    ///
    /// 「自定义」但没有地址时按直连处理：UI 会同时给出未配置的提示，
    /// 因此这里不需要凭空替用户选一条出口。
    pub fn resolve(mode: ProxyMode, custom: Option<&str>) -> Self {
        match mode {
            ProxyMode::Auto => Self::System(system_proxy()),
            ProxyMode::Off => Self::Direct,
            ProxyMode::Custom => match custom.map(str::trim).filter(|value| !value.is_empty()) {
                Some(url) => Self::Custom(url.to_owned()),
                None => Self::Direct,
            },
        }
    }

    /// 指定 scheme 要使用的上游代理地址。
    pub fn upstream(&self, scheme: &str) -> Option<&str> {
        match self {
            Self::Custom(url) => Some(url),
            Self::Direct => None,
            Self::System(system) => {
                let system = system.as_ref()?;
                match scheme {
                    "https" | "wss" => system.https.as_deref(),
                    "http" | "ws" => system.http.as_deref(),
                    _ => None,
                }
            }
        }
    }

    /// 面向 `host:port` 形式的 authority 解析上游代理地址。
    ///
    /// 弹幕 WebSocket 与媒体中继用这条路径：它们只知道目标 authority，
    /// 而「自动」需要先判断该主机是否命中绕过列表。
    pub fn upstream_for_authority(&self, authority: &str) -> Option<&str> {
        let host = authority_host(authority)?;
        let port = authority
            .rsplit_once(':')
            .and_then(|(_, port)| port.parse().ok());
        if self.bypasses_destination(host, port) {
            return None;
        }
        match self {
            Self::Custom(url) => Some(url),
            Self::Direct => None,
            // 隧道一律是 TLS，因此优先取 https 出口。
            Self::System(_) => self.upstream("https"),
        }
    }

    /// 目标主机是否命中系统代理的绕过列表。
    ///
    /// 自定义地址不参与绕过判断：用户填的就是唯一出口。
    #[cfg(test)]
    fn bypasses(&self, host: &str) -> bool {
        self.bypasses_destination(host, None)
    }

    fn bypasses_destination(&self, host: &str, port: Option<u16>) -> bool {
        let Self::System(Some(system)) = self else {
            return false;
        };
        system
            .bypass
            .iter()
            .any(|pattern| destination_matches_pattern(pattern, host, port))
    }

    pub fn upstream_for_url(&self, url: &reqwest::Url) -> Option<&str> {
        if self.bypasses_destination(url.host_str()?, url.port_or_known_default()) {
            None
        } else {
            self.upstream(url.scheme())
        }
    }

    /// FFmpeg 的确定直连选项。系统/自定义出口由已有 stream_proxy 逐请求转发，
    /// FFmpeg 只访问本机 URL，避免 libavformat 的 http_proxy/no_proxy 环境变量、
    /// 不支持 HTTPS 代理及 HLS 子分片继承首个 URL 代理选项的问题。
    ///
    /// 即使 System(None) 也必须返回非空哨兵，不能把未支持的环境代理交回 FFmpeg。
    /// 只有桌面录制链路消费它，移动端没有录制。
    #[cfg(any(desktop, test))]
    pub fn ffmpeg_proxy(&self) -> &'static str {
        DIRECT_FFMPEG_PROXY
    }

    /// 该出口是否需要录制网络转发。只有桌面录制链路使用；没有代理出口时 FFmpeg
    /// 直连源站，由已有 stream_proxy 逐请求转发有出口的情况不适用。
    #[cfg(any(desktop, test))]
    pub fn needs_recording_relay(&self) -> bool {
        matches!(self, Self::Custom(_) | Self::System(Some(_)))
    }

    /// 供 UI 展示的当前出口描述，已抹掉账号密码。
    pub fn describe(&self) -> String {
        match self {
            Self::Direct => "直连（不使用代理）".to_owned(),
            Self::Custom(url) => format!("自定义代理 {}", mask_proxy_url(url)),
            Self::System(None) => {
                if cfg!(any(windows, target_os = "macos")) {
                    "直连（未检测到受支持的静态代理；PAC 暂不支持）".to_owned()
                } else {
                    "直连（未检测到 HTTP(S) 代理环境变量；不读取系统设置或 PAC）".to_owned()
                }
            }
            Self::System(Some(system)) => {
                let endpoint = |value: &Option<String>| {
                    value
                        .as_deref()
                        .map(mask_proxy_url)
                        .unwrap_or_else(|| "直连".to_owned())
                };
                format!(
                    "自动代理 · HTTP：{} · HTTPS：{}",
                    endpoint(&system.http),
                    endpoint(&system.https)
                )
            }
        }
    }
}

/// 读取当前系统代理（带短暂缓存）。
pub fn system_proxy() -> Option<SystemProxy> {
    static CACHE: Mutex<Option<(Instant, Option<SystemProxy>)>> = Mutex::new(None);

    let mut cache = CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some((read_at, value)) = cache.as_ref()
        && read_at.elapsed() < SYSTEM_PROXY_TTL
    {
        return value.clone();
    }
    let value = detect_system_proxy().filter(|proxy| !proxy.is_empty());
    *cache = Some((Instant::now(), value.clone()));
    value
}

fn detect_system_proxy() -> Option<SystemProxy> {
    // 环境变量优先：显式设置了环境变量的进程应当覆盖图形界面里的系统设置，
    // 这与 curl / reqwest 的取值顺序一致。
    if let Some(from_env) = proxy_from_env() {
        return Some(from_env);
    }
    #[cfg(windows)]
    if let Some(proxy) = windows_proxy() {
        return Some(proxy);
    }
    #[cfg(target_os = "macos")]
    if let Some(proxy) = macos_proxy() {
        return Some(proxy);
    }
    None
}

fn env_first(names: &[&str]) -> Option<String> {
    names.iter().find_map(|name| {
        std::env::var(name)
            .ok()
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
    })
}

fn proxy_from_env() -> Option<SystemProxy> {
    let all = env_first(&["all_proxy", "ALL_PROXY"]);
    let http = env_first(&["http_proxy", "HTTP_PROXY"]).or_else(|| all.clone());
    let https = env_first(&["https_proxy", "HTTPS_PROXY"]).or(all);
    let bypass = env_first(&["no_proxy", "NO_PROXY"])
        .map(|value| split_bypass(&value))
        .unwrap_or_default();
    if http.is_none() && https.is_none() {
        return None;
    }
    let proxy = SystemProxy {
        http: http.as_deref().and_then(normalize_proxy_url),
        https: https.as_deref().and_then(normalize_proxy_url),
        bypass,
    };
    Some(proxy)
}

/// 把系统给出的取值规范成 `http(s)://host:port`；无法用于 HTTP 隧道的取值
/// （socks 等）返回 `None`。
fn normalize_proxy_url(raw: &str) -> Option<String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    let candidate = if raw.contains("://") {
        raw.to_owned()
    } else {
        format!("http://{raw}")
    };
    let url = reqwest::Url::parse(&candidate).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        tracing::warn!(
            scheme = url.scheme(),
            "系统代理协议不受支持，已按直连处理（仅支持 HTTP/HTTPS 代理）"
        );
        return None;
    }
    Some(url.to_string())
}

/// 切分绕过列表。Windows 用 `;`，环境变量用 `,`，手工输入常见空格分隔。
fn split_bypass(value: &str) -> Vec<String> {
    value
        .split([';', ',', ' '])
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(str::to_owned)
        .collect()
}

/// 从 `host:port` / `[v6]:port` 形式的 authority 里取出主机名。
fn authority_host(authority: &str) -> Option<&str> {
    let authority = authority.trim();
    if authority.is_empty() {
        return None;
    }
    if let Some(rest) = authority.strip_prefix('[') {
        let (host, _) = rest.split_once(']')?;
        return (!host.is_empty()).then_some(host);
    }
    let host = authority.split(':').next()?;
    (!host.is_empty()).then_some(host)
}

/// 共用绕过规则：域名及子域、Windows 通配符和 <local>、IP/CIDR、可选端口。
/// 不解析目标域名为 IP，CIDR 仅匹配 URL 中的 IP 字面量，避免额外 DNS 请求。
fn destination_matches_pattern(pattern: &str, host: &str, port: Option<u16>) -> bool {
    let pattern = pattern.trim();
    let (pattern, required_port) = if let Some(rest) = pattern.strip_prefix('[') {
        match rest.split_once(']') {
            Some((host, suffix)) => (
                host,
                suffix.strip_prefix(':').and_then(|p| p.parse::<u16>().ok()),
            ),
            None => (pattern, None),
        }
    } else if pattern.matches(':').count() == 1 {
        match pattern
            .rsplit_once(':')
            .and_then(|(host, p)| p.parse::<u16>().ok().map(|p| (host, p)))
        {
            Some((host, port)) => (host, Some(port)),
            None => (pattern, None),
        }
    } else {
        (pattern, None)
    };
    if required_port.is_some() && required_port != port {
        return false;
    }
    host_matches_pattern(pattern, host)
}

fn host_matches_pattern(pattern: &str, host: &str) -> bool {
    let host = host
        .trim_matches(['[', ']'])
        .trim_end_matches('.')
        .to_ascii_lowercase();
    let pattern = pattern.trim().trim_end_matches('.').to_ascii_lowercase();
    if pattern.is_empty() {
        return false;
    }
    if pattern == "*" {
        return true;
    }
    if pattern == "<local>" {
        return !host.contains('.') && !host.contains(':');
    }
    if let Some((network, bits)) = pattern.split_once('/') {
        let bits = bits.parse::<u32>().ok();
        return match (network.parse::<IpAddr>(), host.parse::<IpAddr>(), bits) {
            (Ok(IpAddr::V4(network)), Ok(IpAddr::V4(host)), Some(bits @ 0..=32)) => {
                let mask = u32::MAX.checked_shl(32 - bits).unwrap_or(0);
                u32::from(network) & mask == u32::from(host) & mask
            }
            (Ok(IpAddr::V6(network)), Ok(IpAddr::V6(host)), Some(bits @ 0..=128)) => {
                let mask = u128::MAX.checked_shl(128 - bits).unwrap_or(0);
                u128::from(network) & mask == u128::from(host) & mask
            }
            _ => false,
        };
    }
    if let Ok(ip) = pattern.parse::<IpAddr>() {
        return host.parse::<IpAddr>() == Ok(ip);
    }
    let domain = pattern
        .strip_prefix("*.")
        .unwrap_or(&pattern)
        .trim_start_matches('.');
    if !domain.contains('*') {
        return host == domain
            || host
                .strip_suffix(domain)
                .is_some_and(|prefix| prefix.ends_with('.'));
    }
    // Windows 常见规则 127.* / 10.* / intranet*；线性贪心匹配，不引入正则回溯。
    let (pattern, host) = (pattern.as_bytes(), host.as_bytes());
    let (mut p, mut h, mut star, mut retry) = (0, 0, None, 0);
    while h < host.len() {
        if p < pattern.len() && pattern[p] == host[h] {
            p += 1;
            h += 1;
        } else if p < pattern.len() && pattern[p] == b'*' {
            star = Some(p);
            p += 1;
            retry = h;
        } else if let Some(position) = star {
            retry += 1;
            h = retry;
            p = position + 1;
        } else {
            return false;
        }
    }
    while p < pattern.len() && pattern[p] == b'*' {
        p += 1;
    }
    p == pattern.len()
}

/// 抹掉代理地址里的账号密码，供日志与 UI 使用。
pub fn mask_proxy_url(url: &str) -> String {
    let Ok(mut parsed) = reqwest::Url::parse(url) else {
        return url.to_owned();
    };
    if parsed.username().is_empty() && parsed.password().is_none() {
        return url.to_owned();
    }
    let _ = parsed.set_username("");
    let _ = parsed.set_password(None);
    parsed.to_string()
}

#[cfg(windows)]
fn windows_proxy() -> Option<SystemProxy> {
    let settings = windows_registry::CURRENT_USER
        .open("Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings")
        .ok()?;
    if settings.get_u32("ProxyEnable").unwrap_or(0) == 0 {
        return None;
    }
    let server = settings.get_string("ProxyServer").ok()?;
    let (http, https) = parse_windows_proxy_server(&server);
    let bypass = settings
        .get_string("ProxyOverride")
        .map(|value| split_bypass(&value))
        .unwrap_or_default();
    Some(SystemProxy {
        http,
        https,
        bypass,
    })
}

/// Windows 的 `ProxyServer` 有两种写法：`host:port` 或
/// `http=host:port;https=host:port`。socks 取值会被丢弃（本项目不支持）。
#[cfg_attr(not(windows), allow(dead_code))]
fn parse_windows_proxy_server(server: &str) -> (Option<String>, Option<String>) {
    let server = server.trim();
    if server.is_empty() {
        return (None, None);
    }
    if !server.contains('=') {
        let url = normalize_proxy_url(server);
        return (url.clone(), url);
    }
    let mut http = None;
    let mut https = None;
    for entry in server.split(';') {
        let Some((scheme, value)) = entry.split_once('=') else {
            continue;
        };
        let value = normalize_proxy_url(value);
        match scheme.trim().to_ascii_lowercase().as_str() {
            "http" => http = value,
            "https" => https = value,
            _ => {}
        }
    }
    (http, https)
}

#[cfg(target_os = "macos")]
fn macos_proxy() -> Option<SystemProxy> {
    // 用 `scutil --proxy` 而不是 system-configuration：输出格式稳定且可以直接
    // 单元测试，避免为一条只读路径引入无法在 Linux/Windows 上编译验证的 FFI 依赖。
    let output = std::process::Command::new("scutil")
        .arg("--proxy")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    parse_scutil_proxy(&String::from_utf8_lossy(&output.stdout))
}

/// 解析 `scutil --proxy` 的输出。`ExceptionsList` 是一个嵌套数组块。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn parse_scutil_proxy(text: &str) -> Option<SystemProxy> {
    let mut values: Vec<(String, String)> = Vec::new();
    let mut exceptions: Vec<String> = Vec::new();
    let mut in_exceptions = false;

    for line in text.lines() {
        let line = line.trim();
        // 例外列表是嵌套数组：它的闭合 `}` 必须在下面那条「忽略孤立 `}`」之前
        // 处理，否则后面的 `HTTPEnable` 等取值会被当成例外条目吃掉。
        if in_exceptions {
            if line.starts_with('}') {
                in_exceptions = false;
                continue;
            }
            // 形如 `0 : *.local`
            if let Some((_, value)) = line.split_once(':') {
                let value = value.trim();
                if !value.is_empty() {
                    exceptions.push(value.to_owned());
                }
            }
            continue;
        }
        if line.is_empty() || line == "}" || line == "<dictionary> {" {
            continue;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let key = key.trim().to_owned();
        let value = value.trim();
        if value.starts_with("<array>") {
            in_exceptions = key == "ExceptionsList";
            continue;
        }
        if value.starts_with('<') {
            continue;
        }
        values.push((key, value.to_owned()));
    }

    let lookup = |key: &str| {
        values
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.as_str())
    };
    let enabled = |key: &str| lookup(key) == Some("1");
    let endpoint = |enable: &str, host: &str, port: &str| {
        if !enabled(enable) {
            return None;
        }
        let host = lookup(host)?.trim();
        if host.is_empty() {
            return None;
        }
        let port = lookup(port).and_then(|value| value.trim().parse::<u16>().ok());
        normalize_proxy_url(&match port {
            Some(port) => format!("{host}:{port}"),
            None => host.to_owned(),
        })
    };

    if enabled("ExcludeSimpleHostnames") {
        exceptions.push("<local>".into());
    }
    let proxy = SystemProxy {
        http: endpoint("HTTPEnable", "HTTPProxy", "HTTPPort"),
        https: endpoint("HTTPSEnable", "HTTPSProxy", "HTTPSPort"),
        bypass: exceptions,
    };
    (!proxy.is_empty()).then_some(proxy)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn custom_mode_uses_the_configured_address() {
        let route = ProxyRoute::resolve(ProxyMode::Custom, Some(" http://127.0.0.1:7890 "));
        assert_eq!(route, ProxyRoute::Custom("http://127.0.0.1:7890".into()));
        assert_eq!(route.upstream("https"), Some("http://127.0.0.1:7890"));
        assert_eq!(
            route.upstream_for_url(&reqwest::Url::parse("https://example.test/live.m3u8").unwrap()),
            Some("http://127.0.0.1:7890")
        );
        assert!(!route.bypasses("example.test"));
    }

    #[test]
    fn custom_mode_without_an_address_falls_back_to_direct() {
        assert_eq!(
            ProxyRoute::resolve(ProxyMode::Custom, None),
            ProxyRoute::Direct
        );
        assert_eq!(
            ProxyRoute::resolve(ProxyMode::Custom, Some("   ")),
            ProxyRoute::Direct
        );
    }

    #[test]
    fn off_mode_is_direct_for_every_scheme_and_ignores_bypass() {
        let route = ProxyRoute::resolve(ProxyMode::Off, Some("http://127.0.0.1:7890"));
        assert_eq!(route.upstream("http"), None);
        assert_eq!(route.upstream("https"), None);
        // `direct` 哨兵值必须传给 FFmpeg：空字符串不会复制给 HLS 子分片，
        // 子分片会重新读取 http_proxy 环境变量。
        assert_eq!(route.ffmpeg_proxy(), "direct");
        assert!(!route.bypasses("example.test"));
    }

    #[test]
    fn system_bypass_applies_to_recording_relay_requests() {
        // 录制网络转发与普通 HTTP 请求共用绕过判断。
        let route = ProxyRoute::System(Some(SystemProxy {
            http: Some("http://127.0.0.1:1111".into()),
            https: None,
            bypass: vec!["*.lan.test".into()],
        }));
        assert_eq!(
            route.upstream_for_url(&reqwest::Url::parse("http://box.lan.test/a.flv").unwrap()),
            None
        );
    }

    #[test]
    fn missing_scheme_stays_direct_and_extended_bypass_rules_are_shared() {
        let route = ProxyRoute::System(Some(SystemProxy {
            http: Some("http://127.0.0.1:7890".into()),
            https: None,
            bypass: vec![
                "127.*".into(),
                "10.0.0.0/8".into(),
                "[2001:db8::1]:443".into(),
                "printer:80".into(),
                "<local>".into(),
            ],
        }));
        assert_eq!(route.upstream("https"), None);
        assert_eq!(route.upstream_for_authority("example.test:443"), None);
        for (host, expected) in [
            ("127.0.0.2", true),
            ("10.42.1.1", true),
            ("11.1.1.1", false),
            ("printer", true),
            ("example.test", false),
        ] {
            assert_eq!(route.bypasses(host), expected, "{host}");
        }
        assert!(destination_matches_pattern(
            "example.test:443",
            "example.test",
            Some(443)
        ));
        assert!(!destination_matches_pattern(
            "example.test:443",
            "example.test",
            Some(80)
        ));
        assert!(destination_matches_pattern(
            "[2001:db8::1]:443",
            "[2001:db8::1]",
            Some(443)
        ));
        assert!(host_matches_pattern("2001:db8::/32", "2001:db8:1::1"));
        assert!(!host_matches_pattern("2001:db8::/32", "2001:db9::1"));
        assert!(host_matches_pattern("0.0.0.0/0", "8.8.8.8"));
        assert!(!host_matches_pattern("::/129", "::1"));
        assert!(!host_matches_pattern("例子.test", "example.test"));
        assert!(!host_matches_pattern("<local>", "::1"));
    }

    #[test]
    fn unavailable_system_proxy_status_does_not_claim_no_configuration() {
        let status = ProxyRoute::System(None).describe();
        assert!(!status.contains("未配置"));
        assert!(status.contains("PAC"));
        if !cfg!(any(windows, target_os = "macos")) {
            assert!(status.contains("环境变量"));
        }
    }

    #[test]
    fn system_route_prefers_the_scheme_specific_proxy() {
        let route = ProxyRoute::System(Some(SystemProxy {
            http: Some("http://127.0.0.1:1111".into()),
            https: Some("http://127.0.0.1:2222".into()),
            bypass: vec!["lan.test".into(), "*.corp.test".into()],
        }));
        assert_eq!(route.upstream("http"), Some("http://127.0.0.1:1111"));
        assert_eq!(route.upstream("https"), Some("http://127.0.0.1:2222"));
        assert_eq!(
            route.upstream_for_url(&reqwest::Url::parse("http://cdn.test/live.flv").unwrap()),
            Some("http://127.0.0.1:1111")
        );
        assert_eq!(
            route.upstream_for_url(&reqwest::Url::parse("https://cdn.test/live.m3u8").unwrap()),
            Some("http://127.0.0.1:2222")
        );
        // 命中绕过列表的主机不选择任何上游代理。
        assert_eq!(
            route.upstream_for_url(&reqwest::Url::parse("http://box.lan.test/a.flv").unwrap()),
            None
        );
        assert_eq!(
            route.upstream_for_url(&reqwest::Url::parse("https://a.corp.test/a.m3u8").unwrap()),
            None
        );
        assert!(route.bypasses("lan.test"));
        assert!(route.bypasses("box.lan.test"));
        assert!(!route.bypasses("notlan.test"));
    }

    #[test]
    fn ffmpeg_always_uses_explicit_direct_and_proxied_sources_use_the_relay() {
        for route in [
            ProxyRoute::Direct,
            ProxyRoute::System(None),
            ProxyRoute::Custom("https://proxy.test".into()),
        ] {
            assert_eq!(route.ffmpeg_proxy(), DIRECT_FFMPEG_PROXY);
        }
        assert!(ProxyRoute::Custom("https://proxy.test".into()).needs_recording_relay());
        assert!(!ProxyRoute::System(None).needs_recording_relay());
        assert!(!ProxyRoute::Direct.needs_recording_relay());
    }

    #[test]
    fn resolves_an_upstream_for_a_target_authority() {
        let route = ProxyRoute::System(Some(SystemProxy {
            http: Some("http://127.0.0.1:1111".into()),
            https: Some("http://127.0.0.1:2222".into()),
            bypass: vec!["*.lan.test".into()],
        }));
        assert_eq!(
            route.upstream_for_authority("live.example.test:443"),
            Some("http://127.0.0.1:2222")
        );
        // 绕过列表命中时弹幕隧道必须直连。
        assert_eq!(route.upstream_for_authority("box.lan.test:443"), None);
        // IPv6 字面量不能把地址里的冒号当端口分隔符。
        assert_eq!(
            route.upstream_for_authority("[2001:db8::1]:443"),
            Some("http://127.0.0.1:2222")
        );
        assert_eq!(
            ProxyRoute::Direct.upstream_for_authority("a.test:443"),
            None
        );
        assert_eq!(
            ProxyRoute::Custom("http://127.0.0.1:7890".into()).upstream_for_authority("a.test:443"),
            Some("http://127.0.0.1:7890")
        );
        assert_eq!(authority_host("a.test:443"), Some("a.test"));
        assert_eq!(authority_host("a.test"), Some("a.test"));
        assert_eq!(authority_host("  "), None);
    }

    #[test]
    fn bypass_matching_mirrors_curl_and_libavformat() {
        for (pattern, host, expected) in [
            ("*", "anything.test", true),
            ("example.test", "example.test", true),
            ("example.test", "a.example.test", true),
            (".example.test", "a.example.test", true),
            ("*.example.test", "a.example.test", true),
            ("example.test", "notexample.test", false),
            ("example.test", "example.test.evil", false),
            ("<local>", "localhost", true),
            ("<local>", "printer", true),
            ("<local>", "example.test", false),
            ("", "example.test", false),
        ] {
            assert_eq!(
                host_matches_pattern(pattern, host),
                expected,
                "pattern={pattern} host={host}"
            );
        }
    }

    #[test]
    fn splits_bypass_lists_from_every_supported_separator() {
        assert_eq!(
            split_bypass("localhost;127.*;*.local, 10.0.0.0/8"),
            vec!["localhost", "127.*", "*.local", "10.0.0.0/8"]
        );
        assert!(split_bypass("  ;;  ").is_empty());
    }

    #[test]
    fn normalizes_system_values_and_rejects_unusable_schemes() {
        assert_eq!(
            normalize_proxy_url("127.0.0.1:7890"),
            Some("http://127.0.0.1:7890/".into())
        );
        assert_eq!(
            normalize_proxy_url("http://127.0.0.1:7890"),
            Some("http://127.0.0.1:7890/".into())
        );
        // 没有启用 socks 支持，socks 取值必须被忽略而不是让客户端构建失败。
        assert_eq!(normalize_proxy_url("socks5://127.0.0.1:1080"), None);
        assert_eq!(normalize_proxy_url("   "), None);
    }

    #[test]
    fn parses_both_windows_proxy_server_forms() {
        assert_eq!(
            parse_windows_proxy_server("127.0.0.1:7890"),
            (
                Some("http://127.0.0.1:7890/".into()),
                Some("http://127.0.0.1:7890/".into())
            )
        );
        assert_eq!(
            parse_windows_proxy_server("http=127.0.0.1:1111;https=127.0.0.1:2222"),
            (
                Some("http://127.0.0.1:1111/".into()),
                Some("http://127.0.0.1:2222/".into())
            )
        );
        // socks 条目被丢弃，HTTP(S) 条目照常保留。
        assert_eq!(
            parse_windows_proxy_server("socks=127.0.0.1:1080;http=127.0.0.1:7890"),
            (Some("http://127.0.0.1:7890/".into()), None)
        );
        assert_eq!(parse_windows_proxy_server(""), (None, None));
    }

    #[test]
    fn parses_scutil_proxy_output_with_exceptions() {
        let output = r#"<dictionary> {
  ExceptionsList : <array> {
    0 : *.local
    1 : 169.254/16
  }
  FTPPassive : 1
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7891
  HTTPSProxy : 127.0.0.1
  SOCKSEnable : 0
  ProxyAutoConfigEnable : 0
}
"#;
        let proxy = parse_scutil_proxy(output).unwrap();
        assert_eq!(proxy.http.as_deref(), Some("http://127.0.0.1:7890/"));
        assert_eq!(proxy.https.as_deref(), Some("http://127.0.0.1:7891/"));
        assert_eq!(proxy.bypass, vec!["*.local", "169.254/16"]);
    }

    #[test]
    fn scutil_output_without_an_enabled_proxy_yields_nothing() {
        let output = "<dictionary> {\n  HTTPEnable : 0\n  ProxyAutoConfigEnable : 0\n}\n";
        assert!(parse_scutil_proxy(output).is_none());
    }

    #[test]
    fn masks_credentials_in_displayed_and_logged_addresses() {
        assert_eq!(
            mask_proxy_url("http://viewer:secret@127.0.0.1:7890"),
            "http://127.0.0.1:7890/"
        );
        assert_eq!(
            mask_proxy_url("http://127.0.0.1:7890"),
            "http://127.0.0.1:7890"
        );
        assert_eq!(
            ProxyRoute::Custom("http://viewer:secret@127.0.0.1:7890".into()).describe(),
            "自定义代理 http://127.0.0.1:7890/"
        );
    }
}
