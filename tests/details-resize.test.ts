import { describe, expect, test } from "bun:test";
import {
  canResizeVideoDetails,
  clampDetailsSharePercent,
  detailsContentScrollStep,
  detailsMomentumStep,
  detailsResizeLayout,
  detailsResizePressIsHold,
  detailsResizeStepIsVisible,
  detailsResizeVelocity,
  detailsShareCssValue,
  roundDetailsShare,
} from "../src/shared/gestures/detailsResize";
import { LONG_PRESS_TRIGGER_MS } from "../src/shared/gestures/longPress";
describe("内容滑动自适应侧栏", () => {
  test("只启用已知且比 16:9 更高的画幅，容忍编码取整", () => {
    for (const ratio of [null, 0, -1, NaN, Infinity, 16 / 9, 1920 / 1088, 854 / 480, 21 / 9, 6]) {
      expect(canResizeVideoDetails(ratio)).toBe(false);
    }
    for (const ratio of [9 / 16, 4 / 3, 1, 15 / 9]) {
      expect(canResizeVideoDetails(ratio)).toBe(true);
    }
  });
  test("上滑先扩大侧栏，只有超过上限的位移用于滚动", () => {
    expect(detailsContentScrollStep(30, -100, 80, 1000, 70)).toEqual({
      percent: 40,
      scrollDelta: 0,
    });
    const boundary = detailsContentScrollStep(65, -100, 0, 1000, 70);
    expect(boundary.percent).toBe(70);
    expect(boundary.scrollDelta).toBeCloseTo(50);
    expect(detailsContentScrollStep(70, -100, 0, 1000, 70)).toEqual({
      percent: 70,
      scrollDelta: 100,
    });
  });
  test("下滑先滚回顶部，再缩小侧栏；下限不会吞掉剩余位移", () => {
    expect(detailsContentScrollStep(60, 100, 200, 1000, 70)).toEqual({
      percent: 60,
      scrollDelta: -100,
    });
    const top = detailsContentScrollStep(60, 100, 40, 1000, 70);
    expect(top.percent).toBe(54);
    expect(top.scrollDelta).toBeCloseTo(-40);
    const bottom = detailsContentScrollStep(25, 100, 0, 1000, 70);
    expect(bottom.percent).toBe(20);
    expect(bottom.scrollDelta).toBeCloseTo(-50);
  });
  test("上下边界反向滑动立即响应，不必先滑回越界起点", () => {
    const max = detailsContentScrollStep(30, -2000, 0, 1000, 70);
    expect(detailsContentScrollStep(max.percent, 10, 0, 1000, 70).percent).toBe(69);
    const min = detailsContentScrollStep(30, 2000, 0, 1000, 70);
    expect(detailsContentScrollStep(min.percent, -10, 0, 1000, 70).percent).toBe(21);
  });
});
describe("详情侧栏占比换算", () => {
  test("认领门槛用像素而非百分比，边界处的测量偏差不算变化", () => {
    // 上限处按侧栏真实高度反算的占比会与上限差约 0.04%（容器高度只有整数精度），
    // 直接比百分比会把这个偏差读成「还能再拖」，每次到顶都抢走原生滚动。
    const height = 717;
    const percent = 67.63797690845101;
    const cap = 67.67782426778243;
    expect(Math.abs(cap - percent) > 0.0001).toBe(true);
    expect(detailsResizeStepIsVisible(percent, cap, height)).toBe(false);
    // 真能看见的一步：1px 及以上的布局变化才算数。
    expect(detailsResizeStepIsVisible(percent, percent + (1 / height) * 100, height)).toBe(true);
    expect(detailsResizeStepIsVisible(percent, percent + (0.5 / height) * 100, height)).toBe(false);
    // 容器高度不可用时不能凭占比判定。
    expect(detailsResizeStepIsVisible(percent, percent + 50, 0)).toBe(false);
  });
});
describe("原始画幅给出的恢复下限", () => {
  test("多次手势仍能缩回原始布局，下限不跟随每次手势起点抬高", () => {
    for (const ratio of [4 / 3, 1, 9 / 16]) {
      const width = 401;
      const height = 757;
      const layout = detailsResizeLayout(width, height, ratio);
      expect(layout).not.toBeNull();
      const min = layout!.minPercent;
      const max = layout!.maxPercent;
      const expanded = detailsContentScrollStep(min, -100, 0, height, max, min).percent;
      expect(expanded).toBeGreaterThan(min);
      const restored = detailsContentScrollStep(expanded, 2000, 0, height, max, min);
      expect(restored.percent).toBe(min);
      expect(restored.scrollDelta).toBeLessThan(0);
      expect(detailsContentScrollStep(min, 2000, 0, height, max, min)).toEqual({
        percent: min,
        scrollDelta: -2000,
      });
      expect(detailsContentScrollStep(min, -10, 0, height, max, min).percent).toBeGreaterThan(
        min,
      );
      expect(((100 - restored.percent) / 100) * height).toBeCloseTo(
        Math.min(width / ratio, height * 0.7),
        8,
      );
    }
  });
  test("尺寸变化按新布局双向收口，无 16:9 空间时保持固定布局", () => {
    const original = detailsResizeLayout(401, 757, 4 / 3)!;
    const tallerLayout = detailsResizeLayout(401, 1000, 4 / 3)!;
    const taller = clampDetailsSharePercent(
      original.initialPercent,
      tallerLayout.maxPercent,
      tallerLayout.minPercent,
    );
    expect(taller).toBeGreaterThan(original.initialPercent);
    expect(taller).toBe(tallerLayout.initialPercent);
    const shorterLayout = detailsResizeLayout(401, 500, 4 / 3)!;
    const shorter = clampDetailsSharePercent(
      taller,
      shorterLayout.maxPercent,
      shorterLayout.minPercent,
    );
    expect(shorter).toBeLessThan(taller);
    expect(shorter).toBe(shorterLayout.maxPercent);
    expect(detailsResizeLayout(757, 401, 4 / 3)).toBeNull();
    expect(detailsResizeLayout(401, 757, 6)).toBeNull();
  });
});
describe("统一初始与拖动布局", () => {
  test("初始占比就是拖动下限，只有更高的画幅进入联动", () => {
    const layout = detailsResizeLayout(401, 757, 4 / 3);
    expect(layout).not.toBeNull();
    expect(layout!.minPercent).toBe(layout!.initialPercent);
    expect(layout!.maxPercent).toBeGreaterThan(layout!.initialPercent);
    expect(((100 - layout!.maxPercent) / 100) * 757).toBeCloseTo(
      401 / (16 / 9),
      8,
    );
    expect(
      ((100 - layout!.initialPercent) / 100) * 757,
    ).toBeCloseTo(Math.min(401 / (4 / 3), 757 * 0.7), 8);
  });

  test("16:9、超宽、放不下满宽16:9与非法尺寸保持固定布局", () => {
    expect(detailsResizeLayout(401, 757, 16 / 9)).toBeNull();
    expect(detailsResizeLayout(401, 757, 21 / 9)).toBeNull();
    expect(detailsResizeLayout(401, 200, 4 / 3)).toBeNull();
    expect(detailsResizeLayout(0, 757, 4 / 3)).toBeNull();
    expect(detailsResizeLayout(401, 0, 4 / 3)).toBeNull();
  });

  test("占比提交只保留 DOM 写值需要的三位小数", () => {
    expect(detailsShareCssValue(roundDetailsShare(66.66666))).toBe("66.667%");
  });
});
describe("松手后的侧栏惯性", () => {
  test("窗口外的旧采样不参与：末段速度不被早先的慢动作稀释", () => {
    // 前 200ms 只挪 2px，最近 50ms 挪了 30px：应读成 0.6px/ms 而不是平均后的 0.13。
    const samples = [
      {
        time: 0,
        y: 400,
      },
      {
        time: 100,
        y: 399,
      },
      {
        time: 200,
        y: 398,
      },
      {
        time: 250,
        y: 368,
      },
    ];
    expect(detailsResizeVelocity(samples)).toBeCloseTo(-0.6, 8);
    // 把窗口外的采样换成方向相反的一条：只要它落在窗口外就不该影响结果 ——
    // 若把 0ms 那条也算进来，读到的会是 (368 - 300) / 250 = +0.272，方向都反了。
    const withStale = [
      {
        time: 0,
        y: 300,
      },
      ...samples.slice(-2),
    ];
    expect(detailsResizeVelocity(withStale)).toBeCloseTo(-0.6, 8);
    // 只剩窗口外的一条：跨度算不出来，不接惯性。
    expect(
      detailsResizeVelocity([
        {
          time: 0,
          y: 300,
        },
        {
          time: 250,
          y: 368,
        },
      ]),
    ).toBe(0);
  });
  test("松手时末次移动已经过旧，不再沿停顿前的速度启动惯性", () => {
    const samples = [
      { time: 0, y: 300 },
      { time: 50, y: 250 },
    ];

    expect(detailsResizeVelocity(samples, 60)).toBeCloseTo(-50 / 60, 8);
    expect(detailsResizeVelocity(samples, 250)).toBe(0);
    expect(detailsResizeVelocity(samples, Number.NaN)).toBeCloseTo(-1, 8);
  });
  test("单帧时长被夹住：后台恢复的百毫秒不会把惯性一帧走完", () => {
    const velocity = 1;
    const capped = detailsMomentumStep(velocity, 1000);
    const atCap = detailsMomentumStep(velocity, 64);
    expect(capped).toEqual(atCap);
    // 正常一帧不受影响。
    expect(detailsMomentumStep(velocity, 16)).not.toEqual(capped);
  });
});

describe("轴锁前按住与卡片长按互斥", () => {
  test("未满长按时长仍可锁定为调整", () => {
    expect(detailsResizePressIsHold(1000, 1000 + LONG_PRESS_TRIGGER_MS - 1)).toBe(false);
  });

  test("满长按时长仍未锁轴则让位给长按", () => {
    expect(detailsResizePressIsHold(1000, 1000 + LONG_PRESS_TRIGGER_MS)).toBe(true);
    expect(detailsResizePressIsHold(1000, 1000 + 2000)).toBe(true);
  });
});
