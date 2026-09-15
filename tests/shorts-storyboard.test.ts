import { describe, expect, test } from "bun:test";
import { shortsStoryboardTile } from "../src/features/shorts/shortsStoryboard";
import type { VideoStoryboard } from "../src/shared/types/video";

/**
 * 短视频进度条的缩略图取格。
 *
 * 与 `storyboardVtt.ts` 的区别是这里按秒数直接取一格（自绘进度条要的），
 * 而那边生成 WebVTT 交给 Video.js 自己解析。两者共用的只有雪碧图排布规则，
 * 因此这份测试重点锁「排布算得对」与「边界不越界」。
 */

/** 2×2 一张图、每格 160×90 的最小快照。 */
function board(overrides: Partial<VideoStoryboard> = {}): VideoStoryboard {
  return {
    img_x_len: 2,
    img_y_len: 2,
    img_x_size: 160,
    img_y_size: 90,
    images: ["//i0.hdslb.com/sheet0.jpg"],
    // 规范里首两项恒为 0：第 0 项是占位，第 1 项才是第 0 张图的时间。
    index: [0, 0, 10, 20, 30],
    ...overrides,
  };
}

const SHEETS = ["https://proxy.local/img?url=sheet0"];

describe("缩略图取格", () => {
  test("按时间取最后一个不晚于目标的采样", () => {
    const b = board();
    // 采样点（去掉首个占位后）是 0/10/20/30，各对应第 0~3 格。
    expect(shortsStoryboardTile(b, 0, SHEETS)).toMatchObject({ x: 0, y: 0 });
    expect(shortsStoryboardTile(b, 9.9, SHEETS)).toMatchObject({ x: 0, y: 0 });
    // 第 1 格：同一行右移一格。
    expect(shortsStoryboardTile(b, 10, SHEETS)).toMatchObject({ x: 160, y: 0 });
    expect(shortsStoryboardTile(b, 19, SHEETS)).toMatchObject({ x: 160, y: 0 });
    // 第 2 格：换行。
    expect(shortsStoryboardTile(b, 20, SHEETS)).toMatchObject({ x: 0, y: 90 });
    expect(shortsStoryboardTile(b, 30, SHEETS)).toMatchObject({ x: 160, y: 90 });
  });

  test("超过最后一个采样点时停在最后一格", () => {
    // 拖到结尾（或时长比采样表长）不该返回 null，否则气泡里的图会在末尾消失。
    expect(shortsStoryboardTile(board(), 9999, SHEETS)).toMatchObject({ x: 160, y: 90 });
  });

  test("负数与 0 都取第一格", () => {
    expect(shortsStoryboardTile(board(), -5, SHEETS)).toMatchObject({ x: 0, y: 0 });
  });

  test("首两项不都为 0 时按完整数组起算", () => {
    // 不是所有稿件都带那个占位项；此时第 0 项就是第 0 格的时间。
    const b = board({ index: [0, 10, 20] });
    expect(shortsStoryboardTile(b, 0, SHEETS)).toMatchObject({ x: 0, y: 0 });
    expect(shortsStoryboardTile(b, 10, SHEETS)).toMatchObject({ x: 160, y: 0 });
    expect(shortsStoryboardTile(b, 20, SHEETS)).toMatchObject({ x: 0, y: 90 });
  });

  test("跨雪碧图：格数超过一张就换图", () => {
    const b = board({
      // 2×2 = 每张 4 格，第 5 个采样落到第二张图的第 0 格。
      index: [0, 0, 10, 20, 30, 40],
      images: ["//a/0.jpg", "//a/1.jpg"],
    });
    const sheets = ["https://proxy/0", "https://proxy/1"];
    expect(shortsStoryboardTile(b, 30, sheets)).toMatchObject({
      url: "https://proxy/0",
      x: 160,
      y: 90,
    });
    expect(shortsStoryboardTile(b, 40, sheets)).toMatchObject({
      url: "https://proxy/1",
      x: 0,
      y: 0,
    });
  });

  test("整张雪碧图的尺寸一并给出", () => {
    // CSS background-size 需要整张图的尺寸才能把某一格摆正。
    expect(shortsStoryboardTile(board(), 0, SHEETS)).toMatchObject({
      width: 160,
      height: 90,
      sheetWidth: 320,
      sheetHeight: 180,
    });
  });

  test("缺字段时按规范默认值兜底", () => {
    // 10×10、160×90 是 B 站快照的常见排布；字段为 0 时不该整块失效。
    const b = board({ img_x_len: 0, img_y_len: 0, img_x_size: 0, img_y_size: 0 });
    expect(shortsStoryboardTile(b, 10, SHEETS)).toMatchObject({
      x: 160,
      y: 0,
      width: 160,
      height: 90,
      sheetWidth: 1600,
      sheetHeight: 900,
    });
  });

  test("没有快照或没有图时返回 null", () => {
    // 调用方据此只显示时间气泡：部分稿件确实没有快照。
    expect(shortsStoryboardTile(null, 5, SHEETS)).toBeNull();
    expect(shortsStoryboardTile(undefined, 5, SHEETS)).toBeNull();
    expect(shortsStoryboardTile(board(), 5, [])).toBeNull();
    expect(shortsStoryboardTile(board({ index: [] }), 5, SHEETS)).toBeNull();
  });

  test("图片下标越界时返回 null 而不是取到 undefined", () => {
    // 采样表比图片列表长（上游数据不一致）时，末尾几格没有对应的图。
    const b = board({ index: [0, 0, 10, 20, 30, 40, 50] });
    expect(shortsStoryboardTile(b, 50, SHEETS)).toBeNull();
  });
});
