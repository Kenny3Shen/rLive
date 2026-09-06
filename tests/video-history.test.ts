import { describe, expect, test } from "bun:test";
import {
  videoPgcEntryEpisode,
  videoResumeCid,
  videoResumePosition,
} from "../src/features/video/videoHistory";
import type { SeasonEpisode, VideoHistoryItem } from "../src/shared/types/video";

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

describe("番剧/影视卡片直入选集", () => {
  function episode(epId: string): SeasonEpisode {
    return {
      ep_id: epId,
      aid: "42",
      cid: Number(epId.slice(2)),
      bvid: `BV${epId}`,
      title: epId.slice(2),
      long_title: `第 ${epId.slice(2)} 话`,
      cover: "",
      duration: 1_200,
      badge: null,
    };
  }
  const episodes = [episode("ep1"), episode("ep2"), episode("ep3")];

  test("没有历史时从首集进入", () => {
    expect(videoPgcEntryEpisode(episodes, null)?.ep_id).toBe("ep1");
  });

  test("有历史时落回上次看的那一集", () => {
    const pgc = record({ kind: "pgc", oid: "367", ep_id: "ep2" });
    expect(videoPgcEntryEpisode(episodes, pgc)?.ep_id).toBe("ep2");
  });

  test("看完的那一集仍回到那一集", () => {
    // 剧集的内容单位是集：追番场景里「上次那集」比「第 1 集」有信息量，
    // 与多 P 稿件「看完退回 P1」的取向不同；从头播交给位置续播判定。
    const finished = record({ kind: "pgc", oid: "367", ep_id: "ep2", progress: 1_198 });
    expect(videoPgcEntryEpisode(episodes, finished)?.ep_id).toBe("ep2");
  });

  test("历史的那一集已不在分集表里时退回首集", () => {
    // 合集改版换掉了旧集、或脏数据：拿它进播放页会播成别的内容。
    const stale = record({ kind: "pgc", oid: "367", ep_id: "ep9" });
    expect(videoPgcEntryEpisode(episodes, stale)?.ep_id).toBe("ep1");
  });

  test("分集表为空时无集可选", () => {
    // 版权/地区限制：调用方据此展示可读的失败态而不是无限加载。
    expect(videoPgcEntryEpisode([], record({ kind: "pgc", oid: "367", ep_id: "ep1" }))).toBeNull();
    expect(videoPgcEntryEpisode([], null)).toBeNull();
  });
});
