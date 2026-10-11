import { describe, expect, test } from "bun:test";
import { videoSelectionCount } from "../src/features/video/videoSelectionCount";

/**
 * 选集类卡片的数量文案（合集 / 选集 / 分集共用）。
 *
 * 位置是事实：算得出当前项序号就报 `x/y`，算不出（链接缺 cid、分集表未到、合集
 * 改版后的脏数据）就退回「共 N …」，不编一个序号出来。
 */
describe("选集卡片的数量文案", () => {
  test("定位到当前项时报 x/y，序号从 1 开始", () => {
    expect(videoSelectionCount(0, 12, "个")).toBe("1/12");
    expect(videoSelectionCount(4, 12, "个")).toBe("5/12");
    expect(videoSelectionCount(11, 12, "P")).toBe("12/12");
  });

  test("定位不到时退回总数，单位词随卡片", () => {
    expect(videoSelectionCount(undefined, 12, "个")).toBe("共 12 个");
    expect(videoSelectionCount(-1, 8, "P")).toBe("共 8 P");
    expect(videoSelectionCount(-1, 24, "集")).toBe("共 24 集");
  });

  test("越界的下标不当作位置", () => {
    // 列表换了（换稿件、换剧）但 `currentCid` / `bvid` 还没跟上时可能落到这里，
    // 报 `13/12` 比不报更糟。
    expect(videoSelectionCount(12, 12, "个")).toBe("共 12 个");
    expect(videoSelectionCount(99, 3, "集")).toBe("共 3 集");
  });

  test("空列表也退回总数，不产生 0/0", () => {
    expect(videoSelectionCount(0, 0, "P")).toBe("共 0 P");
    expect(videoSelectionCount(undefined, 0, "集")).toBe("共 0 集");
  });
});
