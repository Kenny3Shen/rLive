import { describe, expect, test } from "bun:test";
import {
  loadAcfunArticlePage,
  loadAcfunSearchPage,
  loadAcfunVideoPage,
  routeModuleLoaderForPath,
} from "../src/app/routeModules";
import { isImmersivePlayerPath } from "../src/app/layout/immersiveRoutes";
import {
  acfunArticleBackNavigation,
  acfunArticlePath,
  acfunHomePath,
  acfunSearchPath,
  acfunVideoPath,
  acfunViewFromSearch,
} from "../src/features/acfun/acfunRoute";
import { dedupeAcfunItems } from "../src/features/acfun/acfunFeed";
import {
  AcfunPlaybackSessions,
  type AcfunPlaybackResult,
} from "../src/features/acfun/acfunPlaybackLifecycle";
import type { AcfunVideoPlayInfo } from "../src/features/acfun/acfunTypes";
import {
  LIVE_SITE_IDS,
  enabledSiteIds,
  isSiteId,
  updateDisabledSiteIds,
} from "../src/shared/siteId";
import { deferred, settle } from "./helpers/async";

function playInfo(id: string): AcfunVideoPlayInfo {
  return {
    url: `http://127.0.0.1/${id}/master.m3u8`,
    headers: {},
    quality: id,
    quality_label: id,
    protocol: "hls",
    accept_qualities: [],
    session_id: `session-${id}`,
  };
}

describe("AcFun 路由模块", () => {
  test("播放、文章和搜索分别加载对应模块", () => {
    expect(routeModuleLoaderForPath("/video/acfun/play?id=X")).toBe(loadAcfunVideoPage);
    expect(routeModuleLoaderForPath("/video/acfun/article/X")).toBe(loadAcfunArticlePage);
    expect(routeModuleLoaderForPath("/video/acfun/search?view=article&q=X")).toBe(
      loadAcfunSearchPage,
    );
  });

  test("只有播放页进入沉浸模式", () => {
    expect(isImmersivePlayerPath("/video/acfun/play")).toBe(true);
    expect(isImmersivePlayerPath("/video/acfun/article/X")).toBe(false);
    expect(isImmersivePlayerPath("/video/acfun/search")).toBe(false);
  });

  test("路径构造函数保留内容类型和定位参数", () => {
    expect(acfunHomePath()).toBe("/video?source=acfun");
    expect(acfunHomePath("video", { section: "86" })).toBe("/video?source=acfun&section=86");
    expect(acfunHomePath("article")).toBe("/video?source=acfun&view=article");
    expect(acfunHomePath("article", { channel: "28" })).toBe(
      "/video?source=acfun&view=article&channel=28",
    );
    expect(acfunSearchPath("video")).toBe("/video/acfun/search");
    expect(acfunSearchPath("article", " 三角洲行动 ")).toBe(
      "/video/acfun/search?view=article&q=%E4%B8%89%E8%A7%92%E6%B4%B2%E8%A1%8C%E5%8A%A8",
    );
    expect(acfunVideoPath("123", "456")).toBe("/video/acfun/play?id=123&part=456");
    expect(acfunArticlePath("a/b 1")).toBe("/video/acfun/article/a%2Fb%201");
  });

  test("未知内容类型回落到视频，跨页重复项按首次出现保留", () => {
    expect(acfunViewFromSearch("article")).toBe("article");
    expect(acfunViewFromSearch(null)).toBe("video");
    expect(acfunViewFromSearch("unknown")).toBe("video");
    expect(
      dedupeAcfunItems([
        { id: "A", title: "首次" },
        { id: "B", title: "另项" },
        { id: "A", title: "重复" },
        { id: "", title: "空 id" },
      ]),
    ).toEqual([
      { id: "A", title: "首次" },
      { id: "B", title: "另项" },
    ]);
  });

  test("文章返回优先使用历史来源，直链才回到文章首页", () => {
    // 上一历史条目可能是带原搜索词的搜索页，或带频道参数的浏览页；
    // 返回动作不重建路径，因此这些位置会原样恢复。
    expect(acfunArticleBackNavigation({ idx: 1 })).toEqual({ kind: "back" });
    expect(acfunArticleBackNavigation({ idx: 3 })).toEqual({ kind: "back" });
    expect(acfunArticleBackNavigation({ idx: 0 })).toEqual({
      kind: "navigate",
      path: acfunHomePath("article"),
    });
    expect(acfunArticleBackNavigation(null)).toEqual({
      kind: "navigate",
      path: "/video?source=acfun&view=article",
    });
  });
});

describe("AcFun 平台可见性", () => {
  test("AcFun 是已知平台，可停用并重新启用", () => {
    expect(isSiteId("acfun")).toBe(true);
    expect(enabledSiteIds([])).toContain("acfun");
    const disabled = updateDisabledSiteIds([], "acfun", false);
    expect(disabled).toContain("acfun");
    expect(enabledSiteIds(disabled)).not.toContain("acfun");
    expect(updateDisabledSiteIds(disabled, "acfun", true)).not.toContain("acfun");
  });

  test("至少保留一个平台", () => {
    const onlyDefaultEnabled = LIVE_SITE_IDS.filter((siteId) => siteId !== "bilibili");
    expect(enabledSiteIds(onlyDefaultEnabled)).toEqual(["bilibili"]);
    expect(updateDisabledSiteIds(onlyDefaultEnabled, "bilibili", false)).toEqual(
      onlyDefaultEnabled,
    );
  });
});

describe("AcFun 播放代理生命周期", () => {
  function sessions() {
    const stopped: string[] = [];
    const owner = new AcfunPlaybackSessions((sessionId) => stopped.push(sessionId));
    return { owner, stopped };
  }

  test("跨稿件旧请求晚返回时只停止旧会话", async () => {
    const { owner, stopped } = sessions();
    const oldRequest = deferred<AcfunVideoPlayInfo>();
    const old = owner.acquire("A:1", new AbortController().signal, () => oldRequest.promise);
    const oldOutcome = old.catch((error: unknown) => error);
    const current = await owner.acquire("B:2", new AbortController().signal, async () =>
      playInfo("B"),
    );
    expect(owner.retain(current)).toBe(true);
    oldRequest.resolve(playInfo("A"));
    expect(await oldOutcome).toMatchObject({ name: "AbortError" });
    expect(stopped).toEqual(["session-A"]);
    owner.releasePrevious();
    expect(stopped).toEqual(["session-A"]);
    owner.clear();
    expect(stopped).toEqual(["session-A", "session-B"]);
  });

  test("快速切画质时旧结果不会停止已接管的新会话", async () => {
    const { owner, stopped } = sessions();
    const held = await owner.acquire("A:1", new AbortController().signal, async () =>
      playInfo("A-1080"),
    );
    expect(owner.retain(held)).toBe(true);
    const oldQuality = deferred<AcfunVideoPlayInfo>();
    const stale = owner.acquire("A:1", new AbortController().signal, () => oldQuality.promise);
    const staleOutcome = stale.catch((error: unknown) => error);
    const current = await owner.acquire("A:1", new AbortController().signal, async () =>
      playInfo("A-720"),
    );
    expect(owner.retain(current)).toBe(true);
    oldQuality.resolve(playInfo("A-480"));
    expect(await staleOutcome).toMatchObject({ name: "AbortError" });
    expect(stopped).toEqual(["session-A-480"]);
    owner.releasePrevious();
    expect(stopped).toEqual(["session-A-480", "session-A-1080"]);
    owner.clear();
    expect(stopped).toEqual(["session-A-480", "session-A-1080", "session-A-720"]);
  });

  test("离开时取消当前请求，迟到结果仍只释放一次", async () => {
    const { owner, stopped } = sessions();
    const controller = new AbortController();
    const request = deferred<AcfunVideoPlayInfo>();
    const pending = owner.acquire("A:1", controller.signal, () => request.promise);
    const outcome = pending.catch((error: unknown) => error);
    owner.clear();
    controller.abort();
    request.resolve(playInfo("late"));
    expect(await outcome).toMatchObject({ name: "AbortError" });
    await settle();
    owner.clear();
    expect(stopped).toEqual(["session-late"]);
  });

  test("正常卸载当前成功会话只停止一次", async () => {
    const { owner, stopped } = sessions();
    const result = await owner.acquire("A:1", new AbortController().signal, async () =>
      playInfo("A"),
    );
    expect(owner.retain(result)).toBe(true);
    owner.clear();
    owner.clear();
    expect(stopped).toEqual(["session-A"]);
  });

  test("已返回但未接管的查询结果也在离开时释放", async () => {
    const { owner, stopped } = sessions();
    const result: AcfunPlaybackResult = await owner.acquire(
      "A:1",
      new AbortController().signal,
      async () => playInfo("uncommitted"),
    );
    owner.clear();
    expect(owner.retain(result)).toBe(false);
    expect(stopped).toEqual(["session-uncommitted"]);
    owner.clear();
    expect(stopped).toEqual(["session-uncommitted"]);
  });
});
