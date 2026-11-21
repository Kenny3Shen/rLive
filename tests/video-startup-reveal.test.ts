import { describe, expect, test } from "bun:test";
import {
  lockVideoStartupOrientation,
  shouldRevealVideoStartup,
  videoStartupKeyframes,
} from "../src/shared/motion/videoStartupReveal";

describe("VOD 启动入场", () => {
  test("同一路由 entry 锁定首开方向，后续旋转或换源不改变它", () => {
    const portrait = lockVideoStartupOrientation(null, "entry-a", "portrait");
    expect(lockVideoStartupOrientation(portrait, "entry-a", "landscape")).toBe(portrait);
    expect(lockVideoStartupOrientation(portrait, "entry-b", "landscape")).toEqual({
      entryKey: "entry-b",
      orientation: "landscape",
    });
  });

  test("只在移动端首次放行时揭示，gate 关闭重开同一 entry 不重播", () => {
    const base = {
      ready: true,
      mobileClient: true,
      reducedMotion: false,
      entryKey: "entry-a",
      attemptedEntryKey: null,
    };
    expect(shouldRevealVideoStartup(base)).toBe(true);
    expect(shouldRevealVideoStartup({ ...base, ready: false })).toBe(false);
    expect(shouldRevealVideoStartup({ ...base, mobileClient: false })).toBe(false);
    expect(shouldRevealVideoStartup({ ...base, reducedMotion: true })).toBe(false);
    expect(shouldRevealVideoStartup({ ...base, attemptedEntryKey: "entry-a" })).toBe(false);
    expect(shouldRevealVideoStartup({ ...base, attemptedEntryKey: "entry-0" })).toBe(true);
  });

  test("控制层原位淡入，详情竖屏上移、横屏左移", () => {
    const portrait = videoStartupKeyframes("portrait");
    expect(portrait.chrome).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    expect(portrait.details[0]).toMatchObject({ transform: "translate3d(0, 12px, 0)" });
    expect(portrait.details[1]).toEqual({ opacity: 1, transform: "translate3d(0, 0, 0)" });

    const landscape = videoStartupKeyframes("landscape");
    expect(landscape.details[0]).toMatchObject({ transform: "translate3d(12px, 0, 0)" });
  });
});
