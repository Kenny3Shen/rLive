use tauri::State;

use crate::asr::{AsrModelStatus, AsrTranscribeResult, decode_base64_pcm};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

#[tauri::command]
pub fn asr_get_status(state: State<'_, AppState>) -> AppResult<AsrModelStatus> {
    state.asr.status()
}

/// Start an idempotent background download/load operation. The command returns
/// immediately so selecting the setting never blocks the UI thread.
#[tauri::command]
pub fn asr_enable(state: State<'_, AppState>) -> AppResult<AsrModelStatus> {
    let (proxy, speaker_diarization_enabled) = {
        let conn = state
            .db
            .lock()
            .map_err(|_| AppError::new("db_lock_error", "读取代理设置失败"))?;
        let settings = crate::settings::get(&conn)?;
        (settings.proxy, settings.asr_speaker_diarization_enabled)
    };
    state.asr.enable(proxy, speaker_diarization_enabled)
}

#[tauri::command]
pub async fn asr_disable(state: State<'_, AppState>) -> AppResult<AsrModelStatus> {
    state.asr.disable().await
}

/// Drop streaming decoder state without unloading the model. The player calls
/// this when switching rooms or streams so one caption never continues an
/// utterance that belongs to a previous session.
#[tauri::command]
pub fn asr_reset_stream(state: State<'_, AppState>) -> AppResult<()> {
    state.asr.reset_stream()
}

#[tauri::command]
pub async fn asr_transcribe(
    state: State<'_, AppState>,
    pcm_base64: String,
) -> AppResult<AsrTranscribeResult> {
    let pcm = decode_base64_pcm(&pcm_base64)?;
    state.asr.transcribe_pcm(pcm).await
}
