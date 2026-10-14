import { describe, expect, test } from "bun:test";
import { danmakuVisibleContentRect } from "../src/features/room/danmaku/LiveDanmaku";
import { isDanmakuPinTap } from "../src/features/room/danmaku/useDanmakuPinInteraction";
describe("floating danmaku selection geometry", () => {
  test("excludes the reserved repeat-count slot from the selection border", () => {
    const content = {
      x: 20,
      y: 30,
      width: 120,
      height: 24,
    };
    const count = {
      x: 140,
      y: 30,
      width: 22,
      height: 24,
    };
    const reservedRoot = {
      x: 20,
      y: 30,
      width: 220,
      height: 24,
    };
    expect(danmakuVisibleContentRect(content, count, 1, reservedRoot)).toEqual(content);
    expect(danmakuVisibleContentRect(content, count, 2, reservedRoot)).toEqual({
      x: 20,
      y: 30,
      width: 142,
      height: 24,
    });
  });
});
describe("floating danmaku pin gesture", () => {
  test("pins on a short press that stayed on the comment", () => {
    expect(isDanmakuPinTap(0, 0, 0)).toBe(true);
    expect(isDanmakuPinTap(6, -8, 200)).toBe(true);
  });
  test("uses the video player's smaller drag threshold", () => {
    expect(isDanmakuPinTap(12, 0, 200, 12)).toBe(true);
    expect(isDanmakuPinTap(13, 0, 200, 12)).toBe(false);
    expect(isDanmakuPinTap(13, 0, 200)).toBe(true);
  });
  test("leaves a drag or a long press to the player stage", () => {
    // 音量或亮度拖拽可能从评论上开始；它必须仍能到达舞台而不是变成钉住。
    expect(isDanmakuPinTap(0, 40, 200)).toBe(false);
    expect(isDanmakuPinTap(0, 0, 400)).toBe(false);
  });
});
