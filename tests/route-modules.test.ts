import { describe, expect, test } from "bun:test";
import { shouldSkipIdleRoutePreloading } from "../src/app/RouteModulePreloader";
import {
  createCachedRouteLoader,
  loadCategoryBrowsePage,
  loadFollowPage,
  loadHistoryPage,
  loadIptvPage,
  loadIptvPlayerPage,
  loadMultiRoomPage,
  loadRecordingsPage,
  loadRecordingPlaybackPage,
  loadRoomPage,
  loadSearchPage,
  loadSettingsPage,
  routeModuleLoaderForPath,
} from "../src/app/routeModules";

describe("route module loading", () => {
  test("shares one in-flight and resolved module promise", async () => {
    let calls = 0;
    const load = createCachedRouteLoader(async () => {
      calls += 1;
      return { default: () => null };
    });

    const first = load();
    const second = load();

    expect(second).toBe(first);
    await first;
    expect(load()).toBe(first);
    expect(calls).toBe(1);
  });

  test("allows a failed preload to be retried by navigation", async () => {
    let calls = 0;
    const load = createCachedRouteLoader(() => {
      calls += 1;
      return calls === 1
        ? Promise.reject(new Error("temporary import failure"))
        : Promise.resolve({ default: () => null });
    });

    await expect(load()).rejects.toThrow("temporary import failure");
    await expect(load()).resolves.toBeDefined();
    expect(calls).toBe(2);
  });

  test("maps every secondary route to its exact cached loader", () => {
    expect(routeModuleLoaderForPath("/search?q=test")).toBe(loadSearchPage);
    expect(routeModuleLoaderForPath("/follow")).toBe(loadFollowPage);
    expect(routeModuleLoaderForPath("/history?platform=all")).toBe(loadHistoryPage);
    expect(routeModuleLoaderForPath("/recordings")).toBe(loadRecordingsPage);
    expect(routeModuleLoaderForPath("/recordings/play/recording-1")).toBe(
      loadRecordingPlaybackPage,
    );
    expect(routeModuleLoaderForPath("/iptv")).toBe(loadIptvPage);
    expect(routeModuleLoaderForPath("/iptv/play?channel=https%3A%2F%2Fexample.test")).toBe(
      loadIptvPlayerPage,
    );
    expect(routeModuleLoaderForPath("/settings")).toBe(loadSettingsPage);
    expect(routeModuleLoaderForPath("/multi-room")).toBe(loadMultiRoomPage);
    expect(routeModuleLoaderForPath("/room/bilibili/1")).toBe(loadRoomPage);
    expect(routeModuleLoaderForPath("/")).toBeNull();
    expect(routeModuleLoaderForPath("/unknown")).toBeNull();
  });

  test("resolves the desktop category page but leaves merged surfaces to the home route", () => {
    // `/category` 是桌面端的分类墙，一条真实路由。`/category/:parent/:child` 只剩
    // 一个重定向元素（随主 chunk 下发），而首页的分区态是查询参数、不换 pathname，
    // 两者都没有专属的惰求模块。
    expect(routeModuleLoaderForPath("/category")).toBe(loadCategoryBrowsePage);
    expect(routeModuleLoaderForPath("/category/parent/child")).toBeNull();
    expect(routeModuleLoaderForPath("/?cat=huya:100023:1")).toBeNull();
  });
});

describe("idle route preloading policy", () => {
  test("skips data-saving and very slow connections", () => {
    expect(shouldSkipIdleRoutePreloading({ saveData: true, effectiveType: "4g" })).toBe(true);
    expect(shouldSkipIdleRoutePreloading({ effectiveType: "slow-2g" })).toBe(true);
    expect(shouldSkipIdleRoutePreloading({ effectiveType: "2g" })).toBe(true);
  });

  test("allows normal and unknown desktop connections", () => {
    expect(shouldSkipIdleRoutePreloading({ effectiveType: "3g" })).toBe(false);
    expect(shouldSkipIdleRoutePreloading({ effectiveType: "4g" })).toBe(false);
    expect(shouldSkipIdleRoutePreloading(undefined)).toBe(false);
  });
});
