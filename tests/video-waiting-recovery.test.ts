import { describe, expect, test } from "bun:test";
import {
  createVideoWaitingRecovery,
  type VideoWaitingRecoveryClockAdapter,
} from "../src/features/video/videoWaitingRecovery";

function manualClock() {
  let now = 0;
  let nextId = 0;
  const delays: number[] = [];
  const timers = new Map<number, { at: number; callback: () => void }>();
  const adapter: VideoWaitingRecoveryClockAdapter = {
    now: () => now,
    setTimer: (callback, delayMs) => {
      nextId += 1;
      delays.push(delayMs);
      timers.set(nextId, { at: now + delayMs, callback });
      return nextId;
    },
    clearTimer: (handle) => {
      timers.delete(handle as number);
    },
  };
  return {
    adapter,
    advance(ms: number) {
      now += ms;
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= now)
        .sort((left, right) => left[1].at - right[1].at);
      for (const [handle, timer] of due) {
        if (timers.delete(handle)) timer.callback();
      }
    },
    pending: () => timers.size,
    delays: () => delays,
  };
}

function recoveryWith(clock: ReturnType<typeof manualClock>, startupTimeoutMs = 25) {
  let autoRetries = 0;
  let exhausted = 0;
  const recovery = createVideoWaitingRecovery({
    onAutoRetry: () => {
      autoRetries += 1;
    },
    onExhausted: () => {
      exhausted += 1;
    },
    clock: clock.adapter,
    timeoutMs: 10,
    startupTimeoutMs,
    maxAutoRetries: 2,
    stableMs: 30,
  });
  return {
    recovery,
    autoRetries: () => autoRetries,
    exhausted: () => exhausted,
  };
}

describe("VOD waiting 自动恢复", () => {
  test("只有元数据不会取消首片等待，媒体数据到达才解除计时", () => {
    const clock = manualClock();
    const { recovery, autoRetries } = recoveryWith(clock);
    recovery.beginSession("video:1");
    recovery.notifyWaiting();
    recovery.notifyResumed(0);
    recovery.notifyResumed(1);
    clock.advance(25);
    expect(autoRetries()).toBe(1);

    recovery.beginSession("video:1");
    recovery.notifyWaiting();
    recovery.notifyResumed(2);
    expect(clock.pending()).toBe(0);
    clock.advance(100);
    expect(autoRetries()).toBe(1);
  });

  test("首片持续失败耗尽预算后交还手动重试", () => {
    const clock = manualClock();
    const { recovery, autoRetries, exhausted } = recoveryWith(clock);
    recovery.beginSession("video:1");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      recovery.notifyWaiting();
      clock.advance(25);
      recovery.beginSession("video:1");
    }
    expect(autoRetries()).toBe(2);
    expect(exhausted()).toBe(0);
    recovery.notifyWaiting();
    clock.advance(25);
    expect(autoRetries()).toBe(2);
    expect(exhausted()).toBe(1);

    recovery.notifyManualRetry();
    recovery.notifyWaiting();
    clock.advance(25);
    expect(autoRetries()).toBe(3);
    expect(clock.pending()).toBe(0);
  });

  test("稳定播放过的数据会话可重新获得自动恢复预算", () => {
    const clock = manualClock();
    const { recovery, autoRetries, exhausted } = recoveryWith(clock);
    recovery.beginSession("video:1");
    recovery.notifyWaiting();
    clock.advance(25);
    recovery.beginSession("video:1");
    recovery.notifyResumed(3);
    clock.advance(30);
    recovery.notifyWaiting();
    clock.advance(10);
    recovery.beginSession("video:1");
    recovery.notifyWaiting();
    clock.advance(25);

    expect(autoRetries()).toBe(3);
    expect(exhausted()).toBe(0);
  });

  test("暂停后不自动重建播放会话", () => {
    const clock = manualClock();
    const { recovery, autoRetries } = recoveryWith(clock);
    recovery.beginSession("video:1");
    recovery.notifyWaiting();
    recovery.notifyPaused();
    clock.advance(25);
    expect(autoRetries()).toBe(0);
  });

  test("首片超过常规 10 秒仍允许加载并到 25 秒再重建；有媒体后缓冲 10 秒恢复", () => {
    const clock = manualClock();
    const { recovery, autoRetries } = recoveryWith(clock);
    recovery.beginSession("video:1");
    recovery.notifyWaiting();
    expect(clock.delays()).toEqual([25]);
    clock.advance(10);
    recovery.notifyResumed(1);
    expect(autoRetries()).toBe(0);
    clock.advance(14);
    expect(autoRetries()).toBe(0);
    clock.advance(1);
    expect(autoRetries()).toBe(1);

    recovery.beginSession("video:1");
    recovery.notifyResumed(2);
    recovery.notifyWaiting();
    expect(clock.delays().at(-1)).toBe(10);
    clock.advance(9);
    expect(autoRetries()).toBe(1);
    clock.advance(1);
    expect(autoRetries()).toBe(2);
  });
});
