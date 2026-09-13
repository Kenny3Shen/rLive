import { describe, expect, test } from "bun:test";

/**
 * 移动端触摸路径上，chrome（HUD + 控制条）的可见性只能由点按识别器驱动，
 * 舞台的指针活动与指针离场都不得改写它。
 *
 * 真机实测的两个缺陷都源自越过这条线（vivo V2509A / Android 16 / WebView 151）：
 * - `onPointerEnter` / `onPointerMove` 顺手 `revealControls()`：按下时 chrome 就已可见，
 *   约 200ms 后（满双击窗口）才跑的单击回调按「已可见」把它收掉，HUD 闪一下即灭。
 * - 触摸抬手的 `pointerleave` 排隐藏：`scheduleControlsHide` 的 `keepVisible` 守卫在
 *   暂停/缓冲/失败时把 chrome 置为可见，紧随其后的单击回调便只会收起，暂停态点不出 HUD。
 *
 * 用源码断言而非行为断言：`bun test` 无 DOM 环境（现有单测只用 `renderToStaticMarkup`），
 * 且合成 PointerEvent 走不到真机的识别器时序。行为侧由 `player-surface-click.browser.js`、
 * `player-chrome-leave.browser.js` 与真机验证覆盖。
 */

const PAGES = {
  VOD: "../src/features/video/VideoPlayerPage.tsx",
  直播: "../src/features/room/PlayerPane.tsx",
} as const;

const sources = Object.fromEntries(
  await Promise.all(
    Object.entries(PAGES).map(
      async ([label, path]) =>
        [label, await Bun.file(new URL(path, import.meta.url)).text()] as const,
    ),
  ),
) as Record<keyof typeof PAGES, string>;

const idleSource = await Bun.file(
  new URL("../src/shared/hooks/usePlayerChromeIdle.ts", import.meta.url),
).text();

/**
 * 取出一个 `useCallback` 处理器的源码片段，用于断言守卫与副作用的先后次序。
 *
 * 按括号配对切出 `useCallback(...)` 的实参，两页与 hook 的收尾写法不同
 * （`\n  );` 与同行的 `}, [deps]);`），按固定字符串找结尾会漏。这些处理器体内
 * 的字符串字面量不含括号，因此计数器无需处理字符串态。
 */
function handlerBody(source: string, name: string): string {
  const marker = `const ${name} = useCallback(`;
  const start = source.indexOf(marker);
  expect(start, `未找到处理器 ${name}`).toBeGreaterThan(-1);
  let depth = 0;
  for (let index = start + marker.length - 1; index < source.length; index += 1) {
    const char = source[index];
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index);
    }
  }
  throw new Error(`未找到 ${name} 的结尾`);
}

/** 移动端触摸的提前返回。两页的触摸判定各自沿用本页的谓词，故都放行。 */
const MOBILE_TOUCH_GUARD =
  /if \(mobileClient && isTouch(?:Like)?Pointer\(event\.pointerType\)\)\s*return;/;

describe("移动端触摸不改写播放器 chrome 可见性", () => {
  for (const label of ["VOD", "直播"] as const) {
    test(`${label} 页指针活动在唤出 chrome 前先挡掉移动端触摸`, () => {
      const body = handlerBody(sources[label], "handleStagePointerActivity");
      const guard = body.search(MOBILE_TOUCH_GUARD);
      expect(guard, "缺少移动端触摸的提前返回").toBeGreaterThan(-1);
      const reveal = body.indexOf("revealControls()");
      expect(reveal, "未找到 revealControls 调用").toBeGreaterThan(-1);
      expect(guard, "守卫必须早于 revealControls").toBeLessThan(reveal);
    });
  }

  test("VOD 页指针离场在排隐藏前先挡掉移动端触摸", () => {
    const body = handlerBody(sources.VOD, "handleStagePointerLeave");
    const guard = body.search(MOBILE_TOUCH_GUARD);
    expect(guard, "缺少移动端触摸的提前返回").toBeGreaterThan(-1);
    for (const call of ["scheduleControlsHide()", "dismissControls()"]) {
      const index = body.indexOf(call);
      expect(index, `未找到 ${call} 调用`).toBeGreaterThan(-1);
      expect(guard, `守卫必须早于 ${call}`).toBeLessThan(index);
    }
  });

  test("直播页指针离场只对鼠标生效", () => {
    const body = handlerBody(sources.直播, "handleStagePointerLeave");
    const guard = body.indexOf('if (event.pointerType !== "mouse") return;');
    expect(guard, "缺少仅鼠标的提前返回").toBeGreaterThan(-1);
    const hide = body.indexOf("hideControls()");
    expect(hide, "未找到 hideControls 调用").toBeGreaterThan(-1);
    expect(guard, "守卫必须早于 hideControls").toBeLessThan(hide);
  });

  test("两页单击回调都走切换语义，且越过 keepVisible 才能在暂停态收起", () => {
    for (const label of ["VOD", "直播"] as const) {
      expect(sources[label], `${label} 页单击未接 toggleControls`).toContain("toggleControls");
    }
    const hide = handlerBody(idleSource, "hideControls");
    expect(hide, "hideControls 不应沿用 keepVisible 守卫").not.toContain("keepVisible");
    expect(hide, "hideControls 必须保留键盘焦点守卫").toContain("hasKeyboardFocusWithinChrome()");
  });
});
