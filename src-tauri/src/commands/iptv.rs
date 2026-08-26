//! 独立 IPTV 频道浏览器的 Tauri 命令。

use tauri::State;

use crate::db::iptv_favorite::{self, IptvFavoriteGroupRecord, IptvFavoriteRecord};
use crate::error::{AppError, AppResult};
use crate::iptv::{self, IptvChannel, IptvChannelAvailability, IptvChannelCheck};
use crate::state::AppState;

fn lock_db(state: &AppState) -> AppResult<std::sync::MutexGuard<'_, rusqlite::Connection>> {
    state
        .db
        .lock()
        .map_err(|_| AppError::new("db_lock_error", "database mutex poisoned"))
}

fn configured_proxy(state: &AppState) -> AppResult<Option<String>> {
    let conn = state
        .db
        .lock()
        .map_err(|_| crate::error::AppError::new("db_lock_error", "database mutex poisoned"))?;
    Ok(crate::settings::get(&conn)?.proxy)
}

#[tauri::command(async)]
pub async fn iptv_load_playlist(
    state: State<'_, AppState>,
    source_url: String,
) -> AppResult<Vec<IptvChannel>> {
    let proxy = configured_proxy(state.inner())?;
    iptv::load_playlist(&source_url, proxy.as_deref()).await
}

#[tauri::command(async)]
pub async fn iptv_check_channels(
    state: State<'_, AppState>,
    checks: Vec<IptvChannelCheck>,
) -> AppResult<Vec<IptvChannelAvailability>> {
    let proxy = configured_proxy(state.inner())?;
    iptv::check_channels(checks, proxy.as_deref()).await
}

#[tauri::command]
pub fn iptv_favorite_list(
    state: State<'_, AppState>,
    source_id: Option<String>,
) -> AppResult<Vec<IptvFavoriteRecord>> {
    let conn = lock_db(&state)?;
    match source_id {
        Some(source_id) => iptv_favorite::list(&conn, source_id.trim()),
        None => iptv_favorite::list_all(&conn),
    }
}

#[tauri::command]
pub fn iptv_favorite_add(
    state: State<'_, AppState>,
    mut favorite: IptvFavoriteRecord,
) -> AppResult<()> {
    favorite.source_id = favorite.source_id.trim().to_string();
    favorite.url = favorite.url.trim().to_string();
    if favorite.source_id.is_empty() || favorite.source_id.chars().count() > 64 {
        return Err(AppError::new("invalid_iptv_favorite", "频道源标识无效"));
    }
    let channel_url = reqwest::Url::parse(&favorite.url)
        .ok()
        .filter(|url| matches!(url.scheme(), "http" | "https"));
    if channel_url.is_none() {
        return Err(AppError::new("invalid_iptv_favorite", "频道地址无效"));
    }
    if favorite.updated_at == 0 {
        favorite.updated_at = chrono::Utc::now().timestamp_millis();
    }
    let conn = lock_db(&state)?;
    iptv_favorite::upsert(&conn, favorite)
}

#[tauri::command]
pub fn iptv_favorite_remove(
    state: State<'_, AppState>,
    source_id: String,
    channel_url: String,
) -> AppResult<()> {
    let conn = lock_db(&state)?;
    iptv_favorite::remove(&conn, source_id.trim(), channel_url.trim())
}

#[tauri::command]
pub fn iptv_favorite_group_list(
    state: State<'_, AppState>,
) -> AppResult<Vec<IptvFavoriteGroupRecord>> {
    let conn = lock_db(&state)?;
    iptv_favorite::list_groups(&conn)
}

#[tauri::command]
pub fn iptv_favorite_group_upsert(
    state: State<'_, AppState>,
    name: String,
    id: Option<String>,
) -> AppResult<IptvFavoriteGroupRecord> {
    let group = IptvFavoriteGroupRecord {
        id: id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
        name: name.trim().to_string(),
    };
    if group.name.is_empty() {
        return Err(AppError::new(
            "invalid_iptv_favorite_group",
            "分组名称不能为空",
        ));
    }
    if group.name.chars().count() > 32 {
        return Err(AppError::new(
            "invalid_iptv_favorite_group",
            "分组名称不能超过 32 个字符",
        ));
    }

    let conn = lock_db(&state)?;
    iptv_favorite::upsert_group(&conn, group.clone())?;
    Ok(group)
}

#[tauri::command]
pub fn iptv_favorite_group_remove(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let mut conn = lock_db(&state)?;
    iptv_favorite::remove_group(&mut conn, id.trim())
}

#[tauri::command]
pub fn iptv_favorite_set_group(
    state: State<'_, AppState>,
    source_id: String,
    channel_url: String,
    group_id: Option<String>,
) -> AppResult<()> {
    let group_id = group_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty());
    let conn = lock_db(&state)?;
    iptv_favorite::set_group(&conn, source_id.trim(), channel_url.trim(), group_id)
}
