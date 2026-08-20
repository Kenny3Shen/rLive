//! Exit confirmation for the desktop window.
//!
//! Recording keeps running after its page is left, so closing the window can
//! discard capture the user still wants. The window close handler asks the
//! frontend first whenever tasks are active; these commands are the two answers
//! it can give back.

#![cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]

use tauri::State;

use crate::error::AppResult;
use crate::state::AppState;

/// Number of recordings currently capturing media. The exit dialog reads it so
/// its copy matches the library, and the sidebar badge falls back to it when the
/// recording list query has not settled yet.
#[tauri::command]
pub fn recording_active_count(state: State<'_, AppState>) -> usize {
    state.recording.active_count()
}

/// Stop every recording, tear down background services, and leave.
///
/// The window close handler prevented the close and handed the decision to the
/// user; this is the confirmed answer. Stopping is awaited rather than detached
/// so the media, danmaku sidecar, and metadata of each task are finalized before
/// the process goes away.
#[tauri::command(async)]
pub async fn app_confirm_exit(state: State<'_, AppState>) -> AppResult<()> {
    let state = state.inner();
    state.recording.stop_all_graceful().await;
    state.stream_proxy.stop();
    state.image_proxy.stop();
    state.lan_sync.stop();
    state.danmaku.disconnect();
    std::process::exit(0);
}
