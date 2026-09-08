// 在 Vite 预览页运行真实组件与 danmu.js，IPC 和媒体时钟使用本地桩，不发送真实弹幕：
// playwright-cli -s=video-danmaku-actions run-code --filename=tests/video-danmaku-actions.browser.js
async (page) => {
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  await page.waitForFunction(() =>
    performance.getEntriesByType("resource").some((item) =>
      new URL(item.name).pathname.endsWith("/deps/react-dom_client.js"),
    ),
  );
  await page.evaluate(async () => {
    const dependencyUrl = (name) => {
      const resource = performance
        .getEntriesByType("resource")
        .find((item) => new URL(item.name).pathname.endsWith(`/deps/${name}.js`));
      if (!resource) throw new Error(`请先打开 Vite 预览页：未找到 ${name}`);
      return resource.name;
    };
    const { default: React } = await import(dependencyUrl("react"));
    const { default: ReactDOMClient } = await import(dependencyUrl("react-dom_client"));
    const { default: ReactDOM } = await import(dependencyUrl("react-dom"));
    const { QueryClient, QueryClientProvider } = await import(
      dependencyUrl("@tanstack_react-query")
    );
    const { VideoDanmakuLayer } = await import("/src/features/video/VideoDanmakuLayer.tsx");
    const { DanmuJsDanmaku } = await import("/src/features/room/danmaku/DanmuJsDanmaku.tsx");
    const { setExpectedDanmakuConnectionEpoch, clearExpectedDanmakuConnectionEpoch } =
      await import("/src/features/room/danmaku/eventBus.ts");
    const { loadDanmuJs } = await import("/src/features/room/danmaku/danmuJsLoader.ts");
    const { useSettingsStore } = await import("/src/shared/stores/settingsStore.ts");
    await loadDanmuJs();
    const settings = useSettingsStore.getState();
    const oldTauri = window.isTauri;
    const oldInternals = window.__TAURI_INTERNALS__;
    const oldEventInternals = window.__TAURI_EVENT_PLUGIN_INTERNALS__;
    const oldClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const { createElement: h, createRef } = React;
    const { flushSync } = ReactDOM;
    const host = document.createElement("div");
    document.body.append(host);
    const root = ReactDOMClient.createRoot(host);
    const videoRef = createRef();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const state = {
      time: 0,
      paused: false,
      active: true,
      interactive: true,
      cid: 123,
      aid: "456",
      live: false,
      clicks: 0,
      doubleClicks: 0,
      ups: 0,
      clipboard: "",
      calls: [],
      failSend: false,
    };
    const callbacks = new Map();
    let nextCallback = 1;
    let batchHandler = null;
    window.isTauri = true;
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    window.__TAURI_INTERNALS__ = {
      transformCallback: (callback) => {
        const id = nextCallback++;
        callbacks.set(id, callback);
        return id;
      },
      unregisterCallback: (id) => callbacks.delete(id),
      invoke: async (command, args) => {
        state.calls.push({ command, args });
        if (command === "plugin:event|listen" && args.event === "danmaku-batch") {
          batchHandler = callbacks.get(args.handler);
          return 1;
        }
        if (command === "plugin:event|unlisten") return;
        if (command.endsWith("danmaku_send") && state.failSend) throw "测试发送失败";
        if (command === "danmaku_favorite_list") return [];
      },
    };
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text) => {
          state.clipboard = text;
        },
      },
    });
    useSettingsStore.setState({
      danmakuSendEnabled: true,
      danmakuSendPending: false,
      danmakuFontSize: 24,
      danmakuArea: 1,
      danmakuOpacity: 1,
      danmakuShieldWords: [],
      danmakuBlockedUsers: [],
      danmakuMergeWindowSeconds: 0,
    });
    const entries = ["top", "scroll", "bottom"].map((mode) => ({
      id: `action-${mode}`,
      progressMs: 100,
      mode,
      content: mode === "top" ? "一起看视频" : `弹幕交互 ${mode}`,
      color: "#ffffff",
      pool: 0,
    }));
    const render = (patch = {}) => {
      Object.assign(state, patch);
      flushSync(() =>
        root.render(
          h(
            QueryClientProvider,
            { client },
            h(
              "section",
              {
                "data-danmaku-test-stage": "",
                style: {
                  position: "fixed",
                  inset: 0,
                  zIndex: 999,
                  background: "#111",
                  touchAction: "none",
                  "--video-danmaku-top": "72px",
                },
                onClick: () => state.clicks++,
                onDoubleClick: () => state.doubleClicks++,
                onPointerUp: (event) => {
                  if (!event.defaultPrevented) state.ups++;
                },
              },
              h("video", {
                ref: videoRef,
                style: { position: "absolute", inset: 0, width: "100%", height: "100%" },
              }),
              state.live
                ? h(DanmuJsDanmaku, {
                    siteId: "bilibili",
                    roomId: "789",
                    sessionKey: "actions-test",
                  })
                : h(VideoDanmakuLayer, {
                    videoRef,
                    entries,
                    active: state.active,
                    interactive: state.interactive,
                    cid: state.cid,
                    aid: state.aid,
                    title: "测试视频",
                    tapMaxDistance: 12,
                  }),
            ),
          ),
        ),
      );
      Object.defineProperties(videoRef.current, {
        currentTime: { configurable: true, get: () => state.time },
        paused: { configurable: true, get: () => state.paused },
      });
    };
    const seed = () => {
      state.time = 0;
      state.paused = false;
      videoRef.current.dispatchEvent(new Event("seeking"));
      videoRef.current.dispatchEvent(new Event("play"));
      state.time = 0.1;
      videoRef.current.dispatchEvent(new Event("timeupdate"));
    };
    window.__videoDanmakuActionsTest = {
      state,
      render,
      seed,
      pause: () => {
        state.paused = true;
        videoRef.current.dispatchEvent(new Event("pause"));
      },
      seek: () => {
        state.time = 8;
        videoRef.current.dispatchEvent(new Event("seeking"));
      },
      enableSend: (enabled) => useSettingsStore.setState({ danmakuSendEnabled: enabled }),
      liveReady: () => Boolean(batchHandler),
      emitLive: () => {
        setExpectedDanmakuConnectionEpoch(123);
        batchHandler({
          payload: {
            connection_epoch: 123,
            events: [
              { kind: "chat", user: "观众", content: "直播弹幕回归", color: null, ts: Date.now() },
            ],
          },
        });
      },
      dispose: () => {
        flushSync(() => root.unmount());
        host.remove();
        client.clear();
        clearExpectedDanmakuConnectionEpoch(123);
        useSettingsStore.setState(settings);
        window.isTauri = oldTauri;
        window.__TAURI_INTERNALS__ = oldInternals;
        window.__TAURI_EVENT_PLUGIN_INTERNALS__ = oldEventInternals;
        if (oldClipboard) Object.defineProperty(navigator, "clipboard", oldClipboard);
        else delete navigator.clipboard;
        delete window.__videoDanmakuActionsTest;
      },
    };
    render();
  });
  const passed = [];
  const state = () => page.evaluate(() => window.__videoDanmakuActionsTest.state);
  const menu = page.locator("[data-danmaku-menu]");
  const top = page.locator('[data-rlive-danmaku-id="action-top"] [data-rlive-danmaku-content]');
  const waitMenu = () => menu.waitFor({ state: "visible" });
  const noMenu = () => menu.waitFor({ state: "detached" });
  const center = async (locator) => {
    const box = await locator.boundingBox();
    assert(box, "未找到弹幕矩形");
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  const tap = async (locator) => {
    const point = await center(locator);
    // 移动中的 bullet 不满足 locator.click 的 stable 条件，直接按实时位置点按。
    if (await page.evaluate(() => navigator.maxTouchPoints > 0))
      await page.touchscreen.tap(point.x, point.y);
    else await page.mouse.click(point.x, point.y);
  };
  const blank = async () => {
    const size =
      page.viewportSize() ??
      (await page.evaluate(() => ({ width: innerWidth, height: innerHeight })));
    await page.mouse.click(size.width - 30, size.height / 2);
  };
  const seed = async () => {
    await page.waitForSelector("[data-video-danmaku-layer].danmu");
    await page.evaluate(() => window.__videoDanmakuActionsTest.seed());
    await top.waitFor({ state: "visible" });
  };
  try {
    await seed();
    const before = await state();
    await tap(top);
    await waitMenu();
    const after = await state();
    assert(after.clicks === before.clicks && after.ups === before.ups, "点弹幕泄漏到播放器");
    assert((await menu.getByRole("button").count()) === 3, "未复用三个操作按钮");
    const menuBox = await menu.boundingBox();
    const size =
      page.viewportSize() ??
      (await page.evaluate(() => ({ width: innerWidth, height: innerHeight })));
    assert(
      menuBox.x >= 0 && menuBox.x + menuBox.width <= size.width + 1 && menuBox.y >= 0,
      "菜单超出视口",
    );
    await page.screenshot({ path: `/tmp/rlive-video-danmaku-actions-${size.width}.png` });
    passed.push("点按定住弹幕，菜单与选框可见且不触发播放器");

    await menu.getByRole("button", { name: "复制弹幕", exact: true }).click();
    await page.waitForFunction(
      () => window.__videoDanmakuActionsTest.state.clipboard === "一起看视频",
    );
    await menu.getByRole("button", { name: "收藏弹幕", exact: true }).click();
    await page.waitForFunction(() =>
      document.querySelector("[data-danmaku-menu]")?.textContent.includes("已收藏"),
    );
    await page.evaluate(() => {
      window.__videoDanmakuActionsTest.state.time = 42.3459;
    });
    await menu.getByRole("button", { name: "发送相同的弹幕（+1）", exact: true }).click();
    await page.waitForFunction(() =>
      document.querySelector("[data-danmaku-menu]")?.textContent.includes("已发送"),
    );
    const calls = (await state()).calls;
    assert(
      calls.some(
        ({ command, args }) =>
          command === "danmaku_favorite_add" &&
          args.siteId === "bilibili" &&
          args.content === "一起看视频",
      ),
      "收藏参数错误",
    );
    const send = calls.find(({ command }) => command === "video_danmaku_send");
    assert(
      send?.args.cid === 123 &&
        send.args.aid === "456" &&
        send.args.progressMs === 42345 &&
        send.args.message === "一起看视频" &&
        send.args.videoTitle === "测试视频" &&
        !("roomId" in send.args),
      "VOD +1 接口或当前播放进度错误",
    );
    assert(!calls.some(({ command }) => command === "bilibili_danmaku_send"), "视频误发直播弹幕");
    passed.push("复制原文、收藏缓存及视频 +1 当前进度参数正确");

    await page.evaluate(() => {
      window.__videoDanmakuActionsTest.state.failSend = true;
    });
    await menu.getByRole("button", { name: "发送相同的弹幕（+1）", exact: true }).click();
    await page.waitForFunction(() =>
      document.querySelector("[data-danmaku-menu]")?.textContent.includes("视频限制"),
    );
    await page.evaluate(() => window.__videoDanmakuActionsTest.enableSend(false));
    assert(
      await menu.getByRole("button", { name: "请先在账号设置启用发送功能" }).isDisabled(),
      "未启用发送时 +1 未禁用",
    );
    await tap(top);
    await noMenu();
    passed.push("发送失败可见，权限关闭后禁用，再点同条可取消");

    await seed();
    const doublePoint = await center(top);
    const beforeDouble = await state();
    await page.mouse.dblclick(doublePoint.x, doublePoint.y);
    await noMenu();
    const afterDouble = await state();
    assert(
      afterDouble.clicks === beforeDouble.clicks &&
        afterDouble.doubleClicks === beforeDouble.doubleClicks &&
        afterDouble.ups === beforeDouble.ups,
      "双击弹幕泄漏到播放器",
    );
    passed.push("双击弹幕不触发暂停或全屏");

    await seed();
    const scroll = page.locator(
      '[data-rlive-danmaku-id="action-scroll"] [data-rlive-danmaku-content]',
    );
    await page.waitForFunction(() => {
      const rect = document
        .querySelector('[data-rlive-danmaku-id="action-scroll"]')
        ?.getBoundingClientRect();
      return rect && rect.left < innerWidth - 150;
    });
    await tap(scroll);
    await waitMenu();
    const pinned = await center(scroll);
    await page.waitForTimeout(150);
    assert(Math.abs((await center(scroll)).x - pinned.x) < 1, "点按后滚动弹幕没有停住");
    await page.evaluate(() => window.__videoDanmakuActionsTest.pause());
    await blank();
    await noMenu();
    const paused = await center(scroll);
    await page.waitForTimeout(150);
    assert(
      Math.abs((await center(scroll)).x - paused.x) < 1 && (await state()).paused,
      "解除选中后恢复了暂停中的弹幕",
    );
    await page.evaluate(() => {
      window.__videoDanmakuActionsTest.state.paused = false;
      document.querySelector("[data-danmaku-test-stage] video").dispatchEvent(new Event("play"));
    });
    await page.waitForFunction(
      (x) =>
        document.querySelector('[data-rlive-danmaku-id="action-scroll"]').getBoundingClientRect()
          .left <
        x - 2,
      paused.x - (await scroll.boundingBox()).width / 2,
    );
    passed.push("滚动弹幕冻结，暂停时解除不偷播，恢复后继续移动");

    await seed();
    const point = await center(top);
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.mouse.move(point.x + 30, point.y);
    await page.mouse.move(point.x, point.y);
    await page.mouse.up();
    await noMenu();
    await page.mouse.down();
    await page.waitForTimeout(400);
    await page.mouse.up();
    await noMenu();
    passed.push("拖动后回原点、长按均不打开弹幕菜单");

    await tap(top);
    await waitMenu();
    await page.evaluate(() => window.__videoDanmakuActionsTest.seek());
    await noMenu();
    await seed();
    await tap(top);
    await waitMenu();
    await page.evaluate(() => window.__videoDanmakuActionsTest.render({ cid: 124 }));
    await noMenu();
    await seed();
    await tap(top);
    await waitMenu();
    await page.evaluate(() => window.__videoDanmakuActionsTest.render({ interactive: false }));
    await noMenu();
    await tap(top);
    await noMenu();
    await page.evaluate(() => window.__videoDanmakuActionsTest.render({ active: false }));
    assert(
      (await page.locator("[data-video-danmaku-layer] [data-rlive-danmaku-id]").count()) === 0,
      "关闭弹幕仍有残留",
    );
    passed.push("seek、换视频、全屏锁与弹幕关闭正确清理交互");

    await page.evaluate(() => {
      const test = window.__videoDanmakuActionsTest;
      test.enableSend(true);
      test.render({ live: true, failSend: false });
    });
    await page.waitForFunction(() => window.__videoDanmakuActionsTest.liveReady());
    await page.waitForSelector('[data-rlive-danmaku-layer="scroll"].danmu');
    await page.evaluate(() => window.__videoDanmakuActionsTest.emitLive());
    const liveBullet = page.locator(
      '[data-rlive-danmaku-layer="scroll"] [data-rlive-danmaku-content]',
    );
    await page.waitForFunction(() => {
      const rect = document
        .querySelector('[data-rlive-danmaku-layer="scroll"] [data-rlive-danmaku-content]')
        ?.getBoundingClientRect();
      return rect && rect.left < innerWidth - 150;
    });
    await tap(liveBullet);
    await waitMenu();
    await menu.getByRole("button", { name: "发送相同的弹幕（+1）", exact: true }).click();
    await page.waitForFunction(() =>
      window.__videoDanmakuActionsTest.state.calls.some(
        ({ command }) => command === "bilibili_danmaku_send",
      ),
    );
    const liveSend = (await state()).calls.find(
      ({ command }) => command === "bilibili_danmaku_send",
    );
    assert(
      liveSend.args.roomId === "789" &&
        liveSend.args.message === "直播弹幕回归" &&
        !("cid" in liveSend.args),
      "共享改动破坏直播 +1",
    );
    await blank();
    await noMenu();
    passed.push("直播弹幕共用点按逻辑，直播 +1 接口保持正确");
    return { viewport: size, passed };
  } finally {
    await page.evaluate(() => window.__videoDanmakuActionsTest?.dispose());
  }
}
