import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createMemoryRouter } from "react-router-dom";
import { isImmersivePlayerPath } from "../src/app/layout/immersiveRoutes";
import { legacyDouyinShortsRedirect, legacyShortsRedirect } from "../src/app/legacyShortsRoutes";
import { loadShortsPage, loadVideoPage, routeModuleLoaderForPath } from "../src/app/routeModules";
import { BILIBILI_SHORTS_PATH, SHORTS_PATH } from "../src/features/shorts/shortsFeed";
import { VIDEO_HOME_PATH } from "../src/features/video/videoRoute";

async function waitForRouterInitialization(router: ReturnType<typeof createMemoryRouter>) {
  if (router.state.initialized) return;
  await new Promise<void>((resolve) => {
    const unsubscribe = router.subscribe((state) => {
      if (!state.initialized) return;
      unsubscribe();
      resolve();
    });
  });
}

function legacyRouter(initialEntry: string) {
  return createMemoryRouter(
    [
      { path: "/history", element: null },
      { path: SHORTS_PATH, loader: legacyShortsRedirect, element: null },
      { path: BILIBILI_SHORTS_PATH, element: null },
      { path: VIDEO_HOME_PATH, element: null },
      { path: "/shorts/douyin", loader: legacyDouyinShortsRedirect, element: null },
    ],
    { initialEntries: ["/history", initialEntry], initialIndex: 1 },
  );
}

describe("旧 /shorts 选择页下线后的兼容", () => {
  test("没有有效 seed 时 replace 回视频发现页，且丢掉 query", async () => {
    for (const search of ["", "?seed=", "?seed=%20", "?tab=link", "?x=1&seed=%20"]) {
      const router = legacyRouter(`${SHORTS_PATH}${search}`);
      try {
        await waitForRouterInitialization(router);
        expect(router.state.location.pathname).toBe(VIDEO_HOME_PATH);
        expect(router.state.location.search).toBe("");
        expect(router.state.historyAction).toBe("REPLACE");
        // replace 不留额外历史：一次 Back 就回到进入前的页面，不会再次命中旧入口。
        await router.navigate(-1);
        expect(router.state.location.pathname).toBe("/history");
      } finally {
        router.dispose();
      }
    }
  });

  test("有效 seed 转到 B 站推荐流并保留全部 query", async () => {
    const router = legacyRouter(`${SHORTS_PATH}?seed=BV17x411w7KC&tab=link`);
    try {
      await waitForRouterInitialization(router);
      expect(router.state.location.pathname).toBe(BILIBILI_SHORTS_PATH);
      expect(router.state.location.search).toBe("?seed=BV17x411w7KC&tab=link");
      expect(router.state.historyAction).toBe("REPLACE");
      await router.navigate(-1);
      expect(router.state.location.pathname).toBe("/history");
    } finally {
      router.dispose();
    }
  });

  test("旧 /shorts 入口的预加载跟随 seed 判定", () => {
    expect(routeModuleLoaderForPath(SHORTS_PATH)).toBe(loadVideoPage);
    expect(routeModuleLoaderForPath(`${SHORTS_PATH}?tab=link`)).toBe(loadVideoPage);
    expect(routeModuleLoaderForPath(`${SHORTS_PATH}?seed=`)).toBe(loadVideoPage);
    expect(routeModuleLoaderForPath(`${SHORTS_PATH}?seed=BV17x411w7KC`)).toBe(loadShortsPage);
    expect(routeModuleLoaderForPath(`${SHORTS_PATH}?tab=link&seed=BV17x411w7KC`)).toBe(
      loadShortsPage,
    );
  });
});

describe("短视频页没有历史时的返回落点", () => {
  test("页内返回口回视频发现页，而不是已下线的 /shorts", () => {
    // handleBack 依赖 window.history 与 hooks，这里锁定源码契约：
    // 有历史仍 navigate(-1)，无历史 replace 到视频发现页。
    const source = readFileSync(
      join(import.meta.dir, "../src/features/shorts/ShortsPage.tsx"),
      "utf8",
    );
    expect(source).toContain("if (hasBrowserHistoryEntry(window.history.state)) navigate(-1);");
    expect(source).toContain("else navigate(VIDEO_HOME_PATH, { replace: true });");
    expect(source).not.toContain('navigate("/shorts"');
  });
});

describe("抖音短视频下线后的旧入口", () => {
  test("含任意 query 的旧地址 replace 回视频发现页，且不携带原参数", async () => {
    for (const search of ["", "?seed=BV17x411w7KC", "?tab=link&seed=BV17x411w7KC", "?x=1"]) {
      const router = legacyRouter(`/shorts/douyin${search}`);
      try {
        await waitForRouterInitialization(router);
        expect(router.state.location.pathname).toBe(VIDEO_HOME_PATH);
        expect(router.state.location.search).toBe("");
        expect(router.state.historyAction).toBe("REPLACE");
        // replace 不留额外历史：一次 Back 就回到进入前的页面，不会再次命中旧入口。
        await router.navigate(-1);
        expect(router.state.location.pathname).toBe("/history");
      } finally {
        router.dispose();
      }
    }
  });

  test("旧地址的预加载落到视频发现页，不再引用播放器或推荐流模块", () => {
    expect(routeModuleLoaderForPath("/shorts/douyin?seed=BV17x411w7KC")).toBe(loadVideoPage);
    expect(routeModuleLoaderForPath("/shorts/douyin?tab=link")).toBe(loadVideoPage);
    // 旧入口绝不能落到 B 站推荐流，更不能引用任何播放器模块。
    expect(routeModuleLoaderForPath("/shorts/douyin")).not.toBe(loadShortsPage);
  });

  test("旧抖音入口不再进入沉浸布局，B 站舞台保留", () => {
    expect(isImmersivePlayerPath("/shorts/douyin")).toBe(false);
    expect(isImmersivePlayerPath(SHORTS_PATH)).toBe(false);
    expect(isImmersivePlayerPath(BILIBILI_SHORTS_PATH)).toBe(true);
  });

  test("B 站入口与 legacy seed 仍由同一路径常量表达", () => {
    expect(SHORTS_PATH).toBe("/shorts");
    expect(BILIBILI_SHORTS_PATH).toBe("/shorts/bilibili");
    expect(routeModuleLoaderForPath(BILIBILI_SHORTS_PATH)).toBe(loadShortsPage);
    expect(routeModuleLoaderForPath(BILIBILI_SHORTS_PATH)).not.toBe(
      routeModuleLoaderForPath(SHORTS_PATH),
    );
    expect(routeModuleLoaderForPath(SHORTS_PATH)).not.toBeNull();
  });
});
