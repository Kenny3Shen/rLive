import { describe, expect, test } from "bun:test";
import {
  danmakuActionStatusMessage,
  formatDanmakuClipboardText,
  isDanmakuActionFailure,
} from "../src/features/room/danmaku/useDanmakuActions";
import {
  CANVAS_TAP_MAX_DISTANCE_PX,
  canvasDanmakuTouchHitBox,
  isCanvasDanmakuTap,
  TOUCH_HIT_SLOP_PX,
} from "../src/features/room/canvas/CanvasDanmaku";
import { PLAYER_EDGE_GESTURE_MIN_DISTANCE_PX } from "../src/features/room/PlayerPane";

describe("danmaku clipboard actions", () => {
  test("copies a normalized message without altering its wording", () => {
    expect(formatDanmakuClipboardText("  一起看直播  ")).toBe("一起看直播");
  });

  test("keeps the exact message for a +1 send action", () => {
    expect(formatDanmakuClipboardText("一起看直播")).toBe("一起看直播");
    expect(formatDanmakuClipboardText("   ")).toBe("");
  });

  test("shares one status vocabulary between the list and the canvas overlay", () => {
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

describe("canvas danmaku touch selection", () => {
  test("accepts a short stationary tap and rejects a drag or a long press", () => {
    expect(isCanvasDanmakuTap(0, 0, 0)).toBe(true);
    expect(isCanvasDanmakuTap(6, 6, 200)).toBe(true);

    // A drag belongs to the stage's swipe/brightness gestures, not to selection.
    expect(isCanvasDanmakuTap(0, 14, 200)).toBe(false);
    // A long press is the brightness/volume gesture.
    expect(isCanvasDanmakuTap(0, 0, 400)).toBe(false);
  });

  test("stays below the stage's gesture intent threshold", () => {
    // Selecting a comment claims the `pointerup`, which skips the stage's own
    // gesture teardown. A contact that could satisfy both would leave the stage
    // holding a gesture it never ends, so the tap allowance must be strictly
    // smaller than the distance at which a stage gesture activates.
    expect(CANVAS_TAP_MAX_DISTANCE_PX).toBeLessThan(PLAYER_EDGE_GESTURE_MIN_DISTANCE_PX);
    expect(isCanvasDanmakuTap(0, PLAYER_EDGE_GESTURE_MIN_DISTANCE_PX, 200)).toBe(false);
  });

  test("widens only the tested box, leaving the drawn box as the menu anchor", () => {
    const drawn = { x: 100, y: 200, width: 60, height: 18 };
    expect(canvasDanmakuTouchHitBox(drawn, TOUCH_HIT_SLOP_PX)).toEqual({
      x: 90,
      y: 190,
      width: 80,
      height: 38,
    });
    // The drawn box is handed to the menu, so growing it must not mutate it.
    expect(drawn).toEqual({ x: 100, y: 200, width: 60, height: 18 });
  });
});
