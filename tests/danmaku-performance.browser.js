// Windows 主窗口：真实 VideoDanmakuLayer / DanmakuRenderer 高密度压测。
// 统计 rAF 帧间隔、长任务、CDP 主线程脚本/样式/布局耗时与 Paint/Raster；另以 4× CPU 节流模拟低端 Android。
// 在不播放视频的页面运行（如 /settings），避免页面自身的播放请求和渲染干扰测量：
// playwright-cli -s=rwin run-code --filename=tests/danmaku-performance.browser.js
async (page) => {
  const SAMPLE_MS = 6_000;
  const WARMUP_MS = 2_000;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const metrics = async () => {
    const { metrics: list } = await cdp.send("Performance.getMetrics");
    return Object.fromEntries(list.map(({ name, value }) => [name, value]));
  };
  // Paint/Raster 不计入主线程 CPU 指标；弹幕节点未独立成层时整块舞台每帧重绘，只能靠 trace 发现。
  const PAINT_EVENTS = new Set(["Paint", "RasterTask"]);
  const startTrace = async () => {
    const events = [];
    const onData = ({ value }) => {
      for (const event of value) if (event.ph === "X" && PAINT_EVENTS.has(event.name)) events.push(event);
    };
    cdp.on("Tracing.dataCollected", onData);
    await cdp.send("Tracing.start", {
      categories: "devtools.timeline,disabled-by-default-devtools.timeline",
      transferMode: "ReportEvents",
    });
    return async (seconds) => {
      const complete = new Promise((resolve) => cdp.once("Tracing.tracingComplete", resolve));
      await cdp.send("Tracing.end");
      await complete;
      cdp.off("Tracing.dataCollected", onData);
      const perSecond = (name) =>
        +(events.filter((event) => event.name === name).reduce((sum, event) => sum + (event.dur ?? 0), 0) /
          1_000 / seconds).toFixed(1);
      return { paintMsPerSec: perSecond("Paint"), rasterMsPerSec: perSecond("RasterTask") };
    };
  };

  await page.evaluate(async () => {
    const { setupHarness, until } = await import("/tests/browser/harness.js");
    const { VideoDanmakuLayer } = await import("/src/features/video/VideoDanmakuLayer.tsx");
    const { loadDanmakuRenderer } = await import("/src/features/room/danmaku/danmakuLoader.ts");
    const { danmakuCommentFromEvent } = await import("/src/features/room/danmaku/danmakuAdapter.ts");
    const settingsUrl =
      performance
        .getEntriesByType("resource")
        .find(
          (resource) => new URL(resource.name).pathname === "/src/shared/stores/settingsStore.ts",
        )?.name ?? "/src/shared/stores/settingsStore.ts";
    const { useSettingsStore } = await import(settingsUrl);
    const settings = useSettingsStore.getState();
    const Renderer = await loadDanmakuRenderer();
    const harness = await setupHarness({
      style: "position:fixed;inset:0;z-index:999;background:#111;pointer-events:none",
    });
    const { h, createRef, render } = harness;
    useSettingsStore.setState({
      danmakuFontSize: 24,
      danmakuFontStroke: 1,
      danmakuSpeed: 100,
      danmakuArea: 1,
      danmakuOpacity: 1,
      danmakuShieldWords: [],
    });
    let size = () => 0;
    let stopScenario = () => {};

    /** 记录 rAF 帧间隔与长任务；以中位帧间隔为基准适配 60/120/144Hz 等刷新率。 */
    const sample = async (durationMs) => {
      const intervals = [];
      const longTasks = [];
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) longTasks.push(entry.duration);
      });
      try {
        observer.observe({ type: "longtask", buffered: false });
      } catch {
        // 不支持 longtask 的 WebView 仅统计帧间隔。
      }
      let maxActive = 0;
      await new Promise((resolve) => {
        let last = 0;
        const start = performance.now();
        const frame = (now) => {
          if (last) intervals.push(now - last);
          last = now;
          maxActive = Math.max(maxActive, size());
          if (now - start < durationMs) requestAnimationFrame(frame);
          else resolve();
        };
        requestAnimationFrame(frame);
      });
      observer.disconnect();
      intervals.sort((a, b) => a - b);
      const median = intervals[intervals.length >> 1];
      const pct = (p) => intervals[Math.min(intervals.length - 1, Math.floor(intervals.length * p))];
      return {
        frames: intervals.length,
        medianMs: +median.toFixed(2),
        p99Ms: +pct(0.99).toFixed(2),
        maxMs: +intervals[intervals.length - 1].toFixed(2),
        // 超过 1.5 个中位帧即视为丢帧；高刷屏 + CPU 节流时此项受页面自身影响大，需对照空闲基线。
        droppedPct: +((intervals.filter((v) => v > median * 1.5).length / intervals.length) * 100).toFixed(2),
        // 错过 60Hz vsync（> 1.5 个 60Hz 帧）的帧：低端设备上肉眼可见的卡顿，与屏幕刷新率无关。
        jankFrames: intervals.filter((v) => v > 25).length,
        longTasks: longTasks.length,
        longTaskMaxMs: longTasks.length ? +Math.max(...longTasks).toFixed(1) : 0,
        maxActive,
      };
    };

    const startVod = async () => {
      // 每秒 40 条滚动 + 4 条顶部/底部固定弹幕，媒体时钟连续前进。
      const videoRef = createRef();
      const entries = [];
      for (let i = 0; i < 40 * 60; i++) {
        entries.push({
          id: `perf-scroll-${i}`,
          mode: "scroll",
          progressMs: 50 + i * 25,
          color: i % 7 === 0 ? "#ffcc00" : "#ffffff",
          pool: 0,
          content: `高密度弹幕压测 ${i} ${"哈".repeat(i % 12)}`,
        });
      }
      for (let i = 0; i < 4 * 60; i++) {
        entries.push({
          id: `perf-fixed-${i}`,
          mode: i % 2 ? "top" : "bottom",
          progressMs: 70 + i * 250,
          color: "#00aaff",
          pool: 0,
          content: `固定弹幕 ${i}`,
        });
      }
      let renderer;
      const originalSetComments = Renderer.prototype.setComments;
      Renderer.prototype.setComments = function (comments) {
        if (comments.some((comment) => String(comment.id).startsWith("perf-"))) renderer = this;
        return originalSetComments.call(this, comments);
      };
      const anchor = performance.now();
      render(
        h(
          "section",
          null,
          h("video", { ref: videoRef }),
          h(VideoDanmakuLayer, { videoRef, entries, active: true, interactive: true }),
        ),
      );
      Object.defineProperties(videoRef.current, {
        currentTime: { configurable: true, get: () => (performance.now() - anchor) / 1_000 },
        paused: { configurable: true, get: () => false },
      });
      try {
        await until(() => renderer, "VOD 渲染器未就绪");
      } finally {
        Renderer.prototype.setComments = originalSetComments;
      }
      videoRef.current.dispatchEvent(new Event("seeking"));
      videoRef.current.dispatchEvent(new Event("playing"));
      size = () => renderer.size;
      stopScenario = () => render(null);
    };

    const startLive = () => {
      // 无媒体时钟，持续每秒 60 条富文本弹幕。
      const stage = document.createElement("div");
      stage.style.cssText = "position:absolute;inset:0;overflow:hidden";
      harness.host.append(stage);
      const live = new Renderer({ container: stage, speed: 100, area: 1 });
      let seq = 0;
      const timer = setInterval(() => {
        for (let i = 0; i < 6; i++) {
          const comment = danmakuCommentFromEvent(
            {
              kind: "chat",
              user: "观众",
              content: `直播压测弹幕 ${seq} ${"冲".repeat(seq % 9)}`,
              color: seq % 5 === 0 ? "#ff6699" : null,
              ts: Date.now(),
            },
            { id: `live-${seq++}`, fontSize: 24, fontStroke: 1, opacity: 1, laneCount: 30 },
          );
          if (comment) live.emit(comment);
        }
      }, 100);
      size = () => live.size;
      stopScenario = () => {
        clearInterval(timer);
        live.destroy();
        stage.remove();
      };
    };

    window.__danmakuPerf = {
      startIdle: () => {
        size = () => 0;
        stopScenario = () => {};
      },
      startVod,
      startLive,
      sample,
      stop: () => {
        stopScenario();
        size = () => 0;
      },
      dispose: () => {
        harness.dispose();
        useSettingsStore.setState(settings, true);
        delete window.__danmakuPerf;
      },
    };
  });

  const run = async (label, start, throttle) => {
    await page.evaluate((name) => window.__danmakuPerf[name](), start);
    if (throttle > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle });
    await page.waitForTimeout(WARMUP_MS);
    const before = await metrics();
    // Trace 本身开销大，叠加 CPU 节流会污染主线程指标；绘制是否独立成层与节流无关，只在 1× 采集。
    const stopTrace = throttle === 1 ? await startTrace() : null;
    const frames = await page.evaluate((ms) => window.__danmakuPerf.sample(ms), SAMPLE_MS);
    const paint = stopTrace ? await stopTrace(SAMPLE_MS / 1_000) : {};
    const after = await metrics();
    if (throttle > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    await page.evaluate(() => window.__danmakuPerf.stop());
    // 每帧主线程开销（ms），包含弹幕引擎脚本、样式重算和布局。
    const perFrame = (key) => +(((after[key] - before[key]) * 1_000) / frames.frames).toFixed(3);
    return {
      label,
      throttle,
      ...frames,
      scriptMsPerFrame: perFrame("ScriptDuration"),
      styleMsPerFrame: perFrame("RecalcStyleDuration"),
      layoutMsPerFrame: perFrame("LayoutDuration"),
      layouts: after.LayoutCount - before.LayoutCount,
      ...paint,
    };
  };

  const results = [];
  try {
    for (const throttle of [1, 4]) {
      results.push(await run("空闲基线", "startIdle", throttle));
      results.push(await run("VOD 40 条/秒 + 固定弹幕", "startVod", throttle));
      results.push(await run("直播 60 条/秒", "startLive", throttle));
    }
  } finally {
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 }).catch(() => {});
    await page.evaluate(() => window.__danmakuPerf?.dispose());
    await cdp.detach().catch(() => {});
  }
  const failures = [];
  for (const result of results) {
    if (result.label === "空闲基线") continue;
    const name = `${result.label}（${result.throttle}× 节流）`;
    const idle = results.find((item) => item.label === "空闲基线" && item.throttle === result.throttle);
    if (result.maxActive <= 40) failures.push(`${name} 弹幕数量不足：${result.maxActive}`);
    // 卡顿帧不应明显多于同档空闲页面（允许 1% 的采样噪声）；空闲基线吸收页面自身与机器负载。
    if (result.jankFrames > idle.jankFrames + Math.ceil(result.frames * 0.01))
      failures.push(`${name} 卡顿 ${result.jankFrames} 帧，空闲基线 ${idle.jankFrames} 帧`);
    if (result.throttle === 1) {
      if (result.longTaskMaxMs >= 50) failures.push(`${name} 出现 ${result.longTaskMaxMs}ms 长任务`);
      // 未独立成层时整块舞台每帧重绘，实测 Paint+Raster 约 270ms/s。
      if (result.paintMsPerSec + result.rasterMsPerSec > 30)
        failures.push(`${name} 每秒绘制 ${result.paintMsPerSec}ms、光栅 ${result.rasterMsPerSec}ms，弹幕可能未独立成层`);
    }
  }
  if (failures.length) throw new Error(`${failures.join("；")}\n${JSON.stringify(results)}`);
  return results;
}
