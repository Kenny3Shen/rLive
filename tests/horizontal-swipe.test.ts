import { describe, expect, test } from "bun:test";
import {
  isHorizontalSwipe,
  isHorizontalSwipeIgnoredTarget,
  nextIndexForHorizontalSwipe,
  nextItemForHorizontalSwipe,
} from "../src/shared/gestures/horizontalSwipe";
import {
  canStartPullToRefresh,
  isPullToRefreshArmed,
  isPullToRefreshGesture,
  pullToRefreshDistance,
} from "../src/shared/gestures/pullToRefresh";

describe("horizontal tab swipe", () => {
  test("requires a deliberate horizontal movement", () => {
    expect(isHorizontalSwipe(-80, 6)).toBe(true);
    expect(isHorizontalSwipe(80, 6)).toBe(true);
    expect(isHorizontalSwipe(-30, 0)).toBe(false);
    expect(isHorizontalSwipe(-72, 72)).toBe(false);
  });

  test("advances and retreats through an ordered strip without wrapping", () => {
    expect(nextIndexForHorizontalSwipe(0, 4, -80, 4)).toBe(1);
    expect(nextIndexForHorizontalSwipe(1, 4, 80, 4)).toBe(0);
    expect(nextIndexForHorizontalSwipe(0, 4, 80, 4)).toBeNull();
    expect(nextIndexForHorizontalSwipe(3, 4, -80, 4)).toBeNull();
    expect(nextItemForHorizontalSwipe(["a", "b", "c"], "b", -80, 2)).toBe("c");
    expect(nextItemForHorizontalSwipe(["a", "b", "c"], "a", 80, 2)).toBeNull();
  });

  test("ignores only continuous editors, not ordinary buttons", () => {
    expect(isHorizontalSwipeIgnoredTarget(null)).toBe(false);
  });
});

describe("pull to refresh", () => {
  test("only arms from the top of a scroll container", () => {
    expect(canStartPullToRefresh(0)).toBe(true);
    expect(canStartPullToRefresh(12)).toBe(false);
  });

  test("requires a downward vertical drag and damps the rubber band", () => {
    expect(isPullToRefreshGesture(4, 40)).toBe(true);
    expect(isPullToRefreshGesture(40, 20)).toBe(false);
    expect(pullToRefreshDistance(32)).toBe(32);
    expect(isPullToRefreshArmed(64)).toBe(true);
    expect(isPullToRefreshArmed(40)).toBe(false);
  });
});
