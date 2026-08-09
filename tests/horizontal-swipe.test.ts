import { describe, expect, test } from "bun:test";
import {
  HORIZONTAL_SWIPE_SETTLE_MAX_MS,
  HORIZONTAL_SWIPE_SETTLE_MIN_MS,
  horizontalSwipeCommitOffset,
  horizontalSwipeDragOffset,
  horizontalSwipeProgress,
  horizontalSwipeSettleDuration,
  horizontalSwipeShouldCommit,
  horizontalSwipeTargetIndex,
  horizontalSwipeTargetItem,
  horizontalSwipeTrackOffset,
  horizontalSwipeVelocity,
  isHorizontalSwipeIgnoredTarget,
} from "../src/shared/gestures/horizontalSwipe";
import {
  canStartPullToRefresh,
  isPullToRefreshArmed,
  isPullToRefreshGesture,
  pullToRefreshDistance,
} from "../src/shared/gestures/pullToRefresh";

describe("horizontal tab swipe", () => {
  test("reports drag progress as a signed share of the surface", () => {
    expect(horizontalSwipeProgress(-180, 360)).toBe(-0.5);
    expect(horizontalSwipeProgress(90, 360)).toBe(0.25);
    // The page never travels further than one surface, so neither does progress.
    expect(horizontalSwipeProgress(-720, 360)).toBe(-1);
    expect(horizontalSwipeProgress(-180, 0)).toBe(0);
  });

  test("averages release velocity over a window rather than the last two events", () => {
    // A steady 0.5 px/ms drag reads as exactly that, whichever pair is sampled.
    const steady = [
      { x: 0, time: 0 },
      { x: 8, time: 16 },
      { x: 16, time: 32 },
      { x: 24, time: 48 },
    ];
    expect(horizontalSwipeVelocity(steady, 32)).toBeCloseTo(0.5);
    // A finger that stopped before lifting reports 0 instead of inheriting the
    // speed it had before the pause: every earlier sample is outside the window
    // measured back from the newest one, so a parked drag is judged on position.
    expect(
      horizontalSwipeVelocity(
        [
          { x: 0, time: 0 },
          { x: 200, time: 40 },
          { x: 202, time: 200 },
        ],
        32,
      ),
    ).toBe(0);
    expect(horizontalSwipeVelocity([{ x: 10, time: 5 }], 32)).toBe(0);
    expect(horizontalSwipeVelocity([], 32)).toBe(0);
  });

  test("commits on progress past the midpoint or on a flick in the same direction", () => {
    const width = 360;
    // Positional: only a drag that carried the page far enough pages on release.
    expect(horizontalSwipeShouldCommit(-160, 0, width)).toBe(true);
    expect(horizontalSwipeShouldCommit(-100, 0, width)).toBe(false);
    expect(horizontalSwipeShouldCommit(160, 0, width)).toBe(true);
    // A flick pages from a short drag — the old 48px absolute rule could not.
    expect(horizontalSwipeShouldCommit(-24, -0.9, width)).toBe(true);
    expect(horizontalSwipeShouldCommit(24, 0.9, width)).toBe(true);
    // Pulling back past the midpoint cancels: the last intent wins over distance.
    expect(horizontalSwipeShouldCommit(-300, 1.2, width)).toBe(false);
    expect(horizontalSwipeShouldCommit(300, -1.2, width)).toBe(false);
    expect(horizontalSwipeShouldCommit(0, -2, width)).toBe(false);
  });

  test("advances and retreats through an ordered strip without wrapping", () => {
    expect(horizontalSwipeTargetIndex(0, 4, -200, 0, 360)).toBe(1);
    expect(horizontalSwipeTargetIndex(1, 4, 200, 0, 360)).toBe(0);
    expect(horizontalSwipeTargetIndex(0, 4, 200, 0, 360)).toBeNull();
    expect(horizontalSwipeTargetIndex(3, 4, -200, 0, 360)).toBeNull();
    expect(horizontalSwipeTargetItem(["a", "b", "c"], "b", -200, 0, 360)).toBe("c");
    expect(horizontalSwipeTargetItem(["a", "b", "c"], "a", 200, 0, 360)).toBeNull();
    // Below the commit threshold the strip stays where it is.
    expect(horizontalSwipeTargetItem(["a", "b", "c"], "b", -40, 0, 360)).toBeNull();
  });

  test("derives the settle duration from remaining distance and release speed", () => {
    // A flick covers its remaining travel quickly; a slow release eases out.
    const fast = horizontalSwipeSettleDuration(240, 2.4);
    const slow = horizontalSwipeSettleDuration(240, 0.2);
    expect(fast).toBeLessThan(slow);
    // Both stay inside the window that still reads as one continuous movement.
    for (const duration of [fast, slow]) {
      expect(duration).toBeGreaterThanOrEqual(HORIZONTAL_SWIPE_SETTLE_MIN_MS);
      expect(duration).toBeLessThanOrEqual(HORIZONTAL_SWIPE_SETTLE_MAX_MS);
    }
    // Already at rest: nothing to animate.
    expect(horizontalSwipeSettleDuration(0, 1)).toBe(0);
    expect(horizontalSwipeSettleDuration(-240, -2.4)).toBe(fast);
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

  test("keeps the pixels under the finger when a single page is replaced", () => {
    // In the `page` layout the element that followed the finger is reused for
    // the incoming page, which renders at rest. Starting it one width across the
    // travel direction leaves the pixels where the drag left them: subtracting
    // that width recovers exactly the live drag, so settling to 0 continues the
    // gesture instead of restarting it.
    const width = 360;
    for (const [drag, direction] of [
      [-140, 1],
      [140, -1],
      [-320, 1],
    ] as const) {
      const rebased = horizontalSwipeCommitOffset(drag, direction, width);
      expect(rebased - direction * width).toBe(drag);
    }
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
