// 短视频视口的不可选中与系统长按菜单（真实 ShortsPage，mock IPC）。
// playwright-cli -s=shorts-lp run-code --filename=tests/shorts-long-press.browser.js
//
// 复现的缺陷：在评论区选中文字后返回播放页，再长按画面不会触发倍速，而是选中短视频
// 元素并弹出系统选项。两处成因：
//
//   1. 画面本身可选：Android WebView 的长按命中文字节点时改走「选择文字」分支，
//      我们自己的计时器即使触发也被系统菜单盖住。视口因此必须 `select-none`。
//   2. 长按点派发的 contextmenu 没有被压掉：`pointercancel` 先到、contextmenu 后到
//      的那一帧里只看「现在是否按住」已经为假，菜单照样弹出。归属判定因此走共享的
//      `isContextMenuOwnedByPress`（含触发后的宽限期）。
async (page) => {
  const originalUrl = page.url();
  const origin = await page.evaluate(() => location.origin);
  const pattern = "**/src/shared/api/tauri.ts*";
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const passed = [];
  const errors = [];
  const recordError = (error) => errors.push(error.message);
  page.on("pageerror", recordError);
  try {
    await page.unroute(pattern);
    await page.goto(`${origin}/settings`);
    const source = await page.evaluate(async () => (await fetch("/src/shared/api/tauri.ts")).text());
    const signature = "async function invokeCmd(cmd, args) {";
    assert(source.includes(signature), "IPC 测试注入点已改变");
    await page.route(pattern, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/javascript",
        body: source.replace(signature, `${signature}\nif (window.__shortsLongPressInvoke) return window.__shortsLongPressInvoke(cmd, args);`),
      }),
    );
    await page.goto(`${origin}/settings`);
    const result = await page.evaluate(async () => {
      const { setupHarness, dependencyUrl, until, frames } = await import("/tests/browser/harness.js");
      const { QueryClient, QueryClientProvider } = await import(dependencyUrl("@tanstack_react-query"));
      const { MemoryRouter, Routes, Route } = await import(dependencyUrl("react-router-dom"));
      const { ShortsPage } = await import("/src/features/shorts/ShortsPage.tsx");
      const item = (index) => ({
        bvid: `BV1lp${index}`,
        aid: String(index),
        cid: 100 + index,
        title: `长按回归 ${index}`,
        cover: "",
        author: "UP",
        author_face: null,
        duration: 60,
        view: 1,
        danmaku: 1,
        reply: 1,
        pubdate: 0,
        rcmd_reason: null,
        dimension: { width: 1080, height: 1920, rotate: 0 },
      });
      const items = [item(1), item(2)];
      window.__shortsLongPressInvoke = async (cmd) => {
        if (cmd === "video_get_story") return { items, has_more: false };
        if (cmd === "video_get_danmaku") return { items: [], has_more: false };
        return null;
      };
      const ui = await setupHarness({
        style: "position:fixed;inset:0;z-index:1000;background:#000",
        strict: false,
      });
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      ui.render(
        ui.h(
          QueryClientProvider,
          { client },
          ui.h(
            MemoryRouter,
            { initialEntries: ["/shorts/bilibili"] },
            ui.h(Routes, null, ui.h(Route, { path: "/shorts/bilibili", element: ui.h(ShortsPage) })),
          ),
        ),
      );
      await until(() => ui.query('[data-slot="shorts-viewport"]'), "竖屏视口未挂载", 15000);
      await until(() => ui.query('[data-slot="shorts-frame"]'), "画面框未挂载", 15000);
      const viewport = ui.query('[data-slot="shorts-viewport"]');
      const frame = ui.query('[data-slot="shorts-frame"]');
      const out = { viewportClasses: viewport.className };

      // 视口不可选中：长按不会命中文字节点而改走系统选择。
      out.userSelect = getComputedStyle(viewport).userSelect;

      // 评论抽屉里的文字仍可选择（抽屉走 portal，不受视口 select-none 影响）。
      out.drawerSelectable = getComputedStyle(document.body).userSelect;

      // 未按压时：右键菜单保留（桌面右键、输入框文本菜单都靠它）。
      out.idleContextMenuPrevented = await (() => {
        const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
        frame.dispatchEvent(event);
        return event.defaultPrevented;
      })();

      // 按压武装期间：contextmenu 必须被压掉。
      const rect = frame.getBoundingClientRect();
      const init = {
        pointerId: 90,
        pointerType: "touch",
        isPrimary: true,
        button: 0,
        buttons: 1,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
        bubbles: true,
        cancelable: true,
      };
      frame.dispatchEvent(new PointerEvent("pointerdown", init));
      await frames();
      out.armedContextMenuPrevented = await (() => {
        const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
        frame.dispatchEvent(event);
        return event.defaultPrevented;
      })();
      window.dispatchEvent(new PointerEvent("pointerup", { ...init, buttons: 0 }));
      await frames();

      // 一次**没有触发过倍速**的短按抬手之后，右键菜单必须恢复：宽限期只属于真正
      // 触发过的那次按压，否则任何一次点按之后的右键都会被平白吞掉。
      // （夹具没有可播放媒体，倍速计时器不会真的触发，因此这里只能守住「不误伤」
      // 这一侧；「抬手后宽限期内仍归属」由 `playback-selection.test.ts` 的
      // `isContextMenuOwnedByPress` 断言与共享实现守住。）
      out.afterShortPressContextMenuPrevented = await (() => {
        const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
        frame.dispatchEvent(event);
        return event.defaultPrevented;
      })();

      ui.dispose();
      return out;
    });

    assert(
      result.viewportClasses.includes("select-none"),
      `短视频视口未声明不可选中：${result.viewportClasses}`,
    );
    assert(result.userSelect === "none", `视口计算样式不是 none：${result.userSelect}`);
    assert(
      result.drawerSelectable === "auto",
      `视口之外被误设为不可选中：${result.drawerSelectable}`,
    );
    assert(!result.idleContextMenuPrevented, "未按压时也压掉了 contextmenu");
    assert(result.armedContextMenuPrevented, "长按武装期间的 contextmenu 未被压掉");
    assert(
      !result.afterShortPressContextMenuPrevented,
      "未触发过倍速的短按抬手后仍在吞 contextmenu",
    );
    passed.push("视口不可选中，评论等视口外文本仍可选");
    passed.push("长按武装期间压掉系统长按菜单，未触发过倍速时不误伤");
    passed.push("未按压时保留右键菜单");
    return { passed };
  } catch (error) {
    throw new Error(`${error.message}; 已通过：${passed.join("；")}；页面错误：${errors.join("；")}`);
  } finally {
    page.off("pageerror", recordError);
    await page.unroute(pattern);
    await page.goto(originalUrl);
  }
}
