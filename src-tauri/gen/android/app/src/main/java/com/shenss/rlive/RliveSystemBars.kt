package com.shenss.rlive

import android.app.Activity
import android.content.Context
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.webkit.WebView
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsControllerCompat

/**
 * Android 系统栏图标外观的唯一写入点。
 *
 * `enableEdgeToEdge()` 只按 **系统** night mode 决定一次图标颜色，而应用主题
 * 存在 WebView 的 localStorage 里，Kotlin 读不到；「系统浅色 + 应用深色」
 * 等组合会让状态栏图标与页面背景同色。前端每次应用主题时经
 * [RliveSystemBarsPlugin] 把 resolved 亮暗下发到这里。
 *
 * 冷启动首帧由 SharedPreferences 记忆值恢复（Activity 重建时静态值也仍在），
 * 避免先按系统 night mode 反色、页面加载后再纠正的闪烁。视频全屏
 * （custom view）与页面内全屏都覆盖为白图标，退出后回到应用主题外观。
 *
 * 所有方法都必须在主线程调用（现有调用方均为 UI 线程上下文）。
 */
object RliveSystemBars {
  private const val PREFERENCES_NAME = "rlive-system-bars"
  private const val KEY_DARK_SURFACE = "dark_surface"

  /** 与 index.html 启动页同源的背景色，保证启动窗口到 WebView 首帧颜色连续。 */
  private val LAUNCH_BACKGROUND_DARK = Color.parseColor("#111217")
  private val LAUNCH_BACKGROUND_LIGHT = Color.parseColor("#f8f9fb")

  /** 最近一次前端下发的应用主题是否为深色表面；null 表示尚未收到。 */
  private var darkSurfaceFromApp: Boolean? = null

  /** 视频全屏 custom view 是否持有系统栏。 */
  private var videoFullscreenActive: Boolean = false

  /** 前端经插件命令下发应用主题的 resolved 亮暗。 */
  fun applyFromApp(activity: Activity, darkSurface: Boolean) {
    darkSurfaceFromApp = darkSurface
    activity
      .getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)
      .edit()
      .putBoolean(KEY_DARK_SURFACE, darkSurface)
      .apply()
    reapply(activity)
  }

  /**
   * Activity 重建后恢复上次会话记忆的主题，供冷启动首帧与
   * 页面加载前的 `onResume` 使用；没有记忆值时保持
   * `enableEdgeToEdge()` 的默认外观不动。
   */
  fun restoreFromPreferences(activity: Activity) {
    val preferences = activity.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)
    if (preferences.contains(KEY_DARK_SURFACE)) {
      val darkSurface = preferences.getBoolean(KEY_DARK_SURFACE, false)
      darkSurfaceFromApp = darkSurface
      applyLaunchWindowBackground(activity, darkSurface)
      reapply(activity)
    }
  }

  /**
   * 启动窗口背景跟随应用主题：主题的 windowBackground 按 **系统** night mode
   * 解析，深色主题在系统浅色下会先白屏一秒再切换；这期间按应用主题恢复的
   * 白色状态栏图标叠在白底上也不可读。背景与 index.html 启动页同色，
   * WebView 首帧前就绪。无记忆值时保持主题默认。
   */
  private fun applyLaunchWindowBackground(activity: Activity, darkSurface: Boolean) {
    val background = if (darkSurface) LAUNCH_BACKGROUND_DARK else LAUNCH_BACKGROUND_LIGHT
    activity.window.setBackgroundDrawable(ColorDrawable(background))
  }

  /**
   * WebView 首次绘制前默认白底，会在启动窗口与页面首帧之间插入一帧白闪，
   * 这帧上白色状态栏图标也不可读。按记忆的应用主题（无记忆值时回落
   * 系统 night mode，与 enableEdgeToEdge 一致）预置底色。
   * 必须在页面加载前调用，即 MainActivity.onWebViewCreate。
   */
  fun applyWebViewBackground(activity: Activity, webView: WebView) {
    val darkSurface = darkSurfaceFromApp ?: systemInNightMode(activity)
    webView.setBackgroundColor(
      if (darkSurface) LAUNCH_BACKGROUND_DARK else LAUNCH_BACKGROUND_LIGHT,
    )
  }

  /**
   * Activity 重建不会保留 custom view，静态覆盖标志同理要清掉，
   * 否则陈旧的「仍在视频全屏」会把图标锁死为白色。
   */
  fun forgetVideoFullscreen() {
    videoFullscreenActive = false
  }

  /** 视频全屏进入/退出时更新覆盖并立即重放外观。 */
  fun setVideoFullscreen(activity: Activity, active: Boolean) {
    videoFullscreenActive = active
    reapply(activity)
  }

  /** 按当前所有来源重新解析并写入系统栏图标外观；幂等。 */
  fun reapply(activity: Activity) {
    val immersive = videoFullscreenActive || RlivePlayerControlsPlugin.isImmersiveActive()
    val light = appearanceLightSystemBars(
      darkSurface = darkSurfaceFromApp,
      immersive = immersive,
      systemNightMode = systemInNightMode(activity),
    )
    val controller =
      WindowCompat.getInsetsController(activity.window, activity.window.decorView)
    controller.isAppearanceLightStatusBars = light
    // API < 26 上导航栏外观是 no-op，与 minSdk 24 的兼容边界一致。
    controller.isAppearanceLightNavigationBars = light
  }

  private fun systemInNightMode(activity: Activity): Boolean =
    (activity.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) ==
      Configuration.UI_MODE_NIGHT_YES
}
