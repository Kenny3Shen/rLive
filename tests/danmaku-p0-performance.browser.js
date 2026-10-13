// 先构建/预览独立生产页面（详见 tests/browser/danmaku-bench.md）。
// playwright-cli -s=p0 run-code --filename=tests/danmaku-p0-performance.browser.js
// URL 参数：?scene=panel-pinned,panel-up&variants=baseline,current&cpu=1&sample=9000
// high-density 默认 4x、预热 22s；手机 both 预热 6s，面板预热 3s。默认只跑 panel-pinned A/B。
// 返回可序列化 JSON；CLI --raw 的输出请写 .playwright-cli/ 内。不会改 viewport/用户设置。
// oxlint-disable-next-line no-unused-expressions -- playwright-cli 读取并执行函数表达式。
async (page) => {
  await page.waitForFunction(() => window.__danmakuP0Bench?.production === true, null, { timeout: 15000 });
  // playwright-cli 的 run-code 沙箱不保证暴露 URL；在页面上下文解析。
  const query = await page.evaluate(() => Object.fromEntries(new URL(location.href).searchParams));
  const params = { get: (name) => query[name] ?? null, has: (name) => Object.hasOwn(query, name) };
  const sceneNames = (params.get("scene") || "panel-pinned").split(",");
  const variants = (params.get("variants") || "baseline,current").split(",");
  const scenes = {
    "panel-pinned": { mode: "panel", rate: 150, panelWidth: 340, panelHeight: 480, scrolledUp: false },
    "panel-up": { mode: "panel", rate: 150, panelWidth: 340, panelHeight: 480, scrolledUp: true },
    "high-density": { mode: "layer", rate: 200, width: 1920, height: 1080 },
    mobile25: { mode: "both", rate: 25, width: 412, height: 240, panelWidth: 340, panelHeight: 480 },
    mobile200: { mode: "both", rate: 200, width: 412, height: 240, panelWidth: 340, panelHeight: 480 },
    layer: { mode: "layer", rate: 25, width: 412, height: 240 },
    both: { mode: "both", rate: 25, width: 412, height: 240, panelWidth: 340, panelHeight: 480 },
    // bus：只测同样的事件输送，不挂载层和面板，排除原生桥接/测试环境成本。
    bus: { mode: "idle", rate: 25 },
    idle: { mode: "idle", rate: 0 },
  };
  for (const name of sceneNames) if (!scenes[name]) throw new Error(`未知 scene：${name}`);
  for (const variant of variants) if (!["baseline", "current"].includes(variant)) throw new Error(`未知 variant：${variant}`);
  const motions = (params.get("motion") || "running").split(",");
  if (motions.some((motion) => !["running", "paused"].includes(motion))) throw new Error("未知 motion");
  // P2：合成层策略。节点内联的 `will-change:transform` 由夹具用 `!important` 覆盖，
  // 不改生产代码。只对挂载了弹幕层的场景有意义，其余场景会报错而不是静默退化。
  const willChanges = (params.get("willChange") || "node").split(",");
  if (willChanges.some((value) => !["node", "none", "group"].includes(value))) throw new Error("未知 willChange 策略");
  const sampleMs = Number(params.get("sample") || 9000);
  if (!Number.isFinite(sampleMs) || sampleMs < 8000 || sampleMs > 60000) throw new Error("正式采样 sample 须为 8000..60000ms");
  // pace：采样期间挂一个微小的合成器动画，把 Android 显示节奏固定在指定 Hz。
  // 只影响显示节奏，不改弹幕引擎、DOM 结构或被测数据，各变体一律同样注入。不设时保留系统自适应：
  // 120Hz 设备在无合成动画时会退回 60Hz 节奏，跨对照直接比 FPS 会被这个机制污染。
  // 元素必须真的被绘制（有背景色）：完全透明的元素不产生绘制，Chromium 不会为它升档刷新率，
  // 实测同一页面下「无背景」65 FPS vs「有背景」96 FPS，所以这里给 2×2 黑点并压到最底层。
  const paceHz = Number(params.get("pace") || 0);
  if (!Number.isFinite(paceHz) || paceHz < 0) throw new Error("pace 必须是非负数（Hz）");
  const paceId = "__danmaku-p0-bench-pace";
  const cdp = await page.context().newCDPSession(page);
  const readMetrics = async () => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map(({ name, value }) => [name, value]));
  const rows = [];
  try {
    await cdp.send("Performance.enable", { timeDomain: "timeTicks" });
    for (const scene of sceneNames) {
      const cpus = (params.get("cpu") || (scene === "high-density" ? "4" : "1")).split(",").map(Number);
      if (cpus.some((cpu) => ![1, 4].includes(cpu))) throw new Error("cpu 只支持 1、4 或 1,4");
      // both 预填会瞬时向层投递较多消息；6s 覆盖手机 412px 舞台的穿越时间。
      const minimumWarmup = scene === "high-density" ? 22000 : scene.startsWith("mobile") || ["layer", "both"].includes(scene) ? 6000 : 3000;
      const warmupMs = Math.max(minimumWarmup, Number(params.get("warmup") || minimumWarmup));
      if (!Number.isFinite(warmupMs)) throw new Error("warmup 必须是毫秒数");
      for (const cpu of cpus) for (const variant of variants) for (const motion of motions) for (const willChange of willChanges) {
        await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpu });
        const options = { ...scenes[scene], variant, motion, willChange };
        // 可覆写 layer 几何/rate 但结果仍完整记录，便于有限档位的设备专项复跑。
        for (const name of ["width", "height", "panelWidth", "panelHeight", "rate"]) {
          if (params.has(name)) options[name] = Number(params.get(name));
        }
        await page.evaluate((input) => window.__danmakuP0Bench.start(input), options);
        if (paceHz > 0) {
          await page.evaluate(({ id }) => {
            document.getElementById(id)?.remove();
            const element = document.createElement("div");
            element.id = id;
            element.style.cssText = "position:fixed;left:0;top:0;width:2px;height:2px;background:#000;opacity:0.02;pointer-events:none;z-index:0";
            element.animate([{ transform: "translateX(0px)" }, { transform: "translateX(120px)" }], { duration: 2000, iterations: Infinity });
            document.body.appendChild(element);
          }, { id: paceId });
        }
        await page.waitForTimeout(warmupMs);
        const before = await readMetrics();
        const measurement = await page.evaluate((ms) => window.__danmakuP0Bench.sample(ms), sampleMs);
        const after = await readMetrics();
        if (paceHz > 0) await page.evaluate((id) => document.getElementById(id)?.remove(), paceId);
        // CDP 累计耗时单位是秒；分母必须是真实 Timestamp 差，不能除以请求的 sample 时长。
        const elapsedSeconds = after.Timestamp - before.Timestamp;
        if (!(elapsedSeconds > 0)) throw new Error("CDP Timestamp 未提供有效区间");
        const msPerSecond = {};
        for (const [label, key] of Object.entries({ Script: "ScriptDuration", RecalcStyle: "RecalcStyleDuration", Layout: "LayoutDuration", Task: "TaskDuration" })) {
          msPerSecond[label] = Number.isFinite(before[key]) && Number.isFinite(after[key])
            ? (after[key] - before[key]) * 1000 / elapsedSeconds : null;
        }
        // 帧间隔中位数落在目标节奏的 1.1 倍内算满帧，2.05 倍内算降一档（如 120Hz → 60Hz）。
        const budget = paceHz > 0 ? 1000 / paceHz : null;
        const cadence = budget === null ? null
          : measurement.frameMs.median <= budget * 1.1 ? "full"
            : measurement.frameMs.median <= budget * 2.05 ? "half" : "lower";
        rows.push({ scene, cpu, warmupMs, paceHz, cadence, willChange, ...measurement, cdp: { elapsedSeconds, msPerSecond } });
        await page.evaluate(() => window.__danmakuP0Bench.dispose());
      }
    }
    return {
      url: page.url(), capturedAt: new Date().toISOString(),
      ...(await page.evaluate(() => ({ build: window.__danmakuP0Bench.build, environment: window.__danmakuP0Bench.environment }))),
      rows,
    };
  } finally {
    // 即使 prepare/sample/权限失败，也必须解除 CPU 节流并还原 store/storage。
    await page.evaluate((id) => document.getElementById(id)?.remove(), paceId).catch(() => {});
    try { await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 }); }
    finally {
      try { await page.evaluate(() => window.__danmakuP0Bench?.dispose()); }
      finally { await cdp.detach(); }
    }
  }
}
