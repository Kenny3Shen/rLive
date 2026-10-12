// 真实播放页的热点定位 Trace；与 Performance 采样分开运行，避免 Trace 开销混入 A/B。
// 先选定构建与弹幕开关。默认 seek 38s、41s 起采 5s；配置沿用 __vodDanmakuBenchConfig。
// pace:true 时注入一个微小的已绘制合成动画，把 Android 显示节奏固定在 120Hz 档；
// 不注入时无合成动画的页面会退回 60Hz 档，两份 Trace 就无法比较。
// 仅汇总同名完整事件的 inclusive duration；不同事件可能嵌套，绝不能相加当作线程忙碌时间。
async (page) => {
  const config = await page.evaluate(() => window.__vodDanmakuBenchConfig ?? {});
  const cid = String(config.expectCid ?? 1176840);
  const from = config.sampleFrom ?? 41;
  const sampleMs = config.sampleMs ?? 5000;
  const pace = config.pace === true;
  const paceId = "__vod-danmaku-trace-pace";
  const cdp = await page.context().newCDPSession(page);
  let tracing = false;
  const events = [];
  cdp.on("Tracing.dataCollected", ({ value }) => events.push(...value));
  try {
    await page.evaluate(async ({ cid, seekTo }) => {
      if (new URLSearchParams(location.search).get("cid") !== cid) throw new Error("分 P 错误");
      const v = document.querySelector("video");
      v.pause();
      await new Promise((resolve, reject) => {
        const done = () => { clearTimeout(timer); v.removeEventListener("seeked", done); resolve(); };
        const timer = setTimeout(() => { v.removeEventListener("seeked", done); reject(new Error("seek 超时")); }, 15000);
        v.addEventListener("seeked", done, { once: true });
        v.currentTime = seekTo;
      });
      await v.play();
    }, { cid, seekTo: config.seekTo ?? 38 });
    let ready = false;
    for (let n = 0; n < 240; n++) {
      ready = await page.evaluate((from) => document.querySelector("video").currentTime >= from, from);
      if (ready) break;
      await page.waitForTimeout(250);
    }
    if (!ready) throw new Error("未播放到采样起点");
    if (pace) {
      await page.evaluate((id) => {
        document.getElementById(id)?.remove();
        const element = document.createElement("div");
        element.id = id;
        element.style.cssText = "position:fixed;left:0;top:0;width:2px;height:2px;background:#000;opacity:0.02;pointer-events:none;z-index:0";
        element.animate([{ transform: "translateX(0px)" }, { transform: "translateX(120px)" }], { duration: 2000, iterations: Infinity });
        document.body.appendChild(element);
      }, paceId);
    }
    await cdp.send("Performance.enable");
    const timestamp = async () => (await cdp.send("Performance.getMetrics")).metrics.find((v) => v.name === "Timestamp").value;
    const start = await timestamp();
    await cdp.send("Tracing.start", {
      traceConfig: { includedCategories: ["devtools.timeline", "toplevel", "disabled-by-default-devtools.timeline", "cc", "gpu", "media", "v8"], recordMode: "recordContinuously" },
      transferMode: "ReportEvents",
    });
    tracing = true;
    await page.waitForTimeout(sampleMs);
    const end = await timestamp();
    const done = new Promise((resolve) => cdp.once("Tracing.tracingComplete", resolve));
    await cdp.send("Tracing.end");
    await done;
    tracing = false;
    const names = new Map();
    for (const e of events) if (e.ph === "M" && e.name === "thread_name") names.set(`${e.pid}:${e.tid}`, e.args.name);
    const totals = new Map();
    for (const e of events) {
      if (e.ph !== "X" || typeof e.dur !== "number") continue;
      const thread = names.get(`${e.pid}:${e.tid}`);
      if (thread !== "CrRendererMain") continue;
      totals.set(e.name, (totals.get(e.name) ?? 0) + e.dur / 1000);
    }
    return {
      capturedAt: new Date().toISOString(),
      build: await page.evaluate(() => window.__vodDanmakuBuild ?? null),
      cid,
      pace,
      elapsedSeconds: end - start,
      events: events.length,
      note: "同名事件累计 inclusive ms/s；嵌套事件不能相加，非 self time 或线程占用率。Trace 有额外开销。",
      rendererEventsMsPerSecond: Object.fromEntries([...totals].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([key, ms]) => [key, Math.round(ms / (end - start) * 10) / 10])),
    };
  } finally {
    if (tracing) await cdp.send("Tracing.end").catch(() => {});
    await page.evaluate((id) => document.getElementById(id)?.remove(), paceId).catch(() => {});
    await page.evaluate(() => document.querySelector("video")?.pause()).catch(() => {});
    await cdp.detach();
  }
}
