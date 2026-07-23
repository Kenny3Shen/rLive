// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod account;
mod commands;
mod db;
mod error;
mod models;
mod settings;
mod state;

use commands::account::{account_clear_cookie, account_get_cookie, account_set_cookie};
use commands::settings::{settings_get, settings_set};
use state::AppState;
use tauri::Manager;

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

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
            greet,
            settings_get,
            settings_set,
            account_get_cookie,
            account_set_cookie,
            account_clear_cookie,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
