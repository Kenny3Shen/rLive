package com.shenss.rlive

import android.app.Activity
import android.content.Intent
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMuxer
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import java.io.File
import java.nio.ByteBuffer

/** 两条完整 fMP4 轨与目标 MP4 的绝对路径。 */
@InvokeArg
class VideoMuxArgs {
  lateinit var videoPath: String
  lateinit var audioPath: String
  lateinit var outputPath: String
}

/** 用系统播放器打开的成片路径。 */
@InvokeArg
class VideoOpenArgs {
  lateinit var path: String
}

/**
 * Android 端视频下载的收尾桥。
 *
 * rLive 的 Android 构建没有链接 FFmpeg，因此不把音视频轨交给 libavformat；
 * [MediaExtractor] 读取 B 站已经下载好的两条 fMP4 轨，[MediaMuxer] 写成
 * 渐进式 MP4。这里只做容器重封装，不解码也不转码，画质与在线播放一致。
 *
 * 成片位于应用私有目录，`file://` 不能直接交给外部播放器，打开时经
 * [FileProvider] 换成 `content://`。
 */
@TauriPlugin
class RliveVideoMuxPlugin(private val activity: Activity) : Plugin(activity) {
  @Command
  fun mux(invoke: Invoke) {
    val args = invoke.parseArgs(VideoMuxArgs::class.java)
    Thread({
      try {
        muxFiles(args.videoPath, args.audioPath, args.outputPath)
        invoke.resolve()
      } catch (error: Exception) {
        invoke.reject(error.message ?: "合并音视频失败")
      }
    }, "rlive-video-mux").start()
  }

  @Command
  fun openFile(invoke: Invoke) {
    val args = invoke.parseArgs(VideoOpenArgs::class.java)
    activity.runOnUiThread {
      try {
        val file = File(args.path)
        if (!file.isFile) {
          invoke.reject("下载文件已被移动或删除")
          return@runOnUiThread
        }
        val uri = FileProvider.getUriForFile(
          activity,
          "${activity.packageName}.fileprovider",
          file,
        )
        val intent = Intent(Intent.ACTION_VIEW).apply {
          setDataAndType(uri, "video/mp4")
          addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
          addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        activity.startActivity(intent)
        invoke.resolve()
      } catch (error: Exception) {
        invoke.reject(error.message ?: "没有可打开 MP4 的应用")
      }
    }
  }

  private fun muxFiles(videoPath: String, audioPath: String, outputPath: String) {
    val videoExtractor = MediaExtractor()
    val audioExtractor = MediaExtractor()
    var muxer: MediaMuxer? = null
    try {
      videoExtractor.setDataSource(videoPath)
      audioExtractor.setDataSource(audioPath)

      val videoTrack = findTrack(videoExtractor, "video/")
        ?: throw IllegalStateException("视频轨中没有视频流")
      val audioTrack = findTrack(audioExtractor, "audio/")
        ?: throw IllegalStateException("音频轨中没有音频流")
      videoExtractor.selectTrack(videoTrack)
      audioExtractor.selectTrack(audioTrack)

      val videoFormat = videoExtractor.getTrackFormat(videoTrack)
      val audioFormat = audioExtractor.getTrackFormat(audioTrack)
      val bufferSize = maxOf(
        inputSize(videoFormat),
        inputSize(audioFormat),
        4 * 1024 * 1024,
      )

      File(outputPath).parentFile?.mkdirs()
      File(outputPath).delete()
      muxer = MediaMuxer(outputPath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
      val videoOut = muxer.addTrack(videoFormat)
      val audioOut = muxer.addTrack(audioFormat)
      muxer.start()

      val videoBuffer = ByteBuffer.allocateDirect(bufferSize)
      val audioBuffer = ByteBuffer.allocateDirect(bufferSize)
      var videoInfo = readSample(videoExtractor, videoBuffer)
      var audioInfo = readSample(audioExtractor, audioBuffer)
      while (videoInfo != null || audioInfo != null) {
        val takeVideo = when {
          videoInfo == null -> false
          audioInfo == null -> true
          else -> videoInfo.presentationTimeUs <= audioInfo.presentationTimeUs
        }
        if (takeVideo) {
          muxer.writeSampleData(videoOut, videoBuffer, videoInfo!!)
          videoInfo = readSample(videoExtractor, videoBuffer)
        } else {
          muxer.writeSampleData(audioOut, audioBuffer, audioInfo!!)
          audioInfo = readSample(audioExtractor, audioBuffer)
        }
      }

      muxer.stop()
    } finally {
      runCatching { muxer?.release() }
      runCatching { videoExtractor.release() }
      runCatching { audioExtractor.release() }
    }
  }

  private fun findTrack(extractor: MediaExtractor, prefix: String): Int? {
    for (index in 0 until extractor.trackCount) {
      val mime = extractor.getTrackFormat(index).getString(MediaFormat.KEY_MIME)
      if (mime != null && mime.startsWith(prefix)) return index
    }
    return null
  }

  private fun inputSize(format: MediaFormat): Int {
    val declared = if (format.containsKey(MediaFormat.KEY_MAX_INPUT_SIZE)) {
      format.getInteger(MediaFormat.KEY_MAX_INPUT_SIZE)
    } else {
      0
    }
    return maxOf(declared, 1 * 1024 * 1024)
  }

  private fun readSample(
    extractor: MediaExtractor,
    buffer: ByteBuffer,
  ): MediaCodec.BufferInfo? {
    buffer.clear()
    val size = extractor.readSampleData(buffer, 0)
    if (size < 0) return null
    val info = MediaCodec.BufferInfo().apply {
      offset = 0
      this.size = size
      presentationTimeUs = extractor.sampleTime
      flags = extractor.sampleFlags
    }
    extractor.advance()
    return info
  }
}
