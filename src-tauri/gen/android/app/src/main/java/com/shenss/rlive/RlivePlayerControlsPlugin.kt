package com.shenss.rlive

import android.app.Activity
import android.content.Context
import android.content.pm.ActivityInfo
import android.media.AudioManager
import android.os.Build
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
  var value: Double = 0.0
}

/** Requested player orientation: "landscape" while fullscreen, "auto" on exit. */
@InvokeArg
class PlayerOrientationArgs {
  var orientation: String = "auto"
}

/**
 * Android-only player system controls.
 *
 * The WebView cannot dim the device screen, so brightness has to be native.
 * It is applied as an Activity window override — rLive only, never a write to
 * `Settings.System` — and is restored when the player leaves or the Activity
 * is backgrounded, so a gesture inside a room never outlives that room.
 *
 * Volume is handled here through Android's `STREAM_MUSIC`, matching the
 * device's hardware volume keys and media output. It is intentionally a
 * system-level control: changing it persists after leaving the room just as a
 * hardware volume-key press does.
 */
@TauriPlugin
class RlivePlayerControlsPlugin(private val activity: Activity) : Plugin(activity) {
  private val audioManager: AudioManager
    get() = activity.getSystemService(Context.AUDIO_SERVICE) as AudioManager

  /** Prior window brightness before the first player gesture override. */
  private var brightnessBeforePlayer: Float? = null

  init {
    activeInstance = this
  }

  companion object {
    /**
     * The Activity cannot reach the plugin through Tauri, but leaving the
     * player brightness applied while rLive is in the background would dim
     * other apps' idea of this window on return and survive a process death.
     * [MainActivity.onPause] calls this so the override is always released.
     */
    private var activeInstance: RlivePlayerControlsPlugin? = null

    fun restoreBrightnessOverride() {
      val instance = activeInstance ?: return
      instance.activity.runOnUiThread { instance.restoreBrightness() }
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
        // Do not play a volume tick or vibrate on every pointer-move update.
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
        // This is an Activity override, not a write to Settings.System. It
        // affects rLive only and is restored when the player unmounts.
        setWindowBrightness((percent / 100.0).toFloat())
        invoke.resolve(controlValue(brightnessPercent()))
      } catch (error: Exception) {
        invoke.reject(error.message ?: "设置应用亮度失败")
      }
    }
  }

  /**
   * Restores the Activity brightness captured before the first gesture override.
   * Safe to call when no override was made.
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

  /** Drops the gesture override back to the pre-player window brightness. */
  private fun restoreBrightness() {
    brightnessBeforePlayer?.let(::setWindowBrightness)
    brightnessBeforePlayer = null
  }

  /**
   * Locks or releases the Activity orientation for fullscreen playback.
   *
   * The WebView's own `requestedOrientation` hint is ignored on purpose (see
   * [RliveFullscreenWebChromeClient]) because many rooms stream portrait video.
   * The player decides from the real video aspect ratio instead and asks for a
   * lock only when landscape actually helps, so vertical streams are never
   * turned on their side. `SENSOR_LANDSCAPE` keeps both landscape directions
   * usable, and "auto" restores the user's system rotation preference.
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
    // Anything else releases the lock rather than guessing a direction.
    else -> ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
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
