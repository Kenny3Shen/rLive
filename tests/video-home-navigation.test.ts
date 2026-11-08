import { describe, expect, test } from "bun:test";
import {
  navigateBackFromVideo,
  navigateToVideoHome,
} from "../src/features/video/videoHomeNavigation";
import { deferred } from "./helpers/async";

describe("VOD 返回主页", () => {
  test("普通窗口同步导航，不查询或等待全屏 IPC", async () => {
    const pendingExit = deferred();
    const calls: string[] = [];
    const navigation = navigateToVideoHome({
      fullscreen: false,
      exitFullscreen: () => {
        calls.push("exit");
        return pendingExit.promise;
      },
      isCurrentEntry: () => true,
      navigateHome: () => calls.push("home"),
    });
    expect(calls).toEqual(["home"]);
    await navigation;
  });

  test("实际全屏先退出，再导航，避免固定层覆盖首页", async () => {
    const pendingExit = deferred();
    const calls: string[] = [];
    const navigation = navigateToVideoHome({
      fullscreen: true,
      exitFullscreen: () => {
        calls.push("exit");
        return pendingExit.promise;
      },
      isCurrentEntry: () => true,
      navigateHome: () => calls.push("home"),
    });
    expect(calls).toEqual(["exit"]);
    pendingExit.resolve();
    await navigation;
    expect(calls).toEqual(["exit", "home"]);
  });

  test("等待退出期间已离页，迟到结果不再导航", async () => {
    const pendingExit = deferred();
    let currentEntry = true;
    let navigations = 0;
    const navigation = navigateToVideoHome({
      fullscreen: true,
      exitFullscreen: () => pendingExit.promise,
      isCurrentEntry: () => currentEntry,
      navigateHome: () => navigations++,
    });
    currentEntry = false;
    pendingExit.resolve();
    await navigation;
    expect(navigations).toBe(0);
  });

  test("离场动画保留的旧页面不能再次触发返回", async () => {
    let navigations = 0;
    await navigateToVideoHome({
      fullscreen: false,
      exitFullscreen: async () => {},
      isCurrentEntry: () => false,
      navigateHome: () => navigations++,
    });
    expect(navigations).toBe(0);
  });
});

describe("VOD 第一层返回", () => {
  function navigateWith(
    state: unknown,
    entryKey = "video-a",
    requestedEntryKey: string | null = null,
  ) {
    const calls: string[] = [];
    navigateBackFromVideo({
      entryKey,
      requestedEntryKey,
      historyState: state,
      navigateBack: () => calls.push("back"),
      navigateHome: () => calls.push("home"),
    });
    return calls;
  }

  test("有应用内历史且条目对齐时只回退一层", () => {
    expect(navigateWith({ key: "video-a", idx: 2 })).toEqual(["back"]);
  });

  test("返回时退回历史条目，保留上一层的路由状态", () => {
    const calls: unknown[] = [];
    navigateBackFromVideo({
      entryKey: "video-a",
      historyState: { key: "video-a", idx: 2, usr: { feed: "recommend" } },
      navigateBack: () => calls.push("back"),
      navigateHome: () => calls.push("home"),
    });
    expect(calls).toEqual(["back"]);
  });

  test("直入播放页没有更早应用内历史时回视频发现页", () => {
    expect(navigateWith({ key: "video-a", idx: 0 })).toEqual(["home"]);
    expect(navigateWith(null, "default")).toEqual(["home"]);
  });

  test("POP 改写历史但 Router 未提交时，冻结的旧播放页不再重复返回", () => {
    expect(navigateWith({ key: "video-home", idx: 1 })).toEqual([]);
  });

  test("异常或错位的索引不会触发返回", () => {
    expect(navigateWith({ key: "video-a", idx: "2" })).toEqual(["home"]);
    expect(navigateWith({ key: "video-a", idx: -1 })).toEqual(["home"]);
  });

  test("同一历史条目的快速连点只提交一次返回", () => {
    const calls: string[] = [];
    let requested: string | null = null;
    const click = () =>
      navigateBackFromVideo({
        entryKey: "video-a",
        requestedEntryKey: requested,
        historyState: { key: "video-a", idx: 2 },
        markRequested: () => {
          requested = "video-a";
        },
        navigateBack: () => calls.push("back"),
        navigateHome: () => calls.push("home"),
      });
    click();
    click();
    expect(calls).toEqual(["back"]);
    expect(requested).toBe("video-a");
    expect(navigateWith({ key: "video-b", idx: 2 }, "video-b", "video-a")).toEqual(["back"]);
  });
});
