//! Bilibili 直播 API 的纯解析器与底层辅助函数。

use std::collections::{BTreeMap, HashSet};
use std::sync::LazyLock;
use std::time::{SystemTime, UNIX_EPOCH};

use md5::{Digest, Md5};
use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};
use regex::Regex;
use serde_json::Value;

use crate::danmu_rs::bilibili::cookie_value;
use crate::error::{AppError, AppResult};
use crate::models::live::{
    LiveCategory, LivePlayQuality, LiveRoomDetail, LiveRoomItem, LiveRoomStatus, LiveSubCategory,
    PlayUrl, RoomListPage, SiteId, accept_room_id, parse_live_started_at,
};

pub const DEFAULT_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0";
pub const DEFAULT_REFERER: &str = "https://live.bilibili.com/";

/// Bilibili WBI 签名用的字符乱序表（上游的 mixinKeyEncTab）。
const MIXIN_KEY_ENC_TAB: [usize; 64] = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29,
    28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25,
    54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

// ---------------------------------------------------------------------------
// JSON 辅助函数
// ---------------------------------------------------------------------------

pub(super) fn as_str(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        other => other.to_string().trim_matches('"').to_string(),
    }
}

pub(super) fn as_i64(v: &Value) -> i64 {
    match v {
        Value::Number(n) => n.as_i64().unwrap_or(0),
        Value::String(s) => s.parse().unwrap_or(0),
        _ => 0,
    }
}

fn json_err(msg: impl Into<String>) -> AppError {
    AppError::new("bilibili_parse_error", msg).with_site("bilibili")
}

/// 去除 Bilibili 搜索结果中的高亮标签，如 `<em class="keyword">`。
/// 与原手写扫描一致：任何包含 `em`（不区分 ASCII 大小写）的标签都会被剥除。
pub fn strip_em_tags(s: &str) -> String {
    static EM_TAG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<[^>]*[eE][mM][^>]*>").unwrap());
    EM_TAG.replace_all(s, "").into_owned()
}

fn cover_thumb(cover: &str, suffix: &str) -> String {
    if cover.is_empty() {
        return String::new();
    }
    if cover.starts_with("//") {
        format!("https:{cover}{suffix}")
    } else if cover.starts_with("http://") || cover.starts_with("https://") {
        format!("{cover}{suffix}")
    } else {
        format!("https:{cover}{suffix}")
    }
}

/// 把 Bilibili 的头像字段转换为安全、可直接加载的图片 URL。
///
/// API 可能返回协议相对形式的 `//i0.hdslb.com/...`。它相对于 Tauri 自定义
/// WebView 协议不是有效地址，因此在交给前端之前总是补全协议。
/// CDN 缩放后缀之后若还有 query/fragment，保持原样，
/// 而不是把后缀追加到 query 字符串上。
pub(super) fn avatar_thumb(face: &str) -> String {
    let face = face.trim();
    if face.is_empty() {
        return String::new();
    }

    let split_at = face
        .char_indices()
        .find_map(|(index, ch)| matches!(ch, '?' | '#').then_some(index))
        .unwrap_or(face.len());
    let (path, tail) = face.split_at(split_at);
    let path = if let Some(path) = path.strip_prefix("//") {
        format!("https://{path}")
    } else if let Some(path) = path.strip_prefix("http://") {
        format!("https://{path}")
    } else if path.starts_with("https://") {
        path.to_string()
    } else {
        format!("https://{path}")
    };

    // 当上游响应已经过缩放时，不要重复追加 CDN 变换。
    // 最后一段是 Bilibili 唯一使用 `@...` 变换的部分。
    let has_transform = path
        .rsplit('/')
        .next()
        .is_some_and(|segment| segment.contains('@'));
    if has_transform {
        format!("{path}{tail}")
    } else {
        format!("{path}@100w_100h.webp{tail}")
    }
}

// ---------------------------------------------------------------------------
// 纯解析器（可用夹具测试）
// ---------------------------------------------------------------------------

/// 解析 `room/v1/Area/getList` 响应 body。
pub fn parse_categories(raw: &str) -> AppResult<Vec<LiveCategory>> {
    let root: Value =
        serde_json::from_str(raw).map_err(|e| json_err(format!("categories json: {e}")))?;
    let data = root
        .get("data")
        .and_then(|d| d.as_array())
        .ok_or_else(|| json_err("categories: missing data array"))?;

    let mut categories = Vec::with_capacity(data.len());
    for item in data {
        let mut children = Vec::new();
        if let Some(list) = item.get("list").and_then(|l| l.as_array()) {
            for sub in list {
                let pic_raw = as_str(sub.get("pic").unwrap_or(&Value::Null));
                let pic = if pic_raw.is_empty() {
                    None
                } else {
                    Some(format!("{pic_raw}@100w.png"))
                };
                children.push(LiveSubCategory {
                    id: as_str(sub.get("id").unwrap_or(&Value::Null)),
                    name: as_str(sub.get("name").unwrap_or(&Value::Null)),
                    parent_id: as_str(sub.get("parent_id").unwrap_or(&Value::Null)),
                    pic,
                });
            }
        }
        categories.push(LiveCategory {
            id: as_str(item.get("id").unwrap_or(&Value::Null)),
            name: as_str(item.get("name").unwrap_or(&Value::Null)),
            children,
        });
    }
    Ok(categories)
}

fn room_item_from_list_obj(item: &Value) -> LiveRoomItem {
    let cover_raw = item
        .get("cover")
        .or_else(|| item.get("user_cover"))
        .or_else(|| item.get("system_cover"))
        .map(as_str)
        .unwrap_or_default();
    let cover = if cover_raw.is_empty() {
        String::new()
    } else {
        cover_thumb(&cover_raw, "@400w.jpg")
    };
    LiveRoomItem {
        site_id: SiteId::Bilibili,
        room_id: as_str(
            item.get("roomid")
                .or_else(|| item.get("room_id"))
                .unwrap_or(&Value::Null),
        ),
        title: as_str(item.get("title").unwrap_or(&Value::Null)),
        cover,
        user_name: as_str(item.get("uname").unwrap_or(&Value::Null)),
        online: as_i64(item.get("online").unwrap_or(&Value::Null)),
        live_status: None,
    }
}

/// 解析 `room/v1/Area/getRoomList` body。`page_size` 默认为 30（用于 has_more）。
pub fn parse_category_rooms(raw: &str, page_size: usize) -> AppResult<RoomListPage> {
    let root: Value =
        serde_json::from_str(raw).map_err(|e| json_err(format!("category rooms: {e}")))?;
    let data = root
        .get("data")
        .and_then(|d| d.as_array())
        .cloned()
        .unwrap_or_default();
    let has_more = data.len() >= page_size;
    let items = data.iter().map(room_item_from_list_obj).collect();
    Ok(RoomListPage { has_more, items })
}

/// 解析推荐 `getListByArea` body。
pub fn parse_recommend_rooms(raw: &str) -> AppResult<RoomListPage> {
    let root: Value = serde_json::from_str(raw).map_err(|e| json_err(format!("recommend: {e}")))?;
    let list = root
        .pointer("/data/list")
        .and_then(|d| d.as_array())
        .cloned()
        .unwrap_or_default();
    let has_more = !list.is_empty();
    let items = list.iter().map(room_item_from_list_obj).collect();
    Ok(RoomListPage { has_more, items })
}

/// 解析直播首页推荐 `webMain/getMoreRecList` body。
///
/// 与 [`parse_account_recommend_rooms`] 的区别：这条接口只有一条扁平列表，
/// 但**有真游标**（`page` 逐页推进，实测相邻页互斥），因此 `has_more` 反映
/// 上游是否还能继续给货，而不是「恒为假」。
///
/// 实测该接口可能返回空列表（已见 `n=1` 与 `n=0`），此时 `has_more` 为假，
/// 前端无限滚动会正常停下。
///
/// 设备端与已关注主播的置顶条目混在同一列表里，不做额外分组：rLive 首页是
/// 单一房间网格，保持上游顺序即可。
pub fn parse_live_more_recommend_rooms(raw: &str) -> AppResult<RoomListPage> {
    let root: Value =
        serde_json::from_str(raw).map_err(|e| json_err(format!("live more recommend: {e}")))?;
    let list = root
        .pointer("/data/recommend_room_list")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let mut seen_room_ids = std::collections::HashSet::new();
    let mut items = Vec::new();
    for room in &list {
        let item = room_item_from_list_obj(room);
        if !item.room_id.is_empty() && seen_room_ids.insert(item.room_id.clone()) {
            items.push(item);
        }
    }

    Ok(RoomListPage {
        has_more: !list.is_empty(),
        items,
    })
}

/// 判断直播首页推荐负载是否真的走了账号推荐引擎。
///
/// 这两条接口对**无效令牌也返回 `code=0`**（静默降级为匿名／回退流，与
/// `app.bilibili.com` 的 feed 同一行为，已实测），因此业务码无法用于判定
/// 凭据好坏。唯一可靠的观测是每条的 `trackid`：推荐引擎命中时以
/// `live_feed_0.router-live-…` 开头，降级流则是 `rec-fallback-live-…` 或空串。
///
/// 返回 `false` 时调用方应当回退到不需要凭据的路径，而不是把匿名流当成
/// 个性化结果展示给用户。
pub fn live_recommend_is_personalized(raw: &str) -> bool {
    const PERSONALIZED_PREFIX: &str = "live_feed_0.router-live";
    let Ok(root) = serde_json::from_str::<Value>(raw) else {
        return false;
    };
    let Some(data) = root.get("data") else {
        return false;
    };
    let mut lists: Vec<&Vec<Value>> = Vec::new();
    if let Some(list) = data.get("recommend_room_list").and_then(Value::as_array) {
        lists.push(list);
    }
    if let Some(modules) = data.get("room_list").and_then(Value::as_array) {
        for module in modules {
            if let Some(list) = module.get("list").and_then(Value::as_array) {
                lists.push(list);
            }
        }
    }
    lists.into_iter().flatten().any(|room| {
        room.get("trackid")
            .and_then(Value::as_str)
            .is_some_and(|track| track.starts_with(PERSONALIZED_PREFIX))
    })
}

/// 解析凭据路径的直播首页推荐（`index/getList`）。
///
/// 与 [`parse_account_recommend_rooms`] 只差一个字段：**`has_more` 翻成真**。
/// 该接口本身无游标，但凭据路径的续页走另一条有真游标的接口
/// （`webMain/getMoreRecList`），因此首页不宣告「还有下一页」时，前端无限滚动
/// 永远走不到第 2 页 —— 续页实现会变成死代码（Windows debug 实机踩过：
/// 表现是「授权了但只能看一屏」）。
///
/// 这个转换刻意放在站点层而不是解析器里：匿名与 Cookie 路径仍是单页，
/// 解析器保持上游语义不变。
pub fn parse_live_credential_home_rooms(raw: &str) -> AppResult<RoomListPage> {
    let mut page = parse_account_recommend_rooms(raw)?;
    page.has_more = !page.items.is_empty();
    Ok(page)
}

/// 解析 Bilibili 直播已登录首页的 `index/getList` 负载。
///
/// 首页由顶部一小条推荐位加个性化模块组成。rLive 首页是单一房间网格，
/// 因此保留其展示顺序、摊平模块列表并去除重复房间。
/// 该接口不提供稳定的下一页游标，
/// 因此刻意只做单页结果。
pub fn parse_account_recommend_rooms(raw: &str) -> AppResult<RoomListPage> {
    let root: Value =
        serde_json::from_str(raw).map_err(|e| json_err(format!("account recommend: {e}")))?;
    let data = root
        .get("data")
        .and_then(Value::as_object)
        .ok_or_else(|| json_err("account recommend: missing data object"))?;

    let mut seen_room_ids = std::collections::HashSet::new();
    let mut items = Vec::new();
    let mut append_room = |room: &Value| {
        let item = room_item_from_list_obj(room);
        if !item.room_id.is_empty() && seen_room_ids.insert(item.room_id.clone()) {
            items.push(item);
        }
    };

    if let Some(rooms) = data.get("recommend_room_list").and_then(Value::as_array) {
        for room in rooms {
            append_room(room);
        }
    }
    if let Some(modules) = data.get("room_list").and_then(Value::as_array) {
        for module in modules {
            if let Some(rooms) = module.get("list").and_then(Value::as_array) {
                for room in rooms {
                    append_room(room);
                }
            }
        }
    }

    Ok(RoomListPage {
        has_more: false,
        items,
    })
}

/// 解析搜索 `live` 类型 body。
///
/// 响应携带两个互不相交的数组：`live_room` 只含在播房间，`live_user` 则是命中
/// 关键词的主播，多数未开播。两者都收，用 `live_status` 显式区分，让调用方能把
/// 在播房间排在前面。`live_user` 不带直播标题和封面，这里退回主播头像，
/// 避免卡片只剩一个空白方块。
///
/// `live_user` 不随 `page` 变化（实测同一关键词的第 1~3 页返回完全相同的一批
/// 主播），所以只在第一页读它，后续页只追加新的在播房间。
pub fn parse_search_rooms(raw: &str, page: u32) -> AppResult<RoomListPage> {
    let root: Value = serde_json::from_str(raw).map_err(|e| json_err(format!("search: {e}")))?;
    let rooms = search_result_array(&root, "live_room");
    let users = if page <= 1 {
        search_result_array(&root, "live_user")
    } else {
        Vec::new()
    };
    let mut items = Vec::with_capacity(rooms.len() + users.len());
    let mut seen = HashSet::new();

    for item in rooms.iter().chain(users.iter()) {
        let room_id = as_str(item.get("roomid").unwrap_or(&Value::Null));
        if !accept_room_id(&room_id, &mut seen) {
            continue;
        }
        // 按响应里的取值判断，而不是按来自哪个数组：`live_room` 目前全是在播，
        // 但上游哪天开始混排时，这里不该静默说谎。
        let live = as_i64(item.get("live_status").unwrap_or(&Value::Null)) == 1;
        let cover_raw = as_str(item.get("cover").unwrap_or(&Value::Null));
        let cover = if cover_raw.is_empty() {
            avatar_thumb(&as_str(item.get("uface").unwrap_or(&Value::Null)))
        } else {
            cover_thumb(&cover_raw, "@400w.jpg")
        };
        items.push(LiveRoomItem {
            site_id: SiteId::Bilibili,
            room_id,
            title: strip_em_tags(&as_str(item.get("title").unwrap_or(&Value::Null))),
            cover,
            user_name: strip_em_tags(&as_str(item.get("uname").unwrap_or(&Value::Null))),
            online: as_i64(item.get("online").unwrap_or(&Value::Null)),
            live_status: Some(live),
        });
    }

    // 翻页只看在播房间数组：`live_user` 只在第一页读，把它算进翻页条件
    // 会让滚动永不停止。
    Ok(RoomListPage {
        has_more: rooms.len() >= 40,
        items,
    })
}

fn search_result_array(root: &Value, key: &str) -> Vec<Value> {
    root.pointer(&format!("/data/result/{key}"))
        .and_then(|d| d.as_array())
        .cloned()
        .unwrap_or_default()
}

/// 把 `getInfoByRoom` 的 data 对象解析为 LiveRoomDetail。
/// `danmaku` 为可选 JSON，存放 token/主机列表到 `raw` 中。
#[cfg(test)]
fn parse_room_detail(
    room_info_root: &str,
    danmaku: Option<&Value>,
    buvid3: &str,
    cookie: &str,
) -> AppResult<LiveRoomDetail> {
    let root: Value =
        serde_json::from_str(room_info_root).map_err(|e| json_err(format!("room info: {e}")))?;
    let data = root
        .get("data")
        .cloned()
        .ok_or_else(|| json_err("room info: missing data"))?;
    parse_room_detail_from_data(&data, danmaku, buvid3, cookie)
}

pub fn parse_room_detail_from_data(
    data: &Value,
    danmaku: Option<&Value>,
    buvid3: &str,
    cookie: &str,
) -> AppResult<LiveRoomDetail> {
    let room = data.get("room_info").cloned().unwrap_or(Value::Null);
    let anchor = data
        .pointer("/anchor_info/base_info")
        .cloned()
        .unwrap_or(Value::Null);

    let real_room_id = as_str(room.get("room_id").unwrap_or(&Value::Null));
    let face = as_str(anchor.get("face").unwrap_or(&Value::Null));
    let user_avatar = avatar_thumb(&face);

    let mut server_hosts: Vec<String> = Vec::new();
    let mut token = String::new();
    if let Some(d) = danmaku {
        token = as_str(d.get("token").unwrap_or(&Value::Null));
        if let Some(hosts) = d.get("host_list").and_then(|h| h.as_array()) {
            for h in hosts {
                let host = as_str(h.get("host").unwrap_or(&Value::Null));
                if !host.is_empty() {
                    server_hosts.push(host);
                }
            }
        }
    }
    let server_host = server_hosts
        .first()
        .cloned()
        .unwrap_or_else(|| "broadcastlv.chat.bilibili.com".into());

    // WS 认证用的观众 mid（来自 cookie DedeUserID），不是主播 uid。
    let viewer_uid: i64 = cookie_value(cookie, "DedeUserID")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);

    let room_id_num: i64 = real_room_id
        .parse()
        .unwrap_or_else(|_| as_i64(room.get("room_id").unwrap_or(&Value::Null)));

    let raw = serde_json::json!({
        "room_id": room_id_num,
        "uid": as_str(room.get("uid").unwrap_or(&Value::Null)),
        "danmaku": {
            "token": token,
            "server_host": server_host,
            "server_hosts": server_hosts,
            "buvid": buvid3,
            "cookie": cookie,
            "viewer_uid": viewer_uid,
        },
        "area_id": as_str(room.get("area_id").unwrap_or(&Value::Null)),
        "area_name": as_str(room.get("area_name").unwrap_or(&Value::Null)),
        "parent_area_id": as_str(room.get("parent_area_id").unwrap_or(&Value::Null)),
        "parent_area_name": as_str(room.get("parent_area_name").unwrap_or(&Value::Null)),
        "live_start_time": as_str(room.get("live_start_time").unwrap_or(&Value::Null)),
        "description": as_str(room.get("description").unwrap_or(&Value::Null)),
    });

    Ok(LiveRoomDetail {
        site_id: SiteId::Bilibili,
        room_id: real_room_id.clone(),
        title: as_str(room.get("title").unwrap_or(&Value::Null)),
        cover: as_str(room.get("cover").unwrap_or(&Value::Null)),
        user_name: as_str(anchor.get("uname").unwrap_or(&Value::Null)),
        user_avatar,
        online: as_i64(room.get("online").unwrap_or(&Value::Null)),
        status: as_i64(room.get("live_status").unwrap_or(&Value::Null)) == 1,
        live_started_at: parse_live_started_at(room.get("live_start_time")),
        notice: String::new(),
        url: format!("https://live.bilibili.com/{real_room_id}"),
        raw,
    })
}

/// JSON 值的形状。诊断日志只记录这个，不记录任何字段内容。
fn json_shape(value: Option<&Value>) -> &'static str {
    match value {
        None => "missing",
        Some(Value::Null) => "null",
        Some(Value::Object(_)) => "object",
        Some(Value::Array(_)) => "array",
        Some(Value::String(_)) => "string",
        Some(Value::Bool(_)) => "bool",
        Some(Value::Number(_)) => "number",
    }
}

/// 诊断用的房间号：只放行长度受限的纯 ASCII 数字串，
/// 避免把 token、URL 等任意字符串写进日志。
pub(super) fn diagnostic_room_id_str(text: &str) -> &str {
    let digits = !text.is_empty() && text.len() <= 20 && text.bytes().all(|b| b.is_ascii_digit());
    if digits { text } else { "" }
}

fn diagnostic_room_id(data: &Value) -> String {
    match data.get("room_id") {
        Some(Value::Number(number)) if number.as_u64().is_some_and(|id| id > 0) => {
            number.to_string()
        }
        Some(Value::String(room_id)) => diagnostic_room_id_str(room_id).to_string(),
        _ => String::new(),
    }
}

/// 记录一次播放信息失败。字段是 allowlist：房间号、开播状态与 JSON 形状。
///
/// 不记录 query、Cookie、响应正文、上游 message 或任何播放 token。
fn log_play_info_failure(
    data: &Value,
    playurl_info: &'static str,
    playurl: &'static str,
    error_code: &str,
) {
    tracing::warn!(
        room_id = %diagnostic_room_id(data),
        live_status = ?data.get("live_status").and_then(|v| v.as_i64()),
        playurl_info,
        playurl,
        error_code,
        "bilibili play info unavailable"
    );
}

/// 上游明确表示没有可播放直播流时的分类错误。
///
/// 只采信显式布尔值和显式数字：字段缺失、类型不符、`pwd_verified = false`
/// 单独出现都不足以断定上锁，一律落回可重试的 `bilibili_play_info`。
fn play_info_unavailable(data: &Value) -> AppError {
    let explicit_true = |key: &str| data.get(key).and_then(Value::as_bool) == Some(true);
    let pwd_verified = data.get("pwd_verified").and_then(Value::as_bool);

    // 只有 `is_locked` 明确为 true，或 `encrypted` 明确为 true 且密码尚未验证时才解释为受限。
    if explicit_true("is_locked") || (explicit_true("encrypted") && pwd_verified != Some(true)) {
        return AppError::new("bilibili_room_locked", "该直播间当前受限，无法获取播放地址")
            .with_site("bilibili");
    }
    if explicit_true("is_hidden") {
        return AppError::new(
            "bilibili_room_hidden",
            "该直播间当前不可见，无法获取播放地址",
        )
        .with_site("bilibili");
    }

    match data.get("live_status").and_then(Value::as_i64) {
        Some(0) => AppError::new("bilibili_not_live", "该直播间当前未开播，无法获取播放地址")
            .with_site("bilibili"),
        Some(2) => AppError::new(
            "bilibili_room_round",
            "该直播间正在轮播，暂无可用的直播播放地址",
        )
        .with_site("bilibili"),
        _ => AppError::new("bilibili_play_info", "B站播放信息响应异常，请稍后重试")
            .with_site("bilibili")
            .retryable(),
    }
}

/// 从 getRoomPlayInfo 响应中提取 playurl map。
///
/// 缺失、`null` 或非对象都不能当成可播放结果。失败分类与 WARN 只在这里
/// 落一次，两个解析器共用，避免 qualities / urls 各记一遍。
pub fn read_playurl(result: &Value) -> AppResult<&Value> {
    let data = result.get("data").unwrap_or(&Value::Null);
    let playurl_info = json_shape(result.pointer("/data/playurl_info"));
    let playurl = result.pointer("/data/playurl_info/playurl");

    if let Some(value @ Value::Object(_)) = playurl {
        return Ok(value);
    }

    let error = play_info_unavailable(data);
    log_play_info_failure(data, playurl_info, json_shape(playurl), &error.code);
    Err(error)
}

/// 解析 play-info 根 JSON；失败时落 WARN，错误信息与日志都不带 serde 原文本。
///
/// message 会直接展示给用户，因此固定为中文；`scope` 只作为日志字段，
/// 不拼进 message。
fn parse_play_root(raw: &str, scope: &'static str) -> AppResult<Value> {
    serde_json::from_str(raw).map_err(|_| {
        let error = json_err("B站播放信息响应无法解析，请稍后重试");
        tracing::warn!(
            error_code = %error.code,
            scope,
            playurl = "invalid_json",
            "bilibili play info parse failed"
        );
        error
    })
}

/// 从 play-info 响应解析画质列表。
pub fn parse_play_qualities(raw: &str) -> AppResult<Vec<LivePlayQuality>> {
    let root = parse_play_root(raw, "play qualities")?;
    let data = root.get("data").unwrap_or(&Value::Null);
    let playurl = read_playurl(&root)?;

    let mut qualities_map: BTreeMap<i64, String> = BTreeMap::new();
    if let Some(desc) = playurl.get("g_qn_desc").and_then(|d| d.as_array()) {
        for item in desc {
            let qn = as_i64(item.get("qn").unwrap_or(&Value::Null));
            let name = as_str(item.get("desc").unwrap_or(&Value::Null));
            qualities_map.insert(qn, name);
        }
    }

    let accepted: Vec<i64> = playurl
        .pointer("/stream/0/format/0/codec/0/accept_qn")
        .and_then(|a| a.as_array())
        .map(|arr| arr.iter().map(as_i64).collect())
        .unwrap_or_default();

    let mut qualities = Vec::new();
    for qn in accepted {
        let quality = qualities_map
            .get(&qn)
            .cloned()
            .unwrap_or_else(|| "未知清晰度".into());
        qualities.push(LivePlayQuality {
            quality,
            data: Value::Number(qn.into()),
        });
    }

    if qualities.is_empty() {
        // 上游已明确表示未开播/轮播/受限/不可见时，与 urls 链路给同一分类；
        // 其余未知情况（如 live_status 1 但缺 accept_qn）保留清晰度专用错误。
        let business = play_info_unavailable(data);
        let error = if business.code != "bilibili_play_info" {
            business
        } else {
            AppError::new(
                "bilibili_play_qualities_empty",
                "B站暂时无法获取播放清晰度，请稍后重试",
            )
            .with_site("bilibili")
            .retryable()
        };
        log_play_info_failure(data, "object", "object", &error.code);
        return Err(error);
    }
    Ok(qualities)
}

/// 从 play-info 响应解析播放地址（含选定的 qn）。
pub fn parse_play_urls(raw: &str) -> AppResult<Vec<PlayUrl>> {
    let root = parse_play_root(raw, "play urls")?;
    let data = root.get("data").unwrap_or(&Value::Null);
    let playurl = read_playurl(&root)?;
    let mut urls: Vec<String> = Vec::new();

    let streams = playurl
        .get("stream")
        .and_then(|s| s.as_array())
        .cloned()
        .unwrap_or_default();
    for stream in streams {
        let formats = stream
            .get("format")
            .and_then(|f| f.as_array())
            .cloned()
            .unwrap_or_default();
        for format in formats {
            let codecs = format
                .get("codec")
                .and_then(|c| c.as_array())
                .cloned()
                .unwrap_or_default();
            for codec in codecs {
                let base_url = as_str(codec.get("base_url").unwrap_or(&Value::Null));
                let url_list = codec
                    .get("url_info")
                    .and_then(|u| u.as_array())
                    .cloned()
                    .unwrap_or_default();
                for url_item in url_list {
                    let host = as_str(url_item.get("host").unwrap_or(&Value::Null));
                    let extra = as_str(url_item.get("extra").unwrap_or(&Value::Null));
                    // 缺 host 或 base_url 的条目拼不出可用地址：空串、空白或仅
                    // `extra` 里的 query 都不是线路，直接跳过；有效条目拼接保持原样。
                    if host.trim().is_empty() || base_url.trim().is_empty() {
                        continue;
                    }
                    urls.push(format!("{host}{base_url}{extra}"));
                }
            }
        }
    }

    // 上游给了 playurl 对象却没有可用线路时同样不能静默返回空列表：
    // 明确未开播/轮播给出分类错误，其余保持可重试的通用错误。
    if urls.is_empty() {
        let error = play_info_unavailable(data);
        log_play_info_failure(data, "object", "object", &error.code);
        return Err(error);
    }

    // 优先使用非 mcdn 主机（与上游排序一致）。
    urls.sort_by(|a, b| {
        let a_m = a.contains("mcdn");
        let b_m = b.contains("mcdn");
        a_m.cmp(&b_m)
    });

    let mut headers = std::collections::HashMap::new();
    headers.insert("referer".into(), "https://live.bilibili.com".into());
    headers.insert(
        "user-agent".into(),
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36 Edg/115.0.1901.188".into(),
    );

    Ok(urls
        .into_iter()
        .enumerate()
        .map(|(index, url)| {
            PlayUrl::inferred(
                format!("bilibili:{}", index + 1),
                format!("线路{}", index + 1),
                index as u32,
                url,
                headers.clone(),
            )
        })
        .collect())
}

/// 从 `Room/get_info` 解析关注列表所需的直播元数据。
///
/// 关注刷新刻意使用这个接口而不是房间详情接口：
/// 后者会解析状态角标既不需要展示也不需要的
/// 播放与弹幕会话元数据。
pub fn parse_room_live_status(raw: &str) -> AppResult<LiveRoomStatus> {
    let root: Value =
        serde_json::from_str(raw).map_err(|e| json_err(format!("live status: {e}")))?;
    let data = root.get("data").unwrap_or(&Value::Null);
    let status = data.get("live_status").map(as_i64).unwrap_or(0) == 1;
    Ok(LiveRoomStatus {
        status,
        live_started_at: status
            .then(|| {
                parse_live_started_at(
                    data.get("live_time")
                        .or_else(|| data.get("live_start_time")),
                )
            })
            .flatten(),
    })
}

/// 解析 buvid spi 响应。
pub fn parse_buvid(raw: &str) -> AppResult<(String, String)> {
    let root: Value = serde_json::from_str(raw).map_err(|e| json_err(format!("buvid: {e}")))?;
    let data = root.get("data").cloned().unwrap_or(Value::Null);
    Ok((
        as_str(data.get("b_3").unwrap_or(&Value::Null)),
        as_str(data.get("b_4").unwrap_or(&Value::Null)),
    ))
}

/// 从 nav 的 wbi_img 中提取 img_key / sub_key 文件名。
pub fn parse_wbi_keys(raw: &str) -> AppResult<(String, String)> {
    let root: Value = serde_json::from_str(raw).map_err(|e| json_err(format!("wbi keys: {e}")))?;
    let img_url = as_str(
        root.pointer("/data/wbi_img/img_url")
            .unwrap_or(&Value::Null),
    );
    let sub_url = as_str(
        root.pointer("/data/wbi_img/sub_url")
            .unwrap_or(&Value::Null),
    );
    let img_key = file_stem_from_url(&img_url);
    let sub_key = file_stem_from_url(&sub_url);
    if img_key.is_empty() || sub_key.is_empty() {
        return Err(json_err("wbi keys missing from nav response"));
    }
    Ok((img_key, sub_key))
}

fn file_stem_from_url(url: &str) -> String {
    let name = url.rsplit('/').next().unwrap_or("");
    name.split('.').next().unwrap_or("").to_string()
}

pub fn get_mixin_key(origin: &str) -> String {
    let chars: Vec<char> = origin.chars().collect();
    let mut s = String::new();
    for &i in &MIXIN_KEY_ENC_TAB {
        if i < chars.len() {
            s.push(chars[i]);
        }
    }
    s.chars().take(32).collect()
}

/// 用 WBI 对 query 参数签名（返回包含 wts + w_rid 的 map）。
pub fn wbi_sign_params(
    mut params: BTreeMap<String, String>,
    img_key: &str,
    sub_key: &str,
    wts: i64,
) -> BTreeMap<String, String> {
    let mixin_key = get_mixin_key(&format!("{img_key}{sub_key}"));
    params.insert("wts".into(), wts.to_string());

    // 从取值中过滤字符 "!'()*"，排序已由 BTreeMap 保证。
    let filtered: BTreeMap<String, String> = params
        .iter()
        .map(|(k, v)| {
            let cleaned: String = v.chars().filter(|c| !"!'()*".contains(*c)).collect();
            (k.clone(), cleaned)
        })
        .collect();

    let query = filtered
        .iter()
        .map(|(k, v)| format!("{k}={}", urlencoding_encode(v)))
        .collect::<Vec<_>>()
        .join("&");

    let mut hasher = Md5::new();
    hasher.update(format!("{query}{mixin_key}").as_bytes());
    let w_rid = hex::encode(hasher.finalize());

    let mut out = filtered;
    out.insert("w_rid".into(), w_rid);
    out
}

/// 按 Uri.encodeQueryComponent 的方式做百分号编码（空格编码为 %20）。
fn urlencoding_encode(s: &str) -> String {
    utf8_percent_encode(s, UNRESERVED).collect()
}

/// 与原手写实现逐字节等价的 unreserved 集合：字母数字与 `-._~` 之外
/// 一律 `%XX`（大写十六进制）。
const UNRESERVED: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'~');

pub fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 若存在，从 cookie 字符串提取 buvid3/buvid4。
pub fn buvid_from_cookie(cookie: &str) -> Option<(String, String)> {
    let b3 = cookie_value(cookie, "buvid3").unwrap_or_default();
    let b4 = cookie_value(cookie, "buvid4").unwrap_or_default();
    // 浏览器导出可能只包含两个设备 id 之一。保留可用的那个值，
    // 让调用方只需抓取并合并缺失的一个；
    // 像 `cookie.contains("buvid3")` 这样的子串检查还会把无关的 cookie 值
    // 误判成设备标识符。
    (!b3.is_empty() || !b4.is_empty()).then_some((b3, b4))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_categories_fixture() {
        let raw = include_str!("../../../tests/fixtures/bilibili_area_list.json");
        let cats = parse_categories(raw).unwrap();
        assert!(!cats.is_empty());
        assert_eq!(cats[0].name, "娱乐");
        assert!(!cats[0].children.is_empty());
        assert_eq!(cats[0].children[0].id, "21");
        assert!(
            cats[0].children[0]
                .pic
                .as_ref()
                .unwrap()
                .ends_with("@100w.png")
        );
    }

    #[test]
    fn parse_recommend_fixture() {
        let raw = include_str!("../../../tests/fixtures/bilibili_recommend.json");
        let page = parse_recommend_rooms(raw).unwrap();
        assert!(page.has_more);
        assert_eq!(page.items.len(), 2);
        assert_eq!(page.items[0].site_id, SiteId::Bilibili);
        assert_eq!(page.items[0].room_id, "23058");
        assert!(page.items[0].cover.contains("@400w.jpg"));
        assert_eq!(page.items[1].online, 999);
    }

    #[test]
    fn parse_account_recommend_fixture_flattens_and_deduplicates_home_modules() {
        let raw = include_str!("../../../tests/fixtures/bilibili_account_recommend.json");
        let page = parse_account_recommend_rooms(raw).unwrap();

        assert!(!page.has_more);
        assert_eq!(page.items.len(), 3);
        assert_eq!(page.items[0].room_id, "101");
        assert_eq!(page.items[1].room_id, "102");
        assert_eq!(page.items[2].room_id, "103");
        assert_eq!(page.items[2].online, 321);
        // 匿名／Cookie 路径是单页：解析器保持上游语义，不宣告还有下一页。
        assert!(!page.has_more);
    }

    /// 凭据路径的首页必须宣告还有下一页，否则前端永远翻不到续页。
    ///
    /// 这是 Windows debug 实机踩到的真实问题：`index/getList` 无游标、
    /// `has_more` 恒为假，`getMoreRecList` 续页因此永远不被请求，
    /// 表现是「授权了但只能看一屏」。
    #[test]
    fn credential_home_rooms_report_more_while_anonymous_stays_single_page() {
        let raw = include_str!("../../../tests/fixtures/bilibili_account_recommend.json");
        let credential = parse_live_credential_home_rooms(raw).unwrap();
        assert!(credential.has_more);
        assert_eq!(credential.items.len(), 3);

        // 空页不宣告继续，避免上游给出空响应时无限翻页。
        let empty = parse_live_credential_home_rooms(r#"{"code":0,"data":{}}"#).unwrap();
        assert!(!empty.has_more);
        assert!(empty.items.is_empty());

        assert!(!parse_account_recommend_rooms(raw).unwrap().has_more);
    }

    #[test]
    fn parse_live_more_recommend_fixture_keeps_order_and_reports_more() {
        let raw = include_str!("../../../tests/fixtures/bilibili_live_more_recommend.json");
        let page = parse_live_more_recommend_rooms(raw).unwrap();

        // 本页非空即宣告还能继续翻：上游从不主动宣告耗尽，空页才是终点。
        assert!(page.has_more);
        assert_eq!(page.items.len(), 2);
        assert_eq!(page.items[0].room_id, "201");
        assert_eq!(page.items[0].online, 4321);
        assert_eq!(page.items[1].room_id, "202");
        assert_eq!(page.items[1].online, 876);
        assert!(page.items[0].cover.contains("@400w.jpg"));
    }

    #[test]
    fn empty_live_more_recommend_page_stops_paging() {
        let page =
            parse_live_more_recommend_rooms(r#"{"code":0,"data":{"recommend_room_list":[]}}"#)
                .unwrap();
        assert!(!page.has_more);
        assert!(page.items.is_empty());
        // 缺 data 对象也不报错：上游偶发只回 code，不应让首页整页失败。
        let page = parse_live_more_recommend_rooms(r#"{"code":0}"#).unwrap();
        assert!(!page.has_more);
    }

    /// 无效令牌会静默降级为匿名／回退流（`code=0`），`trackid` 是唯一可观测信号。
    /// 误判的代价很具体：用户看到「已授权」却拿着匿名流，且无从判断。
    #[test]
    fn live_recommend_personalization_is_detected_from_trackid() {
        let router = r#"{"code":0,"data":{"recommend_room_list":[{"roomid":1,"trackid":"live_feed_0.router-live-2589629-jx44n.1.2"}]}}"#;
        assert!(live_recommend_is_personalized(router));
        // 首页负载里引擎标记也可能只在模块列表里。
        let in_module = r#"{"code":0,"data":{"recommend_room_list":[],"room_list":[{"list":[{"roomid":1,"trackid":"live_feed_0.router-live-1.2.3"}]}]}}"#;
        assert!(live_recommend_is_personalized(in_module));

        for fallback in [
            r#"{"code":0,"data":{"recommend_room_list":[{"roomid":1,"trackid":"rec-fallback-live-1828944-lzd8v.1"}]}}"#,
            r#"{"code":0,"data":{"recommend_room_list":[{"roomid":1}]}}"#,
            r#"{"code":0,"data":{"recommend_room_list":[{"roomid":1,"trackid":""}]}}"#,
            r#"{"code":0,"data":{"recommend_room_list":[]}}"#,
            r#"{"code":-352,"message":"-352"}"#,
            "not json",
        ] {
            assert!(
                !live_recommend_is_personalized(fallback),
                "不应把降级流当成个性化：{fallback}"
            );
        }
    }

    #[test]
    fn parse_category_rooms_fixture() {
        let raw = include_str!("../../../tests/fixtures/bilibili_category_rooms.json");
        let page = parse_category_rooms(raw, 30).unwrap();
        assert!(!page.has_more);
        assert_eq!(page.items.len(), 2);
        assert_eq!(page.items[0].room_id, "10001");
        // user_cover 兜底
        assert!(page.items[1].cover.contains("c2.jpg"));
    }

    #[test]
    fn parse_search_merges_live_rooms_and_offline_users() {
        let raw = include_str!("../../../tests/fixtures/bilibili_search_rooms.json");
        let page = parse_search_rooms(raw, 1).unwrap();
        let ids: Vec<&str> = page.items.iter().map(|x| x.room_id.as_str()).collect();
        // 同一个 roomid 在两个数组里都出现时只保留房间数组那份（带标题和封面）。
        assert_eq!(ids, ["555", "777"]);

        let live = &page.items[0];
        assert_eq!(live.title, "搜索结果房间");
        assert!(live.cover.starts_with("https://"));
        assert_eq!(live.user_name, "搜索主播");
        assert_eq!(live.live_status, Some(true));
        assert_eq!(live.online, 88);

        // `live_user` 不带标题和封面，退回主播头像，状态取响应里的 live_status。
        let offline = &page.items[1];
        assert_eq!(offline.live_status, Some(false));
        assert_eq!(offline.title, "");
        assert_eq!(offline.user_name, "未开播主播");
        assert!(offline.cover.contains("off.jpg"));
        assert_eq!(offline.online, 0);

        // `live_user` 只在第一页读，翻页只看在播房间数量。
        assert!(!page.has_more);
    }

    #[test]
    fn parse_search_skips_matched_users_after_the_first_page() {
        let raw = include_str!("../../../tests/fixtures/bilibili_search_rooms.json");
        let page = parse_search_rooms(raw, 2).unwrap();
        let ids: Vec<&str> = page.items.iter().map(|x| x.room_id.as_str()).collect();
        assert_eq!(ids, ["555"]);
    }

    #[test]
    fn parse_room_detail_fixture() {
        let raw = include_str!("../../../tests/fixtures/bilibili_room_info.json");
        let detail = parse_room_detail(raw, None, "b3", "SESSDATA=x").unwrap();
        assert_eq!(detail.room_id, "23058");
        assert!(detail.status);
        assert_eq!(detail.live_started_at, Some(1_700_000_000_000));
        assert_eq!(detail.user_name, "详情主播");
        assert!(detail.user_avatar.contains("@100w_100h.webp"));
        assert_eq!(detail.raw["danmaku"]["buvid"], "b3");
        // room_id 以数字存储，供 WS 加入使用
        assert!(
            detail.raw["room_id"].as_i64().is_some() || detail.raw["room_id"].as_str().is_some()
        );
    }

    #[test]
    fn buvid_from_cookie_accepts_partial_device_identifiers_only() {
        assert_eq!(
            buvid_from_cookie("SESSDATA=session; buvid3=device-3"),
            Some(("device-3".into(), String::new()))
        );
        assert_eq!(
            buvid_from_cookie("buvid4=device-4; bili_jct=csrf"),
            Some((String::new(), "device-4".into()))
        );
        assert_eq!(buvid_from_cookie("note=contains-buvid3-text"), None);
    }

    #[test]
    fn avatar_thumb_makes_protocol_and_transform_unambiguous() {
        assert_eq!(
            avatar_thumb("//i0.hdslb.com/bfs/face/avatar.jpg?token=abc"),
            "https://i0.hdslb.com/bfs/face/avatar.jpg@100w_100h.webp?token=abc"
        );
        assert_eq!(
            avatar_thumb("http://i0.hdslb.com/bfs/face/avatar.jpg#top"),
            "https://i0.hdslb.com/bfs/face/avatar.jpg@100w_100h.webp#top"
        );
        assert_eq!(
            avatar_thumb("https://i0.hdslb.com/bfs/face/avatar.jpg@50w_50h.webp"),
            "https://i0.hdslb.com/bfs/face/avatar.jpg@50w_50h.webp"
        );
    }

    #[test]
    fn parse_play_qualities_and_urls() {
        let raw = include_str!("../../../tests/fixtures/bilibili_play_info.json");
        let qs = parse_play_qualities(raw).unwrap();
        assert_eq!(qs.len(), 3);
        assert_eq!(qs[0].quality, "原画");
        assert_eq!(qs[0].data, Value::Number(10000.into()));

        let urls = parse_play_urls(raw).unwrap();
        assert_eq!(urls.len(), 2);
        // 非 mcdn 优先
        assert!(!urls[0].url.contains("mcdn"));
        assert!(urls[1].url.contains("mcdn"));
        assert!(urls[0].headers.contains_key("referer"));
        assert_eq!(urls[0].source_id, "bilibili:1");
        assert_eq!(urls[0].label, "线路1");
        assert_eq!(urls[0].protocol, crate::models::live::PlaybackProtocol::Flv);
        assert_eq!(urls[0].priority, 0);
    }

    /// play-info 失败分类的真实执行测试。
    ///
    /// 每个用例同时走 qualities 与 urls，确认两条链路给出同一个分类；
    /// 未知形状必须保持可重试的 `bilibili_play_info`，不能被猜成「未开播」。
    mod play_info_failures {
        use super::*;

        /// 最小可用 playurl（一条 flv 线路 + 一个可接受 qn）。
        fn playable_playurl() -> Value {
            serde_json::json!({
                "g_qn_desc": [{ "qn": 10000, "desc": "原画" }],
                "stream": [{
                    "protocol_name": "http_stream",
                    "format": [{
                        "format_name": "flv",
                        "codec": [{
                            "codec_name": "avc",
                            "accept_qn": [10000],
                            "base_url": "/live-bvc/room.flv",
                            "url_info": [{ "host": "https://cdn.example", "extra": "?token=secret" }]
                        }]
                    }]
                }]
            })
        }

        /// 构造上游响应；`playurl` 为 `None` 时把 `playurl_info` 置为 `null`
        /// （`playurl_info` 整个字段缺失的场景由 `missing_playurl_info_is_not_playable` 覆盖）。
        fn response(data_extra: Value, playurl: Option<Value>) -> String {
            let mut data = serde_json::json!({ "room_id": 23058 });
            if let (Value::Object(extra), Value::Object(data)) = (data_extra, &mut data) {
                data.extend(extra);
            }
            match playurl {
                Some(playurl) => {
                    data["playurl_info"] = serde_json::json!({ "playurl": playurl });
                }
                None => {
                    data["playurl_info"] = Value::Null;
                }
            }
            serde_json::json!({ "code": 0, "data": data }).to_string()
        }

        /// 按 codec 列表构造 playurl，便于覆盖缺字段的线路条目。
        fn playurl_with_codecs(codecs: Vec<Value>) -> Value {
            serde_json::json!({
                "g_qn_desc": [{ "qn": 10000, "desc": "原画" }],
                "stream": [{
                    "protocol_name": "http_stream",
                    "format": [{ "format_name": "flv", "codec": codecs }]
                }]
            })
        }

        /// 单个 codec；`base_url` 为 `None` 时不写该字段（模拟缺失）。
        fn codec_entry(base_url: Option<&str>, url_info: Value) -> Value {
            let mut entry = serde_json::json!({ "accept_qn": [10000], "url_info": url_info });
            if let Some(base_url) = base_url {
                entry["base_url"] = Value::String(base_url.into());
            }
            entry
        }

        fn codes(raw: &str) -> (String, String) {
            let qualities = parse_play_qualities(raw).expect_err("qualities 必须失败");
            let urls = parse_play_urls(raw).expect_err("urls 必须失败");
            assert_eq!(qualities.code, urls.code, "两条链路必须给同一分类");
            assert_eq!(qualities.site.as_deref(), Some("bilibili"));
            (qualities.code, qualities.message)
        }

        #[test]
        fn offline_and_round_rooms_are_classified() {
            for (status, expected) in [(0, "bilibili_not_live"), (2, "bilibili_room_round")] {
                let raw = response(serde_json::json!({ "live_status": status }), None);
                let (code, message) = codes(&raw);
                assert_eq!(code, expected);
                assert!(message.contains("直播间"));
            }
        }

        #[test]
        fn locked_and_hidden_rooms_are_classified() {
            let locked = response(
                serde_json::json!({ "live_status": 1, "is_locked": true }),
                None,
            );
            assert_eq!(codes(&locked).0, "bilibili_room_locked");

            let encrypted = response(
                serde_json::json!({ "live_status": 1, "encrypted": true, "pwd_verified": false }),
                None,
            );
            assert_eq!(codes(&encrypted).0, "bilibili_room_locked");

            let hidden = response(
                serde_json::json!({ "live_status": 1, "is_hidden": true }),
                None,
            );
            assert_eq!(codes(&hidden).0, "bilibili_room_hidden");
        }

        /// 密码已验证的加密房、缺失的布尔字段、类型错误的布尔字段都不能推断上锁。
        #[test]
        fn lock_signals_need_an_explicit_boolean() {
            for extra in [
                serde_json::json!({ "live_status": 1, "encrypted": true, "pwd_verified": true }),
                serde_json::json!({ "live_status": 1, "is_locked": false }),
                serde_json::json!({ "live_status": 1, "pwd_verified": false }),
                serde_json::json!({ "live_status": 1, "is_locked": "true", "is_hidden": "true" }),
                serde_json::json!({ "live_status": 1 }),
            ] {
                let raw = response(extra.clone(), None);
                let (code, _) = codes(&raw);
                assert_eq!(code, "bilibili_play_info", "不应臆测上锁/未开播：{extra}");
            }
        }

        #[test]
        fn live_room_without_playurl_stays_generic_and_retryable() {
            let raw = response(serde_json::json!({ "live_status": 1 }), None);
            let error = parse_play_qualities(&raw).expect_err("null playurl 不能通过");
            assert_eq!(error.code, "bilibili_play_info");
            assert!(error.retryable, "未知原因应允许重试");
            assert_eq!(
                parse_play_urls(&raw).unwrap_err().code,
                "bilibili_play_info"
            );
        }

        #[test]
        fn missing_playurl_info_is_not_playable() {
            let raw = r#"{"code":0,"data":{"room_id":23058,"live_status":1}}"#;
            assert_eq!(codes(raw).0, "bilibili_play_info");
        }

        #[test]
        fn non_object_playurl_is_rejected() {
            for playurl in [
                Value::String("not-a-map".into()),
                Value::Array(vec![]),
                Value::Number(1.into()),
            ] {
                let raw = response(serde_json::json!({ "live_status": 1 }), Some(playurl));
                assert_eq!(codes(&raw).0, "bilibili_play_info");
            }
        }

        /// 根节点缺字段或字段类型错误时不能被读成「未开播」。
        #[test]
        fn malformed_root_fields_never_look_offline() {
            for raw in [
                r#"{"code":0}"#,
                r#"{"code":0,"data":null}"#,
                r#"{"code":0,"data":{"live_status":"0"}}"#,
                r#"{"code":0,"data":{"live_status":null}}"#,
                r#"{"code":0,"data":{"live_status":true}}"#,
                r#"{"code":0,"data":{"live_status":0.5}}"#,
            ] {
                let (code, _) = codes(raw);
                assert_eq!(code, "bilibili_play_info", "畸形字段不得判成未开播：{raw}");
            }
        }

        /// 明确业务状态优先于「清晰度为空」：playurl 是空对象或空 stream 时，
        /// 两条链路给同一分类。
        #[test]
        fn empty_playurl_keeps_explicit_business_status() {
            for (status, expected) in [(0, "bilibili_not_live"), (2, "bilibili_room_round")] {
                for playurl in [serde_json::json!({}), serde_json::json!({ "stream": [] })] {
                    let raw = response(
                        serde_json::json!({ "live_status": status }),
                        Some(playurl.clone()),
                    );
                    let (code, _) = codes(&raw);
                    assert_eq!(code, expected, "live_status={status} playurl={playurl}");
                }
            }

            for (extra, expected) in [
                (
                    serde_json::json!({ "live_status": 1, "is_locked": true }),
                    "bilibili_room_locked",
                ),
                (
                    serde_json::json!({ "live_status": 1, "encrypted": true, "pwd_verified": false }),
                    "bilibili_room_locked",
                ),
                (
                    serde_json::json!({ "live_status": 1, "is_hidden": true }),
                    "bilibili_room_hidden",
                ),
            ] {
                let raw = response(extra.clone(), Some(serde_json::json!({})));
                let (code, _) = codes(&raw);
                assert_eq!(code, expected, "{extra}");
            }
        }

        /// 未知状态或 live_status 1 缺 accept_qn 时，qualities 保留原有专用错误；
        /// urls 仍是可重试的通用错误，不承诺两条链路同 code。
        #[test]
        fn unknown_status_keeps_qualities_specific_error() {
            let raw = response(
                serde_json::json!({ "live_status": 1 }),
                Some(serde_json::json!({ "g_qn_desc": [] })),
            );
            let qualities = parse_play_qualities(&raw).expect_err("qualities 必须失败");
            assert_eq!(qualities.code, "bilibili_play_qualities_empty");
            assert!(qualities.retryable);
            assert_eq!(
                parse_play_urls(&raw).unwrap_err().code,
                "bilibili_play_info"
            );

            let unknown = response(
                serde_json::json!({}),
                Some(serde_json::json!({ "stream": [] })),
            );
            assert_eq!(
                parse_play_qualities(&unknown).unwrap_err().code,
                "bilibili_play_qualities_empty"
            );
        }

        /// 非法 JSON 的 message 直接展示给用户，必须是中文且不带 scope。
        #[test]
        fn invalid_json_message_is_chinese() {
            for raw in [
                r#"{"token":"super-secret","live_status":"#,
                "not json at all",
            ] {
                for message in [
                    parse_play_qualities(raw).unwrap_err().message,
                    parse_play_urls(raw).unwrap_err().message,
                ] {
                    assert_eq!(message, "B站播放信息响应无法解析，请稍后重试");
                    assert!(!message.contains("invalid json"), "{message}");
                    assert!(!message.contains("play qualities"), "{message}");
                    assert!(!message.contains("play urls"), "{message}");
                }
            }
        }

        /// 有效 playurl 保留现有能力：清晰度与线路都能解析。
        #[test]
        fn valid_playurl_keeps_existing_capabilities() {
            let raw = response(
                serde_json::json!({ "live_status": 1, "is_locked": false }),
                Some(playable_playurl()),
            );
            let qualities = parse_play_qualities(&raw).unwrap();
            assert_eq!(qualities.len(), 1);
            assert_eq!(qualities[0].quality, "原画");
            let urls = parse_play_urls(&raw).unwrap();
            assert_eq!(urls.len(), 1);
            assert_eq!(
                urls[0].url,
                "https://cdn.example/live-bvc/room.flv?token=secret"
            );
        }

        /// 缺 host / base_url 的条目拼不出线路：全部无效时按业务状态或可重试错误失败，
        /// 只有 `extra`（query）也不能当成地址。
        #[test]
        fn urls_without_host_or_base_url_are_skipped() {
            let invalid_codecs = [
                codec_entry(
                    Some("/live-bvc/room.flv"),
                    serde_json::json!([{ "extra": "?token=secret" }]),
                ),
                codec_entry(
                    Some("/live-bvc/room.flv"),
                    serde_json::json!([{ "host": "", "extra": "?token=secret" }]),
                ),
                codec_entry(
                    Some("/live-bvc/room.flv"),
                    serde_json::json!([{ "host": null, "extra": "?token=secret" }]),
                ),
                codec_entry(None, serde_json::json!([{ "host": "https://cdn.example" }])),
                codec_entry(
                    Some("  "),
                    serde_json::json!([{ "host": "https://cdn.example" }]),
                ),
            ];

            for codec in invalid_codecs {
                let raw = response(
                    serde_json::json!({ "live_status": 1 }),
                    Some(playurl_with_codecs(vec![codec.clone()])),
                );
                let error = parse_play_urls(&raw).expect_err("无可用线路必须失败");
                assert_eq!(error.code, "bilibili_play_info", "{codec}");
                assert!(error.retryable, "{codec}");
            }

            // 明确业务状态优先于「没有可用线路」。
            for (status, expected) in [(0, "bilibili_not_live"), (2, "bilibili_room_round")] {
                let raw = response(
                    serde_json::json!({ "live_status": status }),
                    Some(playurl_with_codecs(vec![codec_entry(
                        Some("/live-bvc/room.flv"),
                        serde_json::json!([{ "host": "" }]),
                    )])),
                );
                assert_eq!(parse_play_urls(&raw).unwrap_err().code, expected);
            }
        }

        /// 无效条目与有效条目混合时只丢无效的，有效线路保留，且优先级和顺序保持原有语义。
        #[test]
        fn mixed_entries_keep_only_valid_urls() {
            let raw = response(
                serde_json::json!({ "live_status": 1 }),
                Some(playurl_with_codecs(vec![codec_entry(
                    Some("/live-bvc/room.flv"),
                    serde_json::json!([
                        { "host": "" },
                        { "host": "https://mcdn.example", "extra": "?token=mcdn" },
                        { "host": "https://cdn.example", "extra": "?token=secret" },
                        { "extra": "?token=orphan" }
                    ]),
                )])),
            );
            let urls = parse_play_urls(&raw).unwrap();
            assert_eq!(urls.len(), 2, "空 host / 仅 query 的条目应被跳过");
            assert_eq!(
                urls[0].url,
                "https://cdn.example/live-bvc/room.flv?token=secret"
            );
            assert_eq!(
                urls[1].url,
                "https://mcdn.example/live-bvc/room.flv?token=mcdn"
            );
            assert_eq!(urls[0].priority, 0);
            assert_eq!(urls[1].priority, 1);
            assert_eq!(urls[0].source_id, "bilibili:1");
            assert_eq!(urls[0].headers["referer"], "https://live.bilibili.com");
            assert!(urls.iter().all(|url| !url.url.is_empty()));
        }

        #[test]
        fn diagnostic_room_id_only_accepts_bounded_digits() {
            assert_eq!(diagnostic_room_id_str("23058"), "23058");
            assert_eq!(diagnostic_room_id_str(""), "");
            assert_eq!(diagnostic_room_id_str("SESSDATA=secret"), "");
            assert_eq!(diagnostic_room_id_str("https://cdn.example/x?token=1"), "");
            assert_eq!(diagnostic_room_id_str("12 34"), "");
            assert_eq!(diagnostic_room_id_str(&"1".repeat(21)), "");
        }

        #[test]
        fn invalid_json_message_does_not_echo_body() {
            let raw = r#"{"token":"super-secret","live_status":"#;
            let quality_message = parse_play_qualities(raw).unwrap_err().message;
            let url_message = parse_play_urls(raw).unwrap_err().message;
            for message in [quality_message, url_message] {
                assert!(
                    !message.contains("super-secret"),
                    "message 回显了正文：{message}"
                );
                assert!(
                    !message.contains("EOF"),
                    "message 不应带 serde 原文本：{message}"
                );
            }
        }

        /// 凭据与上游正文不得出现在用户可见的 message 中。
        #[test]
        fn messages_never_carry_credentials() {
            let raw = response(
                serde_json::json!({
                    "live_status": 0,
                    "is_locked": true,
                    "message": "upstream-secret-token",
                    "pwd": "room-password",
                }),
                None,
            );
            let quality_error = parse_play_qualities(&raw).unwrap_err();
            let url_error = parse_play_urls(&raw).unwrap_err();
            for message in [quality_error.message, url_error.message] {
                for secret in ["upstream-secret-token", "room-password", "SESSDATA"] {
                    assert!(
                        !message.contains(secret),
                        "message 泄露了 {secret}: {message}"
                    );
                }
            }
        }
    }

    #[test]
    fn parse_live_status_fixture() {
        let raw = include_str!("../../../tests/fixtures/bilibili_live_status.json");
        let status = parse_room_live_status(raw).unwrap();
        assert!(status.status);
        assert_eq!(status.live_started_at, Some(1_700_000_000_000));
    }

    #[test]
    fn offline_live_status_ignores_stale_start_time() {
        let raw = r#"{
            "data": {
                "live_status": 0,
                "live_time": "2023-11-15 06:13:20"
            }
        }"#;
        let status = parse_room_live_status(raw).unwrap();
        assert!(!status.status);
        assert_eq!(status.live_started_at, None);
    }

    #[test]
    fn wbi_sign_stable() {
        let mut params = BTreeMap::new();
        params.insert("foo".into(), "1".into());
        params.insert("bar".into(), "2".into());
        let signed = wbi_sign_params(
            params,
            "imgkey1234567890abcdefghijklmn",
            "subkey1234567890abcdefghijklmn",
            1700000000,
        );
        assert_eq!(signed.get("wts").unwrap(), "1700000000");
        assert_eq!(signed.get("w_rid").unwrap().len(), 32);
        // 保证确定性
        let mut params2 = BTreeMap::new();
        params2.insert("foo".into(), "1".into());
        params2.insert("bar".into(), "2".into());
        let signed2 = wbi_sign_params(
            params2,
            "imgkey1234567890abcdefghijklmn",
            "subkey1234567890abcdefghijklmn",
            1700000000,
        );
        assert_eq!(signed.get("w_rid"), signed2.get("w_rid"));
    }

    #[test]
    fn strip_em_basic() {
        assert_eq!(strip_em_tags("a<em>b</em>c"), "abc");
        assert_eq!(strip_em_tags(r#"搜<em class="keyword">索</em>"#), "搜索");
    }

    /// 等价性锚点：原手写扫描剥除一切「包含 em（不区分 ASCII 大小写）」的标签，
    /// 未闭合的 `<` 原样保留。
    #[test]
    fn strip_em_matches_any_tag_containing_em() {
        assert_eq!(strip_em_tags("<item>x</item>"), "x");
        assert_eq!(strip_em_tags("<EM>x</EM>"), "x");
        assert_eq!(strip_em_tags("<a href=\"em\">y</a>"), "y</a>");
        assert_eq!(strip_em_tags("a<em"), "a<em");
        assert_eq!(strip_em_tags("<a>b</a>"), "<a>b</a>");
    }

    /// 等价性锚点：query 组件编码只保留 unreserved 集合，十六进制为大写。
    #[test]
    fn urlencoding_encode_keeps_unreserved_and_uppercase_hex() {
        assert_eq!(urlencoding_encode("aZ09-_.~"), "aZ09-_.~");
        assert_eq!(urlencoding_encode("a b+c/dé"), "a%20b%2Bc%2Fd%C3%A9");
    }
}
