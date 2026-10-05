// 真实 Windows 主窗口 VOD 侧栏调占比的样式/布局采样；不修改设置或替换 IPC。
// 先打开一个有相关视频/评论数据的 VOD，再运行本文件；采样后恢复视口和布局。
// playwright-cli -s=rwin run-code --filename=tests/vod-resize-performance.browser.js
async (page) => {
  const client = await page.context().newCDPSession(page);
  try {
    await client.send("Emulation.setDeviceMetricsOverride", {
      width: 401,
      height: 757,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await client.send("Performance.enable");
    await page.evaluate(async () => {
      if (!window.__TAURI_INTERNALS__) throw new Error("请连接真实 Tauri 主窗口");
      const frame = document.querySelector("[data-video-details-frame]");
      if (!frame) throw new Error("请先打开 VOD 播放页");
      window.__resizeSample = {
        style: frame.getAttribute("style"),
        resizing: frame.getAttribute("data-vod-details-resizing"),
      };
      const { writeDetailsShare } = await import("/src/shared/hooks/useDetailsResize.ts");
      writeDetailsShare(frame, 40);
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
    });
    const before = Object.fromEntries(
      (await client.send("Performance.getMetrics")).metrics.map((x) => [x.name, x.value]),
    );
    const sample = await page.evaluate(async () => {
      const { writeDetailsShare } = await import("/src/shared/hooks/useDetailsResize.ts");
      const frame = document.querySelector("[data-video-details-frame]");
      const intervals = [];
      let last = performance.now();
      for (let i = 0; i < 120; i++) {
        await new Promise(requestAnimationFrame);
        const now = performance.now();
        intervals.push(now - last);
        last = now;
        writeDetailsShare(frame, 40 + Math.sin(i / 15) * 15);
      }
      await new Promise(requestAnimationFrame);
      intervals.sort((a, b) => a - b);
      return {
        frames: intervals.length,
        p50Ms: intervals[Math.floor(intervals.length * 0.5)],
        p95Ms: intervals[Math.floor(intervals.length * 0.95)],
        descendants: frame.querySelectorAll("*").length,
      };
    });
    const after = Object.fromEntries(
      (await client.send("Performance.getMetrics")).metrics.map((x) => [x.name, x.value]),
    );
    return {
      ...sample,
      styleMs: (after.RecalcStyleDuration - before.RecalcStyleDuration) * 1000,
      layoutMs: (after.LayoutDuration - before.LayoutDuration) * 1000,
      styleCount: after.RecalcStyleCount - before.RecalcStyleCount,
      layoutCount: after.LayoutCount - before.LayoutCount,
    };
  } finally {
    await page.evaluate(() => {
      const saved = window.__resizeSample;
      const frame = document.querySelector("[data-video-details-frame]");
      if (saved && frame) {
        for (const [key, value] of [
          ["style", saved.style],
          ["data-vod-details-resizing", saved.resizing],
        ]) {
          if (value === null) frame.removeAttribute(key);
          else frame.setAttribute(key, value);
        }
      }
      delete window.__resizeSample;
    });
    await client.send("Emulation.clearDeviceMetricsOverride");
    await client.detach();
  }
}
