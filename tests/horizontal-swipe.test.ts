import { describe, expect, test } from "bun:test";
import {
  HORIZONTAL_SWIPE_COMMIT_PROGRESS,
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
    // 页面行程不会超过一个表面宽度，进度也是如此。
    expect(horizontalSwipeProgress(-720, 360)).toBe(-1);
    expect(horizontalSwipeProgress(-180, 0)).toBe(0);
  });

  test("averages release velocity over a window rather than the last two events", () => {
    // 稳定的 0.5 px/ms 拖拽读出来就是它本身，无论采样到哪一对。
    const steady = [
      { x: 0, time: 0 },
      { x: 8, time: 16 },
      { x: 16, time: 32 },
      { x: 24, time: 48 },
    ];
    expect(horizontalSwipeVelocity(steady, 32)).toBeCloseTo(0.5);
    // 抬起前停顿过的手指上报 0 而不是继承停顿前的速度：
    // 从最新样本往回量的窗口不含更早样本，停驻的拖拽只按位置判断。
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

  test("commits on progress past the threshold or on a flick in the same direction", () => {
    const width = 360;
    const threshold = width * HORIZONTAL_SWIPE_COMMIT_PROGRESS;
    // 按位置判定：只有把页面带得足够远的拖拽才在释放时翻页。相对常量表述，
    // 使阈值重新调校后边界情况仍然有意义，
    // 而不是悄悄变成"恰好两侧都不算"。
    expect(horizontalSwipeShouldCommit(-(threshold + 20), 0, width)).toBe(true);
    expect(horizontalSwipeShouldCommit(-threshold, 0, width)).toBe(true);
    expect(horizontalSwipeShouldCommit(-(threshold - 20), 0, width)).toBe(false);
    expect(horizontalSwipeShouldCommit(threshold + 20, 0, width)).toBe(true);
    // 三分之一表面是刻意的拖拽，必须翻页：在中点附近它会弹回，
    // 读起来像手势被忽略了。
    expect(horizontalSwipeShouldCommit(-width / 3, 0, width)).toBe(true);
    // 一甩可以从短拖拽翻页 —— 过去的 48px 绝对规则做不到。
    expect(horizontalSwipeShouldCommit(-24, -0.9, width)).toBe(true);
    expect(horizontalSwipeShouldCommit(24, 0.9, width)).toBe(true);
    // 拉回越过中点即取消：最后的意图胜过距离。
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
    // 低于配置的提交阈值时条带保持原位。
    expect(
      horizontalSwipeTargetItem(
        ["a", "b", "c"],
        "b",
        -(360 * HORIZONTAL_SWIPE_COMMIT_PROGRESS - 1),
        0,
        360,
      ),
    ).toBeNull();
  });

  test("derives the settle duration from remaining distance and release speed", () => {
    // 一甩快速覆盖剩余行程；慢速释放则缓缓减速。
    const fast = horizontalSwipeSettleDuration(240, 2.4);
    const slow = horizontalSwipeSettleDuration(240, 0.2);
    expect(fast).toBeLessThan(slow);
    // 两者都保持在仍读作一次连续运动的窗口内。
    for (const duration of [fast, slow]) {
      expect(duration).toBeGreaterThanOrEqual(HORIZONTAL_SWIPE_SETTLE_MIN_MS);
      expect(duration).toBeLessThanOrEqual(HORIZONTAL_SWIPE_SETTLE_MAX_MS);
    }
    // 已在静止状态：没有可动画的东西。
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
    // 整宽平移让页面一路跟手横穿，因此表面宽度才是上限 —— 不是固定推力。
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
    // `page` 布局中跟随手指的元素被进入页复用并以静止态渲染。让它从行程方向之外
    // 一个宽度处开始，像素留在拖拽留下的位置：减去那个宽度正好还原实时拖拽，
    // 收尾到 0 就是延续手势而不是重启它。
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
