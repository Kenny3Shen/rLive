// 实机集成回归：需先 attach Windows Debug 主窗口，会切换发现页但不打开媒体。
// playwright-cli -s=tab-fix run-code --filename=tests/tab-navigation.browser.js
async (page) => {
  const report = [];
  const header = () => page.locator('[data-slot="app-header"]');
  const navigate = async (path, selector) => {
    await page.goto(`http://localhost:1420${path}`);
    await page.waitForSelector(selector);
    await page.waitForFunction(() => Boolean(window.__TAURI_INTERNALS__) && navigator.userAgent.includes("Windows NT"));
  };
  const exercise = async (selector, labels, expectImmediate = true) => {
    return await page.evaluate(async ({ selector, labels, expectImmediate }) => {
      const track = document.querySelector(selector);
      const viewport = track.parentElement;
      const samples = [];
      const clicks = [];
      let sampling = true;
      const read = () => {
        if (!sampling) return;
        const bounds = viewport.getBoundingClientRect();
        const panels = [...track.children].map((panel) => panel.getBoundingClientRect());
        let covered = bounds.left;
        for (const panel of panels.sort((a, b) => a.left - b.left)) {
          if (panel.right <= covered) continue;
          if (panel.left > covered + 1) break;
          covered = panel.right;
        }
        samples.push({
          x: new DOMMatrixReadOnly(getComputedStyle(track).transform).m41,
          gap: Math.max(0, bounds.right - covered),
          animations: track.getAnimations().length,
        });
        requestAnimationFrame(read);
      };
      requestAnimationFrame(read);
      try {
        for (const label of labels) {
          const button = [...document.querySelectorAll('[data-slot="app-header"] [role="tab"]')]
            .find((tab) => tab.textContent.trim() === label);
          if (!button) throw new Error(`缺少页签：${label}`);
          button.click();
          clicks.push({ label, animationsAtClick: track.getAnimations().length });
          await new Promise((resolve) => setTimeout(resolve, 70));
        }
        await new Promise((resolve) => setTimeout(resolve, 700));
      } finally {
        sampling = false;
      }
      const active = [...track.children].find((panel) => !panel.inert);
      if (!active) throw new Error("缺少活动面板");
      const finalError = Math.abs(active.getBoundingClientRect().left - viewport.getBoundingClientRect().left);
      if (samples.some((sample) => sample.gap > 1)) throw new Error(`切换出现面板空白：${JSON.stringify(samples)}`);
      if (samples.some((sample) => sample.animations > 1)) throw new Error("同一轨道叠加了动画");
      if (track.getAnimations().length || track.style.willChange) throw new Error("收尾残留动画");
      if (finalError > 1) throw new Error(`最终定位偏差：${finalError}`);
      if (expectImmediate && !clicks.some((click) => click.animationsAtClick === 1)) throw new Error("点击没有即时启动动画");
      if (!samples.some((sample) => sample.animations === 1)) throw new Error("切换缺少平移中间帧");
      return { clicks, frames: samples.length, gapFrames: 0, finalError, remainingAnimations: 0 };
    }, { selector, labels, expectImmediate });
  };

  await navigate("/video", '[data-swipe-kind="video"]');
  report.push({ page: "视频", ...await exercise('[data-swipe-kind="video"]', ["热门", "番剧", "影视", "番剧"]) });
  report.push({ page: "视频跨项", ...await exercise('[data-swipe-kind="video"]', ["推荐", "影视"], false) });
  await header().getByRole("tab", { name: "番剧", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-swipe-kind="video"]')?.getAnimations().length === 0);
  const anime = page.locator('[data-swipe-value="anime"]');
  await anime.getByRole("tab", { name: "国创", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-swipe-value="anime"] [role="tab"][aria-selected="true"]')?.textContent === "国创");
  await header().getByRole("tab", { name: "影视", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-swipe-value="cinema"]')?.inert === false);
  const departingZone = await anime.locator('[role="tab"][aria-selected="true"]').innerText();
  if (departingZone.trim() !== "国创") throw new Error(`离场分区被新 URL 覆盖：${departingZone}`);
  report.push({ page: "视频分区隔离", departingZone: departingZone.trim() });
  await page.waitForFunction(() => document.querySelector('[data-swipe-kind="video"]')?.getAnimations().length === 0);
  await page.screenshot({ path: ".playwright-cli/windows-video-tabs.png" });
  const routeExit = await page.evaluate(async () => {
    const track = document.querySelector('[data-swipe-kind="video"]');
    const initial = new DOMMatrixReadOnly(getComputedStyle(track).transform).m41;
    document.querySelector('nav[aria-label="主导航"] a[href="/"]').click();
    const positions = [];
    const start = performance.now();
    do {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      if (track.isConnected) positions.push(new DOMMatrixReadOnly(getComputedStyle(track).transform).m41);
    } while (track.isConnected && performance.now() - start < 800);
    const maxDeviation = Math.max(0, ...positions.map((position) => Math.abs(position - initial)));
    if (maxDeviation > 1) throw new Error(`离开路由时旧轨道被归零：${maxDeviation}`);
    return { frames: positions.length, maxDeviation };
  });
  report.push({ page: "视频路由退场", ...routeExit });

  await navigate("/", '[data-swipe-kind="live"]');
  const originalSite = await header().locator('[role="tab"][aria-selected="true"]').innerText();
  const platforms = await header().locator('[role="tab"]').allTextContents();
  if (platforms.length >= 3) {
    await header().getByRole("tab").nth(0).click();
    await page.waitForFunction(() => document.querySelector('[data-swipe-kind="live"]')?.getAnimations().length === 0);
    report.push({ page: "直播平台", ...await exercise('[data-swipe-kind="live"]', [platforms[1].trim(), platforms[2].trim(), platforms[1].trim()]) });
    if (platforms.length > 3) {
      report.push({ page: "直播跨项", ...await exercise('[data-swipe-kind="live"]', [platforms.at(-1).trim(), platforms[0].trim()], false) });
    }
  }
  await header().getByRole("tab").filter({ hasText: originalSite.trim() }).click();
  await page.waitForFunction(() => document.querySelector('[data-swipe-kind="live"]')?.getAnimations().length === 0);
  await page.screenshot({ path: ".playwright-cli/windows-live-tabs.png" });

  await navigate("/history", '[data-slot="horizontal-swipe-track"]');
  report.push({ page: "历史", ...await exercise('[data-slot="horizontal-swipe-track"]', ["视频历史", "弹幕历史", "视频历史"]) });

  await navigate("/follow", '[data-slot="horizontal-swipe-track"]');
  report.push({ page: "关注", ...await exercise('[data-slot="horizontal-swipe-track"]', ["IPTV 频道", "直播关注", "IPTV 频道"]) });
  await page.screenshot({ path: ".playwright-cli/windows-follow-tabs.png" });

  await navigate("/iptv", '[data-slot="app-swipe-page"]');
  const sources = await header().getByRole("tab").allTextContents();
  if (sources.length > 1) {
    const iptv = await page.evaluate(async (label) => {
      [...document.querySelectorAll('[data-slot="app-header"] [role="tab"]')].find((tab) => tab.textContent.trim() === label).click();
      let maxAnimations = 0;
      let maxPanChildren = 0;
      const start = performance.now();
      do {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        maxAnimations = Math.max(maxAnimations, document.querySelector('[data-slot="app-swipe-page"]').getAnimations().length);
        maxPanChildren = Math.max(maxPanChildren, ...[...document.querySelectorAll('[data-slot="page-pan"]')].map((pan) => pan.children.length));
      } while (performance.now() - start < 700);
      if (maxAnimations > 1 || maxPanChildren > 1) throw new Error("IPTV 来源切换叠加父子两段动画");
      return { maxAnimations, maxPanChildren };
    }, sources[1].trim());
    report.push({ page: "IPTV", ...iptv });
  }
  await page.screenshot({ path: ".playwright-cli/windows-iptv-tabs.png" });
  await navigate("/video", '[data-swipe-kind="video"]');
  return report;
}
