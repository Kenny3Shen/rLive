import { describe, expect, test } from "bun:test";
import {
  EASE_EMPHASIZED,
  EASE_EXIT,
  EASE_OUT,
  motionProfile,
  SWIPE_SETTLE_EASING,
} from "../src/shared/motion/tokens";

const css = await Bun.file(new URL("../src/styles.css", import.meta.url)).text();

describe("系统感动效契约", () => {
  test("CSS 与 WAAPI 共用语义曲线", () => {
    for (const [name, value] of [
      ["out", EASE_OUT],
      ["emphasized", EASE_EMPHASIZED],
      ["exit", EASE_EXIT],
    ]) {
      expect(css).toContain(`--motion-ease-${name}: ${value};`);
    }
  });

  test("连续页面表面的进出时长与曲线必须一致", () => {
    const profile = motionProfile();
    expect(profile.enter).toEqual(profile.exit);
    expect(profile.enter.ease).toBe(EASE_EMPHASIZED);
    expect(profile.roomZoom.duration).toBeGreaterThanOrEqual(profile.enter.duration);
    expect(profile.roomZoom.duration).toBeLessThanOrEqual(0.36);
  });

  test("直接操作的释放曲线保留初速度，不跟随从静止入场的曲线变化", () => {
    expect(SWIPE_SETTLE_EASING).toBe("cubic-bezier(0.215, 0.61, 0.355, 1)");
    expect(SWIPE_SETTLE_EASING).not.toBe(EASE_OUT);
  });

  test("按下快于松开，关闭快于打开", () => {
    const duration = (name: string) => {
      const match = css.match(new RegExp(`--motion-${name}-duration: (\\d+)ms`));
      expect(match).not.toBeNull();
      return Number(match![1]);
    };
    expect(duration("press")).toBeLessThanOrEqual(100);
    expect(duration("press")).toBeLessThan(duration("release"));
    for (const surface of ["popup", "dialog", "drawer"]) {
      expect(duration(`${surface}-exit`)).toBeLessThan(duration(surface));
    }
  });
});
