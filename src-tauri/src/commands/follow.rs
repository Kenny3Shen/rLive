use serde::{Deserialize, Serialize};
use tauri::State;

use crate::account;
use crate::db::follow::{self, FollowRecord, TagRecord};
use crate::error::{AppError, AppResult};
use crate::models::live::{LiveRoomStatus, SiteId};
use crate::sites;
use crate::state::AppState;

/// 应用一次关注列表状态探测，同时不让上一场直播的开播时间
/// 渗入新的一场。
///
/// 并非所有只返回状态的接口都提供开播时间戳。只要直播仍在进行，这没有问题，
/// 因为已存储的时间戳依然有效。但一旦它下播过（或此前状态未知），
/// 新的"正在直播"结果若没有时间戳，就必须清掉旧值。
fn apply_live_status(record: &mut FollowRecord, live_status: Option<LiveRoomStatus>) {
    match live_status {
        Some(LiveRoomStatus { status: false, .. }) => {
            record.live_status = Some(0);
            record.live_started_at = None;
        }
        Some(LiveRoomStatus {
            status: true,
            live_started_at,
        }) => {
            let was_live = record.live_status == Some(1);
            record.live_status = Some(1);
            record.live_started_at = live_started_at.or(if was_live {
                record.live_started_at
            } else {
                None
            });
        }
        // 在偶发刷新失败时保留最后一次已验证的时间戳，
        // 同时把状态本身显示为未知。
        None => record.live_status = None,
    }
}

/// 单个房间在一轮刷新里的探测结果。
///
/// `ok` 与 `failed` 区分「平台确认了状态」与「本次没拿到」，因为把后者当
/// 「未开播」是当前实现最误导用户的地方。`retryable` 只用于给 UI 提示，
/// 不参与重试资格判定（用户对任何失败项都可手动重试）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FollowRefreshFailure {
    pub site_id: String,
    pub room_id: String,
    pub user_name: String,
    /// 安全错误类别：不带上游响应正文、不带 Cookie 与 URL。
    pub code: String,
    pub retryable: bool,
}

/// 一轮关注刷新的结果摘要。
///
/// 前端需要它来区分「这轮全成功」与「部分失败」，并把失败项列出来定向重试；
/// 旧接口只返回列表，失败项与「未开播」在 UI 上无法区分。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FollowRefreshSummary {
    /// 本轮参与探测的关注总数。
    pub total: usize,
    /// 成功取得状态的条数。
    pub refreshed: usize,
    /// 本轮成功取得状态的房间键，供前端标记“本轮已确认”。
    pub refreshed_keys: Vec<String>,
    pub failures: Vec<FollowRefreshFailure>,
    /// 本轮状态成功落库的时间（Unix 毫秒）。
    pub checked_at: i64,
}

/// 关注的房间键：`{site_id}:{room_id}`。两个字段都来自受控输入。
pub fn follow_key(site_id: &str, room_id: &str) -> String {
    format!("{site_id}:{room_id}")
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FollowUserDto {
    pub site_id: String,
    pub room_id: String,
    pub user_name: String,
    pub face: String,
    pub tag_ids: Vec<String>,
    pub auto_record: bool,
    pub live_status: Option<bool>,
    pub live_started_at: Option<i64>,
    pub updated_at: i64,
}

impl From<FollowRecord> for FollowUserDto {
    fn from(r: FollowRecord) -> Self {
        Self {
            site_id: r.site_id,
            room_id: r.room_id,
            user_name: r.user_name,
            face: r.face,
            tag_ids: r.tag_ids,
            auto_record: r.auto_record,
            live_status: r.live_status.map(|v| v != 0),
            live_started_at: r.live_started_at,
            updated_at: r.updated_at,
        }
    }
}

impl From<FollowUserDto> for FollowRecord {
    fn from(d: FollowUserDto) -> Self {
        Self {
            site_id: d.site_id,
            room_id: d.room_id,
            user_name: d.user_name,
            face: d.face,
            tag_ids: d.tag_ids,
            auto_record: d.auto_record,
            live_status: d.live_status.map(|b| if b { 1 } else { 0 }),
            live_started_at: d.live_started_at,
            updated_at: d.updated_at,
        }
    }
}

#[tauri::command]
pub fn follow_list(state: State<'_, AppState>) -> AppResult<Vec<FollowUserDto>> {
    let conn = state.conn()?;
    Ok(follow::list(&conn)?.into_iter().map(Into::into).collect())
}

#[tauri::command]
pub fn follow_add(state: State<'_, AppState>, user: FollowUserDto) -> AppResult<()> {
    let mut rec: FollowRecord = user.into();
    if rec.updated_at == 0 {
        rec.updated_at = chrono::Utc::now().timestamp_millis();
    }
    let conn = state.conn()?;
    follow::upsert(&conn, rec)
}

#[tauri::command]
pub fn follow_remove(
    state: State<'_, AppState>,
    site_id: String,
    room_id: String,
) -> AppResult<()> {
    let conn = state.conn()?;
    follow::remove(&conn, &site_id, &room_id)
}

#[tauri::command]
pub fn follow_set_tags(
    state: State<'_, AppState>,
    site_id: String,
    room_id: String,
    tag_ids: Vec<String>,
) -> AppResult<()> {
    let conn = state.conn()?;
    follow::set_tags(&conn, &site_id, &room_id, &tag_ids)
}

#[tauri::command]
pub fn follow_set_auto_record(
    state: State<'_, AppState>,
    site_id: String,
    room_id: String,
    auto_record: bool,
) -> AppResult<()> {
    let conn = state.conn()?;
    follow::set_auto_record(&conn, &site_id, &room_id, auto_record)
}

#[tauri::command]
pub fn tag_list(state: State<'_, AppState>) -> AppResult<Vec<TagRecord>> {
    let conn = state.conn()?;
    follow::list_tags(&conn)
}

#[tauri::command]
pub fn tag_upsert(
    state: State<'_, AppState>,
    name: String,
    id: Option<String>,
) -> AppResult<TagRecord> {
    let id = id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let tag = TagRecord {
        id,
        name: name.trim().to_string(),
    };
    if tag.name.is_empty() {
        return Err(AppError::new("invalid_tag", "tag name is empty"));
    }
    if tag.name.chars().count() > 32 {
        return Err(AppError::new("invalid_tag", "tag name is too long"));
    }
    let conn = state.conn()?;
    follow::upsert_tag(&conn, tag.clone())?;
    Ok(tag)
}

#[tauri::command]
pub fn tag_remove(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let mut conn = state.conn()?;
    follow::remove_tag(&mut conn, &id)
}

async fn refresh_follows(
    state: &AppState,
    auto_record_only: bool,
    targets: Option<Vec<FollowRefreshTarget>>,
) -> AppResult<FollowRefreshResult> {
    let (follows, proxy) = {
        let conn = state.conn()?;
        let follows = if auto_record_only {
            follow::list_auto_record(&conn)?
        } else {
            follow::list(&conn)?
        };
        (follows, crate::settings::get(&conn)?.proxy)
    };

    // 定向重试时只探测点名的那几条；其余照旧返回列表，但不参与本轮的
    // 「已确认」集合，也不写入状态。
    let targets: Option<Vec<String>> = targets.map(|targets| {
        targets
            .into_iter()
            .map(|target| follow_key(&target.site_id, &target.room_id))
            .collect()
    });
    let selected = |record: &FollowRecord| {
        targets.as_ref().is_none_or(|targets| {
            targets
                .iter()
                .any(|key| key == &follow_key(&record.site_id, &record.room_id))
        })
    };

    let sem = std::sync::Arc::new(tokio::sync::Semaphore::new(5));
    let mut tasks = Vec::new();

    for f in follows.iter().filter(|record| selected(record)) {
        let site_id = f.site_id.clone();
        let room_id = f.room_id.clone();
        let user_name = f.user_name.clone();
        let permit = sem
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| AppError::new("refresh_error", "semaphore closed"))?;
        let cookie = {
            let sid = SiteId::from_str_loose(&site_id);
            let conn = state.conn()?;
            match sid {
                Some(s) => account::get_cookie(&conn, &s)?,
                None => None,
            }
        };
        let proxy = proxy.clone();
        tasks.push(tokio::spawn(async move {
            let _permit = permit;
            let outcome = match SiteId::from_str_loose(&site_id) {
                Some(sid) => match sites::site_with_proxy(&sid, cookie, proxy.as_deref()) {
                    Ok(site) => site.get_room_live_status(&room_id).await,
                    Err(error) => Err(error),
                },
                None => Err(AppError::new(
                    "follow_unknown_site",
                    format!("unsupported site: {site_id}"),
                )),
            };
            (site_id, room_id, user_name, outcome)
        }));
    }

    let mut status_map = std::collections::HashMap::new();
    let mut failures = Vec::new();
    for t in tasks {
        // 任务本身 panic 时无法归因到具体房间，只记一条不含标识的失败。
        let Ok((site_id, room_id, user_name, outcome)) = t.await else {
            failures.push(FollowRefreshFailure {
                site_id: String::new(),
                room_id: String::new(),
                user_name: String::new(),
                code: "follow_refresh_task_failed".into(),
                retryable: true,
            });
            continue;
        };
        match outcome {
            Ok(live_status) => {
                status_map.insert((site_id, room_id), Some(live_status));
            }
            Err(error) => {
                // 保留旧状态（包括旧时间戳），只把它标为未确认；
                // 不能因为一次探测失败就把主播显示成未开播。
                status_map.insert((site_id.clone(), room_id.clone()), None);
                failures.push(FollowRefreshFailure {
                    site_id,
                    room_id,
                    user_name,
                    code: error.code,
                    retryable: error.retryable,
                });
            }
        }
    }

    let mut updated = Vec::new();
    let mut refreshed_keys = Vec::new();
    let mut refreshed = 0_usize;
    // 本轮状态落库的时间，也是前端标记“本轮已确认”的时间。
    let checked_at = chrono::Utc::now().timestamp_millis();
    {
        let mut conn = state.conn()?;
        // 网络等待结束后重读：期间用户可能已经改过标签、自动录制或删了关注。
        let mut list = if auto_record_only {
            follow::list_auto_record(&conn)?
        } else {
            follow::list(&conn)?
        };
        let now = checked_at;
        let mut batch = Vec::new();
        for rec in &mut list {
            let key = (rec.site_id.clone(), rec.room_id.clone());
            if let Some(live_status) = status_map.get(&key) {
                if live_status.is_some() {
                    refreshed_keys.push(follow_key(&rec.site_id, &rec.room_id));
                    refreshed += 1;
                }
                apply_live_status(rec, *live_status);
                rec.updated_at = now;
                batch.push(follow::FollowLiveStatusUpdate {
                    site_id: rec.site_id.clone(),
                    room_id: rec.room_id.clone(),
                    live_status: rec.live_status,
                    live_started_at: rec.live_started_at,
                    updated_at: now,
                });
            }
            updated.push(FollowUserDto::from(rec.clone()));
        }
        // 一轮刷新一个事务；只写状态字段，不覆盖用户修改也不复活已删除的关注。
        follow::apply_live_status_batch(&mut conn, &batch)?;
    }
    // 定向重试时 total 只统计被点名的条数，避免 UI 把未参与的房间算作本轮结果。
    let total = if targets.is_some() {
        refreshed + failures.len()
    } else {
        updated.len()
    };
    Ok(FollowRefreshResult {
        follows: updated,
        summary: FollowRefreshSummary {
            total,
            refreshed,
            refreshed_keys,
            failures,
            checked_at,
        },
    })
}

/// 刷新命令的返回值：列表加上本轮摘要。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FollowRefreshResult {
    pub follows: Vec<FollowUserDto>,
    pub summary: FollowRefreshSummary,
}

#[tauri::command]
pub async fn follow_refresh(state: State<'_, AppState>) -> AppResult<FollowRefreshResult> {
    refresh_follows(&state, false, None).await
}

#[tauri::command]
pub async fn follow_refresh_auto_record(
    state: State<'_, AppState>,
) -> AppResult<FollowRefreshResult> {
    refresh_follows(&state, true, None).await
}

/// 只重试指定房间。用于 UI 的「重试失败项」，不需要重新探测整张列表。
#[tauri::command]
pub async fn follow_refresh_selected(
    state: State<'_, AppState>,
    targets: Vec<FollowRefreshTarget>,
) -> AppResult<FollowRefreshResult> {
    refresh_follows(&state, false, Some(targets)).await
}

/// 定向重试的目标。带上 `user_name` 以便失败时还能显示是谁。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FollowRefreshTarget {
    pub site_id: String,
    pub room_id: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(live_status: Option<i32>, live_started_at: Option<i64>) -> FollowRecord {
        FollowRecord {
            site_id: "bilibili".into(),
            room_id: "1".into(),
            user_name: "主播".into(),
            face: String::new(),
            tag_ids: Vec::new(),
            auto_record: false,
            live_status,
            live_started_at,
            updated_at: 0,
        }
    }

    #[test]
    fn a_new_live_session_without_timestamp_does_not_keep_the_old_session_start() {
        let mut follow = record(Some(0), Some(1_700_000_000_000));

        apply_live_status(
            &mut follow,
            Some(LiveRoomStatus {
                status: true,
                live_started_at: None,
            }),
        );

        assert_eq!(follow.live_status, Some(1));
        assert_eq!(follow.live_started_at, None);

        // 偶发失败后，未知的先前状态也可能携带旧时间戳，
        // 因此必须把它视为可能是新的一场直播。
        let mut unknown = record(None, Some(1_700_000_000_000));
        apply_live_status(
            &mut unknown,
            Some(LiveRoomStatus {
                status: true,
                live_started_at: None,
            }),
        );
        assert_eq!(unknown.live_started_at, None);
    }

    #[test]
    fn an_ongoing_live_session_keeps_its_known_start_when_probe_has_none() {
        let mut follow = record(Some(1), Some(1_700_000_000_000));

        apply_live_status(
            &mut follow,
            Some(LiveRoomStatus {
                status: true,
                live_started_at: None,
            }),
        );

        assert_eq!(follow.live_started_at, Some(1_700_000_000_000));
    }

    #[test]
    fn offline_and_failed_probes_handle_start_time_deliberately() {
        let mut offline = record(Some(1), Some(1_700_000_000_000));
        apply_live_status(
            &mut offline,
            Some(LiveRoomStatus {
                status: false,
                live_started_at: Some(1_700_000_000_000),
            }),
        );
        assert_eq!(offline.live_status, Some(0));
        assert_eq!(offline.live_started_at, None);

        let mut failed = record(Some(1), Some(1_700_000_000_000));
        apply_live_status(&mut failed, None);
        assert_eq!(failed.live_status, None);
        assert_eq!(failed.live_started_at, Some(1_700_000_000_000));
    }

    /// F-02：失败项必须与「未开播」区分，并携带可安全展示的错误类别。
    #[test]
    fn failure_categories_are_safe_and_do_not_carry_upstream_bodies() {
        let failure = FollowRefreshFailure {
            site_id: "bilibili".into(),
            room_id: "1".into(),
            user_name: "主播".into(),
            code: "bilibili_http_error".into(),
            retryable: true,
        };
        let json = serde_json::to_string(&failure).unwrap();
        // 不携带上游正文、URL、Cookie 字段。
        assert!(!json.contains("://"));
        assert!(!json.contains("cookie"));
        assert!(!json.contains("SESSDATA"));
        assert!(json.contains("bilibili_http_error"));
    }

    #[test]
    fn a_failed_probe_is_not_reported_as_offline() {
        // 失败时保留上一状态，只把状态本身置为未知；
        // 这与「平台确认未开播」是不同事实。
        let mut previously_live = record(Some(1), Some(1_700_000_000_000));
        apply_live_status(&mut previously_live, None);
        assert_ne!(previously_live.live_status, Some(0));

        let mut previously_offline = record(Some(0), None);
        apply_live_status(&mut previously_offline, None);
        assert_ne!(previously_offline.live_status, Some(0));
    }

    #[test]
    fn refresh_summary_reports_counts_and_confirmed_keys() {
        let summary = FollowRefreshSummary {
            total: 10,
            refreshed: 7,
            refreshed_keys: vec![follow_key("bilibili", "1")],
            failures: vec![FollowRefreshFailure {
                site_id: "bilibili".into(),
                room_id: "2".into(),
                user_name: "主播".into(),
                code: "bilibili_http_error".into(),
                retryable: true,
            }],
            checked_at: 1_700_000_000_000,
        };
        let json = serde_json::to_value(&summary).unwrap();
        assert_eq!(json["total"], 10);
        assert_eq!(json["refreshed"], 7);
        assert_eq!(json["refreshed_keys"][0], "bilibili:1");
        assert_eq!(json["failures"][0]["retryable"], true);
        assert_eq!(json["checked_at"], 1_700_000_000_000_i64);
    }

    #[test]
    fn follow_key_is_stable_and_separates_site_from_room() {
        assert_eq!(follow_key("bilibili", "1"), "bilibili:1");
        // 不同站点同房号不能碰撞。
        assert_ne!(follow_key("bilibili", "1"), follow_key("huya", "1"));
    }
}
