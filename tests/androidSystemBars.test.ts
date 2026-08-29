import { describe, expect, test } from "bun:test";
import {
  resetAndroidSystemBarsForTests,
  supportsAndroidSystemBars,
  syncAndroidSystemBars,
} from "../src/app/androidSystemBars";

type NativeCall = { command: string; args?: Record<string, unknown> };

/** 微任务链（invoke 的 resolve/reject 与 while 循环推进）在一个宏任务前全部排空。 */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** `.catch().then()` 链需要多个微任务 tick 才真正启动，逐 tick 让出。 */
const flushMicrotasks = async (ticks = 4) => {
  for (let i = 0; i < ticks; i += 1) {
    await Promise.resolve();
  }
};

function recordingInvoke(calls: NativeCall[]) {
  return async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push({ command, args });
    return {} as T;
  };
}

describe("Android system bars appearance", () => {
  test("only syncs inside a Tauri Android client", () => {
    expect(supportsAndroidSystemBars({ tauriRuntime: true, platform: "android" })).toBe(true);
    expect(supportsAndroidSystemBars({ tauriRuntime: false, platform: "android" })).toBe(false);
    expect(supportsAndroidSystemBars({ tauriRuntime: true, platform: "ios" })).toBe(false);
    expect(supportsAndroidSystemBars({ tauriRuntime: true, platform: "desktop" })).toBe(false);
  });

  test("never invokes the bridge outside Android", async () => {
    const calls: NativeCall[] = [];
    syncAndroidSystemBars(true, {
      supportsNative: false,
      nativeInvoke: recordingInvoke(calls),
    });
    await settle();
    expect(calls).toEqual([]);
  });

  test("sends the resolved theme once per change", async () => {
    resetAndroidSystemBarsForTests();
    const calls: NativeCall[] = [];
    const nativeInvoke = recordingInvoke(calls);

    syncAndroidSystemBars(true, { nativeInvoke, supportsNative: true });
    await settle();
    // 相同目标不重复过桥。
    syncAndroidSystemBars(true, { nativeInvoke, supportsNative: true });
    await settle();
    syncAndroidSystemBars(false, { nativeInvoke, supportsNative: true });
    await settle();

    expect(calls).toEqual([
      { command: "android_system_bars_set_appearance", args: { dark: true } },
      { command: "android_system_bars_set_appearance", args: { dark: false } },
    ]);
  });

  test("a target superseded before sending is never invoked", async () => {
    resetAndroidSystemBarsForTests();
    const calls: NativeCall[] = [];
    let releaseFirst: (() => void) | null = null;
    const nativeInvoke = async <T>(
      command: string,
      args?: Record<string, unknown>,
    ): Promise<T> => {
      calls.push({ command, args });
      if (calls.length === 1) {
        return new Promise<T>((resolve) => {
          releaseFirst = () => resolve({} as T);
        });
      }
      return {} as T;
    };

    syncAndroidSystemBars(true, { nativeInvoke, supportsNative: true });
    // 让链式写入启动，第一个 invoke 进入在途状态。
    await flushMicrotasks();
    // 在途期间的目标翻转：false 从未真正发送，最终只落 true。
    syncAndroidSystemBars(false, { nativeInvoke, supportsNative: true });
    syncAndroidSystemBars(true, { nativeInvoke, supportsNative: true });
    expect(calls).toEqual([
      { command: "android_system_bars_set_appearance", args: { dark: true } },
    ]);

    releaseFirst?.();
    await settle();
    expect(calls).toEqual([
      { command: "android_system_bars_set_appearance", args: { dark: true } },
    ]);
  });

  test("writes stay ordered when a new target arrives mid-flight", async () => {
    resetAndroidSystemBarsForTests();
    const calls: NativeCall[] = [];
    let releaseFirst: (() => void) | null = null;
    const nativeInvoke = async <T>(
      command: string,
      args?: Record<string, unknown>,
    ): Promise<T> => {
      calls.push({ command, args });
      if (calls.length === 1) {
        return new Promise<T>((resolve) => {
          releaseFirst = () => resolve({} as T);
        });
      }
      return {} as T;
    };

    syncAndroidSystemBars(false, { nativeInvoke, supportsNative: true });
    // false 已在途（无法撤销 IPC），此时 true 到达。
    await flushMicrotasks();
    syncAndroidSystemBars(true, { nativeInvoke, supportsNative: true });
    releaseFirst?.();
    await settle();

    // false 先落地，true 在其 settle 后按顺序补发，不产生乱序写入。
    expect(calls).toEqual([
      { command: "android_system_bars_set_appearance", args: { dark: false } },
      { command: "android_system_bars_set_appearance", args: { dark: true } },
    ]);
  });

  test("retries silently after a failure", async () => {
    resetAndroidSystemBarsForTests();
    const calls: NativeCall[] = [];
    let failures = 0;
    const nativeInvoke = async <T>(
      command: string,
      args?: Record<string, unknown>,
    ): Promise<T> => {
      calls.push({ command, args });
      if (failures === 0) {
        failures += 1;
        throw new Error("bridge unavailable");
      }
      return {} as T;
    };

    syncAndroidSystemBars(true, { nativeInvoke, supportsNative: true });
    await settle();
    expect(calls).toHaveLength(1);

    // 失败静默：不抛出、不上报；相同目标在下一次调用时重试。
    syncAndroidSystemBars(true, { nativeInvoke, supportsNative: true });
    await settle();
    // 成功后相同目标不再发送。
    syncAndroidSystemBars(true, { nativeInvoke, supportsNative: true });
    await settle();
    expect(calls).toHaveLength(2);
  });
});
