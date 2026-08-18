import { describe, expect, test } from "bun:test";
import {
  FFMPEG_HLS_SEGMENT_RETRY_COUNT_DEFAULT,
  FFMPEG_HLS_SEGMENT_RETRY_COUNT_MAX,
  FFMPEG_HLS_SEGMENT_RETRY_COUNT_MIN,
  FFMPEG_RECONNECT_DELAY_MAX_SECONDS_DEFAULT,
  FFMPEG_RECONNECT_DELAY_MAX_SECONDS_MAX,
  FFMPEG_RECONNECT_DELAY_MAX_SECONDS_MIN,
  FFMPEG_RW_TIMEOUT_SECONDS_DEFAULT,
  FFMPEG_RW_TIMEOUT_SECONDS_MAX,
  FFMPEG_RW_TIMEOUT_SECONDS_MIN,
  RECORDING_AUTO_SPLIT_MINUTES_DEFAULT,
  RECORDING_AUTO_SPLIT_MINUTES_MAX,
  parseFfmpegHlsSegmentRetryCount,
  parseFfmpegReconnectDelayMaxSeconds,
  parseFfmpegRwTimeoutSeconds,
  parseRecordingAutoSplitMinutes,
  recordingPreferencesFromAppSettings,
} from "../src/shared/stores/settingsStore";
import { createAppDataStorageApi } from "../src/features/settings/appDataStorage";

describe("FFmpeg recording settings", () => {
  test("clamps the read/write timeout and falls back to ten seconds", () => {
    expect(parseFfmpegRwTimeoutSeconds(FFMPEG_RW_TIMEOUT_SECONDS_MIN - 1)).toBe(
      FFMPEG_RW_TIMEOUT_SECONDS_MIN,
    );
    expect(parseFfmpegRwTimeoutSeconds(FFMPEG_RW_TIMEOUT_SECONDS_MAX + 1)).toBe(
      FFMPEG_RW_TIMEOUT_SECONDS_MAX,
    );
    expect(parseFfmpegRwTimeoutSeconds(undefined)).toBe(FFMPEG_RW_TIMEOUT_SECONDS_DEFAULT);
  });

  test("clamps the reconnect delay and falls back to eight seconds", () => {
    expect(parseFfmpegReconnectDelayMaxSeconds(FFMPEG_RECONNECT_DELAY_MAX_SECONDS_MIN - 1)).toBe(
      FFMPEG_RECONNECT_DELAY_MAX_SECONDS_MIN,
    );
    expect(parseFfmpegReconnectDelayMaxSeconds(FFMPEG_RECONNECT_DELAY_MAX_SECONDS_MAX + 1)).toBe(
      FFMPEG_RECONNECT_DELAY_MAX_SECONDS_MAX,
    );
    expect(parseFfmpegReconnectDelayMaxSeconds(Number.NaN)).toBe(
      FFMPEG_RECONNECT_DELAY_MAX_SECONDS_DEFAULT,
    );
  });

  test("keeps zero HLS retries and clamps the upper boundary", () => {
    expect(parseFfmpegHlsSegmentRetryCount(FFMPEG_HLS_SEGMENT_RETRY_COUNT_MIN)).toBe(0);
    expect(parseFfmpegHlsSegmentRetryCount(FFMPEG_HLS_SEGMENT_RETRY_COUNT_MAX + 1)).toBe(
      FFMPEG_HLS_SEGMENT_RETRY_COUNT_MAX,
    );
    expect(parseFfmpegHlsSegmentRetryCount(null)).toBe(FFMPEG_HLS_SEGMENT_RETRY_COUNT_DEFAULT);
  });

  test("keeps zero as auto-split off and caps each bundle at one day", () => {
    expect(parseRecordingAutoSplitMinutes(0)).toBe(0);
    expect(parseRecordingAutoSplitMinutes(RECORDING_AUTO_SPLIT_MINUTES_MAX + 1)).toBe(
      RECORDING_AUTO_SPLIT_MINUTES_MAX,
    );
    expect(parseRecordingAutoSplitMinutes(undefined)).toBe(RECORDING_AUTO_SPLIT_MINUTES_DEFAULT);
  });

  test("maps backend recording defaults into the frontend preference shape", () => {
    expect(
      recordingPreferencesFromAppSettings({
        recording_include_danmaku: true,
        recording_continue_after_leave: true,
        recording_auto_split_minutes: 90,
        ffmpeg_rw_timeout_seconds: 18,
        ffmpeg_reconnect_delay_max_seconds: 12,
        ffmpeg_hls_segment_retry_count: 7,
      }),
    ).toEqual({
      recordingIncludeDanmaku: true,
      recordingContinueAfterLeave: true,
      recordingAutoSplitMinutes: 90,
      ffmpegRwTimeoutSeconds: 18,
      ffmpegReconnectDelayMaxSeconds: 12,
      ffmpegHlsSegmentRetryCount: 7,
    });
  });
});

describe("application data storage IPC", () => {
  test("uses the desktop commands and preserves their camelCase response", async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const response = {
      path: "D:\\rLive-data",
      currentPath: "C:\\rLive-data",
      defaultPath: "C:\\Program Files\\rLive",
      isDefault: false,
      restartRequired: true,
    };
    const api = createAppDataStorageApi(
      async <T>(command: string, args?: Record<string, unknown>) => {
        calls.push({ command, args });
        return response as T;
      },
    );

    expect(await api.info()).toEqual(response);
    expect(await api.setPath("D:\\rLive-data")).toEqual(response);
    expect(await api.setPath(null)).toEqual(response);
    expect(calls).toEqual([
      { command: "app_data_storage_info", args: undefined },
      { command: "app_data_set_storage_path", args: { path: "D:\\rLive-data" } },
      { command: "app_data_set_storage_path", args: { path: null } },
    ]);
  });
});
