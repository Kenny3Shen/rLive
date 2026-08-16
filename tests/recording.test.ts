import { describe, expect, test } from "bun:test";
import {
  activeRecordingForContext,
  clampRecordingPlaybackTime,
  formatRecordingDuration,
  formatRecordingSize,
  recordingEndedPlaybackTime,
  recordingSeekReached,
  recordingProtocolLabel,
  type RecordingContext,
  type RecordingItem,
} from "../src/features/recording/recording";
import { shouldPromptBeforeRecordingLeave } from "../src/features/recording/RecordingLeaveGuard";
import {
  firstRecordedDanmakuAtOrAfter,
  parseRecordedDanmakuSidecar,
} from "../src/features/recording/recordedDanmaku";

const liveContext: RecordingContext = {
  source: {
    url: "https://example.test/live.flv",
    headers: {},
  },
  sourceKey: "live:bilibili:100",
  sourceKind: "live",
  siteId: "bilibili",
  roomId: "100",
  title: "测试直播间",
};

function recordingItem(overrides: Partial<RecordingItem> = {}): RecordingItem {
  return {
    id: "recording-1",
    source_key: liveContext.sourceKey,
    source_kind: "live",
    site_id: "bilibili",
    room_id: "100",
    title: liveContext.title,
    user_name: "主播",
    cover: "",
    protocol: "flv",
    status: "recording",
    started_at: 1,
    ended_at: null,
    duration_ms: 0,
    size_bytes: 0,
    include_danmaku: false,
    continue_on_leave: false,
    danmaku_count: 0,
    danmaku_file: null,
    file_path: "/recordings/recording-1/stream.flv",
    error: null,
    ...overrides,
  };
}

describe("recording presentation helpers", () => {
  test("formats short and long durations as timecodes", () => {
    expect(formatRecordingDuration(0)).toBe("0:00");
    expect(formatRecordingDuration(65_000)).toBe("1:05");
    expect(formatRecordingDuration(3_661_000)).toBe("1:01:01");
  });

  test("bounds playback progress when a media backend reports time past EOF", () => {
    expect(clampRecordingPlaybackTime(37, 32)).toBe(32);
    expect(clampRecordingPlaybackTime(-1, 32)).toBe(0);
    expect(clampRecordingPlaybackTime(Number.NaN, 32)).toBe(0);
    expect(clampRecordingPlaybackTime(37, 0)).toBe(37);
  });

  test("does not disguise an early media EOF as the recording end", () => {
    expect(recordingEndedPlaybackTime(20, 60, 1.5)).toBe(20);
    expect(recordingEndedPlaybackTime(59, 60, 1.5)).toBe(60);
    expect(recordingEndedPlaybackTime(61, 60, 1.5)).toBe(60);
  });

  test("does not complete a non-terminal seek when media ends at its target", () => {
    expect(recordingSeekReached(20, 20, 60, true, 1.5)).toBe(false);
    expect(recordingSeekReached(59, 60, 60, true, 1.5)).toBe(true);
    expect(recordingSeekReached(20, 20, 60, false, 1.5)).toBe(true);
  });

  test("formats local storage sizes with stable units", () => {
    expect(formatRecordingSize(0)).toBe("0 B");
    expect(formatRecordingSize(1024)).toBe("1.0 KB");
    expect(formatRecordingSize(1_536)).toBe("1.5 KB");
    expect(formatRecordingSize(1024 ** 3)).toBe("1.0 GB");
  });

  test("keeps protocol labels readable in the library", () => {
    expect(recordingProtocolLabel("flv")).toBe("FLV");
    expect(recordingProtocolLabel("hls")).toBe("HLS");
    expect(recordingProtocolLabel("mpeg_ts")).toBe("MPEG-TS");
    expect(recordingProtocolLabel("native")).toBe("原生");
  });

  test("parses synchronized danmaku batches and ignores an incomplete tail", () => {
    const entries = parseRecordedDanmakuSidecar(
      JSON.stringify({
        offset_ms: 1200,
        events: [
          {
            kind: "chat",
            user: "小明",
            content: "晚上好",
            color: "#ffffff",
            ts: 1,
          },
          {
            kind: "system",
            user: "system",
            content: "连接断开",
            color: null,
            ts: 2,
          },
        ],
      }) + "\n{",
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.offsetMs).toBe(1200);
    expect(entries[0]?.text).toBe("晚上好");
    expect(firstRecordedDanmakuAtOrAfter(entries, 0)).toBe(0);
    expect(firstRecordedDanmakuAtOrAfter(entries, 1201)).toBe(1);
  });
});

describe("active recording context matching", () => {
  test("matches an active session by its stable source key", () => {
    const active = recordingItem();

    expect(activeRecordingForContext([active], liveContext)).toBe(active);
  });

  test("falls back to the live site and room identity when a source key changes", () => {
    const active = recordingItem({ source_key: "legacy-live-key" });

    expect(activeRecordingForContext([active], liveContext)).toBe(active);
  });

  test("ignores completed sessions and unrelated active sessions", () => {
    const completed = recordingItem({ status: "completed" });
    const otherRoom = recordingItem({
      id: "recording-2",
      source_key: "live:bilibili:200",
      room_id: "200",
    });

    expect(activeRecordingForContext([completed, otherRoom], liveContext)).toBeNull();
    expect(activeRecordingForContext([recordingItem()], null)).toBeNull();
  });
});

describe("recording leave confirmation policy", () => {
  test("prompts for an active default session when navigating away", () => {
    expect(shouldPromptBeforeRecordingLeave(recordingItem(), "/room/bilibili/100", "/")).toBe(true);
  });

  test("does not prompt after background continuation was enabled", () => {
    expect(
      shouldPromptBeforeRecordingLeave(
        recordingItem({ continue_on_leave: true }),
        "/room/bilibili/100",
        "/",
      ),
    ).toBe(false);
  });

  test("does not prompt without an active session or a real destination change", () => {
    expect(
      shouldPromptBeforeRecordingLeave(
        recordingItem({ status: "completed" }),
        "/room/bilibili/100",
        "/",
      ),
    ).toBe(false);
    expect(
      shouldPromptBeforeRecordingLeave(recordingItem(), "/room/bilibili/100", "/room/bilibili/100"),
    ).toBe(false);
    expect(shouldPromptBeforeRecordingLeave(null, "/room/bilibili/100", "/")).toBe(false);
  });
});
