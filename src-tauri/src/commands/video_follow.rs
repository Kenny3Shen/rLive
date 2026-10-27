use tauri::State;

use crate::db::video_follow::{
    self, VideoFollowGroupRecord, VideoFollowRecord, normalize_group_id,
};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// Tauri 命令参数由前端按 camelCase 传入；数据库与 IPC 返回结构保持 snake_case。
fn required_camel_arg(value: Option<String>, field: &str) -> AppResult<String> {
    value.ok_or_else(|| AppError::new("invalid_video_follow", format!("缺少视频关注参数 {field}")))
}

#[tauri::command]
pub fn video_follow_list(state: State<'_, AppState>) -> AppResult<Vec<VideoFollowRecord>> {
    let conn = state.conn()?;
    video_follow::list(&conn)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn video_follow_upsert(
    state: State<'_, AppState>,
    site_id: Option<String>,
    mid: String,
    name: String,
    face: Option<String>,
    group_id: Option<String>,
) -> AppResult<VideoFollowRecord> {
    let site_id = required_camel_arg(site_id, "siteId")?;
    let conn = state.conn()?;
    video_follow::upsert(
        &conn,
        VideoFollowRecord {
            site_id,
            mid,
            name,
            face,
            group_id: normalize_group_id(group_id.as_deref()),
            updated_at: chrono::Utc::now().timestamp_millis(),
        },
    )
}

#[tauri::command]
pub fn video_follow_remove(
    state: State<'_, AppState>,
    site_id: Option<String>,
    mid: String,
) -> AppResult<()> {
    let site_id = required_camel_arg(site_id, "siteId")?;
    let conn = state.conn()?;
    video_follow::remove(&conn, &site_id, &mid)
}

#[tauri::command]
pub fn video_follow_set_group(
    state: State<'_, AppState>,
    site_id: Option<String>,
    mid: String,
    group_id: Option<String>,
) -> AppResult<()> {
    let site_id = required_camel_arg(site_id, "siteId")?;
    let conn = state.conn()?;
    video_follow::set_group(&conn, &site_id, &mid, group_id.as_deref())
}

#[tauri::command]
pub fn video_follow_group_list(
    state: State<'_, AppState>,
) -> AppResult<Vec<VideoFollowGroupRecord>> {
    let conn = state.conn()?;
    video_follow::list_groups(&conn)
}

#[tauri::command]
pub fn video_follow_group_upsert(
    state: State<'_, AppState>,
    name: String,
    id: Option<String>,
) -> AppResult<VideoFollowGroupRecord> {
    let conn = state.conn()?;
    video_follow::upsert_group(
        &conn,
        VideoFollowGroupRecord {
            id: id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
            name,
        },
    )
}

#[tauri::command]
pub fn video_follow_group_remove(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let mut conn = state.conn()?;
    video_follow::remove_group(&mut conn, id.trim())
}
