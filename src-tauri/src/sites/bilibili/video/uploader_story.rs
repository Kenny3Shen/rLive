//! UP 主 story 列表：真实双向 aid 游标与上游位置，不使用推荐流的 seen 记忆。

use serde_json::Value;
use std::collections::HashSet;

use super::{BilibiliSite, as_i64, as_str, story_item, video_err};
use crate::error::AppResult;
use crate::models::video::{VideoStoryDirection, VideoUploaderStoryItem, VideoUploaderStoryPage};

fn positive_id(value: &str) -> Option<String> {
    value
        .trim()
        .parse::<u64>()
        .ok()
        .filter(|id| *id > 0)
        .map(|id| id.to_string())
}

fn uploader_story_query(
    mid: &str,
    cursor: Option<&str>,
    direction: VideoStoryDirection,
) -> AppResult<Vec<(&'static str, String)>> {
    let mid = positive_id(mid).ok_or_else(|| video_err("UP 主 UID 无效"))?;
    let cursor = cursor
        .map(|id| positive_id(id).ok_or_else(|| video_err("UP 主流游标无效")))
        .transpose()?;
    if direction != VideoStoryDirection::Initial && cursor.is_none() {
        return Err(video_err("翻页缺少 UP 主流游标"));
    }
    let previous = direction == VideoStoryDirection::Prev;
    let mut query = vec![
        ("vmid", mid),
        ("before_size", if previous { "10" } else { "0" }.into()),
        ("after_size", if previous { "0" } else { "10" }.into()),
        (
            "contain",
            if direction == VideoStoryDirection::Initial {
                "1"
            } else {
                "0"
            }
            .into(),
        ),
    ];
    if let Some(aid) = cursor {
        query.push(("aid", aid));
    }
    Ok(query)
}

fn parse_uploader_story(
    raw: &str,
    mid: &str,
    cursor: Option<&str>,
    direction: VideoStoryDirection,
) -> AppResult<VideoUploaderStoryPage> {
    let root: Value =
        serde_json::from_str(raw).map_err(|e| video_err(format!("UP 主流 JSON: {e}")))?;
    if root.get("code").map(as_i64).is_some_and(|code| code != 0) {
        return Err(video_err("UP 主流暂不可用，请稍后重试"));
    }
    let raw_items = root
        .pointer("/data/items")
        .and_then(Value::as_array)
        .ok_or_else(|| video_err("UP 主流缺少条目列表"))?;
    let total = root
        .pointer("/data/page/total")
        .and_then(Value::as_u64)
        .ok_or_else(|| video_err("UP 主流缺少作品总数"))?;
    let mut seen = HashSet::new();
    let mut items: Vec<VideoUploaderStoryItem> = raw_items
        .iter()
        .filter_map(|raw| {
            // goto 是消费类型，不是实际画幅；不得在这里过滤 dimension 的横屏条目。
            if raw
                .get("goto")
                .or_else(|| raw.get("card_goto"))
                .map(as_str)
                .as_deref()
                != Some("vertical_av")
            {
                return None;
            }
            let video = story_item(raw);
            let index = raw.get("index")?.as_u64()?;
            if index == 0
                || index > total
                || video.author_mid.as_deref() != Some(mid)
                || video.bvid.is_empty()
                || !video.cid.is_some_and(|cid| cid > 0)
                || positive_id(&video.aid).is_none()
                || !seen.insert(video.aid.clone())
            {
                return None;
            }
            Some(VideoUploaderStoryItem { video, index })
        })
        .collect();
    items.sort_by_key(|item| item.index);

    // 不把「当前稿件已删除/不在作者流中」静默变成从作者第一条播放。
    if direction == VideoStoryDirection::Initial
        && let Some(aid) = cursor
        && !items.iter().any(|item| item.video.aid == aid)
    {
        return Err(video_err(
            "当前视频不在该 UP 主的竖屏流中，可能已删除或暂不可用",
        ));
    }
    let flag = |key: &str| {
        root.pointer(&format!("/data/page/{key}"))
            .and_then(Value::as_bool)
            .unwrap_or(false)
    };
    let next_cursor = items
        .last()
        .filter(|item| flag("has_next") && item.index < total)
        .map(|item| item.video.aid.clone());
    let prev_cursor = items
        .first()
        .filter(|item| flag("has_prev") && item.index > 1)
        .map(|item| item.video.aid.clone());
    // 上游忽略了游标时停止该方向，防止前端不停加载同一页。
    let next_cursor = next_cursor
        .filter(|aid| direction != VideoStoryDirection::Next || Some(aid.as_str()) != cursor);
    let prev_cursor = prev_cursor
        .filter(|aid| direction != VideoStoryDirection::Prev || Some(aid.as_str()) != cursor);
    Ok(VideoUploaderStoryPage {
        items,
        total,
        next_cursor,
        prev_cursor,
    })
}

impl BilibiliSite {
    pub async fn video_uploader_story(
        &self,
        mid: &str,
        cursor_aid: Option<&str>,
        direction: VideoStoryDirection,
    ) -> AppResult<VideoUploaderStoryPage> {
        let query = uploader_story_query(mid, cursor_aid, direction)?;
        let mid = query
            .iter()
            .find(|(key, _)| *key == "vmid")
            .map(|(_, value)| value.as_str())
            .unwrap();
        let cursor = query
            .iter()
            .find(|(key, _)| *key == "aid")
            .map(|(_, value)| value.as_str());
        let text = self.get_app_feed("/space/story/cursor", &query).await?;
        parse_uploader_story(&text, mid, cursor, direction)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn item(aid: &str, index: u64) -> Value {
        json!({"goto":"vertical_av", "card_goto":"vertical_av", "param":aid,
            "bvid":format!("BV{aid}"), "player_args":{"cid":123},
            "owner":{"mid":42,"name":"作者"}, "index":index,
            "dimension":{"width":1920,"height":1080,"rotate":0}})
    }
    fn page(items: Vec<Value>, total: u64, prev: bool, next: bool) -> String {
        json!({"code":0,"data":{"items":items,"page":{"total":total,"has_prev":prev,"has_next":next}}}).to_string()
    }

    #[test]
    fn query_initial_contains_current_and_pages_are_directional() {
        let initial =
            uploader_story_query("42", Some("117274736399643"), VideoStoryDirection::Initial)
                .unwrap();
        assert!(initial.contains(&("contain", "1".into())));
        assert!(initial.contains(&("before_size", "0".into())));
        assert!(initial.contains(&("aid", "117274736399643".into())));
        let prev = uploader_story_query("42", Some("123"), VideoStoryDirection::Prev).unwrap();
        assert!(prev.contains(&("contain", "0".into())));
        assert!(prev.contains(&("before_size", "10".into())));
        assert!(prev.contains(&("after_size", "0".into())));
        assert!(uploader_story_query("0", None, VideoStoryDirection::Initial).is_err());
        assert!(uploader_story_query("42", Some("oops"), VideoStoryDirection::Next).is_err());
        assert!(uploader_story_query("42", None, VideoStoryDirection::Prev).is_err());
    }

    #[test]
    fn keeps_real_position_total_and_landscape_in_story_mode() {
        let raw = page(vec![item("500", 56), item("501", 57)], 100, true, true);
        let result =
            parse_uploader_story(&raw, "42", Some("500"), VideoStoryDirection::Initial).unwrap();
        assert_eq!(result.total, 100);
        assert_eq!(result.items[0].index, 56);
        assert_eq!(result.items[0].video.dimension.unwrap().width, 1920);
        assert_eq!(result.next_cursor.as_deref(), Some("501"));
        assert_eq!(result.prev_cursor.as_deref(), Some("500"));
        let ipc = serde_json::to_value(&result).unwrap();
        assert_eq!(ipc["items"][0]["aid"], "500");
        assert_eq!(ipc["items"][0]["index"], 56);
        assert!(ipc["items"][0].get("video").is_none());
    }

    #[test]
    fn preserves_order_filters_foreign_rows_and_dedupes() {
        let mut foreign = item("502", 58);
        foreign["owner"]["mid"] = json!(43);
        let mut broken = item("503", 59);
        broken["player_args"]["cid"] = json!(0);
        let raw = page(
            vec![
                item("501", 57),
                foreign,
                broken,
                item("500", 56),
                item("500", 56),
            ],
            100,
            true,
            true,
        );
        let result =
            parse_uploader_story(&raw, "42", Some("502"), VideoStoryDirection::Prev).unwrap();
        assert_eq!(
            result
                .items
                .iter()
                .map(|item| item.index)
                .collect::<Vec<_>>(),
            vec![56, 57]
        );
    }

    #[test]
    fn missing_seed_is_not_silently_replaced_by_latest() {
        let raw = page(vec![item("500", 1)], 100, false, true);
        assert!(
            parse_uploader_story(&raw, "42", Some("499"), VideoStoryDirection::Initial).is_err()
        );
    }

    #[test]
    fn boundary_empty_and_stalled_cursors_stop_loading() {
        let first = parse_uploader_story(
            &page(vec![item("1", 1)], 1, true, true),
            "42",
            None,
            VideoStoryDirection::Initial,
        )
        .unwrap();
        assert!(first.next_cursor.is_none());
        assert!(first.prev_cursor.is_none());
        let empty = parse_uploader_story(
            &page(vec![], 0, false, false),
            "42",
            None,
            VideoStoryDirection::Initial,
        )
        .unwrap();
        assert!(empty.items.is_empty());
        let stalled = parse_uploader_story(
            &page(vec![item("9", 9)], 100, true, true),
            "42",
            Some("9"),
            VideoStoryDirection::Next,
        )
        .unwrap();
        assert!(stalled.next_cursor.is_none());
        let stalled = parse_uploader_story(
            &page(vec![item("9", 9)], 100, true, true),
            "42",
            Some("9"),
            VideoStoryDirection::Prev,
        )
        .unwrap();
        assert!(stalled.prev_cursor.is_none());
    }

    #[tokio::test]
    #[ignore = "真实网络：APP 混合推荐与作者双向游标，不读取登录凭据"]
    async fn live_app_feed_and_uploader_cursor() {
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(std::time::Duration::from_secs(25))
            .build()
            .unwrap();
        let site = BilibiliSite::new(client, String::new());
        let recommended = site.video_recommend(1, 20).await.unwrap();
        assert!(!recommended.items.is_empty());
        // 本地转换得到的 bvid 必须指向同一稿件，而不仅是形状像 BV 字符串。
        let first = &recommended.items[0];
        let archive = site.video_archive(&first.bvid).await.unwrap();
        assert_eq!(archive.aid, first.aid);
        let page = site
            .video_uploader_story("304036454", None, VideoStoryDirection::Initial)
            .await
            .unwrap();
        let seed = &page.items[3];
        let entered = site
            .video_uploader_story(
                "304036454",
                Some(&seed.video.aid),
                VideoStoryDirection::Initial,
            )
            .await
            .unwrap();
        assert_eq!(entered.items[0].video.aid, seed.video.aid);
        assert_eq!(entered.items[0].index, seed.index);
        assert_eq!(entered.total, page.total);
        let next = site
            .video_uploader_story(
                "304036454",
                entered.next_cursor.as_deref(),
                VideoStoryDirection::Next,
            )
            .await
            .unwrap();
        assert!(next.items[0].index > entered.items.last().unwrap().index);
        let prev = site
            .video_uploader_story(
                "304036454",
                entered.prev_cursor.as_deref(),
                VideoStoryDirection::Prev,
            )
            .await
            .unwrap();
        assert_eq!(prev.items.last().unwrap().index + 1, seed.index);
        eprintln!(
            "APP推荐 {} 条；UP入口 {}/{}，双向游标通过",
            recommended.items.len(),
            seed.index,
            page.total
        );
    }

    #[test]
    fn invalid_payload_does_not_invent_total() {
        for raw in [
            "{}",
            r#"{"code":-400}"#,
            r#"{"data":{"items":[],"page":{}}}"#,
        ] {
            assert!(parse_uploader_story(raw, "42", None, VideoStoryDirection::Initial).is_err());
        }
    }
}
