// 真实 VOD 播放 + 弹幕的实机采样（Windows WebView2 / Android WebView 主窗口）。
// 不替换 IPC、媒体引擎或弹幕数据；同一播放器内原地交错对照。
// on：正常弹幕；off：产品开关隐藏弹幕层（引擎仍运行）；masked：测试专用样式同时
// display:none 弹幕层与侧栏列表，只隔离二者的可见渲染成本，不代表引擎已停用。
//
// 先在主窗口打开目标播放页（默认 BV1Js411o76u P1）并等视频就绪，再运行：
//   playwright-cli -s=rand eval 'window.__vodDanmakuBenchConfig = {variants:["on","off"],repeat:2}'
//   playwright-cli -s=rand --raw run-code --filename=tests/vod-danmaku-performance.browser.js > .playwright-cli/vod-danmaku.json
//
// 默认采 41–49s：该稿件 40–50s 段约 92 条/秒，是 P1 最密的窗口。
// 脚本内不做页面导航：Android WebView 上 run-code 期间的导航会让 CLI 在结束时等待 load 超时。
// 首轮仅预热（拉齐分片缓存与弹幕分段），不计入结果。竖屏紧凑布局没有弹幕开关，只能测 on。
// 正常播放会写观看历史；结束时暂停并还原 muted、弹幕开关。不改设置、不发送弹幕。
// oxlint-disable-next-line no-unused-expressions -- playwright-cli 读取并执行函数表达式。
async (page) => {
  const config = await page.evaluate(() => {
    if (!window.__TAURI_INTERNALS__) throw new Error("请连接真实 Tauri 主窗口");
    if (!location.pathname.startsWith("/video/play")) throw new Error("请先打开视频播放页");
    return { cid: new URLSearchParams(location.search).get("cid"), ...(window.__vodDanmakuBenchConfig ?? {}) };
  });
  // 越过分 P 结尾会自动连播到下一 P；每轮校验 cid，避免把别的分 P 当成目标段。
  const expectedCid = String(config.expectCid ?? "1176840");
  const seekTo = config.seekTo ?? 38;
  const sampleFrom = config.sampleFrom ?? 41;
  const sampleMs = config.sampleMs ?? 8000;
  const variants = config.variants ?? ["on", "off"];
  const repeat = config.repeat ?? 1;
  // 只用于计算采样指标，不强制 WebView 刷新率；实际显示模式须由系统侧确认。
  const targetHz = config.targetHz ?? 60;
  if (!Number.isFinite(targetHz) || targetHz <= 0) throw new Error("targetHz 必须为正数");
  // pace：采样期间挂一个微小的合成器动画，把 Android 的刷新率固定在 targetHz。
  // 只影响显示节奏，不改变弹幕引擎、DOM 结构或被测数据；不设时保留系统自适应。
  // 元素必须真的被绘制（有背景色）：完全透明的元素不产生绘制，Chromium 不会为它升档刷新率，
  // 实测同一页面下「无背景」65 FPS vs「有背景」96 FPS，所以这里给 2×2 黑点并压到最底层。
  const pace = config.pace === true;
  const paceId = "__vod-danmaku-bench-pace";
  if (!Array.isArray(variants) || !variants.length || variants.some((v) => !["on", "off", "masked"].includes(v))) {
    throw new Error("variants 仅支持 on / off / masked");
  }
  if (!Number.isInteger(repeat) || repeat < 1 || !Number.isFinite(seekTo) || seekTo < 0 ||
      !Number.isFinite(sampleFrom) || sampleFrom <= seekTo || !Number.isFinite(sampleMs) || sampleMs <= 0) {
    throw new Error("无效采样参数：需 repeat >= 1、0 <= seekTo < sampleFrom、sampleMs > 0");
  }
  const maskId = "__vod-danmaku-bench-mask";
  if (await page.evaluate((id) => Boolean(document.getElementById(id)), maskId)) {
    throw new Error("存在未清理的采样样式，请重载页面再运行");
  }
  // Android CDP 下 waitForFunction 不可靠；统一用 evaluate 轮询。
  const until = async (fn, arg, ms, label) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await page.evaluate(fn, arg)) return;
      await page.waitForTimeout(200);
    }
    throw new Error(`等待超时：${label}`);
  };
  const cdp = await page.context().newCDPSession(page);
  const metrics = async () =>
    Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map(({ name, value }) => [name, value]));
  const initial = await page.evaluate(() => ({
    danmaku: document.querySelector("[data-video-danmaku-layer]")?.dataset.visible === "true",
    muted: document.querySelector("video")?.muted ?? null,
  }));
  const setDanmaku = (on) => page.evaluate(async (on) => {
    const visible = () => document.querySelector("[data-video-danmaku-layer]")?.dataset.visible === "true";
    if (visible() === on) return true;
    const button = document.querySelector(`button[aria-label="${on ? "开启弹幕" : "关闭弹幕"}"]`);
    if (!button) return false;
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 300));
    return visible() === on;
  }, on);
  const rows = [];
  const plan = [{ round: -1, variant: variants[0], warmup: true }];
  for (let round = 0; round < repeat; round++) for (const variant of variants) plan.push({ round, variant });
  try {
    await cdp.send("Performance.enable", { timeDomain: "timeTicks" });
    await until(() => {
      const video = document.querySelector("video");
      return video && video.readyState >= 2 && video.duration > 0 && document.querySelector("[data-video-danmaku-layer]");
    }, null, 60000, "视频与弹幕层就绪");
    for (const { round, variant, warmup } of plan) {
      let stage = "toggle";
      try {
        await page.evaluate((id) => document.getElementById(id)?.remove(), maskId);
        if (!(await setDanmaku(variant !== "off"))) throw new Error(`无法切换弹幕为 ${variant}（竖屏紧凑布局没有开关）`);
        if (variant === "masked") {
          await page.evaluate((id) => {
            const style = document.createElement("style");
            style.id = id;
            style.textContent = "[data-video-danmaku-layer],[data-slot=video-danmaku-list]{display:none!important}";
            document.head.appendChild(style);
          }, maskId);
        }
        stage = "seek";
        const setup = await page.evaluate(async ({ seekTo, sampleFrom, sampleMs, expectedCid }) => {
          if (new URLSearchParams(location.search).get("cid") !== expectedCid) throw new Error("当前分 P 与目标不符");
          const video = document.querySelector("video");
          if (sampleFrom + sampleMs / 1000 >= video.duration) throw new Error("采样窗口越过视频结尾");
          video.pause();
          await new Promise((resolve, reject) => {
            const done = () => { clearTimeout(timer); video.removeEventListener("seeked", done); resolve(); };
            const timer = setTimeout(() => {
              video.removeEventListener("seeked", done);
              reject(new Error("seek 超时"));
            }, 15000);
            video.addEventListener("seeked", done, { once: true });
            video.currentTime = seekTo;
          });
          try {
            await video.play();
          } catch {
            // 无用户手势时自动播放可能被拒；静音重试，结束时还原。
            video.muted = true;
            await video.play();
          }
          const layer = document.querySelector("[data-video-danmaku-layer]");
          const rect = layer?.getBoundingClientRect();
          const firstRow = document.querySelector('[data-slot="video-danmaku-list"] li');
          const rowContentVisibility = firstRow ? getComputedStyle(firstRow).contentVisibility : null;
          if (window.__vodDanmakuBuild?.variant === "baseline" && firstRow && rowContentVisibility !== "auto") {
            throw new Error("基线缺少 content-visibility:auto 样式，A/B 无效");
          }
          return {
            layerVisible: layer?.dataset.visible === "true",
            layerSize: rect ? { width: Math.round(rect.width), height: Math.round(rect.height) } : null,
            viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
            videoSize: { width: video.videoWidth, height: video.videoHeight },
            muted: video.muted,
            list: {
              total: Number(document.querySelector('[data-slot="video-danmaku-list"] ol')?.getAttribute("data-count")) ||
                document.querySelectorAll('[data-slot="video-danmaku-list"] li').length,
              mounted: document.querySelectorAll('[data-slot="video-danmaku-list"] li').length,
              rowContentVisibility,
              active: !document.querySelector('[data-slot="video-danmaku-list"]')?.closest('[inert],[aria-hidden="true"]'),
            },
            cid: new URLSearchParams(location.search).get("cid"),
          };
        }, { seekTo, sampleFrom, sampleMs, expectedCid });
        if (setup.cid !== expectedCid) throw new Error(`当前 cid ${setup.cid} 不是目标 ${expectedCid}`);
        stage = "warmup";
        await until((at) => document.querySelector("video").currentTime >= at, sampleFrom, 60000, "播放到采样起点");
        stage = "sample";
        if (pace) {
          await page.evaluate((id) => {
            const element = document.createElement("div");
            element.id = id;
            element.style.cssText = "position:fixed;left:0;top:0;width:2px;height:2px;background:#000;opacity:0.02;pointer-events:none;z-index:0";
            element.animate([{ transform: "translateX(0px)" }, { transform: "translateX(120px)" }], { duration: 2000, iterations: Infinity });
            document.body.appendChild(element);
          }, paceId);
        }
        const before = await metrics();
        const sample = await page.evaluate(async ({ ms, targetHz }) => {
          const animationsAtStart = document.getAnimations().length;
          const video = document.querySelector("video");
          const layer = document.querySelector("[data-video-danmaku-layer]");
          const quality = () => video.getVideoPlaybackQuality?.() ?? null;
          const q0 = quality();
          const t0 = video.currentTime;
          const intervals = [];
          const density = [];
          const tasks = [];
          let waiting = 0;
          const onWaiting = () => { waiting += 1; };
          video.addEventListener("waiting", onWaiting);
          const observer = PerformanceObserver.supportedEntryTypes.includes("longtask")
            ? new PerformanceObserver((list) => tasks.push(...list.getEntries())) : null;
          observer?.observe({ type: "longtask" });
          // 每秒只读一次 DOM，rAF 只记时间，避免采样本身制造样式/布局。
          const densityTimer = setInterval(() => density.push(layer?.querySelectorAll("[data-rlive-danmaku-id]").length ?? 0), 1000);
          const start = performance.now();
          await new Promise((resolve) => {
            let previous = start;
            const tick = (now) => {
              intervals.push(now - previous);
              previous = now;
              if (now - start >= ms) resolve();
              else requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
          });
          const duration = performance.now() - start;
          clearInterval(densityTimer);
          observer?.disconnect();
          video.removeEventListener("waiting", onWaiting);
          const q1 = quality();
          const sorted = [...intervals].sort((a, b) => a - b);
          const pct = (p) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] ?? 0;
          const round = (v) => Math.round(v * 10) / 10;
          return {
            durationMs: round(duration),
            fps: round(intervals.length * 1000 / duration),
            frameMs: { median: round(pct(0.5)), p95: round(pct(0.95)), max: round(sorted.at(-1) ?? 0) },
            jankOver25ms: intervals.filter((v) => v > 25).length,
            frameBudget: {
              targetHz,
              budgetMs: 1000 / targetHz,
              // 1.5 倍帧预算避免把正常时间戳微抖动计为缺帧；120Hz 时阈值为 12.5ms。
              overThresholdMs: 1500 / targetHz,
              overThresholdCount: intervals.filter((v) => v > 1500 / targetHz).length,
              overThresholdPercent: round(intervals.filter((v) => v > 1500 / targetHz).length * 100 / intervals.length),
            },
            // Android 刷新率跟随内容：无合成动画时退回 60Hz 节奏，有动画才升到 120Hz。
            // 跨对照直接比 FPS 会被这个机制污染，必须先看节奏档位。
            cadence: pct(0.5) <= 1000 / targetHz * 1.1 ? "full" : pct(0.5) <= 2000 / targetHz * 1.05 ? "half" : "lower",
            animationsAtStart,
            animationsAtEnd: document.getAnimations().length,
            longtasks: { count: tasks.length, totalMs: round(tasks.reduce((s, t) => s + t.duration, 0)), maxMs: round(Math.max(0, ...tasks.map((t) => t.duration))) },
            media: {
              from: round(t0),
              advancedSeconds: round(video.currentTime - t0),
              waiting,
              droppedFrames: q0 && q1 ? q1.droppedVideoFrames - q0.droppedVideoFrames : null,
              totalFrames: q0 && q1 ? q1.totalVideoFrames - q0.totalVideoFrames : null,
            },
            danmakuDOM: { max: Math.max(0, ...density), mean: round(density.reduce((a, b) => a + b, 0) / Math.max(1, density.length)) },
          };
        }, { ms: sampleMs, targetHz });
        const after = await metrics();
        const elapsed = after.Timestamp - before.Timestamp;
        const msPerSecond = {};
        for (const [label, key] of Object.entries({ Script: "ScriptDuration", Style: "RecalcStyleDuration", Layout: "LayoutDuration", Task: "TaskDuration" })) {
          msPerSecond[label] = Math.round((after[key] - before[key]) * 10000 / elapsed) / 10;
        }
        const cidAfter = await page.evaluate(() => new URLSearchParams(location.search).get("cid"));
        if (cidAfter !== expectedCid) throw new Error(`采样中切到 cid ${cidAfter}`);
        if (!warmup) rows.push({ round, variant, ...setup, ...sample, cdp: { elapsedSeconds: Math.round(elapsed * 100) / 100, msPerSecond } });
      } catch (error) {
        // 保留已完成的轮次；失败轮次记录卡在哪一步，不当作有效样本。
        rows.push({ round, variant, warmup: Boolean(warmup), failed: true, stage, error: String(error?.message ?? error).split("\n")[0] });
      } finally {
        await page.evaluate((id) => document.getElementById(id)?.remove(), paceId).catch(() => {});
        await page.evaluate(() => document.querySelector("video")?.pause()).catch(() => {});
      }
    }
    return {
      capturedAt: new Date().toISOString(),
      build: await page.evaluate(() => window.__vodDanmakuBuild ?? null),
      url: await page.evaluate(() => location.href),
      userAgent: await page.evaluate(() => navigator.userAgent),
      hardware: await page.evaluate(() => ({ cores: navigator.hardwareConcurrency, memory: navigator.deviceMemory ?? null })),
      config: { seekTo, sampleFrom, sampleMs, variants, repeat, targetHz, pace },
      rows,
    };
  } finally {
    await page.evaluate((id) => document.getElementById(id)?.remove(), paceId).catch(() => {});
    await page.evaluate((id) => document.getElementById(id)?.remove(), maskId).catch(() => {});
    await setDanmaku(initial.danmaku).catch(() => {});
    await page.evaluate((muted) => {
      const video = document.querySelector("video");
      video?.pause();
      if (video && typeof muted === "boolean") video.muted = muted;
    }, initial.muted).catch(() => {});
    await cdp.detach();
  }
}
