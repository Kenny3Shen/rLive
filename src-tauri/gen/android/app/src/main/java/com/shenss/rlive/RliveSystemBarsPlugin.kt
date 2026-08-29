package com.shenss.rlive

import android.app.Activity
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

/** 应用当前渲染表面是否为深色主题。 */
@InvokeArg
class SystemBarAppearanceArgs {
  var dark: Boolean = false
}

/**
 * 应用亮暗主题到 Android 系统栏图标外观的桥。
 *
 * 应用主题保存在 WebView 的 localStorage 里，Kotlin 读不到；
 * `enableEdgeToEdge()` 只按系统 night mode 决定一次图标颜色，
 * 「系统浅色 + 应用深色」等组合会让状态栏图标与页面背景同色。
 * 前端在每次主题应用时把 resolved 亮暗经这里下发，见
 * [RliveSystemBars]。
 */
@TauriPlugin
class RliveSystemBarsPlugin(private val activity: Activity) : Plugin(activity) {

  @Command
  fun setAppearance(invoke: Invoke) {
    val args = invoke.parseArgs(SystemBarAppearanceArgs::class.java)
    activity.runOnUiThread {
      try {
        RliveSystemBars.applyFromApp(activity, args.dark)
        invoke.resolve(JSObject().apply { put("dark", args.dark) })
      } catch (error: Exception) {
        invoke.reject(error.message ?: "同步系统栏外观失败")
      }
    }
  }
}
