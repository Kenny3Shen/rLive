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
///
/// 它只保证**资产**就绪（必要时下载），不加载 ONNX 会话：
/// 会话留给用户真的打开字幕时的 `asr_load_session`。
#[tauri::command]
pub fn asr_enable(state: State<'_, AppState>) -> AppResult<AsrModelStatus> {
    let (proxy, options) = asr_settings(state.inner())?;
    state.asr.enable(proxy, options)
}

/// 按实际字幕需求加载识别会话。用户第一次打开字幕时调用。
///
/// 资产尚未就绪时它只登记需求，正在进行的 `asr_enable` 准备任务
/// 会在下载完成后接着加载，不会重复下载。
#[tauri::command]
pub fn asr_load_session(state: State<'_, AppState>) -> AppResult<AsrModelStatus> {
    let (proxy, _) = asr_settings(state.inner())?;
    state.asr.load_session(proxy)
}

fn asr_settings(state: &AppState) -> AppResult<(Option<String>, AsrRuntimeOptions)> {
    let conn = state
        .db
        .lock()
        .map_err(|_| AppError::new("db_lock_error", "读取代理设置失败"))?;
    let settings = crate::settings::get(&conn)?;
    Ok((
        settings.proxy,
        AsrRuntimeOptions {
            provider: settings.asr_provider,
            vad_enabled: settings.asr_vad_enabled,
            punctuation_enabled: settings.asr_punctuation_enabled,
            speaker_enabled: settings.asr_speaker_diarization_enabled,
            hotwords: settings.asr_hotwords,
        },
    ))
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

/// 登记一个开始消费字幕的播放器。
///
/// 字幕开着但媒体暂停时不会产生转写请求，但那不代表可以卸载模型；
/// 有活动消费者时空闲看门狗不会释放会话。
#[tauri::command]
pub fn asr_streaming_started(state: State<'_, AppState>) {
    state.asr.streaming_started();
}

/// 注销一个停止消费字幕的播放器。会话本身交给空闲看门狗释放，
/// 以便用户快速开关字幕时不必反复重载模型。
#[tauri::command]
pub fn asr_streaming_stopped(state: State<'_, AppState>) {
    state.asr.streaming_stopped();
}

#[tauri::command]
pub async fn asr_transcribe(
    state: State<'_, AppState>,
    pcm_base64: String,
) -> AppResult<AsrTranscribeResult> {
    let pcm = decode_base64_pcm(&pcm_base64)?;
    state.asr.transcribe_pcm(pcm).await
}
