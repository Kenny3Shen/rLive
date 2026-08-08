import { describe, expect, test } from "bun:test";
import {
  horizontalSwipeCommitOffset,
  horizontalSwipeDragOffset,
  horizontalSwipeTrackOffset,
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

  test("lets a page follow the finger while damping strip boundaries", () => {
    expect(horizontalSwipeDragOffset(1, 3, -80, 360)).toBe(-80);
    expect(horizontalSwipeDragOffset(1, 3, 80, 360)).toBe(80);
    expect(horizontalSwipeDragOffset(0, 3, 80, 360)).toBeCloseTo(14.4);
    expect(horizontalSwipeDragOffset(2, 3, -80, 360)).toBeCloseTo(-14.4);
  });

  test("caps page travel at a full surface width for the phone-style pan", () => {
    // A full-width pan lets the page track the finger all the way across, so the
    // surface width is the cap — not a fixed nudge.
    expect(horizontalSwipeDragOffset(1, 3, -500, 300)).toBe(-300);
    expect(horizontalSwipeDragOffset(1, 3, 500, 1_000)).toBe(500);
    expect(horizontalSwipeDragOffset(1, 3, 1_500, 1_000)).toBe(1_000);
    expect(horizontalSwipeDragOffset(-1, 3, 80, 360)).toBe(0);
  });

  test("rebases a committed drag without restarting a full-width animation", () => {
    expect(horizontalSwipeCommitOffset(-144, 1, 360)).toBe(216);
    expect(horizontalSwipeCommitOffset(144, -1, 360)).toBe(-216);
    expect(horizontalSwipeCommitOffset(0, 1, 360)).toBe(360);
  });

  test("positions a mounted track at each full-width page", () => {
    expect(horizontalSwipeTrackOffset(0, 360)).toBe(0);
    expect(horizontalSwipeTrackOffset(1, 360)).toBe(-360);
    expect(horizontalSwipeTrackOffset(2, 360)).toBe(-720);
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
