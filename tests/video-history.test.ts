import { describe, expect, test } from "bun:test";
import { videoResumeCid, videoResumePosition } from "../src/features/video/videoHistory";
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

describe("视频续播分 P", () => {
  // 多 P 稿件：pages 有两项，P1 是 archive.cid。
  const archive = {
    cid: 1_001,
    pages: [
      { page: 1, cid: 1_001, part: "P1", duration: 1_200 },
      { page: 2, cid: 1_002, part: "P2", duration: 1_200 },
    ],
  };

  test("卡片进入时落回上次看到一半的那一 P", () => {
    expect(videoResumeCid(record({ cid: 1_002 }), archive)).toBe(1_002);
  });

  test("上次那一 P 已看完时回到 P1", () => {
    // 看完的那一 P 没有「上次退出的地方」可回，重播它反而违背预期。
    expect(videoResumeCid(record({ cid: 1_002, progress: 1_198 }), archive)).toBe(1_001);
  });

  test("历史的 cid 不属于本稿件时回到 P1", () => {
    // 合集里换了稿件、或历史是脏数据：拿它取流会播成别的内容。
    expect(videoResumeCid(record({ cid: 7_777 }), archive)).toBe(1_001);
  });

  test("没有历史时回到 P1", () => {
    expect(videoResumeCid(null, archive)).toBe(1_001);
  });

  test("稿件详情未到时取流键未就绪", () => {
    expect(videoResumeCid(record({ cid: 1_002 }), undefined)).toBe(0);
  });
});
