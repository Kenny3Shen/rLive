import { describe, expect, test } from "bun:test";
import {
  playlistContainsCurrentItem,
  playlistItemFromArchivePage,
  playlistItemFromSeasonEpisode,
  playlistItemFromVideoItem,
  videoEndedAction,
  videoSwipeDirection,
  videoWheelDirection,
  type VideoWheelGesture,
  type PlaylistItem,
  usePlaylistStore,
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
    duration: 60,
    view: 1,
    danmaku: 0,
    rcmd_reason: null,
    pubdate: 0,
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
      playlistItemFromVideoItem(
        searchItem(index === 0 ? "BV1search" : `BV1other${index}`, null),
        index,
      ),
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

describe("video ended action", () => {
  test("lets looping win over auto play next", () => {
    // 循环播放是「就看这一集」的显式意图,不能被连播带走(哪怕还有下一集)。
    expect(videoEndedAction(true, true, true)).toBe("loop");
    expect(videoEndedAction(true, false, false)).toBe("loop");
  });

  test("advances only when auto play next has somewhere to go", () => {
    expect(videoEndedAction(false, true, true)).toBe("next");
    // 最后一集:连播退化成停住,而不是重播。
    expect(videoEndedAction(false, true, false)).toBe("stop");
  });

  test("stops when both preferences are off", () => {
    expect(videoEndedAction(false, false, true)).toBe("stop");
  });
});

test("竖屏上下滑只在越过距离阈值且方向明确时切换", () => {
  expect(videoSwipeDirection(4, -80)).toBe(1);
  expect(videoSwipeDirection(-4, 80)).toBe(-1);
  expect(videoSwipeDirection(0, 47)).toBeNull();
  expect(videoSwipeDirection(0, 48)).toBe(-1);
  expect(videoSwipeDirection(80, -60)).toBeNull();
  expect(videoSwipeDirection(40, 50)).toBeNull();
  expect(videoSwipeDirection(0, 14, 12)).toBe(-1);
});

test("UP 投稿队列切回普通来源或清空后不遗留来源标记", () => {
  const before = usePlaylistStore.getState();
  const item = playlistItemFromVideoItem(searchItem("BV1src", 1), 0);
  try {
    usePlaylistStore.getState().setPlaylist([item], item.id, "sequence", {
      mid: "42",
      name: "某UP",
    });
    expect(usePlaylistStore.getState().uploader).toEqual({ mid: "42", name: "某UP" });
    usePlaylistStore.getState().setPlaylist([item], item.id, "feed");
    expect(usePlaylistStore.getState().uploader).toBeNull();
    usePlaylistStore.getState().setPlaylist([item], item.id, "sequence", {
      mid: "42",
      name: "某UP",
    });
    usePlaylistStore.getState().clearPlaylist();
    expect(usePlaylistStore.getState().uploader).toBeNull();
    expect(usePlaylistStore.getState().getCurrentPosition()).toBeNull();
  } finally {
    usePlaylistStore.setState(before, true);
  }
});

test("推荐流结束时不把下一条当作自动播放下一集", () => {
  const before = usePlaylistStore.getState();
  const items = [0, 1].map((index) =>
    playlistItemFromVideoItem(searchItem(`BV1feed${index}`, null), index),
  );
  try {
    usePlaylistStore.getState().setPlaylist(items, items[0].id, "feed");
    expect(usePlaylistStore.getState().getNextItem()).toEqual(items[1]);
    expect(usePlaylistStore.getState().getNextAutoPlayItem()).toBeNull();
    usePlaylistStore.getState().setPlaylist(items, items[0].id, "sequence");
    expect(usePlaylistStore.getState().getNextAutoPlayItem()).toEqual(items[1]);
  } finally {
    usePlaylistStore.setState(before, true);
  }
});

test("滚轮累积小增量且同一段惯性只换一条，停顿后可以反向", () => {
  const gesture: VideoWheelGesture = { lastTime: -Infinity, distance: 0, committed: false };
  expect(videoWheelDirection(gesture, 20, 0)).toBeNull();
  expect(videoWheelDirection(gesture, 40, 20)).toBe(1);
  expect(videoWheelDirection(gesture, 160, 50)).toBeNull();
  expect(videoWheelDirection(gesture, -80, 100)).toBeNull();
  expect(videoWheelDirection(gesture, -80, 500)).toBe(-1);
});
