import { describe, expect, test } from "bun:test";
import {
  DETAILS_RESIZE_DIRECTION_RATIO,
  DETAILS_RESIZE_LOCK_DISTANCE_PX,
  DETAILS_SHARE_MIN_PERCENT,
  DETAILS_SHARE_HARD_MAX_PERCENT,
  DETAILS_STAGE_ASPECT_RATIO,
  canResizeVideoDetails,
  detailsContentScrollStep,
  clampDetailsSharePercent,
  detailsResizeCeiling,
  detailsResizeIntent,
  detailsResizeSharePercent,
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
