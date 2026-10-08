import { describe, expect, test } from "bun:test";
import { videoSelectionDefaultOpen } from "../src/features/video/videoSelectionDefaults";

describe("播放页选集卡片默认展开策略", () => {
  test("移动端三类选集一律默认收起", () => {
    expect(videoSelectionDefaultOpen("parts", { mobile: true })).toBe(false);
    expect(videoSelectionDefaultOpen("season", { mobile: true, multiPart: false })).toBe(false);
    expect(videoSelectionDefaultOpen("season", { mobile: true, multiPart: true })).toBe(false);
    expect(videoSelectionDefaultOpen("episodes", { mobile: true })).toBe(false);
  });

  test("桌面端多 P 与分集展开，合集仅在单独存在时展开", () => {
    expect(videoSelectionDefaultOpen("parts", { mobile: false })).toBe(true);
    expect(videoSelectionDefaultOpen("episodes", { mobile: false })).toBe(true);
    expect(videoSelectionDefaultOpen("season", { mobile: false, multiPart: false })).toBe(true);
    expect(videoSelectionDefaultOpen("season", { mobile: false, multiPart: true })).toBe(false);
  });
});
