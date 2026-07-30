//! Kuaishou live site client.
//!
//! Kuaishou exposes stable, anonymous JSON endpoints for the live home,
//! games, and game-board pages.  Individual live rooms are rendered with an
//! SSR state object, which also contains the short-lived pull URLs.  General
//! creator/live search is signature-protected, so `search_rooms` deliberately
//! falls back to searching public game categories and then opens that game's
//! live list instead of pretending to support creator search.

use std::collections::HashMap;
use std::sync::Mutex;

use reqwest::Client;
use reqwest::header::{COOKIE, HeaderMap, REFERER, SET_COOKIE, USER_AGENT};
use serde_json::{Value, json};

use crate::error::{AppError, AppResult};
use crate::http_client;
use crate::models::live::{
    LiveCategory, LivePlayQuality, LiveRoomDetail, LiveRoomItem, LiveRoomStatus, LiveSubCategory,
    PlayUrl, RoomListPage, SiteId, parse_live_started_at,
};
use crate::sites::traits::LiveSite;

/// Browser UA used by Kuaishou's web live pages and pull CDN.
pub const DEFAULT_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const LIVE_ROOT: &str = "https://live.kuaishou.com/";
const HOME_LIVESTREAM_URL: &str = "https://live.kuaishou.com/live_api/home/livestream";
const CATEGORY_URL: &str = "https://live.kuaishou.com/live_api/home/category";
const GAMEBOARD_LIST_URL: &str = "https://live.kuaishou.com/live_api/gameboard/list";
const SEARCH_CATEGORY_URL: &str = "https://live.kuaishou.com/live_api/search/category";
const PAGE_SIZE: u32 = 20;

/// A Kuaishou instance owns only request-local cookies.  Commands intentionally
/// create a fresh site instance, so anonymous `did` cookies are never persisted
/// in the account database; a user-supplied Cookie is preserved and merged
/// during the lifetime of the request.
pub struct KuaishouSite {
    client: Client,
    cookie: Mutex<String>,
}

impl Default for KuaishouSite {
    fn default() -> Self {
        Self::new(http_client::default_client(), String::new())
    }
}

impl KuaishouSite {
    pub fn new(client: Client, cookie: String) -> Self {
        Self {
            client,
            cookie: Mutex::new(normalize_cookie(&cookie)),
        }
    }

    fn err(message: impl Into<String>) -> AppError {
        AppError::new("kuaishou_api_error", message)
            .with_site("kuaishou")
            .retryable()
    }

    fn parse_err(message: impl Into<String>) -> AppError {
        AppError::new("kuaishou_parse_error", message).with_site("kuaishou")
    }

    fn cookie(&self) -> AppResult<String> {
        self.cookie
            .lock()
            .map(|cookie| cookie.clone())
            .map_err(|_| {
                AppError::new("kuaishou_lock", "Kuaishou session mutex poisoned")
                    .with_site("kuaishou")
            })
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
        if received.is_empty() {
            return Ok(());
        }

        let mut cookie = self.cookie.lock().map_err(|_| {
            AppError::new("kuaishou_lock", "Kuaishou session mutex poisoned").with_site("kuaishou")
        })?;
        *cookie = merge_cookie_values(&cookie, &received.join("; "));
        Ok(())
    }

    async fn get_text(
        &self,
        url: &str,
        params: &[(&str, String)],
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
        if !cookie.is_empty() {
            request = request.header(COOKIE, cookie);
        }
        for (key, value) in params {
            request = request.query(&[(*key, value.as_str())]);
        }

        let response = request
            .send()
            .await
            .map_err(|error| Self::err(format!("HTTP request failed: {error}")))?;
        let status = response.status();
        let headers = response.headers().clone();
        let text = response
            .text()
            .await
            .map_err(|error| Self::err(format!("HTTP response body failed: {error}")))?;
        self.remember_response_cookies(&headers)?;

        if !status.is_success() {
            return Err(Self::err(format!(
                "HTTP {status}: {}",
                text.chars().take(180).collect::<String>()
            )));
        }
        if text.trim().is_empty() {
            return Err(Self::err("快手接口返回为空，可能触发访问验证"));
        }
        Ok(text)
    }

    async fn get_json(
        &self,
        url: &str,
        params: &[(&str, String)],
        referer: &str,
    ) -> AppResult<Value> {
        let text = self.get_text(url, params, referer, true).await?;
        let value: Value = serde_json::from_str(&text)
            .map_err(|error| Self::parse_err(format!("JSON 响应解析失败: {error}")))?;
        self.ensure_api_success(&value)?;
        Ok(value)
    }

    fn ensure_api_success(&self, value: &Value) -> AppResult<()> {
        // The public endpoints normally do not include a status field on
        // success.  When an edge node returns a structured error, the code is
        // usually in one of these locations.
        let code = value
            .get("errorCode")
            .or_else(|| value.get("error_code"))
            .or_else(|| value.get("code"))
            .or_else(|| value.pointer("/data/errorCode"))
            .and_then(json_i64_opt);
        let Some(code) = code else {
            return Ok(());
        };
        if code == 0 || code == 200 {
            return Ok(());
        }
        let message = first_non_empty([
            json_str(value.get("message").unwrap_or(&Value::Null)),
            json_str(value.get("msg").unwrap_or(&Value::Null)),
            json_str(value.get("errorMsg").unwrap_or(&Value::Null)),
            json_str(value.pointer("/data/message").unwrap_or(&Value::Null)),
        ]);
        Err(Self::err(format!("快手接口错误 code={code}: {message}")))
    }

    async fn get_gameboard_rooms(&self, game_id: &str, page: u32) -> AppResult<RoomListPage> {
        let game_id = normalize_game_id(game_id)?;
        let page = page.max(1);
        let value = self
            .get_json(
                GAMEBOARD_LIST_URL,
                &[
                    ("gameId", game_id),
                    ("page", page.to_string()),
                    ("pageSize", PAGE_SIZE.to_string()),
                    ("filterType", "0".to_string()),
                ],
                LIVE_ROOT,
            )
            .await?;
        parse_room_list(&value, false)
    }

    /// The public room page SSR state carries an explicit `isLiving` flag.
    /// Follow refreshes consume that flag directly and never retain the
    /// playlist payload used for actual playback.
    async fn get_room_live_status_from_html(&self, room_id: &str) -> AppResult<LiveRoomStatus> {
        let html = self
            .get_text(
                &format!("https://live.kuaishou.com/u/{room_id}"),
                &[],
                LIVE_ROOT,
                false,
            )
            .await?;
        parse_room_live_status_html(&html)
    }
}

#[async_trait::async_trait]
impl LiveSite for KuaishouSite {
    async fn get_categories(&self) -> AppResult<Vec<LiveCategory>> {
        let value = self.get_json(CATEGORY_URL, &[], LIVE_ROOT).await?;
        parse_categories(&value)
    }

    async fn get_recommend_rooms(&self, page: u32) -> AppResult<RoomListPage> {
        // The anonymous home endpoint returns a fresh first-page feed, not a
        // stable cursor.  Advertising a second page would duplicate cards in
        // the UI, so only expose its verifiable first page.
        if page.max(1) > 1 {
            return Ok(RoomListPage {
                has_more: false,
                items: Vec::new(),
            });
        }
        let value = self
            .get_json(
                HOME_LIVESTREAM_URL,
                &[
                    ("queryFollowing", "true".to_string()),
                    ("followingWeight", "50".to_string()),
                ],
                LIVE_ROOT,
            )
            .await?;
        parse_room_list(&value, false)
    }

    async fn get_category_rooms(
        &self,
        category: &LiveSubCategory,
        page: u32,
    ) -> AppResult<RoomListPage> {
        self.get_gameboard_rooms(&category.id, page).await
    }

    async fn search_rooms(&self, keyword: &str, page: u32) -> AppResult<RoomListPage> {
        let keyword = keyword.trim();
        if keyword.is_empty() {
            return Ok(RoomListPage {
                has_more: false,
                items: Vec::new(),
            });
        }

        // `live_api/search/liveStream` is signed by Kuaishou's web client and
        // rejects anonymous requests.  The public category search gives a
        // useful, honest fallback: find the closest game and browse its rooms.
        let search = self
            .get_json(
                SEARCH_CATEGORY_URL,
                &[("keyword", keyword.to_string()), ("page", "1".to_string())],
                LIVE_ROOT,
            )
            .await?;
        let Some(game_id) = find_search_game_id(&search, keyword) else {
            return Ok(RoomListPage {
                has_more: false,
                items: Vec::new(),
            });
        };
        self.get_gameboard_rooms(&game_id, page).await
    }

    async fn get_room_live_status(&self, room_id: &str) -> AppResult<LiveRoomStatus> {
        let room_id = normalize_room_id(room_id)?;
        self.get_room_live_status_from_html(&room_id).await
    }

    async fn get_room_detail(&self, room_id: &str) -> AppResult<LiveRoomDetail> {
        let room_id = normalize_room_id(room_id)?;
        let html = self
            .get_text(
                &format!("https://live.kuaishou.com/u/{room_id}"),
                &[],
                LIVE_ROOT,
                false,
            )
            .await?;
        parse_room_detail_html(&html, &room_id)
    }

    async fn get_play_qualities(&self, detail: &LiveRoomDetail) -> AppResult<Vec<LivePlayQuality>> {
        if !detail.status {
            return Err(AppError::new(
                "kuaishou_not_live",
                "该快手直播间当前未开播，无法获取播放地址",
            )
            .with_site("kuaishou"));
        }
        parse_play_qualities(&detail.raw)
    }

    async fn get_play_urls(
        &self,
        detail: &LiveRoomDetail,
        quality: &LivePlayQuality,
    ) -> AppResult<Vec<PlayUrl>> {
        let mut headers = HashMap::new();
        headers.insert("user-agent".to_string(), DEFAULT_USER_AGENT.to_string());
        headers.insert(
            "referer".to_string(),
            format!("https://live.kuaishou.com/u/{}", detail.room_id),
        );

        let mut urls = Vec::new();
        if let Some(values) = quality.data.get("urls").and_then(Value::as_array) {
            for value in values {
                let url = json_str(value);
                if is_http_url(&url) && !urls.iter().any(|item: &PlayUrl| item.url == url) {
                    urls.push(PlayUrl {
                        url,
                        headers: headers.clone(),
                    });
                }
            }
        }
        if urls.is_empty() {
            return Err(Self::parse_err("播放清晰度缺少可用的快手流地址"));
        }
        Ok(urls)
    }
}

fn normalize_game_id(value: &str) -> AppResult<String> {
    let value = value.trim();
    if value.is_empty() || value.len() > 24 || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(
            AppError::new("kuaishou_invalid_game_id", "无效的快手游戏分类 ID")
                .with_site("kuaishou"),
        );
    }
    Ok(value.to_string())
}

fn normalize_room_id(value: &str) -> AppResult<String> {
    let value = value.trim();
    let value = value
        .strip_prefix("https://live.kuaishou.com/u/")
        .or_else(|| value.strip_prefix("http://live.kuaishou.com/u/"))
        .unwrap_or(value);
    let value = value
        .split(['?', '#', '/'])
        .next()
        .unwrap_or_default()
        .trim();
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
    {
        return Err(
            AppError::new("kuaishou_invalid_room_id", "无效的快手主播 ID").with_site("kuaishou"),
        );
    }
    Ok(value.to_string())
}

fn normalize_cookie(value: &str) -> String {
    merge_cookie_values(
        "",
        value.trim().strip_prefix("Cookie:").unwrap_or(value).trim(),
    )
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

fn json_bool(value: &Value) -> Option<bool> {
    match value {
        Value::Bool(value) => Some(*value),
        Value::Number(value) => value.as_i64().map(|value| value != 0),
        Value::String(value) => match value.trim().to_ascii_lowercase().as_str() {
            "true" | "1" | "yes" => Some(true),
            "false" | "0" | "no" => Some(false),
            _ => None,
        },
        _ => None,
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
                "url", "url_list", "urls", "poster", "cover", "avatar", "image", "src",
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

fn parse_categories(value: &Value) -> AppResult<Vec<LiveCategory>> {
    let categories = value
        .pointer("/data/list")
        .and_then(Value::as_array)
        .ok_or_else(|| KuaishouSite::parse_err("快手分类接口缺少 data.list"))?;

    let mut output = Vec::new();
    for (index, category) in categories.iter().enumerate() {
        let name = json_str(category.get("name").unwrap_or(&Value::Null));
        if name.is_empty() {
            continue;
        }
        let id = first_non_empty([
            json_str(category.get("id").unwrap_or(&Value::Null)),
            json_str(category.get("type").unwrap_or(&Value::Null)),
            format!("group-{index}"),
        ]);
        let children = category
            .get("gameInfos")
            .or_else(|| category.get("game_infos"))
            .and_then(Value::as_array)
            .map(|games| {
                games
                    .iter()
                    .filter_map(|game| {
                        let game_id = first_non_empty([
                            json_str(game.get("id").unwrap_or(&Value::Null)),
                            json_str(game.get("gameId").unwrap_or(&Value::Null)),
                        ]);
                        let game_name = first_non_empty([
                            json_str(game.get("name").unwrap_or(&Value::Null)),
                            json_str(game.get("title").unwrap_or(&Value::Null)),
                        ]);
                        if game_id.is_empty() || game_name.is_empty() {
                            return None;
                        }
                        let pic = first_non_empty([
                            first_image_url(game.get("iconUrl").unwrap_or(&Value::Null)),
                            first_image_url(game.get("poster").unwrap_or(&Value::Null)),
                        ]);
                        Some(LiveSubCategory {
                            id: game_id,
                            name: game_name,
                            parent_id: id.clone(),
                            pic: (!pic.is_empty()).then_some(pic),
                        })
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        output.push(LiveCategory { id, name, children });
    }
    if output.is_empty() {
        return Err(KuaishouSite::parse_err("未在快手分类接口中找到游戏分类"));
    }
    Ok(output)
}

fn parse_room_list(value: &Value, default_has_more: bool) -> AppResult<RoomListPage> {
    let list = value
        .pointer("/data/list")
        .and_then(Value::as_array)
        .ok_or_else(|| KuaishouSite::parse_err("快手房间列表接口缺少 data.list"))?;
    let items = list
        .iter()
        .filter_map(room_item_from_value)
        .collect::<Vec<_>>();
    let has_more = value
        .pointer("/data/hasMore")
        .or_else(|| value.pointer("/data/has_more"))
        .or_else(|| value.get("hasMore"))
        .and_then(json_bool)
        .unwrap_or(default_has_more);
    Ok(RoomListPage { has_more, items })
}

fn room_item_from_value(value: &Value) -> Option<LiveRoomItem> {
    let author = value.get("author").unwrap_or(&Value::Null);
    // Kuaishou's liveStream.id is a transient stream id.  The /u/<principal>
    // room route requires the stable author/principal id instead.
    let room_id = first_non_empty([
        json_str(author.get("id").unwrap_or(&Value::Null)),
        json_str(author.get("principalId").unwrap_or(&Value::Null)),
        json_str(author.get("principal_id").unwrap_or(&Value::Null)),
        json_str(value.get("principalId").unwrap_or(&Value::Null)),
    ]);
    if room_id.is_empty() {
        return None;
    }
    let live_stream = value.get("liveStream").unwrap_or(value);
    let title = first_non_empty([
        json_str(value.get("caption").unwrap_or(&Value::Null)),
        json_str(live_stream.get("caption").unwrap_or(&Value::Null)),
        json_str(value.get("title").unwrap_or(&Value::Null)),
        json_str(live_stream.get("title").unwrap_or(&Value::Null)),
    ]);
    Some(LiveRoomItem {
        site_id: SiteId::Kuaishou,
        room_id,
        title,
        cover: first_non_empty([
            first_image_url(value.get("poster").unwrap_or(&Value::Null)),
            first_image_url(live_stream.get("poster").unwrap_or(&Value::Null)),
            first_image_url(value.get("cover").unwrap_or(&Value::Null)),
        ]),
        user_name: first_non_empty([
            json_str(author.get("name").unwrap_or(&Value::Null)),
            json_str(author.get("nickname").unwrap_or(&Value::Null)),
            json_str(author.get("userName").unwrap_or(&Value::Null)),
        ]),
        online: first_popularity([
            value.get("watchingCount"),
            live_stream.get("watchingCount"),
            value.get("onlineCount"),
            value.get("watchingCountText"),
        ]),
    })
}

fn first_popularity<'a>(values: impl IntoIterator<Item = Option<&'a Value>>) -> i64 {
    values
        .into_iter()
        .flatten()
        .map(parse_popularity)
        .find(|value| *value != 0)
        .unwrap_or(0)
}

fn parse_popularity(value: &Value) -> i64 {
    if let Some(value) = json_i64_opt(value) {
        return value;
    }
    let value = json_str(value)
        .replace(',', "")
        .replace('，', "")
        .replace('+', "");
    let value = value.trim();
    let (number, multiplier) = if let Some(number) = value.strip_suffix('亿') {
        (number, 100_000_000_f64)
    } else if let Some(number) = value.strip_suffix('万') {
        (number, 10_000_f64)
    } else if let Some(number) = value.strip_suffix('w').or_else(|| value.strip_suffix('W')) {
        (number, 10_000_f64)
    } else if let Some(number) = value.strip_suffix('k').or_else(|| value.strip_suffix('K')) {
        (number, 1_000_f64)
    } else {
        (value, 1_f64)
    };
    number
        .trim()
        .parse::<f64>()
        .ok()
        .map(|number| (number * multiplier).round() as i64)
        .unwrap_or(0)
}

fn find_search_game_id(value: &Value, keyword: &str) -> Option<String> {
    let list = value.pointer("/data/list")?.as_array()?;
    let needle = keyword.trim().to_ascii_lowercase();
    let mut candidates = Vec::new();
    for (index, item) in list.iter().enumerate() {
        let id = first_non_empty([
            json_str(item.get("categoryId").unwrap_or(&Value::Null)),
            json_str(item.get("id").unwrap_or(&Value::Null)),
            json_str(item.get("gameId").unwrap_or(&Value::Null)),
        ]);
        if normalize_game_id(&id).is_err() {
            continue;
        }
        let names = [
            json_str(item.get("title").unwrap_or(&Value::Null)),
            json_str(item.get("shortName").unwrap_or(&Value::Null)),
            json_str(item.get("name").unwrap_or(&Value::Null)),
        ];
        let score = names
            .iter()
            .filter(|name| !name.is_empty())
            .map(|name| search_name_score(name, &needle))
            .min()
            .unwrap_or(4);
        if score < 3 {
            candidates.push((score, index, id));
        }
    }
    candidates.sort_by(|left, right| left.0.cmp(&right.0).then(left.1.cmp(&right.1)));
    candidates.into_iter().next().map(|(_, _, id)| id)
}

fn search_name_score(name: &str, needle: &str) -> u8 {
    let name = name.trim().to_ascii_lowercase();
    if name == needle {
        0
    } else if name.starts_with(needle) || needle.starts_with(&name) {
        1
    } else if name.contains(needle) || needle.contains(&name) {
        2
    } else {
        3
    }
}

/// Parse only the two follow-list fields from the room's SSR state.  In
/// particular, do not use `playUrls` as a heuristic: touching it here couples
/// a live-state refresh to short-lived playback metadata unnecessarily.
fn parse_room_live_status_html(html: &str) -> AppResult<LiveRoomStatus> {
    let state = extract_initial_state(html)?;
    let play_list = state
        .pointer("/liveroom/playList")
        .or_else(|| state.pointer("/liveRoom/playList"))
        .or_else(|| state.pointer("/liveroom/play_list"))
        .and_then(Value::as_array)
        .ok_or_else(|| KuaishouSite::parse_err("快手直播页未包含房间状态数据，可能需要访问验证"))?;
    let item = play_list.first().ok_or_else(|| {
        KuaishouSite::parse_err("快手直播页未返回房间状态，主播可能不存在或页面结构已变更")
    })?;
    let live_stream = item.get("liveStream").unwrap_or(item);
    let status = [
        item.get("isLiving"),
        live_stream.get("isLiving"),
        item.get("living"),
        live_stream.get("living"),
    ]
    .into_iter()
    .flatten()
    .find_map(json_bool)
    .ok_or_else(|| KuaishouSite::parse_err("快手房间状态缺少 isLiving 字段"))?;

    Ok(LiveRoomStatus {
        status,
        live_started_at: status
            .then(|| {
                parse_live_started_at(
                    live_stream
                        .get("startTime")
                        .or_else(|| live_stream.get("start_time"))
                        .or_else(|| item.get("startTime"))
                        .or_else(|| item.get("start_time")),
                )
            })
            .flatten(),
    })
}

fn parse_room_detail_html(html: &str, requested_room_id: &str) -> AppResult<LiveRoomDetail> {
    let state = extract_initial_state(html)?;
    let play_list = state
        .pointer("/liveroom/playList")
        .or_else(|| state.pointer("/liveRoom/playList"))
        .or_else(|| state.pointer("/liveroom/play_list"))
        .and_then(Value::as_array)
        .ok_or_else(|| {
            KuaishouSite::parse_err("快手直播页未包含 liveroom.playList，可能需要访问验证")
        })?;
    let item = play_list.first().ok_or_else(|| {
        KuaishouSite::parse_err("快手直播页未返回房间数据，主播可能未开播或页面结构已变更")
    })?;

    if let Some(error) = item.get("errorType").filter(|error| !error.is_null()) {
        let title = json_str(error.get("title").unwrap_or(&Value::Null));
        let content = json_str(error.get("content").unwrap_or(&Value::Null));
        let message = first_non_empty([title, content]);
        let error_type = json_i64(error.get("type").unwrap_or(&Value::Null));
        if error_type != 0 || !message.is_empty() {
            return Err(AppError::new(
                "kuaishou_room_unavailable",
                if message.is_empty() {
                    "快手暂未返回可用直播间数据，请稍后重试".to_string()
                } else {
                    format!("快手直播间暂不可用：{message}")
                },
            )
            .with_site("kuaishou")
            .retryable());
        }
    }

    let live_stream = item.get("liveStream").unwrap_or(item);
    let author = item.get("author").unwrap_or(&Value::Null);
    let game_info = item.get("gameInfo").unwrap_or(&Value::Null);
    let play_urls = live_stream
        .get("playUrls")
        .or_else(|| live_stream.get("play_urls"))
        .or_else(|| item.get("playUrls"))
        .cloned()
        .unwrap_or(Value::Null);
    let status = item
        .get("isLiving")
        .and_then(json_bool)
        .or_else(|| live_stream.get("isLiving").and_then(json_bool))
        .or_else(|| live_stream.get("living").and_then(json_bool))
        .unwrap_or_else(|| !play_urls.is_null());
    let room_id = first_non_empty([
        json_str(author.get("id").unwrap_or(&Value::Null)),
        json_str(author.get("principalId").unwrap_or(&Value::Null)),
        requested_room_id.to_string(),
    ]);

    Ok(LiveRoomDetail {
        site_id: SiteId::Kuaishou,
        room_id: room_id.clone(),
        title: first_non_empty([
            json_str(item.get("caption").unwrap_or(&Value::Null)),
            json_str(live_stream.get("caption").unwrap_or(&Value::Null)),
            json_str(item.get("title").unwrap_or(&Value::Null)),
            json_str(live_stream.get("title").unwrap_or(&Value::Null)),
            json_str(game_info.get("name").unwrap_or(&Value::Null)),
        ]),
        cover: first_non_empty([
            first_image_url(live_stream.get("poster").unwrap_or(&Value::Null)),
            first_image_url(item.get("poster").unwrap_or(&Value::Null)),
            first_image_url(item.get("cover").unwrap_or(&Value::Null)),
        ]),
        user_name: first_non_empty([
            json_str(author.get("name").unwrap_or(&Value::Null)),
            json_str(author.get("nickname").unwrap_or(&Value::Null)),
            json_str(author.get("userName").unwrap_or(&Value::Null)),
        ]),
        user_avatar: first_non_empty([
            first_image_url(author.get("avatar").unwrap_or(&Value::Null)),
            first_image_url(author.get("avatarUrl").unwrap_or(&Value::Null)),
        ]),
        online: first_popularity([
            item.get("watchingCount"),
            live_stream.get("watchingCount"),
            item.get("onlineCount"),
            item.get("watchingCountText"),
        ]),
        status,
        live_started_at: parse_live_started_at(
            live_stream
                .get("startTime")
                .or_else(|| live_stream.get("start_time"))
                .or_else(|| item.get("startTime"))
                .or_else(|| item.get("start_time")),
        ),
        notice: first_non_empty([
            json_str(author.get("description").unwrap_or(&Value::Null)),
            json_str(item.get("notice").unwrap_or(&Value::Null)),
            json_str(live_stream.get("description").unwrap_or(&Value::Null)),
        ]),
        url: format!("https://live.kuaishou.com/u/{room_id}"),
        raw: json!({
            "play_urls": play_urls,
            "live_stream_id": json_str(live_stream.get("id").unwrap_or(&Value::Null)),
            "room_id": room_id,
        }),
    })
}

/// Extract the direct JSON assignment in `window.__INITIAL_STATE__` without
/// making assumptions about the rest of the HTML or script formatting.
fn extract_initial_state(html: &str) -> AppResult<Value> {
    const MARKER: &str = "window.__INITIAL_STATE__";
    for (index, _) in html.match_indices(MARKER) {
        let tail = &html[index + MARKER.len()..];
        let Some(equal) = tail.find('=') else {
            continue;
        };
        if equal > 64 {
            continue;
        }
        let tail = tail[equal + 1..].trim_start();
        let Some(opening) = tail.find('{') else {
            continue;
        };
        if opening > 64 {
            continue;
        }
        let raw = &tail[opening..];
        let Some(end) = find_matching_json_brace(raw.as_bytes()) else {
            continue;
        };
        if let Ok(value) = serde_json::from_str::<Value>(&raw[..=end]) {
            return Ok(value);
        }
    }
    Err(KuaishouSite::parse_err(
        "快手直播页未包含可解析的 SSR 初始状态，可能需要访问验证",
    ))
}

fn find_matching_json_brace(bytes: &[u8]) -> Option<usize> {
    if bytes.first() != Some(&b'{') {
        return None;
    }
    let mut depth = 0_i32;
    let mut in_string = false;
    let mut escaped = false;
    for (index, byte) in bytes.iter().enumerate() {
        if in_string {
            if escaped {
                escaped = false;
            } else if *byte == b'\\' {
                escaped = true;
            } else if *byte == b'"' {
                in_string = false;
            }
            continue;
        }
        match *byte {
            b'"' => in_string = true,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(index);
                }
            }
            _ => {}
        }
    }
    None
}

#[derive(Debug)]
struct QualityCandidate {
    level: i64,
    bitrate: i64,
    label: String,
    url: String,
    /// 0 = H.264/AVC, 1 = unknown, 2 = HEVC/H.265.
    codec_rank: u8,
}

#[derive(Debug)]
struct QualityGroup {
    level: i64,
    label: String,
    urls: Vec<String>,
}

fn parse_play_qualities(raw: &Value) -> AppResult<Vec<LivePlayQuality>> {
    let play_urls = raw
        .get("play_urls")
        .or_else(|| raw.get("playUrls"))
        .unwrap_or(&Value::Null);
    let mut candidates = Vec::new();
    collect_quality_candidates(play_urls, 1, &mut candidates);
    candidates.retain(|candidate| is_http_url(&candidate.url));
    candidates.sort_by(|left, right| {
        right
            .level
            .cmp(&left.level)
            .then(left.codec_rank.cmp(&right.codec_rank))
            .then(right.bitrate.cmp(&left.bitrate))
            .then(left.url.cmp(&right.url))
    });

    let mut groups = Vec::<QualityGroup>::new();
    for candidate in candidates {
        if let Some(group) = groups
            .iter_mut()
            .find(|group| group.level == candidate.level)
        {
            if !group.urls.iter().any(|url| url == &candidate.url) {
                group.urls.push(candidate.url);
            }
            continue;
        }
        groups.push(QualityGroup {
            level: candidate.level,
            label: candidate.label,
            urls: vec![candidate.url],
        });
    }

    let qualities = groups
        .into_iter()
        .map(|group| LivePlayQuality {
            quality: group.label,
            data: json!({ "urls": group.urls, "level": group.level }),
        })
        .collect::<Vec<_>>();
    if qualities.is_empty() {
        return Err(KuaishouSite::parse_err(
            "快手直播流中未找到可播放的清晰度，地址可能已过期",
        ));
    }
    Ok(qualities)
}

fn collect_quality_candidates(value: &Value, codec_rank: u8, output: &mut Vec<QualityCandidate>) {
    match value {
        Value::Array(values) => {
            for value in values {
                collect_quality_candidates(value, codec_rank, output);
            }
        }
        Value::Object(object) => {
            let object_codec_rank = codec_rank_from_value(value).unwrap_or(codec_rank);
            if let Some(representations) = object
                .get("adaptationSet")
                .and_then(|set| set.get("representation"))
                .or_else(|| object.get("representation"))
            {
                collect_representation_values(representations, object_codec_rank, output);
            }
            for (key, child) in object {
                if key == "adaptationSet" || key == "representation" {
                    continue;
                }
                let child_codec_rank = codec_rank_from_key(key).unwrap_or(object_codec_rank);
                if child.is_array() || child.is_object() {
                    collect_quality_candidates(child, child_codec_rank, output);
                }
            }
        }
        _ => {}
    }
}

fn collect_representation_values(
    value: &Value,
    codec_rank: u8,
    output: &mut Vec<QualityCandidate>,
) {
    match value {
        Value::Array(values) => {
            for value in values {
                collect_representation_values(value, codec_rank, output);
            }
        }
        Value::Object(object) => {
            if json_bool(object.get("hidden").unwrap_or(&Value::Null)) == Some(true) {
                return;
            }
            let level = json_i64(object.get("level").unwrap_or(&Value::Null));
            let bitrate = json_i64(object.get("bitrate").unwrap_or(&Value::Null));
            let level = if level != 0 { level } else { bitrate };
            let label = first_non_empty([
                json_str(object.get("name").unwrap_or(&Value::Null)),
                json_str(object.get("shortName").unwrap_or(&Value::Null)),
                quality_label_for_level(level),
            ]);
            let codec_rank = codec_rank_from_value(value).unwrap_or(codec_rank);
            let mut urls = Vec::new();
            for key in ["url", "urls", "flv", "hls", "hlsUrl", "hls_url"] {
                collect_http_urls(object.get(key).unwrap_or(&Value::Null), &mut urls);
            }
            for url in urls {
                output.push(QualityCandidate {
                    level,
                    bitrate,
                    label: label.clone(),
                    url,
                    codec_rank,
                });
            }
        }
        _ => {}
    }
}

fn collect_http_urls(value: &Value, output: &mut Vec<String>) {
    match value {
        Value::String(value) if is_http_url(value) => {
            if !output.iter().any(|candidate| candidate == value) {
                output.push(value.to_string());
            }
        }
        Value::Array(values) => {
            for value in values {
                collect_http_urls(value, output);
            }
        }
        Value::Object(object) => {
            for key in ["url", "urls", "flv", "hls", "hlsUrl", "hls_url"] {
                if let Some(value) = object.get(key) {
                    collect_http_urls(value, output);
                }
            }
        }
        _ => {}
    }
}

fn codec_rank_from_key(key: &str) -> Option<u8> {
    codec_rank(key)
}

fn codec_rank_from_value(value: &Value) -> Option<u8> {
    for key in ["codec", "videoCodec", "format", "streamType", "type"] {
        if let Some(rank) = value.get(key).and_then(Value::as_str).and_then(codec_rank) {
            return Some(rank);
        }
    }
    None
}

fn codec_rank(value: &str) -> Option<u8> {
    let value = value.to_ascii_lowercase();
    if value.contains("h264") || value.contains("avc") {
        Some(0)
    } else if value.contains("hevc") || value.contains("h265") {
        Some(2)
    } else {
        None
    }
}

fn quality_label_for_level(level: i64) -> String {
    match level {
        130.. => "蓝光 质臻".to_string(),
        70.. => "蓝光 4M".to_string(),
        50.. => "超清".to_string(),
        30.. => "高清".to_string(),
        _ => "流畅".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_categories_fixture() {
        let value: Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/kuaishou_categories.json"
        ))
        .expect("fixture JSON");
        let categories = parse_categories(&value).expect("categories");
        assert_eq!(categories.len(), 1);
        assert_eq!(categories[0].id, "2");
        assert_eq!(categories[0].children[0].id, "1");
        assert_eq!(
            categories[0].children[0].pic.as_deref(),
            Some("https://img.example/lol.png")
        );
    }

    #[test]
    fn parses_gameboard_room_items_with_author_id() {
        let value: Value =
            serde_json::from_str(include_str!("../../tests/fixtures/kuaishou_gameboard.json"))
                .expect("fixture JSON");
        let page = parse_room_list(&value, false).expect("room page");
        assert!(page.has_more);
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].room_id, "creator_123");
        assert_eq!(page.items[0].online, 12_000);
        assert_eq!(page.items[0].cover, "https://img.example/poster.jpg");
    }

    #[test]
    fn parses_ssr_live_status_without_play_urls() {
        let html = r#"<script>window.__INITIAL_STATE__ = {"liveroom":{"playList":[{"isLiving":true,"liveStream":{"startTime":"1720000000"}}]}};</script>"#;

        let status = parse_room_live_status_html(html).expect("room status");

        assert!(status.status);
        assert_eq!(status.live_started_at, Some(1_720_000_000_000));
    }

    #[test]
    fn parses_offline_ssr_status_without_retaining_start_time() {
        let html = r#"<script>window.__INITIAL_STATE__ = {"liveroom":{"playList":[{"isLiving":false,"liveStream":{"startTime":"1720000000"}}]}};</script>"#;

        let status = parse_room_live_status_html(html).expect("room status");

        assert!(!status.status);
        assert_eq!(status.live_started_at, None);
    }

    #[test]
    fn parses_ssr_detail_and_prefers_h264_urls() {
        let html = include_str!("../../tests/fixtures/kuaishou_room.html");
        let detail = parse_room_detail_html(html, "creator_123").expect("room detail");
        assert!(detail.status);
        assert_eq!(detail.room_id, "creator_123");
        assert_eq!(detail.user_name, "测试主播");
        assert_eq!(detail.online, 12_000);

        let qualities = parse_play_qualities(&detail.raw).expect("qualities");
        assert_eq!(qualities[0].quality, "超清");
        assert_eq!(
            qualities[0].data.pointer("/urls/0").and_then(Value::as_str),
            Some("https://stream.example/h264-super.flv")
        );
        assert_eq!(
            qualities[0].data.pointer("/urls/1").and_then(Value::as_str),
            Some("https://stream.example/hevc-super.flv")
        );
        assert_eq!(qualities[1].quality, "高清");
    }

    #[test]
    fn search_fallback_selects_closest_game_and_handles_empty_results() {
        let value = json!({
            "data": {
                "list": [
                    {"categoryId": "22196", "title": "英雄联盟手游", "shortName": "LOL手游"},
                    {"categoryId": "1", "title": "英雄联盟", "shortName": "英雄联盟"}
                ]
            }
        });
        assert_eq!(find_search_game_id(&value, "英雄联盟"), Some("1".into()));
        assert_eq!(
            find_search_game_id(&json!({"data": {"list": []}}), "不存在"),
            None
        );
        assert_eq!(
            find_search_game_id(
                &json!({"data": {"list": [{"categoryId": "2", "title": "王者荣耀"}]}}),
                "英雄联盟",
            ),
            None
        );
    }

    #[test]
    fn normalizes_room_url_and_merges_session_cookie() {
        assert_eq!(
            normalize_room_id("https://live.kuaishou.com/u/creator_123?foo=bar").unwrap(),
            "creator_123"
        );
        let cookie = merge_cookie_values("did=old; session=keep", "did=new; client_key=abc");
        assert!(cookie.contains("did=new"));
        assert!(cookie.contains("session=keep"));
        assert!(cookie.contains("client_key=abc"));
    }
}
