//! AcFun 视频点播弹幕列表。
//!
//! 列表接口按分 P 的内部 `videoId` 查询，响应中的 `position` 已是相对视频
//! 开头的毫秒数。`pcursor` 是服务端生成的下一页游标，最后一页仍可能带数据，
//! 必须以 `no_more` 作为终止条件。

use std::collections::HashSet;

use serde_json::Value;

use crate::error::{AppError, AppResult};
use crate::models::acfun::AcfunVideoDanmakuItem;
use crate::sites::json::{json_i64_opt, json_str};

use super::content::AcfunContentClient;

const LIST_PATH: &str = "/rest/pc-direct/new-danmaku/list";
const PAGE_SIZE: u32 = 200;
const MAX_PAGES: usize = 500;

pub(super) fn part_belongs_to_video(value: &Value, part_id: &str) -> bool {
    value
        .get("videoList")
        .and_then(Value::as_array)
        .is_some_and(|parts| {
            parts
                .iter()
                .any(|part| part.get("id").map(json_str).as_deref() == Some(part_id))
        })
}

pub(super) async fn fetch_all(
    client: &AcfunContentClient,
    part_id: &str,
) -> AppResult<Vec<AcfunVideoDanmakuItem>> {
    let mut cursor = String::from("1");
    let mut seen_cursors = HashSet::new();
    let mut pages = Vec::new();
    for _ in 0..MAX_PAGES {
        if !seen_cursors.insert(cursor.clone()) {
            return Err(error("AcFun 弹幕分页游标重复，无法继续加载"));
        }
        let value = client
            .post_form(
                LIST_PATH,
                &[
                    ("resourceId", part_id.to_string()),
                    ("resourceType", "9".to_string()),
                    ("enableAdvanced", "true".to_string()),
                    ("pcursor", cursor.clone()),
                    ("count", PAGE_SIZE.to_string()),
                    ("sortType", "2".to_string()),
                ],
                "视频弹幕",
            )
            .await?;
        check_result(&value)?;
        pages.push((parse_items(&value)?, next_cursor(&value)?));
        match pages.last().and_then(|(_, next)| next.clone()) {
            Some(next) => cursor = next,
            None => return Ok(merge_pages(pages)),
        }
    }
    Err(error(format!("AcFun 弹幕超过 {MAX_PAGES} 页，已停止加载")))
}

fn parse_items(value: &Value) -> AppResult<Vec<AcfunVideoDanmakuItem>> {
    let items = value
        .get("danmakus")
        .and_then(Value::as_array)
        .ok_or_else(|| error("AcFun 弹幕缺少 danmakus 数组"))?;
    items.iter().map(parse_item).collect()
}

fn parse_item(value: &Value) -> AppResult<AcfunVideoDanmakuItem> {
    let id = value
        .get("danmakuId")
        .map(json_str)
        .filter(|id| !id.trim().is_empty())
        .ok_or_else(|| error("AcFun 弹幕缺少 danmakuId"))?;
    let content = value
        .get("body")
        .map(json_str)
        .map(|body| body.trim().to_string())
        .filter(|body| !body.is_empty())
        .ok_or_else(|| error("AcFun 弹幕缺少正文"))?;
    Ok(AcfunVideoDanmakuItem {
        id,
        progress: nonnegative_u64(value, "position")?,
        mode: nonnegative_u32(value, "mode")?,
        size: nonnegative_u32(value, "size")?,
        color: nonnegative_u32(value, "color")?,
        content,
    })
}

fn nonnegative_u64(value: &Value, field: &str) -> AppResult<u64> {
    value
        .get(field)
        .and_then(json_i64_opt)
        .filter(|number| *number >= 0)
        .and_then(|number| u64::try_from(number).ok())
        .ok_or_else(|| error(format!("AcFun 弹幕缺少有效的 {field}")))
}

fn nonnegative_u32(value: &Value, field: &str) -> AppResult<u32> {
    value
        .get(field)
        .and_then(json_i64_opt)
        .filter(|number| *number >= 0)
        .and_then(|number| u32::try_from(number).ok())
        .ok_or_else(|| error(format!("AcFun 弹幕缺少有效的 {field}")))
}

fn next_cursor(value: &Value) -> AppResult<Option<String>> {
    let cursor = value
        .get("pcursor")
        .map(json_str)
        .map(|cursor| cursor.trim().to_string())
        .filter(|cursor| !cursor.is_empty())
        .ok_or_else(|| error("AcFun 弹幕缺少 pcursor"))?;
    Ok((cursor != "no_more").then_some(cursor))
}

fn merge_pages(
    pages: Vec<(Vec<AcfunVideoDanmakuItem>, Option<String>)>,
) -> Vec<AcfunVideoDanmakuItem> {
    let mut seen = HashSet::new();
    let mut items = pages
        .into_iter()
        .flat_map(|(items, _)| items)
        .filter(|item| seen.insert(item.id.clone()))
        .collect::<Vec<_>>();
    items.sort_by(|left, right| {
        left.progress
            .cmp(&right.progress)
            .then_with(|| left.id.cmp(&right.id))
    });
    items
}

fn check_result(value: &Value) -> AppResult<()> {
    let result = value
        .get("result")
        .and_then(json_i64_opt)
        .ok_or_else(|| error("AcFun 弹幕响应缺少 result"))?;
    if result == 0 {
        return Ok(());
    }
    let message = value
        .get("error_msg")
        .or_else(|| value.get("message"))
        .map(json_str)
        .filter(|message| !message.is_empty())
        .unwrap_or_else(|| "视频弹幕请求失败".to_string());
    Err(error(message))
}

fn error(message: impl Into<String>) -> AppError {
    AppError::new("acfun_danmaku_api_error", message).with_site("acfun")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_part_against_the_video_detail() {
        let value = serde_json::json!({
            "videoList": [{"id": 39352915_u64}, {"id": "39352909"}]
        });
        assert!(part_belongs_to_video(&value, "39352915"));
        assert!(part_belongs_to_video(&value, "39352909"));
        assert!(!part_belongs_to_video(&value, "48987793"));
    }

    #[test]
    fn parses_real_danmaku_page_and_terminal_cursor() {
        let value = serde_json::json!({
            "result": 0,
            "pcursor": "no_more",
            "danmakus": [
                {
                    "danmakuId": 287852354,
                    "position": 250211,
                    "mode": 1,
                    "size": 25,
                    "color": 16777215,
                    "body": "手机多是吧？？？？？"
                },
                {
                    "danmakuId": "287859214",
                    "position": 22224,
                    "mode": 5,
                    "size": 25,
                    "color": 16740618,
                    "body": "类嘞类嘞"
                }
            ]
        });
        let items = parse_items(&value).unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].id, "287852354");
        assert_eq!(items[0].progress, 250_211);
        assert_eq!(items[0].color, 16_777_215);
        assert_eq!(items[1].mode, 5);
        assert_eq!(next_cursor(&value).unwrap(), None);
    }

    #[test]
    fn keeps_server_cursor_until_no_more() {
        let value = serde_json::json!({"pcursor": "3", "danmakus": []});
        assert_eq!(next_cursor(&value).unwrap().as_deref(), Some("3"));
        assert!(next_cursor(&serde_json::json!({"danmakus": []})).is_err());
        assert!(
            parse_item(&serde_json::json!({
                "danmakuId": 1,
                "position": -1,
                "mode": 1,
                "size": 25,
                "color": 0,
                "body": "invalid"
            }))
            .is_err()
        );
        assert!(check_result(&serde_json::json!({"result": 1})).is_err());
        assert!(check_result(&serde_json::json!({})).is_err());
    }

    #[test]
    fn merge_sorts_by_time_and_removes_cross_page_duplicates() {
        let item = |id: &str, progress: u64| AcfunVideoDanmakuItem {
            id: id.to_string(),
            progress,
            mode: 1,
            size: 25,
            color: 0xffffff,
            content: id.to_string(),
        };
        let items = merge_pages(vec![
            (vec![item("b", 20), item("a", 10)], Some("2".to_string())),
            (vec![item("c", 5), item("a", 10)], None),
        ]);
        assert_eq!(
            items
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            ["c", "a", "b"]
        );
    }
}
