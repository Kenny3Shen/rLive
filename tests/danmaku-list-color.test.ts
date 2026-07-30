import { describe, expect, test } from "bun:test";
import {
  danmakuListSurfaceFromTheme,
  resolveDanmakuListUserColor,
} from "../src/features/room/danmaku/listColor";

describe("danmaku list username colour", () => {
  test("rejects Bilibili's default white on the light surface", () => {
    expect(resolveDanmakuListUserColor("#ffffff", "light")).toBeNull();
    expect(resolveDanmakuListUserColor("#fff", "light")).toBeNull();
    expect(resolveDanmakuListUserColor("#FFFFFF", "light")).toBeNull();
  });

  test("keeps white on the dark surface used by the default theme", () => {
    expect(resolveDanmakuListUserColor("#ffffff", "dark")).toBe("#ffffff");
  });

  test("keeps saturated VIP colours that remain readable on light panels", () => {
    expect(resolveDanmakuListUserColor("#e74c3c", "light")).toBe("#e74c3c");
    expect(resolveDanmakuListUserColor("#1e90ff", "light")).toBe("#1e90ff");
    expect(resolveDanmakuListUserColor("#c33", "light")).toBe("#cc3333");
  });

  test("rejects near-black colours on the dark surface", () => {
    expect(resolveDanmakuListUserColor("#000000", "dark")).toBeNull();
    expect(resolveDanmakuListUserColor("#111111", "dark")).toBeNull();
  });

  test("ignores missing or unsafe colour values", () => {
    expect(resolveDanmakuListUserColor(null, "light")).toBeNull();
    expect(resolveDanmakuListUserColor(undefined, "dark")).toBeNull();
    expect(resolveDanmakuListUserColor("red", "light")).toBeNull();
    expect(resolveDanmakuListUserColor("url(javascript:alert(1))", "light")).toBeNull();
  });

  test("maps settings theme modes onto the list surface", () => {
    expect(danmakuListSurfaceFromTheme("light")).toBe("light");
    expect(danmakuListSurfaceFromTheme("dark")).toBe("dark");
    expect(danmakuListSurfaceFromTheme("system", true)).toBe("dark");
    expect(danmakuListSurfaceFromTheme("system", false)).toBe("light");
  });
});
