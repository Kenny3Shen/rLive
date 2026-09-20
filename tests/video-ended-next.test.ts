import { describe, expect, test } from "bun:test";
import {
  nextSelectionItem,
  playlistItemFromPgcEpisode,
  playlistItemFromVideoItem,
  videoEndedAction,
  videoEndedTarget,
} from "../src/features/video/playlistStore";
import type { SeasonEpisode, VideoArchive, VideoItem } from "../src/shared/types/video";

/**
 * 「播完进下一集」的回归：目标必须来自当前视频自身的选集，而不是来源队列。
 *
 * 这一条是自动续播（跨分 P/跨集）之后暴露出来的：搜索/投稿队列的列表项没有
 * cid（以 0 占位），取流键由历史续播补出，于是队列里根本没有「正在播的这一集」，
 * 沿队列邻项走就会切到另一个视频；推荐/热门/相关流的队列邻项压根不作为连播
 * 目标，从这些入口进入的选集视频会直接落到相关连播。
 */

/** 搜索/UP 投稿条目：没有 cid，播放页用稿件详情补齐取流键。 */
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
    rcmd_reason: null,
    pubdate: 0,
  };
}

function archive(pages: VideoArchive["pages"]): VideoArchive {
  return {
    bvid: "BV1parts",
    aid: "aidparts",
    cid: pages.at(0)?.cid ?? 0,
    title: "多 P 稿件",
    cover: "",
    desc: "",
    tags: [],
    author: "up",
    author_face: null,
    author_mid: "1",
    author_fans: 0,
    author_videos: 0,
    view: 0,
    danmaku: 0,
    pubdate: 0,
    reply: 0,
    ugc_season: null,
    pages,
  };
}

const PAGES = [
  { page: 1, cid: 1001, part: "P1", duration: 10 },
  { page: 2, cid: 1002, part: "P2", duration: 10 },
  { page: 3, cid: 1003, part: "P3", duration: 10 },
];

const EPISODES: SeasonEpisode[] = [1, 2, 3].map((index) => ({
  ep_id: `ep${index}`,
  aid: `aid${index}`,
  cid: 2000 + index,
  bvid: `BV1ep${index}`,
  title: String(index),
  long_title: `第 ${index} 集`,
  cover: "",
  duration: 60,
}));

describe("播放结束后的下一集", () => {
  test("选集有下一集时进下一集，而不是搜索队列的下一条", () => {
    // 从搜索结果点开多 P 稿件的 P2：队列条目是别的视频，且 cid 都是 0。
    const queue = [
      playlistItemFromVideoItem(searchItem("BV1parts", null), 0),
      playlistItemFromVideoItem(searchItem("BV1other", null), 1),
    ];
    const selection = nextSelectionItem({
      epId: null,
      bvid: "BV1parts",
      cid: 1002,
      archive: archive(PAGES),
    });

    expect(selection?.cid).toBe(1003);
    expect(videoEndedTarget(selection, queue[1])?.cid).toBe(1003);
  });

  test("推荐/相关流队列不自动连播时，选集仍把下一集接上", () => {
    // feed 队列的 getNextAutoPlayItem() 恒为 null（不自动连播），选集必须接管。
    const selection = nextSelectionItem({
      epId: null,
      bvid: "BV1parts",
      cid: 1001,
      archive: archive(PAGES),
    });

    expect(videoEndedTarget(selection, null)?.cid).toBe(1002);
  });

  test("PGC 分集按 ep_id 取下一集，不落到来源队列", () => {
    const selection = nextSelectionItem({
      epId: "ep2",
      bvid: null,
      cid: 2002,
      episodes: EPISODES,
    });

    expect(selection?.epId).toBe("ep3");
    expect(videoEndedTarget(selection, playlistItemFromPgcEpisode(EPISODES[0]))?.epId).toBe("ep3");
  });

  test("UGC 合集按当前稿件定位下一集", () => {
    const season: VideoArchive["ugc_season"] = {
      title: "某合集",
      episodes: [1, 2, 3].map((index) => ({
        bvid: `BV1ep${index}`,
        cid: 3000 + index,
        title: `第 ${index} 集`,
        aid: `aid${index}`,
        duration: 60,
        cover: "",
      })),
    };
    // 合集稿件没有分 P：pages 为空，沿 ugc_season 顺序取下一集。
    const archiveWithSeason: VideoArchive = { ...archive([]), ugc_season: season };
    const selection = nextSelectionItem({
      epId: null,
      bvid: "BV1ep2",
      cid: 3002,
      archive: archiveWithSeason,
    });

    expect(selection?.bvid).toBe("BV1ep3");
    expect(videoEndedTarget(selection, null)?.cid).toBe(3003);
  });

  test("选集播完最后一集才退回来源队列，两者都没有则留给相关连播", () => {
    const last = nextSelectionItem({
      epId: null,
      bvid: "BV1parts",
      cid: 1003,
      archive: archive(PAGES),
    });
    const queueNext = playlistItemFromVideoItem(searchItem("BV1other", 0), 1);

    // 已经是最后 P：选集为 null，来源队列接手。
    expect(last).toBeNull();
    expect(videoEndedTarget(null, queueNext)).toBe(queueNext);
    // 队列也没有下一项 → 交给 videoEndedAction 判定相关连播/停住。
    expect(videoEndedTarget(null, null)).toBeNull();
    expect(videoEndedAction(false, true, false, true)).toBe("related");
  });

  test("单 P 无选集时完全沿来源队列", () => {
    const queueNext = playlistItemFromVideoItem(searchItem("BV1other", 0), 1);
    const selection = nextSelectionItem({
      epId: null,
      bvid: "BV1solo",
      cid: 4001,
      archive: archive([]),
    });

    expect(selection).toBeNull();
    expect(videoEndedTarget(null, queueNext)).toBe(queueNext);
  });

  test("取流键未定时不预设下一集；续播落到中间 P 时仍能接上", () => {
    // 续播查询未落定前 cid 为 0：此时不预设目标，等解析出来再算（ended 的
    // 延迟窗口会重取一次 ref）。若把 0 当成当前项，index 为 -1 会静默失效。
    expect(
      nextSelectionItem({ epId: null, bvid: "BV1parts", cid: 0, archive: archive(PAGES) }),
    ).toBeNull();
    // 解析成 P2（历史续播落点）后，下一集是从 P2 往后数的 P3，不是 P1。
    const resumed = nextSelectionItem({
      epId: null,
      bvid: "BV1parts",
      cid: 1002,
      archive: archive(PAGES),
    });
    expect(resumed?.index).toBe("P3");
  });
});
