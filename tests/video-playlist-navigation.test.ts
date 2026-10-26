import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createMemoryRouter } from "react-router-dom";
import {
  playlistItemFromPgcEpisode,
  playlistItemFromSeasonEpisode,
  shouldReplacePlaylistHistory,
  type PlaylistItem,
} from "../src/features/video/playlistStore";
import type { SeasonEpisode, VideoSeasonEpisode } from "../src/shared/types/video";
import { videoPlayPath } from "../src/features/video/videoRoute";

const root = join(import.meta.dir, "..");

function readSource(file: string): string {
  return readFileSync(join(root, file), "utf8");
}

function route(initialEntries: string[], initialIndex: number) {
  return createMemoryRouter([{ path: "*", element: null }], {
    initialEntries,
    initialIndex,
  });
}

async function switchEpisode(
  router: ReturnType<typeof route>,
  item: PlaylistItem,
  source: Parameters<typeof shouldReplacePlaylistHistory>[0] = "selection",
) {
  await router.navigate(
    videoPlayPath({
      bvid: item.bvid,
      cid: item.cid,
      epId: item.epId,
      title: item.title,
      aid: item.aid,
    }),
    { replace: shouldReplacePlaylistHistory(source) },
  );
}

describe("VOD 选集导航历史", () => {
  test("明确选集与选集队列替换历史，其他来源队列压入新层级", () => {
    expect(shouldReplacePlaylistHistory("selection")).toBe(true);
    expect(shouldReplacePlaylistHistory("sequence")).toBe(true);
    expect(shouldReplacePlaylistHistory("list")).toBe(false);
    expect(shouldReplacePlaylistHistory("feed")).toBe(false);
  });

  test("搜索进入视频后连续换集，Back 回到搜索页而不是上一集", async () => {
    const searchPage = "/video/search?keyword=%E5%8A%A8%E7%94%BB";
    const firstPart = videoPlayPath({ bvid: "BV1parts", cid: 1001 });
    const secondPart = videoPlayPath({ bvid: "BV1parts", cid: 1002 });
    const thirdPart = videoPlayPath({ bvid: "BV1parts", cid: 1003 });
    const router = route([searchPage, firstPart], 1);
    try {
      await router.navigate(secondPart, { replace: shouldReplacePlaylistHistory("selection") });
      expect(router.state.historyAction).toBe("REPLACE");
      await router.navigate(thirdPart, { replace: shouldReplacePlaylistHistory("selection") });
      expect(router.state.location.search).toBe(new URL(thirdPart, "http://localhost").search);
      await router.navigate(-1);
      expect(router.state.location.pathname).toBe("/video/search");
      expect(router.state.location.search).toBe("?keyword=%E5%8A%A8%E7%94%BB");
    } finally {
      router.dispose();
    }
  });

  test("首页进入的上一视频在连续换集后仍完整保留，再 Back 回到首页", async () => {
    const previousVideo = videoPlayPath({
      bvid: "BV1previous",
      cid: 4001,
      title: "上一视频",
      aid: "aidprevious",
    });
    const currentVideo = videoPlayPath({
      bvid: "BV1current",
      cid: 5001,
      title: "当前视频",
      aid: "aidcurrent",
    });
    const secondPart = videoPlayPath({ bvid: "BV1current", cid: 5002 });
    const thirdPart = videoPlayPath({ bvid: "BV1current", cid: 5003 });
    const router = route(["/", previousVideo], 1);
    try {
      await router.navigate(currentVideo);
      expect(router.state.historyAction).toBe("PUSH");
      await router.navigate(secondPart, { replace: shouldReplacePlaylistHistory("selection") });
      await router.navigate(thirdPart, { replace: shouldReplacePlaylistHistory("selection") });

      await router.navigate(-1);
      const previousLocation = new URL(previousVideo, "http://localhost");
      expect(router.state.location.pathname).toBe(previousLocation.pathname);
      expect(router.state.location.search).toBe(previousLocation.search);

      await router.navigate(-1);
      expect(router.state.location.pathname).toBe("/");
      expect(router.state.location.search).toBe("");
    } finally {
      router.dispose();
    }
  });

  test("搜索或推荐换到另一条视频仍压入新层级", async () => {
    const firstVideo = videoPlayPath({ bvid: "BV1first", cid: 1001 });
    const otherVideo = videoPlayPath({ bvid: "BV1other", cid: 2001 });
    for (const source of ["list", "feed"] as const) {
      const router = route(["/video", firstVideo], 1);
      try {
        await router.navigate(otherVideo, { replace: shouldReplacePlaylistHistory(source) });
        expect(router.state.historyAction).toBe("PUSH");
        await router.navigate(-1);
        expect(router.state.location.search).toBe(new URL(firstVideo, "http://localhost").search);
      } finally {
        router.dispose();
      }
    }
  });

  test("PGC 跨 bvid 换集仍属于同一剧，Back 回到来源页", async () => {
    const episodes: SeasonEpisode[] = [1, 2, 3].map((index) => ({
      ep_id: `ep${index}`,
      aid: `aid${index}`,
      cid: 2000 + index,
      bvid: `BV1ep${index}`,
      title: String(index),
      long_title: `第 ${index} 集`,
      cover: "",
      duration: 60,
    }));
    const items = episodes.map(playlistItemFromPgcEpisode);
    const source = "/video?tab=anime";
    const router = route(
      [source, videoPlayPath({ bvid: items[0].bvid, cid: items[0].cid, epId: items[0].epId })],
      1,
    );
    try {
      await switchEpisode(router, items[1]);
      expect(items[0].bvid).not.toBe(items[1].bvid);
      await switchEpisode(router, items[2]);
      await router.navigate(-1);
      expect(router.state.location.pathname).toBe("/video");
      expect(router.state.location.search).toBe("?tab=anime");
    } finally {
      router.dispose();
    }
  });

  test("UGC 合集跨 bvid 换集仍属于同一作品，Back 回到来源页", async () => {
    const episodes: VideoSeasonEpisode[] = [1, 2, 3].map((index) => ({
      bvid: `BV1season${index}`,
      cid: 3000 + index,
      title: `第 ${index} 集`,
      aid: `aid${index}`,
      duration: 60,
      cover: "",
    }));
    const items = episodes.map(playlistItemFromSeasonEpisode);
    const source = "/video?tab=popular";
    const router = route([source, videoPlayPath({ bvid: items[0].bvid, cid: items[0].cid })], 1);
    try {
      await switchEpisode(router, items[1]);
      expect(items[0].bvid).not.toBe(items[1].bvid);
      await switchEpisode(router, items[2]);
      await router.navigate(-1);
      expect(router.state.location.pathname).toBe("/video");
      expect(router.state.location.search).toBe("?tab=popular");
    } finally {
      router.dispose();
    }
  });

  test("生产入口统一使用选集历史规则", () => {
    const sidebar = readSource("src/features/video/VideoSidebar.tsx");
    expect(sidebar).toContain('shouldReplacePlaylistHistory("selection")');

    const player = readSource("src/features/video/VideoPlayerPage.tsx");
    expect(player).toContain(
      "goToPlaylistItem(nextItem, shouldReplacePlaylistHistory(playlistKind))",
    );
    expect(player).toContain(
      "goToPlaylistItem(prevItem, shouldReplacePlaylistHistory(playlistKind))",
    );
    expect(player).toContain('shouldReplacePlaylistHistory("selection")');
    expect(player).toContain(
      'shouldReplacePlaylistHistory(target === latest.episode ? "selection" : current.kind)',
    );
  });
});
