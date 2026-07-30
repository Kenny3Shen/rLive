import { describe, expect, test } from "bun:test";
import { nextFailoverAction } from "../frontend/features/room/playback/failover";
import { pickDefaultQualityIndex, parseQualityLevel } from "../frontend/features/room/playback/quality";
import {
  createShieldMatcher,
  floatingDanmakuText,
  isShielded,
  shouldShowOnCanvas,
} from "../frontend/features/room/danmaku/filter";
import { lineLabel, clampIndex } from "../frontend/lib/playUrl";

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
