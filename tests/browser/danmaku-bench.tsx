import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { emit } from "@tauri-apps/api/event";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { DanmakuPanel } from "@/features/room/DanmakuPanel";
import { LiveDanmaku } from "@/features/room/danmaku/LiveDanmaku";
import { DanmakuPanel as BaselinePanel } from "@danmaku-bench-baseline/DanmakuPanel.tsx";
import { LiveDanmaku as BaselineLayer } from "@danmaku-bench-baseline/danmaku/LiveDanmaku.tsx";
import { loadDanmakuRenderer } from "@/features/room/danmaku/danmakuLoader";
import { clearExpectedDanmakuConnectionEpoch, setExpectedDanmakuConnectionEpoch, subscribeDanmakuBatches } from "@/features/room/danmaku/eventBus";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import type { DanmakuEvent } from "@/shared/types/live";
import "./danmaku-bench.css";

declare const __DANMAKU_BENCH_BUILD__: Record<string, unknown>;
type Options = {
  variant: "baseline" | "current";
  mode: "panel" | "layer" | "both" | "idle";
  rate: number;
  width: number;
  height: number;
  panelWidth: number;
  panelHeight: number;
  scrolledUp: boolean;
  /** 仅测试：冻结现有及后续弹幕的 WAAPI，原生轨道、到期与事件摄入保持运行。 */
  motion: "running" | "paused";
  /**
   * P2 合成层策略。动画包装节点（`[data-rlive-danmaku-id]` 的父节点）内联带
   * `will-change:transform`，这里用 `!important` 样式表覆盖它，从而在不改生产代码的
   * 前提下对照不同策略。用 `:has()` 而不是逐个改元素：采样期间会持续新建节点，
   * 一次性改 DOM 只能覆盖当时已存在的那些。
   * - `node`：保持现状，每条弹幕一个合成层。
   * - `none`：包装节点与组都不提升。
   * - `group`：把提升移到组容器，包装节点不提升。
   */
  willChange: "node" | "none" | "group";
};
type Renderer = InstanceType<Awaited<ReturnType<typeof loadDanmakuRenderer>>>;
const globals = window as typeof window & { __TAURI_INTERNALS__?: { invoke?: unknown }; isTauri?: boolean; __danmakuP0Bench?: unknown };
const nativeIPC = Boolean(globals.__TAURI_INTERNALS__?.invoke);
const host = document.getElementById("root")!;
const status = document.getElementById("bench-status")!;
const frames = async () => { await frame(); await frame(); };
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
const until = async (test: () => boolean, message: string, timeout = 10000) => {
  const deadline = performance.now() + timeout;
  while (!test()) { if (performance.now() > deadline) throw new Error(message); await sleep(25); }
};
const defaults: Options = { variant: "current", mode: "panel", rate: 150, width: 1920, height: 1080, panelWidth: 340, panelHeight: 480, scrolledUp: false, motion: "running", willChange: "node" };
const epoch = 710023;
let options: Options | null = null;
let root: Root | null = null;
let client: QueryClient | null = null;
let timer: number | null = null;
let unsubscribe: (() => void) | null = null;
let restoreSettings: (() => void) | null = null;
let restoreEmit: (() => void) | null = null;
let restoreAnimate: (() => void) | null = null;
let restoreWillChange: (() => void) | null = null;
let serial = 0;
let sent = 0;
let received = 0;
let batches = 0;
let injectionError: string | null = null;
let runStartedAt: number | null = null;
let prefilled = 0;
let sampling = false;
let disposedGeneration = 0;
let lastSample: unknown = null;
const renderers = new Set<Renderer>();
const inFlight = new Set<Promise<void>>();
const phrases = ["这波漂亮", "欢迎回来", "继续加油", "精彩瞬间", "大家晚上好", "节奏不错", "收到啦", "一起看直播"];
const panel = () => host.querySelector<HTMLElement>("[data-bench-panel]");
const viewport = () => panel()?.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]');
const rowSelector = 'button[aria-label^="选择 "]';
const panelCount = () => {
  const list = panel()?.querySelector<HTMLElement>('[data-slot="danmaku-list"]');
  return list ? Number(list.dataset.count) : (panel()?.querySelectorAll(rowSelector).length ?? 0);
};
const layerSize = () => [...renderers].reduce((total, renderer) => total + renderer.size, 0);

function metrics() {
  const list = panel()?.querySelector<HTMLElement>('[data-slot="danmaku-list"]');
  const view = viewport();
  // 采样时必须确认覆盖真的生效：内联样式不可被普通声明覆盖，一旦样式表没命中，
  // 所有策略都会退化成同一个 `node`，对照会得到“看起来合理但完全无效”的结论。
  // 动画包装节点是 `[data-rlive-danmaku-id]` 的父节点，它才是带 will-change 的那个。
  const probe = host.querySelector<HTMLElement>("[data-rlive-danmaku-id]");
  const wrapper = probe?.parentElement ?? null;
  const group = host.querySelector<HTMLElement>("[data-danmaku-group]");
  return {
    options, production: import.meta.env.PROD, reactVersion: React.version,
    transport: nativeIPC ? "native-event-plugin" : "mockIPC-events",
    running: timer !== null, sent, received, batches, prefilled, injectionError,
    layerOnScreen: layerSize(), rendererCount: renderers.size,
    layerDOM: host.querySelectorAll("[data-rlive-danmaku-id]").length,
    effectiveWillChange: probe ? {
      wrapper: wrapper ? getComputedStyle(wrapper).willChange : null,
      group: group ? getComputedStyle(group).willChange : null,
      // 原生引擎自己给中间层写了 `translateZ(0)`，它也会提升图层。
      // 记下来，避免把“去掉 will-change”误读成“完全没有合成层”。
      nativeStageTransform: wrapper?.parentElement ? getComputedStyle(wrapper.parentElement).transform : null,
    } : null,
    panelDOMRows: panel()?.querySelectorAll(rowSelector).length ?? 0,
    panelDataCount: list ? Number(list.dataset.count) : null,
    panelCount: panelCount(), panelUnpinned: Boolean(panel()?.querySelector('[aria-label="滚动到底部"]')),
    panelScrollTop: view?.scrollTop ?? null,
    panelDistanceToBottom: view ? view.scrollHeight - view.clientHeight - view.scrollTop : null,
    layerRect: rect(host.querySelector("[data-bench-layer]")), panelRect: rect(panel()),
    elapsedMs: runStartedAt === null ? 0 : performance.now() - runStartedAt,
    visibility: document.visibilityState,
  };
}
function rect(element: Element | null) {
  if (!element) return null;
  const { width, height } = element.getBoundingClientRect();
  return { width, height };
}
function inject(amount: number) {
  const events: DanmakuEvent[] = Array.from({ length: amount }, () => {
    const id = ++serial;
    return { kind: "chat", user: `观众${id % 16}`, content: `${phrases[id % phrases.length]} ${String(id).padStart(7, "0")}`, color: null, ts: Date.now() };
  });
  sent += amount;
  batches += 1;
  const promise = emit("danmaku-batch", { connection_epoch: epoch, events });
  inFlight.add(promise);
  void promise.then(() => inFlight.delete(promise), (error) => {
    inFlight.delete(promise);
    injectionError = String(error);
    stop();
  });
  return promise;
}

function stop() {
  if (timer !== null) window.clearInterval(timer);
  timer = null;
}
async function dispose() {
  stop();
  disposedGeneration += 1;
  try {
    await Promise.allSettled(inFlight);
    if (root) { flushSync(() => root!.unmount()); root = null; }
    unsubscribe?.();
    unsubscribe = null;
    client?.clear();
    client = null;
    clearExpectedDanmakuConnectionEpoch(epoch);
    restoreEmit?.();
    restoreEmit = null;
    restoreAnimate?.();
    restoreAnimate = null;
    restoreWillChange?.();
    restoreWillChange = null;
    renderers.clear();
    // 原生 unlisten 是异步的；下一轮切换前留出清理微任务的机会。
    await sleep(100);
  } finally {
    restoreSettings?.();
    restoreSettings = null;
    if (!nativeIPC) clearMocks();
    options = null;
    status.textContent = "React production · 已释放夹具";
  }
}

async function prepare(input: Partial<Options> = {}) {
  assert(!sampling, "采样中不能切换场景");
  await dispose();
  const next = { ...defaults, ...input };
  assert(import.meta.env.PROD, "必须使用独立 production build，禁止用 Vite dev 采性能");
  assert(["baseline", "current"].includes(next.variant), "未知 variant");
  assert(["running", "paused"].includes(next.motion), "未知 motion");
  assert(["node", "none", "group"].includes(next.willChange), "未知 willChange 策略");
  assert(["panel", "layer", "both", "idle"].includes(next.mode), "未知 mode");
  assert(Number.isFinite(next.rate) && next.rate >= 0 && next.rate <= 10000, "rate 必须为 0..10000");
  for (const key of ["width", "height", "panelWidth", "panelHeight"] as const) assert(Number.isFinite(next[key]) && next[key] > 0, `${key} 必须为正数`);
  assert(!document.hidden, "夹具必须处于前台");
  if (next.mode === "layer" || next.mode === "both") assert(!matchMedia("(prefers-reduced-motion: reduce)").matches, "系统减少动态效果会关闭真实弹幕层；请先关闭该设置");
  options = next;
  serial = sent = received = batches = prefilled = 0;
  injectionError = null;
  runStartedAt = null;
  lastSample = null;
  try {
    // 只替换 persist 的 storage，不触发 setter/backend，不写回用户 localStorage。
    const originalState = useSettingsStore.getState();
    const originalStorage = useSettingsStore.persist.getOptions().storage;
    useSettingsStore.persist.setOptions({ storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } });
    restoreSettings = () => {
      try { useSettingsStore.setState(originalState, true); }
      finally { useSettingsStore.persist.setOptions({ storage: originalStorage }); }
    };
    useSettingsStore.setState({ danmakuFontSize: 12, danmakuArea: 1, danmakuMergeWindowSeconds: 0, danmakuSpeed: 100, danmakuFontStroke: 0, danmakuOpacity: 0.8, danmakuShieldWords: [], danmakuBlockedUsers: [], danmakuFilterGifts: false });
    if (!nativeIPC) mockIPC((command) => { throw new Error(`禁止非事件 IPC：${command}`); }, { shouldMockEvents: true });
    if (next.motion === "paused") {
      const original = Element.prototype.animate;
      const wrapped: typeof original = function (keyframes, animationOptions) {
        const motion = original.call(this, keyframes, animationOptions);
        if (this.parentElement?.closest("[data-danmaku-group]")) motion.pause();
        return motion;
      };
      Element.prototype.animate = wrapped;
      restoreAnimate = () => { if (Element.prototype.animate === wrapped) Element.prototype.animate = original; };
    }
    // P2：节点内联样式固定带 `will-change:transform`，普通声明无法覆盖它，
    // 必须用 `!important` 样式表。组容器不带内联 will-change，所以可以直接声明。
    if (next.willChange !== "node") {
      const style = document.createElement("style");
      style.id = "danmaku-bench-will-change";
      style.textContent = next.willChange === "none"
        ? "div:has(> [data-rlive-danmaku-id]){will-change:auto !important}"
        : "div:has(> [data-rlive-danmaku-id]){will-change:auto !important}[data-danmaku-group]{will-change:transform !important}";
      document.head.append(style);
      restoreWillChange = () => style.remove();
    }
    const RendererConstructor = await loadDanmakuRenderer();
    const originalEmit = RendererConstructor.prototype.emit;
    // 只在第一次 emit 捕获实例并立刻卸下包装；采样热路径不做 Set.add 或 DOM 查询。
    const capture: typeof originalEmit = function (this: Renderer, definition) {
      renderers.add(this);
      RendererConstructor.prototype.emit = originalEmit;
      return originalEmit.call(this, definition);
    };
    RendererConstructor.prototype.emit = capture;
    restoreEmit = () => { if (RendererConstructor.prototype.emit === capture) RendererConstructor.prototype.emit = originalEmit; };
    setExpectedDanmakuConnectionEpoch(epoch);
    unsubscribe = subscribeDanmakuBatches((events) => { received += events.length; });
    client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
    const Panel = next.variant === "baseline" ? BaselinePanel : DanmakuPanel;
    const Layer = next.variant === "baseline" ? BaselineLayer : LiveDanmaku;
    root = createRoot(host);
    // 无 roomId，不启用发送状态查询；没有播放组件，所有内容都是实际被测组件。
    flushSync(() => root!.render(
      <QueryClientProvider client={client!}>
        {(next.mode === "layer" || next.mode === "both") && <div data-bench-layer style={{ width: next.width, height: next.height }}><Layer active sessionKey={epoch} siteId="bilibili" /></div>}
        {(next.mode === "panel" || next.mode === "both") && <div data-bench-panel style={{ width: next.panelWidth, height: next.panelHeight, top: next.mode === "both" ? next.height : 0 }}><Panel active visible siteId="bilibili" /></div>}
      </QueryClientProvider>,
    ));
    // 屏蔽所有真实交互；脚本只滚动 viewport，绝不点菜单/操作按钮。
    host.inert = true;
    await frames();
    await sleep(100);
    await document.fonts.ready;
    // readiness 通过真实共享 bus 回执确认，不依赖 native IPC 对象可修改。
    await inject(1);
    await until(() => received === 1, "eventBus 未收到探针：请检查同源 Tauri 事件权限/原生插件");
    if (next.mode === "layer" || next.mode === "both") await until(() => renderers.size === 1 && layerSize() > 0, "真实悬浮渲染器未就绪");
    // 确认 P2 覆盖已生效，且真的改变了包装节点的计算值（否则本轮对照无效）。
    if (next.mode === "layer" || next.mode === "both") {
      await until(() => Boolean(host.querySelector("[data-rlive-danmaku-id]")), "节点未上屏，无法核对 will-change 覆盖");
      const effective = metrics().effectiveWillChange!;
      const wantWrapper = next.willChange === "node" ? "transform" : "auto";
      assert(effective.wrapper === wantWrapper, `will-change 覆盖未生效：包装节点计算值为 ${effective.wrapper}，期望 ${wantWrapper}`);
      if (next.willChange === "group") assert(effective.group === "transform", `组容器未提升：${effective.group}`);
    }
    if (next.mode === "panel" || next.mode === "both") {
      await until(() => panelCount() === 1, "真实面板未收到首条消息");
      const fillTo = async (target: number) => {
        while (panelCount() < target) {
          const before = panelCount();
          const count = Math.min(32, target - before);
          await inject(count);
          await until(() => panelCount() === before + count, `预填窗口未提交 ${before + count} 条`);
          await frames();
        }
      };
      // --baseline 可选已虚拟化的提交；按实际列表能力而非变体名字确定预填容量，
      // 否则同容量 A/B 会变成「基线仍增长、当前已裁剪」的不同负载。
      const virtualized = panel()?.querySelector('[data-slot="danmaku-list"]')?.hasAttribute("data-count");
      await fillTo(virtualized ? 1200 : 300);
      if (next.scrolledUp) {
        const view = viewport()!;
        view.scrollTop = Math.max(0, (view.scrollHeight - view.clientHeight) / 2);
        view.dispatchEvent(new Event("scroll"));
        await until(() => Boolean(panel()?.querySelector('[aria-label="滚动到底部"]')), "上滚后未解除钉底");
        // 原版钉底只有 300；必须上滚后继续小批灌到 1200，不能一次压爆 pending 队列。
        await fillTo(1200);
        // 两版都从满窗口的中点开始读，避免旧版在 300 条时的锚点偏向窗口顶部。
        view.scrollTop = Math.max(0, (view.scrollHeight - view.clientHeight) / 2);
        view.dispatchEvent(new Event("scroll"));
        await frames();
        assert(Boolean(panel()?.querySelector('[aria-label="滚动到底部"]')), "满窗口上滚状态丢失");
      }
      prefilled = panelCount();
    }
    status.textContent = `React production · ${next.variant} · ${next.mode} · ${next.rate}/s · ${nativeIPC ? "原生 IPC" : "mockIPC"}`;
    return metrics();
  } catch (error) {
    await dispose();
    throw error;
  }
}

async function start(input?: Partial<Options>) {
  if (input || !options) await prepare(input);
  assert(options, "未准备场景");
  assert(!sampling, "采样中不能重启注入");
  stop();
  let accumulator = 0;
  runStartedAt = performance.now();
  // 不追赶被阻塞的 tick：实际 rate 由 sent/received 和真实采样时长报告。
  timer = window.setInterval(() => {
    accumulator += options!.rate / 20;
    const amount = Math.floor(accumulator);
    accumulator -= amount;
    if (amount > 0) void inject(amount).catch(() => {});
  }, 50);
  return metrics();
}

async function sample(ms = 9000) {
  assert(options && !sampling, "先 start，且不能并发 sample");
  assert(Number.isFinite(ms) && ms >= 1000, "sample 时长至少 1000ms；正式测量建议 8–10s");
  assert(!document.hidden, "采样页面不在前台");
  sampling = true;
  const generation = disposedGeneration;
  const before = metrics();
  const intervals: number[] = [];
  const density: number[] = [layerSize()];
  const tasks: PerformanceEntry[] = [];
  const supportsLongtasks = PerformanceObserver.supportedEntryTypes.includes("longtask");
  const observer = supportsLongtasks ? new PerformanceObserver((list) => tasks.push(...list.getEntries())) : null;
  const densityTimer = window.setInterval(() => density.push(layerSize()), 1000);
  // 只计数，不在 scroll 热路径读取几何，避免探针本身制造同步布局。
  const panelViewport = viewport();
  let panelScrollEvents = 0;
  const onPanelScroll = () => { panelScrollEvents++; };
  panelViewport?.addEventListener("scroll", onPanelScroll, { passive: true });
  let hidden = false;
  const onVisibility = () => { if (document.hidden) hidden = true; };
  document.addEventListener("visibilitychange", onVisibility);
  const startAt = performance.now();
  let endAt = startAt;
  observer?.observe({ type: "longtask", buffered: false });
  try {
    await new Promise<void>((resolve, reject) => {
      let id = 0;
      let previous = startAt;
      const timeout = window.setTimeout(() => { cancelAnimationFrame(id); reject(new Error("rAF 采样超时，页面可能被挂起")); }, ms * 2 + 10000);
      const tick = () => {
        if (generation !== disposedGeneration) { clearTimeout(timeout); reject(new Error("采样期间已 dispose")); return; }
        const now = performance.now();
        intervals.push(now - previous);
        previous = now;
        if (now - startAt >= ms) { endAt = now; clearTimeout(timeout); resolve(); }
        else id = requestAnimationFrame(tick);
      };
      id = requestAnimationFrame(tick);
    });
    tasks.push(...(observer?.takeRecords() ?? []));
    const after = metrics();
    const durationMs = endAt - startAt;
    const sorted = [...intervals].sort((a, b) => a - b);
    const percentile = (p: number) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] ?? 0;
    const longtasks = tasks.filter((task) => task.startTime >= startAt && task.startTime < endAt);
    density.push(after.layerOnScreen);
    lastSample = {
      options: { ...options! }, requestedMs: ms, durationMs, frames: intervals.length,
      fps: intervals.length * 1000 / durationMs,
      frameMs: { median: percentile(0.5), p95: percentile(0.95), max: sorted.at(-1) ?? 0 },
      jankOver25ms: intervals.filter((value) => value > 25).length,
      jankRatio: intervals.filter((value) => value > 25).length / intervals.length,
      longtasks: { supported: supportsLongtasks, count: longtasks.length, maxMs: Math.max(0, ...longtasks.map((task) => task.duration)), totalMs: longtasks.reduce((sum, task) => sum + task.duration, 0) },
      panelScrollEvents,
      events: { sent: after.sent - before.sent, received: after.received - before.received, batches: after.batches - before.batches, actualRate: (after.received - before.received) * 1000 / durationMs },
      layerOnScreen: { min: Math.min(...density), mean: density.reduce((a, b) => a + b, 0) / density.length, max: Math.max(...density), samples: density },
      valid: !hidden && !injectionError && (options!.rate === 0 || after.received > before.received),
      before, after,
    };
    return lastSample;
  } finally {
    observer?.disconnect();
    clearInterval(densityTimer);
    panelViewport?.removeEventListener("scroll", onPanelScroll);
    document.removeEventListener("visibilitychange", onVisibility);
    sampling = false;
  }
}

const api = {
  prepare, start, sample, stop, dispose, metrics,
  get lastSample() { return lastSample; },
  production: import.meta.env.PROD,
  build: __DANMAKU_BENCH_BUILD__,
  environment: {
    userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? null,
    devicePixelRatio, viewport: { width: innerWidth, height: innerHeight },
    nativeIPC, reactVersion: React.version, production: import.meta.env.PROD,
  },
};
globals.__danmakuP0Bench = api;
status.dataset.production = String(import.meta.env.PROD);
status.textContent = `React ${React.version} · ${import.meta.env.PROD ? "production" : "非生产：禁止采样"} · 等待 start()`;
window.addEventListener("pagehide", () => { stop(); restoreEmit?.(); restoreAnimate?.(); restoreWillChange?.(); restoreWillChange = null; restoreSettings?.(); restoreSettings = null; });
