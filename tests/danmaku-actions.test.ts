import { describe, expect, test } from "bun:test";
import {
  danmakuActionStatusMessage,
  formatDanmakuClipboardText,
  isDanmakuActionFailure,
} from "../src/features/room/danmaku/useDanmakuActions";
import {
  DANMAKU_TAP_MAX_DISTANCE_PX,
  DANMAKU_TOUCH_HIT_SLOP_PX,
  expandedDanmakuHitRect,
  isDanmakuTap,
  shouldHitTestDanmakuHover,
} from "../src/features/room/danmaku/DanmuJsDanmaku";
import { PLAYER_EDGE_GESTURE_MIN_DISTANCE_PX } from "../src/features/room/PlayerPane";

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

describe("floating danmaku touch selection", () => {
  test("accepts a short stationary tap and rejects a drag or a long press", () => {
    expect(isDanmakuTap(0, 0, 0)).toBe(true);
    expect(isDanmakuTap(6, 6, 200)).toBe(true);

    // A drag belongs to the stage's swipe/brightness gestures, not to selection.
    expect(isDanmakuTap(0, 14, 200)).toBe(false);
    // A long press is the brightness/volume gesture.
    expect(isDanmakuTap(0, 0, 400)).toBe(false);
  });

  test("stays below the stage's gesture intent threshold", () => {
    // The bullet must receive `pointerup` to select a comment, so its tap allowance
    // stays below the point where the stage captures a brightness/volume drag.
    expect(DANMAKU_TAP_MAX_DISTANCE_PX).toBeLessThan(PLAYER_EDGE_GESTURE_MIN_DISTANCE_PX);
    expect(isDanmakuTap(0, PLAYER_EDGE_GESTURE_MIN_DISTANCE_PX, 200)).toBe(false);
  });

  test("only skips hit testing while a selection actually exists", () => {
    // The menu holds the pointer, so the frozen comment stays selected instead
    // of the stage hit-testing the gap behind the menu.
    expect(shouldHitTestDanmakuHover(true, true)).toBe(false);
    expect(shouldHitTestDanmakuHover(false, true)).toBe(true);

    // The regression: a menu that unmounts under the pointer gets no
    // `pointerleave`, so the claim flag can survive with no menu left to clear
    // it. Without a selection the flag must not suppress hit testing, or hover
    // selection stays dead for the rest of the session after the first menu.
    expect(shouldHitTestDanmakuHover(true, false)).toBe(true);
    expect(shouldHitTestDanmakuHover(false, false)).toBe(true);
  });

  test("widens only the tested box, leaving the drawn box as the menu anchor", () => {
    const drawn = { x: 100, y: 200, width: 60, height: 18 };
    expect(expandedDanmakuHitRect(drawn, DANMAKU_TOUCH_HIT_SLOP_PX)).toEqual({
      x: 90,
      y: 190,
      width: 80,
      height: 38,
    });
    // The drawn box is handed to the menu, so growing it must not mutate it.
    expect(drawn).toEqual({ x: 100, y: 200, width: 60, height: 18 });
  });
});
