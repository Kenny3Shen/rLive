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
          // 中央布局曾是列向 flex，`TimeSlider` 基类的 `flex-1`（`flex: 1 1 0%`）
          // 会把高度压成 0：滑杆既不可见也无法命中。现在时间与滑杆同排一行，
          // 高度、同排关系、越界与命中四项都得量。
          sliderHeight: slider?.getBoundingClientRect().height,
          progressFlow: progress ? getComputedStyle(progress).flexDirection : null,
          // 当前时间、滑杆、剩余时间的纵向中心必须一致；有任何一项被挤到第二行
          // （或滑杆高度塔陷）都会在这里露出来。
          rowCentersAligned: (() => {
            if (!progress) return null;
            const centers = [...progress.children]
              .filter((el) => el.getBoundingClientRect().width > 0)
              .map((el) => {
                const b = el.getBoundingClientRect();
                return b.y + b.height / 2;
              });
            return centers.every((center) => Math.abs(center - centers[0]) < 1.5);
          })(),
          // 行内相邻子元素不得水平重叠，也不得溢出到右侧按钮组。
          rowOverflow: progress ? progress.scrollWidth - progress.clientWidth : null,
          rowBleedsIntoRightGroup: (() => {
            if (!progress) return null;
            const rightGroup = controls.parentElement?.querySelector(
              '[data-slot="player-extension-controls"] > div:last-child',
            );
            if (!rightGroup) return null;
            const children = [...progress.children].filter(
              (el) => el.getBoundingClientRect().width > 0,
            );
            const last = children.at(-1);
            return last
              ? last.getBoundingClientRect().right > rightGroup.getBoundingClientRect().x + 0.5
              : null;
          })(),
          sliderFlex: slider ? getComputedStyle(slider).flex : null,
          sliderHitTest: (() => {
            if (!slider) return null;
            const box = slider.getBoundingClientRect();
            // 本夹具没有真实媒体，滑杆处于禁用态（`pointer-events: none`），命中测试
            // 会被这层语义挡掉。临时摘下再还原：要测的是布局给出的命中区，不是禁用。
            const disabled = slider.hasAttribute("data-disabled");
            if (disabled) slider.removeAttribute("data-disabled");
            const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
            const inside = Boolean(hit && slider.contains(hit));
            if (disabled) slider.setAttribute("data-disabled", "");
            return inside;
          })(),
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
        geometry.sliderWidth >= 40 && geometry.allFit,
        `${width}px 控制栏越界：${JSON.stringify(geometry)}`,
      );
      assert(
        geometry.sliderHeight >= 20 && geometry.sliderFlex === "1 1 0%" && geometry.sliderHitTest,
        `${width}px 中央进度条不可见或不可操作：${JSON.stringify(geometry)}`,
      );
      // 时间与滑杆必须同排一行：列向、换行或子元素互相重叠都不合格。
      assert(
        geometry.progressFlow === "row" && geometry.rowCentersAligned,
        `${width}px 进度条与时间未同排一行：${JSON.stringify(geometry)}`,
      );
      // 窄屏下剩余时间会收起；无论收不收，整行都不得溢出或压到右侧按钮。
      assert(
        geometry.rowOverflow <= 0 && geometry.rowBleedsIntoRightGroup === false,
        `${width}px 进度行溢出或压住右侧按钮：${JSON.stringify(geometry)}`,
      );
    }
    passed.push("401px/320px：上下按钮28px、图标20px，时间与进度条同排不溢出且可命中");

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
