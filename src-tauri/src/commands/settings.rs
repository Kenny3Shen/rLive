use serde::Serialize;
use tauri::State;

use crate::error::AppResult;
use crate::models::AppSettings;
use crate::state::AppState;

#[derive(Serialize)]
pub struct SettingsGetResponse {
    pub settings: AppSettings,
    pub has_saved_settings: bool,
    /// 当前实际生效的出口描述（已抹掉代理账号密码）。
    ///
    /// 「自动」的解析结果在 Rust 侧（环境变量与操作系统设置），前端无法自行推导，
    /// 因此随设置一起下发，让设置页能直接展示「现在走的是哪条路」。
    pub proxy_status: String,
}

#[tauri::command]
pub fn settings_get(state: State<'_, AppState>) -> AppResult<SettingsGetResponse> {
    let conn = state
        .db
        .lock()
        .map_err(|e| crate::error::AppError::new("db_lock_error", format!("settings_get: {e}")))?;
    let (settings, has_saved_settings) = crate::settings::get_with_status(&conn)?;
    let proxy_status = settings.proxy_route().describe();
    Ok(SettingsGetResponse {
        settings,
        has_saved_settings,
        proxy_status,
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
