import { describe, expect, test } from "bun:test";
import {
  shouldReportWatchProgress,
  watchResumePosition,
  WATCH_PROGRESS_REPORT_INTERVAL_MS,
} from "../src/shared/watchProgress";

describe("观看进度上报节流", () => {
  const now = 1_700_000_000_000;

  test("越过最小进度后立刻记第一笔", () => {
    expect(shouldReportWatchProgress(4, null, now)).toBe(true);
  });

  test("进度过短不记", () => {
    expect(shouldReportWatchProgress(1, null, now)).toBe(false);
  });

  test("节流窗口内不重复写盘", () => {
    expect(shouldReportWatchProgress(10, now - 1_000, now)).toBe(false);
    expect(shouldReportWatchProgress(10, now - WATCH_PROGRESS_REPORT_INTERVAL_MS, now)).toBe(true);
  });
});

describe("续播位置", () => {
  test("时长已知时看到结尾附近算看完", () => {
    // 停在最后一帧会立刻再触发 ended，续播体验上等于播不了。
    expect(watchResumePosition(3_596, 3_600)).toBe(0);
    expect(watchResumePosition(3_594, 3_600)).toBe(3_594);
  });

  test("时长未知时无从判断结尾，照原样续播", () => {
    // 录制中断的分卷可能拿不到时长，此时不能因为「算不出结尾」就退回从头播。
    expect(watchResumePosition(3_596, 0)).toBe(3_596);
  });
});
