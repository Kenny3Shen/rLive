import { describe, expect, test } from "bun:test";
import {
  nextAutoDanmakuSegmentIndex,
  normalizeAutoDanmakuText,
  remainingAutoDanmakuSendDelay,
  splitAutoDanmakuText,
  splitGraphemes,
  utf16Units,
} from "../src/features/room/danmaku/autoSend";

describe("automatic danmaku text preparation", () => {
  test("collapses newlines and repeated whitespace into one sendable space", () => {
    expect(normalizeAutoDanmakuText("\n  一起\t\t看   直播  \r\n")).toBe("一起 看 直播");
  });

  test("splits sixteen Chinese characters into ordered fifteen-character messages", () => {
    const text = "弹".repeat(16);
    expect(splitAutoDanmakuText(text, 100)).toEqual({
      normalized: text,
      segments: ["弹".repeat(15), "弹"],
      error: null,
    });
  });

  test("advances through long-text segments and wraps back to the first one", () => {
    const segments = ["第一段", "第二段", "第三段"];
    let index = 0;
    const sent: string[] = [];
    for (let count = 0; count < 5; count += 1) {
      sent.push(segments[index]!);
      index = nextAutoDanmakuSegmentIndex(index, segments.length);
    }

    expect(sent).toEqual(["第一段", "第二段", "第三段", "第一段", "第二段"]);
  });

  test("never shortens the interval when a clock reading moves backwards", () => {
    expect(remainingAutoDanmakuSendDelay(1_000, 11_000)).toBe(0);
    expect(remainingAutoDanmakuSendDelay(1_000, 500)).toBe(10_000);
  });

  test("does not split emoji or combining-character graphemes", () => {
    const family = "👨‍👩‍👧‍👦";
    const result = splitAutoDanmakuText(family.repeat(3), 20);

    expect(result.error).toBeNull();
    expect(result.segments).toEqual([family, family, family]);
    expect(result.segments.every((segment) => splitGraphemes(segment)?.length === 1)).toBe(true);
  });

  test("honours Bilibili's twenty UTF-16-unit limit before the fifteen-grapheme target", () => {
    const result = splitAutoDanmakuText("😀".repeat(11), 20);

    expect(result.error).toBeNull();
    expect(result.segments).toEqual(["😀".repeat(10), "😀"]);
    expect(result.segments.every((segment) => utf16Units(segment) <= 20)).toBe(true);
  });

  test("rejects one grapheme that cannot fit in the platform limit", () => {
    const oneGrapheme = `a${"\u0301".repeat(20)}`;
    const result = splitAutoDanmakuText(oneGrapheme, 20);

    expect(splitGraphemes(oneGrapheme)).toEqual([oneGrapheme]);
    expect(result.segments).toEqual([]);
    expect(result.error).toContain("单个用户可见字符");
  });

  test("fails safely when grapheme segmentation is unavailable", () => {
    expect(splitGraphemes("👨‍👩‍👧‍👦", null)).toBeNull();
  });
});
