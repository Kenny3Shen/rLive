package com.shenss.rlive

import android.content.pm.ActivityInfo
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
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

/**
 * Keeps Tauri's WebChromeClient behaviour while handling the Android WebView
 * custom view used by HTML video fullscreen. Wry's generated client declines
 * custom views, which makes the browser Fullscreen API fail on Android.
 */
@Suppress("DEPRECATION")
class RliveFullscreenWebChromeClient(
  private val activity: MainActivity,
  private val delegate: WebChromeClient,
) : WebChromeClient() {
  private var customView: View? = null
  private var customViewCallback: CustomViewCallback? = null
  private var fullscreenContainer: FrameLayout? = null
  private var restoreVisibleSystemBars = true
  private var previousSystemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_DEFAULT
  private var previousRequestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
  private var hasLockedLandscapeOrientation = false

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
    lockLandscapeOrientation()
    enterImmersiveMode()
  }

  @Suppress("DEPRECATION")
  override fun onShowCustomView(
    view: View,
    requestedOrientation: Int,
    callback: CustomViewCallback,
  ) {
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
    val decorView = activity.window.decorView
    val controller = WindowCompat.getInsetsController(activity.window, decorView)
    previousSystemBarsBehavior = controller.systemBarsBehavior
    restoreVisibleSystemBars = ViewCompat.getRootWindowInsets(decorView)
      ?.isVisible(WindowInsetsCompat.Type.systemBars()) ?: true
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
    restoreRequestedOrientation()

    val decorView = activity.window.decorView
    val controller = WindowCompat.getInsetsController(activity.window, decorView)
    controller.systemBarsBehavior = previousSystemBarsBehavior
    if (restoreVisibleSystemBars) {
      controller.show(WindowInsetsCompat.Type.systemBars())
    }
    return true
  }

  /**
   * WebView reports a custom fullscreen view without consistently requesting
   * an orientation itself. A live video fullscreen action should work without
   * requiring the user to first enable system auto-rotate, while still
   * allowing both normal and reverse landscape orientations.
   */
  private fun lockLandscapeOrientation() {
    if (hasLockedLandscapeOrientation) {
      return
    }

    val previousOrientation = activity.requestedOrientation
    try {
      activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
      previousRequestedOrientation = previousOrientation
      hasLockedLandscapeOrientation = true
    } catch (_: IllegalStateException) {
      // Android can reject orientation locks for uncommon window modes. The
      // custom fullscreen view remains usable in the device's current layout.
    } catch (_: SecurityException) {
      // Keep fullscreen available if a device policy forbids orientation locks.
    }
  }

  private fun restoreRequestedOrientation() {
    if (!hasLockedLandscapeOrientation) {
      return
    }

    val orientation = previousRequestedOrientation
    hasLockedLandscapeOrientation = false
    previousRequestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
    try {
      activity.requestedOrientation = orientation
    } catch (_: IllegalStateException) {
      // The activity may be finishing; Android will restore it on teardown.
    } catch (_: SecurityException) {
      // Device policy may also reject restoration; avoid trapping Back.
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
