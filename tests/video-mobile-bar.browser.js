// 移动端 VOD 播放页的两个导航按钮：「返回主页」在顶部 HUD、「播放下一个」在底部控制栏。
//
// 回归的是两件不同的事，夹具一并守住：
//   1. 「播放下一个」在移动端竖屏消失 —— `f7ed6c27` 改用 Video.js 原生皮肤时把它并进
//      次级按钮组（`onNext && showSecondary`），而 `showSecondaryPlayerControls(compact,
//      portrait)` 在移动端竖屏恒为 false。它跟「仅音频/弹幕/字幕」不同：那是刻意的
//      降密度，而「下一集」是本页的主播放动作，选集还有下一集时就该在场。
//   2. 「返回主页」只出现在桌面 HUD —— 移动端以前只能进 `⋮` 菜单找。这一页没有流内
//      顶栏，返回箭头只回上一层（可能只是上一集），直接回视频首页不该藏在低频工具里。
//
// 断言分两层：按钮在场（DOM + 可见几何），以及点击真的落到目标路由/选集。只断言
// DOM 存在会让「渲染了但点了没反应」这种失效漏过去，因此两个按钮都真的点一次。
//
// 夹具页面自带 Android UA 桩与 memory router；用法：
//   playwright-cli -s=vod-mobile-bar open http://127.0.0.1:1420/
//   playwright-cli -s=vod-mobile-bar run-code --filename=tests/video-mobile-bar.browser.js
async (page) => {
  const FIXTURE = "http://127.0.0.1:1420/tests/browser/video-resume-next.html";
  // 手机宽度档：320 是控制栏最挤的一档，401 与用户截图同宽。
  const WIDTHS = [320, 401];

  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };

  // Android UA 必须在页面脚本之前生效：`getClientPlatform()` 决定 compact 与
  // HUD/控制栏的分支，夹具页面自己也会读它。
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "userAgent", {
      get: () =>
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36",
      configurable: true,
    });
    Object.defineProperty(navigator, "userAgentData", {
      get: () => ({ platform: "Android", mobile: true }),
      configurable: true,
    });
  });

  /** 打开夹具并等播放页落定。夹具 HTML 不带应用样式表，必须补引才有 Tailwind。 */
  const open = async (width) => {
    await page.setViewportSize({ width, height: 757 });
    await page.goto(FIXTURE);
    await page.evaluate(async () => {
      await import("/src/styles.css");
    });
    await page.waitForFunction(() => Boolean(document.querySelector("[data-player-hud]")));
    await page.waitForTimeout(1200);
  };

  /** 按钮的可点状态：存在、有面积、未被禁用。 */
  const buttonState = async (scope, label) =>
    await page.evaluate(
      ({ scope, label }) => {
        const root = document.querySelector(scope);
        if (!root) return { present: false, scopeMissing: true };
        const button = [...root.querySelectorAll("button")].find(
          (el) => el.getAttribute("aria-label") === label,
        );
        if (!button) return { present: false };
        const rect = button.getBoundingClientRect();
        return {
          present: true,
          width: +rect.width.toFixed(1),
          height: +rect.height.toFixed(1),
          disabled: button.disabled,
          visible: rect.width > 0 && rect.height > 0,
        };
      },
      { scope, label },
    );

  const results = [];

  for (const width of WIDTHS) {
    await open(width);

    const hudHome = await buttonState("[data-player-hud]", "返回主页");
    assert(hudHome.present, `${width}px：HUD 里没有「返回主页」`);
    assert(hudHome.visible && !hudHome.disabled, `${width}px：「返回主页」不可点`);
    // 触控目标不小于 32px 见方（HUD 图标按钮是 36px 档，压缩后也不该更小）。
    assert(
      hudHome.width >= 32 && hudHome.height >= 32,
      `${width}px：「返回主页」命中区只有 ${hudHome.width}×${hudHome.height}px`,
    );

    const barNext = await buttonState("[data-player-controls]", "播放下一个");
    assert(barNext.present, `${width}px：控制栏里没有「播放下一个」`);
    assert(barNext.visible && !barNext.disabled, `${width}px：「播放下一个」不可点`);
    assert(
      barNext.width >= 32 && barNext.height >= 32,
      `${width}px：「播放下一个」命中区只有 ${barNext.width}×${barNext.height}px`,
    );

    // HUD 四个按钮不能互相压住：返回箭头 | 返回主页 | 看短视频 | ⋮。
    const hudLayout = await page.evaluate(() => {
      const buttons = [...document.querySelectorAll("[data-player-hud] button")];
      const rects = buttons.map((b) => b.getBoundingClientRect());
      let overlapping = null;
      for (let i = 1; i < rects.length; i += 1) {
        if (rects[i].left < rects[i - 1].right - 0.5) {
          overlapping = [i - 1, i];
          break;
        }
      }
      return { count: buttons.length, overlapping };
    });
    assert(
      hudLayout.overlapping === null,
      `${width}px：HUD 按钮 ${hudLayout.overlapping?.join("/")} 互相重叠`,
    );

    // 控制栏三段不得溢出（新按钮进的是最挤的左侧组）。
    const barLayout = await page.evaluate(() => {
      const bar = document.querySelector('[data-slot="player-extension-controls"]');
      return { scrollWidth: bar.scrollWidth, clientWidth: bar.clientWidth };
    });
    assert(
      barLayout.scrollWidth <= barLayout.clientWidth + 1,
      `${width}px：控制栏溢出（${barLayout.scrollWidth} > ${barLayout.clientWidth}）`,
    );

    results.push(
      `${width}px：HUD ${hudLayout.count} 个按钮（含返回主页 ${hudHome.width}px），` +
        `控制栏含播放下一个 ${barNext.width}px 且未溢出`,
    );
  }

  // ---- 点击行为：两个按钮都要真的到达目标 ----
  await open(401);

  const route = () =>
    page.evaluate(() => {
      const location = window.resumeNextFixture.router.state.location;
      return { pathname: location.pathname, search: location.search };
    });
  const click = (scope, label) =>
    page.evaluate(
      ({ scope, label }) => {
        const button = [...document.querySelectorAll(`${scope} button`)].find(
          (el) => el.getAttribute("aria-label") === label,
        );
        if (!button) return false;
        button.click();
        return true;
      },
      { scope, label },
    );

  // 选集：夹具是 P2 续播，下一项是 P3（cid=1003）。
  const beforeNext = await route();
  assert(await click("[data-player-controls]", "播放下一个"), "控制栏里点不到「播放下一个」");
  await page.waitForFunction(
    () => window.resumeNextFixture.router.state.location.search.includes("cid=1003"),
    undefined,
    { timeout: 5000 },
  );
  const afterNext = await route();
  assert(
    afterNext.pathname === beforeNext.pathname && afterNext.search !== beforeNext.search,
    `「播放下一个」没有换集（仍是 ${afterNext.search}）`,
  );
  results.push("点「播放下一个」换到选集下一项（P3）");

  // 返回主页：落在 VIDEO_HOME_PATH。
  await open(401);
  assert(await click("[data-player-hud]", "返回主页"), "HUD 里点不到「返回主页」");
  await page.waitForFunction(
    () => window.resumeNextFixture.router.state.location.pathname === "/video",
    undefined,
    { timeout: 5000 },
  );
  const afterHome = await route();
  assert(afterHome.pathname === "/video", `「返回主页」落在 ${afterHome.pathname}`);
  results.push("点「返回主页」落到 /video");

  return { passed: results };
};
