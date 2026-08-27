package com.shenss.rlive

import android.os.Build
import android.os.Bundle
import android.view.Display
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import kotlin.math.abs

class MainActivity : TauriActivity() {
  private lateinit var fallbackChromeClient: RustWebChromeClient
  private var fullscreenChromeClient: RliveFullscreenWebChromeClient? = null
  private var fullscreenBackCallback: OnBackPressedCallback? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    enableEdgeToEdge()

    // The immersive flag is static, so an Activity recreation would carry it
    // across while the reloaded page starts windowed. Clear it here or onResume
    // would keep the bars hidden under a windowed room.
    RlivePlayerControlsPlugin.forgetImmersive()

    // Android 7.0/7.1 cannot expose WebView's currently installed Chrome
    // client. Keep an equivalent Tauri client ready for those devices.
    fallbackChromeClient = RustWebChromeClient(this)
  }

  override fun onResume() {
    super.onResume()
    requestHighRefreshRate()
    restoreSystemBarsUnlessFullscreen()
  }

  /**
   * A player brightness gesture is an Activity window override scoped to the
   * room the user is in. Releasing it here means backgrounding rLive — or a
   * process death that never runs the player's own teardown — always leaves
   * the screen back on the user's system brightness.
   */
  override fun onPause() {
    RlivePlayerControlsPlugin.restoreBrightnessOverride()
    super.onPause()
  }

  /**
   * Video fullscreen and the in-page player fullscreen are the only paths that
   * hide the system bars, and both restore them on exit. Returning to the
   * foreground in any other state means the bars should be visible — after a
   * process death that dropped the custom view, or after the system interrupted
   * playback mid-fullscreen.
   *
   * Without this the window can stay laid out as if the bars were present while
   * they are not, which collapses every `env(safe-area-inset-*)` to 0 in the
   * WebView.
   */
  private fun restoreSystemBarsUnlessFullscreen() {
    val client = fullscreenChromeClient
    if (client?.isShowingCustomView == true) {
      return
    }
    // The in-page player keeps its fixed layer across a pause/resume, so the
    // bars must stay hidden for it just as they do for a custom view.
    if (RlivePlayerControlsPlugin.isImmersiveActive()) {
      return
    }
    client?.restoreSystemBars() ?: RliveFullscreenWebChromeClient.restoreSystemBars(this)
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    installFullscreenBackHandler()

    // Wry installs its generated RustWebChromeClient immediately after this
    // hook returns. Post our assignment so we preserve it as the delegate and
    // only replace the fullscreen custom-view behaviour that Wry rejects.
    webView.post {
      if (isFinishing || isDestroyed) {
        return@post
      }

      val delegate = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        webView.webChromeClient ?: fallbackChromeClient
      } else {
        fallbackChromeClient
      }
      fullscreenChromeClient = RliveFullscreenWebChromeClient(this, delegate)
      webView.webChromeClient = fullscreenChromeClient
    }
  }

  private fun installFullscreenBackHandler() {
    if (fullscreenBackCallback != null) {
      return
    }

    fullscreenBackCallback = object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        if (fullscreenChromeClient?.exitFullscreen() == true) {
          return
        }

        // Let the normal activity dispatcher handle Back outside video
        // fullscreen (including Tauri's plugin callbacks).
        isEnabled = false
        onBackPressedDispatcher.onBackPressed()
        isEnabled = true
      }
    }.also { callback ->
      onBackPressedDispatcher.addCallback(this, callback)
    }
  }

  /**
   * Ask Android for the best animation mode the panel exposes, without changing
   * its physical resolution. This remains a preference: power saving, thermal
   * throttling and device-specific variable-refresh policies may override it.
   */
  private fun requestHighRefreshRate() {
    val display = activityDisplay() ?: return
    val currentMode = display.mode
    val compatibleModes = display.supportedModes.filter { mode ->
      mode.physicalWidth == currentMode.physicalWidth &&
        mode.physicalHeight == currentMode.physicalHeight
    }
    val preferredRate = preferredAnimationRefreshRate(compatibleModes.map { it.refreshRate })
      ?: return
    val preferredMode = compatibleModes.minByOrNull { mode ->
      abs(mode.refreshRate - preferredRate)
    } ?: return
    val attributes = window.attributes
    if (
      attributes.preferredDisplayModeId == preferredMode.modeId &&
      abs(attributes.preferredRefreshRate - preferredMode.refreshRate) < 0.01f
    ) {
      return
    }

    attributes.preferredDisplayModeId = preferredMode.modeId
    attributes.preferredRefreshRate = preferredMode.refreshRate
    window.attributes = attributes
  }

  @Suppress("DEPRECATION")
  private fun activityDisplay(): Display? {
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      display
    } else {
      windowManager.defaultDisplay
    }
  }
}
