//! Douyin live site client.
//!
//! Douyin's public list APIs are protected by a browser challenge.  The live
//! site itself still server-renders the same category / hot-room payloads, so
//! this implementation uses those SSR payloads for browse pages and the
//! official room endpoints for details and streams.  A `ttwid` session is
//! obtained from the live home page when the caller has not supplied one.

use std::collections::HashMap;
use std::sync::Mutex;

use reqwest::header::{COOKIE, HeaderMap, REFERER, SET_COOKIE, USER_AGENT};
use reqwest::{Client, Url};
use serde_json::Value;

use crate::error::{AppError, AppResult};
use crate::http_client;
use crate::models::live::{
    LiveCategory, LivePlayQuality, LiveRoomDetail, LiveRoomItem, LiveSubCategory, PlayUrl,
    RoomListPage, SiteId, parse_live_started_at,
};
use crate::sites::traits::LiveSite;

/// Browser UA used by Douyin's web live endpoints.  Keeping this stable is
/// important: `ttwid` is bound to the browser family by some edge nodes.
pub const DEFAULT_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

const LIVE_ROOT: &str = "https://live.douyin.com/";
const ROOM_REFLOW_URL: &str = "https://webcast.amemv.com/webcast/room/reflow/info/";
const LIVE_SEARCH_URL: &str = "https://www.douyin.com/aweme/v1/web/live/search/";

/// A Douyin site instance owns only transient, read-only request state.  The
/// initial cookie comes from the account store; response cookies such as
/// `ttwid` and `msToken` stay in memory and are never written back to disk.
pub struct DouyinSite {
    client: Client,
    cookie: Mutex<String>,
    /// Each site instance starts by visiting the public live home once, even
    /// when a saved Cookie already contains `ttwid`. This refreshes the
    /// transient browser session for the requests made by that instance.
    web_session_initialized: Mutex<bool>,
}

impl Default for DouyinSite {
    fn default() -> Self {
        Self::new(http_client::default_client(), String::new())
    }
}

impl DouyinSite {
    pub fn new(client: Client, cookie: String) -> Self {
        let cookie = normalize_cookie(&cookie);
        Self {
            client,
            cookie: Mutex::new(cookie),
            web_session_initialized: Mutex::new(false),
        }
    }

    fn err(message: impl Into<String>) -> AppError {
        AppError::new("douyin_api_error", message)
            .with_site("douyin")
            .retryable()
    }

    fn parse_err(message: impl Into<String>) -> AppError {
        AppError::new("douyin_parse_error", message).with_site("douyin")
    }

    fn login_required() -> AppError {
        AppError::new(
            "douyin_login_required",
            "抖音直播搜索需要登录，请在账号管理中配置完整的抖音 Cookie",
        )
        .with_site("douyin")
    }

    fn cookie(&self) -> AppResult<String> {
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
        // The live home currently returns a short-lived `x-ms-token` header
        // instead of (or in addition to) an `msToken` Set-Cookie. Keep it in
        // the same in-memory session because room endpoints accept it as the
        // `msToken` query parameter. Do not accept delimiters/control bytes:
        // this value is later placed in a Cookie header for the local session.
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

    async fn get_text(
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
        // A manually saved `.douyin.com` Cookie must never be replayed to a
        // different registrable domain such as `webcast.amemv.com`.
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
            // `reqwest::Error` can include the complete request URL, including
            // query parameters such as msToken. Keep that detail out of the
            // user-facing error and tracing output.
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
            // Response bodies may be edge-generated and can reflect request
            // values. Status is sufficient for a safe diagnostic here.
            return Err(Self::err(format!("HTTP {status}")));
        }
        if text.trim() == "blocked" {
            return Err(Self::err("请求被抖音风控拦截，请稍后重试或更新 Cookie"));
        }
        Ok(text)
    }

    async fn get_json(
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
        // Do not surface arbitrary server text: some gateways reflect query
        // parameters, which could disclose a short-lived msToken.
        Err(Self::err(format!("抖音接口错误 code={code}")))
    }

    /// Fetches the live home once to obtain the anonymous `ttwid` cookie.
    async fn ensure_web_session(&self) -> AppResult<()> {
        if self.web_session_is_initialized()? {
            return Ok(());
        }
        let _ = self.get_text(LIVE_ROOT, &[], LIVE_ROOT, false).await?;
        if self.has_cookie("ttwid")? {
            self.mark_web_session_initialized()?;
            Ok(())
        } else {
            Err(Self::err(
                "未能从抖音直播页获取 ttwid，会话初始化失败，请稍后重试",
            ))
        }
    }

    async fn get_ssr_page(&self, path: &str) -> AppResult<String> {
        self.ensure_web_session().await?;
        let url = format!("https://live.douyin.com/{path}");
        self.get_text(&url, &[], LIVE_ROOT, false).await
    }

    async fn get_reflow_room(&self, room_id: &str) -> AppResult<Value> {
        // This official reflow endpoint works with the public room id and is
        // intentionally requested without the `.douyin.com` Cookie/session.
        let params = vec![
            ("type_id".into(), "0".into()),
            ("live_id".into(), "1".into()),
            ("room_id".into(), room_id.to_string()),
            ("sec_user_id".into(), String::new()),
            ("version_code".into(), "99.99.99".into()),
            ("app_id".into(), "6383".into()),
        ];
        self.get_json(ROOM_REFLOW_URL, &params, LIVE_ROOT).await
    }

    async fn get_reflow_room_detail(&self, room_id: &str) -> AppResult<LiveRoomDetail> {
        let root = self.get_reflow_room(room_id).await?;
        let detail = parse_reflow_room_detail(&root, room_id)?;
        if detail.status && !has_playable_stream(&detail) {
            return Err(Self::err(
                "抖音房间未返回可播放数据，会话可能已失效，请刷新后重试",
            ));
        }
        Ok(detail)
    }

    async fn get_room_detail_from_html(&self, web_rid: &str) -> AppResult<LiveRoomDetail> {
        self.ensure_web_session().await?;
        let html = self
            .get_text(
                &format!("https://live.douyin.com/{web_rid}"),
                &[],
                LIVE_ROOT,
                false,
            )
            .await?;
        parse_room_detail_html(&html, web_rid)
    }

    /// Avoid the browser-signed web-enter endpoint for a public web room id.
    /// The SSR page supplies the internal room id, and the official reflow
    /// endpoint can provide stream metadata without replaying login Cookies.
    async fn get_ssr_room_detail_or_reflow(&self, web_rid: &str) -> AppResult<LiveRoomDetail> {
        let ssr_detail = self.get_room_detail_from_html(web_rid).await?;
        if !ssr_detail.status || has_playable_stream(&ssr_detail) {
            return Ok(ssr_detail);
        }

        // A live SSR payload without a stream cannot be played. Preserve the
        // reflow failure instead of returning unusable metadata and later
        // masking a useful diagnostic (for example browser verification) as
        // a generic "no stream" error.
        let internal_room_id = reflow_room_id(&ssr_detail)?;
        self.get_reflow_room_detail(&internal_room_id).await
    }
}

#[async_trait::async_trait]
impl LiveSite for DouyinSite {
    fn danmaku_session_cookie(&self) -> AppResult<Option<String>> {
        let cookie = self.cookie()?;
        Ok((!cookie.is_empty()).then_some(cookie))
    }

    async fn get_categories(&self) -> AppResult<Vec<LiveCategory>> {
        self.ensure_web_session().await?;
        let html = self.get_text(LIVE_ROOT, &[], LIVE_ROOT, false).await?;
        parse_categories_html(&html)
    }

    async fn get_recommend_rooms(&self, page: u32) -> AppResult<RoomListPage> {
        // The public SSR payload exposes only its first page. The subsequent
        // cursor API is browser-signed and cannot be safely reproduced from a
        // saved Cookie, so never advertise a non-functional next page.
        if page.max(1) > 1 {
            return Ok(RoomListPage {
                has_more: false,
                items: Vec::new(),
            });
        }
        let html = self.get_ssr_page("hot_live").await?;
        parse_ssr_rooms(&html)
    }

    async fn get_category_rooms(
        &self,
        category: &LiveSubCategory,
        page: u32,
    ) -> AppResult<RoomListPage> {
        if page.max(1) > 1 {
            return Ok(RoomListPage {
                has_more: false,
                items: Vec::new(),
            });
        }
        let mut id_parts = category.id.split(',');
        let partition_id = id_parts.next().unwrap_or_default().trim();
        let partition_id = numeric_id(partition_id, "分类 ID")?;
        let partition_type = id_parts.next().unwrap_or_default().trim();
        let path = if partition_type.is_empty() {
            format!("category/{partition_id}")
        } else {
            let partition_type = numeric_id(partition_type, "分类类型")?;
            format!("categorynew/{partition_type}_{partition_id}")
        };
        let html = self.get_ssr_page(&path).await?;
        parse_ssr_rooms(&html)
    }

    async fn search_rooms(&self, keyword: &str, page: u32) -> AppResult<RoomListPage> {
        let keyword = keyword.trim();
        if keyword.is_empty() {
            return Ok(RoomListPage {
                has_more: false,
                items: Vec::new(),
            });
        }
        self.ensure_web_session().await?;
        let page = page.max(1);
        let params = vec![
            ("device_platform".into(), "webapp".into()),
            ("aid".into(), "6383".into()),
            ("channel".into(), "channel_pc_web".into()),
            ("search_channel".into(), "aweme_live".into()),
            ("keyword".into(), keyword.to_string()),
            ("search_source".into(), "switch_tab".into()),
            ("query_correct_type".into(), "1".into()),
            ("is_filter_search".into(), "0".into()),
            ("offset".into(), ((page - 1) * 10).to_string()),
            ("count".into(), "10".into()),
            ("pc_client_type".into(), "1".into()),
            ("version_code".into(), "170400".into()),
            ("version_name".into(), "17.4.0".into()),
            ("cookie_enabled".into(), "true".into()),
            ("screen_width".into(), "1980".into()),
            ("screen_height".into(), "1080".into()),
            ("browser_language".into(), "zh-CN".into()),
            ("browser_platform".into(), "Win32".into()),
            ("browser_name".into(), "Edge".into()),
            ("browser_version".into(), "125.0.0.0".into()),
            ("browser_online".into(), "true".into()),
            ("engine_name".into(), "Blink".into()),
            ("engine_version".into(), "125.0.0.0".into()),
            ("os_name".into(), "Windows".into()),
            ("os_version".into(), "10".into()),
            ("platform".into(), "PC".into()),
        ];
        let result = self
            .get_json(
                LIVE_SEARCH_URL,
                &params,
                &format!("https://www.douyin.com/search/{keyword}?type=live"),
            )
            .await?;
        parse_search_rooms(&result)
    }

    async fn get_room_detail(&self, room_id: &str) -> AppResult<LiveRoomDetail> {
        let room_id = normalize_room_id(room_id)?;
        if room_id.len() <= 16 {
            self.get_ssr_room_detail_or_reflow(&room_id).await
        } else {
            self.get_reflow_room_detail(&room_id).await
        }
    }

    async fn get_play_qualities(&self, detail: &LiveRoomDetail) -> AppResult<Vec<LivePlayQuality>> {
        if !detail.status {
            return Err(AppError::new(
                "douyin_not_live",
                "该抖音直播间当前未开播，无法获取播放地址",
            )
            .with_site("douyin"));
        }
        let stream_url = detail
            .raw
            .get("stream_url")
            .or_else(|| detail.raw.get("streamUrl"))
            .unwrap_or(&Value::Null);
        parse_play_qualities(stream_url)
    }

    async fn get_play_urls(
        &self,
        detail: &LiveRoomDetail,
        quality: &LivePlayQuality,
    ) -> AppResult<Vec<PlayUrl>> {
        let Some(values) = quality.data.get("urls").and_then(Value::as_array) else {
            return Err(Self::parse_err("播放清晰度缺少 URL 数据"));
        };
        let mut headers = HashMap::new();
        headers.insert("user-agent".into(), DEFAULT_USER_AGENT.into());
        headers.insert(
            "referer".into(),
            format!("https://live.douyin.com/{}", detail.room_id),
        );

        let mut urls = Vec::new();
        for value in values {
            let url = json_str(value);
            if !is_http_url(&url) || urls.iter().any(|item: &PlayUrl| item.url == url) {
                continue;
            }
            urls.push(PlayUrl {
                url,
                headers: headers.clone(),
            });
        }
        if urls.is_empty() {
            return Err(Self::err("抖音播放地址为空或已失效，请刷新直播间后重试"));
        }
        Ok(urls)
    }
}

fn numeric_id<'a>(value: &'a str, label: &str) -> AppResult<&'a str> {
    if value.is_empty() || value.len() > 32 || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(
            AppError::new("douyin_invalid_id", format!("无效的抖音{label}")).with_site("douyin"),
        );
    }
    Ok(value)
}

fn normalize_room_id(room_id: &str) -> AppResult<String> {
    let room_id = room_id.trim();
    let room_id = room_id
        .strip_prefix("https://live.douyin.com/")
        .or_else(|| room_id.strip_prefix("http://live.douyin.com/"))
        .unwrap_or(room_id);
    let room_id = room_id
        .split(['?', '#', '/'])
        .next()
        .unwrap_or_default()
        .trim();
    Ok(numeric_id(room_id, "房间号")?.to_string())
}

fn normalize_cookie(value: &str) -> String {
    merge_cookie_values(
        "",
        value.trim().strip_prefix("Cookie:").unwrap_or(value).trim(),
    )
}

/// Saved account cookies are scoped to Douyin-owned web hosts. Keep that
/// boundary explicit because the room reflow API is hosted on amemv.com.
fn is_douyin_cookie_url(value: &str) -> bool {
    Url::parse(value)
        .ok()
        .and_then(|url| url.host_str().map(str::to_ascii_lowercase))
        .is_some_and(|host| host == "douyin.com" || host.ends_with(".douyin.com"))
}

fn cookie_pairs(value: &str) -> Vec<(String, String)> {
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

fn json_i64_opt(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_u64().and_then(|number| i64::try_from(number).ok()))
        .or_else(|| value.as_str().and_then(|number| number.trim().parse().ok()))
}

fn json_i64(value: &Value) -> i64 {
    json_i64_opt(value).unwrap_or(0)
}

fn json_str(value: &Value) -> String {
    match value {
        Value::String(value) => value.trim().to_string(),
        Value::Number(value) => value.to_string(),
        Value::Bool(value) => value.to_string(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn first_non_empty(values: impl IntoIterator<Item = String>) -> String {
    values
        .into_iter()
        .find(|value| !value.trim().is_empty())
        .unwrap_or_default()
}

fn first_image_url(value: &Value) -> String {
    match value {
        Value::String(value) => normalize_image_url(value),
        Value::Array(values) => values
            .iter()
            .map(first_image_url)
            .find(|value| !value.is_empty())
            .unwrap_or_default(),
        Value::Object(object) => {
            for key in [
                "url_list",
                "url",
                "uri",
                "icon",
                "icons",
                "cover",
                "background",
                "avatar_thumb",
                "image",
                "image_url",
                "static_icon",
            ] {
                if let Some(candidate) = object.get(key) {
                    let url = first_image_url(candidate);
                    if !url.is_empty() {
                        return url;
                    }
                }
            }
            String::new()
        }
        _ => String::new(),
    }
}

fn normalize_image_url(value: &str) -> String {
    let value = value.trim();
    if let Some(value) = value.strip_prefix("//") {
        format!("https://{value}")
    } else {
        value.to_string()
    }
}

fn is_http_url(value: &str) -> bool {
    value.starts_with("https://") || value.starts_with("http://")
}

/// Decode one JSON value embedded inside Douyin's RSC JavaScript string.
///
/// The page contains text such as `roomsData\":{\"count\":15,...}`.  A
/// normal brace scan would be confused by braces in `stream_data`, so this
/// scans after decoding the outer string escapes and honours JSON strings.
fn decode_embedded_json_value(source: &str, opening: char) -> AppResult<String> {
    let closing = match opening {
        '{' => '}',
        '[' => ']',
        _ => {
            return Err(
                AppError::new("douyin_parse_error", "unsupported embedded JSON delimiter")
                    .with_site("douyin"),
            );
        }
    };

    let mut output = String::new();
    let mut chars = source.chars();
    let mut depth = 0i32;
    let mut in_string = false;
    let mut json_escape = false;

    while let Some(character) = chars.next() {
        let decoded = if character == '\\' {
            let escaped = chars.next().ok_or_else(|| {
                AppError::new("douyin_parse_error", "truncated embedded JSON escape")
                    .with_site("douyin")
            })?;
            match escaped {
                '"' => '"',
                '\\' => '\\',
                '/' => '/',
                'b' => '\u{0008}',
                'f' => '\u{000C}',
                'n' => '\n',
                'r' => '\r',
                't' => '\t',
                'u' => {
                    let hex = chars.by_ref().take(4).collect::<String>();
                    if hex.len() != 4 {
                        return Err(AppError::new(
                            "douyin_parse_error",
                            "truncated embedded unicode escape",
                        )
                        .with_site("douyin"));
                    }
                    let code = u32::from_str_radix(&hex, 16).map_err(|_| {
                        AppError::new("douyin_parse_error", "invalid embedded unicode escape")
                            .with_site("douyin")
                    })?;
                    // Keep lone surrogate escapes valid for serde_json; valid
                    // Unicode escapes can be decoded directly.
                    if let Some(character) = char::from_u32(code) {
                        character
                    } else {
                        output.push_str("\\u");
                        output.push_str(&hex);
                        continue;
                    }
                }
                other => other,
            }
        } else {
            character
        };

        output.push(decoded);
        if in_string {
            if json_escape {
                json_escape = false;
            } else if decoded == '\\' {
                json_escape = true;
            } else if decoded == '"' {
                in_string = false;
            }
            continue;
        }

        if decoded == '"' {
            in_string = true;
        } else if decoded == opening {
            depth += 1;
        } else if decoded == closing {
            depth -= 1;
            if depth == 0 {
                return Ok(output);
            }
        }
    }

    Err(AppError::new("douyin_parse_error", "embedded JSON is not balanced").with_site("douyin"))
}

fn extract_embedded_json(source: &str, key: &str, opening: char) -> AppResult<String> {
    for (index, _) in source.match_indices(key) {
        let tail = &source[index + key.len()..];
        let Some(start) = tail.find(opening) else {
            continue;
        };
        // A real object/array value follows the key immediately after the
        // escaped colon.  This avoids accidentally scanning an unrelated JS
        // identifier farther down a huge RSC payload.
        if start > 96 {
            continue;
        }
        if let Ok(value) = decode_embedded_json_value(&tail[start..], opening) {
            return Ok(value);
        }
    }
    Err(AppError::new(
        "douyin_parse_error",
        format!("Douyin SSR payload missing {key}"),
    )
    .with_site("douyin"))
}

fn parse_categories_html(html: &str) -> AppResult<Vec<LiveCategory>> {
    let raw = extract_embedded_json(html, "categoryData", '[')?;
    let data: Value = serde_json::from_str(&raw)
        .map_err(|error| DouyinSite::parse_err(format!("分类 SSR JSON 解析失败: {error}")))?;
    let Some(categories) = data.as_array() else {
        return Err(DouyinSite::parse_err("分类 SSR 数据不是数组"));
    };

    let mut output = Vec::new();
    for category in categories {
        let partition = category.get("partition").unwrap_or(&Value::Null);
        let id = partition_id(partition);
        let name = json_str(partition.get("title").unwrap_or(&Value::Null));
        if id.is_empty() || name.is_empty() {
            continue;
        }
        let image = first_image_url(partition);
        let mut children = vec![LiveSubCategory {
            id: id.clone(),
            name: name.clone(),
            parent_id: id.clone(),
            pic: (!image.is_empty()).then_some(image.clone()),
        }];
        collect_subcategories(category.get("sub_partition"), &id, &image, &mut children);
        output.push(LiveCategory { id, name, children });
    }
    if output.is_empty() {
        return Err(DouyinSite::parse_err("未在抖音 SSR 页面中找到直播分类"));
    }
    Ok(output)
}

fn partition_id(partition: &Value) -> String {
    let id = first_non_empty([
        json_str(partition.get("id_str").unwrap_or(&Value::Null)),
        json_str(partition.get("id").unwrap_or(&Value::Null)),
        json_str(partition.get("partition_id").unwrap_or(&Value::Null)),
    ]);
    let partition_type = first_non_empty([
        json_str(partition.get("type").unwrap_or(&Value::Null)),
        json_str(partition.get("partition_type").unwrap_or(&Value::Null)),
    ]);
    if id.is_empty() {
        String::new()
    } else if partition_type.is_empty() {
        id
    } else {
        format!("{id},{partition_type}")
    }
}

fn collect_subcategories(
    values: Option<&Value>,
    parent_id: &str,
    inherited_image: &str,
    output: &mut Vec<LiveSubCategory>,
) {
    let Some(values) = values.and_then(Value::as_array) else {
        return;
    };
    for item in values {
        let partition = item.get("partition").unwrap_or(&Value::Null);
        let id = partition_id(partition);
        let name = json_str(partition.get("title").unwrap_or(&Value::Null));
        if id.is_empty() || name.is_empty() {
            continue;
        }
        let image = first_image_url(partition);
        output.push(LiveSubCategory {
            id: id.clone(),
            name,
            parent_id: parent_id.to_string(),
            pic: (!image.is_empty())
                .then_some(image.clone())
                .or_else(|| (!inherited_image.is_empty()).then_some(inherited_image.to_string())),
        });
        collect_subcategories(
            item.get("sub_partition"),
            &id,
            if image.is_empty() {
                inherited_image
            } else {
                &image
            },
            output,
        );
    }
}

fn parse_ssr_rooms(html: &str) -> AppResult<RoomListPage> {
    let raw = extract_embedded_json(html, "roomsData", '{')?;
    let value: Value = serde_json::from_str(&raw)
        .map_err(|error| DouyinSite::parse_err(format!("房间列表 SSR JSON 解析失败: {error}")))?;
    parse_room_list_data(&value)
}

fn parse_room_list_data(value: &Value) -> AppResult<RoomListPage> {
    let data = value
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(|| DouyinSite::parse_err("抖音房间列表缺少 data 数组"))?;
    let items = data
        .iter()
        .filter_map(|item| room_item_from_value(item.get("room").unwrap_or(item)))
        .collect::<Vec<_>>();
    Ok(RoomListPage {
        // `roomsData.offset` is always the first SSR page's next offset even
        // when a caller adds an `offset` query string.  Do not advertise a
        // non-existent next page and feed duplicate rooms to the UI.
        has_more: false,
        items,
    })
}

fn parse_search_rooms(value: &Value) -> AppResult<RoomListPage> {
    let data = value
        .get("data")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut items = Vec::new();
    for item in data {
        let raw = item
            .pointer("/lives/rawdata")
            .or_else(|| item.pointer("/live/rawdata"))
            .and_then(Value::as_str);
        let room = raw
            .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
            .unwrap_or(item);
        if let Some(room) = room_item_from_value(&room) {
            items.push(room);
        }
    }
    let has_more = value
        .get("has_more")
        .and_then(Value::as_bool)
        .unwrap_or(items.len() >= 10);
    Ok(RoomListPage { has_more, items })
}

fn room_item_from_value(room: &Value) -> Option<LiveRoomItem> {
    let owner = room.get("owner").unwrap_or(&Value::Null);
    let room_id = first_non_empty([
        json_str(owner.get("web_rid").unwrap_or(&Value::Null)),
        json_str(room.get("web_rid").unwrap_or(&Value::Null)),
        json_str(room.get("id_str").unwrap_or(&Value::Null)),
        json_str(room.get("id").unwrap_or(&Value::Null)),
    ]);
    if room_id.is_empty() {
        return None;
    }
    Some(LiveRoomItem {
        site_id: SiteId::Douyin,
        room_id,
        title: json_str(room.get("title").unwrap_or(&Value::Null)),
        cover: first_image_url(room.get("cover").unwrap_or(&Value::Null)),
        user_name: first_non_empty([
            json_str(owner.get("nickname").unwrap_or(&Value::Null)),
            json_str(room.pointer("/user/nickname").unwrap_or(&Value::Null)),
        ]),
        online: first_non_empty_i64([
            room.pointer("/room_view_stats/display_value"),
            room.pointer("/stats/total_user"),
            room.get("user_count"),
            room.get("user_count_str"),
        ]),
    })
}

fn first_non_empty_i64<'a>(values: impl IntoIterator<Item = Option<&'a Value>>) -> i64 {
    values
        .into_iter()
        .flatten()
        .map(json_i64)
        .find(|value| *value != 0)
        .unwrap_or(0)
}

fn parse_reflow_room_detail(root: &Value, requested_room_id: &str) -> AppResult<LiveRoomDetail> {
    let data = root
        .get("data")
        .ok_or_else(|| DouyinSite::parse_err("抖音 reflow 接口缺少 data"))?;
    let room = data
        .get("room")
        .ok_or_else(|| DouyinSite::parse_err("抖音 reflow 接口未返回房间数据"))?;
    parse_room_detail(room, data.get("user"), requested_room_id)
}

fn parse_room_detail_html(html: &str, requested_web_rid: &str) -> AppResult<LiveRoomDetail> {
    for (index, _) in html.match_indices("roomInfo") {
        let tail = &html[index + "roomInfo".len()..];
        let Some(start) = tail.find('{') else {
            continue;
        };
        if start > 96 {
            continue;
        }
        let Ok(raw) = decode_embedded_json_value(&tail[start..], '{') else {
            continue;
        };
        let Ok(info) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        if let Some(room) = info.get("room") {
            return parse_room_detail(room, info.get("anchor"), requested_web_rid);
        }
    }
    Err(DouyinSite::parse_err(
        "抖音直播页未包含可用房间数据，可能已下播或页面结构发生变化",
    ))
}

fn parse_room_detail(
    room: &Value,
    fallback_user: Option<&Value>,
    requested_id: &str,
) -> AppResult<LiveRoomDetail> {
    if !room.is_object() {
        return Err(DouyinSite::parse_err("抖音房间数据格式异常"));
    }
    let owner = room.get("owner").unwrap_or(&Value::Null);
    let fallback_user = fallback_user.unwrap_or(&Value::Null);
    let room_id = first_non_empty([
        json_str(owner.get("web_rid").unwrap_or(&Value::Null)),
        json_str(room.get("web_rid").unwrap_or(&Value::Null)),
        requested_id.to_string(),
    ]);
    let actual_room_id = first_non_empty([
        json_str(room.get("id_str").unwrap_or(&Value::Null)),
        json_str(room.get("id").unwrap_or(&Value::Null)),
        requested_id.to_string(),
    ]);
    let owner_name = first_non_empty([
        json_str(owner.get("nickname").unwrap_or(&Value::Null)),
        json_str(fallback_user.get("nickname").unwrap_or(&Value::Null)),
    ]);
    let avatar = first_non_empty([
        first_image_url(owner.get("avatar_thumb").unwrap_or(&Value::Null)),
        first_image_url(fallback_user.get("avatar_thumb").unwrap_or(&Value::Null)),
    ]);
    let status = json_i64(
        room.get("status")
            .or_else(|| room.get("live_status"))
            .or_else(|| room.get("room_status"))
            .unwrap_or(&Value::Null),
    ) == 2;
    let stream_url = room.get("stream_url").cloned().unwrap_or(Value::Null);

    Ok(LiveRoomDetail {
        site_id: SiteId::Douyin,
        room_id: room_id.clone(),
        title: json_str(room.get("title").unwrap_or(&Value::Null)),
        cover: if status {
            first_image_url(room.get("cover").unwrap_or(&Value::Null))
        } else {
            String::new()
        },
        user_name: owner_name,
        user_avatar: avatar,
        online: if status {
            first_non_empty_i64([
                room.pointer("/room_view_stats/display_value"),
                room.pointer("/stats/total_user"),
                room.get("user_count"),
                room.get("user_count_str"),
            ])
        } else {
            0
        },
        status,
        live_started_at: parse_live_started_at(
            room.get("live_start_time")
                .or_else(|| room.get("start_time"))
                .or_else(|| room.get("room_start_time")),
        ),
        notice: first_non_empty([
            json_str(owner.get("signature").unwrap_or(&Value::Null)),
            json_str(fallback_user.get("signature").unwrap_or(&Value::Null)),
        ]),
        url: format!("https://live.douyin.com/{room_id}"),
        raw: serde_json::json!({
            "room_id": actual_room_id,
            "web_rid": room_id,
            "stream_url": stream_url,
        }),
    })
}

fn reflow_room_id(detail: &LiveRoomDetail) -> AppResult<String> {
    let room_id = detail.raw.get("room_id").map(json_str).unwrap_or_default();
    let room_id = numeric_id(&room_id, "内部房间号")?;
    if room_id.len() <= 16 {
        return Err(DouyinSite::parse_err("抖音房间接口未返回内部房间号"));
    }
    Ok(room_id.to_string())
}

fn has_playable_stream(detail: &LiveRoomDetail) -> bool {
    detail
        .raw
        .get("stream_url")
        .or_else(|| detail.raw.get("streamUrl"))
        .is_some_and(|stream_url| parse_play_qualities(stream_url).is_ok())
}

fn parse_play_qualities(stream_url: &Value) -> AppResult<Vec<LivePlayQuality>> {
    if !stream_url.is_object() {
        return Err(DouyinSite::parse_err("抖音房间未提供直播流数据"));
    }
    let stream_data = stream_url
        .pointer("/live_core_sdk_data/pull_data/stream_data")
        .and_then(Value::as_str)
        .and_then(|data| serde_json::from_str::<Value>(data).ok())
        .unwrap_or(Value::Null);
    let qualities = stream_url
        .pointer("/live_core_sdk_data/pull_data/options/qualities")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let mut result = Vec::new();
    for quality in qualities {
        if json_i64(quality.get("disable").unwrap_or(&Value::Null)) != 0 {
            continue;
        }
        let key = json_str(quality.get("sdk_key").unwrap_or(&Value::Null));
        let level = json_i64(quality.get("level").unwrap_or(&Value::Null));
        let mut urls = stream_urls_for_sdk_key(&stream_data, &key);
        if urls.is_empty() {
            urls = fallback_urls_for_sdk_key(stream_url, &key, level);
        }
        if urls.is_empty() {
            continue;
        }
        let name = json_str(quality.get("name").unwrap_or(&Value::Null));
        result.push((
            level,
            LivePlayQuality {
                quality: if name.is_empty() {
                    quality_name(&key)
                } else {
                    name
                },
                data: serde_json::json!({ "urls": urls, "level": level, "sdk_key": key }),
            },
        ));
    }

    if result.is_empty() {
        result = fallback_qualities(stream_url);
    }
    result.sort_by(|(left, _), (right, _)| right.cmp(left));
    let result = result
        .into_iter()
        .map(|(_, quality)| quality)
        .collect::<Vec<_>>();
    if result.is_empty() {
        return Err(DouyinSite::err("抖音直播流中未找到可播放的清晰度"));
    }
    Ok(result)
}

fn stream_urls_for_sdk_key(stream_data: &Value, key: &str) -> Vec<String> {
    if key.is_empty() {
        return Vec::new();
    }
    let main = stream_data
        .pointer(&format!("/data/{key}/main"))
        .unwrap_or(&Value::Null);
    dedupe_urls([main.get("flv"), main.get("hls"), main.get("hls_url")])
}

fn fallback_urls_for_sdk_key(stream_url: &Value, key: &str, level: i64) -> Vec<String> {
    let mut candidates = match key {
        "origin" => vec!["FULL_HD1", "ORIGIN"],
        "hd" => vec!["HD1", "HD"],
        "sd" => vec!["SD2", "SD"],
        "ld" => vec!["SD1", "LD"],
        "md" => vec!["MD", "LD"],
        _ => vec![key],
    };
    if candidates.is_empty() && level > 0 {
        candidates.push("HD1");
    }
    for candidate in candidates {
        let urls = urls_for_resolution(stream_url, candidate);
        if !urls.is_empty() {
            return urls;
        }
    }
    Vec::new()
}

fn urls_for_resolution(stream_url: &Value, resolution: &str) -> Vec<String> {
    dedupe_urls([
        stream_url.pointer(&format!("/flv_pull_url/{resolution}")),
        stream_url.pointer(&format!("/hls_pull_url_map/{resolution}")),
        stream_url.pointer(&format!("/hls_pull_url/{resolution}")),
    ])
}

fn dedupe_urls<'a>(values: impl IntoIterator<Item = Option<&'a Value>>) -> Vec<String> {
    let mut output = Vec::new();
    for value in values.into_iter().flatten() {
        collect_urls(value, &mut output);
    }
    output
}

fn collect_urls(value: &Value, output: &mut Vec<String>) {
    match value {
        Value::String(value) if is_http_url(value) => {
            if !output.iter().any(|candidate| candidate == value) {
                output.push(value.to_string());
            }
        }
        Value::Array(values) => {
            for value in values {
                collect_urls(value, output);
            }
        }
        Value::Object(values) => {
            for key in ["url", "url_list", "main"] {
                if let Some(value) = values.get(key) {
                    collect_urls(value, output);
                }
            }
        }
        _ => {}
    }
}

fn fallback_qualities(stream_url: &Value) -> Vec<(i64, LivePlayQuality)> {
    let mut resolutions = stream_url
        .get("flv_pull_url")
        .and_then(Value::as_object)
        .map(|values| values.keys().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    if resolutions.is_empty() {
        resolutions = stream_url
            .get("hls_pull_url_map")
            .and_then(Value::as_object)
            .map(|values| values.keys().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
    }
    resolutions
        .into_iter()
        .filter_map(|resolution| {
            let urls = urls_for_resolution(stream_url, &resolution);
            if urls.is_empty() {
                return None;
            }
            let level = resolution_rank(&resolution);
            Some((
                level,
                LivePlayQuality {
                    quality: quality_name(&resolution),
                    data: serde_json::json!({
                        "urls": urls,
                        "level": level,
                        "sdk_key": resolution,
                    }),
                },
            ))
        })
        .collect()
}

fn resolution_rank(value: &str) -> i64 {
    let value = value.to_ascii_uppercase();
    if value.contains("FULL") || value.contains("ORIGIN") {
        100
    } else if value.starts_with("HD") {
        80
    } else if value == "SD2" || value == "SD" {
        60
    } else if value == "SD1" || value == "LD" {
        40
    } else if value == "MD" {
        20
    } else {
        0
    }
}

fn quality_name(value: &str) -> String {
    let value = value.to_ascii_lowercase();
    if value.contains("origin") || value.contains("full") {
        "原画".into()
    } else if value.starts_with("hd") {
        "高清".into()
    } else if value == "sd" || value == "sd2" {
        "标清".into()
    } else if value == "ld" || value == "sd1" || value == "md" {
        "流畅".into()
    } else if value == "ao" {
        "纯音频".into()
    } else {
        value
    }
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpListener;

    use super::*;

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

    #[test]
    fn parses_nested_ssr_categories() {
        let html = r#"<script>categoryData\":[{\"partition\":{\"id_str\":\"103\",\"type\":4,\"title\":\"游戏\",\"icon\":\"//img.example/game.png\"},\"sub_partition\":[{\"partition\":{\"id_str\":\"1\",\"type\":1,\"title\":\"射击\"},\"sub_partition\":[{\"partition\":{\"id_str\":\"1010032\",\"type\":1,\"title\":\"和平精英\"},\"sub_partition\":[]}]}]}]</script>"#;
        let categories = parse_categories_html(html).expect("categories");
        assert_eq!(categories.len(), 1);
        assert_eq!(categories[0].id, "103,4");
        assert!(
            categories[0]
                .children
                .iter()
                .any(|item| item.id == "1010032,1")
        );
        assert_eq!(
            categories[0].children[0].pic.as_deref(),
            Some("https://img.example/game.png")
        );
    }

    #[test]
    fn parses_ssr_room_list() {
        let html = r#"<script>roomsData\":{\"count\":15,\"offset\":15,\"data\":[{\"room\":{\"id_str\":\"7666175273884879635\",\"title\":\"测试直播\",\"cover\":{\"url_list\":[\"https://img.example/cover.jpg\"]},\"owner\":{\"web_rid\":\"522864404974\",\"nickname\":\"主播\"},\"room_view_stats\":{\"display_value\":42}}}]}</script>"#;
        let page = parse_ssr_rooms(html).expect("room page");
        assert!(!page.has_more);
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].room_id, "522864404974");
        assert_eq!(page.items[0].online, 42);
    }

    #[test]
    fn ssr_room_metadata_uses_its_internal_id_for_reflow() {
        let html = r#"<script>roomInfo\":{\"room\":{\"id_str\":\"7666175273884879635\",\"status\":2,\"title\":\"轻量房间数据\",\"owner\":{\"web_rid\":\"522864404974\",\"nickname\":\"主播\"},\"stream_url\":{}},\"anchor\":{\"nickname\":\"主播\"}}</script>"#;
        let detail = parse_room_detail_html(html, "522864404974").expect("SSR room detail");

        assert!(detail.status);
        assert!(!has_playable_stream(&detail));
        assert_eq!(reflow_room_id(&detail).unwrap(), "7666175273884879635");
    }

    #[test]
    fn parses_detail_and_sorts_play_qualities() {
        let stream_data = serde_json::json!({
            "data": {
                "origin": {"main": {"flv": "https://cdn.example/origin.flv", "hls": "https://cdn.example/origin.m3u8"}},
                "ld": {"main": {"flv": "https://cdn.example/ld.flv", "hls": "https://cdn.example/ld.m3u8"}}
            }
        });
        let room = serde_json::json!({
            "id_str": "7666175273884879635",
            "status": 2,
            "title": "测试直播",
            "cover": {"url_list": ["https://img.example/cover.jpg"]},
            "owner": {
                "web_rid": "522864404974",
                "nickname": "主播",
                "avatar_thumb": {"url_list": ["https://img.example/avatar.jpg"]}
            },
            "room_view_stats": {"display_value": 42},
            "stream_url": {
                "live_core_sdk_data": {
                    "pull_data": {
                        "stream_data": stream_data.to_string(),
                        "options": {"qualities": [
                            {"name": "流畅", "sdk_key": "ld", "level": 1},
                            {"name": "蓝光", "sdk_key": "origin", "level": 4}
                        ]}
                    }
                }
            }
        });
        let detail = parse_reflow_room_detail(
            &serde_json::json!({
                "data": {
                    "room": room,
                    "user": {"nickname": "主播"}
                }
            }),
            "522864404974",
        )
        .expect("reflow detail");
        assert!(detail.status);
        assert_eq!(detail.room_id, "522864404974");
        assert!(has_playable_stream(&detail));
        let qualities =
            parse_play_qualities(detail.raw.get("stream_url").unwrap()).expect("qualities");
        assert_eq!(qualities[0].quality, "蓝光");
        assert_eq!(qualities[1].quality, "流畅");
        assert_eq!(
            qualities[0].data.pointer("/urls/0").and_then(Value::as_str),
            Some("https://cdn.example/origin.flv")
        );
    }

    #[test]
    fn extracts_room_detail_from_ssr_fallback() {
        let html = r#"<script>roomInfo\":{} roomInfo\":{\"room\":{\"id_str\":\"7666175273884879635\",\"status\":2,\"title\":\"回退直播\",\"owner\":{\"web_rid\":\"522864404974\",\"nickname\":\"主播\"},\"stream_url\":{}},\"anchor\":{\"nickname\":\"主播\"}}</script>"#;
        let detail = parse_room_detail_html(html, "522864404974").expect("fallback detail");
        assert!(detail.status);
        assert_eq!(detail.title, "回退直播");
    }

    #[test]
    fn ssr_detail_remains_usable_without_a_web_enter_payload() {
        let html = r#"<script>roomInfo\":{\"room\":{\"id_str\":\"7666175273884879635\",\"status\":2,\"title\":\"SSR 直播\",\"owner\":{\"web_rid\":\"522864404974\",\"nickname\":\"主播\"},\"stream_url\":{}},\"anchor\":{\"nickname\":\"主播\"}}</script>"#;
        let detail = parse_room_detail_html(html, "522864404974").expect("SSR fallback detail");
        assert_eq!(detail.title, "SSR 直播");
    }
}
