// 移动端底栏在惯性滚动期间的点击（真实 Shell + 合成器触摸，mock IPC）。
// playwright-cli -s=sidebar-tap run-code --filename=tests/sidebar-fling-tap.browser.js
//
// 复现的缺陷：内容区快速上滑后，惯性滚动还在跑时点底栏，页面不切换 —— 只能停住
// 滚动，得再点一次才生效。原因是 Chromium 的 scroll gesture 会吃掉「用来停住滚动」
// 的第一次点按：`pointerdown` / `pointerup` 照常派发，`click` 被吞掉。
//
// 必须用真实合成器触摸（CDP `Input.dispatchTouchEvent`）：夹具合成的 PointerEvent
// 不经合成器，也就不会被 scroll gesture 吃掉，测不出这条路径。
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
  const sleep = (ms) => page.waitForTimeout(ms);
  const touch = (type, points) =>
    client.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: points.map((point) => ({ x: point.x, y: point.y, id: point.id ?? 1 })),
    });
  /** 在内容区快速上滑，制造一次仍在跑的惯性滚动。 */
  const flingContent = async (viewport) => {
    const x = viewport.width / 2;
    const from = viewport.height * 0.5;
    await touch("touchStart", [{ x, y: from }]);
    for (let step = 1; step <= 6; step += 1) {
      await touch("touchMove", [{ x, y: from - (step * viewport.height * 0.25) / 6 }]);
      await sleep(5);
    }
    await touch("touchEnd", []);
    await sleep(60);
  };
  const readState = () =>
    page.evaluate(() => ({
      path: window.shellFixture.router.state.location.pathname,
      state: window.shellFixture.router.state.location.state ?? null,
      scroll: [...document.querySelectorAll("[data-slot]")]
        .filter((node) => node.dataset.slot === "app-swipe-panel")
        .map((node) => node.scrollTop),
    }));
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
    await page.evaluate(() => window.shellFixture.router.navigate("/video"));
    await page.waitForSelector('[data-slot="app-sidebar-link"]', { timeout: 10000 });
    await sleep(500);

    const geometry = await page.evaluate(() => {
      const link = [...document.querySelectorAll('[data-slot="app-sidebar-link"]')].find(
        (node) => node.getAttribute("href") === "/iptv",
      );
      const rect = link.getBoundingClientRect();
      const scroller = [...document.querySelectorAll("[data-slot]")].find(
        (node) =>
          node.dataset.slot === "app-swipe-panel" && node.scrollHeight > node.clientHeight + 4,
      );
      return {
        link: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
        scrollable: Boolean(scroller),
        viewport: { width: innerWidth, height: innerHeight },
      };
    });
    assert(geometry.scrollable, "内容区不可滚动，夹具前提不成立");

    await flingContent(geometry.viewport);
    const scrolling = await readState();
    assert(
      scrolling.scroll.some((top) => top > 40),
      `未制造出惯性滚动：${JSON.stringify(scrolling.scroll)}`,
    );

    // 滚动仍在滑的时候点底栏：必须当场切页，而不是只停住滚动。
    await touch("touchStart", [geometry.link]);
    await sleep(40);
    await touch("touchEnd", []);
    await sleep(700);
    const after = await readState();
    assert(after.path === "/iptv", `惯性滚动期间点底栏未切页：${after.path}`);
    assert(
      after.state?.rliveNavigationSource === "sidebar",
      `自行导航未带上侧栏状态：${JSON.stringify(after.state)}`,
    );
    passed.push("惯性滚动期间点底栏当场切页，且带侧栏导航状态");

    // 同一次点按只导航一次：随后的兼容 click 被压掉。
    // 夹具用的是 memory router，`window.history` 不受影响，因此直接数 `navigate` 调用。
    await page.evaluate(() => window.shellFixture.router.navigate("/video"));
    await page.waitForSelector('[data-slot="app-sidebar-link"]', { timeout: 10000 });
    await sleep(400);
    await page.evaluate(() => {
      const router = window.shellFixture.router;
      window.__navigations = [];
      const original = router.navigate;
      router.navigate = (to, options) => {
        window.__navigations.push({ to, state: options?.state ?? null });
        return original.call(router, to, options);
      };
    });
    await flingContent(geometry.viewport);
    await touch("touchStart", [geometry.link]);
    await sleep(40);
    await touch("touchEnd", []);
    await sleep(700);
    const navigations = await page.evaluate(() => window.__navigations);
    assert(navigations.length === 1, `同一次点按导航了 ${navigations.length} 次`);
    assert(navigations[0].to === "/iptv", `导航到了 ${navigations[0].to}`);
    passed.push("同一次点按只导航一次");

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
