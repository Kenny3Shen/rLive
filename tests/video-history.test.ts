import { describe, expect, test } from "bun:test";
import {
  shouldReportVideoProgress,
  videoResumePosition,
  VIDEO_HISTORY_REPORT_INTERVAL_MS,
} from "../src/features/video/videoHistory";
import type { VideoHistoryItem } from "../src/shared/types/video";

function record(overrides: Partial<VideoHistoryItem> = {}): VideoHistoryItem {
  return {
    kind: "ugc",
    oid: "BV1Ybuq6nEYq",
    title: "标题",
    cover: "",
    author: "UP 主",
    part_title: "",
    bvid: "BV1Ybuq6nEYq",
    cid: 1_001,
    ep_id: "",
    aid: "1",
    progress: 300,
    duration: 1_200,
    watched_at: 1_700_000_000_000,
    ...overrides,
  };
}

describe("视频续播位置", () => {
  test("同一分集从上次位置续播", () => {
    expect(videoResumePosition(record(), { cid: 1_001, epId: null })).toBe(300);
  });

  test("从未看过的作品从头播", () => {
    expect(videoResumePosition(null, { cid: 1_001, epId: null })).toBe(0);
  });

  test("历史停在别的分集时从头播", () => {
    // 同一稿件换 P（或同一剧集换集）不能沿用上一集的进度：会跳到错误的位置。
    expect(videoResumePosition(record(), { cid: 2_002, epId: null })).toBe(0);
  });

  test("cid 未知时按 ep_id 比对分集", () => {
    const pgc = record({ kind: "pgc", oid: "45678", cid: 0, ep_id: "ep900", progress: 120 });
    expect(videoResumePosition(pgc, { cid: 0, epId: "ep900" })).toBe(120);
    expect(videoResumePosition(pgc, { cid: 0, epId: "ep901" })).toBe(0);
  });

  test("已看到片尾的分集从头播", () => {
    // 停在最后一帧会立刻再触发 ended，续播体验上等于播不了。
    expect(videoResumePosition(record({ progress: 1_198 }), { cid: 1_001, epId: null })).toBe(0);
  });

  test("进度过短视为没看，不续播", () => {
    expect(videoResumePosition(record({ progress: 1.5 }), { cid: 1_001, epId: null })).toBe(0);
  });
});

describe("视频进度上报节流", () => {
  const now = 1_700_000_000_000;

  test("越过最小进度后立刻记第一笔", () => {
    expect(shouldReportVideoProgress(4, null, now)).toBe(true);
  });

  test("进度过短不记", () => {
    expect(shouldReportVideoProgress(1, null, now)).toBe(false);
  });

  test("节流窗口内不重复写盘", () => {
    expect(shouldReportVideoProgress(10, now - 1_000, now)).toBe(false);
    expect(shouldReportVideoProgress(10, now - VIDEO_HISTORY_REPORT_INTERVAL_MS, now)).toBe(true);
  });
});
