package com.shenss.rlive

import android.app.Activity
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

/**
 * Android 返回键的应用级语义桥。
 *
 * 返回链自上而下：视频全屏退出（MainActivity 的 fullscreenBackCallback）→
 * Tauri AppPlugin 把 `back-button` 事件派发给页面。页面在底部导航根路由上
 * 且没有浮层消费返回时，Back 的语义是回到系统桌面 —— 回退 SPA 历史只会
 * 回到上一个页签。这一语义原先硬编码在 MainActivity 的 homeBackCallback
 * （`moveTaskToBack`），但它先于页面事件运行，根路由上的抽屉等浮层永远
 * 收不到返回事件；现在由页面通过本命令在需要时显式触发。
 */
@TauriPlugin
class RliveBackNavigationPlugin(private val activity: Activity) : Plugin(activity) {
  @Command
  fun moveTaskToBack(invoke: Invoke) {
    activity.runOnUiThread {
      try {
        activity.moveTaskToBack(true)
        invoke.resolve(JSObject())
      } catch (error: Exception) {
        invoke.reject(error.message ?: "退回系统桌面失败")
      }
    }
  }
}
