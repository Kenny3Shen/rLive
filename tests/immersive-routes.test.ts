import { describe, expect, test } from "bun:test";
import { isImmersivePlayerPath } from "../src/app/layout/immersiveRoutes";

describe("immersive player routes", () => {
  test("uses the fullscreen shell for every dedicated playback route", () => {
    expect(isImmersivePlayerPath("/room/bilibili/1")).toBe(true);
    expect(isImmersivePlayerPath("/recordings/play/recording-1")).toBe(true);
    expect(isImmersivePlayerPath("/iptv/play")).toBe(true);
    expect(isImmersivePlayerPath("/video/play")).toBe(true);
    expect(isImmersivePlayerPath("/multi-room")).toBe(true);
  });

  test("keeps discovery and recording library routes in the standard shell", () => {
    expect(isImmersivePlayerPath("/recordings")).toBe(false);
    expect(isImmersivePlayerPath("/recordings/play")).toBe(false);
    expect(isImmersivePlayerPath("/iptv")).toBe(false);
    expect(isImmersivePlayerPath("/room")).toBe(false);
    // 视频发现页不是沉浸表面：它要保留侧栏、头部页签与分区条。
    expect(isImmersivePlayerPath("/video")).toBe(false);
  });
});
