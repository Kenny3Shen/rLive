import { describe, expect, test } from "bun:test";
import {
  createVideoWaitingRecovery,
  VOD_WAITING_RECOVERY_MAX_AUTO_RETRIES,
  VOD_WAITING_RECOVERY_STABLE_MS,
  VOD_WAITING_RECOVERY_TIMEOUT_MS,
  type VideoWaitingRecovery,
  type VideoWaitingRecoveryClockAdapter,
} from "../src/features/video/videoWaitingRecovery";

/** 与 playback-recovery-session.test.ts 同款假时钟：advanceBy 依到期顺序触发回调。 */
class FakeClock implements VideoWaitingRecoveryClockAdapter {
  private currentTime = 0;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();

  now(): number {
    return this.currentTime;
  }

  setTimer(callback: () => void, delayMs: number): number {
    const id = this.nextId++;
    this.timers.set(id, { at: this.currentTime + delayMs, callback });
    return id;
  }

  clearTimer(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  advanceBy(durationMs: number): void {
    const target = this.currentTime + durationMs;
    while (true) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (!next) break;
      const [id, timer] = next;
      this.timers.delete(id);
      this.currentTime = timer.at;
      timer.callback();
    }
    this.currentTime = target;
  }
}

function createHarness(clock: FakeClock = new FakeClock()) {
  const counts = { autoRetry: 0, exhausted: 0 };
  const recovery = createVideoWaitingRecovery({
    clock,
    onAutoRetry: () => {
      counts.autoRetry += 1;
    },
    onExhausted: () => {
      counts.exhausted += 1;
    },
  });
  return { recovery, clock, counts };
}

/**
 * 上游故障的一轮：先稳定播 stableForMs，再卡住直到超时判定成立。
 * 页面在自动重试后会随新 playUrl 重建播放器（beginSession），由调用方按
 * 「重试了才重建」的现实语义显式调用。
 */
function stallUntilTimeout(
  recovery: VideoWaitingRecovery,
  clock: FakeClock,
  stableForMs = 0,
): void {
  if (stableForMs > 0) {
    recovery.notifyResumed();
    clock.advanceBy(stableForMs);
  }
  recovery.notifyWaiting();
  clock.advanceBy(VOD_WAITING_RECOVERY_TIMEOUT_MS);
}

describe("点播 waiting 自动恢复", () => {
  test("短 waiting 不重试：不到超时窗口", () => {
    const { recovery, clock, counts } = createHarness();
    recovery.beginSession("BV1:a");
    recovery.notifyResumed();
    recovery.notifyWaiting();
    clock.advanceBy(VOD_WAITING_RECOVERY_TIMEOUT_MS - 1);
    expect(counts.autoRetry).toBe(0);
  });

  test("持续 waiting 超过窗口触发自动重试", () => {
    const { recovery, clock, counts } = createHarness();
    recovery.beginSession("BV1:a");
    recovery.notifyResumed();
    clock.advanceBy(60_000);
    recovery.notifyWaiting();
    clock.advanceBy(VOD_WAITING_RECOVERY_TIMEOUT_MS);
    expect(counts.autoRetry).toBe(1);
    expect(counts.exhausted).toBe(0);
  });

  test("playing/seeked 解除 waiting：计时取消，不再重试", () => {
    const { recovery, clock, counts } = createHarness();
    recovery.beginSession("BV1:a");
    recovery.notifyResumed();
    // seek 引发的短暂 waiting，seeked 之后解除。
    recovery.notifyWaiting();
    clock.advanceBy(9_000);
    recovery.notifyResumed();
    clock.advanceBy(VOD_WAITING_RECOVERY_TIMEOUT_MS);
    expect(counts.autoRetry).toBe(0);
    // playing 同样解除：卡一下又自己缓过来。
    recovery.notifyWaiting();
    recovery.notifyResumed();
    clock.advanceBy(VOD_WAITING_RECOVERY_TIMEOUT_MS);
    expect(counts.autoRetry).toBe(0);
  });

  test("用户暂停/播完/错误接管都会作废计时", () => {
    const cases = [
      (recovery: VideoWaitingRecovery) => recovery.notifyPaused(),
      (recovery: VideoWaitingRecovery) => recovery.notifyEnded(),
      (recovery: VideoWaitingRecovery) => recovery.notifyError(),
    ];
    for (const cancel of cases) {
      const { recovery, clock, counts } = createHarness();
      recovery.beginSession("BV1:a");
      recovery.notifyResumed();
      recovery.notifyWaiting();
      cancel(recovery);
      clock.advanceBy(VOD_WAITING_RECOVERY_TIMEOUT_MS);
      expect(counts.autoRetry).toBe(0);
      expect(counts.exhausted).toBe(0);
    }
  });

  test("拆除会话后的过期计时不对新会话动手", () => {
    const { recovery, clock, counts } = createHarness();
    recovery.beginSession("BV1:a");
    recovery.notifyWaiting();
    // 播放器拆除（换集过渡/离开路由）：计时随会话作废。
    recovery.endSession();
    clock.advanceBy(VOD_WAITING_RECOVERY_TIMEOUT_MS);
    expect(counts.autoRetry).toBe(0);
    // 新会话重新登记后，自己的判定照常生效。
    recovery.beginSession("BV1:a");
    recovery.notifyWaiting();
    clock.advanceBy(VOD_WAITING_RECOVERY_TIMEOUT_MS);
    expect(counts.autoRetry).toBe(1);
  });

  test("迟到的过期计时被会话纪元拦下", () => {
    const base = new FakeClock();
    // clearTimer 失效：模拟真实定时器「回调已入队、清不掉」的窗口。
    const leaky: VideoWaitingRecoveryClockAdapter = {
      now: () => base.now(),
      setTimer: (callback, delayMs) => base.setTimer(callback, delayMs),
      clearTimer: () => {},
    };
    const counts = { autoRetry: 0 };
    const recovery = createVideoWaitingRecovery({
      clock: leaky,
      onAutoRetry: () => {
        counts.autoRetry += 1;
      },
      onExhausted: () => {},
    });

    recovery.beginSession("BV1:a");
    recovery.notifyWaiting(); // 计时 A：属于会话 1。
    base.advanceBy(2_000);
    recovery.beginSession("BV1:a"); // 会话 2 挂载；A 清不掉、继续活着。
    recovery.notifyWaiting(); // 计时 B：属于会话 2。
    base.advanceBy(VOD_WAITING_RECOVERY_TIMEOUT_MS);
    // A 在 t=10s 迟到触发，纪元不匹配被作废；B 在 t=12s 触发，只重试这一次。
    expect(counts.autoRetry).toBe(1);
  });

  test("预算耗尽后不再无限重试，错误面板接管", () => {
    const { recovery, clock, counts } = createHarness();
    recovery.beginSession("BV1:a");
    // 每轮只稳定播 5 秒（< 30 秒），预算不该被重置。
    stallUntilTimeout(recovery, clock, 5_000);
    recovery.beginSession("BV1:a"); // 自动重试 → 重建新会话
    stallUntilTimeout(recovery, clock, 5_000);
    recovery.beginSession("BV1:a");
    stallUntilTimeout(recovery, clock, 5_000);
    expect(counts.autoRetry).toBe(VOD_WAITING_RECOVERY_MAX_AUTO_RETRIES);
    expect(counts.exhausted).toBe(1);
    // 耗尽后继续卡：notifyWaiting 直接忽略，不重建也不重复报错。
    for (let index = 0; index < 3; index += 1) {
      recovery.notifyWaiting();
      clock.advanceBy(VOD_WAITING_RECOVERY_TIMEOUT_MS);
    }
    expect(counts.autoRetry).toBe(VOD_WAITING_RECOVERY_MAX_AUTO_RETRIES);
    expect(counts.exhausted).toBe(1);
    // 同 key 重建（换画质之类）：判定重新武装，但预算沿用——只报错不重建。
    recovery.beginSession("BV1:a");
    stallUntilTimeout(recovery, clock);
    expect(counts.autoRetry).toBe(VOD_WAITING_RECOVERY_MAX_AUTO_RETRIES);
    expect(counts.exhausted).toBe(2);
  });

  test("稳定播放满 30 秒后预算重置", () => {
    const { recovery, clock, counts } = createHarness();
    recovery.beginSession("BV1:a");
    // 两轮短间隔故障把预算用完。
    stallUntilTimeout(recovery, clock, 5_000);
    recovery.beginSession("BV1:a");
    stallUntilTimeout(recovery, clock, 5_000);
    expect(counts.autoRetry).toBe(2);
    // 新会话恢复后稳定播放满 30 秒再卡：预算已还回去，可以再自动恢复。
    recovery.notifyResumed();
    clock.advanceBy(VOD_WAITING_RECOVERY_STABLE_MS);
    recovery.notifyWaiting();
    clock.advanceBy(VOD_WAITING_RECOVERY_TIMEOUT_MS);
    expect(counts.autoRetry).toBe(3);
    expect(counts.exhausted).toBe(0);
  });

  test("手动重试清掉预算后仍可自动恢复", () => {
    const { recovery, clock, counts } = createHarness();
    recovery.beginSession("BV1:a");
    stallUntilTimeout(recovery, clock, 5_000);
    recovery.beginSession("BV1:a");
    stallUntilTimeout(recovery, clock, 5_000);
    recovery.beginSession("BV1:a");
    stallUntilTimeout(recovery, clock, 5_000);
    expect(counts.exhausted).toBe(1);
    // 用户点了错误面板的「重试」。
    recovery.notifyManualRetry();
    recovery.beginSession("BV1:a");
    recovery.notifyResumed();
    stallUntilTimeout(recovery, clock);
    expect(counts.autoRetry).toBe(3);
    expect(counts.exhausted).toBe(1);
  });

  test("换 videoKey 重置预算", () => {
    const { recovery, clock, counts } = createHarness();
    recovery.beginSession("BV1:a");
    stallUntilTimeout(recovery, clock, 5_000);
    recovery.beginSession("BV1:a");
    stallUntilTimeout(recovery, clock, 5_000);
    recovery.beginSession("BV1:a");
    stallUntilTimeout(recovery, clock, 5_000);
    expect(counts.exhausted).toBe(1);
    // 下一集：新 key 从零起算。
    recovery.beginSession("BV1:b");
    stallUntilTimeout(recovery, clock);
    expect(counts.autoRetry).toBe(3);
    expect(counts.exhausted).toBe(1);
  });
});
