package com.shenss.rlive

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

/** Arguments shared by the brightness and media-volume setters. */
@InvokeArg
class PlayerControlValueArgs {
  var value: Int = 0
}

/**
 * Android-only player controls.
 *
 * WebView can attenuate a <video>, but it cannot control Android's media
 * stream or the Activity brightness. Keeping those operations native gives
 * vertical player gestures the same behaviour users expect from Android live
 * clients while never requesting permission to write the device-wide setting.
 */
@TauriPlugin
class RlivePlayerControlsPlugin(private val activity: Activity) : Plugin(activity) {
  private val audioManager: AudioManager
    get() = activity.getSystemService(Context.AUDIO_SERVICE) as AudioManager

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
        val streamVolume = (maxVolume * percent / 100f).roundToInt()
        // Do not play a volume tick or vibrate on every pointer-move update.
        audioManager.setStreamVolume(
          AudioManager.STREAM_MUSIC,
          streamVolume,
          AudioManager.FLAG_REMOVE_SOUND_AND_VIBRATE,
        )
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
        val attributes = activity.window.attributes
        // This is an Activity override, not a write to Settings.System. It
        // affects rLive only and naturally disappears when the app closes.
        attributes.screenBrightness = percent / 100f
        activity.window.attributes = attributes
        invoke.resolve(controlValue(brightnessPercent()))
      } catch (error: Exception) {
        invoke.reject(error.message ?: "设置应用亮度失败")
      }
    }
  }

  private fun state(): JSObject = JSObject().apply {
    put("mediaVolume", mediaVolumePercent())
    put("brightness", brightnessPercent())
  }

  private fun controlValue(value: Int): JSObject = JSObject().apply {
    put("value", value)
  }

  private fun mediaVolumePercent(): Int {
    val maxVolume = audioManager.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
    if (maxVolume <= 0) return 0
    return clampPercent((audioManager.getStreamVolume(AudioManager.STREAM_MUSIC) * 100f / maxVolume).roundToInt())
  }

  private fun brightnessPercent(): Int {
    val override = activity.window.attributes.screenBrightness
    if (override != WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE) {
      return clampPercent((override * 100f).roundToInt())
    }

    // Reading the user's current brightness is allowed; writing it is not
    // needed because this plugin intentionally keeps changes app-local.
    val systemBrightness = try {
      Settings.System.getInt(
        activity.contentResolver,
        Settings.System.SCREEN_BRIGHTNESS,
        128,
      )
    } catch (_: SecurityException) {
      128
    }
    return clampPercent((systemBrightness * 100f / 255f).roundToInt())
  }

  private fun clampPercent(value: Int): Int = value.coerceIn(0, 100)
}
