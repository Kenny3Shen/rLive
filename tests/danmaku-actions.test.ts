import { describe, expect, test } from "bun:test";
import {
  danmakuActionStatusMessage,
  formatDanmakuClipboardText,
  isDanmakuActionFailure,
} from "../src/features/room/danmaku/useDanmakuActions";
import {
  danmakuVisibleContentRect,
  isDanmakuPinTap,
} from "../src/features/room/danmaku/DanmuJsDanmaku";

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

describe("floating danmaku selection geometry", () => {
  test("excludes the reserved repeat-count slot from the selection border", () => {
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

describe("floating danmaku pin gesture", () => {
  test("pins on a short press that stayed on the comment", () => {
    expect(isDanmakuPinTap(0, 0, 0)).toBe(true);
    expect(isDanmakuPinTap(6, -8, 200)).toBe(true);
  });

  test("leaves a drag or a long press to the player stage", () => {
    // 音量或亮度拖拽可能从评论上开始；它必须仍能到达舞台而不是变成钉住。
    expect(isDanmakuPinTap(0, 40, 200)).toBe(false);
    expect(isDanmakuPinTap(0, 0, 400)).toBe(false);
  });
});
