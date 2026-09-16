//! 持久化本地缓存（图片 + 短视频媒体分片）的 Tauri 命令。

use serde::Serialize;
use tauri::State;

use crate::error::AppResult;
use crate::state::AppState;

/// 两类缓存各自的占用，以及可浏览的根目录。
///
/// 两者根目录不同、预算与生存期也不同（图片 30 天、媒体分片 6 小时），
/// 因此分开报告；清除则是**同时**清掉两类 —— 用户按一次「清除缓存」的预期是
/// 磁盘占用归零，而不是只清掉其中看得见的那一半。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct CacheUsage {
    pub image_bytes: u64,
    pub image_files: u64,
    pub media_bytes: u64,
    pub media_files: u64,
    /// 图片缓存根目录（可浏览）。
    pub image_path: String,
    /// 媒体分片缓存根目录。
    pub media_path: String,
}

#[tauri::command(async)]
pub async fn cache_usage(state: State<'_, AppState>) -> AppResult<CacheUsage> {
    let image = state.image_proxy.cache_usage().await;
    // 媒体目录同样要存在：设置页可能在第一条短视频被缓存之前就报告占用。
    state.media_cache.ensure_root().await;
    let media = state.media_cache.usage().await;
    Ok(CacheUsage {
        image_bytes: image.bytes,
        image_files: image.files,
        media_bytes: media.bytes,
        media_files: media.files,
        image_path: image.path,
        media_path: crate::app_paths::path_to_string(state.media_cache.root()),
    })
}

#[tauri::command(async)]
pub async fn cache_clear(state: State<'_, AppState>) -> AppResult<CacheUsage> {
    state.image_proxy.cache_clear().await?;
    state.media_cache.clear().await?;
    cache_usage(state).await
}
