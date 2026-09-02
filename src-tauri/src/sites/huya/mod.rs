//! 虎牙直播站点客户端（移动页 + 传统 anticode，无 TARS 依赖）。

use std::collections::{HashMap, HashSet};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use md5::{Digest, Md5};
use percent_encoding::percent_decode_str;
use reqwest::Client;
use serde_json::Value;

use crate::error::{AppError, AppResult};
use crate::http_client;
use crate::models::live::{
    LiveCategory, LivePlayQuality, LiveRoomDetail, LiveRoomItem, LiveRoomStatus, LiveSubCategory,
    PlayUrl, RoomListPage, SiteId, accept_room_id, parse_live_started_at,
};
use crate::sites::traits::LiveSite;

const UA: &str = "Mozilla/5.0 (iPhone; CPU iPhone OS 13_2_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0.3 Mobile/15E148 Safari/604.1 Edg/109.0.0.0";
const DESKTOP_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
/// 搜索每页取多少条。上游按 `floor(start / rows)` 归桶，改这个值必须同步
/// 用 `start = rows * (page - 1)` 计算偏移，否则会重复返回同一页。
const SEARCH_ROWS: usize = 40;

pub struct HuyaSite {
    client: Client,
    /// 解析经过认证发送所需的规范房间/频道关系时，
    /// 需要手动保存的 Web 会话。它只留在这个短时效的后端站点实例内，
    /// 绝不会序列化进房间详情。
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

    /// 单层 `bussLive` 目录，作为两级 `getGameList` 接口不可用时的回落。
    /// 它把全部游戏塞进一个合成的「热门分类」父分区，二级结构会退化，
    /// 但分类浏览不会整体空掉。
    async fn legacy_flat_categories(&self) -> AppResult<Vec<LiveCategory>> {
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

    fn err(msg: impl Into<String>) -> AppError {
        AppError::new("huya_api_error", msg)
            .with_site("huya")
            .retryable()
    }

    async fn get_text(&self, url: &str, ua: &str) -> AppResult<String> {
        let mut request = self.client.get(url).header("user-agent", ua);
        // 房间引导页面可能需要浏览器会话才能暴露规范的内部频道关系。
        // 不要把私有 Cookie 重放到公开的 CDN/列表/搜索主机。
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
        // 剥离会破坏 JSON.parse 的函数体
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

        // 下播房间的移动端引导不一定暴露 lChannelId/lSubChannelId。
        // 桌面端房间负载仍带有第一方播放器所用的资料 uid，
        // 可作为信令频道的兜底。绝不能回退到公开短房间号：
        // 它不是 lTid/lSid。
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

/// 只提取对信令层有意义的桌面字段。公开资料页房间号被刻意排除：
/// 它不是 TARS 频道 id。下播页面常把两个桌面频道字段都置零，
/// 改用主播（`lp`）作为 Web 播放器的兜底。
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
    // 把 `function (...) { ... }` 替换为 `""`（按花括号配对）。
    // 重要：绝不能在非字符边界切片 `str` —— 虎牙页面包含中文 UTF-8；
    // 按字节下标遍历加 `s[i..]` 会 panic 并中止应用。
    let bytes = s.as_bytes();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i..].starts_with(b"function") {
            // 从字节偏移处查找起始花括号（ASCII `{` 是单字节）。
            if let Some(rel) = bytes[i..].iter().position(|&b| b == b'{') {
                let start_brace = i + rel;
                if let Some(end) = find_matching_brace_bytes(&bytes[start_brace..]) {
                    out.push_str("\"\"");
                    i = start_brace + end + 1;
                    continue;
                }
            }
        }
        // 安全地复制一个 UTF-8 字符。
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

/// 解析静态桌面房间赋值，例如
/// `var TT_PROFILE_INFO = {"uid": ...};`。只返回结构化的 JSON 对象，
/// 调用方即可挑选所需的少量公开房间标识符，
/// 而不必保留整个文档或用户会话。
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
    hex::encode(h.finalize())
}

fn percent_decode(s: &str) -> String {
    percent_decode_str(&s.replace('+', " "))
        .decode_utf8_lossy()
        .into_owned()
}

fn base64_decode(s: &str) -> Option<Vec<u8>> {
    // 输入来自 `percent_decode`（`+` → 空格），可能带空白；与原手写实现一致：
    // 忽略空白、剥除所有 `=`、丢弃非零 trailing bits。
    const LENIENT: GeneralPurpose = GeneralPurpose::new(
        &base64::alphabet::STANDARD,
        GeneralPurposeConfig::new()
            .with_decode_padding_mode(DecodePaddingMode::Indifferent)
            .with_decode_allow_trailing_bits(true),
    );
    let filtered: Vec<u8> = s
        .bytes()
        .filter(|c| !c.is_ascii_whitespace() && *c != b'=')
        .collect();
    LENIENT.decode(filtered).ok()
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

/// 虎牙 `/g` 页筛选条的四个二级分组。`bussTypeGameList` 的 key 就是 `bussType`，
/// 而每组的聚合入口自身也混在该组数组里，且与普通子分区字段完全同构
/// （同为 gid >= 100000 的六位数），没有任何字段可区分。因此这里用站点级常量
/// 把聚合项提取成父分区，否则父分区会在自己的 children 里出现一个同名条目。
/// 顺序与 `/g` 页筛选条一致（网游 / 单机 / 娱乐 / 手游），不按 bussType 数值排序。
const HUYA_BUSS_GROUPS: [(&str, i64, &str); 4] = [
    ("1", 100023, "网游竞技"),
    ("2", 100002, "单机热游"),
    ("8", 100022, "娱乐"),
    ("3", 100004, "手游休闲"),
];

/// 解析 `m=Game&do=getGameList` 的两级分类。
///
/// 图片只在平铺的 `gameList` 里带 `imgUrl`；`bussTypeGameList` 的条目没有该字段，
/// 所以先用 `gameList` 建一张 gid -> imgUrl 映射再回填。不按 gid 拼
/// `{gid}-MS.jpg`：拼接地址对新分类可能 404，上游给的 `-L.jpg` 才是实际存在的。
fn parse_game_list(v: &Value) -> AppResult<Vec<LiveCategory>> {
    let mut images: HashMap<i64, String> = HashMap::new();
    if let Some(arr) = v.get("gameList").and_then(|x| x.as_array()) {
        for item in arr {
            let gid = json_i64(item.get("gid").unwrap_or(&Value::Null));
            let img = json_str(item.get("imgUrl").unwrap_or(&Value::Null));
            if gid != 0 && !img.is_empty() {
                images.insert(gid, img);
            }
        }
    }

    let groups = v.get("bussTypeGameList").unwrap_or(&Value::Null);
    let mut categories = Vec::new();
    for (key, parent_gid, fallback_name) in HUYA_BUSS_GROUPS {
        let items = groups
            .get(key)
            .and_then(|x| x.as_array())
            .cloned()
            .unwrap_or_default();
        let parent_id = parent_gid.to_string();
        let mut parent_name = String::new();
        let mut children = Vec::new();
        for item in &items {
            let gid = json_i64(item.get("gid").unwrap_or(&Value::Null));
            let name = json_str(item.get("gameFullName").unwrap_or(&Value::Null));
            if gid == parent_gid {
                // 聚合项本身升格为父分区，不再作为子分类出现。
                if !name.is_empty() {
                    parent_name = name;
                }
                continue;
            }
            if gid == 0 || name.is_empty() {
                continue;
            }
            // `isHide` 实测全为 0，仍然过滤以防上游后续隐藏分区。
            if json_i64(item.get("isHide").unwrap_or(&Value::Null)) != 0 {
                continue;
            }
            children.push(LiveSubCategory {
                id: gid.to_string(),
                name,
                parent_id: parent_id.clone(),
                pic: images.get(&gid).cloned(),
            });
        }
        if children.is_empty() {
            continue;
        }
        categories.push(LiveCategory {
            id: parent_id,
            name: if parent_name.is_empty() {
                fallback_name.to_string()
            } else {
                parent_name
            },
            children,
        });
    }

    if categories.is_empty() {
        return Err(HuyaSite::err("huya game list has no categories"));
    }
    Ok(categories)
}

/// 分类浏览器会给每个父分区合成一个 id 为 `0` 的「全部X」磁贴，它不是真实分区。
/// 虎牙的父分区聚合 gid 本身就能拉房间列表（实测 `gameId=100023` 返回跨子分区的
/// 混排结果），所以这里把哨兵值换成父分区 id。与斗鱼/抖音/Twitch 的约定一致。
fn category_game_id(category: &LiveSubCategory) -> &str {
    let id = category.id.trim();
    if id == "0" {
        category.parent_id.trim()
    } else {
        id
    }
}

/// 取搜索响应里某一路索引的 `docs` 数组。
fn search_docs(v: &Value, index: &str) -> Vec<Value> {
    v.pointer(&format!("/response/{index}/docs"))
        .and_then(|x| x.as_array())
        .cloned()
        .unwrap_or_default()
}

/// 取搜索结果封面。主播索引没有直播截图，退回主播头像；
/// 在播索引偶尔也缺截图，同样退回头像，避免卡片空一块。
fn search_cover(item: &Value) -> String {
    [
        "game_screenshot",
        "game_imgUrl",
        "game_avatarUrl180",
        "game_avatarUrl52",
    ]
    .into_iter()
    .map(|key| json_str(item.get(key).unwrap_or(&Value::Null)))
    .find(|value| !value.is_empty())
    .unwrap_or_default()
}

/// 第 `page` 页对应的上游偏移。上游按 `floor(start / rows)` 归桶，
/// 因此偏移必须是 `SEARCH_ROWS` 的整数倍，否则会重复返回同一页。
fn search_start(page: u32) -> usize {
    SEARCH_ROWS * (page.max(1) as usize - 1)
}

/// 把一次搜索响应解析成一页结果。
///
/// 响应是多路索引：`3` 只含在播房间，带真实观看人数与直播截图；
/// `1` 是主播索引，覆盖未开播主播并用 `gameLiveOn` 标出开播状态。
fn parse_search_page(v: &Value, page: u32) -> RoomListPage {
    let live_docs = search_docs(v, "3");
    let anchor_docs = search_docs(v, "1");

    let mut items = Vec::with_capacity(live_docs.len() + anchor_docs.len());
    let mut seen = HashSet::new();
    // 在播索引优先：它的封面和人数比主播索引完整。它不响应 `start`，
    // 只在第一页取，后续页的在播房间由主播索引补上。
    if page <= 1 {
        for item in &live_docs {
            let room_id = json_str(item.get("room_id").unwrap_or(&Value::Null));
            if !accept_room_id(&room_id, &mut seen) {
                continue;
            }
            items.push(LiveRoomItem {
                site_id: SiteId::Huya,
                room_id,
                title: json_str(item.get("game_introduction").unwrap_or(&Value::Null)),
                cover: search_cover(item),
                user_name: json_str(item.get("game_nick").unwrap_or(&Value::Null))
                    .trim()
                    .to_string(),
                online: json_i64(item.get("game_total_count").unwrap_or(&Value::Null)),
                live_status: Some(true),
            });
        }
    }
    for item in &anchor_docs {
        let room_id = json_str(item.get("room_id").unwrap_or(&Value::Null));
        if !accept_room_id(&room_id, &mut seen) {
            continue;
        }
        let live = item
            .get("gameLiveOn")
            .and_then(|x| x.as_bool())
            .unwrap_or(false);
        // 主播索引没有观看人数字段（`game_activityCount` 是累计活跃度，
        // 与在播索引的当前人数不同量纲），留 0 表示未知，不硬凑一个数。
        items.push(LiveRoomItem {
            site_id: SiteId::Huya,
            room_id,
            // 未开播主播的 `live_intro` 是上一场或预告的标题（实测「解说一下今天的比赛！」），
            // 拿它当直播标题会让卡片看起来还在播，因此留空由展示层退回主播名，
            // 与另外三个平台的未开播条目一致。
            title: if live {
                json_str(item.get("live_intro").unwrap_or(&Value::Null))
            } else {
                String::new()
            },
            cover: search_cover(item),
            user_name: json_str(item.get("game_nick").unwrap_or(&Value::Null))
                .trim()
                .to_string(),
            online: 0,
            live_status: Some(live),
        });
    }

    // 翻页只看主播索引：它是唯一响应 `start` 的索引。
    let found = json_i64(v.pointer("/response/1/numFound").unwrap_or(&Value::Null));
    let consumed = (SEARCH_ROWS * page.max(1) as usize) as i64;
    RoomListPage {
        has_more: anchor_docs.len() >= SEARCH_ROWS && consumed < found,
        items,
    }
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
                live_status: None,
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

/// 从虎牙房间引导响应中提取关注刷新所需的少量状态负载。
/// 其中的线路和 TARS/频道标识符在这里刻意忽略；
/// 它们只在用户进入房间播放或连接弹幕之后才需要。
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
        // 首选带二级结构的目录接口；失败时回落到单层 bussLive，
        // 保证分类浏览不会因为上游接口变动而整体空掉。
        match self
            .get_json("https://www.huya.com/cache.php?m=Game&do=getGameList")
            .await
            .and_then(|v| parse_game_list(&v))
        {
            Ok(categories) => return Ok(categories),
            Err(err) => {
                tracing::debug!("huya game list unavailable; falling back to bussLive: {err}");
            }
        }
        self.legacy_flat_categories().await
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
            category_game_id(category)
        );
        parse_huya_room_list(&self.get_json(&url).await?)
    }

    async fn search_rooms(&self, keyword: &str, page: u32) -> AppResult<RoomListPage> {
        let page = page.max(1);
        let keyword = keyword.trim();
        if keyword.is_empty() {
            return Ok(RoomListPage::empty());
        }
        // `startPage` 是空转参数（任何取值都返回第一页），真正生效的偏移是
        // `start`，并且上游按 `floor(start / rows)` 归桶，所以 `start` 必须是
        // `rows` 的整数倍。实测 `rows=SEARCH_ROWS` 配 `start = rows * (page-1)`
        // 连续七页零重复。
        let url = format!(
            "https://search.cdn.huya.com/?m=Search&do=getSearchContent&q={}&uid=0&v=1&typ=-5&start={}&rows={SEARCH_ROWS}",
            urlencoding_encode(keyword),
            search_start(page)
        );
        let v = self.get_json(&url).await?;
        Ok(parse_search_page(&v, page))
    }

    async fn get_room_live_status(&self, room_id: &str) -> AppResult<LiveRoomStatus> {
        // 移动端房间引导已包含 eLiveStatus。
        // 避免 get_room_detail 中后续的播放地址/弹幕工作。
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
        // HTML 抓取遗漏时，优先使用首条线路的频道 id。
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
        // 频道 id 标识房间的消息流，而聊天发送用的 `lPid` 标识主播。
        // 两者都保留，而不是在某个频道碰巧可用时就静默互换。
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
                // 弹幕加入需要 yyuid + 频道 sid。
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
            // 房间引导当前返回的带签名虎牙 FLV 接口只有 HTTP。
            // 改写协议会使部分 CDN 线路失效，
            // 表现为立即 403 或连接被关闭。
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

    /// 真实演练搜索分页：`startPage` 曾经空转，所有页都返回第一页。
    /// 只有真实请求能证明 `start = rows * (page - 1)` 的偏移生效，
    /// 并且未开播主播确实出现在结果里。
    #[tokio::test]
    #[ignore = "live network smoke — run with --ignored"]
    async fn live_search_pagination_and_offline_anchors_smoke() {
        let site = HuyaSite::default();
        let first = site.search_rooms("英雄联盟", 1).await.expect("page 1");
        assert!(!first.items.is_empty(), "search page 1 returned no rooms");
        assert!(first.has_more, "search page 1 should offer another page");
        let offline = first
            .items
            .iter()
            .find(|item| item.live_status == Some(false))
            .expect("search page 1 returned no offline anchors");
        // 未开播条目的 `live_intro` 是旧标题，必须已经被丢掉。
        assert!(
            offline.title.is_empty(),
            "offline anchors must not carry a stale stream title"
        );
        assert!(
            first
                .items
                .iter()
                .any(|item| item.live_status == Some(true)),
            "search page 1 returned no live rooms"
        );

        let second = site.search_rooms("英雄联盟", 2).await.expect("page 2");
        assert!(!second.items.is_empty(), "search page 2 returned no rooms");
        let first_ids: Vec<_> = first.items.iter().map(|item| &item.room_id).collect();
        assert!(
            second
                .items
                .iter()
                .any(|item| !first_ids.contains(&&item.room_id)),
            "search page 2 repeated page 1 — the start offset is not taking effect"
        );
    }

    /// 等价性锚点：原手写实现把 `+` 解码为空格，截断/非法转义按字面保留。
    #[test]
    fn percent_decode_form_style() {
        assert_eq!(percent_decode("a%20b+c%2Bd"), "a b c+d");
        assert_eq!(percent_decode("%E4%B8%AD"), "中");
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("a%G1b"), "a%G1b");
        assert_eq!(percent_decode("a%2"), "a%2");
    }

    /// 等价性锚点：原手写实现忽略空白与 `=`、丢弃非零 trailing bits。
    #[test]
    fn base64_decode_lenient_like_handwritten() {
        assert_eq!(base64_decode("QQ==").as_deref(), Some(b"A".as_slice()));
        assert_eq!(
            base64_decode("U3RyZWFt").as_deref(),
            Some(b"Stream".as_slice())
        );
        // `fm` 先经 percent_decode（`+` → 空格），空白必须被忽略。
        assert_eq!(base64_decode("QSBJ").as_deref(), Some(b"A I".as_slice()));
        assert_eq!(
            base64_decode("U3Ry\nZWFt =").as_deref(),
            Some(b"Stream".as_slice())
        );
        // 2 字符块的余数位被丢弃而不是报错。
        assert_eq!(base64_decode("QR").as_deref(), Some(b"A".as_slice()));
        assert_eq!(base64_decode("!!"), None);
    }

    #[test]
    fn search_start_snaps_to_row_buckets() {
        // 上游按 `floor(start / rows)` 归桶，偏移必须是 SEARCH_ROWS 的整数倍。
        assert_eq!(search_start(1), 0);
        assert_eq!(search_start(2), SEARCH_ROWS);
        assert_eq!(search_start(7), SEARCH_ROWS * 6);
        // page 0 不是合法页码，按第一页处理而不是算出负偏移。
        assert_eq!(search_start(0), 0);
    }

    fn search_response(anchor_count: usize, num_found: i64) -> Value {
        // 未开播主播的 `live_intro` 在真实响应里也是有内容的（上一场或预告的标题），
        // 因此夹具不能用空串糊过去。
        let anchors: Vec<Value> = (0..anchor_count)
            .map(|i| {
                serde_json::json!({
                    "room_id": (2000 + i).to_string(),
                    "game_nick": format!("主播{i}"),
                    "live_intro": format!("上一场标题{i}"),
                    "game_avatarUrl180": "https://img.example/a.jpg",
                    "gameLiveOn": i % 2 == 1
                })
            })
            .collect();
        serde_json::json!({
            "response": {
                "1": {"numFound": num_found, "docs": anchors},
                "3": {"numFound": 1, "docs": [{
                    "room_id": "1001",
                    "game_nick": " 在播主播 ",
                    "game_introduction": "今天打排位",
                    "game_screenshot": "https://img.example/live.jpg",
                    "game_total_count": 12345,
                    "gameLiveOn": true
                }]}
            }
        })
    }

    #[test]
    fn search_page_one_merges_live_index_before_anchors() {
        let page = parse_search_page(&search_response(2, 100), 1);
        let ids: Vec<&str> = page.items.iter().map(|x| x.room_id.as_str()).collect();
        assert_eq!(ids, ["1001", "2000", "2001"]);

        let live = &page.items[0];
        assert_eq!(live.live_status, Some(true));
        assert_eq!(live.title, "今天打排位");
        assert_eq!(live.cover, "https://img.example/live.jpg");
        assert_eq!(live.user_name, "在播主播");
        assert_eq!(live.online, 12345);

        // 主播索引没有当前人数字段，留 0 表示未知。
        let offline = &page.items[1];
        assert_eq!(offline.live_status, Some(false));
        assert_eq!(offline.online, 0);
        assert_eq!(offline.cover, "https://img.example/a.jpg");
        // 未开播主播的 `live_intro` 是旧标题，不能当成正在播的直播标题。
        assert_eq!(offline.title, "");

        // 主播索引里正在播的条目仍然用它的直播标题。
        assert_eq!(page.items[2].live_status, Some(true));
        assert_eq!(page.items[2].title, "上一场标题1");
    }

    #[test]
    fn search_skips_the_live_index_after_the_first_page() {
        // 在播索引不响应 `start`，第二页再读会把第一页的房间重复带出来。
        let page = parse_search_page(&search_response(2, 100), 2);
        let ids: Vec<&str> = page.items.iter().map(|x| x.room_id.as_str()).collect();
        assert_eq!(ids, ["2000", "2001"]);
    }

    #[test]
    fn search_has_more_tracks_the_anchor_index_only() {
        // 满页且总数还有剩余才继续翻。
        assert!(parse_search_page(&search_response(SEARCH_ROWS, 1560), 1).has_more);
        // 不满一页说明主播索引到底了。
        assert!(!parse_search_page(&search_response(SEARCH_ROWS - 1, 1560), 1).has_more);
        // 已取满 numFound 时停下。
        assert!(!parse_search_page(&search_response(SEARCH_ROWS, SEARCH_ROWS as i64), 1).has_more);
    }

    #[test]
    fn strip_js_functions_handles_chinese_utf8() {
        // 遇到多字节 UTF-8 时不得 panic（旧的字节下标遍历曾导致应用中止）。
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

    /// 精简 fixture：保留真实响应的结构特征（平铺 `gameList` 带 `imgUrl`、
    /// `bussTypeGameList` 的条目不带 `imgUrl`、聚合项混在组内、`gid` 是 JSON number）。
    fn game_list_fixture() -> Value {
        serde_json::json!({
            "status": 200,
            "total": 8,
            "gameList": [
                {"gid": 1, "gameFullName": "英雄联盟", "isHide": 0,
                 "imgUrl": "https://huyaimg.msstatic.com/cdnimage/game/1-L.jpg"},
                {"gid": 100023, "gameFullName": "网游竞技", "isHide": 0,
                 "imgUrl": "https://huyaimg.msstatic.com/cdnimage/game/100023-L.jpg"},
                {"gid": 100043, "gameFullName": "暴雪专区", "isHide": 0,
                 "imgUrl": "https://huyaimg.msstatic.com/cdnimage/game/100043-L.jpg"},
                {"gid": 2793, "gameFullName": "天天吃鸡", "isHide": 0,
                 "imgUrl": "https://huyaimg.msstatic.com/cdnimage/game/2793-L.jpg"},
                {"gid": 2168, "gameFullName": "星秀", "isHide": 0,
                 "imgUrl": "https://huyaimg.msstatic.com/cdnimage/game/2168-L.jpg"},
                {"gid": 3203, "gameFullName": "王者荣耀", "isHide": 0,
                 "imgUrl": "https://huyaimg.msstatic.com/cdnimage/game/3203-L.jpg"}
            ],
            "bussTypeGameList": {
                "1": [
                    {"gid": 1, "gameFullName": "英雄联盟", "isHide": 0},
                    {"gid": 100023, "gameFullName": "网游竞技", "isHide": 0},
                    {"gid": 100043, "gameFullName": "暴雪专区", "isHide": 0},
                    {"gid": 999001, "gameFullName": "已隐藏分区", "isHide": 1},
                    {"gid": 0, "gameFullName": "零 gid", "isHide": 0},
                    {"gid": 999002, "gameFullName": "", "isHide": 0}
                ],
                "2": [
                    {"gid": 100002, "gameFullName": "单机热游", "isHide": 0},
                    {"gid": 2793, "gameFullName": "天天吃鸡", "isHide": 0}
                ],
                "3": [
                    {"gid": 100004, "gameFullName": "手游休闲", "isHide": 0},
                    {"gid": 3203, "gameFullName": "王者荣耀", "isHide": 0}
                ],
                "8": [
                    {"gid": 100022, "gameFullName": "娱乐", "isHide": 0},
                    {"gid": 2168, "gameFullName": "星秀", "isHide": 0}
                ]
            },
            "bussType": 0
        })
    }

    #[test]
    fn game_list_orders_parents_like_the_site_filter_bar() {
        let categories = parse_game_list(&game_list_fixture()).unwrap();
        // 顺序跟随 `/g` 页筛选条（网游 / 单机 / 娱乐 / 手游），不按 bussType 数值排序。
        assert_eq!(
            categories
                .iter()
                .map(|c| (c.id.as_str(), c.name.as_str()))
                .collect::<Vec<_>>(),
            vec![
                ("100023", "网游竞技"),
                ("100002", "单机热游"),
                ("100022", "娱乐"),
                ("100004", "手游休闲"),
            ]
        );
    }

    #[test]
    fn game_list_promotes_aggregate_entry_and_filters_noise() {
        let categories = parse_game_list(&game_list_fixture()).unwrap();
        // 聚合项升格为父分区后不得再出现在自己的 children 里；
        // isHide != 0、零 gid 和空名称也要一并剔除。数字 gid 转成字符串。
        assert_eq!(
            categories[0]
                .children
                .iter()
                .map(|c| (c.id.as_str(), c.name.as_str(), c.parent_id.as_str()))
                .collect::<Vec<_>>(),
            vec![
                ("1", "英雄联盟", "100023"),
                ("100043", "暴雪专区", "100023"),
            ]
        );
    }

    #[test]
    fn game_list_takes_pic_from_flat_game_list_img_url() {
        let categories = parse_game_list(&game_list_fixture()).unwrap();
        // 图片只在平铺 `gameList` 里，按 gid 回填上游 `-L.jpg`，不拼 `{gid}-MS.jpg`。
        assert_eq!(
            categories[0].children[0].pic.as_deref(),
            Some("https://huyaimg.msstatic.com/cdnimage/game/1-L.jpg")
        );
        assert_eq!(categories[3].children[0].id, "3203");
        assert_eq!(
            categories[3].children[0].pic.as_deref(),
            Some("https://huyaimg.msstatic.com/cdnimage/game/3203-L.jpg")
        );
    }

    #[test]
    fn game_list_falls_back_to_constant_parent_name_and_omits_missing_pic() {
        let v = serde_json::json!({
            "gameList": [],
            "bussTypeGameList": {
                "1": [{"gid": 1, "gameFullName": "英雄联盟", "isHide": 0}]
            }
        });
        let categories = parse_game_list(&v).unwrap();
        assert_eq!(categories.len(), 1);
        assert_eq!(categories[0].id, "100023");
        assert_eq!(categories[0].name, "网游竞技");
        assert_eq!(categories[0].children[0].pic, None);
    }

    #[test]
    fn game_list_errors_so_caller_can_fall_back_to_buss_live() {
        // 只有聚合项、没有任何子分区，以及响应完全不可用时都必须报错。
        let only_aggregate = serde_json::json!({
            "bussTypeGameList": {
                "1": [{"gid": 100023, "gameFullName": "网游竞技", "isHide": 0}]
            }
        });
        assert!(parse_game_list(&only_aggregate).is_err());
        assert!(parse_game_list(&Value::Null).is_err());
    }

    #[test]
    fn category_game_id_routes_synthetic_all_tile_to_parent() {
        // 前端为每个父分区合成的「全部X」磁贴形如 { id: "0", parent_id: 父分区 id }，
        // 聚合 gid 可以直接拉跨子分区的房间列表。
        let all = LiveSubCategory {
            id: "0".into(),
            name: "全部网游竞技".into(),
            parent_id: "100023".into(),
            pic: None,
        };
        assert_eq!(category_game_id(&all), "100023");

        let normal = LiveSubCategory {
            id: "1".into(),
            name: "英雄联盟".into(),
            parent_id: "100023".into(),
            pic: None,
        };
        assert_eq!(category_game_id(&normal), "1");
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
        // fm base64 解码后带有下划线，便于提取前缀。
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
