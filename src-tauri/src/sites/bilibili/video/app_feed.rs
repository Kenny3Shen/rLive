//! APP 首页混合推荐流：匿名、免签名，设备标识由父模块请求层携带。
//!
//! `goto` 决定是否为 UGC，`card_goto` 只参与明确广告的排除，不推断画幅。
//! APP 不给 bvid，在本地按完整整数 aid 转换，避免每条卡片补一次 view 请求。

use std::collections::HashSet;
use std::future::Future;

use reqwest::Url;
use serde_json::Value;

use crate::error::AppResult;
use crate::models::video::{VideoDimension, VideoItem, VideoListPage};

use super::{BilibiliSite, avatar_thumb, strip_em_tags, video_cover, video_dimension, video_err};

/// 一次请求并发取几批。
///
/// 上游无页码也无游标，每批固定 9~11 条且**每次调用都换一批内容**，因此凑够 20 条
/// 必须多批。这里与 story feed 的关键差异是：主 feed 的批次彼此独立，并发取回的
/// 是不同窗口（实测 4 批并发的唯一条数中位 31，最低 26，从未低于目标 20），
/// 而 story 的轮换游标由服务端按时间推进，并发只会拿到重叠切片。
///
/// 并发而不是串行，是因为单批耗时被上游的设备个性化路径主导：带 `buvid` 请求
/// 实测约 500ms，不带约 140ms，因此串行 3 批固定付出约 1.5s 的等待。
/// 实测（真机主窗口，`video_get_recommend`）：串行 3 批中位约 1.95s，4 批并发
/// 中位约 0.82s；默认目标 20 条连测 40 轮全部返回满 20 条。
///
/// 4 批而不是 3：并发取回的窗口有少量重叠，3 批的去重后唯一条数最低探到 18
/// （低于默认目标），余量太薄；4 批在同样时延下把最低唯一条数抬到 28，并且仍然
/// 只发 4 个请求。
const FEED_BATCHES: usize = 4;

const MAX_AID: u64 = 1 << 51;
const BV_XOR: u64 = 23_442_827_791_579;
const BV_TABLE: &[u8; 58] = b"FcwAPNKTMug3GV5Lj7EJnHpWsx4tb8haYeviqBz6rkCy12mUSDQX9RdoZf";

fn app_feed_params() -> Vec<(&'static str, String)> {
    [
        ("build", "8130300"),
        ("mobi_app", "android"),
        ("platform", "android"),
        ("device", "phone"),
        ("style", "2"),
        ("column", "4"),
    ]
    .into_iter()
    .map(|(key, value)| (key, value.to_owned()))
    .collect()
}

impl BilibiliSite {
    /// page_size 只是本次目标；上游无可靠页码，最多并发取 [`FEED_BATCHES`] 批，不无限凑数。
    pub(super) async fn video_app_recommend(&self, page_size: u32) -> AppResult<VideoListPage> {
        let params = app_feed_params();
        collect_app_feed(page_size, || self.get_app_feed("", &params)).await
    }
}

/// 仅注入传输边界，便于离线验证次数、顺序和部分成功；生产仍复用同一请求层。
async fn collect_app_feed<F, Fut>(page_size: u32, mut fetch: F) -> AppResult<VideoListPage>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = AppResult<String>>,
{
    let target = page_size.clamp(1, 30) as usize;
    // 先并发把整波请求发出去，再按顺序解析、去重。串行等待是这里唯一的
    // 数量级瓶颈（见 [`FEED_BATCHES`]）；并发发起不改变「首批失败即报错、
    // 后续失败返回部分结果」的语义，因为取舍仍按批序进行。
    let batches = futures_util::future::join_all((0..FEED_BATCHES).map(|_| fetch())).await;
    let mut items = Vec::with_capacity(target);
    let mut taken = HashSet::new();
    let mut has_more = false;
    for raw in batches {
        let batch = match raw.and_then(|raw| parse_app_feed(&raw)) {
            Ok(batch) => batch,
            Err(error) => {
                if items.is_empty() {
                    return Err(error);
                }
                // 短暂失败不否定已取到的卡片，也不宣告上游已耗尽。
                has_more = true;
                break;
            }
        };
        if batch.is_empty() {
            has_more = false;
            break;
        }
        let before = items.len();
        for item in batch {
            if taken.insert(item.bvid.clone()) {
                items.push(item);
                if items.len() == target {
                    break;
                }
            }
        }
        has_more = items.len() > before;
        if items.len() == target {
            break;
        }
        // 重复批仍允许消耗剩余预算；最后一批也无新增时落下 has_more，避免空转。
    }
    if items.is_empty() {
        return Err(video_err("APP 推荐流未返回可播放视频"));
    }
    Ok(VideoListPage { items, has_more })
}

fn parse_app_feed(raw: &str) -> AppResult<Vec<VideoItem>> {
    let root: Value = serde_json::from_str(raw)
        .map_err(|error| video_err(format!("APP 推荐流 JSON: {error}")))?;
    let code = root
        .get("code")
        .and_then(Value::as_i64)
        .ok_or_else(|| video_err("APP 推荐流缺少有效 code"))?;
    if code != 0 {
        return Err(video_err(format!("APP 推荐流返回错误 {code}")));
    }
    let items = root
        .pointer("/data/items")
        .and_then(Value::as_array)
        .ok_or_else(|| video_err("APP 推荐流缺少 data.items"))?;
    Ok(items.iter().filter_map(app_video_item).collect())
}

/// 标识符只接受十进制整数字符串或 JSON 整数，绝不途经浮点数。
fn decimal_u64(raw: &str) -> Option<u64> {
    let raw = raw.trim();
    if raw.is_empty() || !raw.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    raw.parse().ok()
}

fn json_u64(value: &Value) -> Option<u64> {
    match value {
        Value::String(raw) => decimal_u64(raw),
        Value::Number(number) => number.as_u64(),
        _ => None,
    }
}

fn positive_i64(value: u64) -> Option<i64> {
    i64::try_from(value).ok().filter(|value| *value > 0)
}

/// 新版 av → BV；旧 aid 与 51 位新 aid 共用同一算法。
fn aid_to_bvid(aid: u64) -> Option<String> {
    if aid == 0 || aid >= MAX_AID {
        return None;
    }
    let mut value = (MAX_AID | aid) ^ BV_XOR;
    let mut bvid = *b"BV1000000000";
    for index in (3..12).rev() {
        if value == 0 {
            break;
        }
        bvid[index] = BV_TABLE[(value % 58) as usize];
        value /= 58;
    }
    bvid.swap(3, 9);
    bvid.swap(4, 7);
    String::from_utf8(bvid.to_vec()).ok()
}

fn explicit_flag(value: &Value) -> bool {
    value.as_bool() == Some(true)
        || value
            .as_str()
            .is_some_and(|raw| raw.eq_ignore_ascii_case("true"))
        || json_u64(value).is_some_and(|value| value > 0)
}

fn is_ad(item: &Value) -> bool {
    item.get("card_goto")
        .and_then(Value::as_str)
        .is_some_and(|goto| goto.starts_with("ad"))
        || [
            "/is_ad",
            "/is_advertisement",
            "/ad_info/is_ad",
            "/ad_info/is_advertisement",
        ]
        .iter()
        .any(|pointer| item.pointer(pointer).is_some_and(explicit_flag))
    // ad_info 的存在与 is_ad_loc=true 只表明广告槽，不能当作广告证据。
}

fn nonempty_text(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
}

struct AppVideoUri {
    aid: u64,
    cid: Option<i64>,
    dimension: Option<VideoDimension>,
}

impl AppVideoUri {
    fn parse(raw: &str) -> Option<Self> {
        let url = Url::parse(raw).ok()?;
        if url.scheme() != "bilibili"
            || !matches!(url.host_str(), Some("video" | "story"))
            || !url.username().is_empty()
            || url.password().is_some()
            || url.port().is_some()
        {
            return None;
        }
        let aid = decimal_u64(url.path().strip_prefix('/')?)?;
        if aid == 0 || aid >= MAX_AID {
            return None;
        }
        // 只读 URI 顶层明文查询字段，不猜测 opaque extra 等嵌套载荷。
        // 同名字段重复时视为歧义，不能随意挑一个尺寸或 cid。
        let field = |key: &str| -> Option<Option<u64>> {
            let mut values = url.query_pairs().filter(|(name, _)| name == key);
            let Some((_, raw)) = values.next() else {
                return Some(None);
            };
            if values.next().is_some() {
                return None;
            }
            Some(Some(decimal_u64(&raw)?))
        };
        let cid = field("cid").flatten().and_then(positive_i64);
        let dimension = (|| {
            let width = positive_i64(field("player_width")??)?;
            let height = positive_i64(field("player_height")??)?;
            let rotate = i64::try_from(field("player_rotate")?.unwrap_or(0)).ok()?;
            Some(VideoDimension {
                width,
                height,
                rotate,
            })
        })();
        Some(Self {
            aid,
            cid,
            dimension,
        })
    }
}

fn app_video_item(item: &Value) -> Option<VideoItem> {
    if !matches!(
        item.get("goto").and_then(Value::as_str),
        Some("av" | "vertical_av")
    ) || is_ad(item)
    {
        return None;
    }
    let uri = item
        .get("uri")
        .and_then(Value::as_str)
        .and_then(AppVideoUri::parse);
    let raw_aid = [
        item.get("param"),
        item.pointer("/player_args/aid"),
        item.pointer("/args/aid"),
    ]
    .into_iter()
    .flatten()
    .find(|value| !value.is_null());
    // 显式非法 aid 不得被其他字段掩盖；只有缺失时才回退 URI。
    let aid = match raw_aid {
        Some(raw) => json_u64(raw)?,
        None => uri.as_ref()?.aid,
    };
    let bvid = aid_to_bvid(aid)?;
    // URI 指向别的稿件时不借用它的 cid 或画幅。
    let uri = uri.filter(|uri| uri.aid == aid);
    let player_aid = item
        .pointer("/player_args/aid")
        .filter(|value| !value.is_null());
    let player_matches = player_aid.is_none_or(|value| json_u64(value) == Some(aid));
    let cid = player_matches
        .then(|| {
            item.pointer("/player_args/cid")
                .and_then(json_u64)
                .and_then(positive_i64)
        })
        .flatten()
        .or_else(|| uri.as_ref().and_then(|uri| uri.cid))?;
    let author_mid = ["/up_args/up_id", "/args/up_id"]
        .iter()
        .find_map(|pointer| {
            item.pointer(pointer)
                .and_then(json_u64)
                .filter(|mid| *mid > 0)
        })
        .map(|mid| mid.to_string());
    let author = nonempty_text(item.pointer("/up_args/up_name"))
        .or_else(|| nonempty_text(item.pointer("/args/up_name")))
        .unwrap_or_default()
        .to_owned();
    let rcmd_reason = nonempty_text(item.get("rcmd_reason"))
        .or_else(|| nonempty_text(item.pointer("/rcmd_reason_style/text")))
        .map(str::to_owned);
    Some(VideoItem {
        bvid,
        aid: aid.to_string(),
        cid: Some(cid),
        title: strip_em_tags(
            item.get("title")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        ),
        cover: video_cover(
            item.get("cover")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        ),
        author,
        author_mid,
        author_face: nonempty_text(item.pointer("/up_args/up_face")).map(avatar_thumb),
        author_fans: None,
        duration: item
            .pointer("/player_args/duration")
            .and_then(json_u64)
            .and_then(positive_i64)
            .unwrap_or(0),
        // 这些是展示文案还原的近似量，而非精确 stat；不补造低位、不发额外请求。
        view: cover_count(item, 1),
        danmaku: cover_count(item, 3),
        // APP 卡片流不下发评论数：封面角标只有播放/弹幕/时长三类（实测），
        // 补一个近似值会与详情页对不上，因此保持「没说」。
        reply: None,
        pubdate: item
            .get("pubdate")
            .and_then(json_u64)
            .and_then(positive_i64)
            .unwrap_or(0),
        rcmd_reason,
        dimension: video_dimension(item).or_else(|| uri.and_then(|uri| uri.dimension)),
    })
}

/// 将「77.4万」还原为展示精度的 774000；这不代表上游给了精确观看数。
/// 未知文案、负数、溢出均不猜测，交给现有模型的未知值 0。
fn display_count(raw: &str) -> Option<i64> {
    let raw = raw.trim();
    let (number, scale) = if let Some(number) = raw.strip_suffix('万') {
        (number, 10_000_u64)
    } else if let Some(number) = raw.strip_suffix('亿') {
        (number, 100_000_u64 * 1_000)
    } else {
        (raw, 1)
    };
    let (whole, fraction) = match number.split_once('.') {
        Some((whole, fraction)) if scale > 1 => (whole, Some(fraction)),
        Some(_) => return None,
        None => (number, None),
    };
    let whole = decimal_u64(whole)?.checked_mul(scale)?;
    let fractional = if let Some(fraction) = fraction {
        let numerator = decimal_u64(fraction)?;
        let denominator = 10_u64.checked_pow(fraction.len().try_into().ok()?)?;
        numerator.checked_mul(scale)?.checked_div(denominator)?
    } else {
        0
    };
    i64::try_from(whole.checked_add(fractional)?).ok()
}

fn cover_count(item: &Value, icon: u64) -> i64 {
    [
        ("cover_left_icon_1", "cover_left_text_1"),
        ("cover_left_icon_2", "cover_left_text_2"),
    ]
    .iter()
    .find_map(|(icon_key, text_key)| {
        if item.get(icon_key).and_then(json_u64) != Some(icon) {
            return None;
        }
        item.get(text_key)
            .and_then(Value::as_str)
            .and_then(display_count)
    })
    .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use std::future::ready;

    use serde_json::json;

    use super::*;

    fn card(aid: u64, goto: &str) -> Value {
        json!({
            "goto": goto, "card_goto": "av", "param": aid.to_string(),
            "player_args": { "aid": aid, "cid": 41855094127_u64, "duration": 91 },
            "title": "混合推荐", "cover": "http://i0.hdslb.com/bfs/archive/test.jpg",
            "args": { "up_id": 42, "up_name": "测试作者", "aid": aid }
        })
    }

    fn body(items: Vec<Value>) -> String {
        json!({ "code": 0, "data": { "items": items } }).to_string()
    }

    fn dimension_tuple(item: &VideoItem) -> Option<(i64, i64, i64)> {
        item.dimension
            .map(|dimension| (dimension.width, dimension.height, dimension.rotate))
    }

    #[test]
    fn converts_old_and_new_aids_without_float() {
        for (aid, expected) in [
            (170001, "BV17x411w7KC"),
            (455017605, "BV1Q541167Qg"),
            (882584971, "BV1mK4y1C7Bz"),
            (117274736399643, "BV1BSeJ6gEbP"),
            (117263042742272, "BV1VXYe6rEoc"),
        ] {
            assert_eq!(aid_to_bvid(aid).as_deref(), Some(expected));
            let item = app_video_item(&card(aid, "av")).unwrap();
            assert_eq!(item.aid, aid.to_string());
            assert_eq!(item.bvid, expected);
        }
        assert!(aid_to_bvid(1).is_some());
        assert!(aid_to_bvid(MAX_AID - 1).is_some());
        for aid in [0, MAX_AID, MAX_AID + 1, u64::MAX] {
            assert!(aid_to_bvid(aid).is_none());
        }
    }

    #[test]
    fn rejects_invalid_ids_instead_of_inventing_playable_cards() {
        for aid in [
            json!(""),
            json!("-1"),
            json!("170001.0"),
            json!(170001.0),
            json!("1e5"),
            json!("BV17x411w7KC"),
            json!(0),
            json!(MAX_AID),
            json!("18446744073709551616"),
            json!("+170001"),
        ] {
            let mut entry = card(170001, "av");
            entry["param"] = aid;
            assert!(app_video_item(&entry).is_none(), "{entry}");
        }
        for cid in [
            Value::Null,
            json!(0),
            json!(-1),
            json!(1.5),
            json!("broken"),
            json!(u64::MAX),
        ] {
            let mut entry = card(170001, "av");
            entry["player_args"]["cid"] = cid;
            assert!(app_video_item(&entry).is_none());
        }
    }

    #[test]
    fn keeps_mixed_gotos_in_upstream_order_not_card_goto() {
        let mut horizontal = card(170001, "av");
        horizontal["card_goto"] = json!("vertical_av");
        let mut vertical = card(455017605, "vertical_av");
        vertical["card_goto"] = Value::Null;
        let mut not_video = card(882584971, "live");
        not_video["card_goto"] = json!("av");
        let mut missing_goto = card(882584971, "av");
        missing_goto.as_object_mut().unwrap().remove("goto");
        let page = parse_app_feed(&body(vec![
            horizontal,
            not_video,
            card(882584971, "bangumi"),
            vertical,
            card(882584971, "pgc"),
            card(882584971, "article"),
            missing_goto,
            card(117274736399643, "av"),
            Value::Null,
        ]))
        .unwrap();
        assert_eq!(
            page.iter()
                .map(|item| item.aid.as_str())
                .collect::<Vec<_>>(),
            ["170001", "455017605", "117274736399643"]
        );
        assert!(page.iter().all(|item| item.dimension.is_none()));
    }

    #[test]
    fn ad_slot_is_not_an_ad_but_explicit_ad_markers_are() {
        let mut slot = card(170001, "av");
        slot["ad_info"] = json!({ "is_ad_loc": true });
        assert!(app_video_item(&slot).is_some());
        slot["is_ad"] = json!(false);
        slot["ad_info"]["is_ad"] = json!("0");
        assert!(app_video_item(&slot).is_some());
        for goto in ["ad", "ad_av", "ad_player", "ad_web_s"] {
            let mut entry = slot.clone();
            entry["card_goto"] = json!(goto);
            assert!(app_video_item(&entry).is_none());
        }
        for marker in [json!(true), json!(1), json!("1"), json!("true")] {
            let mut entry = slot.clone();
            entry["is_ad"] = marker.clone();
            assert!(app_video_item(&entry).is_none());
            entry["is_ad"] = json!(false);
            entry["ad_info"]["is_ad"] = marker;
            assert!(app_video_item(&entry).is_none());
        }
        let mut ad = slot.clone();
        ad["is_advertisement"] = json!(true);
        assert!(app_video_item(&ad).is_none());
        assert_eq!(parse_app_feed(&body(vec![ad, slot])).unwrap().len(), 1);
    }

    #[test]
    fn maps_author_reason_and_approximate_counts_without_extra_requests() {
        let mut entry = card(117274736399643, "av");
        entry["up_args"] = json!({ "up_id": "123456", "up_name": "UP 主", "up_face": "//i0.hdslb.com/bfs/face/test.jpg" });
        entry["cover_left_icon_1"] = json!(1);
        entry["cover_left_text_1"] = json!("77.4万");
        entry["cover_left_icon_2"] = json!(3);
        entry["cover_left_text_2"] = json!("1.2万");
        entry["rcmd_reason"] = json!("百万播放");
        entry["rcmd_reason_style"] = json!({ "text": "风格理由" });
        let item = app_video_item(&entry).unwrap();
        assert_eq!(item.author, "UP 主");
        assert_eq!(item.author_mid.as_deref(), Some("123456"));
        assert!(
            item.author_face
                .as_deref()
                .unwrap()
                .starts_with("https://i0.hdslb.com/")
        );
        assert_eq!(item.cover, "https://i0.hdslb.com/bfs/archive/test.jpg");
        assert_eq!(item.cid, Some(41855094127));
        assert_eq!(item.duration, 91);
        assert_eq!((item.view, item.danmaku), (774000, 12000));
        assert_eq!(item.rcmd_reason.as_deref(), Some("百万播放"));
        assert!(item.author_fans.is_none());
        assert_eq!(item.pubdate, 0);
        entry["up_args"] = Value::Null;
        entry["rcmd_reason"] = json!("");
        let item = app_video_item(&entry).unwrap();
        assert_eq!(item.author_mid.as_deref(), Some("42"));
        assert_eq!(item.author, "测试作者");
        assert!(item.author_face.is_none());
        assert_eq!(item.rcmd_reason.as_deref(), Some("风格理由"));
        entry["args"] = Value::Null;
        let item = app_video_item(&entry).unwrap();
        assert!(item.author.is_empty());
        assert!(item.author_mid.is_none());
    }

    #[test]
    fn formatted_counts_require_known_icons_and_never_guess_unknown_text() {
        for (text, expected) in [
            ("0", Some(0)),
            ("233", Some(233)),
            (" 77.4万 ", Some(774000)),
            ("1万", Some(10000)),
            ("1.23亿", Some(123000000)),
            ("", None),
            ("-1", None),
            ("播放", None),
            ("1.2万+", None),
            ("NaN", None),
            ("1e9", None),
            ("1.2.3万", None),
            ("999999999999999999亿", None),
            ("9223372036854775808", None),
        ] {
            assert_eq!(display_count(text), expected, "{text}");
        }
        let mut entry = card(170001, "av");
        entry["cover_left_icon_1"] = json!(3);
        entry["cover_left_text_1"] = json!("12");
        entry["cover_left_icon_2"] = json!("1");
        entry["cover_left_text_2"] = json!("77.4万");
        let item = app_video_item(&entry).unwrap();
        assert_eq!((item.view, item.danmaku), (774000, 12));
        entry["cover_left_icon_1"] = json!(99);
        entry["cover_left_icon_2"] = Value::Null;
        let item = app_video_item(&entry).unwrap();
        assert_eq!((item.view, item.danmaku), (0, 0));
    }

    #[test]
    fn reads_root_dimensions_before_uri_and_preserves_rotation() {
        let mut entry = card(170001, "vertical_av");
        entry["uri"] = json!(
            "bilibili://story/170001?cid=99&player_width=1920&player_height=1080&player_rotate=1"
        );
        let item = app_video_item(&entry).unwrap();
        assert_eq!(dimension_tuple(&item), Some((1920, 1080, 1)));
        assert_eq!(item.cid, Some(41855094127), "player_args 优先");
        entry["dimension"] = json!({ "width": 1080, "height": 1920, "rotate": 0 });
        assert_eq!(
            dimension_tuple(&app_video_item(&entry).unwrap()),
            Some((1080, 1920, 0))
        );
        entry["dimension"]["width"] = json!(0);
        assert_eq!(
            dimension_tuple(&app_video_item(&entry).unwrap()),
            Some((1920, 1080, 1))
        );
        entry["dimension"] = Value::Null;
        entry["uri"] =
            json!("bilibili://video/170001?player_width=1920&player_height=1080&player_rotate=90");
        assert_eq!(
            dimension_tuple(&app_video_item(&entry).unwrap()),
            Some((1920, 1080, 90))
        );
        entry["uri"] = json!("bilibili://video/170001?player_width=1920&player_height=1080");
        assert_eq!(
            dimension_tuple(&app_video_item(&entry).unwrap()),
            Some((1920, 1080, 0))
        );
    }

    #[test]
    fn missing_or_broken_uri_fields_do_not_invent_dimensions() {
        for uri in [
            "",
            "not a uri",
            "https://example.com/?player_width=1&player_height=2",
            "bilibili://story/170001",
            "bilibili://video/170001?player_width=1920",
            "bilibili://video/170001?player_width=0&player_height=1080",
            "bilibili://video/170001?player_width=oops&player_height=1080",
            "bilibili://video/170001?player_width=1920&player_height=1080&player_rotate=no",
            "bilibili://video/170001?player_width=1920&player_width=1080&player_height=1080",
            "bilibili://video/455017605?player_width=1920&player_height=1080",
            "bilibili://video/170001?extra=player_width%3D1920%26player_height%3D1080",
        ] {
            let mut entry = card(170001, "vertical_av");
            entry["uri"] = json!(uri);
            let item = app_video_item(&entry).unwrap();
            assert!(item.dimension.is_none(), "{uri}");
            assert!(item.cid.is_some());
        }
    }

    #[test]
    fn uri_and_player_args_can_supply_missing_keys_but_not_mismatched_cid() {
        let mut entry = card(170001, "av");
        entry.as_object_mut().unwrap().remove("param");
        assert_eq!(app_video_item(&entry).unwrap().aid, "170001");
        entry["player_args"] = Value::Null;
        assert!(app_video_item(&entry).is_none());
        entry["uri"] =
            json!("bilibili://video/170001?cid=1234&player_width=1920&player_height=1080");
        assert_eq!(app_video_item(&entry).unwrap().cid, Some(1234));
        entry["args"] = Value::Null;
        assert_eq!(app_video_item(&entry).unwrap().bvid, "BV17x411w7KC");
        entry["uri"] = json!("bilibili://video/170001?cid=bad");
        assert!(app_video_item(&entry).is_none());
        entry["uri"] = json!("bilibili://video/170001?cid=1&cid=2");
        assert!(app_video_item(&entry).is_none());
        entry["param"] = json!("170001");
        entry["uri"] = json!("bilibili://video/455017605?cid=1234");
        assert!(app_video_item(&entry).is_none());
        entry["player_args"] = json!({ "aid": 455017605, "cid": 1234 });
        assert!(app_video_item(&entry).is_none());
    }

    #[test]
    fn rejects_api_errors_and_malformed_envelopes() {
        for raw in [
            "oops",
            "null",
            "{}",
            r#"{"code":0,"data":{}}"#,
            r#"{"code":0,"data":{"items":{}}}"#,
            r#"{"code":-352,"data":{"items":[]}}"#,
        ] {
            assert!(parse_app_feed(raw).is_err(), "{raw}");
        }
        assert!(parse_app_feed(&body(vec![])).unwrap().is_empty());
    }

    #[test]
    fn uses_only_the_verified_unsigned_app_parameters() {
        let params = app_feed_params();
        assert_eq!(
            params,
            [
                ("build", "8130300"),
                ("mobi_app", "android"),
                ("platform", "android"),
                ("device", "phone"),
                ("style", "2"),
                ("column", "4"),
            ]
            .map(|(key, value)| (key, value.to_owned()))
        );
    }

    #[tokio::test]
    async fn fetches_the_whole_wave_concurrently() {
        // 四批必须同时在飞：每个 future 只有在四个都已被轮询过后才就绪。
        // 若实现退回串行 `await`，第一个 future 永远不会就绪，本测试超时失败。
        let polled = std::rc::Rc::new(std::cell::RefCell::new(0usize));
        let fetch = {
            let polled = std::rc::Rc::clone(&polled);
            move || {
                let polled = std::rc::Rc::clone(&polled);
                let mut started = false;
                std::future::poll_fn(move |_| {
                    if !started {
                        started = true;
                        *polled.borrow_mut() += 1;
                    }
                    if *polled.borrow() == FEED_BATCHES {
                        std::task::Poll::Ready(Ok(body(vec![card(170001, "av")])))
                    } else {
                        std::task::Poll::Pending
                    }
                })
            }
        };
        let page = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            collect_app_feed(30, fetch),
        )
        .await
        .expect("并发取批不应等待某个批次的串行完成")
        .unwrap();
        assert_eq!(page.items.len(), 1);
    }

    #[tokio::test]
    async fn deduplicates_within_and_across_batches_preserving_first_occurrence() {
        let mut repeated = card(170001, "vertical_av");
        repeated["title"] = json!("不能覆盖先出现的条目");
        let mut batches = [
            body(vec![
                card(170001, "av"),
                repeated.clone(),
                card(455017605, "vertical_av"),
            ]),
            body(vec![repeated, card(882584971, "av")]),
            body(vec![card(117274736399643, "av")]),
            body(vec![card(117263042742272, "av")]),
        ]
        .into_iter();
        let mut calls = 0;
        let page = collect_app_feed(30, || {
            calls += 1;
            ready(Ok(batches.next().expect("只允许一批的量")))
        })
        .await
        .unwrap();
        assert_eq!(calls, FEED_BATCHES);
        assert_eq!(
            page.items
                .iter()
                .map(|item| item.aid.as_str())
                .collect::<Vec<_>>(),
            [
                "170001",
                "455017605",
                "882584971",
                "117274736399643",
                "117263042742272"
            ]
        );
        assert_eq!(page.items[0].title, "混合推荐");
        assert!(page.has_more);
    }

    #[tokio::test]
    async fn clamps_target_and_stops_without_unbounded_refill() {
        // 目标在首批就满足时不再处理后续批次，但整波请求已经发出（并发换时延）。
        for (requested, expected) in [(0, 1), (2, 2), (30, 30), (u32::MAX, 30)] {
            let mut calls = 0;
            let page = collect_app_feed(requested, || {
                calls += 1;
                ready(Ok(body((1..=35).map(|aid| card(aid, "av")).collect())))
            })
            .await
            .unwrap();
            assert_eq!(page.items.len(), expected);
            assert_eq!(calls, FEED_BATCHES);
        }
        let mut calls = 0;
        let page = collect_app_feed(30, || {
            calls += 1;
            ready(Ok(body(vec![card(170001, "av")])))
        })
        .await
        .unwrap();
        assert_eq!(calls, FEED_BATCHES);
        assert_eq!(page.items.len(), 1);
        assert!(!page.has_more, "末批仍无新增，不让消费者空转");
    }

    #[tokio::test]
    async fn empty_or_failed_first_batch_errors_without_retrying() {
        for first in [
            Ok(body(vec![])),
            Ok(body(vec![card(1, "live")])),
            Err(video_err("离线模拟传输失败")),
            Ok("bad json".to_owned()),
        ] {
            // 首批坏掉时，后续批次的成功不得把它掩盖成可用结果。
            let mut batches = [first, Ok(body(vec![card(170001, "av")]))].into_iter();
            let result = collect_app_feed(30, || {
                ready(batches.next().unwrap_or_else(|| {
                    Ok(body(vec![card(170001, "av")]))
                }))
            })
            .await;
            assert!(result.is_err());
        }
    }

    #[tokio::test]
    async fn later_empty_or_failed_batch_returns_partial() {
        for (second, expected_more) in [
            (Ok(body(vec![])), false),
            (Err(video_err("离线模拟传输失败")), true),
            (Ok("bad json".to_owned()), true),
        ] {
            let mut batches = [Ok(body(vec![card(170001, "av")])), second].into_iter();
            let mut calls = 0;
            let page = collect_app_feed(30, || {
                calls += 1;
                ready(batches.next().unwrap_or_else(|| {
                    Ok(body(vec![card(455017605, "av")]))
                }))
            })
            .await
            .unwrap();
            assert_eq!(calls, FEED_BATCHES);
            assert_eq!(page.items.len(), 1);
            assert_eq!(page.has_more, expected_more);
        }
    }
}
