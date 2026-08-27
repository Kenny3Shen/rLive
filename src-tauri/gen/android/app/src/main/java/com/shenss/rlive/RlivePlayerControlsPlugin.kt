package com.shenss.rlive

import android.app.Activity
import android.content.Context
import android.content.pm.ActivityInfo
import android.media.AudioManager
import android.os.Build
import android.provider.Settings
import android.view.WindowManager
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import kotlin.math.roundToInt

/** 亮度与媒体音量 setter 共用的参数。 */
@InvokeArg
class PlayerControlValueArgs {
  var value: Double = 0.0
}

/** 请求的播放器方向：全屏时 "landscape"，退出时 "auto"。 */
@InvokeArg
class PlayerOrientationArgs {
  var orientation: String = "auto"
}

/** 播放器是否需要隐藏系统栏以获得沉浸表面。 */
@InvokeArg
class PlayerImmersiveArgs {
  var immersive: Boolean = false
}

/**
 * 仅 Android 的播放器系统控制。
 *
 * WebView 调不了设备屏幕亮度，必须原生实现。它以 Activity 窗口覆盖的
 * 方式应用——只影响 rLive，绝不写 `Settings.System`——播放器离开或
 * Activity 退后台时恢复，房间内的手势不会活过这个房间。
 *
 * 音量在这里经 Android 的 `STREAM_MUSIC` 处理，与设备硬件音量键和媒体
 * 输出一致。它刻意是系统级控制：改动在离开房间后保留，和按一次硬件
 * 音量键一样。
 */
@TauriPlugin
class RlivePlayerControlsPlugin(private val activity: Activity) : Plugin(activity) {
  private val audioManager: AudioManager
    get() = activity.getSystemService(Context.AUDIO_SERVICE) as AudioManager

  /** 首次播放器手势覆盖前的窗口亮度。 */
  private var brightnessBeforePlayer: Float? = null

  init {
    activeInstance = this
  }

  companion object {
    /**
     * Activity 经 Tauri 拿不到插件实例，而 rLive 在后台时仍保持播放器亮度
     * 的话，返回时其他应用眼中的这个窗口会被压暗，还可能活过进程死亡。
     * [MainActivity.onPause] 调用它，保证覆盖总会被释放。
     */
    private var activeInstance: RlivePlayerControlsPlugin? = null

    /**
     * 页面内全屏播放器当前是否持有系统栏。
     *
     * 放在 companion 而不是实例上，`MainActivity` 无需插件句柄即可读取：
     * `onResume` 不能在仍处于全屏的播放器下恢复系统栏。Back 刻意不经由
     * 它路由——见 [MainActivity] 的 Back 处理器。
     */
    private var immersive: Boolean = false

    fun isImmersiveActive(): Boolean = immersive

    fun restoreBrightnessOverride() {
      val instance = activeInstance ?: return
      instance.activity.runOnUiThread { instance.restoreBrightness() }
    }

    /**
     * 只丢弃沉浸标志，不碰窗口。
     *
     * Activity 重建保留这份静态状态但会重新加载页面，恢复出的播放器以
     * 窗口模式启动。在 create 时清标志，避免陈旧的「仍在全屏」让系统栏
     * 在窗口模式的房间下保持隐藏（见 [MainActivity]）。
     */
    fun forgetImmersive() {
      immersive = false
    }
  }

  @Command
  fun getState(invoke: Invoke) {
    activity.runOnUiThread {
      try {
        invoke.resolve(state())
      } catch (error: Exception) {
        invoke.reject(error.message ?: "读取播放器系统控制状态失败")
      }
    }
  }

  @Command
  fun setMediaVolume(invoke: Invoke) {
    val args = invoke.parseArgs(PlayerControlValueArgs::class.java)
    activity.runOnUiThread {
      try {
        val maxVolume = audioManager.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
        if (maxVolume <= 0) {
          invoke.reject("当前设备没有可调节的媒体音量")
          return@runOnUiThread
        }
        val percent = clampPercent(args.value)
        val streamVolume = (maxVolume * percent / 100.0).roundToInt()
        // 指针移动的每次更新都不要播放音量提示音或振动。
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
          AudioManager.FLAG_REMOVE_SOUND_AND_VIBRATE
        } else {
          0
        }
        audioManager.setStreamVolume(AudioManager.STREAM_MUSIC, streamVolume, flags)
        invoke.resolve(controlValue(mediaVolumePercent()))
      } catch (error: Exception) {
        invoke.reject(error.message ?: "设置媒体音量失败")
      }
    }
  }

  @Command
  fun setBrightness(invoke: Invoke) {
    val args = invoke.parseArgs(PlayerControlValueArgs::class.java)
    activity.runOnUiThread {
      try {
        val percent = clampPercent(args.value)
        rememberBrightnessBeforeOverride()
        // 这是 Activity 覆盖，不是写 Settings.System。
        // 只影响 rLive，播放器卸载时恢复。
        setWindowBrightness((percent / 100.0).toFloat())
        invoke.resolve(controlValue(brightnessPercent()))
      } catch (error: Exception) {
        invoke.reject(error.message ?: "设置应用亮度失败")
      }
    }
  }

  /**
   * 恢复首次手势覆盖前记录的 Activity 亮度。
   * 未做过覆盖时调用也安全。
   */
  @Command
  fun resetBrightness(invoke: Invoke) {
    activity.runOnUiThread {
      try {
        restoreBrightness()
        invoke.resolve(JSObject())
      } catch (error: Exception) {
        invoke.reject(error.message ?: "恢复应用亮度失败")
      }
    }
  }

  /** 撤掉手势覆盖，回到播放器前的窗口亮度。 */
  private fun restoreBrightness() {
    brightnessBeforePlayer?.let(::setWindowBrightness)
    brightnessBeforePlayer = null
  }

  /**
   * 为全屏播放锁定或释放 Activity 方向。
   *
   * WebView 自己的 `requestedOrientation` 提示被刻意忽略（见
   * [RliveFullscreenWebChromeClient]），因为很多房间推的是竖屏视频。
   * 播放器改为按真实画面宽高比判断，只在横屏确有帮助时才请求锁定，
   * 竖向画面永不会被转成侧躺。`SENSOR_LANDSCAPE` 保留两个横屏方向
   * 可用，"auto" 恢复用户的系统旋转偏好。
   */
  @Command
  fun setPlayerOrientation(invoke: Invoke) {
    val args = invoke.parseArgs(PlayerOrientationArgs::class.java)
    activity.runOnUiThread {
      try {
        activity.requestedOrientation = requestedOrientationFor(args.orientation)
        invoke.resolve(JSObject().apply { put("orientation", args.orientation) })
      } catch (error: Exception) {
        invoke.reject(error.message ?: "切换播放方向失败")
      }
    }
  }

  private fun requestedOrientationFor(orientation: String): Int = when (orientation) {
    "landscape" -> ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
    "portrait" -> ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
    // 其余取值释放锁定，不猜测方向。
    else -> ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
  }

  /**
   * 为页面内全屏播放器隐藏或恢复系统栏。
   *
   * rLive 在 Android 上刻意不用 WebView 的 HTML Fullscreen API。
   * `WebChromeClient.onShowCustomView` 会把渲染内容重挂到一个全新的
   * View，这次表面交接在新 View 画出第一帧前会出现数个全黑帧——也就是
   * 用户看到的闪烁。播放器因此以页面内 fixed 层铺满屏幕（与桌面同一
   * 层），再经这里单独请求沉浸系统栏，渲染表面从不被交接。
   *
   * custom view 既然不存在了，这就是隐藏系统栏的唯一路径。状态记在
   * companion 里，`MainActivity.onResume` 便能为仍处于全屏的播放器
   * 保持隐藏。
   */
  @Command
  fun setImmersive(invoke: Invoke) {
    val args = invoke.parseArgs(PlayerImmersiveArgs::class.java)
    activity.runOnUiThread {
      try {
        applyImmersive(args.immersive)
        invoke.resolve(JSObject().apply { put("immersive", args.immersive) })
      } catch (error: Exception) {
        invoke.reject(error.message ?: "切换全屏显示失败")
      }
    }
  }

  private fun applyImmersive(wantsImmersive: Boolean) {
    immersive = wantsImmersive
    if (wantsImmersive) {
      val controller =
        WindowCompat.getInsetsController(activity.window, activity.window.decorView)
      controller.systemBarsBehavior =
        WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
      controller.hide(WindowInsetsCompat.Type.systemBars())
    } else {
      // 与视频 custom-view 路径共用，两条退出路径都同时重置
      // behavior 与可见性（见那个方法的注释）。
      RliveFullscreenWebChromeClient.restoreSystemBars(activity)
    }
  }

  private fun state(): JSObject = JSObject().apply {
    put("mediaVolume", mediaVolumePercent())
    put("brightness", brightnessPercent())
  }

  private fun controlValue(value: Double): JSObject = JSObject().apply {
    put("value", value)
  }

  private fun mediaVolumePercent(): Double {
    val maxVolume = audioManager.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
    if (maxVolume <= 0) return 0.0
    return clampPercent(
      audioManager.getStreamVolume(AudioManager.STREAM_MUSIC).toDouble() * 100.0 / maxVolume,
    )
  }

  private fun brightnessPercent(): Double {
    val override = activity.window.attributes.screenBrightness
    if (override != WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE) {
      return clampPercent(override.toDouble() * 100.0)
    }

    // 读取用户当前亮度是允许的；不需要写入，因为本插件刻意把改动
    // 保持为应用内。
    val systemBrightness = try {
      Settings.System.getInt(
        activity.contentResolver,
        Settings.System.SCREEN_BRIGHTNESS,
        128,
      )
    } catch (_: SecurityException) {
      128
    }
    return clampPercent(systemBrightness.toDouble() * 100.0 / 255.0)
  }

  private fun rememberBrightnessBeforeOverride() {
    if (brightnessBeforePlayer != null) return
    brightnessBeforePlayer = activity.window.attributes.screenBrightness
  }

  private fun setWindowBrightness(brightness: Float) {
    val attributes = activity.window.attributes
    attributes.screenBrightness = brightness
    activity.window.attributes = attributes
  }

  private fun clampPercent(value: Double): Double = value.coerceIn(0.0, 100.0)
}
