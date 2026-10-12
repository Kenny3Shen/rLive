/**
 * 弹幕 P1 时间轴微基准的可复用主体。
 *
 * `remove(id)` 与 `setComments`/`appendComments` 的收益是时间轴操作的延迟尖峰，
 * 不是稳态 FPS（文档实测：6 万条下移除 20 条 63.3ms、12 万条下 setComments 75.2ms），
 * 所以不能用帧率场景代替。这里只驱动渲染器本身，用伪媒体元素提供媒体语义，
 * 不播放视频、不依赖主应用路由。
 *
 * 两个入口共用本模块，避免 A/B 与单版本路径的夹具逻辑分叉：
 * - `tests/danmaku-timeline-performance.browser.js`（dev server 源码，单版本）
 * - `tests/browser/danmaku-timeline-ab-build.ts`（单构建 A/B，双实现同页）
 */
import type { DanmakuComment } from "@/features/room/danmaku/danmakuTypes";
import type { DanmakuRenderer } from "@/features/room/danmaku/danmakuRenderer";

export type TimelineBenchConfig = {
  /** 时间轴规模上限；单次 `setComments` 的规模点不会超过它。 */
  scale: number;
  /** 每轮从时间轴移除的条数。 */
  removes: number;
  /** 分段加载轮数。 */
  segments: number;
  /** 每段新增条数。 */
  segmentSize: number;
  /** `remove` 的重复轮数，用于取中位数。 */
  repeat: number;
};

export type TimelineBenchRenderer = new (options: {
  container: HTMLElement;
  media: HTMLMediaElement;
  speed?: number;
  area?: number;
}) => DanmakuRenderer;

export const TIMELINE_BENCH_DEFAULTS: TimelineBenchConfig = {
  scale: 120_000,
  removes: 20,
  segments: 8,
  segmentSize: 6_000,
  repeat: 3,
};

function percentile(sorted: readonly number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] ?? 0;
}

function summarize(samples: readonly number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    count: sorted.length,
    medianMs: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    maxMs: sorted.at(-1) ?? 0,
    totalMs: sorted.reduce((sum, value) => sum + value, 0),
  };
}

/** 构造一批互不相同的弹幕定义；id 前缀隔离批次，避免被 `appendComments` 去重。 */
function makeComments(prefix: string, size: number, atSeconds = 0): DanmakuComment[] {
  return Array.from({ length: size }, (_, index) => ({
    id: `${prefix}-${index}`,
    mode: index % 17 === 0 ? "top" : "scroll",
    time: atSeconds + index * 0.01,
    duration: index % 17 === 0 ? 15_000 : undefined,
    text: `时间轴基准 ${prefix} ${index}`,
  }));
}

export async function runTimelineBench(
  Renderer: TimelineBenchRenderer,
  overrides: Partial<TimelineBenchConfig> = {},
): Promise<Record<string, unknown>> {
  const config = { ...TIMELINE_BENCH_DEFAULTS, ...overrides };
  for (const [key, value] of Object.entries(config)) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${key} 必须是正数`);
  }

  const stage = document.createElement("div");
  stage.style.cssText =
    "position:fixed;left:0;top:0;width:1280px;height:720px;z-index:2147483000;pointer-events:none;background:#000";
  document.body.append(stage);
  // 伪媒体：渲染器只读 `currentTime` / `paused` / `playbackRate` 与几个事件。
  const media = document.createElement("video");
  let clockTime = 0;
  Object.defineProperties(media, {
    currentTime: { configurable: true, get: () => clockTime },
    paused: { configurable: true, get: () => false },
    playbackRate: { configurable: true, get: () => 1 },
  });
  const step = async (seconds: number) => {
    const target = clockTime + seconds;
    while (clockTime < target) {
      clockTime = Math.min(target, clockTime + 0.25);
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  };
  /** 只测同步主线程耗时：不 await 帧，避免把渲染节奏算进被测操作。 */
  const timed = (run: () => void) => {
    const start = performance.now();
    run();
    return performance.now() - start;
  };
  const mount = () => {
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;left:0;top:0;width:1280px;height:720px;pointer-events:none";
    document.body.append(host);
    return host;
  };
  const results: Record<string, unknown> = {};
  let renderer: DanmakuRenderer | null = null;
  try {
    renderer = new Renderer({ container: stage, media, speed: 100 });
    // 基线没有 `appendComments`，用它区分两个实现，也决定分段场景的可选路径。
    const appendComments = (
      renderer as DanmakuRenderer & {
        appendComments?: (comments: readonly DanmakuComment[]) => void;
      }
    ).appendComments;
    results.supportsAppendComments = typeof appendComments === "function";
    results.environment = {
      scale: config.scale,
      removes: config.removes,
      segments: config.segments,
      segmentSize: config.segmentSize,
      stage: { width: stage.offsetWidth, height: stage.offsetHeight },
      userAgent: navigator.userAgent,
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemory: (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? null,
    };
    media.dispatchEvent(new Event("playing"));

    // 1) 单次 setComments 随时间轴规模的增长。这是 P1 的基线形态：每次调用都重建全部分组。
    //    每个规模点用一个新渲染器，并取 best-of-2：复用同一实例会把上一点的巨型数组留给
    //    下一次调用，在低内存设备上表现为纯 GC 噪声（实测 Android 模拟器上同一规模点会在
    //    44～200ms 之间跳动，甚至出现 30k 慢于 60k）；而“单次 setComments 耗时”本就不应
    //    包含上一条时间轴的回收成本。
    const setPoints: { size: number; ms: number }[] = [];
    for (const size of [10_000, 30_000, 60_000, 120_000].filter((value) => value <= config.scale)) {
      const batch = makeComments(`set-${size}`, size);
      let best = Number.POSITIVE_INFINITY;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const host = mount();
        const instance = new Renderer({ container: host, media, speed: 100 });
        try {
          best = Math.min(best, timed(() => instance.setComments(batch)));
        } finally {
          instance.destroy();
          host.remove();
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      setPoints.push({ size, ms: best });
    }
    results.setCommentsBySize = setPoints;
    results.setComments = summarize(setPoints.map((point) => point.ms));

    // 2) 分段加载累计：每次 +segmentSize。基线只能整体替换；当前版走增量追加。
    //    两个模式各用新实例，避免时间轴互相污染；同样取 best-of-2 来过滤 GC 噪声。
    const runSegments = async (mode: "set" | "append") => {
      let best: { samples: { segment: number; total: number; ms: number }[]; totalMs: number; lastMs: number } | null =
        null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const host = mount();
        const instance = new Renderer({ container: host, media, speed: 100 });
        const push = (instance as DanmakuRenderer & {
          appendComments?: (comments: readonly DanmakuComment[]) => void;
        }).appendComments;
        const pushed: DanmakuComment[] = [];
        const samples: { segment: number; total: number; ms: number }[] = [];
        try {
          for (let index = 0; index < config.segments; index += 1) {
            pushed.push(...makeComments(`seg-${index}`, config.segmentSize, index * 60));
            const snapshot = pushed.slice();
            const elapsed = timed(() => {
              if (mode === "append" && push) push.call(instance, snapshot);
              else instance.setComments(snapshot);
            });
            samples.push({ segment: index + 1, total: pushed.length, ms: elapsed });
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
        } finally {
          instance.destroy();
          host.remove();
        }
        const totalMs = samples.reduce((sum, item) => sum + item.ms, 0);
        const candidate = { samples, totalMs, lastMs: samples.at(-1)?.ms ?? 0 };
        if (!best || totalMs < best.totalMs) best = candidate;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      return best!;
    };
    results.segmentsSetComments = await runSegments("set");
    results.segmentsAppendComments = await runSegments("append");

    // 2b) 文档口径的 P1 目标：时间轴已到 12 万条时，再加载一段新分段要多久。
    //     基线只有整体替换，所以它的等价操作是重算 12.6 万条；当前版是增量追加 6000 条。
    //     这是两个实现在同一规模点的真实差异，而不是把不同夹具的数字相减。
    const atScale = Math.min(config.scale, 120_000);
    const baseSegment = makeComments("tail-base", atScale, 0);
    const extraSegment = makeComments("tail-extra", config.segmentSize, atScale * 0.01);
    const tail: Record<string, { ms: number; total: number; mode: string }> = {};
    for (const mode of ["set", "append"] as const) {
      const host = mount();
      const instance = new Renderer({ container: host, media, speed: 100 });
      const push = (instance as DanmakuRenderer & {
        appendComments?: (comments: readonly DanmakuComment[]) => void;
      }).appendComments;
      try {
        if (mode === "append" && !push) continue;
        instance.setComments(baseSegment);
        const elapsed = timed(() => {
          if (mode === "append" && push) push.call(instance, extraSegment);
          else instance.setComments([...baseSegment, ...extraSegment]);
        });
        tail[mode] = { ms: elapsed, total: atScale + config.segmentSize, mode: mode === "append" ? "appendComments" : "setComments" };
      } finally {
        instance.destroy();
        host.remove();
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    results.appendAtScale = tail;

    // 3) remove(id) 在已装满的时间轴上移除若干条。文档口径是「6 万条上移除 20 条」。
    //    remove 之后紧接着 setComments 下一条：先让本轮样本落定再计下一条。
    const removeSamples: number[] = [];
    for (let round = 0; round < config.repeat; round += 1) {
      const size = Math.min(config.scale, 60_000);
      const batch = makeComments(`rm-${round}`, size);
      const host = mount();
      const instance = new Renderer({ container: host, media, speed: 100 });
      try {
        instance.setComments(batch);
        // 移除时间轴中段的条目：最坏情况下 `splice` 需要移动后半段。
        const targets = Array.from(
          { length: Math.min(config.removes, size) },
          (_, index) => batch[Math.floor(size / 2) + index * 3].id,
        );
        removeSamples.push(
          timed(() => {
            for (const id of targets) instance.remove(id);
          }),
        );
      } finally {
        instance.destroy();
        host.remove();
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    results.removeAt60k = { perRound: config.removes, ...summarize(removeSamples) };

    // 3b) 压实成本：墓碑方案把 O(时间轴) 的代价从每次 remove 移到阈值触发的压实。
    //     这里连续移除到刚好触发压实，单独量出那次尖峰；若它仍接近基线，
    //     方案只是把尖峰推后而不是消除。
    const compactStage = mount();
    const compactRenderer = new Renderer({ container: compactStage, media, speed: 100 });
    try {
      const size = Math.min(config.scale, 60_000);
      const batch = makeComments("compact", size);
      compactRenderer.setComments(batch);
      // 逐条移除并计时，找出单次最慢的一步：压实应当在这里出现一次尖峰。
      const steps: number[] = [];
      const targets = batch.filter((_, index) => index % 2 === 0).slice(0, 4_000);
      for (const comment of targets) {
        steps.push(timed(() => compactRenderer.remove(comment.id)));
      }
      const slowest = steps.indexOf(Math.max(...steps));
      results.compactAt60k = {
        removals: targets.length,
        ...summarize(steps),
        slowestStep: slowest + 1,
        // 基线没有墓碑，单步应当均匀；当前版预期在阈值处出现一次高值。
        top5: [...steps].sort((a, b) => b - a).slice(0, 5),
      };
    } finally {
      compactRenderer.destroy();
      compactStage.remove();
    }

    // 4) 正确性对照：增量追加后，过去的不补投、未来的仍会按时间投放。
    //    基线没有 `appendComments`，该对照只能验证当前实现；基线的等价值是 `setComments` 全量替换。
    const probeHost = mount();
    const probe = new Renderer({ container: probeHost, media, speed: 100 });
    const probeAppend = (probe as DanmakuRenderer & {
      appendComments?: (comments: readonly DanmakuComment[]) => void;
    }).appendComments;
    try {
      clockTime = 100;
      const past = makeComments("past", 40, 10);
      const future = makeComments("future", 40, 105);
      if (probeAppend) {
        probeAppend.call(probe, past);
        probeAppend.call(probe, future);
      } else {
        probe.setComments([...past, ...future]);
      }
      media.dispatchEvent(new Event("seeking"));
      media.dispatchEvent(new Event("playing"));
      await step(0.5);
      const attached = [...probeHost.querySelectorAll("[data-rlive-danmaku-id]")].map((el) =>
        el.getAttribute("data-rlive-danmaku-id") ?? "",
      );
      // 追加后若把游标留在 0，原生会把 40 条早已过去的弹幕一次性补投，并把未来的游标推错。
      results.cursorIntegrity = {
        pastAttached: attached.filter((id) => id.startsWith("past-")).length,
        futureAttached: attached.filter((id) => id.startsWith("future-")).length,
      };
    } finally {
      probe.destroy();
      probeHost.remove();
    }

    results.environment = {
      scale: config.scale,
      removes: config.removes,
      segments: config.segments,
      segmentSize: config.segmentSize,
      stage: { width: stage.offsetWidth, height: stage.offsetHeight },
      userAgent: navigator.userAgent,
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemory: (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? null,
    };
    return results;
  } finally {
    renderer?.destroy();
    stage.remove();
  }
}
