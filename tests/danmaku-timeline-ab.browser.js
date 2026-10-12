// 弹幕 P1 时间轴单构建 A/B：把基线渲染器与当前渲染器编入同一页面，同一夹具内前后对照。
//
// P1 的两项收益是时间轴操作的延迟尖峰，不是稳态 FPS。用两个独立构建或两个环境比
// 数字没有意义（文档已记录过「不同夹具的数字不能相减」），所以这里把基线
// `danmakuRenderer.ts` 通过生成模块编进同一个 bundle，由本脚本显式选择实现。
//
// 构建：bun tests/browser/danmaku-timeline-ab-build.ts
// 预览：bun tests/browser/danmaku-timeline-ab-build.ts --preview --port=1437
// 运行：
//   playwright-cli -s=p1 open 'http://127.0.0.1:1437/'
//   playwright-cli -s=p1 --raw run-code --filename=tests/danmaku-timeline-ab.browser.js
//
// URL 参数：`?scale=120000&removes=20&segments=8&segmentSize=6000&repeat=3&order=baseline,current`
// 顺序可反转（`order=current,baseline`）以复核热机与顺序影响。
// oxlint-disable-next-line no-unused-expressions -- playwright-cli 读取并执行函数表达式。
async (page) => {
  await page.waitForFunction(() => Boolean(window.__danmakuTimelineBenchRenderer), null, { timeout: 20000 });
  const query = await page.evaluate(() => Object.fromEntries(new URL(location.href).searchParams));
  const number = (name, fallback) => {
    const raw = query[name];
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} 必须是正数`);
    return value;
  };
  const config = {
    scale: number("scale", 120_000),
    removes: number("removes", 20),
    segments: number("segments", 8),
    segmentSize: number("segmentSize", 6_000),
    repeat: number("repeat", 3),
  };
  const order = (query.order || "baseline,current").split(",");
  for (const variant of order) {
    if (!["baseline", "current"].includes(variant)) throw new Error(`未知 variant：${variant}`);
  }
  const rows = [];
  for (const variant of order) {
    // 每轮重载页面再设 variant：渲染器每次 `run` 内部新建，但模块级状态与上一轮的
    // 大数组需要一次彻底的 GC 机会，否则后跑的版本会继承前面的内存压力。
    // variant 通过 sessionStorage 传（reload 会清掉页面内变量）。
    await page.evaluate((next) => {
      sessionStorage.setItem("__danmakuTimelineBenchVariant", next);
    }, variant);
    await page.reload({ waitUntil: "load" });
    await page.waitForFunction(() => Boolean(window.__danmakuTimelineBenchRenderer), null, { timeout: 20000 });
    // 核对页面真的加载了本轮要求的实现；resolveRenderer 在页面脚本里只跑一次，
    // 若选择链路失效，两个 variant 会给出同一份数字而不是报错。
    const loaded = await page.evaluate(() => window.__danmakuTimelineBenchVariant);
    if (loaded !== variant) throw new Error(`页面加载的实现是 ${loaded}，不是本轮要求的 ${variant}`);
    const result = await page.evaluate(async (input) => {
      // 复用单版本路径的同一夹具主体，避免两条路径的采样逻辑分叉。
      const { runTimelineBench } = await import("/danmaku-timeline-bench.js");
      return runTimelineBench(window.__danmakuTimelineBenchRenderer, input);
    }, config);
    rows.push({ variant, ...result });
  }
  const pick = (row, key) => {
    const value = row[key];
    if (!value || typeof value !== "object") return null;
    if (key === "setComments" || key === "removeAt60k") return value.totalMs ?? null;
    return value.totalMs ?? null;
  };
  // 计时精度下限：`performance.now()` 在多数环境亚毫秒，但 0 会让倍率变成 Infinity。
  // 用 0.05ms 做下限并标记，避免把“测不出来”写成“无限快”。
  const FLOOR_MS = 0.05;
  const summary = {};
  for (const key of [
    "setComments",
    "segmentsSetComments",
    "segmentsAppendComments",
    "removeAt60k",
    "compactAt60k",
  ]) {
    const baseline = rows.find((row) => row.variant === "baseline");
    const current = rows.find((row) => row.variant === "current");
    const before = baseline ? pick(baseline, key) : null;
    const after = current ? pick(current, key) : null;
    const flored = after !== null && after < FLOOR_MS;
    summary[key] = {
      baseline: before,
      current: after,
      // 基线慢、当前快时倍率 > 1；任一缺失时为 null。
      speedup:
        before !== null && after !== null
          ? Number((before / Math.max(after, FLOOR_MS)).toFixed(2))
          : null,
      // 当前版低于计时精度时倍率只是下界，不能当成精确值引用。
      speedupIsLowerBound: flored,
    };
  }
  // 12 万条规模点上的「再加一段」：当前版是 appendComments 增量追加，基线没有增量 API，
  // 它的等价操作只能是重新 setComments 全量 12.6 万条（`appendAtScale.set`）。
  // 两个数字来自同一夹具、同一规模点，可以直接对照。
  const baselineRow = rows.find((row) => row.variant === "baseline");
  const currentRow = rows.find((row) => row.variant === "current");
  const tailBefore = baselineRow?.appendAtScale?.set?.ms ?? null;
  const tailAfter = currentRow?.appendAtScale?.append?.ms ?? null;
  summary.appendAtScale = {
    baseline: tailBefore,
    current: tailAfter,
    speedup:
      tailBefore !== null && tailAfter !== null
        ? Number((tailBefore / Math.max(tailAfter, FLOOR_MS)).toFixed(2))
        : null,
    speedupIsLowerBound: tailAfter !== null && tailAfter < FLOOR_MS,
  };
  return {
    url: page.url(),
    capturedAt: new Date().toISOString(),
    config,
    order,
    timingFloorMs: FLOOR_MS,
    build: await page.evaluate(() => window.__danmakuTimelineBenchBuild),
    summary,
    rows,
  };
}
