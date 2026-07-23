mod account;
mod commands;
mod danmaku;
mod db;
mod error;
mod http_client;
mod models;
mod player;
mod profile;
mod settings;
mod sites;
mod state;

use commands::account::{account_clear_cookie, account_get_cookie, account_set_cookie};
use commands::danmaku::{danmaku_connect, danmaku_disconnect};
use commands::follow::{
    follow_add, follow_list, follow_refresh, follow_remove, follow_set_tags, tag_list, tag_remove,
    tag_upsert,
};
use commands::history::{history_add, history_clear, history_list};
use commands::player::{
    player_enter_fullscreen, player_exit_fullscreen, player_load, player_open,
    player_set_bounds, player_set_pause, player_set_volume, player_show_danmaku, player_status,
    player_stop,
};
use commands::profile::{profile_export, profile_import};
use commands::settings::{settings_get, settings_set};
use commands::site::{
    site_get_categories, site_get_category_rooms, site_get_play_qualities, site_get_play_urls,
    site_get_recommend, site_get_room_detail, site_list, site_search_rooms,
};
use state::AppState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let state = AppState::init()?;
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            settings_get,
            settings_set,
            account_get_cookie,
            account_set_cookie,
            account_clear_cookie,
            site_list,
            site_get_categories,
            site_get_recommend,
            site_get_category_rooms,
            site_search_rooms,
            site_get_room_detail,
            site_get_play_qualities,
            site_get_play_urls,
            history_list,
            history_add,
            history_clear,
            player_open,
            player_load,
            player_stop,
            player_set_pause,
            player_set_volume,
            player_set_bounds,
            player_show_danmaku,
            player_status,
            player_enter_fullscreen,
            player_exit_fullscreen,
            danmaku_connect,
            danmaku_disconnect,
            follow_list,
            follow_add,
            follow_remove,
            follow_set_tags,
            follow_refresh,
            tag_list,
            tag_upsert,
            tag_remove,
            profile_export,
            profile_import,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                // State<'_, T> must be accessed via .inner() for field use on all platforms.
                if let Some(state) = app_handle.try_state::<AppState>() {
                    let state = state.inner();
                    let _ = state.player.stop();
                    state.danmaku.disconnect();
                }
            }
        });
}
