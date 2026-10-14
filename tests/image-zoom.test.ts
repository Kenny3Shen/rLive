import { describe, expect, test } from "bun:test";
import {
  clampImageZoomTransform,
  imageZoomAnchorTransform,
  imageZoomReleasedTransform,
  imageZoomWheelDelta,
  imageZoomWheelScale,
  IMAGE_ZOOM_IDENTITY,
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
  test("钳制先夹倍率再算平移：越界倍率不会带出越界平移", () => {
    const clamped = clampImageZoomTransform(
      {
        scale: 99,
        x: 99999,
        y: -99999,
      },
      geometry,
    );
    expect(clamped).toEqual({
      scale: IMAGE_ZOOM_MAX_SCALE,
      x: 300,
      y: -200,
    });
  });
  test("以当前变换为基准缩放时锚点仍然成立（连续捏合）", () => {
    const screenOf = (
      transform: ImageZoomTransform,
      point: {
        x: number;
        y: number;
      },
    ) => ({
      x: geometry.centerX + transform.scale * (point.x - geometry.centerX) + transform.x,
      y: geometry.centerY + transform.scale * (point.y - geometry.centerY) + transform.y,
    });
    const content = {
      x: 620,
      y: 300,
    };
    const current: ImageZoomTransform = {
      scale: 1.4,
      x: -30,
      y: 18,
    };
    const from = screenOf(current, content);
    const to = {
      x: from.x + 12,
      y: from.y - 6,
    };
    const next = imageZoomAnchorTransform(geometry, current, 2.1, from, to);
    const landed = screenOf(next, content);
    expect(landed.x).toBeCloseTo(to.x, 6);
    expect(landed.y).toBeCloseTo(to.y, 6);
  });
  test("几乎没放大的残留直接归位，其余只做范围收口", () => {
    // 1.01 倍：看不出来，但会把翻页手势永久关掉，因此归位。
    expect(
      imageZoomReleasedTransform(
        {
          scale: 1.01,
          x: 8,
          y: -6,
        },
        geometry,
      ),
    ).toEqual(IMAGE_ZOOM_IDENTITY);
    // 2 倍且平移越界：收到边界，仍保持放大态。
    expect(
      imageZoomReleasedTransform(
        {
          scale: 2,
          x: 9e5,
          y: 0,
        },
        geometry,
      ),
    ).toEqual({
      scale: 2,
      x: 0,
      y: 0,
    });
  });
  test("滚轮 delta 按 deltaMode 归一化到像素", () => {
    expect(imageZoomWheelDelta(3, 0)).toBe(3);
    expect(imageZoomWheelDelta(3, 1)).toBe(48);
    expect(imageZoomWheelDelta(1, 2)).toBe(100);
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
});
