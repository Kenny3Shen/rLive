import { describe, expect, test } from "bun:test";
import { roomIdentityMarqueeCycle } from "../src/shared/components/player/RoomIdentityLine";

describe("room identity marquee", () => {
  test("builds one symmetric round trip per cycle", () => {
    // 280 px / 28 px·s = 10 s 单程，两端各停 1.2 s，一个周期 = 2 × (10 + 1.2) s。
    const { cycleMs, keyframes } = roomIdentityMarqueeCycle(280);
    expect(cycleMs).toBe(22400);
    expect(keyframes.map((frame) => frame.transform)).toEqual([
      "translate3d(0, 0, 0)",
      "translate3d(0, 0, 0)",
      "translate3d(-280px, 0, 0)",
      "translate3d(-280px, 0, 0)",
      "translate3d(0, 0, 0)",
    ]);

    const offsets = keyframes.map((frame) => frame.offset);
    expect(offsets[0]).toBe(0);
    expect(offsets[offsets.length - 1]).toBe(1);
    // 停顿与行程的占比精确对应 GSAP 时代的 delay / repeatDelay 语义。
    expect(offsets[1]).toBeCloseTo(1200 / 22400);
    expect(offsets[2]).toBeCloseTo(11200 / 22400);
    expect(offsets[3]).toBeCloseTo(12400 / 22400);
    // 关键帧偏移必须严格递增，否则 Web Animations 会抛 TypeError。
    for (let index = 1; index < offsets.length; index += 1) {
      expect(offsets[index]).toBeGreaterThan(offsets[index - 1]!);
    }
  });

  test("clamps travel duration for extreme distances", () => {
    // 单程最短 2.4 s、最长 16 s。
    expect(roomIdentityMarqueeCycle(2.8).cycleMs).toBe(2 * (2400 + 1200));
    expect(roomIdentityMarqueeCycle(2800).cycleMs).toBe(2 * (16000 + 1200));
  });
});
