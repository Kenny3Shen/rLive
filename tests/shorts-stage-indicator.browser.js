// 短视频舞台指示器的浏览器回归：
//   playwright-cli -s=shorts-indicator open http://127.0.0.1:1421/ && \
//   playwright-cli -s=shorts-indicator run-code --filename=tests/shorts-stage-indicator.browser.js
//
// 断言五件事：
//   1. 暂停时画面里出现 Video.js 的 PlayButton（`[data-paused]`），尺寸按令牌为 64px / 图标 32px；
//   2. 它只当指示器：外层不接指针、按钮不进 Tab 序、`aria-hidden`；
//   3. 播放中不出现暂停按钮，点按层仍能收到点击；
//   4. 缓冲态下 BufferingIndicator 进入 `data-visible`；
//   5. 首帧前（含 play 已到、预热、失败）不露封面或原生海报，首帧后卡顿不重新黑屏。
async (page) => {
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };

  // 端口不写死：用已打开页面（Vite 预览页）的 origin，免得 1420 被占时整段跑不起来。
  const origin = page.url().match(/^https?:\/\/[^/]+/)[0];
  const coverUrl = "https://example.com/shorts-test-cover.svg";
  await page.route(coverUrl, (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><path fill="red" d="M0 0h16v16H0z"/></svg>',
    }),
  );
  try {
    await page.goto(`${origin}/tests/browser/shorts-stage-indicator.html`);
    await page.waitForFunction(() => !!window.__shortsStageIndicator, null, { timeout: 15000 });

    const paused = await page.evaluate(() => window.__shortsStageIndicator.render(true));
    console.log("paused:", JSON.stringify(paused));

    assert(paused.hasPlayButton, "暂停时画面里应渲染 PlayButton");
    assert(paused.playPaused, "PlayButton 应处于暂停态（data-paused）");
    assert(paused.tabIndex === "-1", "PlayButton 不应进入 Tab 序");
    assert(
      paused.wrapperPointerEvents === "none",
      `指示器外层应不接指针，实测 ${paused.wrapperPointerEvents}`,
    );
    assert(paused.wrapperAriaHidden === "true", "指示器外层应 aria-hidden");
    assert(
      paused.playBox && Math.abs(paused.playBox.width - 64) <= 2,
      `按钮应为 64px（--media-control-size），实测 ${JSON.stringify(paused.playBox)}`,
    );
    assert(
      paused.playIconCss && paused.playIconCss.width === "32px",
      `图标应为 32px（--media-icon-size），实测 ${JSON.stringify(paused.playIconCss)}`,
    );

    // 转圈图标必须与暂停图标同尺寸（都读 `--media-icon-size`）。
    assert(paused.hasBuffering, "画面里应有 BufferingIndicator");
    assert(
      paused.bufferingIconCss && paused.bufferingIconCss.width === "32px",
      `转圈图标应为 32px，实测 ${JSON.stringify(paused.bufferingIconCss)}`,
    );

    // 点按层仍然收得到点击（指示器没有截住）。
    const taps = await page.evaluate(() => window.__shortsStageIndicator.tapSurface());
    assert(taps === 1, `点画面框应触发一次 onSurfaceTap，实测 ${taps}`);

    const playing = await page.evaluate(() => window.__shortsStageIndicator.render(false));
    console.log("playing:", JSON.stringify(playing));
    assert(!playing.hasPlayButton, "播放中不应常驻暂停按钮（舞台只在 paused 时渲染 PlayButton）");

    // 起播前：黑屏 + 转圈，且画面里没有任何封面图。
    const firstFrame = await page.evaluate(() => window.__shortsStageIndicator.render(true, true));
    console.log("first-frame:", JSON.stringify(firstFrame));
    assert(firstFrame.hasLoadingIndicator, "起播前应有加载转圈（shorts-loading-indicator）");
    assert(
      firstFrame.loadingIconCss && firstFrame.loadingIconCss.width === "32px",
      `转圈图标应为 32px（与暂停图标同档），实测 ${JSON.stringify(firstFrame.loadingIconCss)}`,
    );
    assert(
      firstFrame.loadingPointerEvents === "none" && firstFrame.loadingAriaHidden === "true",
      "转圈只当指示器：应不接指针且 aria-hidden",
    );
    assert(
      firstFrame.coverImages.length === 0,
      `起播前画面里不应有封面图，实测 ${JSON.stringify(firstFrame.coverImages)}`,
    );
    assert(!firstFrame.hasPlayButton, "起播前不应同时出现暂停按钮");
    const assertBlack = (state, label) => {
      assert(state.coverImages.length === 0, `${label}：整个舞台不应露出模糊封面`);
      assert(state.nativePoster === null, `${label}：不应设置稿件 poster`);
      assert(
        state.hasMask && state.maskColor === "rgb(0, 0, 0)" && state.maskOpacity === "1",
        `${label}：媒体上方应有不透明黑底`,
      );
      assert(state.maskPointerEvents === "none", `${label}：黑底不能挡住点按`);
      assert(
        JSON.stringify(state.maskBox) === JSON.stringify(state.videoBox),
        `${label}：黑底必须覆盖整块媒体`,
      );
      assert(!state.hasBuffering, `${label}：首帧前不应叠加缓冲转圈`);
    };
    assertBlack(firstFrame, "取流中");
    for (const loading of [false, true]) {
      const earlyPlay = await page.evaluate(
        (loading) => window.__shortsStageIndicator.render(false, loading, { hasFrame: false }),
        loading,
      );
      assertBlack(earlyPlay, `play 已到，loading=${loading}`);
      assert(earlyPlay.hasLoadingIndicator, "play 先到不能撤掉起播转圈");
    }
    const warm = await page.evaluate(() =>
      window.__shortsStageIndicator.render(true, true, { hasFrame: false, mode: "warm" }),
    );
    assertBlack(warm, "预热中");
    assert(!warm.hasLoadingIndicator, "预热面板不显示转圈");
    const failed = await page.evaluate(() =>
      window.__shortsStageIndicator.render(true, false, { hasFrame: false, error: "测试取流失败" }),
    );
    assertBlack(failed, "首帧前失败");
    assert(!failed.hasLoadingIndicator, "失败面板不显示转圈");

    const decoded = await page.evaluate(() =>
      window.__shortsStageIndicator.render(true, false, { hasFrame: true, mode: "warm" }),
    );
    assert(
      !decoded.hasMask && decoded.coverImages.length === 1,
      "预热帧已提交后应展示视频并恢复可选背景",
    );
    const rebuffering = await page.evaluate(() =>
      window.__shortsStageIndicator.render(false, true, { hasFrame: true }),
    );
    assert(!rebuffering.hasMask && !rebuffering.hasLoadingIndicator, "出画后卡顿不能重新遮成黑屏");

    // 缓冲态：指示器容器在 500ms 延迟后进入可见态。
    await page.evaluate(() => window.__shortsStageIndicator.starve());
    await page.waitForTimeout(800);
    const starved = await page.evaluate(() => window.__shortsStageIndicator.starve());
    console.log("starved:", JSON.stringify(starved));
    assert(starved.bufferingVisible, "缓冲态下 BufferingIndicator 应可见（data-visible）");

    await page.screenshot({ path: ".playwright-cli/shorts-stage-indicator.png" });
    const blank = await page.evaluate(() => window.__shortsStageIndicator.renderBlank());
    assert(blank.images === 0 && blank.videos === 0, "相邻占位不能加载封面或媒体");
    return "shorts stage indicator ok";
  } finally {
    await page.evaluate(() => window.__shortsStageIndicator?.unmount());
    await page.unroute(coverUrl);
  }
}
