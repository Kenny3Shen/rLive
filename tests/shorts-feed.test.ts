import { describe, expect, test } from "bun:test";
import {
  SHORTS_COMMENT_DOCK_MIN_STAGE_PX,
  SHORTS_COMMENT_DOCK_SHARE,
  shortsCommentDockHeight,
  shortsMediaAspect,
  shortsMediaFrame,
  shortsFrameFill,
  shortsSwipeIntent,
  shortsSwipeTargetIndex,
  shortsSwipeDragOffset,
  shortsSwipeVelocity,
  shortsMountedIndexes,
  shortsShouldFetchMore,
  shortsNextSlots,
  type ShortsSlots,
} from "../src/features/shorts/shortsFeed";

describe("短视频画幅", () => {
  test("媒体实测优先、列表旋转交换宽高，缺失时不猜画幅", () => {
    const dimension = { width: 1920, height: 1080, rotate: 1 };
    expect(shortsMediaAspect(dimension)).toBeCloseTo(9 / 16);
    expect(shortsMediaAspect(dimension, { width: 1920, height: 1080 })).toBeCloseTo(16 / 9);
    expect(shortsMediaAspect(null)).toBeNull();
    expect(shortsMediaAspect({ ...dimension, width: 0 })).toBeNull();
  });

  test.each([
    [1920, 1080, 9 / 16, 607.5, 1080],
    [412, 839, 16 / 9, 412, 231.75],
    [1920, 1080, null, 1920, 1080],
  ] as const)(
    "内切不裁原画面：%s×%s/%s",
    (width, height, aspect, expectedWidth, expectedHeight) => {
      const frame = shortsMediaFrame(width, height, aspect);
      expect(frame.width).toBeCloseTo(expectedWidth);
      expect(frame.height).toBeCloseTo(expectedHeight);
    },
  );

  test("只允许接近源比例的竖屏裁切，横屏、差距过大和未知比例均留边", () => {
    expect(shortsFrameFill(412, 808, 9 / 16)).toBe(true);
    expect(shortsFrameFill(393, 810, 9 / 16)).toBe(false);
    expect(shortsFrameFill(1440, 841, 16 / 9)).toBe(false);
    expect(shortsFrameFill(360, 673, null)).toBe(false);
    expect(shortsFrameFill(0, 0, 9 / 16)).toBe(false);
  });
});

describe("短视频手势", () => {
  test.each([
    [4, 6, "pending"],
    [0, -40, "switch"],
    [40, 0, "reject"],
    [30, 32, "reject"],
  ] as const)("轴锁 %s/%s", (x, y, expected) => {
    expect(shortsSwipeIntent(x, y)).toBe(expected);
  });

  test.each([
    [1, -80, 0, null],
    [1, -400, 0, 2],
    [1, -10, -1, 2],
    [1, -720, 1, null],
    [2, 400, 0, 1],
    [0, 400, 0, null],
    [4, -400, 0, null],
  ] as const)(
    "提交按距离与最后甩动方向，禁止首尾越界：%s/%s/%s",
    (index, delta, velocity, expected) => {
      expect(shortsSwipeTargetIndex(index, 5, delta, velocity, 800)).toBe(expected);
    },
  );

  test("位移最多一屏，越界阻尼；停顿后速度不沿用之前的快滑", () => {
    expect(shortsSwipeDragOffset(1, 5, -1200, 800)).toBe(-800);
    const boundary = shortsSwipeDragOffset(0, 5, 300, 800);
    expect(boundary).toBeGreaterThan(0);
    expect(boundary).toBeLessThan(75);
    expect(
      shortsSwipeVelocity([
        { y: 0, time: 0 },
        { y: -200, time: 100 },
        { y: -200, time: 200 },
      ]),
    ).toBeCloseTo(0);
    expect(
      shortsSwipeVelocity([
        { y: 0, time: 0 },
        { y: -40, time: 16 },
        { y: -80, time: 32 },
      ]),
    ).toBeLessThan(-1);
  });
});

describe("三槽所有权与补货", () => {
  test("前进只替换新邻居，回滑复用旧槽，同位置返回原状态", () => {
    const empty: ShortsSlots = { held: { a: null, b: null, c: null }, active: "a" };
    const first = shortsNextSlots(0, 5, empty);
    const second = shortsNextSlots(1, 5, first);
    const third = shortsNextSlots(2, 5, second);
    expect(first).toEqual({ held: { a: 0, b: 1, c: null }, active: "a" });
    expect(second).toEqual({ held: { a: 0, b: 1, c: 2 }, active: "b" });
    expect(third).toEqual({ held: { a: 3, b: 1, c: 2 }, active: "c" });
    expect(shortsNextSlots(1, 5, third)).toEqual(second);
    expect(shortsNextSlots(2, 5, third)).toBe(third);
    expect(shortsNextSlots(4, 5, third).held).toEqual({ a: 3, b: 4, c: null });
    expect(shortsNextSlots(0, 1, empty).held).toEqual({ a: 0, b: null, c: null });
  });

  test("只挂载邻居，末尾预取但禁止重复在途请求与空流死循环", () => {
    expect(shortsMountedIndexes(0, 5)).toEqual([0, 1]);
    expect(shortsMountedIndexes(2, 5)).toEqual([1, 2, 3]);
    expect(shortsMountedIndexes(4, 5)).toEqual([3, 4]);
    expect(shortsMountedIndexes(0, 0)).toEqual([]);
    expect(shortsShouldFetchMore(0, 10, true, false)).toBe(false);
    expect(shortsShouldFetchMore(9, 10, true, false)).toBe(true);
    expect(shortsShouldFetchMore(9, 10, true, true)).toBe(false);
    expect(shortsShouldFetchMore(9, 10, false, false)).toBe(false);
    expect(shortsShouldFetchMore(0, 0, true, false)).toBe(false);
  });
});

describe("评论 dock 高度", () => {
  test("约占六成，但总为画面保留最小高度", () => {
    // 入参是外层可用高度。dock 打开时底部操作栏整条收起，因此这里不再先减操作栏：
    // 800px 里 60% = 480，上方画面留 320，够用。
    expect(shortsCommentDockHeight(800)).toBe(480);
    expect(shortsCommentDockHeight(700)).toBe(420);
    // 矮视口：600px 是分界点（60% 与「留 240px 画面」相等），更矮时画面下限先触发。
    expect(shortsCommentDockHeight(600)).toBe(360);
    expect(shortsCommentDockHeight(480)).toBe(SHORTS_COMMENT_DOCK_MIN_STAGE_PX);
    // 更矮：dock 随之变矮而不是压没画面。
    expect(shortsCommentDockHeight(400)).toBe(400 - SHORTS_COMMENT_DOCK_MIN_STAGE_PX);
    expect(shortsCommentDockHeight(400)).toBeLessThan(400 * SHORTS_COMMENT_DOCK_SHARE);
  });

  test("没有可用高度或极矮视口返回 0（调用方退回整窗口抽屉）", () => {
    for (const height of [0, -1, NaN, Infinity, 200, SHORTS_COMMENT_DOCK_MIN_STAGE_PX]) {
      expect(shortsCommentDockHeight(height)).toBe(0);
    }
  });
});
