import { describe, expect, test } from "bun:test";
import {
  BILIBILI_LIVE_DANMAKU_MAX_UTF16_UNITS,
  bilibiliDanmakuUtf16Units,
  insertBilibiliDanmakuText,
  truncateBilibiliDanmaku,
} from "../src/features/room/danmaku/outgoing";
describe("Bilibili outgoing danmaku boundaries", () => {
  test("matches the official web UTF-16-unit limit without splitting emoji", () => {
    expect(BILIBILI_LIVE_DANMAKU_MAX_UTF16_UNITS).toBe(20);
    expect(bilibiliDanmakuUtf16Units("😀".repeat(10))).toBe(20);
    expect(truncateBilibiliDanmaku("😀".repeat(11))).toBe("😀".repeat(10));
    expect(truncateBilibiliDanmaku("中".repeat(21))).toBe("中".repeat(20));
    expect(truncateBilibiliDanmaku("é".repeat(11))).toBe("é".repeat(10));
  });
  test("replaces a selection and returns the restored caret position", () => {
    expect(insertBilibiliDanmakuText("你好世界", "😀", 1, 3)).toEqual({
      draft: "你😀界",
      caret: 3,
    });
    expect(insertBilibiliDanmakuText("a".repeat(19), "😀", 19, 19)).toEqual({
      draft: "a".repeat(19),
      caret: 19,
    });
  });
});
