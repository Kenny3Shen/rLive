import { describe, expect, test } from "bun:test";
import {
  ANDROID_BACK_EVENT,
  dispatchAndroidBackEvent,
  hasBrowserHistoryEntry,
  isAndroidHomeTabRoot,
  shouldRegisterAndroidBackHandler,
} from "../src/app/androidBackNavigation";

describe("Android Back navigation", () => {
  test("registers the app listener on every Tauri Android route", () => {
    // 根路由也要注册：返回键需要先经过页面，抽屉等浮层才有机会消费。
    expect(
      shouldRegisterAndroidBackHandler({
        userAgent: "Mozilla/5.0 (Linux; Android 15)",
        tauriRuntime: true,
      }),
    ).toBe(true);
    expect(
      shouldRegisterAndroidBackHandler({
        userAgent: "Mozilla/5.0 (Windows NT 10.0)",
        tauriRuntime: true,
      }),
    ).toBe(false);
    expect(
      shouldRegisterAndroidBackHandler({
        userAgent: "Mozilla/5.0 (Linux; Android 15)",
        tauriRuntime: false,
      }),
    ).toBe(false);
  });

  test("bottom-nav roots send Back to the system home screen", () => {
    expect(isAndroidHomeTabRoot("/", "")).toBe(true);
    expect(isAndroidHomeTabRoot("/follow", "")).toBe(true);
    expect(isAndroidHomeTabRoot("/history", "")).toBe(true);
    expect(isAndroidHomeTabRoot("/iptv", "")).toBe(true);
    expect(isAndroidHomeTabRoot("/settings", "")).toBe(true);
    // 空白 section 仍是设置根页。
    expect(isAndroidHomeTabRoot("/settings", "?section=")).toBe(true);
    expect(isAndroidHomeTabRoot("/settings", "?section=%20")).toBe(true);
    // 空白 cat 仍是推荐态首页。
    expect(isAndroidHomeTabRoot("/", "?cat=")).toBe(true);
    expect(isAndroidHomeTabRoot("/", "?cat=%20")).toBe(true);
  });

  test("drilled-down routes keep history rewind", () => {
    expect(isAndroidHomeTabRoot("/settings", "?section=playback")).toBe(false);
    expect(isAndroidHomeTabRoot("/room/bilibili/1", "")).toBe(false);
    // 首页的分区选择态是钻入层：一次 Back 回到推荐流，再一次才退回系统桌面。
    expect(isAndroidHomeTabRoot("/", "?cat=bilibili:1:101")).toBe(false);
    expect(isAndroidHomeTabRoot("/search", "")).toBe(false);
    expect(isAndroidHomeTabRoot("/iptv/play", "")).toBe(false);
    expect(isAndroidHomeTabRoot("/recordings", "")).toBe(false);
  });

  test("allows overlays to consume Back before navigation", () => {
    const target = new EventTarget();
    target.addEventListener(ANDROID_BACK_EVENT, (event) => event.preventDefault());
    expect(dispatchAndroidBackEvent(target)).toBe(true);
  });

  test("recognizes router history entries and direct-link fallbacks", () => {
    expect(hasBrowserHistoryEntry({ idx: 2 })).toBe(true);
    expect(hasBrowserHistoryEntry({ idx: 0 })).toBe(false);
    expect(hasBrowserHistoryEntry({ idx: "2" })).toBe(false);
    expect(hasBrowserHistoryEntry(null)).toBe(false);
  });
});
