// 真实 Shell/VideoPlayerPage 的隔离夹具；mock IPC，不在真实 Tauri 主窗口运行。
// playwright-cli -s=vod-controls open http://localhost:1421/
// playwright-cli -s=vod-controls run-code --filename=tests/vod-mobile-controls.browser.js
async (page) => {
  const originalUrl = page.url();
  const origin = await page.evaluate(() => location.origin);
  const originalUa = await page.evaluate(() => navigator.userAgent);
  const cdp = await page.context().newCDPSession(page);
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const passed = [];
  const frames = () =>
    page.evaluate(async () => {
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
    });
  try {
    await cdp.send("Network.setUserAgentOverride", {
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
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 401,
      height: 757,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await page.goto(`${origin}/tests/browser/video-shell.html`);
    await page.evaluate(async () => {
      await import("/src/styles.css");
    });
    await page.waitForFunction(() => Boolean(window.shellFixture));
    await page.evaluate(() =>
      window.shellFixture.router.navigate("/video/play?bvid=BV1shell&cid=1001&aid=456"),
    );
    await page.waitForSelector('[data-slot="player-progress"]', { timeout: 30000 });
    await page.waitForSelector('[data-video-side-tab-panel="danmaku"]', { state: "attached" });
    for (const width of [401, 320]) {
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width,
        height: 757,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await frames();
      const geometry = await page.evaluate(() => {
        const stage = document.querySelector("[data-player-stage]");
        const hud = stage.querySelector("[data-player-hud] button");
        const controls = stage.querySelector('[data-slot="player-extension-controls"]');
        const bottom = controls.querySelector("button");
        const progress = controls.querySelector('[data-slot="player-progress"]');
        const slider = progress?.querySelector(".media-time-slider");
        const size = (el) => ({
          width: el.getBoundingClientRect().width,
          height: el.getBoundingClientRect().height,
        });
        const rect = controls.getBoundingClientRect();
        const buttons = [...controls.querySelectorAll("button")].filter(
          (el) => el.getBoundingClientRect().width,
        );
        return {
          top: size(hud),
          bottom: size(bottom),
          topIcon: size(hud.querySelector("svg")),
          bottomIcon: size(
            [...bottom.querySelectorAll("svg")].find((el) => el.getBoundingClientRect().width),
          ),
          center: Boolean(progress?.closest('[data-slot="player-center-slot"]')),
          count: stage.querySelectorAll('[data-slot="player-progress"]').length,
          sliderWidth: slider?.getBoundingClientRect().width,
          noInput: !controls.querySelector("input"),
          allFit: buttons.every((el) => {
            const b = el.getBoundingClientRect();
            return b.left >= rect.left && b.right <= rect.right + 0.5;
          }),
        };
      });
      assert(
        geometry.top.width === 28 && geometry.top.height === 28,
        `顶部尺寸错误：${JSON.stringify(geometry)}`,
      );
      assert(JSON.stringify(geometry.top) === JSON.stringify(geometry.bottom), "上下按钮大小不同");
      assert(
        geometry.topIcon.width === 20 && geometry.bottomIcon.width === 20,
        `上下图标不是20px：${JSON.stringify(geometry)}`,
      );
      assert(
        geometry.center && geometry.count === 1 && geometry.noInput,
        "竖屏主行未使用唯一进度条替代发送框",
      );
      assert(
        geometry.sliderWidth >= 72 && geometry.allFit,
        `${width}px 控制栏越界：${JSON.stringify(geometry)}`,
      );
    }
    passed.push("401px/320px：上下按钮28px、图标20px，中央进度条与按钮不越界");

    await page.getByRole("tab", { name: "弹幕", exact: true }).click();
    await frames();
    const composer = await page.evaluate(() => {
      const panel = document.querySelector('[data-video-side-tab-panel="danmaku"]');
      const input = panel.querySelector("input");
      const box = panel.getBoundingClientRect(),
        field = input?.getBoundingClientRect();
      const wrapper = panel.querySelector('[data-slot="video-sidebar-danmaku-composer"]');
      return {
        present: Boolean(input),
        nearBottom: field && box.bottom - field.bottom < 40,
        noExtraBorders: wrapper && [wrapper, wrapper.firstElementChild].every((node) => getComputedStyle(node).borderTopWidth === "0px"),
        wrapperPadding: wrapper && getComputedStyle(wrapper).padding,
      };
    });
    assert(
      composer.present && composer.nearBottom,
      `弹幕发送框未固定在Tab底部：${JSON.stringify(composer)}`,
    );
    assert(composer.noExtraBorders && composer.wrapperPadding === "0px", "弹幕底部仍有重复横线或双重留白");
    passed.push("弹幕发送框位于弹幕Tab底部，无重复横线与留白");

    await page.getByRole("button", { name: "全屏", exact: true }).click();
    await page.waitForSelector('[data-slot="player-progress"][data-placement="above"]');
    assert(
      (await page.locator('[data-slot="player-center-slot"] input').count()) === 1,
      "全屏未恢复控制栏发送框",
    );
    assert(
      (await page.locator('[data-video-side-tab-panel="danmaku"] input').count()) === 0,
      "全屏仍重复挂载Tab发送框",
    );
    await page.getByRole("button", { name: "退出全屏", exact: true }).last().click();
    await page.waitForSelector('[data-slot="player-progress"][data-placement="center"]');
    passed.push("进入全屏恢复独立进度行与控制栏发送框，退出还原竖屏布局");
    return { passed };
  } finally {
    await cdp.send("Network.setUserAgentOverride", { userAgent: originalUa });
    await cdp.send("Emulation.clearDeviceMetricsOverride");
    await cdp.detach();
    await page.goto(originalUrl);
  }
}
