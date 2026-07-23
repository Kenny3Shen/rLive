use tauri::State;

use crate::error::AppResult;
use crate::models::AppSettings;
use crate::state::AppState;

#[tauri::command]
pub fn settings_get(state: State<'_, AppState>) -> AppResult<AppSettings> {
    let conn = state.db.lock().map_err(|e| {
        crate::error::AppError::new("db_lock_error", format!("settings_get: {e}"))
    })?;
    crate::settings::get(&conn)
}

#[tauri::command]
pub fn settings_set(state: State<'_, AppState>, settings: AppSettings) -> AppResult<()> {
    let conn = state.db.lock().map_err(|e| {
        crate::error::AppError::new("db_lock_error", format!("settings_set: {e}"))
    })?;
    crate::settings::set(&conn, &settings)
}
