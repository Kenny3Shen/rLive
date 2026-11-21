import { describe, expect, test } from "bun:test";
import {
  playerViewportIsLandscape,
  resolvePlayerViewportMatch,
} from "../src/shared/hooks/usePlayerViewport";

const PORTRAIT_QUERY = "(orientation: portrait)";
const COMPACT_QUERY =
  "(max-width: 767px), (orientation: landscape) and (max-height: 540px) and (pointer: coarse)";
const STACKED_QUERY = "(width < 64rem)";

function snapshot(
  overrides: Partial<Parameters<typeof resolvePlayerViewportMatch>[1]> = {},
): Parameters<typeof resolvePlayerViewportMatch>[1] {
  return {
    mobileClient: true,
    landscape: false,
    width: 390,
    height: 844,
    coarsePointer: true,
    mediaMatches: false,
    ...overrides,
  };
}

describe("移动播放器视口方向", () => {
  test("屏幕方向优先于冷启动时仍相反的媒体查询", () => {
    expect(
      resolvePlayerViewportMatch(
        PORTRAIT_QUERY,
        snapshot({ landscape: false, mediaMatches: false }),
      ),
    ).toBe(true);
    expect(
      resolvePlayerViewportMatch(
        PORTRAIT_QUERY,
        snapshot({
          landscape: true,
          width: 844,
          height: 390,
          mediaMatches: true,
        }),
      ),
    ).toBe(false);
  });

  test("没有屏幕方向信息时使用稳定视口宽高", () => {
    expect(playerViewportIsLandscape({ width: 390, height: 844 })).toBe(false);
    expect(playerViewportIsLandscape({ width: 844, height: 390 })).toBe(true);
    expect(playerViewportIsLandscape({ width: 0, height: 844 })).toBeNull();
    expect(playerViewportIsLandscape({ width: 500, height: 500 })).toBeNull();
  });

  test("屏幕方向字段优先于视口回退", () => {
    expect(
      playerViewportIsLandscape({
        orientationType: "landscape-primary",
        width: 390,
        height: 844,
      }),
    ).toBe(true);
    expect(
      playerViewportIsLandscape({
        orientationAngle: 0,
        width: 844,
        height: 390,
      }),
    ).toBe(false);
  });
});

describe("移动播放器宽度断点", () => {
  test("平板竖屏不因移动客户端而永久进入紧凑布局", () => {
    expect(
      resolvePlayerViewportMatch(
        COMPACT_QUERY,
        snapshot({ width: 800, height: 1280, mediaMatches: true }),
      ),
    ).toBe(false);
  });

  test("手机竖屏和矮横屏使用真实宽高判断紧凑布局", () => {
    expect(resolvePlayerViewportMatch(COMPACT_QUERY, snapshot())).toBe(true);
    expect(
      resolvePlayerViewportMatch(
        COMPACT_QUERY,
        snapshot({
          landscape: true,
          width: 844,
          height: 390,
          mediaMatches: false,
        }),
      ),
    ).toBe(true);
  });

  test("堆叠详情严格跟随视口宽度，平板横竖屏都由宽度决定", () => {
    expect(
      resolvePlayerViewportMatch(
        STACKED_QUERY,
        snapshot({ width: 800, height: 1280, mediaMatches: false }),
      ),
    ).toBe(true);
    expect(
      resolvePlayerViewportMatch(
        STACKED_QUERY,
        snapshot({
          landscape: true,
          width: 1280,
          height: 800,
          mediaMatches: true,
        }),
      ),
    ).toBe(false);
  });
});
