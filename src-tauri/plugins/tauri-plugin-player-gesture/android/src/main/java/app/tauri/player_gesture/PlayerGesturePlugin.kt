package app.tauri.player_gesture

import android.app.Activity
import android.content.Context
import android.media.AudioManager
import android.provider.Settings
import android.view.WindowManager
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import kotlin.math.roundToInt

@InvokeArg
class PercentageArgs {
  var value: Double = 0.0
}

/**
 * A deliberately narrow bridge for the live player's vertical edge gestures.
 *
 * Brightness is an Activity/window override, not the device-wide setting. The
 * prior override is restored when the player leaves, so rLive never persists a
 * dimmed screen after playback. Volume targets STREAM_MUSIC, the same stream
 * Android uses for live media playback, without opening the system volume UI.
 */
@TauriPlugin
class PlayerGesturePlugin(private val activity: Activity) : Plugin(activity) {
  private val audioManager =
    activity.getSystemService(Context.AUDIO_SERVICE) as AudioManager
  private var brightnessBeforePlayerGesture: Float? = null

  @Command
  fun getState(invoke: Invoke) {
    try {
      invoke.resolve(
        JSObject().apply {
          put("brightness", currentBrightnessPercent())
          put("volume", currentVolumePercent())
        },
      )
    } catch (error: Exception) {
      invoke.reject(error.message ?: "无法读取播放器手势状态")
    }
  }

  @Command
  fun setBrightness(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(PercentageArgs::class.java)
      if (brightnessBeforePlayerGesture == null) {
        brightnessBeforePlayerGesture = activity.window.attributes.screenBrightness
      }

      val brightness = args.value.coerceIn(0.0, 100.0).toFloat() / 100f
      setWindowBrightness(brightness)
      invoke.resolve(JSObject().apply { put("brightness", (brightness * 100).roundToInt()) })
    } catch (error: Exception) {
      invoke.reject(error.message ?: "无法调整应用亮度")
    }
  }

  @Command
  fun setVolume(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(PercentageArgs::class.java)
      val maxVolume = audioManager.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
      if (maxVolume <= 0) {
        invoke.reject("设备不支持媒体音量调节")
        return
      }

      val volume =
        ((args.value.coerceIn(0.0, 100.0) / 100.0) * maxVolume)
          .roundToInt()
          .coerceIn(0, maxVolume)
      // No FLAG_SHOW_UI: the player already presents its own unobtrusive OSD.
      audioManager.setStreamVolume(AudioManager.STREAM_MUSIC, volume, 0)
      invoke.resolve(JSObject().apply { put("volume", currentVolumePercent()) })
    } catch (error: Exception) {
      invoke.reject(error.message ?: "无法调整系统媒体音量")
    }
  }

  @Command
  fun resetBrightness(invoke: Invoke) {
    try {
      brightnessBeforePlayerGesture?.let(::setWindowBrightness)
      brightnessBeforePlayerGesture = null
      invoke.resolve()
    } catch (error: Exception) {
      invoke.reject(error.message ?: "无法恢复应用亮度")
    }
  }

  private fun currentBrightnessPercent(): Int {
    val windowBrightness = activity.window.attributes.screenBrightness
    val brightness =
      if (windowBrightness >= 0f) {
        windowBrightness
      } else {
        // The normal Activity state delegates to the device setting. Reading
        // that value gives a useful starting point before the first override.
        Settings.System.getInt(
          activity.contentResolver,
          Settings.System.SCREEN_BRIGHTNESS,
          DEFAULT_BRIGHTNESS,
        ) / MAX_SYSTEM_BRIGHTNESS.toFloat()
      }
    return (brightness.coerceIn(0f, 1f) * 100).roundToInt()
  }

  private fun currentVolumePercent(): Int {
    val maxVolume = audioManager.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
    if (maxVolume <= 0) return 0
    return (
      audioManager.getStreamVolume(AudioManager.STREAM_MUSIC).toFloat() * 100 / maxVolume
    ).roundToInt()
  }

  private fun setWindowBrightness(brightness: Float) {
    val attributes = activity.window.attributes
    attributes.screenBrightness = brightness.coerceIn(
      WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_OFF,
      WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_FULL,
    )
    activity.window.attributes = attributes
  }

  private companion object {
    const val DEFAULT_BRIGHTNESS = 128
    const val MAX_SYSTEM_BRIGHTNESS = 255
  }
}
