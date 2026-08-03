use serde::Serialize;
use tauri::State;

use crate::asr::{AsrCaptionSegment, AsrModelStatus, decode_base64_pcm};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

#[derive(Debug, Serialize)]
pub struct AsrTranscribeResponse {
    pub segments: Vec<AsrCaptionSegment>,
}

#[tauri::command]
pub fn asr_get_status(state: State<'_, AppState>) -> AppResult<AsrModelStatus> {
    state.asr.status()
}

/// Start an idempotent background download/load operation. The command returns
/// immediately so selecting the setting never blocks the UI thread.
#[tauri::command]
pub fn asr_enable(state: State<'_, AppState>) -> AppResult<AsrModelStatus> {
    let (proxy, vad_enabled) = {
        let conn = state
            .db
            .lock()
            .map_err(|_| AppError::new("db_lock_error", "读取代理设置失败"))?;
        let settings = crate::settings::get(&conn)?;
        (settings.proxy, settings.asr_vad_enabled)
    };
    state.asr.enable(proxy, vad_enabled)
}

#[tauri::command]
pub async fn asr_disable(state: State<'_, AppState>) -> AppResult<AsrModelStatus> {
    state.asr.disable().await
}

#[tauri::command]
pub async fn asr_transcribe(
    state: State<'_, AppState>,
    pcm_base64: String,
) -> AppResult<AsrTranscribeResponse> {
    let pcm = decode_base64_pcm(&pcm_base64)?;
    let segments = state.asr.transcribe_pcm(pcm).await?;
    Ok(AsrTranscribeResponse { segments })
}
