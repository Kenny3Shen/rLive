import { describe, expect, test } from "bun:test";
import {
  nextSelectionItem,
  playlistItemFromPgcEpisode,
  playlistItemFromVideoItem,
  videoEndedAction,
  videoEndedTargets,
} from "../src/features/video/playlistStore";
import type { SeasonEpisode, VideoArchive, VideoItem } from "../src/shared/types/video";
import { videoItem } from "./helpers/video";

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
  return videoItem({
    bvid,
    aid: `aid${bvid}`,
    cid,
    title: `${bvid} 标题`,
  });
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
  {
    page: 1,
    cid: 1001,
    part: "P1",
    duration: 10,
  },
  {
    page: 2,
    cid: 1002,
    part: "P2",
    duration: 10,
  },
  {
    page: 3,
    cid: 1003,
    part: "P3",
    duration: 10,
  },
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
const PREFS = {
  loopPlayback: false,
  autoPlayNext: true,
  autoPlayRelated: true,
};
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
    const targets = videoEndedTargets(selection, queue[1], "list");
    expect(targets.episode?.cid).toBe(1003);
    expect(targets.list?.bvid).toBe("BV1other");
  });
  test("PGC 分集按 ep_id 取下一集，不落到来源队列", () => {
    const selection = nextSelectionItem({
      epId: "ep2",
      bvid: null,
      cid: 2002,
      episodes: EPISODES,
    });
    expect(selection?.epId).toBe("ep3");
    expect(
      videoEndedTargets(selection, playlistItemFromPgcEpisode(EPISODES[0]), "sequence").episode
        ?.epId,
    ).toBe("ep3");
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
    const archiveWithSeason: VideoArchive = {
      ...archive([]),
      ugc_season: season,
    };
    const selection = nextSelectionItem({
      epId: null,
      bvid: "BV1ep2",
      cid: 3002,
      archive: archiveWithSeason,
    });
    expect(selection?.bvid).toBe("BV1ep3");
    expect(videoEndedTargets(selection, null, "sequence").episode?.cid).toBe(3003);
  });
  test("选集播完最后一集才退回来源队列，两者都没有则留给相关连播", () => {
    const last = nextSelectionItem({
      epId: null,
      bvid: "BV1parts",
      cid: 1003,
      archive: archive(PAGES),
    });
    const queueNext = playlistItemFromVideoItem(searchItem("BV1other", 0), 1);

    // 已经是最后 P：选集为 null，搜索列表的下一条作为连播目标。
    expect(last).toBeNull();
    expect(videoEndedTargets(null, queueNext, "list")).toEqual({
      episode: null,
      list: queueNext,
    });
    // 队列也没有下一项 → 交给 videoEndedAction 判定相关连播/停住。
    expect(videoEndedTargets(null, null, "list")).toEqual({
      episode: null,
      list: null,
    });
    expect(
      videoEndedAction({
        ...PREFS,
        hasEpisode: false,
        hasListItem: false,
        relatedAvailable: true,
      }),
    ).toBe("related");
  });
  test("搜索/UP 投稿列表的下一条归自动连播：关掉自动连播就停住", () => {
    const list = {
      hasEpisode: false,
      hasListItem: true,
      relatedAvailable: true,
    };
    expect(
      videoEndedAction({
        ...PREFS,
        ...list,
      }),
    ).toBe("list");
    // 只关自动切集不影响列表连播；关掉自动连播则不再跳到下一条搜索结果。
    expect(
      videoEndedAction({
        ...PREFS,
        ...list,
        autoPlayNext: false,
      }),
    ).toBe("list");
    expect(
      videoEndedAction({
        ...PREFS,
        ...list,
        autoPlayRelated: false,
      }),
    ).toBe("stop");
    expect(
      videoEndedAction({
        ...PREFS,
        ...list,
        autoPlayNext: false,
        autoPlayRelated: false,
      }),
    ).toBe("stop");
  });
  test("选集下一集归自动切集，循环优先于两者", () => {
    const episode = {
      hasEpisode: true,
      hasListItem: true,
      relatedAvailable: true,
    };
    expect(
      videoEndedAction({
        ...PREFS,
        ...episode,
      }),
    ).toBe("next");
    expect(
      videoEndedAction({
        ...PREFS,
        ...episode,
        autoPlayRelated: false,
      }),
    ).toBe("next");
    // 关掉自动切集：同一作品不再换集，由自动连播决定是否换到列表下一条。
    expect(
      videoEndedAction({
        ...PREFS,
        ...episode,
        autoPlayNext: false,
      }),
    ).toBe("list");
    expect(
      videoEndedAction({
        ...PREFS,
        ...episode,
        autoPlayNext: false,
        autoPlayRelated: false,
      }),
    ).toBe("stop");
    expect(
      videoEndedAction({
        ...PREFS,
        ...episode,
        loopPlayback: true,
      }),
    ).toBe("loop");
  });
  test("推荐/相关流与选集队列的邻项都不算列表连播目标", () => {
    const queueNext = playlistItemFromVideoItem(searchItem("BV1other", 0), 1);
    expect(videoEndedTargets(null, queueNext, "feed")).toEqual({
      episode: null,
      list: null,
    });
    expect(videoEndedTargets(null, queueNext, "sequence")).toEqual({
      episode: queueNext,
      list: null,
    });
  });
  test("PGC 没有相关视频：自动连播开着也停住", () => {
    expect(
      videoEndedAction({
        ...PREFS,
        hasEpisode: false,
        hasListItem: false,
        relatedAvailable: false,
      }),
    ).toBe("stop");
  });
  test("取流键未定时不预设下一集；续播落到中间 P 时仍能接上", () => {
    // 续播查询未落定前 cid 为 0：此时不预设目标，等解析出来再算（ended 的
    // 延迟窗口会重取一次 ref）。若把 0 当成当前项，index 为 -1 会静默失效。
    expect(
      nextSelectionItem({
        epId: null,
        bvid: "BV1parts",
        cid: 0,
        archive: archive(PAGES),
      }),
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
