// 短视频舞台指示器的浏览器回归：
//   playwright-cli -s=shorts-indicator open http://127.0.0.1:1421/ && \
//   playwright-cli -s=shorts-indicator run-code --filename=tests/shorts-stage-indicator.browser.js
//
// 断言四件事：
//   1. 暂停时画面里出现 Video.js 的 PlayButton（`[data-paused]`），尺寸按令牌为 64px / 图标 32px；
//   2. 它只当指示器：外层不接指针、按钮不进 Tab 序、`aria-hidden`；
//   3. 播放中不出现暂停按钮，点按层仍能收到点击；
//   4. 缓冲态下 BufferingIndicator 进入 `data-visible`。
async (page) => {
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };

  // 端口不写死：用已打开页面（Vite 预览页）的 origin，免得 1420 被占时整段跑不起来。
  const origin = page.url().replace(/\/[^/]*$/, "");
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
  assert(
    !playing.hasPlayButton,
    "播放中不应常驻暂停按钮（舞台只在 paused 时渲染 PlayButton）",
  );

  // 缓冲态：指示器容器在 500ms 延迟后进入可见态。
  await page.evaluate(() => window.__shortsStageIndicator.starve());
  await page.waitForTimeout(800);
  const starved = await page.evaluate(() => window.__shortsStageIndicator.starve());
  console.log("starved:", JSON.stringify(starved));
  assert(starved.bufferingVisible, "缓冲态下 BufferingIndicator 应可见（data-visible）");

  await page.screenshot({ path: ".playwright-cli/shorts-stage-indicator.png" });
  return "shorts stage indicator ok";
}
