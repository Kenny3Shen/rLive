import { describe, expect, test } from "bun:test";
import {
  acfunResumePartId,
  acfunResumePosition,
  acfunWatchHistoryEntry,
} from "../src/features/acfun/acfunHistory";
import { videoHistoryPlayPath, videoHistorySiteId } from "../src/features/video/videoHistory";
import type { AcfunVideoDetail } from "../src/features/acfun/acfunTypes";
import type { VideoHistoryItem } from "../src/shared/types/video";

const detail: AcfunVideoDetail = {
  item: {
    id: "49004803",
    title: "多 P 稿件",
    cover: "https://example.com/cover.jpg",
    author: "作者",
    duration_sec: 300,
    play_count: 10,
    danmaku_count: 20,
    published_at: 100,
  },
  description: "",
  tags: [],
  parts: [
    { id: "p1", index: 1, title: "第一集", duration_sec: 120 },
    { id: "p2", index: 2, title: "", duration_sec: 180 },
  ],
};

function record(overrides: Partial<VideoHistoryItem> = {}): VideoHistoryItem {
  return {
    kind: "acfun",
    oid: "49004803",
    title: "多 P 稿件",
    cover: "",
    author: "",
    part_title: "第一集",
    bvid: "",
    cid: 0,
    ep_id: "",
    aid: "",
    part_id: "p1",
    progress: 30,
    duration: 120,
    watched_at: 1,
    ...overrides,
  };
}

describe("AcFun video history", () => {
  test("URL 分 P 优先，其次使用仍然存在的历史分 P", () => {
    expect(acfunResumePartId(record(), detail, "p2")).toBe("p2");
    expect(acfunResumePartId(record(), detail)).toBe("p1");
    expect(acfunResumePartId(record({ part_id: "removed" }), detail)).toBe("p1");
    expect(acfunResumePartId(null, detail)).toBe("p1");
  });

  test("只在同一分 P 且未看完时续播", () => {
    expect(acfunResumePosition(record(), "p1")).toBe(30);
    expect(acfunResumePosition(record(), "p2")).toBe(0);
    expect(acfunResumePosition(record({ progress: 117 }), "p1")).toBe(0);
    expect(acfunResumePosition(record({ progress: 2 }), "p1")).toBe(0);
    expect(acfunResumePosition(record({ kind: "ugc" }), "p1")).toBe(0);
  });

  test("历史条目保留 AcFun 独立标识并映射播放地址", () => {
    const entry = acfunWatchHistoryEntry(detail, "p2");
    expect(entry).toMatchObject({
      kind: "acfun",
      oid: "49004803",
      part_id: "p2",
      part_title: "P2",
      bvid: "",
      cid: 0,
      aid: "",
      duration: 180,
    });
    expect(videoHistorySiteId(entry!)).toBe("acfun");
    expect(videoHistoryPlayPath(entry!)).toBe("/video/acfun/play?id=49004803&part=p2");
  });
});
