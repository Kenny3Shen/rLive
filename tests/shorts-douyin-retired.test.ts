import { describe, expect, test } from "bun:test";
import { createMemoryRouter } from "react-router-dom";
import { isImmersivePlayerPath } from "../src/app/layout/immersiveRoutes";
import { legacyDouyinShortsRedirect } from "../src/app/legacyShortsRoutes";
import {
  loadShortsHomePage,
  loadShortsPage,
  routeModuleLoaderForPath,
} from "../src/app/routeModules";
import { BILIBILI_SHORTS_PATH, SHORTS_PATH } from "../src/features/shorts/shortsFeed";

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

describe("抖音短视频下线后的旧入口", () => {
  test("含任意 query 的旧地址 replace 回 /shorts，且不携带原参数", async () => {
    for (const search of ["", "?seed=BV17x411w7KC", "?tab=link&seed=BV17x411w7KC", "?x=1"]) {
      const router = createMemoryRouter(
        [
          { path: "/history", element: null },
          { path: "/shorts", element: null },
          { path: "/shorts/bilibili", element: null },
          { path: "/shorts/douyin", loader: legacyDouyinShortsRedirect, element: null },
        ],
        { initialEntries: ["/history", `/shorts/douyin${search}`], initialIndex: 1 },
      );
      try {
        await waitForRouterInitialization(router);
        expect(router.state.location.pathname).toBe(SHORTS_PATH);
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

  test("旧地址的预加载落到平台选择页，不再引用播放器或推荐流模块", () => {
    // 平台选择页只画入口卡片，不挂推荐查询或播放器；预加载它等于预加载重定向落点。
    expect(routeModuleLoaderForPath("/shorts/douyin?seed=BV17x411w7KC")).toBe(loadShortsHomePage);
    expect(routeModuleLoaderForPath("/shorts/douyin?tab=link")).toBe(loadShortsHomePage);
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
    expect(routeModuleLoaderForPath(BILIBILI_SHORTS_PATH)).not.toBe(
      routeModuleLoaderForPath(SHORTS_PATH),
    );
    expect(routeModuleLoaderForPath(SHORTS_PATH)).not.toBeNull();
  });
});
