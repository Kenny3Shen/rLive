import { describe, expect, test } from "bun:test";
import {
  DETAILS_RESIZE_DIRECTION_RATIO,
  DETAILS_RESIZE_LOCK_DISTANCE_PX,
  DETAILS_SHARE_MIN_PERCENT,
  DETAILS_SHARE_HARD_MAX_PERCENT,
  DETAILS_STAGE_ASPECT_RATIO,
  clampDetailsSharePercent,
  detailsResizeCeiling,
  detailsResizeIntent,
  detailsResizeSharePercent,
  detailsShareCssValue,
  detailsShareFromHeights,
  detailsShareMaxPercent,
  detailsStageMinHeight,
} from "../src/shared/gestures/detailsResize";

describe("详情侧栏占比拖动", () => {
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
    expect(clampDetailsSharePercent(Number.POSITIVE_INFINITY)).toBe(
      DETAILS_SHARE_HARD_MAX_PERCENT,
    );
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

  test("CSS 取值始终是收回范围内的百分比", () => {
    expect(detailsShareCssValue(41.23456)).toBe("41.235%");
    expect(detailsShareCssValue(999)).toBe(`${DETAILS_SHARE_HARD_MAX_PERCENT.toFixed(3)}%`);
    expect(detailsShareCssValue(Number.NaN)).toBe(`${DETAILS_SHARE_MIN_PERCENT.toFixed(3)}%`);
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
    // 401×757 的手机上恰好落在竖屏视频未拖动时的默认占比（约 70.2%），
    // 即「竖屏画面铺满舞台」那个位置。
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
    expect(detailsShareMaxPercent(width, thresholdHeight - 1)).toBe(
      DETAILS_SHARE_HARD_MAX_PERCENT,
    );
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
    expect(detailsResizeCeiling(start, 800, 360)).toBe(Math.max(start, DETAILS_SHARE_HARD_MAX_PERCENT));
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
