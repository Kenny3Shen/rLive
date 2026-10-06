// 在 Windows Debug 主窗口验证真实 Shell 的来源窗口放大/缩回，不改主窗口路由或用户数据。
// playwright-cli -s=rwin run-code --filename=tests/page-zoom-origin.browser.js
async (page) => {
  const run = async () =>
    await page.evaluate(async () => {
      const { setupHarness, dependencyUrl, assert, frames, until } =
        await import("/tests/browser/harness.js");
      const { Shell } = await import("/src/app/layout/Shell.tsx");
      const { createMemoryRouter, RouterProvider, useLocation } = await import(
        dependencyUrl("react-router-dom")
      );
      const { QueryClient, QueryClientProvider } = await import(
        dependencyUrl("@tanstack_react-query")
      );
      const ui = await setupHarness({
        style: "position:fixed;inset:0;z-index:1000;background:var(--background)",
      });
      const { h } = ui;
      const originalAnimate = Element.prototype.animate;
      const originalMatchMedia = window.matchMedia;
      const historyState = history.state;
      const client = new QueryClient();
      let router;
      let reduced = false;
      let cardVisible = true;
      const passed = [];
      const calls = [];
      const scope = () => ui.query('[data-slot="page-zoom"]');
      const card = () => scope()?.querySelector('[data-player-origin="test:video"]');
      const scroller = () => scope()?.querySelector('[data-slot="app-page"]');
      const video = () => scope()?.querySelector("video");
      function List() {
        const open = () => {
          history.replaceState({ ...historyState, idx: 1 }, "");
          void router.navigate("/video/play?bvid=origin&cid=1");
        };
        return h(
          "div",
          { style: { height: 2400, paddingTop: 600 } },
          cardVisible &&
            h(
              "div",
              {
                role: "button",
                tabIndex: 0,
                "data-player-origin": "test:video",
                "data-page-scroll-anchor": "test:video",
                style: { marginLeft: "15%", width: 180, height: 110, background: "var(--primary)" },
                onClick: open,
                onKeyDown: (event) => {
                  if (event.key === "Enter") open();
                },
              },
              "播放来源",
              h(
                "button",
                { "data-secondary": true, onClick: (event) => event.stopPropagation() },
                "菜单",
              ),
            ),
        );
      }
      function Player() {
        const location = useLocation();
        return h(
          "div",
          { "data-test-play": location.search, style: { flex: 1, background: "black" } },
          h("video"),
        );
      }
      const waitEntry = async () => {
        await until(() => calls.length > 0 && video(), "播放页未展开");
        await frames();
        return calls.at(-1);
      };
      const settle = async () => {
        for (const animation of scope().getAnimations({ subtree: true })) animation.finish();
        await until(
          () =>
            scope().children.length === 1 && scope().getAnimations({ subtree: true }).length === 0,
          "未清理动画/背景层",
        );
        await frames();
        assert(
          scope().lastElementChild.style.transform === "" &&
            scope().lastElementChild.style.willChange === "",
          "残留变换祖先",
        );
        calls.length = 0;
      };
      const back = async () => {
        history.replaceState({ ...historyState, idx: 0 }, "");
        await router.navigate(-1);
        await until(() => calls.length > 0, "未启动缩回动画");
        await frames();
        return calls.at(-1);
      };
      const sameRect = (actual, expected, message) => {
        for (const key of ["left", "top", "width", "height"]) {
          assert(
            Math.abs(actual[key] - expected[key]) < 1.5,
            `${message} ${key}: ${actual[key]} != ${expected[key]}`,
          );
        }
      };
      const startCard = async (keyboard = false) => {
        scroller().scrollTop = 530;
        await frames();
        const source = card().getBoundingClientRect();
        const list = card();
        if (keyboard)
          list.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        else list.click();
        const entry = await waitEntry();
        assert(
          scope().children.length === 2 && scope().firstElementChild.inert,
          "入场缺少 inert 来源背景",
        );
        assert(card() === list && scroller().scrollTop === 530, "来源列表重挂载或滚动被归零");
        sameRect(entry.element.getBoundingClientRect(), source, "起点不在来源窗口");
        return { source, entry };
      };
      try {
        window.matchMedia = (query) =>
          query === "(prefers-reduced-motion: reduce)"
            ? { matches: reduced }
            : originalMatchMedia.call(window, query);
        Element.prototype.animate = function (...args) {
          const animation = originalAnimate.apply(this, args);
          if (ui.host.contains(this) && this.parentElement?.dataset.slot === "page-zoom") {
            animation.pause();
            animation.currentTime = 0;
            calls.push({ element: this, animation, keyframes: animation.effect.getKeyframes() });
          }
          return animation;
        };
        history.replaceState({ ...historyState, idx: 0 }, "");
        router = createMemoryRouter(
          [
            {
              element: h(Shell),
              children: [
                { path: "/settings", element: h(List) },
                { path: "/video/play", element: h(Player) },
              ],
            },
          ],
          { initialEntries: ["/settings"] },
        );
        ui.render(h(QueryClientProvider, { client }, h(RouterProvider, { router })));
        await until(() => card(), "列表未挂载");
        const { source, entry } = await startCard();
        const player = video();
        entry.animation.currentTime = 150;
        const middle = entry.element.getBoundingClientRect();
        assert(
          middle.width > source.width && middle.width < scope().clientWidth,
          "放大缺少真实中间帧",
        );
        await settle();
        const exit = await back();
        assert(
          video() === player && scope().firstElementChild.inert,
          "退出重建媒体节点或未禁用旧层",
        );
        assert(
          ui.query("[data-test-play]").dataset.testPlay.includes("bvid=origin"),
          "旧路由参数丢失",
        );
        exit.animation.currentTime = Number(exit.animation.effect.getTiming().duration);
        sameRect(
          exit.element.getBoundingClientRect(),
          card().getBoundingClientRect(),
          "终点未缩回恢复后的卡片",
        );
        await settle();
        assert(!video(), "离场媒体未卸载");
        passed.push("真实 Shell：从滚动后的卡片放大、背景不跳、旧播放器缩回原位且最终清理");

        const { entry: keyboardEntry } = await startCard(true);
        keyboardEntry.animation.currentTime = 90;
        const interruptedRect = keyboardEntry.element.getBoundingClientRect();
        calls.length = 0;
        const interruptedExit = await back();
        sameRect(
          interruptedExit.element.getBoundingClientRect(),
          interruptedRect,
          "快速返回未从当前帧接管",
        );
        assert(keyboardEntry.animation.playState === "idle", "旧动画未取消");
        await settle();
        passed.push("Enter 打开与快速反向均沿来源窗口，旧动画取消且无位置跳变");

        history.replaceState({ ...historyState, idx: 1 }, "");
        await router.navigate(1);
        const forward = await waitEntry();
        assert(forward.keyframes[0].transform.includes("translate"), "历史前进丢失来源");
        await settle();
        cardVisible = false;
        const missing = await back();
        assert(
          missing.keyframes.at(-1).transform.includes("translate"),
          "来源未加载时未回退到记忆窗口",
        );
        await settle();
        passed.push("历史前进保留来源，来源卡片缺失时使用记忆窗口");

        reduced = true;
        history.replaceState({ ...historyState, idx: 1 }, "");
        await router.navigate(1);
        await until(() => video() && scope().children.length === 1, "减少动态效果仍保留背景层");
        assert(calls.length === 0, "减少动态效果仍启动动画");
        cardVisible = true;
        history.replaceState({ ...historyState, idx: 0 }, "");
        await router.navigate(-1);
        await until(() => !video(), "减少动态效果未即时卸载播放器");
        assert(calls.length === 0, "减少动态效果仍启动退出动画");
        passed.push("减少动态效果下直接切页，无动画/背景残留");

        reduced = false;
        ui.query("[data-secondary]").click();
        history.replaceState({ ...historyState, idx: 1 }, "");
        await router.navigate("/video/play?bvid=programmatic");
        const noSource = await waitEntry();
        assert(noSource.keyframes[0].transform === "scale(0.96)", "卡内菜单污染了程序导航来源");
        await settle();
        await back();
        await settle();
        passed.push("次级按钮不记录来源，无来源导航保留轻量缩放兜底");
        return { passed };
      } finally {
        ui.dispose();
        router?.dispose();
        client.clear();
        Element.prototype.animate = originalAnimate;
        window.matchMedia = originalMatchMedia;
        history.replaceState(historyState, "");
      }
    });
  const cdp = await page.context().newCDPSession(page);
  const results = [];
  try {
    for (const viewport of [
      { width: 1280, height: 800, mobile: false },
      { width: 360, height: 732, mobile: true },
      { width: 844, height: 390, mobile: true },
    ]) {
      await cdp.send("Emulation.setDeviceMetricsOverride", { ...viewport, deviceScaleFactor: 1 });
      await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: viewport.mobile });
      // 长驻主窗口的 Resource Timing 缓冲可能已淘汰依赖 URL，重载同一路由再装配。
      await page.reload();
      await page.waitForFunction(() => document.querySelector('[data-slot="page-zoom"]'));
      results.push({ viewport, ...(await run()) });
    }
    return results;
  } finally {
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
    await cdp.send("Emulation.clearDeviceMetricsOverride");
    await cdp.detach();
  }
}
