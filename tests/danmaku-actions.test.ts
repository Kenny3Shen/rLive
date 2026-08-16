import { describe, expect, test } from "bun:test";
import {
  danmakuActionStatusMessage,
  formatDanmakuClipboardText,
  isDanmakuActionFailure,
} from "../src/features/room/danmaku/useDanmakuActions";
import { danmakuVisibleContentRect } from "../src/features/room/danmaku/DanmuJsDanmaku";

describe("danmaku clipboard actions", () => {
  test("copies a normalized message without altering its wording", () => {
    expect(formatDanmakuClipboardText("  一起看直播  ")).toBe("一起看直播");
  });

  test("keeps the exact message for a +1 send action", () => {
    expect(formatDanmakuClipboardText("一起看直播")).toBe("一起看直播");
    expect(formatDanmakuClipboardText("   ")).toBe("");
  });

  test("shares one status vocabulary between the list and the floating overlay", () => {
    expect(danmakuActionStatusMessage("copied")).toBe("已复制弹幕内容");
    expect(danmakuActionStatusMessage("favorited")).toBe("已收藏");
    expect(danmakuActionStatusMessage("sent")).toBe("已发送相同的弹幕");
    expect(danmakuActionStatusMessage(null)).toBeNull();
  });

  test("marks only the failing outcomes as errors", () => {
    expect(isDanmakuActionFailure("copy-failed")).toBe(true);
    expect(isDanmakuActionFailure("favorite-failed")).toBe(true);
    expect(isDanmakuActionFailure("send-failed")).toBe(true);
    expect(isDanmakuActionFailure("sent")).toBe(false);
    expect(isDanmakuActionFailure(null)).toBe(false);
  });
});

describe("floating danmaku hover geometry", () => {
  test("excludes the reserved repeat-count slot from the hover border", () => {
    const content = { x: 20, y: 30, width: 120, height: 24 };
    const count = { x: 140, y: 30, width: 22, height: 24 };
    const reservedRoot = { x: 20, y: 30, width: 220, height: 24 };

    expect(danmakuVisibleContentRect(content, count, 1, reservedRoot)).toEqual(content);
    expect(danmakuVisibleContentRect(content, count, 2, reservedRoot)).toEqual({
      x: 20,
      y: 30,
      width: 142,
      height: 24,
    });
  });
});
