import { describe, expect, test } from "bun:test";
import { isImmersivePlayerPath, usesOverlayTopBar } from "../src/app/layout/immersiveRoutes";

describe("immersive player routes", () => {
  test("uses the fullscreen shell for every dedicated playback route", () => {
    expect(isImmersivePlayerPath("/room/bilibili/1")).toBe(true);
    expect(isImmersivePlayerPath("/recordings/play/recording-1")).toBe(true);
    expect(isImmersivePlayerPath("/iptv/play")).toBe(true);
    expect(isImmersivePlayerPath("/video/play")).toBe(true);
    expect(isImmersivePlayerPath("/multi-room")).toBe(true);
  });

  test("only removes shell safe-area padding for routes with overlay top bars", () => {
    expect(usesOverlayTopBar("/room/bilibili/1")).toBe(true);
    expect(usesOverlayTopBar("/video/play")).toBe(true);
    expect(usesOverlayTopBar("/video")).toBe(false);
    expect(usesOverlayTopBar("/iptv/play")).toBe(false);
    expect(usesOverlayTopBar("/recordings/play/recording-1")).toBe(false);
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
