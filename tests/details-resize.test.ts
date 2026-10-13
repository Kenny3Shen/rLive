import { describe, expect, test } from "bun:test";
import {
  DETAILS_MOMENTUM_DECAY_MS,
  DETAILS_MOMENTUM_MIN_SPAN_MS,
  DETAILS_MOMENTUM_MIN_VELOCITY,
  DETAILS_MOMENTUM_SAMPLE_LIMIT,
  DETAILS_MOMENTUM_STOP_VELOCITY,
  DETAILS_MOMENTUM_WINDOW_MS,
  DETAILS_RESIZE_DIRECTION_RATIO,
  DETAILS_RESIZE_LOCK_DISTANCE_PX,
  DETAILS_SHARE_MIN_PERCENT,
  DETAILS_SHARE_HARD_MAX_PERCENT,
  DETAILS_STAGE_ASPECT_RATIO,
  canResizeVideoDetails,
  detailsContentScrollStep,
  clampDetailsSharePercent,
  detailsMomentumStep,
  detailsResizeCeiling,
  detailsResizeIntent,
  detailsResizeSharePercent,
  detailsResizeStepIsVisible,
  detailsResizeVelocity,
  detailsShareCssValue,
  detailsShareFromHeights,
  detailsShareMaxPercent,
  detailsShareMinPercent,
  detailsStageMinHeight,
  roundDetailsShare,
} from "../src/shared/gestures/detailsResize";

describe("内容滑动自适应侧栏", () => {
  test("只启用已知非 16:9 画幅，容忍编码取整", () => {
    for (const ratio of [null, 0, -1, NaN, Infinity, 16 / 9, 1920 / 1088, 854 / 480]) {
      expect(canResizeVideoDetails(ratio)).toBe(false);
    }
    for (const ratio of [9 / 16, 4 / 3, 1, 21 / 9]) {
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
  test("向上拖把侧栏拖大、向下拖拖小", () => {
    // 手指向上（deltaY < 0）＝分界上移＝侧栏变高。
    expect(detailsResizeSharePercent(30, -100, 1000)).toBeCloseTo(40, 5);
    expect(detailsResizeSharePercent(30, 100, 1000)).toBeCloseTo(20, 5);
  });

  test("位移按容器高度换算，容器越高同样手势改得越少", () => {
    expect(detailsResizeSharePercent(30, -100, 500)).toBeCloseTo(50, 5);
    expect(detailsResizeSharePercent(30, -100, 2000)).toBeCloseTo(35, 5);
  });

  test("容器高度未知时保持原值，不做除零", () => {
    expect(detailsResizeSharePercent(42, -120, 0)).toBe(42);
    expect(detailsResizeSharePercent(42, -120, Number.NaN)).toBe(42);
  });

  test("上下限是硬停：越界取值原样夹回范围", () => {
    // 手指继续往上推，占比停在容器给出的上限；继续往下推停在下限。
    expect(detailsResizeSharePercent(80, -500, 1000, 70)).toBe(70);
    expect(detailsResizeSharePercent(25, 500, 1000, 70)).toBe(DETAILS_SHARE_MIN_PERCENT);
    expect(clampDetailsSharePercent(140, 70)).toBe(70);
    expect(clampDetailsSharePercent(-40, 70)).toBe(DETAILS_SHARE_MIN_PERCENT);
  });

  test("clamp 对非有限值回落到下限，不产生 NaN 布局", () => {
    expect(clampDetailsSharePercent(Number.NaN)).toBe(DETAILS_SHARE_MIN_PERCENT);
    expect(clampDetailsSharePercent(Number.POSITIVE_INFINITY)).toBe(DETAILS_SHARE_HARD_MAX_PERCENT);
    expect(clampDetailsSharePercent(-40)).toBe(DETAILS_SHARE_MIN_PERCENT);
    expect(clampDetailsSharePercent(140)).toBe(DETAILS_SHARE_HARD_MAX_PERCENT);
  });

  test("轴向锁定：纵向归调占比、横向归翻页、其余继续等", () => {
    expect(detailsResizeIntent(0, -DETAILS_RESIZE_LOCK_DISTANCE_PX)).toBe("resize");
    expect(detailsResizeIntent(0, DETAILS_RESIZE_LOCK_DISTANCE_PX)).toBe("resize");
    expect(detailsResizeIntent(-DETAILS_RESIZE_LOCK_DISTANCE_PX, 0)).toBe("swipe");
    expect(detailsResizeIntent(4, -4)).toBe("pending");
  });

  test("斜向拖动按主轴归属，两套阈值不会同时命中", () => {
    // 明显偏纵向：归调占比。
    expect(detailsResizeIntent(12, -40)).toBe("resize");
    // 明显偏横向：归翻页（横向要压过纵向的 1.25 倍）。
    expect(detailsResizeIntent(-40, 12)).toBe("swipe");
    // 恰在临界比例上：既不满足纵向的 `> |dx|`，也不满足横向的 `> 1.25|dy|`。
    expect(detailsResizeIntent(40, -32)).toBe("pending");
    expect(Math.abs(-40) > 32 * DETAILS_RESIZE_DIRECTION_RATIO).toBe(false);
  });

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

  test("起算占比按侧栏真实高度量取，未拖动过时也不跳变", () => {
    expect(detailsShareFromHeights(531.4, 757)).toBeCloseTo(70.2, 1);
    expect(detailsShareFromHeights(0, 757)).toBe(0);
    expect(detailsShareFromHeights(100, 0)).toBe(DETAILS_SHARE_MIN_PERCENT);
  });

  test("CSS 取值仅收回物理范围，不能截断合法的超宽原始占比", () => {
    expect(detailsShareCssValue(41.23456)).toBe("41.235%");
    expect(detailsShareCssValue(999)).toBe("100.000%");
    expect(detailsShareCssValue(Number.NaN)).toBe("0.000%");
    expect(detailsShareCssValue(-1)).toBe("0.000%");
    expect(roundDetailsShare(92.34567)).toBe(92.346);
    expect(detailsShareCssValue(92.34567)).toBe("92.346%");
    expect(Number.parseFloat(detailsShareCssValue(92.34567))).toBe(roundDetailsShare(92.34567));
  });
});

describe("16:9 视频窗口给的占比上限", () => {
  test("满宽 16:9 的高度按宽度换算", () => {
    expect(detailsStageMinHeight(1600)).toBeCloseTo(900, 5);
    expect(detailsStageMinHeight(401)).toBeCloseTo(401 / DETAILS_STAGE_ASPECT_RATIO, 5);
    // 宽度不可用时不参与约束。
    expect(detailsStageMinHeight(0)).toBe(0);
    expect(detailsStageMinHeight(Number.NaN)).toBe(0);
  });

  test("上限随容器形状变化：越宽给侧栏的越少，越高给的越多", () => {
    // 该约束等价于「舞台留出一个满宽 16:9 的高度」：
    // share ≤ (1 − width / (16/9) / height) × 100。
    const width = 401;
    const height = 757;
    const percent = detailsShareMaxPercent(width, height);
    expect(percent).toBeCloseTo((1 - width / (16 / 9) / height) * 100, 5);
    // 401×757 的手机上约 70.2%，对应满宽 16:9 舞台，而非竖屏源画幅的默认布局。
    expect(percent).toBeCloseTo(70.2, 1);
    expect(detailsShareMaxPercent(width, height * 2)).toBeGreaterThan(percent);
    expect(detailsShareMaxPercent(width * 2, height)).toBeLessThan(percent);
  });

  test("容器矮到 16:9 放不下时回退到硬顶，不把侧栏顶到下限或以下", () => {
    // 横屏手机：满宽 16:9 比容器还高，解出的份额低于下限，没有任何取值能满足
    // 该约束 —— 此时硬夹会把侧栏顶到下限甚至更低，用户连往上拖的余地都没有。
    expect(detailsShareMaxPercent(800, 360)).toBe(DETAILS_SHARE_HARD_MAX_PERCENT);
    // 约束要求份额 ≤ 10%，而侧栏最小就是 20%，同样在可达到的范围内无解（
    // 16:9 窗口高 900px，容器 1000px，但 80% 的容器高只有 800px）。
    expect(detailsShareMaxPercent(1600, 1000)).toBe(DETAILS_SHARE_HARD_MAX_PERCENT);
    expect(detailsShareMaxPercent(1600, 900)).toBe(DETAILS_SHARE_HARD_MAX_PERCENT);
  });

  test("约束刚好可满足的那一刻起就不再回退", () => {
    // 临界点是「约束给出的份额 == 下限」，即满宽 16:9 恰好占容器高的 80%：
    // height = width / (16/9) / 0.8。恰好落在临界点上时算得的份额受浮点误差
    // 影响（19.999…%），会落进「不可满足」那一支；这里只需验证两侧各自稳定 ——
    // 比临界点高就恢复约束，矮就回退到手势自己的完整量程。
    const width = 401;
    const thresholdHeight = detailsStageMinHeight(width) / 0.8;
    const justAbove = detailsShareMaxPercent(width, thresholdHeight + 1);
    expect(justAbove).toBeGreaterThan(DETAILS_SHARE_MIN_PERCENT);
    expect(justAbove).toBeLessThan(DETAILS_SHARE_HARD_MAX_PERCENT);
    expect(detailsShareMaxPercent(width, thresholdHeight - 1)).toBe(DETAILS_SHARE_HARD_MAX_PERCENT);
  });

  test("容器尺寸不可用时回退到硬顶", () => {
    expect(detailsShareMaxPercent(0, 757)).toBe(DETAILS_SHARE_HARD_MAX_PERCENT);
    expect(detailsShareMaxPercent(401, 0)).toBe(DETAILS_SHARE_HARD_MAX_PERCENT);
    expect(detailsShareMaxPercent(Number.NaN, Number.NaN)).toBe(DETAILS_SHARE_HARD_MAX_PERCENT);
  });

  test("默认布局已经超出 16:9 约束时只能往小拖，不会被弹掉一截", () => {
    // 横画幅视频按比值撑高：401 宽、16:9 的舞台是 225.6px，侧栏默认 70.2%；
    // 而横屏手机（800×360）的 16:9 约束根本放不下，回退到硬顶 → 上限即起点。
    const start = 70.2;
    expect(detailsResizeCeiling(start, 800, 360)).toBe(
      Math.max(start, DETAILS_SHARE_HARD_MAX_PERCENT),
    );
    // 竖屏手机从默认占比开始：上限就是 16:9 约束值（70.2%），与起点相同。
    expect(detailsResizeCeiling(start, 401, 757)).toBeCloseTo(70.2, 1);
    // 已经拖到约束内之后，上限就是约束值本身，不会跟着起点继续放宽。
    expect(detailsResizeCeiling(40, 401, 757)).toBeCloseTo(70.2, 1);
    // 起点无效（尺寸量失败）时退到约束值。
    expect(detailsResizeCeiling(Number.NaN, 401, 757)).toBeCloseTo(70.2, 1);
  });

  test("从约束内往上拖停在约束上，舞台仍放得下满宽 16:9", () => {
    const width = 401;
    const height = 757;
    const ceiling = detailsResizeCeiling(30, width, height);
    const dragged = detailsResizeSharePercent(30, -100000, height, ceiling);
    expect(dragged).toBeCloseTo(ceiling, 5);
    // 舞台高度 = 容器 − 侧栏，必须仍 ≥ 满宽 16:9 的高度。
    const stageHeight = ((100 - dragged) / 100) * height;
    expect(stageHeight).toBeGreaterThanOrEqual(detailsStageMinHeight(width) - 0.001);
  });

  test("舞台让出的高度精确加回侧栏，总和始终守恒", () => {
    for (const [width, height] of [
      [401, 757],
      [900, 1200],
      [1280, 800],
    ]) {
      const ceiling = detailsResizeCeiling(30, width, height);
      if (ceiling <= DETAILS_SHARE_MIN_PERCENT) continue;
      const stageHeight = ((100 - ceiling) / 100) * height;
      const detailsHeight = (ceiling / 100) * height;
      expect(stageHeight + detailsHeight).toBeCloseTo(height, 5);
      // 只有「16:9 放得下」的容器才受约束。
      if (detailsShareMaxPercent(width, height) < DETAILS_SHARE_HARD_MAX_PERCENT) {
        expect(stageHeight).toBeGreaterThanOrEqual(detailsStageMinHeight(width) - 0.001);
      }
    }
  });
});

describe("原始画幅给出的恢复下限", () => {
  test("4:3、方形与竖屏按原始高度恢复，最多保留70%舞台", () => {
    const width = 401;
    const height = 757;
    expect(detailsShareMinPercent(width, height, 4 / 3)).toBeCloseTo(
      (1 - width / (4 / 3) / height) * 100,
      8,
    );
    expect(detailsShareMinPercent(width, height, 1)).toBeCloseTo((1 - width / height) * 100, 8);
    expect(detailsShareMinPercent(width, height, 9 / 16)).toBe(30);
    expect(detailsShareMinPercent(800, 360, 4 / 3)).toBe(30);
    expect(detailsShareMinPercent(width, height, 16 / 9)).toBeCloseTo(
      detailsShareMaxPercent(width, height),
      8,
    );
  });

  test("未提供有效尺寸或画幅时仍使用兼容下限", () => {
    for (const ratio of [null, 0, -1, NaN, Infinity]) {
      expect(detailsShareMinPercent(401, 757, ratio)).toBe(DETAILS_SHARE_MIN_PERCENT);
    }
    for (const size of [0, -1, NaN, Infinity]) {
      expect(detailsShareMinPercent(size, 757, 4 / 3)).toBe(DETAILS_SHARE_MIN_PERCENT);
      expect(detailsShareMinPercent(401, size, 4 / 3)).toBe(DETAILS_SHARE_MIN_PERCENT);
    }
  });

  test("多次手势仍能缩回原始布局，下限不跟随每次手势起点抬高", () => {
    for (const ratio of [4 / 3, 1, 9 / 16]) {
      const width = 401;
      const height = 757;
      const min = detailsShareMinPercent(width, height, ratio);
      const max = detailsResizeCeiling(min, width, height, min);
      const expanded = detailsContentScrollStep(min, -100, 0, height, max, min).percent;
      expect(expanded).toBeGreaterThan(min);
      const nextMax = detailsResizeCeiling(expanded, width, height, min);
      const restored = detailsContentScrollStep(expanded, 2000, 0, height, nextMax, min);
      expect(restored.percent).toBe(min);
      expect(restored.scrollDelta).toBeLessThan(0);
      expect(detailsContentScrollStep(min, 2000, 0, height, nextMax, min)).toEqual({
        percent: min,
        scrollDelta: -2000,
      });
      expect(detailsContentScrollStep(min, -10, 0, height, nextMax, min).percent).toBeGreaterThan(
        min,
      );
      expect(((100 - restored.percent) / 100) * height).toBeCloseTo(
        Math.min(width / ratio, height * 0.7),
        8,
      );
    }
  });

  test("动态下限保留下滑滚动优先与边界剩余位移", () => {
    const min = detailsShareMinPercent(400, 1000, 1);
    expect(min).toBe(60);
    expect(detailsContentScrollStep(70, 100, 200, 1000, 80, min)).toEqual({
      percent: 70,
      scrollDelta: -100,
    });
    const step = detailsContentScrollStep(70, 300, 40, 1000, 80, min);
    expect(step.percent).toBe(min);
    expect(step.scrollDelta).toBeCloseTo(-200, 8);
    expect(detailsContentScrollStep(min, 100, 200, 1000, 80, min)).toEqual({
      percent: min,
      scrollDelta: -100,
    });
  });

  test("21:9和极宽画幅以原始布局硬停，超过85%的占比也完整传到CSS与提交", () => {
    for (const ratio of [21 / 9, 6, 10]) {
      const width = 401;
      const height = 757;
      const min = detailsShareMinPercent(width, height, ratio);
      const max = detailsResizeCeiling(min, width, height, min);
      expect(max).toBe(min);
      for (const delta of [-2000, 2000]) {
        expect(detailsContentScrollStep(min, delta, 0, height, max, min)).toEqual({
          percent: min,
          scrollDelta: -delta,
        });
      }
      const clamped = clampDetailsSharePercent(30, detailsShareMaxPercent(width, height), min);
      expect(clamped).toBe(min);
      const committed = roundDetailsShare(clamped);
      const css = Number.parseFloat(detailsShareCssValue(clamped));
      expect(css).toBe(committed);
      expect(css).toBeCloseTo(min, 3);
      if (ratio >= 6) expect(css).toBeGreaterThan(DETAILS_SHARE_HARD_MAX_PERCENT);
    }
  });

  test("尺寸与画幅变化按新原始布局双向收口，上限仍保住满宽16:9", () => {
    const constrain = (current: number, width: number, height: number, ratio: number) =>
      clampDetailsSharePercent(
        current,
        detailsShareMaxPercent(width, height),
        detailsShareMinPercent(width, height, ratio),
      );
    const original = detailsShareMinPercent(401, 757, 4 / 3);
    const taller = constrain(original, 401, 1000, 4 / 3);
    expect(taller).toBeGreaterThan(original);
    expect(taller).toBe(detailsShareMinPercent(401, 1000, 4 / 3));
    const shorter = constrain(taller, 401, 500, 4 / 3);
    expect(shorter).toBeLessThan(taller);
    expect(shorter).toBe(detailsShareMaxPercent(401, 500));
    expect(constrain(80, 757, 401, 4 / 3)).toBe(80);
    const wide = constrain(shorter, 401, 757, 6);
    expect(wide).toBeGreaterThan(85);
    expect(constrain(wide, 401, 757, 9 / 16)).toBe(detailsShareMaxPercent(401, 757));
  });
});

describe("松手后的侧栏惯性", () => {
  test("速度取最近 100ms 的位移，向上为负", () => {
    // 200px/s 上滑：100ms 走 20px。
    expect(detailsResizeVelocity([
      { time: 0, y: 400 },
      { time: 50, y: 390 },
      { time: 100, y: 380 },
    ])).toBeCloseTo(-0.2, 8);
    expect(detailsResizeVelocity([
      { time: 0, y: 380 },
      { time: 100, y: 400 },
    ])).toBeCloseTo(0.2, 8);
  });

  test("窗口外的旧采样不参与：末段速度不被早先的慢动作稀释", () => {
    // 前 200ms 只挪 2px，最近 50ms 挪了 30px：应读成 0.6px/ms 而不是平均后的 0.13。
    const samples = [
      { time: 0, y: 400 },
      { time: 100, y: 399 },
      { time: 200, y: 398 },
      { time: 250, y: 368 },
    ];
    expect(detailsResizeVelocity(samples)).toBeCloseTo(-0.6, 8);
    // 把窗口外的采样换成方向相反的一条：只要它落在窗口外就不该影响结果 ——
    // 若把 0ms 那条也算进来，读到的会是 (368 - 300) / 250 = +0.272，方向都反了。
    const withStale = [{ time: 0, y: 300 }, ...samples.slice(-2)];
    expect(detailsResizeVelocity(withStale)).toBeCloseTo(-0.6, 8);
    // 只剩窗口外的一条：跨度算不出来，不接惯性。
    expect(detailsResizeVelocity([{ time: 0, y: 300 }, { time: 250, y: 368 }])).toBe(0);
  });

  test("采样不足、跨度太短或取值无效时不接惯性", () => {
    expect(detailsResizeVelocity([])).toBe(0);
    expect(detailsResizeVelocity([{ time: 0, y: 400 }])).toBe(0);
    // 跨度 < 16ms：1px 的坐标取整就能放大成极大速度。
    expect(
      detailsResizeVelocity([
        { time: 0, y: 400 },
        { time: DETAILS_MOMENTUM_MIN_SPAN_MS - 1, y: 200 },
      ]),
    ).toBe(0);
    expect(
      detailsResizeVelocity([
        { time: 0, y: 400 },
        { time: Number.NaN, y: 300 },
        { time: 60, y: 200 },
      ]),
    ).toBeCloseTo(-200 / 60, 8);
    expect(detailsResizeVelocity([{ time: Number.NaN, y: Number.NaN }])).toBe(0);
    // 采样窗口本身就是 100ms：更长的跨度自然被截断在窗口边界上。
    expect(DETAILS_MOMENTUM_WINDOW_MS).toBe(100);
    expect(DETAILS_MOMENTUM_SAMPLE_LIMIT).toBeGreaterThanOrEqual(3);
  });

  test("位移是速度的积分：总位移收敛到 v₀·τ，速度按 e^(-t/τ) 衰减", () => {
    const velocity = 0.8;
    const dt = 16;
    const one = detailsMomentumStep(velocity, dt);
    // 单步位移等于该段时间上速度的积分。
    expect(one.delta).toBeCloseTo(
      velocity * DETAILS_MOMENTUM_DECAY_MS * (1 - Math.exp(-dt / DETAILS_MOMENTUM_DECAY_MS)),
      8,
    );
    expect(one.velocity).toBeCloseTo(velocity * Math.exp(-dt / DETAILS_MOMENTUM_DECAY_MS), 8);
    // 逐帧累加：总位移逼近 v₀·τ，速度单调衰减。
    let total = 0;
    let current = velocity;
    let previous = velocity;
    for (let i = 0; i < 400; i += 1) {
      const step = detailsMomentumStep(current, dt);
      total += step.delta;
      current = step.velocity;
      expect(Math.abs(current)).toBeLessThanOrEqual(Math.abs(previous) + 1e-12);
      previous = current;
    }
    expect(total).toBeCloseTo(velocity * DETAILS_MOMENTUM_DECAY_MS, 2);
    expect(Math.abs(current)).toBeLessThan(DETAILS_MOMENTUM_STOP_VELOCITY);
  });

  test("单帧时长被夹住：后台恢复的百毫秒不会把惯性一帧走完", () => {
    const velocity = 1;
    const capped = detailsMomentumStep(velocity, 1000);
    const atCap = detailsMomentumStep(velocity, 64);
    expect(capped).toEqual(atCap);
    // 正常一帧不受影响。
    expect(detailsMomentumStep(velocity, 16)).not.toEqual(capped);
  });

  test("启动阈值与停止阈值形成滞回，非法取值立即停下", () => {
    // 启动门槛高于停止门槛：接上惯性后能在低于启动速度的区间里继续跑一段。
    expect(DETAILS_MOMENTUM_MIN_VELOCITY).toBeGreaterThan(DETAILS_MOMENTUM_STOP_VELOCITY);
    expect(DETAILS_MOMENTUM_MIN_VELOCITY).toBeGreaterThan(0);
    expect(detailsMomentumStep(Number.NaN, 16)).toEqual({ delta: 0, velocity: 0 });
    expect(detailsMomentumStep(Number.POSITIVE_INFINITY, 16)).toEqual({ delta: 0, velocity: 0 });
    // 非正时长不推进，速度原样保留。
    expect(detailsMomentumStep(0.5, 0)).toEqual({ delta: 0, velocity: 0.5 });
    expect(detailsMomentumStep(0.5, Number.NaN)).toEqual({ delta: 0, velocity: 0.5 });
  });

  test("惯性位移交给同一套分配逻辑：仍先滚内容、到顶再缩侧栏", () => {
    // 下滑（delta > 0）时先滚回内容顶部，剩余位移才缩小侧栏。
    const scrollOnly = detailsContentScrollStep(60, 100, 200, 1000, 70);
    expect(scrollOnly).toEqual({ percent: 60, scrollDelta: -100 });
    const withResize = detailsContentScrollStep(60, 100, 40, 1000, 70);
    expect(withResize.percent).toBe(54);
    expect(withResize.scrollDelta).toBeCloseTo(-40, 8);
    // 上滑超过上限后剩余位移用于滚动，不会丢。
    const atCeiling = detailsContentScrollStep(70, -100, 0, 1000, 70);
    expect(atCeiling).toEqual({ percent: 70, scrollDelta: 100 });
  });

  test("一次快速上滑的惯性位移量级合理：不超过一个手指滑动的高度", () => {
    // 0.8px/ms（800px/s）的松手速度，指数衰减下总位移约 260px ——
    // 相当于再滑 1/3 个屏幕，不会把侧栏一路顶到上限。
    let total = 0;
    let velocity = 0.8;
    for (let i = 0; i < 200; i += 1) {
      const step = detailsMomentumStep(velocity, 16);
      total += step.delta;
      velocity = step.velocity;
    }
    expect(total).toBeGreaterThan(150);
    expect(total).toBeLessThan(400);
  });
});
