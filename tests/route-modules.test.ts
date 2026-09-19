import { describe, expect, test } from "bun:test";
import { shouldSkipIdleRoutePreloading } from "../src/app/RouteModulePreloader";
import {
  createCachedRouteLoader,
  idleRouteModuleLoadersForPlatform,
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
  loadShortsPage,
  loadDouyinVideoPage,
  loadVideoPage,
  loadVideoPlayerPage,
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

  test("resolves the video surfaces without letting the play page fall through to discovery", () => {
    // 两条路径共一个前缀，判定顺序错了播放页就会拿到发现页的 loader。
    expect(routeModuleLoaderForPath("/video")).toBe(loadVideoPage);
    expect(routeModuleLoaderForPath("/video?tab=anime")).toBe(loadVideoPage);
    expect(routeModuleLoaderForPath("/video/play?cid=123&bvid=BV1")).toBe(loadVideoPlayerPage);
  });

  test("短视频是自己的目的地，不共用 `/video` 前缀", () => {
    // 路径刻意不挂在 `/video` 下（侧栏目的地按前缀匹配，那样「视频」会跟着高亮），
    // 因此它不能被视频任何一条路由接走。
    expect(routeModuleLoaderForPath("/shorts")).toBe(loadShortsPage);
    expect(routeModuleLoaderForPath("/shorts/douyin")).toBe(loadDouyinVideoPage);
    expect(routeModuleLoaderForPath("/video")).not.toBe(loadShortsPage);
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
  test("移动端不预载桌面分类页、录制库和多画面", () => {
    for (const platform of ["android", "ios"] as const) {
      const loaders = idleRouteModuleLoadersForPlatform(platform);
      expect(loaders).not.toContain(loadCategoryBrowsePage);
      expect(loaders).not.toContain(loadRecordingsPage);
      expect(loaders).not.toContain(loadMultiRoomPage);
      for (const loader of [
        loadFollowPage,
        loadHistoryPage,
        loadIptvPlayerPage,
        loadRoomPage,
        loadVideoPlayerPage,
      ]) {
        expect(loaders).toContain(loader);
      }
      expect(new Set(loaders).size).toBe(loaders.length);
    }
    const desktop = idleRouteModuleLoadersForPlatform("desktop");
    expect(desktop).toContain(loadCategoryBrowsePage);
    expect(desktop).toContain(loadRecordingsPage);
    expect(desktop).toContain(loadMultiRoomPage);
  });

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
