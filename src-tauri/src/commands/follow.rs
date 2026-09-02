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

#[derive(Debug, Clone, Serialize, Deserialize)]
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
) -> AppResult<Vec<FollowUserDto>> {
    let (follows, proxy) = {
        let conn = state.conn()?;
        let follows = if auto_record_only {
            follow::list_auto_record(&conn)?
        } else {
            follow::list(&conn)?
        };
        (follows, crate::settings::get(&conn)?.proxy)
    };

    let sem = std::sync::Arc::new(tokio::sync::Semaphore::new(5));
    let mut tasks = Vec::new();

    for f in follows {
        let site_id = f.site_id.clone();
        let room_id = f.room_id.clone();
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
            let live_info = match SiteId::from_str_loose(&site_id) {
                Some(sid) => match sites::site_with_proxy(&sid, cookie, proxy.as_deref()) {
                    Ok(site) => site.get_room_live_status(&room_id).await.ok(),
                    Err(_) => None,
                },
                None => None,
            };
            (site_id, room_id, live_info)
        }));
    }

    let mut status_map = std::collections::HashMap::new();
    for t in tasks {
        if let Ok((site_id, room_id, live_info)) = t.await {
            status_map.insert((site_id, room_id), live_info);
        }
    }

    let mut updated = Vec::new();
    {
        let conn = state.conn()?;
        let mut list = if auto_record_only {
            follow::list_auto_record(&conn)?
        } else {
            follow::list(&conn)?
        };
        let now = chrono::Utc::now().timestamp_millis();
        for rec in &mut list {
            if let Some(live_status) = status_map.get(&(rec.site_id.clone(), rec.room_id.clone())) {
                apply_live_status(rec, *live_status);
                rec.updated_at = now;
                let _ = follow::upsert(&conn, rec.clone());
            }
            updated.push(FollowUserDto::from(rec.clone()));
        }
    }
    Ok(updated)
}

#[tauri::command]
pub async fn follow_refresh(state: State<'_, AppState>) -> AppResult<Vec<FollowUserDto>> {
    refresh_follows(&state, false).await
}

#[tauri::command]
pub async fn follow_refresh_auto_record(
    state: State<'_, AppState>,
) -> AppResult<Vec<FollowUserDto>> {
    refresh_follows(&state, true).await
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
}
