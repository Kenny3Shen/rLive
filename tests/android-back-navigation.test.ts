import { describe, expect, test } from "bun:test";
import {
  ANDROID_BACK_EVENT,
  dispatchAndroidBackEvent,
  hasBrowserHistoryEntry,
  shouldRegisterAndroidBackHandler,
} from "../src/app/androidBackNavigation";

describe("Android Back navigation", () => {
  test("only registers an app listener for non-root Tauri Android routes", () => {
    expect(
      shouldRegisterAndroidBackHandler({
        pathname: "/room/bilibili/1",
        userAgent: "Mozilla/5.0 (Linux; Android 15)",
        tauriRuntime: true,
      }),
    ).toBe(true);
    expect(
      shouldRegisterAndroidBackHandler({
        pathname: "/",
        userAgent: "Mozilla/5.0 (Linux; Android 15)",
        tauriRuntime: true,
      }),
    ).toBe(false);
    expect(
      shouldRegisterAndroidBackHandler({
        pathname: "/settings",
        userAgent: "Mozilla/5.0 (Windows NT 10.0)",
        tauriRuntime: true,
      }),
    ).toBe(false);
  });

  test("allows room overlays to consume Back before router navigation", () => {
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
