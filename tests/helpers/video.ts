import type { VideoItem } from "../../src/shared/types/video";

/** 补齐必填字段；UID、画幅默认缺省，显式传入的 null/0/undefined 不做回填。 */
export function videoItem(overrides: Partial<VideoItem> = {}): VideoItem {
  return {
    bvid: "BV1x",
    aid: "1",
    cid: 1,
    title: "测试视频",
    cover: "",
    author: "测试 UP",
    author_face: null,
    duration: 60,
    view: 0,
    danmaku: 0,
    reply: null,
    pubdate: 0,
    rcmd_reason: null,
    ...overrides,
  };
}
