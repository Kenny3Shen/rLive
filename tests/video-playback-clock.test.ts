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
});
