// 播放表面的残留选区与系统长按菜单（真实 Shell/播放页，mock IPC）。
// playwright-cli -s=selection run-code --filename=tests/playback-selection.browser.js
//
// 复现的缺陷：在评论区选中文字后返回播放页，此后长按画面不再触发倍速，而是弹出
// 系统选项。两处成因，各由本夹具的一半守住：
//
//   1. 选区残留：抽屉卸载后选区可能仍非折叠，系统把长按读成「拖拽已有选区」。
//      画面按压因此先清一次非折叠选区（`clearStaleSelection`）。
//   2. 系统长按菜单：Android WebView 在长按点派发 contextmenu；倍速期间必须压掉，
//      且 `pointercancel` 先到、contextmenu 后到的那一帧也要算作本次按压。
async (page) => {
  const originalUrl = page.url();
  const originalOrigin = await page.evaluate(() => location.origin);
  const originalUa = await page.evaluate(() => navigator.userAgent);
  const client = await page.context().newCDPSession(page);
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const passed = [];
  const errors = [];
  const recordError = (error) => errors.push(error.message);
  page.on("pageerror", recordError);
  const frames = () =>
    page.evaluate(async () => {
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
    });
  /** 在画面表面上合成一次触摸按压（桌面 CDP 没有 hasTouch，自己派发）。 */
  const pressSurface = (phase, extra = {}) =>
    page.evaluate(
      ({ phase, extra }) => {
        const surface = document.querySelector("[data-player-video-surface]");
        if (!surface) throw new Error("找不到播放表面");
        const rect = surface.getBoundingClientRect();
        surface.dispatchEvent(
          new PointerEvent(phase, {
            pointerId: 77,
            pointerType: "touch",
            isPrimary: true,
            button: 0,
            buttons: phase === "pointerup" ? 0 : 1,
            clientX: rect.left + rect.width / 2,
            clientY: rect.top + rect.height / 2,
            bubbles: true,
            cancelable: true,
            ...extra,
          }),
        );
      },
      { phase, extra },
    );
  const readSelection = () =>
    page.evaluate(() => {
      const selection = document.getSelection();
      return {
        text: selection?.toString() ?? "",
        collapsed: selection?.isCollapsed ?? true,
        rangeCount: selection?.rangeCount ?? 0,
      };
    });
  try {
    await client.send("Network.setUserAgentOverride", {
      userAgent:
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36",
      userAgentMetadata: {
        brands: [],
        fullVersionList: [],
        platform: "Android",
        platformVersion: "14",
        architecture: "",
        model: "Pixel 8",
        mobile: true,
      },
    });
    await client.send("Emulation.setDeviceMetricsOverride", {
      width: 401,
      height: 757,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await page.goto(`${originalOrigin}/tests/browser/video-shell.html`);
    await page.evaluate(async () => {
      await import("/src/styles.css");
    });
    await page.waitForFunction(() => Boolean(window.shellFixture));
    await page.evaluate(() => window.shellFixture.router.navigate("/video/play?bvid=BV1shell&cid=1001"));
    await page.waitForSelector("[data-player-video-surface]", { timeout: 20000 });
    await page.waitForSelector('[data-video-side-tab-panel="related"]', { timeout: 20000 });
    await frames();

    // 播放表面整体不可选中：长按不会命中文字节点而改走「选择文字」分支。
    // 这条类名由 `mobileClient` 门控（与两个短视频视口的 `select-none` 同一做法），
    // 桌面 CDP 会话的 `pointer: coarse` 为假，因此断言类名而不是计算样式。
    const surfaceSelectable = await page.evaluate(() => {
      const surface = document.querySelector("[data-player-video-surface]");
      return {
        classes: surface.className,
        computed: getComputedStyle(surface).userSelect,
      };
    });
    assert(
      surfaceSelectable.classes.includes("select-none"),
      `播放表面未声明不可选中：${surfaceSelectable.classes}`,
    );

    // 侧栏正文仍可选择：不可选中只覆盖播放表面，不泄漏到侧栏。
    const asideSelectable = await page.evaluate(() => {
      const aside = document.querySelector('aside[aria-label="视频详情"]');
      return { classes: aside.className, computed: getComputedStyle(aside).userSelect };
    });
    assert(!asideSelectable.classes.includes("select-none"), `侧栏被误设为不可选中`);
    assert(asideSelectable.computed === "auto", `侧栏计算样式被改：${asideSelectable.computed}`);
    passed.push("不可选中只覆盖播放表面，侧栏正文仍可选");

    // 可编辑元素里的选区归用户自己：按压画面不该动它。
    //
    // 输入框的内部选区在 `document.getSelection()` 上读到的是一段折叠 caret，
    // 清理函数因此提前返回、根本不调 `removeAllRanges`；真实世界里长按画面的
    // 那一下不能把用户刚选中的弹幕文本抹掉，也不能让输入框失焦。
    const keptSelection = await page.evaluate(() => {
      const host = document.createElement("div");
      host.innerHTML = '<input id="probe-input" value="弹幕内容" />';
      document.body.append(host);
      const input = host.querySelector("#probe-input");
      input.focus();
      input.setSelectionRange(0, 2);
      const selection = document.getSelection();
      return {
        start: input.selectionStart,
        end: input.selectionEnd,
        focused: document.activeElement === input,
        docCollapsed: selection?.isCollapsed ?? true,
      };
    });
    assert(
      keptSelection.focused && keptSelection.end > keptSelection.start,
      `夹具未造出输入框选区：${JSON.stringify(keptSelection)}`,
    );
    await pressSurface("pointerdown");
    await frames();
    const inputAfter = await page.evaluate(() => {
      const input = document.querySelector("#probe-input");
      return {
        focused: document.activeElement === input,
        start: input?.selectionStart,
        end: input?.selectionEnd,
      };
    });
    await pressSurface("pointerup");
    await frames();
    assert(
      inputAfter.focused && inputAfter.end > inputAfter.start,
      `画面按压抹掉了输入框里的选区：${JSON.stringify(inputAfter)}`,
    );
    await page.evaluate(() => document.querySelector("#probe-input")?.parentElement?.remove());
    passed.push("输入框内的选区不被画面按压抹掉");

    // 倍速武装期间到达的 contextmenu 必须被压掉（否则系统菜单盖住倍速提示）。
    await pressSurface("pointerdown");
    await frames();
    const duringPress = await page.evaluate(() => {
      const surface = document.querySelector("[data-player-video-surface]");
      const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
      surface.dispatchEvent(event);
      return event.defaultPrevented;
    });
    assert(duringPress, "长按倍速武装期间的 contextmenu 未被压掉");
    await pressSurface("pointerup");
    await frames();
    passed.push("长按倍速期间压掉系统长按菜单");

    // 不武装时的右键菜单必须保留（桌面右键、侧栏文本菜单都不受影响）。
    const idlePress = await page.evaluate(() => {
      const surface = document.querySelector("[data-player-video-surface]");
      const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
      surface.dispatchEvent(event);
      return event.defaultPrevented;
    });
    assert(!idlePress, "未按压时也压掉了 contextmenu");
    passed.push("未武装时保留右键菜单");

    // 残留选区：造一个非折叠选区后按压画面，必须被清掉。
    const madeStale = await page.evaluate(() => {
      const aside = document.querySelector('aside[aria-label="视频详情"]');
      const walker = document.createTreeWalker(aside, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node && node.textContent.trim().length < 4) node = walker.nextNode();
      if (!node) return false;
      const range = document.createRange();
      range.selectNode(node);
      const selection = document.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return !selection.isCollapsed;
    });
    assert(madeStale, "夹具未造出非折叠选区");
    await pressSurface("pointerdown");
    await frames();
    const cleared = await readSelection();
    await pressSurface("pointerup");
    await frames();
    assert(cleared.collapsed, `画面按压未清掉残留选区：${JSON.stringify(cleared)}`);
    passed.push("画面按压清掉残留选区");

    return { passed };
  } catch (error) {
    throw new Error(`${error.message}; 已通过：${passed.join("；")}；页面错误：${errors.join("；")}`);
  } finally {
    page.off("pageerror", recordError);
    await client.send("Network.setUserAgentOverride", { userAgent: originalUa });
    await client.send("Emulation.clearDeviceMetricsOverride");
    await client.detach();
    await page.goto(originalUrl);
  }
}
