import { describe, expect, test } from "bun:test";
import { createSmoothMediaClock, type MediaClockSource } from "../src/shared/smoothMediaClock";

/** 每帧 16.67ms，真实 currentTime 带 ±12ms 抖动（模拟 MSE 音频时钟）。 */
function run(frames: number, frameMs: number, jitterMs: number, rate = 1) {
  const clock = createSmoothMediaClock();
  const media: MediaClockSource = { currentTime: 0, playbackRate: rate, paused: false, readyState: 4 };
  const out: number[] = [];
  for (let i = 0; i < frames; i++) {
    const wall = i * frameMs;
    const jitter = (i % 2 ? 1 : -1) * jitterMs * ((i * 7) % 5) / 4;
    media.currentTime = Math.max(0, (wall * rate + jitter) / 1_000);
    out.push(clock.read(wall, media));
  }
  return out;
}

describe("smoothMediaClock", () => {
  test("抖动的 currentTime 被平滑为接近匀速的逐帧增量", () => {
    for (const frameMs of [1_000 / 60, 1_000 / 120]) {
      const times = run(600, frameMs, 12);
      const steps = times.slice(1).map((t, i) => t - times[i]!);
      // 首帧对齐后的增量偏差应远小于原始 ±12ms 抖动。
      const worst = Math.max(...steps.slice(10).map((d) => Math.abs(d - frameMs)));
      expect(worst).toBeLessThan(2);
      // 长期不漂移：末帧与真实时间差在抖动范围内。
      expect(Math.abs(times.at(-1)! - 599 * frameMs)).toBeLessThan(15);
    }
  });

  test("倍速按 playbackRate 外推", () => {
    const times = run(300, 1_000 / 60, 5, 2);
    expect(Math.abs(times.at(-1)! - 299 * (1_000 / 60) * 2)).toBeLessThan(10);
  });

  test("暂停、缓冲等待时直接返回真实时间，恢复后重新对齐", () => {
    const clock = createSmoothMediaClock();
    const media: MediaClockSource = { currentTime: 1, playbackRate: 1, paused: false, readyState: 4 };
    clock.read(0, media);
    media.readyState = 2;
    media.currentTime = 1.2;
    expect(clock.read(500, media)).toBe(1_200);
    media.readyState = 4;
    // 缓冲期间墙钟走了 1s，恢复后不能外推出这 1s。
    expect(clock.read(1_500, media)).toBe(1_200);
    media.paused = true;
    media.currentTime = 3;
    expect(clock.read(1_600, media)).toBe(3_000);
  });

  test("seek 等大跳变硬对齐", () => {
    const clock = createSmoothMediaClock();
    const media: MediaClockSource = { currentTime: 0, playbackRate: 1, paused: false, readyState: 4 };
    clock.read(0, media);
    media.currentTime = 30;
    expect(clock.read(16, media)).toBe(30_000);
  });
});
