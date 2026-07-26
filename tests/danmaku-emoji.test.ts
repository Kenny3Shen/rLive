import { describe, expect, test } from "bun:test";
import {
  BILIBILI_NATIVE_TEXT_EMOJIS,
  tokenizeDanmakuContent,
} from "../src/features/room/danmaku/emoji";

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

  test("keeps the picker aligned with Bilibili Live's native text faces", () => {
    expect(BILIBILI_NATIVE_TEXT_EMOJIS).toHaveLength(41);
    expect(BILIBILI_NATIVE_TEXT_EMOJIS).toEqual(
      expect.arrayContaining(["(⌒▽⌒)", "(=・ω・=)", "(汗)", "(苦笑)"]),
    );
    expect(BILIBILI_NATIVE_TEXT_EMOJIS).not.toContain("😀");
  });
});
