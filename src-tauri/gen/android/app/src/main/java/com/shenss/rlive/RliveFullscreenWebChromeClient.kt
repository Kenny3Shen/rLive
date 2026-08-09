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
 * Keeps Tauri's WebChromeClient behaviour while handling the Android WebView
 * custom view used by HTML video fullscreen. Wry's generated client declines
 * custom views, which makes the browser Fullscreen API fail on Android.
 *
 * Orientation is intentionally left alone: portrait live streams must not be
 * forced into landscape (Simple Live only locks landscape for non-portrait
 * content). Immersive system bars still apply for a true fullscreen surface.
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
    // Ignore WebView's requestedOrientation: many live rooms are portrait, and
    // forcing landscape turns vertical streams on their side.
    onShowCustomView(view, callback)
  }

  override fun onHideCustomView() {
    if (dismissCustomView()) {
      delegate.onHideCustomView()
    }
  }

  /** Returns true when Android video fullscreen consumed the back action. */
  fun exitFullscreen(): Boolean {
    if (customView == null) {
      return false
    }

    // Chromium normally calls onHideCustomView synchronously from this callback.
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

    restoreSystemBars()
    return true
  }

  /**
   * Brings the system bars back unconditionally.
   *
   * An earlier version snapshotted `isVisible(systemBars())` before hiding and
   * only restored when that snapshot was true. That self-destructs: the
   * restored bars are still under BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE, so
   * Android auto-hides them again shortly after. The next fullscreen entry then
   * samples an already-hidden state, records "was hidden", and skips the
   * restore forever after.
   *
   * The Activity runs edge-to-edge and has no path other than video fullscreen
   * that hides the bars, so there is no legitimate hidden state to preserve.
   * Resetting the behaviour first also matters: leaving it on TRANSIENT means
   * the bars we just showed would fade out on their own.
   */
  fun restoreSystemBars() {
    restoreSystemBars(activity)
  }

  companion object {
    /**
     * Same restore, reachable before [MainActivity] has installed its client.
     * The chrome client is assigned from a `webView.post {}` block, so an early
     * `onResume` can run while it is still null.
     */
    fun restoreSystemBars(activity: Activity) {
      val controller = WindowCompat.getInsetsController(activity.window, activity.window.decorView)
      controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_DEFAULT
      controller.show(WindowInsetsCompat.Type.systemBars())
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
