import { describe, expect, test } from "bun:test";
import {
  LONG_PRESS_CANCEL_SLOP_PX,
  LONG_PRESS_CONTEXTMENU_GRACE_MS,
  LONG_PRESS_TRIGGER_MS,
  hasLongPressMovedBeyondSlop,
  isContextMenuOwnedByPress,
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

describe("contextmenu 归属判定", () => {
  test("计时器仍在计时时，contextmenu 属于本次按压", () => {
    expect(isContextMenuOwnedByPress(true, 0, 10_000)).toBe(true);
  });

  test("计时器先触发时，宽限期内到达的 contextmenu 仍算同一手势", () => {
    expect(isContextMenuOwnedByPress(false, 5_000, 5_000 + 5)).toBe(true);
    expect(isContextMenuOwnedByPress(false, 5_000, 5_000 + LONG_PRESS_CONTEXTMENU_GRACE_MS - 1)).toBe(true);
  });

  test("超过宽限期的迟到 contextmenu 被忽略（遮罩退出期间的重定向伪信号）", () => {
    expect(isContextMenuOwnedByPress(false, 5_000, 5_000 + LONG_PRESS_CONTEXTMENU_GRACE_MS)).toBe(false);
    expect(isContextMenuOwnedByPress(false, 5_000, 5_000 + 2_000)).toBe(false);
  });

  test("从未触发且未计时的孤立 contextmenu 被忽略", () => {
    expect(isContextMenuOwnedByPress(false, 0, 10_000)).toBe(false);
    // 页面刚加载（performance.now() 很小）时也不得误判为宽限期内。
    expect(isContextMenuOwnedByPress(false, 0, 100)).toBe(false);
  });

  test("宽限期必须小于重定向伪信号的最小间隔（一个触发周期）", () => {
    // 重定向场景里手指要先落在遮罩上至少 LONG_PRESS_TRIGGER_MS 才会激起
    // contextmenu，因此伪信号距上次触发不少于一个周期；宽限期需留出余量。
    expect(LONG_PRESS_CONTEXTMENU_GRACE_MS).toBeLessThan(LONG_PRESS_TRIGGER_MS);
    expect(LONG_PRESS_TRIGGER_MS - LONG_PRESS_CONTEXTMENU_GRACE_MS).toBeGreaterThanOrEqual(150);
  });
});
