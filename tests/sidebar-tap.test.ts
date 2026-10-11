import { describe, expect, test } from "bun:test";

/**
 * 移动端底栏在惯性滚动期间的点击。
 *
 * Chromium 的 scroll gesture 会吃掉「用来停住滚动」的第一次点按：`pointerdown` /
 * `pointerup` 照常派发，`click` 却被吞掉。底栏固定在滚动容器之外，用户想点它时
 * 滚动常常还在滑，于是表现为「点一下没反应」。`SidebarLink` 因此在 `pointerup`
 * 上自行判定并导航，再用时间窗把随后到达的兼容 `click` 压掉。
 *
 * 断言走源码：这些时序分支要靠真实合成器行为才走得到（夹具的合成 PointerEvent
 * 不经合成器，因此测不出来，与 `video-sidebar-touch-action.test.ts` 同一处境）。
 */
const SOURCE_URL = new URL("../src/app/layout/Sidebar.tsx", import.meta.url);

async function source(): Promise<string> {
  return Bun.file(SOURCE_URL).text();
}

describe("移动端底栏的 fling 点击兼容", () => {
  test("在 pointerup 上自行导航，不等被吞掉的 click", async () => {
    const text = await source();
    expect(text).toContain("onPointerUp={handlePointerUp}");
    expect(text).toContain("goToDestination();");
  });

  test("自行导航后的兼容 click 被压掉，同一次点按不导航两遍", async () => {
    const text = await source();
    const clickHandler = text.slice(text.indexOf("onClick={(event) => {"));
    const suppression = clickHandler.indexOf("Date.now() < suppressClickUntilRef.current");
    const keyboard = clickHandler.indexOf("if (event.detail !== 0) return;");
    expect(suppression).toBeGreaterThan(-1);
    expect(suppression).toBeLessThan(keyboard);
    expect(clickHandler.slice(suppression, keyboard)).toContain("event.preventDefault()");
  });

  test("只认触摸：鼠标与键盘走 NavLink 自己的路径", async () => {
    const text = await source();
    expect(text).toContain('if (pointerType !== "touch" && pointerType !== "")');
    // 键盘激活（detail === 0）仍自行导航，鼠标 click（detail > 0）交给 NavLink。
    expect(text).toContain("if (event.detail !== 0) return;");
  });

  test("滑动、长按与指针已被祖先捕获都不算点按", async () => {
    const text = await source();
    expect(text).toContain("hasLongPressMovedBeyondSlop(tap.x, tap.y, event.clientX, event.clientY)");
    expect(text).toContain("SIDEBAR_TAP_MAX_DURATION_MS");
    // 祖先横滑锁定后会 setPointerCapture；两边都导航会翻两次。
    expect(text).toContain("hasPointerCapture(event.pointerId)");
    expect(text).toContain("onPointerCancel={handlePointerCancel}");
  });

  test("自行导航带上侧栏状态，Shell 才认得出这是底栏直达", async () => {
    const text = await source();
    expect(text).toContain("navigate(to, { state: SIDEBAR_NAVIGATION_STATE })");
    // 原来的键盘路径也走同一个出口，不再各写一份 navigate。
    expect(text).not.toContain("navigate(to);");
  });
});
