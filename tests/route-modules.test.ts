import { describe, expect, test } from "bun:test";
import { shouldSkipIdleRoutePreloading } from "../src/app/RouteModulePreloader";
import {
  createCachedRouteLoader,
  loadVideoPage,
  loadVideoPlayerPage,
  routeModuleLoaderForPath,
} from "../src/app/routeModules";
describe("route module loading", () => {
  test("shares one in-flight and resolved module promise", async () => {
    let calls = 0;
    const load = createCachedRouteLoader(async () => {
      calls += 1;
      return {
        default: () => null,
      };
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
        : Promise.resolve({
            default: () => null,
          });
    });
    await expect(load()).rejects.toThrow("temporary import failure");
    await expect(load()).resolves.toBeDefined();
    expect(calls).toBe(2);
  });
  test("resolves the video surfaces without letting the play page fall through to discovery", () => {
    // 两条路径共一个前缀，判定顺序错了播放页就会拿到发现页的 loader。
    expect(routeModuleLoaderForPath("/video")).toBe(loadVideoPage);
    expect(routeModuleLoaderForPath("/video?tab=anime")).toBe(loadVideoPage);
    expect(routeModuleLoaderForPath("/video/play?cid=123&bvid=BV1")).toBe(loadVideoPlayerPage);
  });
});
describe("idle route preloading policy", () => {
  test("skips data-saving and very slow connections", () => {
    expect(
      shouldSkipIdleRoutePreloading({
        saveData: true,
        effectiveType: "4g",
      }),
    ).toBe(true);
    expect(
      shouldSkipIdleRoutePreloading({
        effectiveType: "slow-2g",
      }),
    ).toBe(true);
    expect(
      shouldSkipIdleRoutePreloading({
        effectiveType: "2g",
      }),
    ).toBe(true);
  });
  test("allows normal and unknown desktop connections", () => {
    expect(
      shouldSkipIdleRoutePreloading({
        effectiveType: "3g",
      }),
    ).toBe(false);
    expect(
      shouldSkipIdleRoutePreloading({
        effectiveType: "4g",
      }),
    ).toBe(false);
    expect(shouldSkipIdleRoutePreloading(undefined)).toBe(false);
  });
});
