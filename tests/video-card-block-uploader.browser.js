// 在 Windows 主窗口 / Vite 页面验证真实 VideoCard 的「屏蔽 UP 主」次级动作：
// 桌面端右键菜单、触摸端长按底部抽屉、以及没有 UID 时两种入口都不出现。
//
// playwright-cli -s=rwin run-code --filename=tests/video-card-block-uploader.browser.js
//
// 契约（断言的是真实 DOM、事件与 store 状态，不是类名）：
//  1. 桌面卡是 ContextMenuTrigger：右键后出现「屏蔽 UP 主 作者名」，点它把该 UID
//     写进 `videoBlockedUploaders`。
//  2. 触摸端长按（pointerType: touch）弹出抽屉，抽屉里的按钮同样写入名单；
//     长按后松手合成的点按不得打开视频（导航计数为 0）。
//  3. 条目没有 UID 时不挂右键菜单也不挂长按：右键不出现菜单，长按不弹抽屉。
// 只桩 IPC 与 store 持久化，不访问真实站点。
async (page) => {
  const ready = () =>
    performance.getEntriesByType("resource").some((r) => r.name.includes("/deps/react-router-dom"));
  if (!(await page.evaluate(ready))) {
    await page.goto("http://localhost:1420/video", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(ready, null, { timeout: 30000 });
  }
  return page.evaluate(async () => {
    const { setupHarness, dependencyUrl, frames, assert, until } = await import(
      "/tests/browser/harness.js"
    );
    const { MemoryRouter, useNavigate } = await import(dependencyUrl("react-router-dom"));
    const { QueryClient, QueryClientProvider } = await import(
      dependencyUrl("@tanstack_react-query")
    );
    const { useSettingsStore } = await import("/src/shared/stores/settingsStore.ts");
    const { VideoCard } = await import("/src/features/video/VideoCard.tsx");
    // 必须复用页面已加载的 React 运行时（见 harness 的 `dependencyUrl` 注释）；
    // `default` 是 CJS 互操作后的 React 命名空间，`createElement` 挂在它上面。
    const ReactModule = await import(dependencyUrl("react"));
    const React = ReactModule.default ?? ReactModule;
    const h = React.createElement.bind(React);

    const base = {
      bvid: "BVblock1", aid: "1", cid: 7, title: "屏蔽回归", cover: "", author: "作者甲",
      author_mid: "424242", author_face: null, duration: 60, view: 1, danmaku: 1,
      pubdate: 0, rcmd_reason: null,
    };
    const originalUploaders = useSettingsStore.getState().videoBlockedUploaders;
    // 本测试只验证 UI 到 store 的链路，不需要真的改用户设置：把持久化换成空实现，
    // 否则点击菜单项会把测试 UID 写进真实设置库（`blockVideoUploader` 自己发起落库），
    // 而落库是 fire-and-forget，事后再写回原值仍会留下竞态窗口。
    const originalPersist = useSettingsStore.getState().persistToBackend;
    useSettingsStore.setState({ persistToBackend: async () => {} });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // 触摸端判定走 `isMobileClient()`：桌面 CDP 会话拿不到触摸能力，
    // 因此 UA 与 userAgentData 两个来源都要桩（`getClientPlatform` 优先读后者）。
    Object.defineProperty(navigator, "userAgent", {
      get: () => window.__blockTestMobileUA ?? "Mozilla/5.0 (Windows NT 10.0) desktop-ua",
      configurable: true,
    });
    Object.defineProperty(navigator, "userAgentData", {
      get: () =>
        window.__blockTestMobileUA
          ? { platform: "Android", mobile: true }
          : { platform: "Windows", mobile: false },
      configurable: true,
    });

    let navigations = 0;
    function NavigationProbe() {
      const navigate = useNavigate();
      window.__blockTestNavigate = navigate;
      return null;
    }

    const harness = await setupHarness({
      style: "position:fixed;inset:0;z-index:99999;background:var(--background);overflow:auto",
    });
    const { host } = harness;
    // `item` 每次都要是**新对象**：VideoCard 是 `memo` 的，传同一个引用时 React 会
    // 直接跳过重渲染，平台分支（桌面/触摸）因此不会重新求值 —— 测试里换 UA 之后
    // 拿到的还是上一轮的卡片。
    const renderCard = (item) => {
      navigations = 0;
      harness.render(
        h(
          QueryClientProvider,
          { client },
          h(
            MemoryRouter,
            null,
            h(NavigationProbe),
            h("div", { style: { width: 320 } }, h(VideoCard, { item: { ...item } })),
          ),
        ),
      );
    };
    const card = () => host.querySelector("button[data-page-scroll-anchor]");
    const press = (element, type, holdMs) => {
      const box = element.getBoundingClientRect();
      const init = {
        pointerId: 1,
        pointerType: type,
        isPrimary: true,
        clientX: box.left + box.width / 2,
        clientY: box.top + box.height / 2,
        bubbles: true,
        cancelable: true,
      };
      element.dispatchEvent(new PointerEvent("pointerdown", init));
      if (holdMs) {
        // 长按计时器是 500ms（`LONG_PRESS_TRIGGER_MS`），留出余量。
        return new Promise((resolve) =>
          setTimeout(() => {
            element.dispatchEvent(new PointerEvent("pointerup", init));
            resolve();
          }, holdMs),
        );
      }
      element.dispatchEvent(new PointerEvent("pointerup", init));
      return Promise.resolve();
    };
    // 长按后松手会合成一次 click：这里补上，验证它被吞掉而不是打开视频。
    const clickAfterLongPress = (element) => {
      element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    };

    const reports = [];
    try {
      /* ---------- 桌面：右键菜单 ---------- */
      window.__blockTestMobileUA = null;
      useSettingsStore.setState({ videoBlockedUploaders: [] });
      renderCard(base);
      await frames();
      assert(card(), "桌面卡未渲染");
      assert(card().getAttribute("data-motion-press") !== null, "卡片缺少按压标记");
      card().dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 40,
          clientY: 40,
        }),
      );
      // Base UI 的 ContextMenu 自己实现右键与长按（触发元素上的 `onContextMenu`），
      // 菜单内容渲染在 body 上的 portal 里，因此从 document 上找。
      await until(
        () => document.querySelector('[data-slot="context-menu-content"]'),
        "右键未打开上下文菜单",
      );
      const menu = document.querySelector('[data-slot="context-menu-content"]');
      const menuText = menu.textContent ?? "";
      assert(menuText.includes("屏蔽 UP 主"), `菜单缺少屏蔽项：${menuText}`);
      assert(menuText.includes("作者甲"), `菜单没有带上作者名：${menuText}`);
      const menuItem = menu.querySelector('[data-slot="context-menu-item"]');
      assert(menuItem, "屏蔽项不是菜单项");
      menuItem.click();
      await until(
        () => useSettingsStore.getState().videoBlockedUploaders.includes("424242"),
        "点击菜单项未写入屏蔽名单",
      );
      // 关掉菜单，避免影响后续断言（Esc 是 base-ui 的关闭键）。
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await until(() => !document.querySelector('[data-slot="context-menu-content"]'), "菜单未关闭");
      reports.push({ case: "desktop-context-menu", passed: true });

      /* ---------- 触摸端：长按抽屉 ---------- */
      window.__blockTestMobileUA = "Mozilla/5.0 (Linux; Android 15) mobile-ua";
      useSettingsStore.setState({ videoBlockedUploaders: [] });
      renderCard(base);
      await frames();
      assert(card(), "触摸端卡未渲染");
      await press(card(), "touch", 700);
      // 抽屉是 base-ui 的 Dialog，内容挂在 body 上的 portal 里，因此从 document 找。
      await until(
        () => document.querySelector('[data-slot="drawer-content"]'),
        "长按未弹出操作抽屉",
      );
      const drawer = document.querySelector('[data-slot="drawer-content"]');
      const drawerButton = [...drawer.querySelectorAll("button")].find((el) =>
        (el.textContent ?? "").includes("屏蔽"),
      );
      assert(drawerButton, `抽屉缺少屏蔽按钮：${drawer.textContent}`);
      assert(
        (drawerButton.textContent ?? "").includes("作者甲"),
        "抽屉按钮没有带上作者名",
      );
      clickAfterLongPress(card());
      assert(navigations === 0, "长按后合成的点按打开了视频");
      drawerButton.click();
      await until(
        () => useSettingsStore.getState().videoBlockedUploaders.includes("424242"),
        "抽屉按钮未写入屏蔽名单",
      );
      await until(() => !document.querySelector('[data-slot="drawer-content"]'), "抽屉未收起");
      reports.push({ case: "touch-long-press-drawer", passed: true });

      /* ---------- 缺失 UID：两种入口都不出现 ---------- */
      for (const mobile of [false, true]) {
        window.__blockTestMobileUA = mobile ? "Mozilla/5.0 (Linux; Android 15) mobile-ua" : null;
        renderCard({ ...base, author_mid: null });
        await frames();
        const node = card();
        assert(node, "缺 UID 的卡未渲染");
        node.dispatchEvent(
          new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }),
        );
        await frames();
        assert(
          !document.querySelector('[data-slot="context-menu-content"]'),
          `缺 UID 时仍出现了右键菜单（mobile=${mobile}）`,
        );
        if (mobile) {
          await press(node, "touch", 700);
          await frames();
          assert(
            !document.querySelector('[data-slot="drawer-content"]'),
            "缺 UID 时长按仍弹出了抽屉",
          );
          clickAfterLongPress(node);
        }
        assert(navigations === 0, "缺 UID 的卡点按没有导航（可点性回归）");
        reports.push({ case: `missing-mid-${mobile ? "touch" : "desktop"}`, passed: true });
      }

      return reports;
    } finally {
      useSettingsStore.setState({
        videoBlockedUploaders: originalUploaders,
        persistToBackend: originalPersist,
      });
      harness.dispose();
      client.clear();
      delete window.__blockTestMobileUA;
      delete window.__blockTestNavigate;
    }
  });
}
