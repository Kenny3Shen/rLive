//! Android 原生视频合并/打开桥。
//!
//! 桌面端用进程内 FFmpeg 合并，Android 没有链接 FFmpeg；这里把同一件事交给
//! Kotlin 的 `RliveVideoMuxPlugin`：`MediaExtractor` 读取两条 fMP4 轨，
//! `MediaMuxer` 写成渐进式 MP4。打开成片也走原生 `FileProvider`，因为应用
//! 私有目录下的 `file://` 无法直接交给系统播放器。
//!
//! 与 `android_player_controls` 相同，webview 不能直接触达 Kotlin 的
//! `@Command`；Rust 侧必须通过 `register_android_plugin` 返回的
//! `PluginHandle` 调用，因此把句柄放进受管状态。

#[cfg(target_os = "android")]
mod android {
    use std::path::Path;

    use serde_json::{Value, json};
    use tauri::plugin::PluginHandle;
    use tauri::{AppHandle, Manager};

    use crate::error::{AppError, AppResult};

    /// 受管理的 Kotlin 插件句柄。
    pub struct AndroidVideoMux(pub PluginHandle<tauri::Wry>);

    async fn run(app: &AppHandle, command: &'static str, payload: Value) -> AppResult<Value> {
        let handle = app.state::<AndroidVideoMux>();
        handle
            .0
            .run_mobile_plugin_async::<Value>(command, payload)
            .await
            .map_err(|error| {
                tracing::warn!(command, %error, "Android 视频下载原生命令失败");
                AppError::new("android_video_mux_error", format!("{command}: {error}"))
            })
    }

    /// 合并视频轨与音频轨。调用方负责保证两条文件已经完整写入磁盘。
    pub async fn mux_video_audio(
        app: &AppHandle,
        video: &Path,
        audio: &Path,
        output: &Path,
    ) -> AppResult<()> {
        run(
            app,
            "mux",
            json!({
                "videoPath": video.to_string_lossy(),
                "audioPath": audio.to_string_lossy(),
                "outputPath": output.to_string_lossy(),
            }),
        )
        .await?;
        Ok(())
    }

    /// 用系统播放器打开应用私有目录中的 MP4。
    pub async fn open_file(app: &AppHandle, path: &Path) -> AppResult<()> {
        run(app, "openFile", json!({ "path": path.to_string_lossy() })).await?;
        Ok(())
    }
}

#[cfg(target_os = "android")]
pub use android::{AndroidVideoMux, mux_video_audio, open_file};
