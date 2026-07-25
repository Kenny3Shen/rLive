use serde::Serialize;
use tauri::State;

use crate::error::AppResult;
use crate::models::AppSettings;
use crate::state::AppState;

#[derive(Serialize)]
pub struct SettingsGetResponse {
    pub settings: AppSettings,
    pub has_saved_settings: bool,
}

#[tauri::command]
pub fn settings_get(state: State<'_, AppState>) -> AppResult<SettingsGetResponse> {
    let conn = state
        .db
        .lock()
        .map_err(|e| crate::error::AppError::new("db_lock_error", format!("settings_get: {e}")))?;
    let (settings, has_saved_settings) = crate::settings::get_with_status(&conn)?;
    Ok(SettingsGetResponse {
        settings,
        has_saved_settings,
    })
}

#[tauri::command]
pub fn settings_set(state: State<'_, AppState>, settings: AppSettings) -> AppResult<()> {
    let conn = state
        .db
        .lock()
        .map_err(|e| crate::error::AppError::new("db_lock_error", format!("settings_set: {e}")))?;
    crate::settings::set(&conn, &settings)
}
