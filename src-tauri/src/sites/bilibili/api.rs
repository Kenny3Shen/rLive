//! Pure parsers and low-level helpers for the Bilibili live APIs.
//! Ported from upstream simple_live_core `bilibili_site.dart`.

use std::collections::BTreeMap;
use std::time::{SystemTime, UNIX_EPOCH};

use md5::{Digest, Md5};
use serde_json::Value;

use crate::error::{AppError, AppResult};
use crate::models::live::{
    LiveCategory, LivePlayQuality, LiveRoomDetail, LiveRoomItem, LiveSubCategory, PlayUrl,
    RoomListPage, SiteId,
};

pub const DEFAULT_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0";
pub const DEFAULT_REFERER: &str = "https://live.bilibili.com/";

/// Character shuffle table for Bilibili WBI signing (upstream mixinKeyEncTab).
const MIXIN_KEY_ENC_TAB: [usize; 64] = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29,
    28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25,
    54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

// ---------------------------------------------------------------------------
// JSON helpers
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

/// Strip Bilibili search highlight tags like `<em class="keyword">`.
pub fn strip_em_tags(s: &str) -> String {
    // Avoid adding the `regex` crate; char-scan is enough for `<...em...>`.
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

// ---------------------------------------------------------------------------
// Pure parsers (fixture-testable)
// ---------------------------------------------------------------------------

/// Parse `room/v1/Area/getList` response body.
pub fn parse_categories(raw: &str) -> AppResult<Vec<LiveCategory>> {
    let root: Value = serde_json::from_str(raw).map_err(|e| json_err(format!("categories json: {e}")))?;
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
    }
}

/// Parse `room/v1/Area/getRoomList` body. `page_size` defaults to 30 for has_more.
pub fn parse_category_rooms(raw: &str, page_size: usize) -> AppResult<RoomListPage> {
    let root: Value = serde_json::from_str(raw).map_err(|e| json_err(format!("category rooms: {e}")))?;
    let data = root
        .get("data")
        .and_then(|d| d.as_array())
        .cloned()
        .unwrap_or_default();
    let has_more = data.len() >= page_size;
    let items = data.iter().map(room_item_from_list_obj).collect();
    Ok(RoomListPage { has_more, items })
}

/// Parse recommend `getListByArea` body.
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

/// Parse search `live` type body.
pub fn parse_search_rooms(raw: &str) -> AppResult<RoomListPage> {
    let root: Value = serde_json::from_str(raw).map_err(|e| json_err(format!("search: {e}")))?;
    let list = root
        .pointer("/data/result/live_room")
        .and_then(|d| d.as_array())
        .cloned()
        .unwrap_or_default();
    let mut items = Vec::with_capacity(list.len());
    for item in &list {
        let title = strip_em_tags(&as_str(item.get("title").unwrap_or(&Value::Null)));
        let cover_raw = as_str(item.get("cover").unwrap_or(&Value::Null));
        items.push(LiveRoomItem {
            site_id: SiteId::Bilibili,
            room_id: as_str(item.get("roomid").unwrap_or(&Value::Null)),
            title,
            cover: cover_thumb(&cover_raw, "@400w.jpg"),
            user_name: as_str(item.get("uname").unwrap_or(&Value::Null)),
            online: as_i64(item.get("online").unwrap_or(&Value::Null)),
        });
    }
    Ok(RoomListPage {
        has_more: items.len() >= 40,
        items,
    })
}

/// Parse `getInfoByRoom` data object into LiveRoomDetail.
/// `danmaku` optional JSON for token/hosts stored in `raw`.
pub fn parse_room_detail(
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
    let user_avatar = if face.is_empty() {
        String::new()
    } else {
        format!("{face}@100w.jpg")
    };

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

    let raw = serde_json::json!({
        "room_id": real_room_id,
        "uid": as_str(room.get("uid").unwrap_or(&Value::Null)),
        "danmaku": {
            "token": token,
            "server_host": server_host,
            "server_hosts": server_hosts,
            "buvid": buvid3,
            "cookie": cookie,
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
        notice: String::new(),
        url: format!("https://live.bilibili.com/{real_room_id}"),
        raw,
    })
}

/// Extract playurl map from getRoomPlayInfo response.
pub fn read_playurl(result: &Value) -> AppResult<&Value> {
    result
        .pointer("/data/playurl_info/playurl")
        .ok_or_else(|| {
            AppError::new(
                "bilibili_play_info",
                "B站播放信息响应异常，请稍后重试",
            )
            .with_site("bilibili")
        })
}

/// Parse qualities from play-info response.
pub fn parse_play_qualities(raw: &str) -> AppResult<Vec<LivePlayQuality>> {
    let root: Value = serde_json::from_str(raw).map_err(|e| json_err(format!("play qualities: {e}")))?;
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

/// Parse play URLs from play-info response (with qn selected).
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

    // Prefer non-mcdn hosts first (upstream sort).
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
        .map(|url| PlayUrl {
            url,
            headers: headers.clone(),
        })
        .collect())
}

/// Parse live status from `Room/get_info`.
pub fn parse_live_status(raw: &str) -> AppResult<bool> {
    let root: Value = serde_json::from_str(raw).map_err(|e| json_err(format!("live status: {e}")))?;
    let status = root
        .pointer("/data/live_status")
        .map(as_i64)
        .unwrap_or(0);
    Ok(status == 1)
}

/// Parse buvid spi response.
pub fn parse_buvid(raw: &str) -> AppResult<(String, String)> {
    let root: Value = serde_json::from_str(raw).map_err(|e| json_err(format!("buvid: {e}")))?;
    let data = root.get("data").cloned().unwrap_or(Value::Null);
    Ok((
        as_str(data.get("b_3").unwrap_or(&Value::Null)),
        as_str(data.get("b_4").unwrap_or(&Value::Null)),
    ))
}

/// Extract img_key / sub_key filenames from nav wbi_img.
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

/// Sign query params with WBI (returns map including wts + w_rid).
pub fn wbi_sign_params(
    mut params: BTreeMap<String, String>,
    img_key: &str,
    sub_key: &str,
    wts: i64,
) -> BTreeMap<String, String> {
    let mixin_key = get_mixin_key(&format!("{img_key}{sub_key}"));
    params.insert("wts".into(), wts.to_string());

    // Filter "!'()*" from values, already sorted via BTreeMap.
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

/// Percent-encode like Uri.encodeQueryComponent (encode space as %20).
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

/// Extract buvid3/buvid4 from cookie string if present.
pub fn buvid_from_cookie(cookie: &str) -> Option<(String, String)> {
    if !cookie.contains("buvid3") {
        return None;
    }
    let b3 = extract_cookie_value(cookie, "buvid3").unwrap_or_default();
    let b4 = extract_cookie_value(cookie, "buvid4").unwrap_or_default();
    Some((b3, b4))
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
        assert!(cats[0].children[0]
            .pic
            .as_ref()
            .unwrap()
            .ends_with("@100w.png"));
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
    fn parse_category_rooms_fixture() {
        let raw = include_str!("../../../tests/fixtures/bilibili_category_rooms.json");
        let page = parse_category_rooms(raw, 30).unwrap();
        assert!(!page.has_more);
        assert_eq!(page.items.len(), 2);
        assert_eq!(page.items[0].room_id, "10001");
        // user_cover fallback
        assert!(page.items[1].cover.contains("c2.jpg"));
    }

    #[test]
    fn parse_search_strips_em() {
        let raw = include_str!("../../../tests/fixtures/bilibili_search_rooms.json");
        let page = parse_search_rooms(raw).unwrap();
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].title, "搜索结果房间");
        assert!(page.items[0].cover.starts_with("https://"));
    }

    #[test]
    fn parse_room_detail_fixture() {
        let raw = include_str!("../../../tests/fixtures/bilibili_room_info.json");
        let detail = parse_room_detail(raw, None, "b3", "SESSDATA=x").unwrap();
        assert_eq!(detail.room_id, "23058");
        assert!(detail.status);
        assert_eq!(detail.user_name, "详情主播");
        assert!(detail.user_avatar.contains("@100w.jpg"));
        assert_eq!(detail.raw["danmaku"]["buvid"], "b3");
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
        // non-mcdn first
        assert!(!urls[0].url.contains("mcdn"));
        assert!(urls[1].url.contains("mcdn"));
        assert!(urls[0].headers.contains_key("referer"));
    }

    #[test]
    fn parse_live_status_fixture() {
        let raw = include_str!("../../../tests/fixtures/bilibili_live_status.json");
        assert!(parse_live_status(raw).unwrap());
    }

    #[test]
    fn wbi_sign_stable() {
        let mut params = BTreeMap::new();
        params.insert("foo".into(), "1".into());
        params.insert("bar".into(), "2".into());
        let signed = wbi_sign_params(params, "imgkey1234567890abcdefghijklmn", "subkey1234567890abcdefghijklmn", 1700000000);
        assert_eq!(signed.get("wts").unwrap(), "1700000000");
        assert_eq!(signed.get("w_rid").unwrap().len(), 32);
        // deterministic
        let mut params2 = BTreeMap::new();
        params2.insert("foo".into(), "1".into());
        params2.insert("bar".into(), "2".into());
        let signed2 = wbi_sign_params(params2, "imgkey1234567890abcdefghijklmn", "subkey1234567890abcdefghijklmn", 1700000000);
        assert_eq!(signed.get("w_rid"), signed2.get("w_rid"));
    }

    #[test]
    fn strip_em_basic() {
        assert_eq!(strip_em_tags("a<em>b</em>c"), "abc");
        assert_eq!(
            strip_em_tags(r#"搜<em class="keyword">索</em>"#),
            "搜索"
        );
    }
}
