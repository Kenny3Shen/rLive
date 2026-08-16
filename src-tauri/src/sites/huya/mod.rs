//! Huya live site — ported from simple_live_core `huya_site.dart`
//! (mobile page + classic anticode; no TARS dependency).

use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

use md5::{Digest, Md5};
use reqwest::Client;
use serde_json::Value;

use crate::error::{AppError, AppResult};
use crate::http_client;
use crate::models::live::{
    LiveCategory, LivePlayQuality, LiveRoomDetail, LiveRoomItem, LiveRoomStatus, LiveSubCategory,
    PlayUrl, RoomListPage, SiteId, parse_live_started_at,
};
use crate::sites::traits::LiveSite;

const UA: &str = "Mozilla/5.0 (iPhone; CPU iPhone OS 13_2_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0.3 Mobile/15E148 Safari/604.1 Edg/109.0.0.0";
const DESKTOP_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

pub struct HuyaSite {
    client: Client,
    /// A manually saved web session is needed when resolving the canonical
    /// room/channel relationship for an authenticated send.  It stays inside
    /// this short-lived backend site instance and is never serialised into a
    /// room detail.
    cookie: String,
}

impl Default for HuyaSite {
    fn default() -> Self {
        Self {
            client: http_client::default_client(),
            cookie: String::new(),
        }
    }
}

impl HuyaSite {
    pub fn new(client: Client, cookie: String) -> Self {
        Self {
            client,
            cookie: cookie
                .trim()
                .strip_prefix("Cookie:")
                .unwrap_or(cookie.trim())
                .trim()
                .to_owned(),
        }
    }

    fn err(msg: impl Into<String>) -> AppError {
        AppError::new("huya_api_error", msg)
            .with_site("huya")
            .retryable()
    }

    async fn get_text(&self, url: &str, ua: &str) -> AppResult<String> {
        let mut request = self.client.get(url).header("user-agent", ua);
        // Room bootstrap pages may need the browser session to expose the
        // canonical internal channel relationship.  Do not replay a private
        // Cookie to public CDN/list/search hosts.
        if !self.cookie.is_empty() && is_room_page_url(url) {
            request = request.header("cookie", self.cookie.as_str());
        }
        request
            .send()
            .await
            .map_err(|e| Self::err(format!("http: {e}")))?
            .text()
            .await
            .map_err(|e| Self::err(format!("body: {e}")))
    }

    async fn get_json(&self, url: &str) -> AppResult<Value> {
        let text = self.get_text(url, DESKTOP_UA).await?;
        serde_json::from_str(&text).map_err(|e| Self::err(format!("json: {e}")))
    }

    async fn room_info(&self, room_id: &str) -> AppResult<Value> {
        let html = self
            .get_text(&format!("https://m.huya.com/{room_id}"), UA)
            .await?;
        let marker = "window.HNF_GLOBAL_INIT";
        let start = html
            .find(marker)
            .ok_or_else(|| Self::err("HNF_GLOBAL_INIT not found"))?;
        let after = &html[start + marker.len()..];
        let eq = after
            .find('=')
            .ok_or_else(|| Self::err("HNF_GLOBAL_INIT '=' missing"))?;
        let rest = after[eq + 1..].trim_start();
        let brace = rest
            .find('{')
            .ok_or_else(|| Self::err("HNF_GLOBAL_INIT object missing"))?;
        let obj_src = &rest[brace..];
        let end = find_matching_brace(obj_src).ok_or_else(|| Self::err("unbalanced JSON"))?;
        let mut json_text = obj_src[..=end].to_string();
        // Strip function bodies that break JSON.parse
        json_text = strip_js_functions(&json_text);

        let mut obj: Value =
            serde_json::from_str(&json_text).map_err(|e| Self::err(format!("parse init: {e}")))?;

        let mut top = extract_i64_near(&html, "lChannelId").unwrap_or(0);
        let mut sub = extract_i64_near(&html, "lSubChannelId").unwrap_or(0);
        let mobile_presenter = [
            obj.pointer("/roomInfo/tProfileInfo/lUid"),
            obj.pointer("/roomInfo/tLiveInfo/lPresenterUid"),
            obj.pointer("/roomInfo/tLiveInfo/lUid"),
            obj.get("presenterUid"),
        ]
        .into_iter()
        .filter_map(|value| value.map(json_i64))
        .find(|value| *value > 0)
        .unwrap_or(0);

        // Offline rooms do not always expose lChannelId/lSubChannelId in the
        // mobile bootstrap.  The desktop room payload still has the profile
        // uid used by the first-party player as its signal channel fallback.
        // Never fall back to the public short room id: it is not lTid/lSid.
        let mut desktop_presenter = 0;
        let mut desktop_ayyuid = 0;
        if (top == 0 || sub == 0)
            && let Ok(desktop_html) = self
                .get_text(&format!("https://www.huya.com/{room_id}"), DESKTOP_UA)
                .await
        {
            let room_data = parse_js_json_assignment(&desktop_html, "TT_ROOM_DATA");
            let profile_data = parse_js_json_assignment(&desktop_html, "TT_PROFILE_INFO");
            let (desktop_channel, presenter, ayyuid) =
                desktop_room_ids(room_data.as_ref(), profile_data.as_ref(), mobile_presenter);
            desktop_presenter = presenter;
            desktop_ayyuid = ayyuid;
            if top == 0 {
                top = desktop_channel;
            }
            if sub == 0 {
                sub = desktop_channel;
            }
        }
        if let Some(map) = obj.as_object_mut() {
            map.insert("topSid".into(), Value::from(top));
            map.insert("subSid".into(), Value::from(sub));
            if desktop_presenter > 0 {
                map.insert("presenterUid".into(), Value::from(desktop_presenter));
            } else if mobile_presenter > 0 {
                map.insert("presenterUid".into(), Value::from(mobile_presenter));
            }
            if desktop_ayyuid > 0 {
                map.insert("ayyuid".into(), Value::from(desktop_ayyuid));
            }
        }
        Ok(obj)
    }
}

fn is_room_page_url(url: &str) -> bool {
    url.starts_with("https://m.huya.com/") || url.starts_with("https://www.huya.com/")
}

/// Extract the only desktop fields that are meaningful to the signal layer.
/// The public profile room number is deliberately absent: it is not a TARS
/// channel ID. Offline pages commonly set both desktop channel fields to zero
/// and use the broadcaster (`lp`) as the web-player fallback instead.
fn desktop_room_ids(
    room_data: Option<&Value>,
    profile_data: Option<&Value>,
    mobile_presenter: i64,
) -> (i64, i64, i64) {
    let presenter = profile_data
        .and_then(|value| value.get("lp").or_else(|| value.get("uid")))
        .map(json_i64)
        .filter(|value| *value > 0)
        .unwrap_or(0);
    let channel = room_data
        .and_then(|value| {
            [value.get("liveChannel"), value.get("channel")]
                .into_iter()
                .flatten()
                .map(json_i64)
                .find(|value| *value > 0)
        })
        .or_else(|| (presenter > 0).then_some(presenter))
        .or_else(|| (mobile_presenter > 0).then_some(mobile_presenter))
        .unwrap_or(0);
    let ayyuid = room_data
        .and_then(|value| value.get("privateHost"))
        .map(json_i64)
        .filter(|value| *value > 0)
        .or_else(|| {
            profile_data
                .and_then(|value| value.get("yyid"))
                .map(json_i64)
                .filter(|value| *value > 0)
        })
        .unwrap_or(0);
    (channel, presenter, ayyuid)
}

fn find_matching_brace(s: &str) -> Option<usize> {
    find_matching_brace_bytes(s.as_bytes())
}

fn strip_js_functions(s: &str) -> String {
    // Replace `function (...) { ... }` with `""` (brace-matched).
    // IMPORTANT: never slice `str` at non-char boundaries — Huya pages contain
    // Chinese UTF-8; a byte-index walk + `s[i..]` panics and aborts the app.
    let bytes = s.as_bytes();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i..].starts_with(b"function") {
            // Find opening brace from byte offset (ASCII `{` is a single byte).
            if let Some(rel) = bytes[i..].iter().position(|&b| b == b'{') {
                let start_brace = i + rel;
                if let Some(end) = find_matching_brace_bytes(&bytes[start_brace..]) {
                    out.push_str("\"\"");
                    i = start_brace + end + 1;
                    continue;
                }
            }
        }
        // Copy one UTF-8 character safely.
        let ch = s[i..].chars().next().unwrap_or('\u{FFFD}');
        let len = ch.len_utf8();
        out.push(ch);
        i += len;
    }
    out
}

fn find_matching_brace_bytes(bytes: &[u8]) -> Option<usize> {
    if bytes.first() != Some(&b'{') {
        return None;
    }
    let mut depth = 0i32;
    let mut in_str = false;
    let mut esc = false;
    for (i, &c) in bytes.iter().enumerate() {
        if in_str {
            if esc {
                esc = false;
            } else if c == b'\\' {
                esc = true;
            } else if c == b'"' {
                in_str = false;
            }
            continue;
        }
        match c {
            b'"' => in_str = true,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            _ => {}
        }
    }
    None
}

fn extract_i64_near(html: &str, key: &str) -> Option<i64> {
    let pat = format!("\"{key}\"");
    let idx = html.find(&pat)?;
    let after = &html[idx + pat.len()..];
    let colon = after.find(':')?;
    let rest = after[colon + 1..].trim_start();
    let num: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    num.parse().ok()
}

/// Parse a static desktop room assignment such as
/// `var TT_PROFILE_INFO = {"uid": ...};`.  Only the structured JSON object
/// is returned, so callers can select the few public room identifiers they
/// need without retaining the document or a user session.
fn parse_js_json_assignment(html: &str, marker: &str) -> Option<Value> {
    let start = html.find(marker)?;
    let after = &html[start + marker.len()..];
    let eq = after.find('=')?;
    let rest = after[eq + 1..].trim_start();
    let brace = rest.find('{')?;
    let source = &rest[brace..];
    let end = find_matching_brace(source)?;
    serde_json::from_str(&source[..=end]).ok()
}

fn process_anticode(anticode: &str, uid: &str, stream_name: &str) -> String {
    let mut query: HashMap<String, String> = HashMap::new();
    for part in anticode.split('&') {
        if let Some((k, v)) = part.split_once('=') {
            query.insert(k.to_string(), v.to_string());
        }
    }
    query.insert("t".into(), "103".into());
    query.insert("ctype".into(), "tars_mobile".into());

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let ws_time = format!("{:x}", now + 21600);
    let seq_id = format!("{}", now * 1000 + uid.parse::<u64>().unwrap_or(0));

    let fm_raw = query.get("fm").cloned().unwrap_or_default();
    let fm_decoded = percent_decode(&fm_raw);
    let fm_bytes = base64_decode(&fm_decoded).unwrap_or_default();
    let fm = String::from_utf8_lossy(&fm_bytes);
    let ws_secret_prefix = fm.split('_').next().unwrap_or("");
    let ctype = query
        .get("ctype")
        .cloned()
        .unwrap_or_else(|| "tars_mobile".into());
    let t = query.get("t").cloned().unwrap_or_else(|| "103".into());
    let fs = query.get("fs").cloned().unwrap_or_default();

    let ws_secret_hash = md5_hex(&format!("{seq_id}|{ctype}|{t}"));
    let ws_secret = md5_hex(&format!(
        "{ws_secret_prefix}_{uid}_{stream_name}_{ws_secret_hash}_{ws_time}"
    ));
    let uuid = format!("{}", (now % 10_000_000_000) * 1000 % 0xffff_ffff);

    format!(
        "wsSecret={ws_secret}&wsTime={ws_time}&seqid={seq_id}&ctype={ctype}&ver=1&fs={fs}&dMod=mseh-0&sdkPcdn=1_1&uid={uid}&uuid={uuid}&t={t}&sv=202411221719&sdk_sid=1732862566708&a_block=0"
    )
}

fn md5_hex(s: &str) -> String {
    let mut h = Md5::new();
    h.update(s.as_bytes());
    format!("{:x}", h.finalize())
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let (Some(a), Some(b)) = (from_hex(bytes[i + 1]), from_hex(bytes[i + 2]))
        {
            out.push((a << 4) | b);
            i += 3;
            continue;
        }
        out.push(if bytes[i] == b'+' { b' ' } else { bytes[i] });
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn from_hex(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

fn base64_decode(s: &str) -> Option<Vec<u8>> {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut inv = [255u8; 256];
    for (i, &c) in T.iter().enumerate() {
        inv[c as usize] = i as u8;
    }
    let s: Vec<u8> = s
        .bytes()
        .filter(|c| !c.is_ascii_whitespace() && *c != b'=')
        .collect();
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    for chunk in s.chunks(4) {
        if chunk.len() < 2 {
            break;
        }
        let mut n = 0u32;
        let mut bits = 0;
        for &c in chunk {
            let v = inv[c as usize];
            if v == 255 {
                return None;
            }
            n = (n << 6) | u32::from(v);
            bits += 6;
        }
        while bits >= 8 {
            bits -= 8;
            out.push((n >> bits) as u8);
            n &= (1 << bits) - 1;
        }
    }
    Some(out)
}

fn json_i64(v: &Value) -> i64 {
    v.as_i64()
        .or_else(|| v.as_u64().map(|u| u as i64))
        .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
        .unwrap_or(0)
}

fn json_str(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Null => String::new(),
        _ => v.to_string(),
    }
}

fn urlencoding_encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.as_bytes() {
        match *b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn parse_huya_room_list(v: &Value) -> AppResult<RoomListPage> {
    let data = v.get("data").cloned().unwrap_or(Value::Null);
    let mut items = Vec::new();
    if let Some(arr) = data.get("datas").and_then(|x| x.as_array()) {
        for item in arr {
            let mut cover = json_str(item.get("screenshot").unwrap_or(&Value::Null));
            if !cover.is_empty() && !cover.contains('?') {
                cover.push_str("?x-oss-process=style/w338_h190&");
            }
            let mut title = json_str(item.get("introduction").unwrap_or(&Value::Null));
            if title.is_empty() {
                title = json_str(item.get("roomName").unwrap_or(&Value::Null));
            }
            items.push(LiveRoomItem {
                site_id: SiteId::Huya,
                room_id: json_str(item.get("profileRoom").unwrap_or(&Value::Null)),
                title,
                cover,
                user_name: json_str(item.get("nick").unwrap_or(&Value::Null)),
                online: json_i64(item.get("totalCount").unwrap_or(&Value::Null)),
            });
        }
    }
    let page = json_i64(data.get("page").unwrap_or(&Value::Null));
    let total = json_i64(data.get("totalPage").unwrap_or(&Value::Null));
    Ok(RoomListPage {
        has_more: page < total,
        items,
    })
}

/// Extract the small status payload needed by a follow refresh from Huya's
/// room bootstrap response.  The stream lines and TARS/channel identifiers in
/// that response are deliberately ignored here; they are only needed after a
/// user enters a room to play it or connect danmaku.
fn live_status_from_room_info(info: &Value) -> LiveRoomStatus {
    let live_info = info.pointer("/roomInfo/tLiveInfo").unwrap_or(&Value::Null);
    let status = info.pointer("/roomInfo/eLiveStatus").map(json_i64) == Some(2);
    LiveRoomStatus {
        status,
        live_started_at: status
            .then(|| {
                parse_live_started_at(
                    live_info
                        .get("iLiveStartTime")
                        .or_else(|| live_info.get("lLiveStartTime"))
                        .or_else(|| live_info.get("iStartTime"))
                        .or_else(|| live_info.get("lStartTime"))
                        .or_else(|| live_info.get("startTime"))
                        .or_else(|| info.pointer("/roomInfo/iStartTime")),
                )
            })
            .flatten(),
    }
}

#[async_trait::async_trait]
impl LiveSite for HuyaSite {
    async fn get_categories(&self) -> AppResult<Vec<LiveCategory>> {
        let v = self
            .get_json("https://live.cdn.huya.com/liveconfig/game/bussLive")
            .await
            .unwrap_or(Value::Null);
        let mut children = Vec::new();
        if let Some(arr) = v.get("data").and_then(|d| d.as_array()) {
            for item in arr {
                let gid = json_str(item.get("gid").unwrap_or(&Value::Null));
                let name = json_str(item.get("gameFullName").unwrap_or(&Value::Null));
                if gid.is_empty() || name.is_empty() {
                    continue;
                }
                children.push(LiveSubCategory {
                    id: gid.clone(),
                    name,
                    parent_id: "0".into(),
                    pic: Some(format!(
                        "https://huyaimg.msstatic.com/cdnimage/game/{gid}-MS.jpg"
                    )),
                });
            }
        }
        if children.is_empty() {
            children.push(LiveSubCategory {
                id: "1".into(),
                name: "网游竞技".into(),
                parent_id: "0".into(),
                pic: None,
            });
        }
        Ok(vec![LiveCategory {
            id: "0".into(),
            name: "热门分类".into(),
            children,
        }])
    }

    async fn get_recommend_rooms(&self, page: u32) -> AppResult<RoomListPage> {
        let page = page.max(1);
        let url = format!(
            "https://www.huya.com/cache.php?m=LiveList&do=getLiveListByPage&tagAll=0&page={page}"
        );
        parse_huya_room_list(&self.get_json(&url).await?)
    }

    async fn get_category_rooms(
        &self,
        category: &LiveSubCategory,
        page: u32,
    ) -> AppResult<RoomListPage> {
        let page = page.max(1);
        let url = format!(
            "https://www.huya.com/cache.php?m=LiveList&do=getLiveListByPage&gameId={}&tagAll=0&page={page}",
            category.id
        );
        parse_huya_room_list(&self.get_json(&url).await?)
    }

    async fn search_rooms(&self, keyword: &str, page: u32) -> AppResult<RoomListPage> {
        let page = page.max(1);
        let url = format!(
            "https://search.cdn.huya.com/?m=Search&do=getSearchContent&q={}&uid=0&v=1&typ=-5&startPage={page}&rows=20",
            urlencoding_encode(keyword)
        );
        let v = self.get_json(&url).await?;
        let mut items = Vec::new();
        let docs = v
            .pointer("/response/3/docs")
            .or_else(|| v.pointer("/response/1/docs"))
            .and_then(|x| x.as_array())
            .cloned()
            .unwrap_or_default();
        for item in docs {
            let room_id = json_str(item.get("room_id").unwrap_or(&Value::Null));
            if room_id.is_empty() {
                continue;
            }
            items.push(LiveRoomItem {
                site_id: SiteId::Huya,
                room_id,
                title: json_str(item.get("game_introduction").unwrap_or(&Value::Null)),
                cover: json_str(item.get("game_screenshot").unwrap_or(&Value::Null)),
                user_name: json_str(item.get("game_nick").unwrap_or(&Value::Null)),
                online: json_i64(item.get("game_total_count").unwrap_or(&Value::Null)),
            });
        }
        Ok(RoomListPage {
            has_more: items.len() >= 20,
            items,
        })
    }

    async fn get_room_live_status(&self, room_id: &str) -> AppResult<LiveRoomStatus> {
        // The mobile room bootstrap already contains eLiveStatus.  Avoid the
        // later play-url/danmaku work performed by get_room_detail.
        let room = self.room_info(room_id).await?;
        Ok(live_status_from_room_info(&room))
    }

    async fn get_room_detail(&self, room_id: &str) -> AppResult<LiveRoomDetail> {
        let info = self.room_info(room_id).await?;
        let live_info = info
            .pointer("/roomInfo/tLiveInfo")
            .cloned()
            .unwrap_or(Value::Null);
        let profile = info
            .pointer("/roomInfo/tProfileInfo")
            .cloned()
            .unwrap_or(Value::Null);
        let mut top_sid = json_i64(info.get("topSid").unwrap_or(&Value::Null));
        let mut sub_sid = json_i64(info.get("subSid").unwrap_or(&Value::Null));
        // Prefer channel ids from first stream line when HTML scrape missed them.
        if let Some(first) = live_info
            .pointer("/tLiveStreamInfo/vStreamInfo/value")
            .and_then(|v| v.as_array())
            .and_then(|a| a.first())
        {
            if top_sid == 0 {
                top_sid = json_i64(first.get("lChannelId").unwrap_or(&Value::Null));
            }
            if sub_sid == 0 {
                sub_sid = json_i64(first.get("lSubChannelId").unwrap_or(&Value::Null));
            }
        }
        if top_sid == 0 {
            top_sid = json_i64(live_info.get("lChannel").unwrap_or(&Value::Null));
        }
        if top_sid == 0 {
            top_sid = json_i64(live_info.get("lUid").unwrap_or(&Value::Null));
        }
        if sub_sid == 0 {
            sub_sid = top_sid;
        }
        // Channel ids identify a room's message stream, whereas `lPid` for a
        // chat send identifies the presenter. Keep both rather than silently
        // substituting one for the other when a channel happens to work.
        let presenter = [
            json_i64(info.get("presenterUid").unwrap_or(&Value::Null)),
            json_i64(profile.get("lUid").unwrap_or(&Value::Null)),
            json_i64(live_info.get("lPresenterUid").unwrap_or(&Value::Null)),
            json_i64(live_info.get("lUid").unwrap_or(&Value::Null)),
        ]
        .into_iter()
        .find(|value| *value > 0)
        .unwrap_or(if top_sid > 0 { top_sid } else { sub_sid });
        let ayyuid = {
            let y = json_i64(live_info.get("lYyid").unwrap_or(&Value::Null));
            if y != 0 {
                y
            } else {
                let y = json_i64(profile.get("lYyid").unwrap_or(&Value::Null));
                if y != 0 {
                    y
                } else {
                    json_i64(info.get("ayyuid").unwrap_or(&Value::Null))
                }
            }
        };

        let mut title = json_str(live_info.get("sIntroduction").unwrap_or(&Value::Null));
        if title.is_empty() {
            title = json_str(live_info.get("sRoomName").unwrap_or(&Value::Null));
        }

        let mut lines = Vec::new();
        if let Some(arr) = live_info
            .pointer("/tLiveStreamInfo/vStreamInfo/value")
            .and_then(|v| v.as_array())
        {
            for item in arr {
                let flv = json_str(item.get("sFlvUrl").unwrap_or(&Value::Null));
                if flv.is_empty() {
                    continue;
                }
                lines.push(serde_json::json!({
                    "line": flv,
                    "flvAntiCode": json_str(item.get("sFlvAntiCode").unwrap_or(&Value::Null)),
                    "streamName": json_str(item.get("sStreamName").unwrap_or(&Value::Null)),
                    "cdnType": json_str(item.get("sCdnType").unwrap_or(&Value::Null)),
                    "topSid": top_sid,
                    "subSid": sub_sid,
                    "presenterUid": presenter,
                }));
            }
        }

        let mut bit_rates = Vec::new();
        if let Some(arr) = live_info
            .pointer("/tLiveStreamInfo/vBitRateInfo/value")
            .and_then(|v| v.as_array())
        {
            for item in arr {
                let name = json_str(item.get("sDisplayName").unwrap_or(&Value::Null));
                if name.contains("HDR") {
                    continue;
                }
                bit_rates.push(serde_json::json!({
                    "name": name,
                    "bitRate": json_i64(item.get("iBitRate").unwrap_or(&Value::Null)),
                }));
            }
        }
        if bit_rates.is_empty() {
            bit_rates.push(serde_json::json!({"name":"原画","bitRate":0}));
            bit_rates.push(serde_json::json!({"name":"高清","bitRate":2000}));
        }

        let status = info
            .pointer("/roomInfo/eLiveStatus")
            .and_then(|v| v.as_i64())
            == Some(2);

        let uid = format!(
            "{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis() % 9_000_000_000 + 1_000_000_000)
                .unwrap_or(1_234_567_890)
        );

        Ok(LiveRoomDetail {
            site_id: SiteId::Huya,
            room_id: {
                let r = json_str(
                    live_info
                        .get("lProfileRoom")
                        .unwrap_or(&Value::String(room_id.into())),
                );
                if r.is_empty() { room_id.to_string() } else { r }
            },
            title,
            cover: json_str(live_info.get("sScreenshot").unwrap_or(&Value::Null)),
            user_name: json_str(profile.get("sNick").unwrap_or(&Value::Null)),
            user_avatar: json_str(profile.get("sAvatar180").unwrap_or(&Value::Null)),
            online: json_i64(live_info.get("lTotalCount").unwrap_or(&Value::Null)),
            status,
            live_started_at: parse_live_started_at(
                live_info
                    .get("iLiveStartTime")
                    .or_else(|| live_info.get("lLiveStartTime"))
                    .or_else(|| live_info.get("iStartTime"))
                    .or_else(|| live_info.get("lStartTime"))
                    .or_else(|| live_info.get("startTime"))
                    .or_else(|| info.pointer("/roomInfo/iStartTime")),
            ),
            notice: json_str(info.get("welcomeText").unwrap_or(&Value::Null)),
            url: format!("https://www.huya.com/{room_id}"),
            raw: serde_json::json!({
                "uid": uid,
                "lines": lines,
                "bitRates": bit_rates,
                "topSid": top_sid,
                "subSid": sub_sid,
                "presenterUid": presenter,
                "lp": presenter,
                // Danmaku join needs yyuid + channel sids (simple_live HuyaDanmakuArgs).
                "ayyuid": ayyuid,
                "lYyid": ayyuid,
            }),
        })
    }

    async fn get_play_qualities(&self, detail: &LiveRoomDetail) -> AppResult<Vec<LivePlayQuality>> {
        let bit_rates = detail
            .raw
            .get("bitRates")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let lines = detail
            .raw
            .get("lines")
            .cloned()
            .unwrap_or(Value::Array(vec![]));
        let mut out = Vec::new();
        for br in bit_rates {
            let name = json_str(br.get("name").unwrap_or(&Value::Null));
            let bit_rate = json_i64(br.get("bitRate").unwrap_or(&Value::Null));
            out.push(LivePlayQuality {
                quality: if name.is_empty() {
                    format!("{bit_rate}")
                } else {
                    name
                },
                data: serde_json::json!({
                    "bitRate": bit_rate,
                    "lines": lines,
                    "uid": detail.raw.get("uid").cloned().unwrap_or(Value::String("0".into())),
                }),
            });
        }
        if out.is_empty() {
            out.push(LivePlayQuality {
                quality: "原画".into(),
                data: serde_json::json!({
                    "bitRate": 0,
                    "lines": lines,
                    "uid": detail.raw.get("uid").cloned().unwrap_or(Value::String("0".into())),
                }),
            });
        }
        Ok(out)
    }

    async fn get_play_urls(
        &self,
        detail: &LiveRoomDetail,
        quality: &LivePlayQuality,
    ) -> AppResult<Vec<PlayUrl>> {
        let bit_rate = json_i64(quality.data.get("bitRate").unwrap_or(&Value::Null));
        let uid = json_str(
            quality
                .data
                .get("uid")
                .unwrap_or(&Value::String("0".into())),
        );
        let lines = quality
            .data
            .get("lines")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let mut headers = HashMap::new();
        headers.insert("user-agent".into(), UA.into());
        headers.insert(
            "referer".into(),
            format!("https://www.huya.com/{}", detail.room_id),
        );
        headers.insert("origin".into(), "https://www.huya.com".into());

        let mut urls = Vec::new();
        for (index, line) in lines.into_iter().enumerate() {
            let base = json_str(line.get("line").unwrap_or(&Value::Null));
            let stream = json_str(line.get("streamName").unwrap_or(&Value::Null));
            let anti = json_str(line.get("flvAntiCode").unwrap_or(&Value::Null));
            let cdn_type = json_str(line.get("cdnType").unwrap_or(&Value::Null));
            if base.is_empty() || stream.is_empty() {
                continue;
            }
            let q = process_anticode(&anti, &uid, &stream);
            // The signed Huya FLV endpoints currently returned by the room
            // bootstrap are HTTP-only. Rewriting the scheme invalidates some
            // CDN lines and surfaces as an immediate 403/connection close.
            let mut url = format!("{}/{stream}.flv?{q}", base.trim_end_matches('/'));
            if bit_rate > 0 {
                url.push_str(&format!("&ratio={bit_rate}"));
            }
            let source_id = if cdn_type.is_empty() {
                format!("huya:{}", index + 1)
            } else {
                format!("huya:{cdn_type}")
            };
            urls.push(PlayUrl::inferred(
                source_id,
                format!("线路{}", index + 1),
                index as u32,
                url,
                headers.clone(),
            ));
        }
        if urls.is_empty() {
            return Err(Self::err("no huya play urls"));
        }
        Ok(urls)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_js_functions_handles_chinese_utf8() {
        // Must not panic on multi-byte UTF-8 (old byte-index walk aborted the app).
        let src = r#"{"sNick":"虎牙英雄联盟赛事","cb":function(x){return x;},"ok":1}"#;
        let out = strip_js_functions(src);
        assert!(out.contains("虎牙英雄联盟赛事"), "{out}");
        assert!(out.contains(r#""cb":"""#), "{out}");
        assert!(out.contains(r#""ok":1"#), "{out}");
        let v: Value = serde_json::from_str(&out).expect("valid json");
        assert_eq!(v["sNick"], "虎牙英雄联盟赛事");
        assert_eq!(v["ok"], 1);
    }

    #[test]
    fn parses_offline_desktop_room_assignments_without_using_short_room_id() {
        let html = r#"
            <script>
              var TT_ROOM_DATA = {"channel":0,"liveChannel":0,"privateHost":35184476588085};
              var TT_PROFILE_INFO = {"lp":1199554147512,"yyid":35184476588085,"profileRoom":31339681,"nick":"主播"};
            </script>
        "#;
        let room = parse_js_json_assignment(html, "TT_ROOM_DATA").unwrap();
        let profile = parse_js_json_assignment(html, "TT_PROFILE_INFO").unwrap();
        assert_eq!(json_i64(profile.get("profileRoom").unwrap()), 31339681);
        assert_eq!(
            desktop_room_ids(Some(&room), Some(&profile), 0),
            (1199554147512, 1199554147512, 35184476588085)
        );
    }

    #[test]
    fn desktop_channel_uses_nonzero_channel_before_presenter_fallback() {
        let room = serde_json::json!({"liveChannel": 0, "channel": 456, "privateHost": 789});
        let profile = serde_json::json!({"lp": 123, "yyid": 999});
        assert_eq!(
            desktop_room_ids(Some(&room), Some(&profile), 321),
            (456, 123, 789)
        );
    }

    #[test]
    fn cookie_is_limited_to_huya_room_pages() {
        assert!(is_room_page_url("https://m.huya.com/31339681"));
        assert!(is_room_page_url("https://www.huya.com/31339681"));
        assert!(!is_room_page_url(
            "https://live.cdn.huya.com/liveconfig/game/bussLive"
        ));
        assert!(!is_room_page_url("https://search.cdn.huya.com/?q=test"));
    }

    #[test]
    fn room_info_status_probe_reads_live_status_and_start_time() {
        let info = serde_json::json!({
            "roomInfo": {
                "eLiveStatus": "2",
                "tLiveInfo": { "iLiveStartTime": 1_704_067_200 }
            }
        });
        assert_eq!(
            live_status_from_room_info(&info),
            LiveRoomStatus {
                status: true,
                live_started_at: Some(1_704_067_200_000),
            }
        );

        let offline = serde_json::json!({ "roomInfo": { "eLiveStatus": 0 } });
        assert!(!live_status_from_room_info(&offline).status);
    }

    #[test]
    fn process_anticode_builds_query() {
        let anti = "wsSecret=abc&wsTime=1&fm=UkZkeE9FSmpTak5vTmtSS2REWlVXVjhrTUY4a01WOGtNbDhrTXclM0QlM0Q%3D&ctype=tars_mobile&fs=bgct&t=103";
        // fm base64 decodes to something with underscores for prefix extraction.
        let q = process_anticode(anti, "1234567890", "stream-name");
        assert!(q.contains("wsSecret="), "{q}");
        assert!(q.contains("uid=1234567890"), "{q}");
        assert!(q.contains("ctype=tars_mobile"), "{q}");
    }

    #[tokio::test]
    async fn play_urls_preserve_http_cdn_scheme_and_use_room_referer() {
        let detail = LiveRoomDetail {
            site_id: SiteId::Huya,
            room_id: "test-room".into(),
            title: String::new(),
            cover: String::new(),
            user_name: String::new(),
            user_avatar: String::new(),
            online: 0,
            status: true,
            live_started_at: None,
            notice: String::new(),
            url: "https://www.huya.com/test-room".into(),
            raw: serde_json::json!({}),
        };
        let quality = LivePlayQuality {
            quality: "原画".into(),
            data: serde_json::json!({
                "bitRate": 0,
                "uid": "1234567890",
                "lines": [{
                    "line": "http://al.flv.huya.com/src/",
                    "streamName": "stream-name",
                    "flvAntiCode": "fm=UkZkeE9FSmpTak5vTmtSS2REWlVXVjhrTUY4a01WOGtNbDhrTXclM0QlM0Q%3D&ctype=tars_mobile&fs=bgct&t=103",
                    "cdnType": "AL"
                }]
            }),
        };

        let urls = HuyaSite::default()
            .get_play_urls(&detail, &quality)
            .await
            .unwrap();

        assert_eq!(urls.len(), 1);
        assert!(
            urls[0]
                .url
                .starts_with("http://al.flv.huya.com/src/stream-name.flv?")
        );
        assert_eq!(
            urls[0].headers.get("referer").map(String::as_str),
            Some("https://www.huya.com/test-room")
        );
        assert_eq!(
            urls[0].headers.get("origin").map(String::as_str),
            Some("https://www.huya.com")
        );
    }
}
