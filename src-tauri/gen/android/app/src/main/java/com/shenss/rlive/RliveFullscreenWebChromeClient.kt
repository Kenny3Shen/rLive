package com.shenss.rlive

import android.app.Activity
import android.graphics.Bitmap
import android.graphics.Color
import android.os.Message
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.webkit.ConsoleMessage
import android.webkit.GeolocationPermissions
import android.webkit.JsPromptResult
import android.webkit.JsResult
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebStorage
import android.webkit.WebView
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

/**
 * 保留 Tauri WebChromeClient 的行为，同时接管 HTML 视频全屏使用的
 * Android WebView custom view。Wry 生成的 client 拒绝 custom view，
 * 浏览器 Fullscreen API 在 Android 上会因此失败。
 *
 * 方向刻意不动：竖屏直播不能被强制横屏（Simple Live 只对非竖屏内容
 * 锁定横屏）。沉浸式系统栏照常生效，保证真正的全屏表面。
 */
@Suppress("DEPRECATION")
class RliveFullscreenWebChromeClient(
  private val activity: MainActivity,
  private val delegate: WebChromeClient,
) : WebChromeClient() {
  private var customView: View? = null
  private var customViewCallback: CustomViewCallback? = null
  private var fullscreenContainer: FrameLayout? = null

  val isShowingCustomView: Boolean
    get() = customView != null

  override fun onShowCustomView(view: View, callback: CustomViewCallback) {
    if (customView != null) {
      callback.onCustomViewHidden()
      return
    }

    val content = activity.findViewById<ViewGroup>(android.R.id.content)
    if (content == null) {
      callback.onCustomViewHidden()
      return
    }

    (view.parent as? ViewGroup)?.removeView(view)

    customView = view
    customViewCallback = callback
    fullscreenContainer = FrameLayout(activity).apply {
      setBackgroundColor(Color.BLACK)
      addView(
        view,
        FrameLayout.LayoutParams(
          ViewGroup.LayoutParams.MATCH_PARENT,
          ViewGroup.LayoutParams.MATCH_PARENT,
        ),
      )
    }
    content.addView(
      fullscreenContainer,
      ViewGroup.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.MATCH_PARENT,
      ),
    )
    enterImmersiveMode()
  }

  @Suppress("DEPRECATION")
  override fun onShowCustomView(
    view: View,
    requestedOrientation: Int,
    callback: CustomViewCallback,
  ) {
    // 忽略 WebView 的 requestedOrientation：很多直播间是竖屏，
    // 强制横屏会把竖向画面转成侧躺。
    onShowCustomView(view, callback)
  }

  override fun onHideCustomView() {
    if (dismissCustomView()) {
      delegate.onHideCustomView()
    }
  }

  /** Android 视频全屏消费了返回操作时返回 true。 */
  fun exitFullscreen(): Boolean {
    if (customView == null) {
      return false
    }

    // Chromium 通常会在这个回调里同步调用 onHideCustomView。
    customViewCallback?.onCustomViewHidden()
    if (dismissCustomView()) {
      delegate.onHideCustomView()
    }
    return true
  }

  private fun enterImmersiveMode() {
    val controller =
      WindowCompat.getInsetsController(activity.window, activity.window.decorView)
    controller.systemBarsBehavior =
      WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
    controller.hide(WindowInsetsCompat.Type.systemBars())
    // 画面为黑：临时滑出的系统栏必须是白图标（见 RliveSystemBars）。
    RliveSystemBars.setVideoFullscreen(activity, true)
  }

  private fun dismissCustomView(): Boolean {
    val container = fullscreenContainer
    if (customView == null && container == null) {
      return false
    }

    (container?.parent as? ViewGroup)?.removeView(container)
    fullscreenContainer = null
    customView = null
    customViewCallback = null

    // 先撤掉视频全屏的白图标覆盖，restoreSystemBars 再回到应用主题外观。
    RliveSystemBars.setVideoFullscreen(activity, false)
    restoreSystemBars()
    return true
  }

  /**
   * 无条件恢复系统栏。
   *
   * 早期版本在隐藏前快照 `isVisible(systemBars())`，只在快照为真时恢复。
   * 那是自毁式的：恢复出来的系统栏仍处于
   * BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE，Android 不久后会再次自动
   * 隐藏；下一次进入全屏采样到已隐藏状态，记下「当时隐藏」，之后
   * 就永远跳过恢复。
   *
   * Activity 以 edge-to-edge 运行，除视频全屏外没有别的隐藏系统栏的
   * 路径，因此不存在需要保留的合法隐藏状态。先重置 behavior 同样
   * 重要：留在 TRANSIENT 意味着刚显示的系统栏会自行淡出。
   */
  fun restoreSystemBars() {
    restoreSystemBars(activity)
  }

  companion object {
    /**
     * 同一个恢复逻辑，供 [MainActivity] 尚未安装它的 client 时调用。
     * chrome client 在 `webView.post {}` 块里赋值，早到的 onResume
     * 可能在它仍为 null 时运行。
     */
    fun restoreSystemBars(activity: Activity) {
      val controller = WindowCompat.getInsetsController(activity.window, activity.window.decorView)
      controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_DEFAULT
      controller.show(WindowInsetsCompat.Type.systemBars())
      // 显示系统栏的同时重放应用主题图标外观：Android 可能在系统中断
      // 全屏、Activity 重建等路径后不再保留之前的外观设置。
      RliveSystemBars.reapply(activity)
    }
  }

  override fun getDefaultVideoPoster(): Bitmap? = delegate.defaultVideoPoster

  override fun getVideoLoadingProgressView(): View? = delegate.videoLoadingProgressView

  override fun getVisitedHistory(callback: ValueCallback<Array<String>>) {
    delegate.getVisitedHistory(callback)
  }

  override fun onCloseWindow(window: WebView) {
    delegate.onCloseWindow(window)
  }

  override fun onConsoleMessage(consoleMessage: ConsoleMessage): Boolean =
    delegate.onConsoleMessage(consoleMessage)

  @Suppress("DEPRECATION")
  override fun onConsoleMessage(message: String, lineNumber: Int, sourceId: String) {
    delegate.onConsoleMessage(message, lineNumber, sourceId)
  }

  override fun onCreateWindow(
    view: WebView,
    isDialog: Boolean,
    isUserGesture: Boolean,
    resultMsg: Message,
  ): Boolean = delegate.onCreateWindow(view, isDialog, isUserGesture, resultMsg)

  override fun onExceededDatabaseQuota(
    url: String,
    databaseIdentifier: String,
    quota: Long,
    estimatedDatabaseSize: Long,
    totalQuota: Long,
    quotaUpdater: WebStorage.QuotaUpdater,
  ) {
    delegate.onExceededDatabaseQuota(
      url,
      databaseIdentifier,
      quota,
      estimatedDatabaseSize,
      totalQuota,
      quotaUpdater,
    )
  }

  override fun onGeolocationPermissionsHidePrompt() {
    delegate.onGeolocationPermissionsHidePrompt()
  }

  override fun onGeolocationPermissionsShowPrompt(
    origin: String,
    callback: GeolocationPermissions.Callback,
  ) {
    delegate.onGeolocationPermissionsShowPrompt(origin, callback)
  }

  override fun onJsAlert(
    view: WebView,
    url: String,
    message: String,
    result: JsResult,
  ): Boolean = delegate.onJsAlert(view, url, message, result)

  override fun onJsBeforeUnload(
    view: WebView,
    url: String,
    message: String,
    result: JsResult,
  ): Boolean = delegate.onJsBeforeUnload(view, url, message, result)

  override fun onJsConfirm(
    view: WebView,
    url: String,
    message: String,
    result: JsResult,
  ): Boolean = delegate.onJsConfirm(view, url, message, result)

  override fun onJsPrompt(
    view: WebView,
    url: String,
    message: String,
    defaultValue: String,
    result: JsPromptResult,
  ): Boolean = delegate.onJsPrompt(view, url, message, defaultValue, result)

  override fun onJsTimeout(): Boolean = delegate.onJsTimeout()

  override fun onPermissionRequest(request: PermissionRequest) {
    delegate.onPermissionRequest(request)
  }

  override fun onPermissionRequestCanceled(request: PermissionRequest) {
    delegate.onPermissionRequestCanceled(request)
  }

  override fun onProgressChanged(view: WebView, newProgress: Int) {
    delegate.onProgressChanged(view, newProgress)
  }

  override fun onReceivedIcon(view: WebView, icon: Bitmap) {
    delegate.onReceivedIcon(view, icon)
  }

  override fun onReceivedTitle(view: WebView, title: String) {
    delegate.onReceivedTitle(view, title)
  }

  override fun onReceivedTouchIconUrl(view: WebView, url: String, precomposed: Boolean) {
    delegate.onReceivedTouchIconUrl(view, url, precomposed)
  }

  override fun onRequestFocus(view: WebView) {
    delegate.onRequestFocus(view)
  }

  override fun onShowFileChooser(
    webView: WebView,
    filePathCallback: ValueCallback<Array<android.net.Uri?>?>,
    fileChooserParams: FileChooserParams,
  ): Boolean = delegate.onShowFileChooser(webView, filePathCallback, fileChooserParams)
}
