package com.shenss.rlive

import android.os.Build
import android.os.Bundle
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  private lateinit var fallbackChromeClient: RustWebChromeClient
  private var fullscreenChromeClient: RliveFullscreenWebChromeClient? = null
  private var fullscreenBackCallback: OnBackPressedCallback? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    enableEdgeToEdge()

    // Android 7.0/7.1 cannot expose WebView's currently installed Chrome
    // client. Keep an equivalent Tauri client ready for those devices.
    fallbackChromeClient = RustWebChromeClient(this)
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
}
