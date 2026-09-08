// 使用真实 VideoPlayerPage 的 HUD；只在播放表面注入真实弹幕层及本地媒体时钟。
// 不调用平台接口或发送弹幕：playwright-cli -s=video-hud-hit run-code --filename=tests/video-hud-pointer.browser.js
async (page) => {
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const origin = await page.evaluate(() => location.origin);
  await page.goto(`${origin}/video/play?bvid=BV1xx411c7mD&cid=123&aid=456&title=HUD%E5%9B%9E%E5%BD%92`);
  await page.waitForSelector("[data-player-stage] [data-player-hud]");
  await page.evaluate(async () => {
    const dependencyUrl = (name) => {
      const resource = performance.getEntriesByType("resource").find((item) =>
        new URL(item.name).pathname.endsWith(`/deps/${name}.js`),
      );
      if (!resource) throw new Error(`未找到 Vite 依赖 ${name}`);
      return resource.name;
    };
    const { default: React } = await import(dependencyUrl("react"));
    const { default: ReactDOMClient } = await import(dependencyUrl("react-dom_client"));
    const { default: ReactDOM } = await import(dependencyUrl("react-dom"));
    const { QueryClient, QueryClientProvider } = await import(dependencyUrl("@tanstack_react-query"));
    const { VideoDanmakuLayer } = await import("/src/features/video/VideoDanmakuLayer.tsx");
    const { loadDanmuJs } = await import("/src/features/room/danmaku/danmuJsLoader.ts");
    await loadDanmuJs();
    const stage = document.querySelector("[data-player-stage]");
    const surface = stage.querySelector("[data-player-video-surface]");
    const hud = stage.querySelector("[data-player-hud]");
    const host = document.createElement("div");
    // 浏览器预览没有 Tauri，局部测试层盖住错误提示，但保持低于真实 HUD 的 z-30。
    host.style.cssText = "position:absolute;inset:0;z-index:21;background:#111";
    surface.append(host);
    const root = ReactDOMClient.createRoot(host);
    const client = new QueryClient();
    const videoRef = React.createRef();
    const h = React.createElement;
    ReactDOM.flushSync(() => root.render(h(QueryClientProvider, { client },
      h("video", { ref: videoRef, style: { position: "absolute", inset: 0, width: "100%", height: "100%" } }),
      h(VideoDanmakuLayer, {
        videoRef,
        active: true,
        cid: 123,
        aid: "456",
        entries: [{ id: "hud-hit", progressMs: 100, mode: "top", content: "顶部弹幕", color: "#ffffff", pool: 0 }],
      }),
    )));
    let time = 0;
    Object.defineProperties(videoRef.current, {
      currentTime: { configurable: true, get: () => time },
      paused: { configurable: true, get: () => false },
    });
    window.__videoHudPointerTest = {
      hud,
      surface,
      seed: () => {
        time = 0.1;
        videoRef.current.dispatchEvent(new Event("play"));
        videoRef.current.dispatchEvent(new Event("timeupdate"));
      },
      dispose: () => {
        ReactDOM.flushSync(() => root.unmount());
        client.clear();
        host.remove();
        delete window.__videoHudPointerTest;
      },
    };
  });
  const passed = [];
  try {
    await page.waitForSelector("[data-video-danmaku-layer].danmu");
    await page.evaluate(() => window.__videoHudPointerTest.seed());
    await page.waitForSelector('[data-rlive-danmaku-id="hud-hit"]');
    const hit = await page.evaluate(() => {
      const { hud } = window.__videoHudPointerTest;
      const bullet = document.querySelector('[data-rlive-danmaku-id="hud-hit"] [data-rlive-danmaku-content]');
      const rect = bullet.getBoundingClientRect();
      const title = hud.querySelector("p[title]");
      const titleRect = title.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = Math.min(rect.bottom - 2, titleRect.bottom - 2);
      const target = document.elementFromPoint(x, y);
      return {
        x, y,
        overlapsTitle: x > titleRect.left && x < titleRect.right && y > titleRect.top && y < titleRect.bottom,
        hitsBullet: bullet.contains(target),
        actual: target?.outerHTML.slice(0, 240),
      };
    });
    assert(hit.overlapsTitle, "测试弹幕未与真实 HUD 标题重叠");
    assert(hit.hitsBullet, `顶部 HUD 拦截了弹幕，命中：${hit.actual}`);
    if (await page.evaluate(() => navigator.maxTouchPoints > 0)) await page.touchscreen.tap(hit.x, hit.y);
    else await page.mouse.click(hit.x, hit.y);
    await page.locator("[data-danmaku-menu]").waitFor({ state: "visible" });
    passed.push("真实 HUD 标题区域穿透到弹幕，点按打开操作菜单");

    const geometry = await page.evaluate(() => {
      const { hud, surface } = window.__videoHudPointerTest;
      const hudRect = hud.getBoundingClientRect();
      const backgroundHit = document.elementFromPoint(hudRect.left + hudRect.width / 2, hudRect.bottom - 2);
      const buttons = [...hud.querySelectorAll("button:enabled")];
      return {
        backgroundPasses: !hud.contains(backgroundHit) && surface.contains(backgroundHit),
        buttonsHit: buttons.every((button) => {
          const rect = button.getBoundingClientRect();
          return button.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2));
        }),
      };
    });
    assert(geometry.backgroundPasses, "HUD 底部留白仍在拦截");
    assert(geometry.buttonsHit, "可见 HUD 按钮无法命中");
    passed.push("HUD 留白穿透，返回和工具按钮仍正常命中");

    await page.getByRole("button", { name: "更多操作", exact: true }).click();
    const popupTitle = page.getByText("播放操作", { exact: true });
    await popupTitle.waitFor({ state: "visible" });
    assert(await page.getByRole("button", { name: "投屏", exact: true }).isVisible(), "更多操作的弹层不可交互");
    await page.keyboard.press("Escape");
    await popupTitle.waitFor({ state: "hidden" });
    passed.push("真实更多操作弹层可打开和关闭");

    const visibility = await page.evaluate(() => {
      const { hud } = window.__videoHudPointerTest;
      const button = hud.querySelector("button");
      button.disabled = true;
      const disabled = getComputedStyle(button).pointerEvents;
      button.disabled = false;
      const previous = hud.dataset.visible;
      hud.dataset.visible = "false";
      const hidden = [...hud.querySelectorAll("button")].every((item) => getComputedStyle(item).pointerEvents === "none");
      hud.dataset.visible = previous;
      return { disabled, hidden, visible: getComputedStyle(button).pointerEvents };
    });
    assert(visibility.disabled === "none", "禁用按钮仍抢占指针");
    assert(visibility.hidden, "HUD 隐藏后按钮仍拦截点击");
    assert(visibility.visible === "auto", "HUD 重新显示后按钮未恢复");
    passed.push("禁用和隐藏按钮不拦截，重新显示恢复可点");
    return { viewport: page.viewportSize(), passed };
  } finally {
    await page.evaluate(() => window.__videoHudPointerTest?.dispose());
  }
}
