import { describe, expect, test } from "bun:test";
import {
  formatSleepTimer,
  MAX_SLEEP_TIMER_MINUTES,
  MIN_SLEEP_TIMER_MINUTES,
  normalizeSleepTimerMinutes,
} from "../src/features/room/useSleepTimer";

describe("直播间定时关闭", () => {
  test("将倒计时分钟限制在可用范围并取整", () => {
    expect(normalizeSleepTimerMinutes(Number.NaN)).toBe(30);
    expect(normalizeSleepTimerMinutes(0)).toBe(MIN_SLEEP_TIMER_MINUTES);
    expect(normalizeSleepTimerMinutes(12.4)).toBe(12);
    expect(normalizeSleepTimerMinutes(MAX_SLEEP_TIMER_MINUTES + 1)).toBe(MAX_SLEEP_TIMER_MINUTES);
  });

  test("以固定的时分秒格式显示剩余时间", () => {
    expect(formatSleepTimer(0)).toBe("00:00:00");
    expect(formatSleepTimer(3_661)).toBe("01:01:01");
    expect(formatSleepTimer(-1)).toBe("00:00:00");
  });
});
