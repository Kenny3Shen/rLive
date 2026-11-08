import { describe, expect, test } from "bun:test";
import {
  createThrottledRouteOutletState,
  nextThrottledRouteOutletState,
  sameThrottledRouteOutletRoute,
  type ThrottledRouteOutletRoute,
  type ThrottledRouteOutletState,
} from "../src/app/layout/throttledRouteOutlet";

const player: ThrottledRouteOutletRoute = {
  pathname: "/video/play",
  entryKey: "player",
  immersive: true,
};
const video: ThrottledRouteOutletRoute = {
  pathname: "/video",
  entryKey: "home",
  immersive: false,
};

/** 一次导航 = 推进记忆 + 读取当前提交是否分阶段；就绪后再推进同一条目。 */
function navigate(previous: ThrottledRouteOutletState, route: ThrottledRouteOutletRoute) {
  return nextThrottledRouteOutletState(previous, route);
}
function ready(previous: ThrottledRouteOutletState): ThrottledRouteOutletState {
  return { ...previous, activeReady: true };
}

describe("退出播放页的分阶段挂载", () => {
  test("从沉浸页进入普通页时，首帧只提交活动面板", () => {
    const inPlayer = createThrottledRouteOutletState(player);
    const exit = navigate(inPlayer, video);

    expect(exit.memory.throttled).toBe(true);
    expect(exit.activeReady).toBe(false);
    expect(sameThrottledRouteOutletRoute(exit.memory, video)).toBe(true);
  });

  test("活动页就绪后补齐邻居，同条目重渲染不重复卸载", () => {
    const exit = navigate(createThrottledRouteOutletState(player), video);
    const committed = ready(exit);
    const rerender = navigate(committed, video);

    expect(committed.activeReady).toBe(true);
    expect(rerender.memory.throttled).toBe(true);
    expect(rerender.activeReady).toBe(true);

    const nextTab = { ...video, entryKey: "popular" };
    const afterTab = navigate(rerender, nextTab);
    expect(afterTab.memory.throttled).toBe(false);
    expect(afterTab.activeReady).toBe(false);
  });

  test("尚未就绪时连续切页，仍按一次轻量提交处理", () => {
    const exit = navigate(createThrottledRouteOutletState(player), video);
    const nextTab = navigate(exit, { ...video, entryKey: "popular" });

    expect(nextTab.memory.throttled).toBe(true);
    expect(nextTab.activeReady).toBe(false);
  });

  test("再次进入播放页并退出时重新分阶段，不复用上一条历史就绪态", () => {
    const committed = ready(navigate(createThrottledRouteOutletState(player), video));
    const reenter = navigate(committed, { ...player, entryKey: "player-2" });
    expect(reenter.memory.throttled).toBe(false);
    expect(reenter.activeReady).toBe(false);

    const exitAgain = navigate(reenter, { ...video, entryKey: "home-2" });
    expect(exitAgain.memory.throttled).toBe(true);
    expect(exitAgain.activeReady).toBe(false);
  });

  test("普通页面间导航和沉浸页自身不启用分阶段", () => {
    const initial = createThrottledRouteOutletState(video);
    expect(navigate(initial, { ...video, entryKey: "history" }).memory.throttled).toBe(false);
    const inPlayer = navigate(initial, player);
    expect(inPlayer.memory.throttled).toBe(false);
    expect(navigate(inPlayer, { ...player, entryKey: "selection" }).memory.throttled).toBe(false);
  });

  test("分类或搜索跨路径 POP 返回普通页时先提交外壳，同路径页签保留轨道", () => {
    const category = { pathname: "/category", entryKey: "category", immersive: false };
    const back = navigate(createThrottledRouteOutletState(category), {
      pathname: "/",
      entryKey: "home",
      immersive: false,
      historyTraversal: true,
    });
    expect(back.memory.throttled).toBe(true);
    expect(back.activeReady).toBe(false);

    const samePage = navigate(createThrottledRouteOutletState(video), {
      ...video,
      entryKey: "previous-tab",
      historyTraversal: true,
    });
    expect(samePage.memory.throttled).toBe(false);
    const playerBack = navigate(createThrottledRouteOutletState(video), {
      ...player,
      historyTraversal: true,
    });
    expect(playerBack.memory.throttled).toBe(false);
  });

  test("同一页面的 REPLACE 退出也按一次轻量提交处理", () => {
    const exit = navigate(createThrottledRouteOutletState(player), video);
    const replaced = navigate(exit, { ...video, entryKey: "replaced" });
    expect(replaced.memory.throttled).toBe(true);
    expect(replaced.activeReady).toBe(false);
  });
});
