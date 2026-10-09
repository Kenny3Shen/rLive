import { describe, expect, test } from "bun:test";
import {
  clampImageZoomScale,
  clampImageZoomTransform,
  formatImageZoomTransform,
  imageZoomAnchorTransform,
  imageZoomIsIdentity,
  imageZoomPanBounds,
  imageZoomRectContains,
  imageZoomReleasedTransform,
  imageZoomStepScale,
  imageZoomWheelDelta,
  imageZoomWheelScale,
  IMAGE_ZOOM_DOUBLE_TAP_SCALE,
  IMAGE_ZOOM_IDENTITY,
  IMAGE_ZOOM_KEY_STEP,
  IMAGE_ZOOM_MAX_SCALE,
  IMAGE_ZOOM_MIN_SCALE,
  type ImageZoomGeometry,
  type ImageZoomTransform,
} from "../src/shared/gestures/imageZoom";

/** 1000×800 的视口，图片 400×300 居中（页与视口同高，中心即视口中心）。 */
const geometry: ImageZoomGeometry = {
  width: 400,
  height: 300,
  viewportWidth: 1000,
  viewportHeight: 800,
  centerX: 500,
  centerY: 400,
};

describe("图片查看器缩放几何", () => {
  test("倍率钳在适配尺寸到上限之间", () => {
    expect(clampImageZoomScale(0.2)).toBe(IMAGE_ZOOM_MIN_SCALE);
    expect(clampImageZoomScale(1.5)).toBe(1.5);
    expect(clampImageZoomScale(99)).toBe(IMAGE_ZOOM_MAX_SCALE);
    for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(clampImageZoomScale(invalid)).toBe(IMAGE_ZOOM_MIN_SCALE);
    }
  });

  test("平移范围只对大过视口的方向开口", () => {
    // 适配尺寸下图片比视口小：两个方向都无处可移。
    expect(imageZoomPanBounds(1, geometry)).toEqual({ x: 0, y: 0 });
    // 4 倍：1600×1200 对 1000×800，各方向余量的一半。
    expect(imageZoomPanBounds(4, geometry)).toEqual({ x: 300, y: 200 });
    // 高图：横向没超、纵向超了，只有纵向可以移。
    expect(imageZoomPanBounds(1, { ...geometry, width: 200, height: 4000 })).toEqual({
      x: 0,
      y: 1600,
    });
  });

  test("钳制先夹倍率再算平移：越界倍率不会带出越界平移", () => {
    const clamped = clampImageZoomTransform({ scale: 99, x: 99999, y: -99999 }, geometry);
    expect(clamped).toEqual({ scale: IMAGE_ZOOM_MAX_SCALE, x: 300, y: -200 });
  });

  test("锚点变换把内容点从 from 搬到 to", () => {
    // 内容点 `from` 变换前落在该处；按式子反推它变换后应落在 `to`。
    const screenOf = (transform: ImageZoomTransform, point: { x: number; y: number }) => ({
      x: geometry.centerX + transform.scale * (point.x - geometry.centerX) + transform.x,
      y: geometry.centerY + transform.scale * (point.y - geometry.centerY) + transform.y,
    });
    const content = { x: 300, y: 250 };
    const from = screenOf(IMAGE_ZOOM_IDENTITY, content);
    const to = { x: 320, y: 260 };
    const next = imageZoomAnchorTransform(geometry, IMAGE_ZOOM_IDENTITY, 2, from, to);
    expect(next.scale).toBe(2);
    // 缩放围绕 `from`：内容点从 `from` 移动到 `to`，位移就是两指中点的位移。
    expect(screenOf(next, content)).toEqual(to);
  });

  test("以当前变换为基准缩放时锚点仍然成立（连续捏合）", () => {
    const screenOf = (transform: ImageZoomTransform, point: { x: number; y: number }) => ({
      x: geometry.centerX + transform.scale * (point.x - geometry.centerX) + transform.x,
      y: geometry.centerY + transform.scale * (point.y - geometry.centerY) + transform.y,
    });
    const content = { x: 620, y: 300 };
    const current: ImageZoomTransform = { scale: 1.4, x: -30, y: 18 };
    const from = screenOf(current, content);
    const to = { x: from.x + 12, y: from.y - 6 };
    const next = imageZoomAnchorTransform(geometry, current, 2.1, from, to);
    const landed = screenOf(next, content);
    expect(landed.x).toBeCloseTo(to.x, 6);
    expect(landed.y).toBeCloseTo(to.y, 6);
  });

  test("几乎没放大的残留直接归位，其余只做范围收口", () => {
    // 1.01 倍：看不出来，但会把翻页手势永久关掉，因此归位。
    expect(imageZoomReleasedTransform({ scale: 1.01, x: 8, y: -6 }, geometry)).toEqual(
      IMAGE_ZOOM_IDENTITY,
    );
    // 2 倍且平移越界：收到边界，仍保持放大态。
    expect(imageZoomReleasedTransform({ scale: 2, x: 9e5, y: 0 }, geometry)).toEqual({
      scale: 2,
      x: 0,
      y: 0,
    });
  });

  test("恒等判定覆盖未放大与残留位移", () => {
    expect(imageZoomIsIdentity(IMAGE_ZOOM_IDENTITY)).toBe(true);
    expect(imageZoomIsIdentity({ scale: 1, x: 0.4, y: -0.4 })).toBe(true);
    expect(imageZoomIsIdentity({ scale: 1, x: 3, y: 0 })).toBe(false);
    expect(imageZoomIsIdentity({ scale: 1.2, x: 0, y: 0 })).toBe(false);
  });

  test("双击倍率留出继续捏合的余量", () => {
    expect(IMAGE_ZOOM_DOUBLE_TAP_SCALE).toBeGreaterThan(IMAGE_ZOOM_MIN_SCALE);
    expect(IMAGE_ZOOM_DOUBLE_TAP_SCALE).toBeLessThan(IMAGE_ZOOM_MAX_SCALE);
  });

  test("滚轮 delta 按 deltaMode 归一化到像素", () => {
    expect(imageZoomWheelDelta(3, 0)).toBe(3);
    expect(imageZoomWheelDelta(3, 1)).toBe(48);
    expect(imageZoomWheelDelta(1, 2)).toBe(100);
  });

  test("滚轮倍率是乘性的，向上滚放大、向下滚缩小", () => {
    const zoomIn = imageZoomWheelScale(1, -100);
    const zoomOut = imageZoomWheelScale(zoomIn, 100);
    expect(zoomIn).toBeGreaterThan(1);
    // 同量反向滚回原处：乘性换算必须可逆，否则来回滚会持续漂移。
    expect(zoomOut).toBeCloseTo(1, 10);
    // 倍率是乘性量：从 2 倍再滚同样一格，得到的比例与从 1 倍起相同。
    expect(imageZoomWheelScale(2, -100) / 2).toBeCloseTo(zoomIn, 10);
  });

  test("触控板捏合（ctrl + wheel）用小 delta 也走得出可见变化", () => {
    // 浏览器把捏合翻译成 ctrl + 小 delta（个位数），走鼠标那档灵敏度几乎不动。
    expect(imageZoomWheelScale(1, -3, 0, true)).toBeGreaterThan(
      imageZoomWheelScale(1, -3, 0, false),
    );
    // 捏合张开是放大，合拢是缩小。
    expect(imageZoomWheelScale(1, -4, 0, true)).toBeGreaterThan(1);
    expect(imageZoomWheelScale(2, 4, 0, true)).toBeLessThan(2);
  });

  test("滚轮不会越出倍率边界", () => {
    expect(imageZoomWheelScale(1, 5000)).toBe(IMAGE_ZOOM_MIN_SCALE);
    expect(imageZoomWheelScale(1, -5000)).toBe(IMAGE_ZOOM_MAX_SCALE);
  });

  test("键盘缩放是一步一档，且不越界", () => {
    expect(imageZoomStepScale(1, 1)).toBeCloseTo(IMAGE_ZOOM_KEY_STEP, 10);
    expect(imageZoomStepScale(IMAGE_ZOOM_KEY_STEP, -1)).toBeCloseTo(1, 10);
    expect(imageZoomStepScale(1, -1)).toBe(IMAGE_ZOOM_MIN_SCALE);
    expect(imageZoomStepScale(IMAGE_ZOOM_MAX_SCALE, 1)).toBe(IMAGE_ZOOM_MAX_SCALE);
  });

  test("矩形命中含边界", () => {
    const rect = { left: 10, top: 20, right: 110, bottom: 220 };
    expect(imageZoomRectContains(rect, 10, 20)).toBe(true);
    expect(imageZoomRectContains(rect, 110, 220)).toBe(true);
    expect(imageZoomRectContains(rect, 60, 120)).toBe(true);
    expect(imageZoomRectContains(rect, 9, 120)).toBe(false);
    expect(imageZoomRectContains(rect, 60, 221)).toBe(false);
  });

  test("内联变换文本定长，可直接比较", () => {
    expect(formatImageZoomTransform(IMAGE_ZOOM_IDENTITY)).toBe("translate3d(0px, 0px, 0) scale(1)");
    expect(formatImageZoomTransform({ scale: 2.5, x: -12.3456, y: 7 })).toBe(
      "translate3d(-12.35px, 7px, 0) scale(2.5)",
    );
  });
});
