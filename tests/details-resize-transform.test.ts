import { describe, expect, test } from "bun:test";
import { detailsResizeTransform } from "../src/shared/gestures/detailsResizeTransform";

const input = {
  containerHeight: 1000,
  stageHeight: 700,
  minPercent: 30,
  maxPercent: 70,
};

describe("详情侧栏拖动期 transform", () => {
  test("相对按下舞台计算：初始位置不缩放、不位移", () => {
    expect(detailsResizeTransform({ ...input, currentPercent: 30 })).toEqual({
      minStageHeight: 300,
      maxAsideHeight: 700,
      currentStageHeight: 700,
      stageScale: 1,
      chromeOffset: 0,
      asideOffset: 0,
      composerOffset: -400,
    });
  });

  test("中途按冻结舞台等比缩小，并让控制栏与侧栏边界重合", () => {
    const transform = detailsResizeTransform({ ...input, currentPercent: 50 });

    expect(transform).not.toBeNull();
    expect(transform!.currentStageHeight).toBe(500);
    expect(transform!.stageScale).toBeCloseTo(5 / 7, 12);
    expect(transform!.chromeOffset).toBe(-200);
    expect(transform!.asideOffset).toBe(-200);
    expect(transform!.composerOffset).toBe(-200);
    expect(transform!.asideOffset).toBe(transform!.chromeOffset);
  });

  test("侧栏上限处视频缩到最小舞台，侧栏与 composer 均不再补偿", () => {
    const transform = detailsResizeTransform({ ...input, currentPercent: 70 });

    expect(transform).not.toBeNull();
    expect(transform!.currentStageHeight).toBe(300);
    expect(transform!.stageScale).toBeCloseTo(3 / 7, 12);
    expect(transform!.chromeOffset).toBe(-400);
    expect(transform!.asideOffset).toBe(-400);
    expect(transform!.composerOffset).toBe(0);
  });

  test("从侧栏上限下拉时相对 Hs 放大，scale 可大于 1", () => {
    const transform = detailsResizeTransform({
      ...input,
      stageHeight: 300,
      currentPercent: 50,
    });

    expect(transform).not.toBeNull();
    expect(transform!.currentStageHeight).toBe(500);
    expect(transform!.stageScale).toBeCloseTo(5 / 3, 12);
    expect(transform!.stageScale).toBeGreaterThan(1);
    expect(transform!.chromeOffset).toBe(200);
    expect(transform!.asideOffset).toBe(200);
    expect(transform!.composerOffset).toBe(-200);
  });

  test("当前占比夹在初始值与上限之间", () => {
    expect(detailsResizeTransform({ ...input, currentPercent: -10 })?.currentStageHeight).toBe(700);
    expect(detailsResizeTransform({ ...input, currentPercent: 90 })?.currentStageHeight).toBe(300);
  });

  test("非法尺寸与边界返回 null", () => {
    for (const value of [
      { ...input, containerHeight: 0 },
      { ...input, containerHeight: Number.NaN },
      { ...input, stageHeight: 0 },
      { ...input, stageHeight: Number.NaN },
      { ...input, minPercent: -1 },
      { ...input, minPercent: 80 },
      { ...input, maxPercent: 101 },
    ]) {
      expect(detailsResizeTransform({ ...value, currentPercent: 30 })).toBeNull();
    }
    expect(detailsResizeTransform({ ...input, currentPercent: Number.NaN })).toBeNull();
    expect(
      detailsResizeTransform({ ...input, minPercent: 80, maxPercent: 70, currentPercent: 75 }),
    ).toBeNull();
  });

  test("缩放比例与三个位移保持同一舞台高度", () => {
    const transform = detailsResizeTransform({ ...input, currentPercent: 42.5 })!;

    expect(input.stageHeight + transform.chromeOffset).toBeCloseTo(
      transform.currentStageHeight,
      12,
    );
    expect(input.stageHeight * transform.stageScale).toBeCloseTo(transform.currentStageHeight, 12);
    expect(input.stageHeight + transform.asideOffset).toBeCloseTo(transform.currentStageHeight, 12);
  });
});
