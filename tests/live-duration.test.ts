// 直播间已播时长：控制栏时钟、关注列表中文文案与秒级心跳对齐共用一份判定。
import { describe, expect, test } from "bun:test";
import {
  formatLiveDurationClock,
  formatLiveDurationLabel,
  formatLiveDurationText,
  liveDurationTickDelayMs,
  liveElapsedMs,
} from "../src/shared/liveDuration";
import { formatFollowLiveDuration } from "../src/features/follow/followRoute";

const START = 1_700_000_000_000;

describe("已播时长判定", () => {
  test.each([
    [null, null],
    [undefined, null],
    [Number.NaN, null],
    [Number.POSITIVE_INFINITY, null],
    [0, null],
    [-1, null],
    // 平台时钟领先本机时，未来时间不折算成负时长。
    [START + 1_000, null],
  ])("未知、非法与未来的开播时间渲染为空：%p", (startedAt, expected) => {
    expect(liveElapsedMs(startedAt, START)).toBe(expected);
    expect(formatLiveDurationText(startedAt, START)).toBe(expected);
    expect(formatLiveDurationClock(startedAt, START)).toBe(expected);
    expect(formatLiveDurationLabel(startedAt, START)).toBe(expected);
  });

  test("恰好等于当前时刻算刚开播，不算未来", () => {
    expect(liveElapsedMs(START, START)).toBe(0);
    expect(formatLiveDurationText(START, START)).toBe("刚刚开播");
    expect(formatLiveDurationClock(START, START)).toBe("00:00");
  });

  test.each([
    [59_000, "刚刚开播", "00:59"],
    [60_000, "1 分钟", "01:00"],
    [59 * 60_000, "59 分钟", "59:00"],
    [60 * 60_000, "1 小时", "01:00:00"],
    [90 * 60_000, "1 小时 30 分钟", "01:30:00"],
    [23 * 3_600_000, "23 小时", "23:00:00"],
    [24 * 3_600_000, "1 天", "24:00:00"],
    [50 * 3_600_000, "2 天 2 小时", "50:00:00"],
  ] as const)("中文文案与时钟同步推进：%dms", (elapsed, text, clock) => {
    expect(formatLiveDurationText(START, START + elapsed)).toBe(text);
    expect(formatLiveDurationClock(START, START + elapsed)).toBe(clock);
  });

  test("秒位补零且只在整秒翻动", () => {
    expect(formatLiveDurationClock(START, START + 1_999)).toBe("00:01");
    expect(formatLiveDurationClock(START, START + 2_000)).toBe("00:02");
    expect(formatLiveDurationClock(START, START + 61_000)).toBe("01:01");
  });

  test("小时补零，整点处文字宽度不跳", () => {
    expect(formatLiveDurationClock(START, START + 9 * 3_600_000)).toBe("09:00:00");
    expect(formatLiveDurationClock(START, START + 10 * 3_600_000)).toBe("10:00:00");
    expect(formatLiveDurationClock(START, START + 100 * 3_600_000)).toBe("100:00:00");
  });

  test("悬停提示给出中文时长与本地开播时刻", () => {
    const startedAt = new Date(2024, 0, 1, 9, 4, 0).getTime();
    const now = startedAt + 2 * 3_600_000 + 31 * 60_000;
    expect(formatLiveDurationLabel(startedAt, now)).toBe(
      "当前直播时长：2 小时 31 分钟（开播于 09:04）",
    );
  });

  test("心跳对齐到下个整秒并留出余量，恒为正", () => {
    const base = 1_700_000_000_000;
    expect(liveDurationTickDelayMs(base)).toBe(1_020);
    expect(liveDurationTickDelayMs(base + 999)).toBe(21);
    // 恰好落在秒边界上时不能退化成 0（会变成忙循环）。
    expect(liveDurationTickDelayMs(base + 1_000)).toBe(1_020);
  });
});

describe("关注列表文案复用同一判定", () => {
  test("旧入口的导出名保持不变", () => {
    expect(formatFollowLiveDuration).toBe(formatLiveDurationText);
  });
});
