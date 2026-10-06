import { describe, expect, test } from "bun:test";
import { normalizeZoomRect, zoomRectTransform } from "../src/shared/motion/pageZoomOrigin";

const scope = { left: 20, top: 32, width: 1000, height: 800 };

describe("播放页来源窗口几何", () => {
  test("卡片坐标扣除标题栏和宿主偏移", () => {
    const rect = normalizeZoomRect({ left: 120, top: 192, width: 200, height: 160 }, scope);
    expect(rect).toEqual({ left: 0.1, top: 0.2, width: 0.2, height: 0.2 });
    expect(zoomRectTransform(rect!)).toBe("translate(-30%, -20%) scale(0.2, 0.2)");
  });

  test("窗口改变尺寸后仍用同一相对位置与大小，不依赖旧像素", () => {
    const rect = normalizeZoomRect({ left: 270, top: 232, width: 500, height: 400 }, scope)!;
    expect(zoomRectTransform(rect)).toBe("translate(0%, 0%) scale(0.5, 0.5)");
  });

  test("裁掉宿主外部分，避免放大越出安全区", () => {
    expect(normalizeZoomRect({ left: -80, top: -48, width: 300, height: 240 }, scope)).toEqual({
      left: 0,
      top: 0,
      width: 0.2,
      height: 0.2,
    });
  });

  test("离屏、零尺寸和非法矩形都退化为无来源", () => {
    for (const rect of [
      { left: 2000, top: 0, width: 100, height: 100 },
      { left: 0, top: 0, width: 0, height: 100 },
      { left: NaN, top: 0, width: 100, height: 100 },
      { left: 0, top: 0, width: Infinity, height: 100 },
    ])
      expect(normalizeZoomRect(rect, scope)).toBeNull();
    expect(normalizeZoomRect(scope, { ...scope, height: 0 })).toBeNull();
  });
});
