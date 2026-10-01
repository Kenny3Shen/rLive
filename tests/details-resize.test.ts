import { describe, expect, test } from "bun:test";
import {
  DETAILS_RESIZE_DIRECTION_RATIO,
  DETAILS_RESIZE_LOCK_DISTANCE_PX,
  DETAILS_RESIZE_OVERSHOOT_DAMPING,
  DETAILS_SHARE_MAX_PERCENT,
  DETAILS_SHARE_MIN_PERCENT,
  clampDetailsSharePercent,
  detailsResizeIntent,
  detailsResizeSharePercent,
  detailsShareCssValue,
  detailsShareFromHeights,
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

  test("越界只走阻尼，松手后由 clamp 收回范围内", () => {
    const overshoot = detailsResizeSharePercent(DETAILS_SHARE_MAX_PERCENT, -500, 1000);
    expect(overshoot).toBeGreaterThan(DETAILS_SHARE_MAX_PERCENT);
    // 阻尼系数越小越「硬」，但必须仍然有一小段可感知的过冲。
    expect(overshoot).toBeCloseTo(
      DETAILS_SHARE_MAX_PERCENT + 50 * DETAILS_RESIZE_OVERSHOOT_DAMPING,
      5,
    );
    expect(clampDetailsSharePercent(overshoot)).toBe(DETAILS_SHARE_MAX_PERCENT);

    const undershoot = detailsResizeSharePercent(DETAILS_SHARE_MIN_PERCENT, 500, 1000);
    expect(undershoot).toBeLessThan(DETAILS_SHARE_MIN_PERCENT);
    expect(clampDetailsSharePercent(undershoot)).toBe(DETAILS_SHARE_MIN_PERCENT);
  });

  test("clamp 对非有限值回落到下限，不产生 NaN 布局", () => {
    expect(clampDetailsSharePercent(Number.NaN)).toBe(DETAILS_SHARE_MIN_PERCENT);
    expect(clampDetailsSharePercent(Number.POSITIVE_INFINITY)).toBe(DETAILS_SHARE_MAX_PERCENT);
    expect(clampDetailsSharePercent(-40)).toBe(DETAILS_SHARE_MIN_PERCENT);
    expect(clampDetailsSharePercent(140)).toBe(DETAILS_SHARE_MAX_PERCENT);
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
    expect(detailsShareCssValue(999)).toBe(`${DETAILS_SHARE_MAX_PERCENT.toFixed(3)}%`);
    expect(detailsShareCssValue(Number.NaN)).toBe(`${DETAILS_SHARE_MIN_PERCENT.toFixed(3)}%`);
  });

  test("舞台让位的那条规则同时认下两个标记", async () => {
    const css = await Bun.file(new URL("../src/styles.css", import.meta.url)).text();
    // `-share` 是 React 提交后的持久状态，`-resizing` 是手势逐帧写的临时状态；
    // 只认一个就会在拖动中（或提交那一帧）跳回画幅比高度。
    expect(css).toContain('[data-video-details-frame][data-vod-details-share="true"]');
    expect(css).toContain('[data-video-details-frame][data-vod-details-resizing="true"]');
  });

  test("启用拖动的宽度阈值与样式表那条媒体查询同源", async () => {
    const css = await Bun.file(new URL("../src/styles.css", import.meta.url)).text();
    const viewport = await Bun.file(
      new URL("../src/shared/hooks/usePlayerViewport.ts", import.meta.url),
    ).text();
    // 媒体查询里换宽度档（比如改回 `max-width: 1023px`）而 hook 没跟着改，
    // 就会出现「手势开着但拖不动」或「能拖动但手势没开」，这类错位只有真机才看得出来。
    const cssQuery = css.match(/@media \(width < 64rem\)/g) ?? [];
    expect(cssQuery.length).toBeGreaterThanOrEqual(1);
    expect(viewport).toContain('STACKED_DETAILS_QUERY = "(width < 64rem)"');
  });
});
