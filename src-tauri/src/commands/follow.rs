use serde::{Deserialize, Serialize};
use tauri::State;

use crate::account;
use crate::db::follow::{self, FollowRecord, TagRecord};
use crate::error::{AppError, AppResult};
use crate::models::live::SiteId;
use crate::sites;
use crate::state::AppState;

fn lock_db(state: &AppState) -> AppResult<std::sync::MutexGuard<'_, rusqlite::Connection>> {
    state
        .db
        .lock()
        .map_err(|_| AppError::new("db_lock_error", "database mutex poisoned"))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FollowUserDto {
    pub site_id: String,
    pub room_id: String,
    pub user_name: String,
    pub face: String,
    pub tag_ids: Vec<String>,
    pub live_status: Option<bool>,
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
            live_status: r.live_status.map(|v| v != 0),
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
            live_status: d.live_status.map(|b| if b { 1 } else { 0 }),
            updated_at: d.updated_at,
        }
    }
}

#[tauri::command]
pub fn follow_list(state: State<'_, AppState>) -> AppResult<Vec<FollowUserDto>> {
    let conn = lock_db(&state)?;
    Ok(follow::list(&conn)?.into_iter().map(Into::into).collect())
}

#[tauri::command]
pub fn follow_add(state: State<'_, AppState>, user: FollowUserDto) -> AppResult<()> {
    let mut rec: FollowRecord = user.into();
    if rec.updated_at == 0 {
        rec.updated_at = chrono::Utc::now().timestamp_millis();
    }
    let conn = lock_db(&state)?;
    follow::upsert(&conn, rec)
}

#[tauri::command]
pub fn follow_remove(
    state: State<'_, AppState>,
    site_id: String,
    room_id: String,
) -> AppResult<()> {
    let conn = lock_db(&state)?;
    follow::remove(&conn, &site_id, &room_id)
}

#[tauri::command]
pub fn follow_set_tags(
    state: State<'_, AppState>,
    site_id: String,
    room_id: String,
    tag_ids: Vec<String>,
) -> AppResult<()> {
    let conn = lock_db(&state)?;
    follow::set_tags(&conn, &site_id, &room_id, &tag_ids)
}

#[tauri::command]
pub fn tag_list(state: State<'_, AppState>) -> AppResult<Vec<TagRecord>> {
    let conn = lock_db(&state)?;
    follow::list_tags(&conn)
}

#[tauri::command]
pub fn tag_upsert(state: State<'_, AppState>, name: String) -> AppResult<TagRecord> {
    let id = uuid::Uuid::new_v4().to_string();
    let tag = TagRecord {
        id,
        name: name.trim().to_string(),
    };
    if tag.name.is_empty() {
        return Err(AppError::new("invalid_tag", "tag name is empty"));
    }
    let conn = lock_db(&state)?;
    follow::upsert_tag(&conn, tag.clone())?;
    Ok(tag)
}

#[tauri::command]
pub fn tag_remove(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let conn = lock_db(&state)?;
    // tags table has no dedicated remove helper — execute here
    conn.execute("DELETE FROM tags WHERE id = ?1", rusqlite::params![id])
        .map_err(crate::db::schema::map_db_err)?;
    Ok(())
}

#[tauri::command]
pub async fn follow_refresh(state: State<'_, AppState>) -> AppResult<Vec<FollowUserDto>> {
    let follows = {
        let conn = lock_db(&state)?;
        follow::list(&conn)?
    };

    let sem = std::sync::Arc::new(tokio::sync::Semaphore::new(5));
    let mut tasks = Vec::new();

    for f in follows {
        let site_id = f.site_id.clone();
        let room_id = f.room_id.clone();
        let permit = sem.clone().acquire_owned().await.map_err(|_| {
            AppError::new("refresh_error", "semaphore closed")
        })?;
        let cookie = {
            let sid = SiteId::from_str_loose(&site_id);
            let conn = lock_db(&state)?;
            match sid {
                Some(s) => account::get_cookie(&conn, &s)?,
                None => None,
            }
        };
        tasks.push(tokio::spawn(async move {
            let _permit = permit;
            let live_status = match SiteId::from_str_loose(&site_id) {
                Some(sid) => match sites::site(&sid, cookie) {
                    Ok(site) => site.get_live_status(&room_id).await.ok(),
                    Err(_) => None,
                },
                None => None,
            };
            (site_id, room_id, live_status)
        }));
    }

    let mut status_map = std::collections::HashMap::new();
    for t in tasks {
        if let Ok((site_id, room_id, st)) = t.await {
            status_map.insert((site_id, room_id), st);
        }
    }

    let mut updated = Vec::new();
    {
        let conn = lock_db(&state)?;
        let mut list = follow::list(&conn)?;
        let now = chrono::Utc::now().timestamp_millis();
        for rec in &mut list {
            if let Some(st) = status_map.get(&(rec.site_id.clone(), rec.room_id.clone())) {
                rec.live_status = st.map(|b| if b { 1 } else { 0 });
                rec.updated_at = now;
                let _ = follow::upsert(&conn, rec.clone());
            }
            updated.push(FollowUserDto::from(rec.clone()));
        }
    }
    Ok(updated)
}
