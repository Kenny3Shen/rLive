//! 把应用主题的 resolved 亮暗同步给 Android 的 `RliveSystemBarsPlugin`，
//! 使系统状态栏 / 导航栏图标颜色跟随应用主题而不是系统 night mode。
//!
//! 桥接方式与 `android_player_controls` 一致：webview 发出的
//! `plugin:<name>|<command>` invoke 由 Rust 插件自己的 invoke handler 应答，
//! 到不了 Kotlin 的 `@Command` 方法，因此经 `register_android_plugin`
//! 返回的 `PluginHandle` 转发，并注册为应用自己的命令。
//!
//! 桌面端与浏览器构建编译文件末尾直接拒绝的 stub；前端在非 Android
//! 客户端本来就不会调用。

#[cfg(target_os = "android")]
mod android {
    use crate::error::{AppError, AppResult};
    use serde_json::{Value, json};
    use tauri::State;
    use tauri::plugin::PluginHandle;

    /// 受管理的包装类型，使命令能触达已注册的 Kotlin 插件。
    pub struct AndroidSystemBars(pub PluginHandle<tauri::Wry>);

    async fn run(
        system_bars: State<'_, AndroidSystemBars>,
        command: &'static str,
        payload: Value,
    ) -> AppResult<Value> {
        system_bars
            .0
            .run_mobile_plugin_async::<Value>(command, payload)
            .await
            .map_err(|error| {
                tracing::warn!(command, %error, "Android 系统栏命令失败");
                AppError::new("android_system_bars_error", format!("{command}: {error}"))
            })
    }

    /// 同步应用当前渲染表面的亮暗到系统栏图标外观。
    #[tauri::command]
    pub async fn android_system_bars_set_appearance(
        system_bars: State<'_, AndroidSystemBars>,
        dark: bool,
    ) -> AppResult<Value> {
        run(system_bars, "setAppearance", json!({ "dark": dark })).await
    }
}

#[cfg(target_os = "android")]
pub use android::{AndroidSystemBars, android_system_bars_set_appearance};

#[cfg(not(target_os = "android"))]
mod fallback {
    use crate::error::{AppError, AppResult};
    use serde_json::Value;

    /// 前端会先做 Android 判断再调用该命令，所以桌面端走到这里说明有 bug，
    /// 而不是用户可见路径；这里明确报错，而不是假装同步已经成功。
    fn unsupported() -> AppError {
        AppError::new(
            "android_system_bars_unsupported",
            "系统栏外观同步仅在 Android 客户端可用",
        )
    }

    #[tauri::command]
    pub async fn android_system_bars_set_appearance(_dark: bool) -> AppResult<Value> {
        Err(unsupported())
    }
}

#[cfg(not(target_os = "android"))]
pub use fallback::android_system_bars_set_appearance;
