import { describe, expect, test } from "bun:test";
import { navigateToVideoHome } from "../src/features/video/videoHomeNavigation";
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
