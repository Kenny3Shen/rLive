import { describe, expect, test } from "bun:test";
import {
  playlistContainsCurrentItem,
  playlistItemFromArchivePage,
  playlistItemFromSeasonEpisode,
  playlistItemFromVideoItem,
  type PlaylistItem,
} from "../src/features/video/playlistStore";
import type { VideoItem } from "../src/shared/types/video";

function searchItem(bvid: string, cid: number | null): VideoItem {
  return {
    bvid,
    aid: `aid${bvid}`,
    cid,
    title: `${bvid} 标题`,
    cover: "",
    author: "up",
    author_face: null,
    duration: 60,
    view: 1,
    danmaku: 0,
    pubdate: 0,
    rcmd_reason: null,
  };
}

const SEASON_EPISODE = {
  bvid: "BV1season",
  cid: 9002,
  title: "合集分集",
  aid: "aidseason",
  duration: 61,
  cover: "",
};

const ARCHIVE_PAGE = {
  page: 1,
  cid: 9003,
  part: "分 P 标题",
  duration: 62,
};

describe("video playlist leftover guard", () => {
  test("reports a leftover list when the entering video is absent", () => {
    // 上一次搜索会话的快照：currentId 停在旧视频上，「下一个」指向它后面那项。
    const leftover = [0, 1].map((index) =>
      playlistItemFromVideoItem(searchItem(`BV1old${index}`, null), index),
    );
    // 推荐流/相关视频点开的单 P 无合集视频：URL 带真实 cid。
    expect(playlistContainsCurrentItem(leftover, "BV1fresh", 8001)).toBe(false);
  });

  test("keeps the search/issuer snapshot when it holds the entering video at cid 0", () => {
    // 搜索/投稿条目不带 cid：列表项 id 以 0 结尾，点卡进入的链接同样不带 cid。
    const snapshot = [0, 1, 2].map((index) =>
      playlistItemFromVideoItem(searchItem(index === 0 ? "BV1search" : `BV1other${index}`, null), index),
    );
    expect(playlistContainsCurrentItem(snapshot, "BV1search", 0)).toBe(true);
  });

  test("matches the entering video by its real cid for structured lists", () => {
    const seasonItems: PlaylistItem[] = [playlistItemFromSeasonEpisode(SEASON_EPISODE, 0)];
    expect(playlistContainsCurrentItem(seasonItems, "BV1season", 9002)).toBe(true);
    // 合集列表不含其它集时（连播跳到列表外的视频）不命中。
    expect(playlistContainsCurrentItem(seasonItems, "BV1season", 9004)).toBe(false);

    const pageItems: PlaylistItem[] = [
      playlistItemFromArchivePage("BV1parts", "aidparts", ARCHIVE_PAGE),
    ];
    expect(playlistContainsCurrentItem(pageItems, "BV1parts", 9003)).toBe(true);
  });

  test("treats an empty list or a cid-only deep link as no context", () => {
    expect(playlistContainsCurrentItem([], "BV1any", 8001)).toBe(false);
    // 直链 ?cid=123 不带 bvid：id 前缀为空，不会命中任何列表项。
    const items = [playlistItemFromVideoItem(searchItem("BV1any", null), 0)];
    expect(playlistContainsCurrentItem(items, null, 0)).toBe(false);
  });
});
