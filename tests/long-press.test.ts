import { describe, expect, test } from "bun:test";
import {
  LONG_PRESS_CANCEL_SLOP_PX,
  LONG_PRESS_TRIGGER_MS,
  hasLongPressMovedBeyondSlop,
  isLongPressPointer,
} from "../src/shared/gestures/longPress";

describe("long press gesture", () => {
  test("only touch and pen primary pointers can long-press", () => {
    expect(isLongPressPointer("touch", true)).toBe(true);
    expect(isLongPressPointer("pen", true)).toBe(true);
    // 鼠标交给右键菜单；第二根手指不参与。
    expect(isLongPressPointer("mouse", true)).toBe(false);
    expect(isLongPressPointer("touch", false)).toBe(false);
    expect(isLongPressPointer(undefined, true)).toBe(false);
  });

  test("trigger duration matches a deliberate hold, not a scroll drag", () => {
    expect(LONG_PRESS_TRIGGER_MS).toBeGreaterThanOrEqual(400);
    expect(LONG_PRESS_TRIGGER_MS).toBeLessThanOrEqual(600);
  });

  test("movement inside the slop keeps the press, beyond cancels it", () => {
    expect(hasLongPressMovedBeyondSlop(10, 10, 10, 10)).toBe(false);
    // 半径边界本身不算移出。
    expect(hasLongPressMovedBeyondSlop(10, 10, 10 + LONG_PRESS_CANCEL_SLOP_PX, 10)).toBe(false);
    expect(hasLongPressMovedBeyondSlop(10, 10, 10 + LONG_PRESS_CANCEL_SLOP_PX + 1, 10)).toBe(true);
    expect(hasLongPressMovedBeyondSlop(10, 10, 10, 10 - LONG_PRESS_CANCEL_SLOP_PX - 1)).toBe(true);
  });

  test("diagonal drift is judged by radius, not per-axis components", () => {
    // 两个分量都小于半径，但合成位移超出。
    const inside = (LONG_PRESS_CANCEL_SLOP_PX * 0.7) ** 2 * 2;
    expect(inside).toBeLessThanOrEqual(LONG_PRESS_CANCEL_SLOP_PX ** 2);
    expect(hasLongPressMovedBeyondSlop(0, 0, 7, 7)).toBe(false);
    expect(hasLongPressMovedBeyondSlop(0, 0, 8, 8)).toBe(true);
  });
});
