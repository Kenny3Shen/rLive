//! Bilibili 直播 API 的纯解析器与底层辅助函数。

use std::collections::{BTreeMap, HashSet};
use std::time::{SystemTime, UNIX_EPOCH};

use md5::{Digest, Md5};
use serde_json::Value;

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

fn as_str(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        other => other.to_string().trim_matches('"').to_string(),
    }
}

fn as_i64(v: &Value) -> i64 {
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
pub fn strip_em_tags(s: &str) -> String {
    // 避免引入 `regex` crate；字符扫描足以处理 `<...em...>`。
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(start) = rest.find('<') {
        out.push_str(&rest[..start]);
        let after = &rest[start..];
        if let Some(end) = after.find('>') {
            let tag = &after[..=end];
            let lower = tag.to_ascii_lowercase();
            if lower.contains("em") {
                rest = &after[end + 1..];
                continue;
            }
            out.push_str(tag);
            rest = &after[end + 1..];
        } else {
            out.push_str(after);
            return out;
        }
    }
    out.push_str(rest);
    out
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
fn avatar_thumb(face: &str) -> String {
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
    let viewer_uid: i64 = cookie
        .split(';')
        .filter_map(|p| {
            let p = p.trim();
            p.strip_prefix("DedeUserID=").map(|v| v.trim().to_string())
        })
        .find(|v| !v.is_empty())
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

/// 从 getRoomPlayInfo 响应中提取 playurl map。
pub fn read_playurl(result: &Value) -> AppResult<&Value> {
    result.pointer("/data/playurl_info/playurl").ok_or_else(|| {
        AppError::new("bilibili_play_info", "B站播放信息响应异常，请稍后重试").with_site("bilibili")
    })
}

/// 从 play-info 响应解析画质列表。
pub fn parse_play_qualities(raw: &str) -> AppResult<Vec<LivePlayQuality>> {
    let root: Value =
        serde_json::from_str(raw).map_err(|e| json_err(format!("play qualities: {e}")))?;
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
        return Err(AppError::new(
            "bilibili_play_qualities_empty",
            "B站暂时无法获取播放清晰度，请稍后重试",
        )
        .with_site("bilibili"));
    }
    Ok(qualities)
}

/// 从 play-info 响应解析播放地址（含选定的 qn）。
pub fn parse_play_urls(raw: &str) -> AppResult<Vec<PlayUrl>> {
    let root: Value = serde_json::from_str(raw).map_err(|e| json_err(format!("play urls: {e}")))?;
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
                    urls.push(format!("{host}{base_url}{extra}"));
                }
            }
        }
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
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.as_bytes() {
        match *b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char);
            }
            _ => {
                out.push('%');
                out.push_str(&format!("{b:02X}"));
            }
        }
    }
    out
}

pub fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 若存在，从 cookie 字符串提取 buvid3/buvid4。
pub fn buvid_from_cookie(cookie: &str) -> Option<(String, String)> {
    let b3 = extract_cookie_value(cookie, "buvid3").unwrap_or_default();
    let b4 = extract_cookie_value(cookie, "buvid4").unwrap_or_default();
    // 浏览器导出可能只包含两个设备 id 之一。保留可用的那个值，
    // 让调用方只需抓取并合并缺失的一个；
    // 像 `cookie.contains("buvid3")` 这样的子串检查还会把无关的 cookie 值
    // 误判成设备标识符。
    (!b3.is_empty() || !b4.is_empty()).then_some((b3, b4))
}

fn extract_cookie_value(cookie: &str, key: &str) -> Option<String> {
    for part in cookie.split(';') {
        let part = part.trim();
        if let Some(rest) = part.strip_prefix(&format!("{key}=")) {
            return Some(rest.to_string());
        }
    }
    None
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
}
