import { describe, expect, test } from "bun:test";
import { tokenizeDanmakuContent } from "../src/features/room/danmaku/emoji";

describe("local danmaku emoji tokens", () => {
  test("maps picker Unicode and common Bilibili aliases to local emoji entries", () => {
    expect(tokenizeDanmakuContent("你好😀[doge]！")).toEqual([
      { type: "text", value: "你好" },
      expect.objectContaining({ type: "emoji", value: expect.objectContaining({ id: "smile" }) }),
      expect.objectContaining({ type: "emoji", value: expect.objectContaining({ id: "doge" }) }),
      { type: "text", value: "！" },
    ]);
  });

  test("leaves unrecognised chat text untouched", () => {
    expect(tokenizeDanmakuContent("自定义 [not-an-emote] 🙂")).toEqual([
      { type: "text", value: "自定义 [not-an-emote] 🙂" },
    ]);
  });
});
