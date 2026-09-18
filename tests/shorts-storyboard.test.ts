import { describe, expect, test } from "bun:test";
import {
  shortsStoryboardSheetUrls,
  shortsStoryboardThumbnails,
} from "../src/features/shorts/shortsStoryboard";
import type { VideoStoryboard } from "../src/shared/types/video";

/**
 * 短视频进度条的缩略图表。
 *
 * 这份测试锁「雪碧图排布算得对」与「边界不越界」：整表交给 Video.js 的
 * `Slider.Thumbnail` 之后，按秒取格由原语承担，但每个采样点落在哪张图的哪一格
 * 仍然是我们算的。与 `storyboardVtt.ts` 共用的只有排布规则，那份另有测试。
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

describe("缩略图表", () => {
  test("逐采样点铺出整表，时间与格位一一对应", () => {
    // 采样点（去掉首个占位后）是 0/10/20/30，各对应第 0~3 格。
    expect(shortsStoryboardThumbnails(board(), SHEETS)).toEqual([
      { url: SHEETS[0], startTime: 0, width: 160, height: 90, coords: { x: 0, y: 0 } },
      { url: SHEETS[0], startTime: 10, width: 160, height: 90, coords: { x: 160, y: 0 } },
      { url: SHEETS[0], startTime: 20, width: 160, height: 90, coords: { x: 0, y: 90 } },
      { url: SHEETS[0], startTime: 30, width: 160, height: 90, coords: { x: 160, y: 90 } },
    ]);
  });

  test("表中每个采样都不晚于自己的时间，且升序", () => {
    // `ThumbnailCore.findActiveThumbnail` 依赖升序与 startTime 语义，取到的必须是
    // 「最后一个不晚于目标时间的采样」。
    const list = shortsStoryboardThumbnails(board(), SHEETS);
    for (let i = 1; i < list.length; i += 1) {
      expect(list[i]!.startTime).toBeGreaterThanOrEqual(list[i - 1]!.startTime);
    }
  });

  test("首两项不都为 0 时按完整数组起算", () => {
    // 不是所有稿件都带那个占位项；此时第 0 项就是第 0 格的时间。
    const list = shortsStoryboardThumbnails(board({ index: [0, 10, 20] }), SHEETS);
    expect(list.map((item) => item.startTime)).toEqual([0, 10, 20]);
    expect(list[1]).toMatchObject({ coords: { x: 160, y: 0 } });
    expect(list[2]).toMatchObject({ coords: { x: 0, y: 90 } });
  });

  test("跨雪碧图：格数超过一张就换图", () => {
    const b = board({
      // 2×2 = 每张 4 格，第 5 个采样落到第二张图的第 0 格。
      index: [0, 0, 10, 20, 30, 40],
      images: ["//a/0.jpg", "//a/1.jpg"],
    });
    const sheets = ["https://proxy/0", "https://proxy/1"];
    const list = shortsStoryboardThumbnails(b, sheets);
    expect(list).toHaveLength(5);
    expect(list[4]).toMatchObject({ url: "https://proxy/1", startTime: 40, coords: { x: 0, y: 0 } });
  });

  test("缺字段时按规范默认值兜底（10×10、160×90）", () => {
    // 字段为 0 时不该整块失效：2×2 的图按默认的 10×10 排布。
    const list = shortsStoryboardThumbnails(
      board({ img_x_len: 0, img_y_len: 0, img_x_size: 0, img_y_size: 0 }),
      SHEETS,
    );
    expect(list).toHaveLength(4);
    // 10 列：第 2 格（时间 10）在第二列，x=160。
    expect(list[1]).toMatchObject({ width: 160, height: 90, coords: { x: 160, y: 0 } });
  });

  test("没有快照、没有图或没有采样时给空表", () => {
    // 调用方据此只显示时间气泡：部分稿件确实没有快照。
    expect(shortsStoryboardThumbnails(null, SHEETS)).toEqual([]);
    expect(shortsStoryboardThumbnails(undefined, SHEETS)).toEqual([]);
    expect(shortsStoryboardThumbnails(board(), [])).toEqual([]);
    expect(shortsStoryboardThumbnails(board({ index: [] }), SHEETS)).toEqual([]);
  });

  test("采样表比图片列表长时在缺图处截断", () => {
    // 第 5 个采样没有对应的雪碧图：整表停在能画出来的最后一格，不显示加载失败。
    const b = board({ index: [0, 0, 10, 20, 30, 40, 50] });
    const list = shortsStoryboardThumbnails(b, SHEETS);
    expect(list.map((item) => item.startTime)).toEqual([0, 10, 20, 30]);
  });

  test("空地址的雪碧图同样截断", () => {
    // 归一化时原始 URL 为空的项会留下 ""，不能让播放器拿它去发请求。
    const b = board({ images: ["", "//a/1.jpg"] });
    expect(shortsStoryboardThumbnails(b, ["", "https://proxy/1"])).toEqual([]);
  });
});

describe("雪碧图地址归一", () => {
  test("没有快照或图片时给空数组", () => {
    expect(shortsStoryboardSheetUrls(null)).toEqual([]);
    expect(shortsStoryboardSheetUrls(undefined)).toEqual([]);
  });

  test("协议相对地址补 https", () => {
    // 代理就绪前会回退直连，因此这里能直接读到归一后的绝对地址。
    expect(shortsStoryboardSheetUrls(board())).toEqual(["https://i0.hdslb.com/sheet0.jpg"]);
  });
});
