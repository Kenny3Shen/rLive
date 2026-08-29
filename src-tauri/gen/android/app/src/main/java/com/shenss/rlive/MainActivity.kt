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

    // 视频全屏的 custom view 不会在重建后保留，静态覆盖标志同理要清掉。
    RliveSystemBars.forgetVideoFullscreen()
    // 上次会话的应用主题决定系统栏图标外观；否则冷启动首帧沿用
    // enableEdgeToEdge() 按 **系统** night mode 的判定，页面加载后再纠正
    // 会闪一次反色。「系统浅色 + 应用深色」正是这次修复的看不清场景。
    RliveSystemBars.restoreFromPreferences(this)

    // 沉浸标志是静态的，Activity 重建会把它带过来，而重新加载的页面
    // 以窗口模式启动。这里先清掉，否则 onResume 会让系统栏在窗口模式的
    // 房间下保持隐藏。
    RlivePlayerControlsPlugin.forgetImmersive()

    // Android 7.0/7.1 拿不到 WebView 当前已安装的 Chrome client。
    // 为这类设备备一个等价的 Tauri client。
    fallbackChromeClient = RustWebChromeClient(this)
  }

  override fun onResume() {
    super.onResume()
    restoreSystemBarsUnlessFullscreen()
  }

  /**
   * 播放器亮度手势是作用域限定在当前房间的 Activity 窗口覆盖。在这里
   * 释放，意味着 rLive 退到后台——或进程死亡导致播放器自身的清理永远
   * 不运行——屏幕都会回到用户的系统亮度。
   */
  override fun onPause() {
    RlivePlayerControlsPlugin.restoreBrightnessOverride()
    super.onPause()
  }

  /**
   * 视频全屏与页面内播放器全屏是仅有的两条隐藏系统栏的路径，退出时都会
   * 恢复。其余状态回到前台都意味着系统栏应当可见——无论是进程死亡丢掉了
   * custom view，还是系统在全屏播放中途打断。
   *
   * 不这样的话，窗口可能保持按系统栏存在的方式布局而实际不存在，WebView
   * 里所有 `env(safe-area-inset-*)` 都会塌缩为 0。
   */
  private fun restoreSystemBarsUnlessFullscreen() {
    val client = fullscreenChromeClient
    if (client?.isShowingCustomView == true) {
      return
    }
    // 页面内播放器在 pause/resume 之间保持它的 fixed 层，系统栏对它
    // 必须像对 custom view 一样保持隐藏。
    if (RlivePlayerControlsPlugin.isImmersiveActive()) {
      return
    }
    client?.restoreSystemBars() ?: RliveFullscreenWebChromeClient.restoreSystemBars(this)
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    // WebView 预绘制帧的底色跟随应用主题，避免启动窗口与页面首帧之间
    // 插入一帧白闪（见 RliveSystemBars.applyWebViewBackground）。
    RliveSystemBars.applyWebViewBackground(this, webView)
    installFullscreenBackHandler()

    // Wry 在本钩子返回后立刻安装它生成的 RustWebChromeClient。把我们的
    // 赋值 post 出去，才能保留它作为 delegate，只替换 Wry 拒绝处理的
    // 全屏 custom-view 行为。
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

        // 视频全屏之外的返回交给 Activity 常规分发继续处理
        // （包括 Tauri 的插件回调）。
        isEnabled = false
        onBackPressedDispatcher.onBackPressed()
        isEnabled = true
      }
    }.also { callback ->
      onBackPressedDispatcher.addCallback(this, callback)
    }
  }
}
