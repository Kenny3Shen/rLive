import { describe, expect, test } from "bun:test";
import { nextFailoverAction } from "../src/features/room/playback/failover";
import { pickDefaultQualityIndex, parseQualityLevel } from "../src/features/room/playback/quality";
import {
  isDuplicatePlaybackFailure,
  matchingQualityIndex,
  nextStallReplacementLineIndex,
  nextTwitchDecodeQualityIndex,
  playbackWasStable,
  playerRebuildRetryLimit,
} from "../src/features/room/playback/usePlaybackController";
import {
  createShieldMatcher,
  floatingDanmakuText,
  isShielded,
  shouldShowOnCanvas,
} from "../src/features/room/danmaku/filter";
import { lineLabel, clampIndex } from "../src/lib/playUrl";

describe("failover policy (Simple Live)", () => {
  test("retries current line twice before advancing", () => {
    const first = nextFailoverAction({ retryCount: 0, lineIndex: 0, lineCount: 3 });
    expect(first).toEqual({
      type: "retry",
      retryCount: 1,
      lineIndex: 0,
      delayMs: 0,
    });

    const second = nextFailoverAction({ retryCount: 1, lineIndex: 0, lineCount: 3 });
    expect(second).toEqual({
      type: "retry",
      retryCount: 2,
      lineIndex: 0,
      delayMs: 1000,
    });

    const third = nextFailoverAction({ retryCount: 2, lineIndex: 0, lineCount: 3 });
    expect(third).toEqual({
      type: "next_line",
      retryCount: 0,
      lineIndex: 1,
      delayMs: 0,
    });
  });

  test("fails after last line is exhausted", () => {
    const action = nextFailoverAction({
      retryCount: 2,
      lineIndex: 2,
      lineCount: 3,
    });
    expect(action.type).toBe("fail");
  });

  test("empty line list fails immediately", () => {
    const action = nextFailoverAction({
      retryCount: 0,
      lineIndex: 0,
      lineCount: 0,
    });
    expect(action.type).toBe("fail");
  });

  test("uses a health-ranked replacement instead of array order", () => {
    expect(
      nextFailoverAction({
        retryCount: 2,
        lineIndex: 2,
        lineCount: 3,
        nextLineIndex: 0,
      }),
    ).toEqual({
      type: "next_line",
      retryCount: 0,
      lineIndex: 0,
      delayMs: 0,
    });
    expect(
      nextFailoverAction({
        retryCount: 2,
        lineIndex: 1,
        lineCount: 3,
        nextLineIndex: null,
      }).type,
    ).toBe("fail");
  });

  test("limits redundant full-player retries after the FLV plugin has already retried", () => {
    expect(playerRebuildRetryLimit("douyu")).toBe(1);
    expect(playerRebuildRetryLimit("huya")).toBe(1);
    expect(playerRebuildRetryLimit("bilibili")).toBe(2);
  });

  test("only resets a failure budget after uninterrupted stable playback", () => {
    expect(playbackWasStable(null, 31_000)).toBe(false);
    expect(playbackWasStable(1_000, 30_999)).toBe(false);
    expect(playbackWasStable(1_000, 31_000)).toBe(true);
  });

  test("coalesces duplicate player errors without hiding a new line failure", () => {
    const previous = { epoch: 4, generation: 8, lineIndex: 0, at: 1_000 };
    const event = { epoch: 4, generation: 8 };
    expect(isDuplicatePlaybackFailure(previous, event, 0, 1_500)).toBe(true);
    expect(isDuplicatePlaybackFailure(previous, event, 1, 1_500)).toBe(false);
    expect(isDuplicatePlaybackFailure(previous, event, 0, 1_800)).toBe(false);
  });

  test("preserves a selected quality across refreshed signing metadata", () => {
    const refreshed = [{ quality: "原画" }, { quality: "高清" }, { quality: "流畅" }];
    expect(matchingQualityIndex(refreshed, "高清", 0)).toBe(1);
    expect(matchingQualityIndex(refreshed, "已下线画质", 2)).toBe(2);
  });

  test("switches a sustained stall to the next ranked non-exhausted line", () => {
    const input = {
      enabled: true,
      hasPlayed: true,
      lineCount: 3,
      currentIndex: 2,
      rankedIndices: [2, 0, 1],
      exhaustedIndices: new Set([2]),
    };
    expect(nextStallReplacementLineIndex(input)).toBe(0);
    expect(nextStallReplacementLineIndex({ ...input, enabled: false })).toBeNull();
    expect(nextStallReplacementLineIndex({ ...input, hasPlayed: false })).toBeNull();
    expect(nextStallReplacementLineIndex({ ...input, lineCount: 1 })).toBeNull();
    expect(
      nextStallReplacementLineIndex({ ...input, exhaustedIndices: new Set([0, 1, 2]) }),
    ).toBeNull();
  });
});

describe("quality preference", () => {
  test("high/mid/low map like Simple Live", () => {
    expect(pickDefaultQualityIndex(5, "high")).toBe(0);
    expect(pickDefaultQualityIndex(5, "low")).toBe(4);
    expect(pickDefaultQualityIndex(5, "mid")).toBe(2);
    expect(pickDefaultQualityIndex(4, "mid")).toBe(2);
    expect(pickDefaultQualityIndex(0, "high")).toBe(0);
  });

  test("parseQualityLevel defaults to high", () => {
    expect(parseQualityLevel("mid")).toBe("mid");
    expect(parseQualityLevel("nope")).toBe("high");
  });

  test("skips to the next Twitch video quality after a decoder failure", () => {
    const qualities = [
      { quality: "1080p60 (source)" },
      { quality: "720p60" },
      { quality: "480p" },
      { quality: "audio_only" },
    ];
    expect(nextTwitchDecodeQualityIndex(qualities, 0)).toBe(1);
    expect(nextTwitchDecodeQualityIndex(qualities, 1)).toBe(2);
    expect(nextTwitchDecodeQualityIndex(qualities, 2)).toBeNull();
  });
});

describe("line labels", () => {
  test("prefer 线路n with transport tag", () => {
    expect(lineLabel("https://example.com/live.m3u8", 0)).toBe("线路1（HLS）");
    expect(lineLabel("https://example.com/live.flv", 1)).toBe("线路2（FLV）");
  });

  test("clampIndex", () => {
    expect(clampIndex(5, 3)).toBe(2);
    expect(clampIndex(-1, 3)).toBe(0);
  });
});

describe("danmaku filter", () => {
  test("floating text is content-only", () => {
    expect(
      floatingDanmakuText({
        kind: "chat",
        user: "Alice",
        content: "你好",
        color: null,
        ts: 1,
      }),
    ).toBe("你好");
    expect(
      floatingDanmakuText({
        kind: "super_chat",
        user: "Bob",
        content: "加油",
        color: null,
        ts: 2,
      }),
    ).toBe("【SC】加油");
  });

  test("shield and canvas rules", () => {
    const chat = {
      kind: "chat" as const,
      user: "u",
      content: "屏蔽词测试",
      color: null,
      ts: 1,
    };
    expect(isShielded(chat, ["屏蔽词"])).toBe(true);
    const matcher = createShieldMatcher(["  屏蔽词  "]);
    expect(matcher(chat)).toBe(true);
    expect(shouldShowOnCanvas({ ...chat, kind: "system", content: "x" })).toBe(false);
  });
});
