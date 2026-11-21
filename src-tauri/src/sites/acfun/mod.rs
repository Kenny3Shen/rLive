//! AcFun 直播站点客户端。
//!
//! AcFun 的公开浏览接口不需要账号 Cookie。真正取流前要先用随机设备号登录
//! 匿名访客，再由 `startPlay` 换取当次直播的分档地址；视频和文章内容由
//! `content` 子模块处理。

pub(crate) mod content;
pub(crate) mod danmaku;

use std::collections::{HashMap, HashSet};

use reqwest::{Client, StatusCode};
use serde_json::Value;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::models::live::{
    LiveCategory, LivePlayQuality, LiveRoomDetail, LiveRoomItem, LiveRoomStatus, LiveSubCategory,
    PlayUrl, RoomListPage, SiteId, parse_live_started_at,
};
use crate::sites::json::{json_i64, json_str};
use crate::sites::traits::LiveSite;

const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const LIVE_ORIGIN: &str = "https://live.acfun.cn";
const LIST_PAGE_SIZE: usize = 30;
const SEARCH_SERVER_PAGE_SIZE: usize = 30;
const CLOSED_RESULT: i64 = 129_004;
const PAID_SHOW_RESULT: i64 = 380_205;

pub struct AcfunSite {
    client: Client,
}

impl Default for AcfunSite {
    fn default() -> Self {
        Self {
            client: crate::http_client::default_client(),
        }
    }
}

impl AcfunSite {
    pub fn new(client: Client) -> Self {
        Self { client }
    }

    fn err(code: &str, message: impl Into<String>) -> AppError {
        AppError::new(code, message).with_site("acfun")
    }

    fn stream_unavailable(message: impl Into<String>) -> AppError {
        Self::err("acfun_stream_unavailable", message)
    }

    fn check_status(status: StatusCode, what: &str) -> AppResult<()> {
        if status == StatusCode::TOO_MANY_REQUESTS {
            return Err(
                Self::err("acfun_rate_limited", format!("{what} 请求过于频繁")).retryable(),
            );
        }
        if status.is_server_error() {
            return Err(Self::err(
                "acfun_network_error",
                format!("{what} 返回 HTTP {}", status.as_u16()),
            )
            .retryable());
        }
        if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
            return Err(Self::err(
                "acfun_risk_control",
                format!("{what} 被 AcFun 拒绝，请稍后重试"),
            )
            .retryable());
        }
        if !status.is_success() {
            return Err(Self::err(
                "acfun_api_error",
                format!("{what} 返回 HTTP {}", status.as_u16()),
            ));
        }
        Ok(())
    }

    async fn get_text(&self, url: reqwest::Url, referer: &str, what: &str) -> AppResult<String> {
        let response = self
            .client
            .get(url)
            .header("user-agent", UA)
            .header("referer", referer)
            .send()
            .await
            .map_err(|error| {
                Self::err(
                    "acfun_network_error",
                    format!(
                        "{what} 请求失败: {}",
                        crate::http_client::describe_request_error(&error)
                    ),
                )
                .retryable()
            })?;
        Self::check_status(response.status(), what)?;
        response.text().await.map_err(|error| {
            Self::err(
                "acfun_network_error",
                format!("{what} 响应读取失败: {error}"),
            )
            .retryable()
        })
    }

    async fn get_json(&self, url: reqwest::Url, what: &str) -> AppResult<Value> {
        let text = self.get_text(url, "https://live.acfun.cn/", what).await?;
        serde_json::from_str(&text)
            .map_err(|_| Self::err("acfun_api_error", format!("{what} 返回了无法识别的数据")))
    }

    async fn live_info(&self, room_id: &str) -> AppResult<Value> {
        let id = room_id.trim();
        if id.is_empty() || !id.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(Self::err(
                "acfun_room_not_found",
                "AcFun 房间号应为主播数字 ID",
            ));
        }
        let mut url =
            reqwest::Url::parse("https://live.acfun.cn/api/live/info").expect("static AcFun URL");
        url.query_pairs_mut().append_pair("authorId", id);
        let value = self.get_json(url, "AcFun 房间信息").await?;
        if json_i64(value.get("result").unwrap_or(&Value::Null)) != 0 {
            return Err(Self::err(
                "acfun_room_not_found",
                format!("AcFun 未找到主播 {id}"),
            ));
        }
        Ok(value)
    }

    async fn listing_once(
        &self,
        count: usize,
        cursor: &str,
        filters: Option<&str>,
    ) -> AppResult<(RoomListPage, String)> {
        let mut url = reqwest::Url::parse("https://live.acfun.cn/api/channel/list")
            .expect("static AcFun URL");
        {
            let mut query = url.query_pairs_mut();
            query
                .append_pair("count", &count.to_string())
                .append_pair("pcursor", cursor);
            if let Some(filters) = filters {
                query.append_pair("filters", filters);
            }
        }
        let value = self.get_json(url, "AcFun 直播列表").await?;
        parse_listing(&value)
    }

    async fn listing_page(
        &self,
        filters: Option<&str>,
        requested_page: u32,
    ) -> AppResult<RoomListPage> {
        let target = requested_page.max(1);
        let mut cursor = String::new();
        for page in 1..=target {
            let (result, next_cursor) = self.listing_once(LIST_PAGE_SIZE, &cursor, filters).await?;
            if page == target {
                return Ok(RoomListPage {
                    has_more: !next_cursor.is_empty() && next_cursor != "no_more",
                    items: result.items,
                });
            }
            if next_cursor.is_empty() || next_cursor == "no_more" {
                return Ok(RoomListPage::empty());
            }
            cursor = next_cursor;
        }
        Ok(RoomListPage::empty())
    }

    async fn visitor_login(&self) -> AppResult<Visitor> {
        let device_id = format!("web_{}", &Uuid::new_v4().simple().to_string()[..16]);
        let response = self
            .client
            .post("https://id.app.acfun.cn/rest/app/visitor/login")
            .header("user-agent", UA)
            .header("referer", "https://live.acfun.cn/")
            .header("cookie", format!("_did={device_id};"))
            .form(&[("sid", "acfun.api.visitor")])
            .send()
            .await
            .map_err(|error| {
                Self::err(
                    "acfun_network_error",
                    format!(
                        "AcFun 访客登录失败: {}",
                        crate::http_client::describe_request_error(&error)
                    ),
                )
                .retryable()
            })?;
        Self::check_status(response.status(), "AcFun 访客登录")?;
        let value: Value = response.json().await.map_err(|error| {
            Self::err(
                "acfun_network_error",
                format!("AcFun 访客登录响应读取失败: {error}"),
            )
            .retryable()
        })?;
        if json_i64(value.get("result").unwrap_or(&Value::Null)) != 0 {
            return Err(Self::err("acfun_risk_control", "AcFun 暂时拒绝匿名访客登录").retryable());
        }
        let user_id = json_str(value.get("userId").unwrap_or(&Value::Null));
        let token = json_str(value.get("acfun.api.visitor_st").unwrap_or(&Value::Null));
        if user_id.is_empty() || token.is_empty() {
            return Err(Self::err("acfun_api_error", "AcFun 访客登录未返回完整凭据"));
        }
        Ok(Visitor {
            user_id,
            device_id,
            token,
            security: json_str(value.get("acSecurity").unwrap_or(&Value::Null)),
        })
    }

    async fn start_play_once(&self, room_id: &str, visitor: &Visitor) -> AppResult<PlaySnapshot> {
        let mut url = reqwest::Url::parse("https://api.kuaishouzt.com/rest/zt/live/web/startPlay")
            .expect("static AcFun stream URL");
        {
            let mut query = url.query_pairs_mut();
            query
                .append_pair("subBiz", "mainApp")
                .append_pair("kpn", "ACFUN_APP")
                .append_pair("kpf", "PC_WEB")
                .append_pair("userId", &visitor.user_id)
                .append_pair("did", &visitor.device_id);
            query.append_pair("acfun.api.visitor_st", &visitor.token);
        }
        let response = self
            .client
            .post(url)
            .header("user-agent", UA)
            .header("referer", "https://live.acfun.cn/")
            .form(&[("authorId", room_id), ("pullStreamType", "FLV")])
            .send()
            .await
            .map_err(|error| {
                Self::err(
                    "acfun_network_error",
                    format!(
                        "AcFun 取流请求失败: {}",
                        crate::http_client::describe_request_error(&error)
                    ),
                )
                .retryable()
            })?;
        Self::check_status(response.status(), "AcFun 取流")?;
        let value: Value = response.json().await.map_err(|error| {
            Self::err(
                "acfun_network_error",
                format!("AcFun 取流响应读取失败: {error}"),
            )
            .retryable()
        })?;
        parse_start_play(&value, visitor.clone())
    }

    async fn start_play(&self, room_id: &str) -> AppResult<PlaySnapshot> {
        for attempt in 0..2 {
            let visitor = self.visitor_login().await?;
            match self.start_play_once(room_id, &visitor).await {
                Ok(play) => return Ok(play),
                Err(error) if error.code == "acfun_paid_stream" => {
                    return Ok(PlaySnapshot {
                        live_id: String::new(),
                        started_at: None,
                        qualities: Vec::new(),
                        restricted: true,
                        visitor: None,
                        tickets: Vec::new(),
                        enter_room_attach: String::new(),
                    });
                }
                Err(error) if attempt == 0 && error.code == "acfun_risk_control" => {
                    continue;
                }
                Err(error) => return Err(error),
            }
        }
        Err(Self::err("acfun_risk_control", "AcFun 暂时拒绝匿名取流"))
    }

    async fn search_authors(
        &self,
        keyword: &str,
        page: u32,
    ) -> AppResult<(Vec<LiveRoomItem>, bool)> {
        let server_page = page.max(1);
        let mut url = reqwest::Url::parse("https://www.acfun.cn/search").expect("static AcFun URL");
        {
            let mut query = url.query_pairs_mut();
            query
                .append_pair("keyword", keyword)
                .append_pair("type", "user")
                .append_pair("pCursor", &server_page.to_string())
                .append_pair("quickViewId", "up-list")
                .append_pair("reqID", "1")
                .append_pair("ajaxpipe", "1");
        }
        let text = self
            .get_text(url, "https://www.acfun.cn/search", "AcFun 主播搜索")
            .await?;
        parse_search_results(&text, server_page)
    }

    async fn matching_live_rooms(&self, keyword: &str) -> Vec<LiveRoomItem> {
        let Ok((page, _)) = self.listing_once(60, "", None).await else {
            return Vec::new();
        };
        let needle = keyword.to_lowercase();
        page.items
            .into_iter()
            .filter(|room| {
                room.room_id.to_lowercase().contains(&needle)
                    || room.user_name.to_lowercase().contains(&needle)
                    || room.title.to_lowercase().contains(&needle)
            })
            .collect()
    }
}

#[derive(Clone)]
struct Visitor {
    user_id: String,
    device_id: String,
    token: String,
    security: String,
}

#[derive(Debug, Clone)]
struct PlayQuality {
    id: String,
    label: String,
    rank: i64,
    urls: Vec<String>,
}

#[derive(Clone)]
struct PlaySnapshot {
    live_id: String,
    started_at: Option<i64>,
    qualities: Vec<PlayQuality>,
    restricted: bool,
    visitor: Option<Visitor>,
    tickets: Vec<String>,
    enter_room_attach: String,
}

fn parse_listing(value: &Value) -> AppResult<(RoomListPage, String)> {
    let data = value.get("channelListData").unwrap_or(value);
    if json_i64(data.get("result").unwrap_or(&Value::Null)) != 0 {
        return Err(AcfunSite::err("acfun_api_error", "AcFun 直播列表返回失败"));
    }
    let list = data
        .get("liveList")
        .and_then(Value::as_array)
        .ok_or_else(|| AcfunSite::err("acfun_api_error", "AcFun 直播列表缺少 liveList"))?;
    let cursor = json_str(data.get("pcursor").unwrap_or(&Value::Null));
    let mut seen = HashSet::new();
    let mut items = Vec::new();
    for room in list {
        let room_id = json_str(
            room.get("authorId")
                .or_else(|| room.get("href"))
                .unwrap_or(&Value::Null),
        );
        if room_id.is_empty() || room_id == "0" || !seen.insert(room_id.clone()) {
            continue;
        }
        let user = room.get("user").unwrap_or(&Value::Null);
        let cover = room
            .get("coverUrls")
            .and_then(Value::as_array)
            .and_then(|urls| urls.first())
            .map(|url| json_str(url))
            .unwrap_or_default();
        items.push(LiveRoomItem {
            site_id: SiteId::Acfun,
            room_id,
            title: json_str(room.get("title").unwrap_or(&Value::Null)),
            cover,
            user_name: json_str(user.get("name").unwrap_or(&Value::Null)),
            online: json_i64(room.get("onlineCount").unwrap_or(&Value::Null)),
            live_status: Some(true),
        });
    }
    Ok((
        RoomListPage {
            has_more: !cursor.is_empty() && cursor != "no_more",
            items,
        },
        cursor,
    ))
}

fn parse_room_detail(
    value: &Value,
    room_id: &str,
    play: Option<PlaySnapshot>,
) -> AppResult<(LiveRoomDetail, Value)> {
    let user = value
        .get("user")
        .filter(|user| user.is_object())
        .ok_or_else(|| {
            AcfunSite::err(
                "acfun_room_not_found",
                format!("AcFun 未找到主播 {room_id}"),
            )
        })?;
    let returned_author = json_str(value.get("authorId").unwrap_or(&Value::Null));
    let returned_user = json_str(user.get("id").unwrap_or(&Value::Null));
    let user_name = json_str(user.get("name").unwrap_or(&Value::Null));
    if user_name.is_empty()
        || returned_author != room_id
        || returned_user != room_id
        || returned_user == "0"
    {
        return Err(AcfunSite::err(
            "acfun_api_error",
            "AcFun 房间信息与请求的主播不一致",
        ));
    }

    let live_id = play
        .as_ref()
        .map(|play| play.live_id.clone())
        .filter(|live_id| !live_id.is_empty())
        .unwrap_or_else(|| json_str(value.get("liveId").unwrap_or(&Value::Null)));
    let status = !live_id.is_empty();
    let started_at = parse_live_started_at(value.get("createTime"))
        .or_else(|| play.as_ref().and_then(|play| play.started_at));
    let avatar = json_str(user.get("headUrl").unwrap_or(&Value::Null));
    let cover = value
        .get("coverUrls")
        .and_then(Value::as_array)
        .and_then(|urls| urls.first())
        .map(|url| json_str(url))
        .filter(|url| !url.is_empty())
        .unwrap_or_else(|| avatar.clone());
    let play_restricted = play.as_ref().is_some_and(|play| play.restricted);
    let qualities = play
        .as_ref()
        .map(|play| play.qualities.clone())
        .unwrap_or_default()
        .into_iter()
        .map(|quality| {
            serde_json::json!({
                "id": quality.id,
                "quality": quality.label,
                "rank": quality.rank,
                "urls": quality.urls,
            })
        })
        .collect::<Vec<_>>();
    let restricted = play_restricted
        || value
            .get("paidShowUuid")
            .is_some_and(|value| !json_str(value).is_empty())
            && value.get("paidShowUserBuyStatus").and_then(Value::as_bool) != Some(true);
    let danmaku_raw = play
        .as_ref()
        .and_then(|play| play.visitor.as_ref().map(|visitor| (play, visitor)))
        .map(|(play, visitor)| {
            serde_json::json!({
                "roomId": room_id,
                "liveId": play.live_id.clone(),
                "userId": visitor.user_id.clone(),
                "deviceId": visitor.device_id.clone(),
                "visitorToken": visitor.token.clone(),
                "security": visitor.security.clone(),
                "tickets": play.tickets.clone(),
                "enterRoomAttach": play.enter_room_attach.clone(),
            })
        })
        .unwrap_or(Value::Null);
    let detail = LiveRoomDetail {
        site_id: SiteId::Acfun,
        room_id: room_id.to_owned(),
        title: json_str(value.get("title").unwrap_or(&Value::Null)),
        cover,
        user_name,
        user_avatar: avatar,
        online: json_i64(value.get("onlineCount").unwrap_or(&Value::Null)),
        status,
        live_started_at: status.then_some(started_at).flatten(),
        notice: decode_html_entities(&json_str(user.get("signature").unwrap_or(&Value::Null))),
        url: format!("https://live.acfun.cn/live/{room_id}"),
        raw: serde_json::json!({
            "liveId": live_id,
            "startedAt": started_at,
            "restricted": restricted,
            "qualities": qualities,
        }),
    };
    Ok((detail, danmaku_raw))
}

/// 重新取得 AcFun 后端弹幕会话。票据或访客会话失效时由弹幕循环调用；
/// 这里复核房间状态并让新访客登录与 `startPlay` 各执行一轮。
pub(crate) async fn refresh_danmaku_raw(
    room_id: &str,
    route: &crate::proxy::ProxyRoute,
) -> AppResult<Value> {
    let client = crate::http_client::client_for_route(route)?;
    let site = AcfunSite::new(client);
    let (_, danmaku) = site.get_room_detail_with_danmaku(room_id).await?;
    Ok(danmaku)
}

fn parse_start_play(value: &Value, visitor: Visitor) -> AppResult<PlaySnapshot> {
    let result = json_i64(value.get("result").unwrap_or(&Value::Null));
    if result == CLOSED_RESULT {
        return Err(AcfunSite::stream_unavailable("AcFun 直播已结束"));
    }
    if result == PAID_SHOW_RESULT {
        return Err(AcfunSite::err(
            "acfun_paid_stream",
            "AcFun 付费直播需要门票",
        ));
    }
    if result != 1 {
        return Err(AcfunSite::err(
            "acfun_risk_control",
            format!("AcFun 取流被拒绝，result={result}"),
        )
        .retryable());
    }
    let data = value
        .get("data")
        .filter(|data| data.is_object())
        .ok_or_else(|| AcfunSite::err("acfun_api_error", "AcFun 取流响应缺少 data"))?;
    let live_id = json_str(data.get("liveId").unwrap_or(&Value::Null));
    if live_id.is_empty() {
        return Err(AcfunSite::err(
            "acfun_api_error",
            "AcFun 取流响应缺少 liveId",
        ));
    }
    let tickets = data
        .get("availableTickets")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|ticket| json_str(ticket))
        .filter(|ticket| !ticket.is_empty())
        .collect();
    let enter_room_attach = json_str(data.get("enterRoomAttach").unwrap_or(&Value::Null));
    Ok(PlaySnapshot {
        live_id,
        started_at: parse_live_started_at(data.get("liveStartTime")),
        qualities: parse_qualities(data.get("videoPlayRes").unwrap_or(&Value::Null))?,
        restricted: false,
        visitor: Some(visitor),
        tickets,
        enter_room_attach,
    })
}

fn parse_qualities(value: &Value) -> AppResult<Vec<PlayQuality>> {
    let owned;
    let value = if let Some(text) = value.as_str() {
        owned = serde_json::from_str::<Value>(text)
            .map_err(|_| AcfunSite::err("acfun_api_error", "AcFun 画质清单不是有效 JSON"))?;
        &owned
    } else {
        value
    };
    let manifests = value
        .get("liveAdaptiveManifest")
        .and_then(Value::as_array)
        .ok_or_else(|| AcfunSite::err("acfun_api_error", "AcFun 画质清单缺少直播间"));
    let manifests = match manifests {
        Ok(manifests) => manifests,
        Err(_) => return Err(AcfunSite::stream_unavailable("AcFun 当前没有可播放画质")),
    };
    let mut qualities: HashMap<String, PlayQuality> = HashMap::new();
    for manifest in manifests {
        let Some(representations) = manifest
            .pointer("/adaptationSet/representation")
            .and_then(Value::as_array)
        else {
            continue;
        };
        for item in representations {
            if item.get("hidden").and_then(Value::as_bool) == Some(true) {
                continue;
            }
            let Some(url) = item.get("url").and_then(Value::as_str) else {
                continue;
            };
            let Ok(parsed) = reqwest::Url::parse(url) else {
                continue;
            };
            if !matches!(parsed.scheme(), "http" | "https")
                || parsed.host_str().is_none()
                || !parsed.username().is_empty()
                || parsed.password().is_some()
            {
                continue;
            }
            let quality_type = json_str(item.get("qualityType").unwrap_or(&Value::Null));
            let id = if quality_type.is_empty() {
                let number = json_i64(item.get("id").unwrap_or(&Value::Null));
                if number <= 0 {
                    continue;
                }
                format!("id:{number}")
            } else {
                quality_type
            };
            let name = json_str(item.get("name").unwrap_or(&Value::Null));
            let label = if name.is_empty() {
                match id.as_str() {
                    "STANDARD" => "高清",
                    "HIGH" => "超清",
                    "SUPER" => "蓝光",
                    "BLUE_RAY" => "高码率",
                    _ => "画质",
                }
                .to_owned()
            } else {
                name
            };
            let level = value_i64_opt(item.get("level"));
            let bitrate = value_i64_opt(item.get("bitrate"));
            let rank = level
                .filter(|level| *level >= 0)
                .map(|level| 1_000_000 + level.min(999_999))
                .unwrap_or_else(|| bitrate.unwrap_or(0).clamp(0, 999_999));
            let quality = qualities.entry(id.clone()).or_insert_with(|| PlayQuality {
                id,
                label,
                rank,
                urls: Vec::new(),
            });
            quality.rank = quality.rank.max(rank);
            if !quality.urls.iter().any(|existing| existing == url) {
                quality.urls.push(url.to_owned());
            }
        }
    }
    if qualities.is_empty() {
        return Err(AcfunSite::stream_unavailable("AcFun 当前没有可播放画质"));
    }
    let mut values = qualities.into_values().collect::<Vec<_>>();
    values.sort_by(|left, right| {
        right
            .rank
            .cmp(&left.rank)
            .then_with(|| left.id.cmp(&right.id))
    });
    Ok(values)
}

fn play_qualities_from_raw(raw: &Value) -> Option<Vec<LivePlayQuality>> {
    let qualities = raw.get("qualities")?.as_array()?;
    let mapped = qualities
        .iter()
        .filter_map(|quality| {
            let id = json_str(quality.get("id").unwrap_or(&Value::Null));
            let label = json_str(quality.get("quality").unwrap_or(&Value::Null));
            let urls = quality.get("urls")?.as_array()?.clone();
            if id.is_empty() || label.is_empty() || urls.is_empty() {
                return None;
            }
            Some(LivePlayQuality {
                quality: label,
                data: serde_json::json!({ "id": id, "urls": urls }),
            })
        })
        .collect::<Vec<_>>();
    (!mapped.is_empty()).then_some(mapped)
}

fn parse_search_results(text: &str, page: u32) -> AppResult<(Vec<LiveRoomItem>, bool)> {
    let json_text = text
        .split_once("/*<!-- fetch-stream -->*/")
        .map(|(json, _)| json)
        .unwrap_or(text);
    let value: Value = serde_json::from_str(json_text.trim())
        .map_err(|_| AcfunSite::err("acfun_api_error", "AcFun 主播搜索返回了无法识别的数据"))?;
    let html = value
        .get("html")
        .and_then(Value::as_str)
        .ok_or_else(|| AcfunSite::err("acfun_api_error", "AcFun 主播搜索缺少结果"))?;
    let total_pattern = regex::Regex::new(r#"class="total-num"[^>]*data-total="([^"]+)""#)
        .expect("valid AcFun total regex");
    let total = total_pattern
        .captures(html)
        .and_then(|captures| captures.get(1))
        .and_then(|value| value.as_str().parse::<usize>().ok())
        .ok_or_else(|| AcfunSite::err("acfun_api_error", "AcFun 主播搜索缺少结果总数"))?;
    let marker = r#"class="search-up""#;
    let starts = html
        .match_indices(marker)
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    let meta_pattern =
        regex::Regex::new(r#"data-up-exposure-log='([^']+)'"#).expect("valid AcFun metadata regex");
    let name_pattern =
        regex::Regex::new(r#"(?s)class="up__main__name[^"]*"[^>]*>\s*<a[^>]*>(.*?)</a>"#)
            .expect("valid AcFun name regex");
    let avatar_pattern = regex::Regex::new(r#"class="up__avatar[^"]*"[^>]*src="([^"]+)""#)
        .expect("valid AcFun avatar regex");
    let mut items = Vec::new();
    let mut seen = HashSet::new();
    for (index, start) in starts.iter().enumerate() {
        let end = starts.get(index + 1).copied().unwrap_or(html.len());
        let block = &html[*start..end];
        let Some(meta_text) = meta_pattern
            .captures(block)
            .and_then(|captures| captures.get(1))
            .map(|value| decode_html_entities(value.as_str()))
        else {
            continue;
        };
        let Ok(meta) = serde_json::from_str::<Value>(&meta_text) else {
            continue;
        };
        let room_id = json_str(meta.get("up_id").unwrap_or(&Value::Null));
        let user_name = name_pattern
            .captures(block)
            .and_then(|captures| captures.get(1))
            .map(|value| strip_tags(&decode_html_entities(value.as_str())))
            .unwrap_or_default();
        if room_id.is_empty()
            || room_id == "0"
            || user_name.is_empty()
            || !seen.insert(room_id.clone())
        {
            continue;
        }
        let live_status = meta
            .get("is_on_live")
            .and_then(|value| value.as_str().map(|value| !value.trim().is_empty()))
            .or_else(|| meta.get("is_on_live").and_then(Value::as_bool));
        let cover = avatar_pattern
            .captures(block)
            .and_then(|captures| captures.get(1))
            .map(|value| value.as_str().to_owned())
            .unwrap_or_default();
        items.push(LiveRoomItem {
            site_id: SiteId::Acfun,
            room_id,
            title: String::new(),
            cover,
            user_name,
            online: 0,
            live_status,
        });
    }
    Ok((items, page as usize * SEARCH_SERVER_PAGE_SIZE < total))
}

fn value_i64_opt(value: Option<&Value>) -> Option<i64> {
    value.and_then(|value| {
        value
            .as_i64()
            .or_else(|| value.as_u64().and_then(|value| i64::try_from(value).ok()))
            .or_else(|| value.as_str()?.trim().parse().ok())
    })
}

fn strip_tags(value: &str) -> String {
    let mut text = String::with_capacity(value.len());
    let mut in_tag = false;
    for character in value.chars() {
        match character {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => text.push(character),
            _ => {}
        }
    }
    text.trim().to_owned()
}

fn decode_html_entities(value: &str) -> String {
    value
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&ensp;", " ")
        .replace("&nbsp;", " ")
}

#[async_trait::async_trait]
impl LiveSite for AcfunSite {
    async fn get_categories(&self) -> AppResult<Vec<LiveCategory>> {
        let mut url = reqwest::Url::parse("https://live.acfun.cn/api/channel/list")
            .expect("static AcFun URL");
        url.query_pairs_mut()
            .append_pair("count", "1")
            .append_pair("pcursor", "");
        let value = self.get_json(url, "AcFun 直播分类").await?;
        let groups = value
            .pointer("/channelFilters/liveChannelDisplayFilters")
            .and_then(Value::as_array)
            .ok_or_else(|| AcfunSite::err("acfun_api_error", "AcFun 直播分类缺少筛选列表"))?;
        let mut children = Vec::new();
        let mut seen = HashSet::new();
        for group in groups {
            let Some(filters) = group.get("displayFilters").and_then(Value::as_array) else {
                continue;
            };
            for filter in filters {
                let filter_type = json_i64(filter.get("filterType").unwrap_or(&Value::Null));
                let filter_id = json_i64(filter.get("filterId").unwrap_or(&Value::Null));
                let name = json_str(filter.get("name").unwrap_or(&Value::Null));
                if filter_type < 0
                    || filter_id <= 0
                    || name.is_empty()
                    || !seen.insert((filter_type, filter_id))
                {
                    continue;
                }
                children.push(LiveSubCategory {
                    id: format!("{filter_type}:{filter_id}"),
                    name,
                    parent_id: "acfun".into(),
                    pic: filter
                        .get("cover")
                        .map(|value| json_str(value))
                        .filter(|value| !value.is_empty()),
                });
            }
        }
        if children.is_empty() {
            return Err(AcfunSite::err("acfun_api_error", "AcFun 直播分类为空"));
        }
        Ok(vec![LiveCategory {
            id: "acfun".into(),
            name: "AcFun 直播".into(),
            children,
        }])
    }

    async fn get_recommend_rooms(&self, page: u32) -> AppResult<RoomListPage> {
        self.listing_page(None, page).await
    }

    async fn get_category_rooms(
        &self,
        category: &LiveSubCategory,
        page: u32,
    ) -> AppResult<RoomListPage> {
        let (filter_type, filter_id) = category
            .id
            .split_once(':')
            .and_then(|(filter_type, filter_id)| {
                Some((
                    filter_type.parse::<i64>().ok()?,
                    filter_id.parse::<i64>().ok()?,
                ))
            })
            .unwrap_or((1, category.id.parse::<i64>().ok().unwrap_or(0)));
        if filter_type < 0 || filter_id <= 0 {
            return Err(AcfunSite::err(
                "acfun_category_not_found",
                "未知的 AcFun 直播分区",
            ));
        }
        let filters = serde_json::json!([{
            "filterType": filter_type,
            "filterId": filter_id,
        }])
        .to_string();
        self.listing_page(Some(&filters), page).await
    }

    async fn search_rooms(&self, keyword: &str, page: u32) -> AppResult<RoomListPage> {
        let keyword = keyword.trim();
        if keyword.is_empty() {
            return Ok(RoomListPage::empty());
        }
        let (mut items, authors_have_more) = self.search_authors(keyword, page).await?;
        if page <= 1 {
            items.extend(self.matching_live_rooms(keyword).await);
        }
        let mut seen = HashSet::new();
        items.retain(|room| seen.insert(room.room_id.clone()));
        Ok(RoomListPage {
            has_more: authors_have_more,
            items,
        })
    }

    async fn get_room_live_status(&self, room_id: &str) -> AppResult<LiveRoomStatus> {
        let value = self.live_info(room_id).await?;
        let status = !json_str(value.get("liveId").unwrap_or(&Value::Null)).is_empty();
        Ok(LiveRoomStatus {
            status,
            live_started_at: status
                .then(|| parse_live_started_at(value.get("createTime")))
                .flatten(),
        })
    }

    async fn get_room_detail(&self, room_id: &str) -> AppResult<LiveRoomDetail> {
        self.get_room_detail_with_danmaku(room_id)
            .await
            .map(|(detail, _)| detail)
    }

    async fn get_room_detail_with_danmaku(
        &self,
        room_id: &str,
    ) -> AppResult<(LiveRoomDetail, Value)> {
        let room_id = room_id.trim();
        let value = self.live_info(room_id).await?;
        let live = !json_str(value.get("liveId").unwrap_or(&Value::Null)).is_empty();
        let play = if live {
            Some(self.start_play(room_id).await?)
        } else {
            None
        };
        parse_room_detail(&value, room_id, play)
    }

    async fn get_play_qualities(&self, detail: &LiveRoomDetail) -> AppResult<Vec<LivePlayQuality>> {
        if !detail.status {
            return Err(AcfunSite::stream_unavailable("AcFun 主播当前未开播"));
        }
        if detail.raw.get("restricted").and_then(Value::as_bool) == Some(true) {
            return Err(AcfunSite::stream_unavailable("AcFun 付费直播需要门票"));
        }
        if let Some(qualities) = play_qualities_from_raw(&detail.raw) {
            return Ok(qualities);
        }
        let play = self.start_play(&detail.room_id).await?;
        let qualities = play.qualities;
        if qualities.is_empty() {
            return Err(AcfunSite::stream_unavailable("AcFun 当前没有可播放画质"));
        }
        Ok(qualities
            .into_iter()
            .map(|quality| LivePlayQuality {
                quality: quality.label,
                data: serde_json::json!({ "id": quality.id, "urls": quality.urls }),
            })
            .collect())
    }

    async fn get_play_urls(
        &self,
        detail: &LiveRoomDetail,
        quality: &LivePlayQuality,
    ) -> AppResult<Vec<PlayUrl>> {
        let urls = quality
            .data
            .get("urls")
            .and_then(Value::as_array)
            .ok_or_else(|| AcfunSite::stream_unavailable("AcFun 画质缺少播放地址"))?;
        let mut headers = HashMap::new();
        headers.insert("user-agent".into(), UA.into());
        headers.insert("referer".into(), format!("{LIVE_ORIGIN}/"));
        headers.insert("origin".into(), LIVE_ORIGIN.into());
        let mut hosts = HashMap::<String, usize>::new();
        let mut outputs = Vec::new();
        for (index, value) in urls.iter().enumerate() {
            let url = json_str(value);
            let Ok(parsed) = reqwest::Url::parse(&url) else {
                continue;
            };
            let host = parsed.host_str().unwrap_or("acfun").to_owned();
            let count = hosts.entry(host.clone()).or_default();
            *count += 1;
            let source_id = if *count == 1 {
                host
            } else {
                format!("{host}#{}", *count)
            };
            outputs.push(PlayUrl::inferred(
                source_id,
                format!("线路 {}", index + 1),
                index as u32,
                url,
                headers.clone(),
            ));
        }
        if outputs.is_empty() {
            return Err(AcfunSite::stream_unavailable(
                "AcFun 画质没有可用的播放地址",
            ));
        }
        let _ = detail;
        Ok(outputs)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_channel_cards_and_cursor() {
        let value = serde_json::json!({
            "channelListData": {
                "result": 0,
                "pcursor": "next-page",
                "liveList": [{
                    "authorId": 23682490,
                    "href": "23682490",
                    "title": "加班后的交换生",
                    "coverUrls": ["https://imgs.aixifan.com/live.jpg"],
                    "onlineCount": 327,
                    "user": {"id": "23682490", "name": "AC娘本体"}
                }]
            }
        });
        let (page, cursor) = parse_listing(&value).unwrap();
        assert_eq!(cursor, "next-page");
        assert!(page.has_more);
        assert_eq!(page.items[0].site_id, SiteId::Acfun);
        assert_eq!(page.items[0].room_id, "23682490");
        assert_eq!(page.items[0].user_name, "AC娘本体");
        assert_eq!(page.items[0].online, 327);
    }

    #[test]
    fn parses_start_play_qualities_in_stable_order() {
        let value = serde_json::json!({
            "result": 1,
            "data": {
                "liveId": "live-id",
                "liveStartTime": 1_704_067_200_000_i64,
                "availableTickets": ["ticket-a", "ticket-b"],
                "enterRoomAttach": "room-attach",
                "videoPlayRes": "{\"liveAdaptiveManifest\":[{\"adaptationSet\":{\"representation\":[{\"qualityType\":\"HIGH\",\"name\":\"超清\",\"level\":50,\"bitrate\":2000,\"url\":\"https://cdn.example/high.flv\"},{\"qualityType\":\"BLUE_RAY\",\"name\":\"蓝光 8M\",\"level\":130,\"bitrate\":8000,\"url\":\"https://cdn.example/source.flv\"},{\"qualityType\":\"HIGH\",\"name\":\"超清\",\"level\":50,\"bitrate\":2000,\"url\":\"https://cdn.example/high.flv\"}]}}]}"
            }
        });
        let visitor = Visitor {
            user_id: "100".into(),
            device_id: "web_device".into(),
            token: "visitor-token".into(),
            security: "AAAAAAAAAAAAAAAAAAAAAA==".into(),
        };
        let play = parse_start_play(&value, visitor).unwrap();
        assert_eq!(play.live_id, "live-id");
        assert_eq!(play.tickets, ["ticket-a", "ticket-b"]);
        assert_eq!(play.enter_room_attach, "room-attach");
        assert_eq!(play.started_at, Some(1_704_067_200_000));
        assert_eq!(play.qualities.len(), 2);
        assert_eq!(play.qualities[0].label, "蓝光 8M");
        assert_eq!(play.qualities[1].urls.len(), 1);
    }

    #[test]
    fn parses_offline_room_without_play_data() {
        let value = serde_json::json!({
            "result": 0,
            "authorId": 42,
            "liveId": "",
            "title": "",
            "user": {
                "id": "42",
                "name": "离线主播",
                "headUrl": "https://imgs.aixifan.com/avatar.png",
                "signature": "简介 &amp; 资料"
            }
        });
        let (room, _) = parse_room_detail(&value, "42", None).unwrap();
        assert!(!room.status);
        assert!(room.live_started_at.is_none());
        assert_eq!(room.notice, "简介 & 资料");
        assert!(play_qualities_from_raw(&room.raw).is_none());
    }

    #[test]
    fn search_parser_keeps_live_status_and_escaped_names() {
        let html = r#"<span class="total-num" data-total="31">共31条结果</span><div class="search-up" data-up-exposure-log='{"up_id":42,"is_on_live":"live-id"}'><img class="up__avatar" src="https://imgs.aixifan.com/a.jpg"><div class="up__main__name"><a href="/u/42">主播 &amp; 名称</a></div></div><div class="search-up" data-up-exposure-log='{"up_id":43,"is_on_live":""}'><img class="up__avatar" src="https://imgs.aixifan.com/b.jpg"><div class="up__main__name"><a href="/u/43">未开播主播</a></div></div>"#;
        let response = serde_json::json!({ "html": html }).to_string();
        let (items, has_more) = parse_search_results(&response, 1).unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].user_name, "主播 & 名称");
        assert_eq!(items[0].live_status, Some(true));
        assert_eq!(items[1].live_status, Some(false));
        assert!(has_more);
    }
}
