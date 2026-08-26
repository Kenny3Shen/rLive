use tauri::State;

use crate::asr::{AsrModelStatus, AsrRuntimeOptions, AsrTranscribeResult, decode_base64_pcm};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

#[tauri::command]
pub fn asr_get_status(state: State<'_, AppState>) -> AppResult<AsrModelStatus> {
    state.asr.status()
}

/// 启动幂等的后台下载/加载操作。命令立即返回，
/// 因此选择该设置绝不会阻塞 UI 线程。
#[tauri::command]
pub fn asr_enable(state: State<'_, AppState>) -> AppResult<AsrModelStatus> {
    let (proxy, options) = {
        let conn = state
            .db
            .lock()
            .map_err(|_| AppError::new("db_lock_error", "读取代理设置失败"))?;
        let settings = crate::settings::get(&conn)?;
        (
            settings.proxy,
            AsrRuntimeOptions {
                provider: settings.asr_provider,
                vad_enabled: settings.asr_vad_enabled,
                punctuation_enabled: settings.asr_punctuation_enabled,
                speaker_enabled: settings.asr_speaker_diarization_enabled,
                hotwords: settings.asr_hotwords,
            },
        )
    };
    state.asr.enable(proxy, options)
}

#[tauri::command]
pub async fn asr_disable(state: State<'_, AppState>) -> AppResult<AsrModelStatus> {
    state.asr.disable().await
}

/// 丢弃流式解码器状态但不卸载模型。播放器切换房间或线路时调用，
/// 使一条字幕绝不会延续属于上一个会话的语句。
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
