//! Android 返回键的应用级桥接。
//!
//! 与 `android_player_controls` 相同的桥接结构：webview 发出的
//! `plugin:<name>|<command>` invoke 由 Rust 插件自己的 invoke handler 应答，
//! 到不了 Kotlin 的 `@Command` 方法，因此这里用应用命令包装
//! `register_android_plugin` 返回的 `PluginHandle`，并沿用 `core:default`
//! 能力。页面侧 `AndroidBackNavigator` 在底部导航根路由上、且没有浮层
//! 消费返回事件时调用它，把应用退回系统桌面；该语义原先硬编码在
//! MainActivity 的 homeBackCallback 里，移到页面侧后根路由上的抽屉等
//! 浮层才能先消费返回（见 Kotlin 的 `RliveBackNavigationPlugin`）。
//!
//! 桌面端与浏览器构建编译文件末尾直接拒绝的 stub。

#[cfg(target_os = "android")]
mod android {
    use crate::error::{AppError, AppResult};
    use serde_json::{Value, json};
    use tauri::State;
    use tauri::plugin::PluginHandle;

    /// 受管理的包装类型，使命令能触达已注册的 Kotlin 插件。
    pub struct AndroidNavigation(pub PluginHandle<tauri::Wry>);

    async fn run(
        navigation: State<'_, AndroidNavigation>,
        command: &'static str,
    ) -> AppResult<Value> {
        navigation
            .0
            .run_mobile_plugin_async::<Value>(command, json!({}))
            .await
            .map_err(|error| {
                tracing::warn!(command, %error, "Android 返回键桥接命令失败");
                AppError::new("android_navigation_error", format!("{command}: {error}"))
            })
    }

    /// Back 在底部导航根路由上的原生语义：把应用退回系统桌面。
    #[tauri::command]
    pub async fn android_move_task_to_back(
        navigation: State<'_, AndroidNavigation>,
    ) -> AppResult<Value> {
        run(navigation, "moveTaskToBack").await
    }
}

#[cfg(target_os = "android")]
pub use android::{AndroidNavigation, android_move_task_to_back};

#[cfg(not(target_os = "android"))]
mod fallback {
    use crate::error::{AppError, AppResult};
    use serde_json::Value;

    /// 前端只会在 Android 客户端上调用这个命令，桌面端走到这里说明有 bug；
    /// 明确报错而不是假装已经退回系统桌面。
    fn unsupported() -> AppError {
        AppError::new(
            "android_navigation_unsupported",
            "返回键桥接仅在 Android 客户端可用",
        )
    }

    #[tauri::command]
    pub async fn android_move_task_to_back() -> AppResult<Value> {
        Err(unsupported())
    }
}

#[cfg(not(target_os = "android"))]
pub use fallback::android_move_task_to_back;
