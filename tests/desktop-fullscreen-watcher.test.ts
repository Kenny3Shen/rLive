// P-04：桌面窗口全屏监听的迟到清理。
//
// 验收要求用 deferred Promise 分别卡住初次 sync 和 onResized 注册，在它们完成前
// 卸载，再释放 Promise；unlisten 必须恰好一次，旧实例不得继续发窗口 IPC。
import { describe, expect, test } from "bun:test";

import {
  type DesktopFullscreenWindow,
  watchDesktopFullscreen,
} from "../src/features/room/player/desktopFullscreenWatcher";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** 让所有已排队的微任务落地。 */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

type Harness = {
  window: DesktopFullscreenWindow & { maximizeCalls: number };
  /** 每次 isFullscreen 调用的 gate；未预置时立即返回 `fullscreen` 默认值。 */
  isFullscreenGates: Deferred<boolean>[];
  onResizedGate: Deferred<() => void> | null;
  /** 所有窗口侧 IPC 的调用顺序，用于断言卸载后不再有新 IPC。 */
  ipc: string[];
  unlistenCalls: number;
  resizeHandlers: (() => void)[];
  modes: ("fullscreen" | "windowed")[];
  restoreCalls: number;
  restoreGate: Deferred<void> | null;
};

function harness(defaults: { fullscreen: boolean }): Harness {
  const state: Harness = {
    window: null as never,
    isFullscreenGates: [],
    onResizedGate: null,
    ipc: [],
    unlistenCalls: 0,
    resizeHandlers: [],
    modes: [],
    restoreCalls: 0,
    restoreGate: null,
  };
  state.window = {
    maximizeCalls: 0,
    isFullscreen: () => {
      state.ipc.push("isFullscreen");
      const gate = state.isFullscreenGates.shift();
      return gate ? gate.promise : Promise.resolve(defaults.fullscreen);
    },
    onResized: (handler: () => void) => {
      state.ipc.push("onResized");
      state.resizeHandlers.push(handler);
      const unlisten = () => {
        state.unlistenCalls += 1;
      };
      if (state.onResizedGate) return state.onResizedGate.promise;
      return Promise.resolve(unlisten);
    },
  };
  return state;
}

function watch(state: Harness) {
  return watchDesktopFullscreen({
    getWindow: () => state.window,
    restoreMaximized: async () => {
      state.restoreCalls += 1;
      state.ipc.push("restoreMaximized");
      if (state.restoreGate) await state.restoreGate.promise;
    },
    setMode: (mode) => state.modes.push(mode),
  });
}

describe("桌面窗口全屏监听", () => {
  test("正常路径：同步后注册监听，resize 更新模式，卸载时回收一次", async () => {
    const state = harness({ fullscreen: true });
    const dispose = watch(state);
    await settle();

    expect(state.modes).toEqual(["fullscreen"]);
    expect(state.resizeHandlers).toHaveLength(1);

    state.isFullscreenGates.push({ ...deferred<boolean>(), promise: Promise.resolve(false) });
    state.resizeHandlers[0]();
    await settle();
    expect(state.modes).toEqual(["fullscreen", "windowed"]);
    expect(state.restoreCalls).toBe(1);

    dispose();
    expect(state.unlistenCalls).toBe(1);
    // 重复 dispose 不得重复回收。
    dispose();
    expect(state.unlistenCalls).toBe(1);
  });

  test("初次 sync 期间卸载：释放后不设模式，也不再注册监听", async () => {
    const state = harness({ fullscreen: true });
    const gate = deferred<boolean>();
    state.isFullscreenGates.push(gate);

    const dispose = watch(state);
    await settle();
    expect(state.ipc).toEqual(["isFullscreen"]);

    dispose();
    gate.resolve(true);
    await settle();

    expect(state.modes).toEqual([]);
    // 卸载后不得再发窗口 IPC：没有 onResized 注册。
    expect(state.ipc).toEqual(["isFullscreen"]);
    expect(state.resizeHandlers).toHaveLength(0);
    expect(state.unlistenCalls).toBe(0);
  });

  test("恢复最大化期间卸载：不设模式", async () => {
    const state = harness({ fullscreen: false });
    state.restoreGate = deferred<void>();

    const dispose = watch(state);
    await settle();
    expect(state.restoreCalls).toBe(1);

    dispose();
    state.restoreGate.resolve();
    await settle();

    expect(state.modes).toEqual([]);
    expect(state.ipc).toEqual(["isFullscreen", "restoreMaximized"]);
  });

  test("注册期间卸载：迟到的 unlisten 立即回收，恰好一次", async () => {
    const state = harness({ fullscreen: true });
    const gate = deferred<() => void>();
    state.onResizedGate = gate;

    const dispose = watch(state);
    await settle();
    expect(state.ipc).toEqual(["isFullscreen", "onResized"]);
    expect(state.unlistenCalls).toBe(0);

    dispose();
    expect(state.unlistenCalls).toBe(0);

    gate.resolve(() => {
      state.unlistenCalls += 1;
    });
    await settle();

    expect(state.unlistenCalls).toBe(1);
    expect(state.modes).toEqual(["fullscreen"]);
  });

  test("卸载后迟到的 resize 回调不再发窗口 IPC", async () => {
    const state = harness({ fullscreen: true });
    const dispose = watch(state);
    await settle();

    const baseline = [...state.ipc];
    dispose();
    state.resizeHandlers[0]();
    await settle();

    expect(state.ipc).toEqual(baseline);
    expect(state.modes).toEqual(["fullscreen"]);
  });

  test("反复进出房间：监听数量回到基线，不残留订阅", async () => {
    const state = harness({ fullscreen: true });
    let live = 0;
    const base = state.window.onResized;
    state.window.onResized = async (handler) => {
      const unlisten = await base(handler);
      live += 1;
      return () => {
        live -= 1;
        unlisten();
      };
    };

    for (let round = 0; round < 5; round += 1) {
      // 一半轮次把卸载卡在注册途中，另一半正常卸载。
      const slow = round % 2 === 0;
      if (slow) state.onResizedGate = deferred<() => void>();
      const dispose = watch(state);
      await settle();
      if (slow) {
        dispose();
        state.onResizedGate?.resolve(() => {
          live -= 1;
          state.unlistenCalls += 1;
        });
        state.onResizedGate = null;
        await settle();
        // 卡住的那一轮由迟到分支回收，live 不经过 +1，这里补齐计数口径。
        live += 1;
      } else {
        dispose();
      }
      await settle();
    }

    expect(live).toBe(0);
    expect(state.unlistenCalls).toBe(5);
  });
});
