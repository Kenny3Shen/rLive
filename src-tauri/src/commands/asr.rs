//! Stable Tauri command surface for the pending local-caption redesign.
//!
//! Audio is intentionally accepted as an IPC raw body instead of a JSON array:
//! a 16 kHz PCM stream would otherwise spend substantially more CPU and memory
//! serializing samples than recognizing them.

use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, State};

use crate::asr::{AsrAudioPushResult, AsrModelStatus};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// Returns the currently loaded local model and active live-caption session.
#[tauri::command]
pub fn asr_model_status(state: State<'_, AppState>) -> AppResult<AsrModelStatus> {
    state.asr.model_status()
}

/// Compatibility alias for the short name used by the renderer. Keep the
/// fuller `asr_model_status` command as the public settings-facing contract.
#[tauri::command]
pub fn asr_status(state: State<'_, AppState>) -> AppResult<AsrModelStatus> {
    state.asr.model_status()
}

/// Retained for renderer compatibility while the native backend is rebuilt.
#[tauri::command]
pub fn asr_model_load_default(state: State<'_, AppState>) -> AppResult<AsrModelStatus> {
    state.asr.load_default_model()
}

/// Releases the currently loaded model and fences any in-flight audio.
#[tauri::command]
pub fn asr_model_unload(state: State<'_, AppState>) -> AppResult<AsrModelStatus> {
    state.asr.unload_model()
}

/// Starts a new room-scoped caption session. Starting a newer session fences
/// the previous one so late recognition results cannot cross rooms.
#[tauri::command]
pub fn asr_session_start(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
) -> AppResult<AsrModelStatus> {
    state.asr.start_session(app, session_id)
}

/// Stops only the matching session. A delayed cleanup from an older room is a
/// harmless no-op rather than a way to stop the room currently on screen.
#[tauri::command]
pub fn asr_session_stop(
    state: State<'_, AppState>,
    session_id: String,
) -> AppResult<AsrModelStatus> {
    state.asr.stop_session(&session_id)
}

/// Pushes 16 kHz, mono, signed-16-bit little-endian PCM from the AudioWorklet.
///
/// The renderer must invoke this command with an `ArrayBuffer`/`Uint8Array`
/// body and these headers:
///
/// - `x-rlive-asr-session`: active session id
/// - `x-rlive-asr-start-ms`: media-relative start time in milliseconds
///
/// Passing sample arrays as ordinary command arguments is deliberately
/// rejected; it would make Tauri deserialize a large JSON payload per chunk.
#[tauri::command]
pub fn asr_audio_push(
    state: State<'_, AppState>,
    request: Request<'_>,
) -> AppResult<AsrAudioPushResult> {
    let session_id = required_header(&request, "x-rlive-asr-session")?;
    let start_ms = required_header(&request, "x-rlive-asr-start-ms")?
        .parse::<u64>()
        .map_err(|_| AppError::new("asr_invalid_start_ms", "字幕音频时间戳无效"))?;
    let body = match request.body() {
        InvokeBody::Raw(bytes) => bytes.as_slice(),
        InvokeBody::Json(_) => {
            return Err(AppError::new(
                "asr_raw_audio_required",
                "字幕音频必须使用二进制 PCM 数据传输",
            ));
        }
    };

    state.asr.push_audio(session_id, start_ms, body)
}

fn required_header<'a>(request: &'a Request<'_>, name: &str) -> AppResult<&'a str> {
    request
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::new("asr_missing_audio_header", "字幕音频请求缺少必要信息"))
}
