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
  RECORDING_ASS_DEFAULT_SETTINGS,
  RECORDING_CONTINUE_AFTER_LEAVE_DEFAULT,
  RECORDING_INCLUDE_DANMAKU_DEFAULT,
  normalizeRecordingAssSettings,
  parseFfmpegHlsSegmentRetryCount,
  parseFfmpegReconnectDelayMaxSeconds,
  parseFfmpegRwTimeoutSeconds,
  parseRecordingAutoSplitMinutes,
  recordingPreferencesFromAppSettings,
} from "../src/shared/stores/settingsStore";
import { resolveRecordingControlOptions } from "../src/features/recording/recording";

describe("FFmpeg recording settings", () => {
  test("includes danmaku by default", () => {
    expect(RECORDING_INCLUDE_DANMAKU_DEFAULT).toBe(true);
  });

  test("follows hydrated recording defaults until a session option is changed", () => {
    expect(
      resolveRecordingControlOptions({ includeDanmaku: false, continueOnLeave: false }),
    ).toEqual({
      includeDanmaku: false,
      continueOnLeave: false,
    });
    expect(resolveRecordingControlOptions({ includeDanmaku: true, continueOnLeave: true })).toEqual(
      {
        includeDanmaku: true,
        continueOnLeave: true,
      },
    );
    expect(
      resolveRecordingControlOptions(
        { includeDanmaku: true, continueOnLeave: true },
        { continueOnLeave: false },
      ),
    ).toEqual({ includeDanmaku: true, continueOnLeave: false });
  });

  test("uses the requested ASS recording defaults", () => {
    expect(RECORDING_ASS_DEFAULT_SETTINGS.font_size).toBe(36);
    expect(RECORDING_ASS_DEFAULT_SETTINGS.display_area_percent).toBe(25);
  });

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

  test("starts a new task with background recording enabled", () => {
    expect(RECORDING_CONTINUE_AFTER_LEAVE_DEFAULT).toBe(true);
    expect(
      resolveRecordingControlOptions({
        includeDanmaku: true,
        continueOnLeave: RECORDING_CONTINUE_AFTER_LEAVE_DEFAULT,
      }).continueOnLeave,
    ).toBe(true);
  });

  test("maps backend recording defaults into the frontend preference shape", () => {
    expect(
      recordingPreferencesFromAppSettings({
        recording_include_danmaku: true,
        recording_auto_split_minutes: 90,
        ffmpeg_rw_timeout_seconds: 18,
        ffmpeg_reconnect_delay_max_seconds: 12,
        ffmpeg_hls_segment_retry_count: 7,
        recording_ass: {
          ...RECORDING_ASS_DEFAULT_SETTINGS,
          resolution_width: 3840,
          resolution_height: 2160,
        },
      }),
    ).toEqual({
      recordingIncludeDanmaku: true,
      recordingAutoSplitMinutes: 90,
      ffmpegRwTimeoutSeconds: 18,
      ffmpegReconnectDelayMaxSeconds: 12,
      ffmpegHlsSegmentRetryCount: 7,
      recordingAssSettings: {
        ...RECORDING_ASS_DEFAULT_SETTINGS,
        resolution_width: 3840,
        resolution_height: 2160,
      },
    });
  });

  test("normalizes ASS layout, style, and shield rules", () => {
    expect(
      normalizeRecordingAssSettings({
        ...RECORDING_ASS_DEFAULT_SETTINGS,
        resolution_width: 1,
        resolution_height: 99_999,
        font_name: " Bad,Font\n",
        font_size: 999,
        opacity_percent: 120,
        outline: 1.74,
        shadow: Number.NaN,
        scroll_duration_seconds: 0,
        display_area_percent: 0,
        merge_window_seconds: 99,
        shield_rules: [" 广告 ", "广告", "", "联系方式"],
      }),
    ).toEqual({
      ...RECORDING_ASS_DEFAULT_SETTINGS,
      resolution_width: 320,
      resolution_height: 4320,
      font_name: "BadFont",
      font_size: 160,
      opacity_percent: 100,
      outline: 1.5,
      shadow: RECORDING_ASS_DEFAULT_SETTINGS.shadow,
      scroll_duration_seconds: 1,
      display_area_percent: 10,
      merge_window_seconds: 30,
      shield_rules: ["广告", "联系方式"],
    });
  });
});
