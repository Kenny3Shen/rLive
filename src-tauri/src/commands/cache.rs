//! Tauri commands for the persistent local image cache.

use tauri::State;

use crate::error::AppResult;
use crate::image_cache::CacheUsage;
use crate::state::AppState;

#[tauri::command(async)]
pub async fn cache_usage(state: State<'_, AppState>) -> AppResult<CacheUsage> {
    Ok(state.image_proxy.cache_usage().await)
}

#[tauri::command(async)]
pub async fn cache_clear(state: State<'_, AppState>) -> AppResult<CacheUsage> {
    state.image_proxy.cache_clear().await
}
