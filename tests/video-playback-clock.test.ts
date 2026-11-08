import { describe, expect, test } from "bun:test";
import { createPlaybackClock } from "../src/features/video/videoPlaybackClock";

describe("VOD 播放进度 store", () => {
  test("写入通知订阅者，同值不通知", () => {
    const clock = createPlaybackClock(5);
    let calls = 0;
    clock.subscribe(() => calls++);
    expect(clock.get()).toBe(5);
    clock.set(5);
    expect(calls).toBe(0);
    clock.set(5.25);
    expect(clock.get()).toBe(5.25);
    expect(calls).toBe(1);
  });

  test("退订后不再通知，其余订阅者不受影响", () => {
    const clock = createPlaybackClock();
    let first = 0;
    let second = 0;
    const off = clock.subscribe(() => first++);
    clock.subscribe(() => second++);
    clock.set(1);
    off();
    clock.set(2);
    expect(first).toBe(1);
    expect(second).toBe(2);
  });

  test("离场静默只暂停通知，恢复后从实际媒体位置继续", () => {
    const clock = createPlaybackClock(5);
    let calls = 0;
    clock.subscribe(() => calls++);
    clock.setQuiet(true);
    clock.set(6);
    clock.set(7);
    expect(clock.get()).toBe(7);
    expect(calls).toBe(0);
    clock.setQuiet(false);
    expect(calls).toBe(1);
    clock.set(7);
    expect(calls).toBe(1);
    clock.set(7.25);
    expect(calls).toBe(2);
  });

  test("卸载时解除静默不向旧订阅者补发通知", () => {
    const clock = createPlaybackClock(5);
    let calls = 0;
    clock.subscribe(() => calls++);
    clock.setQuiet(true);
    clock.set(7);
    clock.setQuiet(false, false);
    expect(calls).toBe(0);
    clock.set(8);
    expect(calls).toBe(1);
  });
});
