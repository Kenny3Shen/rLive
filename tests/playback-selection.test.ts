import { describe, expect, test } from "bun:test";

/**
 * 播放表面的残留选区清理。
 *
 * 评论区抽屉里选中一段文字后返回播放页，选区仍挂在已经脱离文档的节点上，系统会把
 * 下一次长按读成「拖拽已有选区」—— 长按倍速因此永不触发，弹出的是复制/全选菜单。
 * 这里守住三条边界：清非折叠选区、不碰可编辑元素内的选区、不碰折叠光标。
 *
 * 断言走源码而不是 DOM：`clearStaleSelection` 依赖 `document.getSelection()`，
 * 而 bun test 没有 DOM；这两条边界都是纯静态的书写约束，源码断言足够守住它们
 * （与 `video-sidebar-touch-action.test.ts` 同一套做法）。
 */
const SOURCE_URL = new URL("../src/shared/selection.ts", import.meta.url);

describe("播放表面的残留选区清理", () => {
  test("清掉非折叠选区，且用 removeAllRanges", async () => {
    const source = await Bun.file(SOURCE_URL).text();
    expect(source).toContain("selection.isCollapsed");
    expect(source).toContain("selection.removeAllRanges()");
  });

  test("跳过可编辑元素内的选区", async () => {
    const source = await Bun.file(SOURCE_URL).text();
    expect(source).toContain('input, textarea, [contenteditable="true"]');
  });

  test("折叠光标不清：那是输入框的插入点", async () => {
    const source = await Bun.file(SOURCE_URL).text();
    // 折叠时提前返回，不能走到 removeAllRanges。
    const collapsedGuard = source.indexOf("if (!selection || selection.isCollapsed) return false;");
    const removal = source.indexOf("selection.removeAllRanges()");
    expect(collapsedGuard).toBeGreaterThan(-1);
    expect(collapsedGuard).toBeLessThan(removal);
  });

  test("三个播放表面都接上了清理", async () => {
    const callers = [
      "../src/features/shorts/useShortsInteraction.ts",
      "../src/features/video/VideoPlayerPage.tsx",
    ];
    for (const path of callers) {
      const source = await Bun.file(new URL(path, import.meta.url)).text();
      expect(source).toContain('from "@/shared/selection"');
      expect(source).toContain("clearStaleSelection()");
    }
  });
});

/**
 * 短视频长按倍速与系统长按菜单的归属判定。
 *
 * `onContextMenu` 不能只看「现在是否按住」：Android WebView 在系统长按点先派发
 * `pointercancel` 再派发 contextmenu，取消路径已经清掉按压状态，菜单却还没弹。
 * 归属判定因此走共享的 `isContextMenuOwnedByPress`（含触发后的宽限期）。
 */
describe("短视频长按倍速的系统菜单归属", () => {
  test("hook 导出 onContextMenu 且用共享归属判定", async () => {
    const source = await Bun.file(
      new URL("../src/features/shorts/useShortsInteraction.ts", import.meta.url),
    ).text();
    expect(source).toContain("onContextMenu,");
    expect(source).toContain("isContextMenuOwnedByPress(");
    // 触发时刻必须记下来，否则宽限期永远是 0（= 永不归属）。
    expect(source).toContain("speedHoldTriggeredAtRef.current = Date.now()");
  });

  test("两个短视频页面都挂上 onContextMenu 且画面不可选", async () => {
    for (const path of [
      "../src/features/shorts/ShortsPage.tsx",
      "../src/features/shorts/DouyinShortsFeed.tsx",
    ]) {
      const source = await Bun.file(new URL(path, import.meta.url)).text();
      expect(source).toContain("onContextMenu={");
      // 不可选中必须写在视口自己的 className 上（与播放页画面同一做法）：
      // 只靠粗指针媒体查询会让桌面 WebView2 漏掉，而长按倍速对鼠标也成立。
      expect(source).toMatch(/data-slot="shorts-viewport"[\s\S]{0,600}select-none/);
    }
  });

  test("播放页的 contextmenu 同样按归属判定，不只按当前按住", async () => {
    const source = await Bun.file(
      new URL("../src/features/video/VideoPlayerPage.tsx", import.meta.url),
    ).text();
    expect(source).toContain("isContextMenuOwnedByPress(");
    expect(source).toContain("speedHoldTriggeredAtRef.current = Date.now()");
  });
});
