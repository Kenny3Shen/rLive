import { describe, expect, test } from "bun:test";
import { createMemoryRouter } from "react-router-dom";
import {
  canCompleteVideoShortsNavigation,
  parseVideoPlayParams,
  shouldAutoEnterVideoShorts,
  videoDetailsIntentForKey,
  videoDetailsNavigationState,
  videoPlayPath,
  videoShortsEntryFromState,
  videoShortsEntryNavigationState,
} from "../src/features/video/videoRoute";
import { shortsPath } from "../src/features/shorts/shortsFeed";

const bvid = "BV17x411w7KC";
const cid = 42;
const videoKey = `${bvid}:${cid}`;
const entry = {
  mobileClient: true,
  bvid,
  cid,
  epId: null,
  seasonId: null,
  archive: { bvid, cid, pages: [] },
  frameAspectRatio: 9 / 16,
  audioOnly: false,
  videoKey,
  navigationState: null,
} satisfies Parameters<typeof shouldAutoEnterVideoShorts>[0];

function shouldEnter(overrides: Partial<Parameters<typeof shouldAutoEnterVideoShorts>[0]> = {}) {
  return shouldAutoEnterVideoShorts({ ...entry, ...overrides });
}

const playPath = videoPlayPath({ bvid, cid, title: "竖画幅稿件" });
const shortPath = shortsPath(bvid);

function routerAtPlayer() {
  return createMemoryRouter([{ path: "*", element: null }], {
    initialEntries: ["/video", playPath],
    initialIndex: 1,
  });
}

describe("移动端竖画幅点播自动入口", () => {
  test("有效 B 站单 P UGC 在实测画幅落定后进入；链接仍只含 seed", () => {
    expect(shouldEnter()).toBe(true);
    expect(shortPath).toBe(`/shorts/bilibili?seed=${bvid}`);
    expect([...new URLSearchParams(shortPath.split("?")[1]).keys()]).toEqual(["seed"]);
    const resolved = parseVideoPlayParams(new URLSearchParams(playPath.split("?")[1]));
    expect(resolved?.cid).toBe(cid);
    expect(shouldEnter({ ...resolved })).toBe(true);
  });

  test.each([null, 0, -1, 1, 16 / 9, NaN, Infinity, -Infinity])(
    "未知、非法、正方或横画幅留在播放页：%s",
    (frameAspectRatio) => {
      expect(shouldEnter({ frameAspectRatio })).toBe(false);
    },
  );

  test("比例只按有限正数且小于 1 判定，不按容器宽度或设备方向", () => {
    expect(shouldEnter({ frameAspectRatio: Number.MIN_VALUE })).toBe(true);
    expect(shouldEnter({ frameAspectRatio: 0.999 })).toBe(true);
    expect(shouldEnter({ mobileClient: false })).toBe(false);
    expect(shouldEnter({ audioOnly: true })).toBe(false);
  });

  test.each([null, "", "BV1", "av170001", " BV17x411w7KC", "BV17x411w7KC?x=1"])(
    "缺失或非法 bvid 不自动进入：%s",
    (invalidBvid) => {
      expect(shouldEnter({ bvid: invalidBvid })).toBe(false);
    },
  );

  test.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "尚未解析或非法 cid 不自动进入：%s",
    (invalidCid) => {
      expect(shouldEnter({ cid: invalidCid })).toBe(false);
    },
  );

  test("PGC、season 入口、missing 详情与内容不匹配均不自动进入", () => {
    expect(shouldEnter({ epId: "123" })).toBe(false);
    expect(shouldEnter({ seasonId: "456" })).toBe(false);
    expect(shouldEnter({ archive: undefined })).toBe(false);
    expect(shouldEnter({ archive: null })).toBe(false);
    expect(shouldEnter({ archive: { ...entry.archive, bvid: "BV1Q541167Qg" } })).toBe(false);
    expect(shouldEnter({ archive: { ...entry.archive, cid: 43 } })).toBe(false);
    expect(shouldEnter({ videoKey: `${bvid}:43` })).toBe(false);
    expect(shouldEnter({ frameAspectRatio: null, videoKey: `${bvid}:43`, cid: 43 })).toBe(false);
  });

  test("多 P 的首 P 与其他 P 都保留详情，不扩展 seed 表达 cid", () => {
    const archive = {
      ...entry.archive,
      pages: [
        { page: 1, cid, part: "首 P", duration: 10 },
        { page: 2, cid: 43, part: "次 P", duration: 10 },
      ],
    };
    expect(shouldEnter({ archive })).toBe(false);
    expect(shouldEnter({ archive, cid: 43, videoKey: `${bvid}:43` })).toBe(false);
  });
});

describe("按内容键绑定的详情意图", () => {
  test("保留其他 route state；详情意图不串到新内容", () => {
    const state = videoDetailsNavigationState(videoKey, { source: "shorts", count: 1 });
    expect(state).toEqual({ source: "shorts", count: 1, videoDetailsKey: videoKey });
    expect(videoDetailsIntentForKey(state, videoKey)).toBe(true);
    expect(shouldEnter({ navigationState: state })).toBe(false);
    const newBvid = "BV1Q541167Qg";
    expect(
      shouldEnter({
        bvid: newBvid,
        videoKey: `${newBvid}:${cid}`,
        archive: { ...entry.archive, bvid: newBvid },
        navigationState: state,
      }),
    ).toBe(true);
    expect(videoDetailsIntentForKey(state, `${bvid}:43`)).toBe(false);
  });

  test("拒绝 missing 或不合法 route state", () => {
    for (const state of [
      undefined,
      null,
      false,
      1,
      "details",
      [],
      {},
      { videoDetailsKey: true },
      { videoDetailsKey: "" },
    ]) {
      expect(videoDetailsIntentForKey(state, videoKey)).toBe(false);
    }
  });

  test("metadata/resize 与同内容重建始终尊重详情意图", () => {
    const navigationState = videoDetailsNavigationState(videoKey);
    for (const frameAspectRatio of [null, 9 / 16, 0.7, 0.7, 9 / 16]) {
      expect(shouldEnter({ navigationState, frameAspectRatio })).toBe(false);
    }
  });

  test("自动入口 replace 后 Back 回发现页，不留一个会重定向的播放页", async () => {
    const router = routerAtPlayer();
    try {
      await router.navigate(shortPath, { replace: true });
      expect(router.state.historyAction).toBe("REPLACE");
      await router.navigate(-1);
      expect(router.state.location.pathname).toBe("/video");
    } finally {
      router.dispose();
    }
  });

  test("手动入口标记来源再 push，Back 回同内容详情页而不循环", async () => {
    const router = routerAtPlayer();
    try {
      // 对应页面只更新当前 history usr 的操作，不增加返回栈条目。
      await router.navigate(playPath, {
        replace: true,
        state: videoDetailsNavigationState(videoKey, { source: "search" }),
      });
      await router.navigate(shortPath);
      expect(router.state.historyAction).toBe("PUSH");
      await router.navigate(playPath, { state: videoDetailsNavigationState(videoKey) });
      expect(shouldEnter({ navigationState: router.state.location.state })).toBe(false);
      await router.navigate(-1);
      expect(router.state.location.pathname).toBe("/shorts/bilibili");
      await router.navigate(-1);
      expect(router.state.location.state).toEqual({ source: "search", videoDetailsKey: videoKey });
      expect(shouldEnter({ navigationState: router.state.location.state })).toBe(false);
      await router.navigate(-1);
      expect(router.state.location.pathname).toBe("/video");
    } finally {
      router.dispose();
    }
  });
});

describe("异步退全屏后的导航核对", () => {
  const navigation = {
    requestedKey: videoKey,
    currentKey: videoKey,
    requestedEntryKey: "entry-a",
    currentEntryKey: "entry-a",
    cancelled: false,
  };

  test("只提交仍属于当前内容和历史条目的请求", () => {
    expect(canCompleteVideoShortsNavigation(navigation)).toBe(true);
    expect(canCompleteVideoShortsNavigation({ ...navigation, currentKey: `${bvid}:43` })).toBe(
      false,
    );
    expect(canCompleteVideoShortsNavigation({ ...navigation, currentEntryKey: "entry-b" })).toBe(
      false,
    );
    expect(canCompleteVideoShortsNavigation({ ...navigation, cancelled: true })).toBe(false);
  });

  test("离页/Back 后即使回到同一内容，也不复活旧退全屏请求", async () => {
    const request = { ...navigation };
    const { promise, resolve } = Promise.withResolvers<void>();
    let navigated = false;
    const pending = (async () => {
      await promise;
      if (canCompleteVideoShortsNavigation(request)) navigated = true;
    })();
    request.cancelled = true;
    resolve();
    await pending;
    expect(navigated).toBe(false);
  });
});

describe("自动入口的额外保护", () => {
  test("被屏蔽 UP 主的视频不自动分流，但仍可手动进入", () => {
    expect(shouldEnter({ blockedUploader: true })).toBe(false);
    expect(shouldEnter({ blockedUploader: false })).toBe(true);
  });

  test("缺省 blockedUploader 保持原有自动入口行为", () => {
    const { blockedUploader: _ignored, ...withoutFlag } = { ...entry, blockedUploader: undefined };
    expect(shouldAutoEnterVideoShorts(withoutFlag)).toBe(true);
  });
});

describe("短视频入口的来源恢复", () => {
  const source = {
    bvid,
    cid,
    title: "竖画幅稿件",
    aid: "170001",
    videoKey,
  };

  test("来源信息随 navigation state 传递，链接仍只有 seed", () => {
    const state = videoShortsEntryNavigationState(source, { source: "search" });
    expect(state).toEqual({ source: "search", videoShortsEntry: source });
    expect(videoShortsEntryFromState(state)).toEqual(source);
  });

  test("回详情时标记详情意图，自动入口不会再次分流", () => {
    const restored = videoShortsEntryFromState(videoShortsEntryNavigationState(source));
    expect(restored).not.toBeNull();
    const detailsState = videoDetailsNavigationState(restored!.videoKey);
    expect(shouldEnter({ navigationState: detailsState })).toBe(false);
    const playPathAgain = videoPlayPath({
      bvid: restored!.bvid,
      cid: restored!.cid,
      title: restored!.title,
      aid: restored!.aid,
    });
    const paramsAgain = parseVideoPlayParams(new URLSearchParams(playPathAgain.split("?")[1]));
    expect(paramsAgain).toEqual({
      bvid,
      cid,
      epId: null,
      seasonId: null,
      title: "竖画幅稿件",
      aid: "170001",
    });
  });

  test.each([
    undefined,
    null,
    {},
    { videoShortsEntry: null },
    { videoShortsEntry: [] },
    { videoShortsEntry: { ...source, bvid: "av1" } },
    { videoShortsEntry: { ...source, cid: 0 } },
    { videoShortsEntry: { ...source, cid: 1.5 } },
    { videoShortsEntry: { ...source, videoKey: `${bvid}:99` } },
    { videoShortsEntry: { ...source, title: 1 } },
    { videoShortsEntry: { ...source, aid: 1 } },
  ])("形状不合法时视为没有来源：%s", (state) => {
    expect(videoShortsEntryFromState(state)).toBeNull();
  });
});
