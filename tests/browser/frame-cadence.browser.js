// 帧节奏探针：区分「屏幕刷新率」「WebView 送帧上限」和「内容决定的节奏」。
// 不改页面代码、不替换 requestAnimationFrame；可先切弹幕开关并 seek 到指定位置。
// 配置（window.__vodDanmakuBenchConfig 的子集）：
//   variant: "on" | "off" | "masked" | "keep"（keep 不改弹幕，用于首页/直播间等非 VOD 页面）
//   seekTo / sampleFrom / ms / targetHz
// 读法：中位帧间隔落在 8.3ms 附近表示按 120Hz 节奏送帧，16.7ms 附近表示 60Hz 节奏。
// 弹幕开与关会改变节奏本身，所以跨对照的 FPS 不能直接相减。
async (page) => {
  const config = await page.evaluate(() => window.__vodDanmakuBenchConfig ?? {});
  const variant = config.variant ?? "keep";
  const ms = config.ms ?? 5000;
  const targetHz = config.targetHz ?? 120;
  const seekTo = config.seekTo ?? 38;
  const sampleFrom = config.sampleFrom ?? 41;
  const maskId = "__vod-danmaku-cadence-mask";
  if (!["on", "off", "masked", "keep"].includes(variant)) throw new Error("variant 仅支持 on / off / masked / keep");
  if (await page.evaluate((id) => Boolean(document.getElementById(id)), maskId)) throw new Error("存在未清理的探针样式，请重载页面");
  const cdp = await page.context().newCDPSession(page);
  const initial = await page.evaluate(() => ({
    danmaku: document.querySelector("[data-video-danmaku-layer]")?.dataset.visible === "true",
    muted: document.querySelector("video")?.muted ?? null,
  }));
  try {
    await page.evaluate((id) => document.getElementById(id)?.remove(), maskId);
    if (variant !== "keep") {
      const applied = await page.evaluate(async ({ on, mask, id }) => {
        const layer = document.querySelector("[data-video-danmaku-layer]");
        if (!layer) return { ok: false, reason: "页面没有弹幕层" };
        const visible = () => document.querySelector("[data-video-danmaku-layer]")?.dataset.visible === "true";
        if (visible() !== on) {
          const button = document.querySelector(`button[aria-label="${on ? "开启弹幕" : "关闭弹幕"}"]`);
          if (!button) return { ok: false, reason: "没有弹幕开关" };
          button.click();
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
        if (mask) {
          const style = document.createElement("style");
          style.id = id;
          style.textContent = "[data-video-danmaku-layer],[data-slot=video-danmaku-list]{display:none!important}";
          document.head.appendChild(style);
        }
        return { ok: true, visible: visible() };
      }, { on: variant !== "off", mask: variant === "masked", id: maskId });
      if (!applied.ok) throw new Error(applied.reason);
    }
    const video = await page.evaluate(() => Boolean(document.querySelector("video")));
    if (video && variant !== "keep") {
      await page.evaluate(async ({ seekTo }) => {
        const element = document.querySelector("video");
        element.pause();
        await new Promise((resolve, reject) => {
          const done = () => { clearTimeout(timer); element.removeEventListener("seeked", done); resolve(); };
          const timer = setTimeout(() => { element.removeEventListener("seeked", done); reject(new Error("seek 超时")); }, 15000);
          element.addEventListener("seeked", done, { once: true });
          element.currentTime = seekTo;
        });
        try { await element.play(); } catch { element.muted = true; await element.play(); }
      }, { seekTo });
      let reached = false;
      for (let n = 0; n < 300; n++) {
        reached = await page.evaluate((at) => document.querySelector("video").currentTime >= at, sampleFrom);
        if (reached) break;
        await page.waitForTimeout(200);
      }
      if (!reached) throw new Error("未播放到采样起点");
    }
    await cdp.send("Performance.enable");
    const metrics = async () => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map(({ name, value }) => [name, value]));
    const state = await page.evaluate(() => ({
      url: location.href,
      viewport: [innerWidth, innerHeight],
      dpr: devicePixelRatio,
      playing: [...document.querySelectorAll("video")].filter((v) => !v.paused).length,
      danmakuVisible: document.querySelector("[data-video-danmaku-layer]")?.dataset.visible ?? null,
      mountedDanmaku: document.querySelectorAll("[data-rlive-danmaku-id]").length,
      listRows: document.querySelectorAll('[data-slot="video-danmaku-list"] li').length,
      animations: document.getAnimations().length,
    }));
    const rows = [];
    for (let round = 0; round < 3; round++) {
      const before = await metrics();
      const sample = await page.evaluate(async ({ ms, targetHz }) => {
        const intervals = [];
        let first;
        let previous;
        await new Promise((resolve) => {
          const tick = (time) => {
            if (first === undefined) first = time;
            if (previous !== undefined) intervals.push(time - previous);
            previous = time;
            if (time - first >= ms) resolve();
            else requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });
        const sorted = [...intervals].sort((a, b) => a - b);
        const p = (q) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
        const r = (value) => Math.round(value * 100) / 100;
        const budget = 1000 / targetHz;
        const limits = [budget * 1.1, budget * 1.5, budget * 2, budget * 2.5, budget * 3, budget * 4, budget * 8];
        const labels = [`<=${r(limits[0])}ms(满帧)`, `<=${r(limits[1])}ms`, `<=${r(limits[2])}ms(60Hz 节奏)`, `<=${r(limits[3])}ms`, `<=${r(limits[4])}ms`, `<=${r(limits[5])}ms`, `<=${r(limits[6])}ms`, `>${r(limits[6])}ms`];
        const buckets = new Array(labels.length).fill(0);
        for (const value of intervals) {
          const index = limits.findIndex((limit) => value <= limit);
          buckets[index === -1 ? labels.length - 1 : index]++;
        }
        const total = Math.max(1, intervals.length);
        return {
          durationMs: r(previous - first), frames: intervals.length, fps: r(intervals.length * 1000 / (previous - first)),
          frameMs: { min: r(sorted[0]), median: r(p(0.5)), p95: r(p(0.95)), max: r(sorted.at(-1)) },
          cadence: p(0.5) <= budget * 1.1 ? "满帧" : p(0.5) <= budget * 2 ? "60Hz 节奏" : "更低",
          buckets: Object.fromEntries(labels.map((label, index) => [label, `${buckets[index]} (${Math.round(buckets[index] * 100 / total)}%)`])),
        };
      }, { ms, targetHz });
      const after = await metrics();
      const elapsed = after.Timestamp - before.Timestamp;
      const perSecond = {};
      for (const [label, key] of Object.entries({ Script: "ScriptDuration", Style: "RecalcStyleDuration", Layout: "LayoutDuration", Task: "TaskDuration" })) {
        perSecond[label] = Math.round((after[key] - before[key]) * 10000 / elapsed) / 10;
      }
      rows.push({ round, ...sample, msPerSecond: perSecond });
    }
    return { capturedAt: new Date().toISOString(), variant, targetHz, config: { ms, seekTo, sampleFrom }, state, rows };
  } finally {
    await page.evaluate((id) => document.getElementById(id)?.remove(), maskId).catch(() => {});
    await page.evaluate(async (on) => {
      const visible = () => document.querySelector("[data-video-danmaku-layer]")?.dataset.visible === "true";
      if (visible() === on) return;
      document.querySelector(`button[aria-label="${on ? "开启弹幕" : "关闭弹幕"}"]`)?.click();
      await new Promise((resolve) => setTimeout(resolve, 300));
    }, initial.danmaku).catch(() => {});
    await page.evaluate((muted) => {
      const video = document.querySelector("video");
      video?.pause();
      if (video && typeof muted === "boolean") video.muted = muted;
    }, initial.muted).catch(() => {});
    await cdp.detach();
  }
}
