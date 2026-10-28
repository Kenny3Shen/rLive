import { describe, expect, test } from "bun:test";
import {
  createTimePublishGate,
  isCurrentTimeOnlyPatch,
} from "../src/components/videojs/lib/time-publish-gate";

describe("播放进度发布节流", () => {
  test("逐帧写入按间隔放行，首帧立即发布", () => {
    const gate = createTimePublishGate(100);
    const published = [0, 8, 16, 99, 100, 108, 199, 200].filter((t) => gate.shouldPublish(t));
    expect(published).toEqual([0, 100, 200]);
  });

  test("事件同步重置节拍，紧随其后的逐帧写入被合并", () => {
    const gate = createTimePublishGate(100);
    expect(gate.shouldPublish(0)).toBe(true);
    gate.markPublished(50);
    expect(gate.shouldPublish(120)).toBe(false);
    expect(gate.shouldPublish(150)).toBe(true);
  });

  test("只有单独的 currentTime 写入走节流", () => {
    expect(isCurrentTimeOnlyPatch({ currentTime: 1 })).toBe(true);
    expect(isCurrentTimeOnlyPatch({ currentTime: 1, duration: 2, seeking: false })).toBe(false);
    expect(isCurrentTimeOnlyPatch({ currentTime: 1, seeking: true })).toBe(false);
    expect(isCurrentTimeOnlyPatch({ duration: 2 })).toBe(false);
  });
});
