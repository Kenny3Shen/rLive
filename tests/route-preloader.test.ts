import { describe, expect, test } from "bun:test";
import {
  ROUTE_PRELOAD_AFTER_LOAD_DELAY_MS,
  startIdleRoutePreloading,
} from "../src/app/RouteModulePreloader";
import type { LazyRouteModule, RouteModuleLoader } from "../src/app/routeModules";

const loadedModule: LazyRouteModule = { default: () => null };
const flushMicrotasks = async () => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

function preloadEnvironment({ idle = true, hidden = false, complete = true } = {}) {
  let nextId = 0;
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const idleCallbacks = new Map<number, () => void>();
  const windowEvents = new EventTarget();
  const documentRef = Object.assign(new EventTarget(), {
    hidden,
    readyState: (complete ? "complete" : "loading") as DocumentReadyState,
  });
  const windowRef: NonNullable<Parameters<typeof startIdleRoutePreloading>[1]> = {
    addEventListener: windowEvents.addEventListener.bind(windowEvents),
    removeEventListener: windowEvents.removeEventListener.bind(windowEvents),
    setTimeout(handler, delay = 0) {
      if (typeof handler !== "function") throw new Error("预加载只应注册函数定时器");
      const id = ++nextId;
      timers.set(id, { callback: () => handler(), delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id!);
    },
    ...(idle
      ? {
          requestIdleCallback(callback: () => void) {
            const id = ++nextId;
            idleCallbacks.set(id, callback);
            return id;
          },
          cancelIdleCallback(id: number) {
            idleCallbacks.delete(id);
          },
        }
      : {}),
  };

  return {
    timers,
    idleCallbacks,
    start(loaders: readonly RouteModuleLoader[]) {
      return startIdleRoutePreloading(loaders, windowRef, documentRef);
    },
    finishLoad() {
      documentRef.readyState = "complete";
      windowEvents.dispatchEvent(new Event("load"));
    },
    setHidden(value: boolean) {
      documentRef.hidden = value;
      documentRef.dispatchEvent(new Event("visibilitychange"));
    },
    runTimer() {
      const entry = timers.entries().next().value;
      if (!entry) throw new Error("没有待执行的预加载定时器");
      timers.delete(entry[0]);
      entry[1].callback();
    },
    runIdle() {
      const entry = idleCallbacks.entries().next().value;
      if (!entry) throw new Error("没有待执行的空闲回调");
      idleCallbacks.delete(entry[0]);
      entry[1]();
    },
  };
}

describe("路由空闲预加载生命周期", () => {
  test("首屏加载完成并经过延迟后才在空闲时加载模块", async () => {
    const env = preloadEnvironment({ complete: false });
    let calls = 0;
    const stop = env.start([async () => { calls += 1; return loadedModule; }]);
    expect(env.timers.size).toBe(0);
    env.finishLoad();
    expect([...env.timers.values()].map((timer) => timer.delay)).toEqual([
      ROUTE_PRELOAD_AFTER_LOAD_DELAY_MS,
    ]);
    env.runTimer();
    expect(calls).toBe(0);
    env.runIdle();
    await flushMicrotasks();
    expect(calls).toBe(1);
    expect(env.idleCallbacks.size).toBe(0);
    stop();
  });

  test("初始后台不排任务，前台延迟期间退后台会取消并重新等待", () => {
    const env = preloadEnvironment({ hidden: true });
    const stop = env.start([async () => loadedModule]);
    expect(env.timers.size).toBe(0);
    env.setHidden(false);
    expect(env.timers.size).toBe(1);
    env.setHidden(true);
    expect(env.timers.size).toBe(0);
    env.setHidden(false);
    expect([...env.timers.values()].map((timer) => timer.delay)).toEqual([
      ROUTE_PRELOAD_AFTER_LOAD_DELAY_MS,
    ]);
    stop();
    expect(env.timers.size).toBe(0);
  });

  test("后台取消空闲回调，恢复时不跳过尚未加载的模块", async () => {
    const env = preloadEnvironment();
    const calls: number[] = [];
    const stop = env.start([1, 2].map((id) => async () => {
      calls.push(id);
      return loadedModule;
    }));
    env.runTimer();
    env.setHidden(true);
    expect(env.idleCallbacks.size).toBe(0);
    env.setHidden(false);
    env.setHidden(false);
    expect(env.idleCallbacks.size).toBe(1);
    env.runIdle();
    await flushMicrotasks();
    env.runIdle();
    await flushMicrotasks();
    expect(calls).toEqual([1, 2]);
    stop();
  });

  test("在途 import 不因前后台切换而与下一个模块并发", async () => {
    const env = preloadEnvironment();
    let resolveFirst!: (value: LazyRouteModule) => void;
    let secondCalls = 0;
    const first = new Promise<LazyRouteModule>((resolve) => { resolveFirst = resolve; });
    const stop = env.start([
      () => first,
      async () => { secondCalls += 1; return loadedModule; },
    ]);
    env.runTimer();
    env.runIdle();
    await flushMicrotasks();
    env.setHidden(true);
    env.setHidden(false);
    expect(env.idleCallbacks.size).toBe(0);
    env.setHidden(true);
    resolveFirst(loadedModule);
    await flushMicrotasks();
    expect(env.idleCallbacks.size).toBe(0);
    expect(secondCalls).toBe(0);
    env.setHidden(false);
    env.runIdle();
    await flushMicrotasks();
    expect(secondCalls).toBe(1);
    stop();
  });

  test("没有空闲 API 时仍会取消后台的回退定时器", async () => {
    const env = preloadEnvironment({ idle: false });
    let calls = 0;
    const stop = env.start([async () => { calls += 1; return loadedModule; }]);
    env.runTimer();
    expect(env.timers.size).toBe(1);
    env.setHidden(true);
    expect(env.timers.size).toBe(0);
    env.setHidden(false);
    env.runTimer();
    await flushMicrotasks();
    expect(calls).toBe(1);
    stop();
  });

  test("失败后继续预加载，清理后异步完成和可见性事件都不再排任务", async () => {
    const env = preloadEnvironment();
    let resolveLast!: (value: LazyRouteModule) => void;
    const last = new Promise<LazyRouteModule>((resolve) => { resolveLast = resolve; });
    const stop = env.start([
      () => { throw new Error("模块加载失败"); },
      () => last,
      async () => loadedModule,
    ]);
    env.runTimer();
    env.runIdle();
    await flushMicrotasks();
    expect(env.idleCallbacks.size).toBe(1);
    env.runIdle();
    await flushMicrotasks();
    stop();
    resolveLast(loadedModule);
    await flushMicrotasks();
    env.setHidden(true);
    env.setHidden(false);
    env.finishLoad();
    expect(env.timers.size).toBe(0);
    expect(env.idleCallbacks.size).toBe(0);
  });
});
