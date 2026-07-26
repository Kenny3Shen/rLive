//! Tauri commands for the independent IPTV channel browser.

use crate::error::AppResult;
use crate::iptv::{self, IptvChannel};

#[tauri::command(async)]
pub async fn iptv_load_playlist(source_url: String) -> AppResult<Vec<IptvChannel>> {
    iptv::load_playlist(&source_url).await
}
