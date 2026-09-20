import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { VideoPlayerPage } from "../../src/features/video/VideoPlayerPage";
import { usePlaylistStore } from "../../src/features/video/playlistStore";
import type { VideoArchive, VideoHistoryItem } from "../../src/shared/types/video";

/**
 * 「自动续播 → 播完进下一集」的真实播放页夹具。
 *
 * 场景取自真实用户路径：从搜索/UP 投稿队列点开一个多 P 稿件，观看历史让它续播
 * 到 P2。搜索条目没有 cid，所以链接只带 bvid（cid=0），列表项以 `${bvid}_0`
 * 占位；取流键由历史续播补成 1002。修复前 played-ended 只沿来源队列取下一项，
 * 会切到搜索队列的下一条（另一个稿件）；修复后进 P3。
 *
 * 桩只覆盖 IPC 与 DASH 外部引擎（与 video-autoplay 同一套），播放页本身、
 * 查询、播放列表与导航都是真实的。
 */
Object.assign(window, { isTauri: true });
mockWindows("main");
const archive: VideoArchive = {
  bvid: "BV1parts",
  aid: "456",
  cid: 1001,
  title: "自动续播回归",
  cover: "",
  desc: "",
  tags: [],
  author: "测试",
  author_face: null,
  author_mid: "1",
  author_fans: 0,
  author_videos: 0,
  view: 0,
  danmaku: 0,
  pubdate: 0,
  reply: 0,
  ugc_season: null,
  pages: [
    { page: 1, cid: 1001, part: "第一集", duration: 10 },
    { page: 2, cid: 1002, part: "第二集", duration: 10 },
    { page: 3, cid: 1003, part: "第三集", duration: 10 },
  ],
};
/** 历史停在 P2 的中间：既不是首 P，也不是片尾（否则续播判定会从头播）。 */
const history: VideoHistoryItem = {
  kind: "ugc",
  oid: "BV1parts",
  title: "自动续播回归",
  cover: "",
  author: "测试",
  part_title: "第二集",
  bvid: "BV1parts",
  cid: 1002,
  ep_id: "",
  aid: "456",
  progress: 4,
  duration: 10,
  watched_at: 0,
};
mockIPC(
  (command) => {
    switch (command) {
      case "video_get_archive":
        return archive;
      case "video_history_find":
        return history;
      case "video_history_add":
        return null;
      case "video_get_play_info":
        return {
          mpd_url: "test.mpd",
          video_url: "",
          audio_url: "",
          duration: 10,
          quality: 80,
          quality_label: "测试",
          codecs: "avc1",
          accept_quality: [],
          session_ids: { video: "v", audio: "a", mpd: "m" },
          audio_only: false,
        };
      case "video_get_subtitles":
        return [];
      case "video_get_danmaku":
      case "video_get_related":
        return { items: [], has_more: false };
      case "video_get_comments":
        return { items: [], has_more: false, all_count: 0, next: 0 };
      default:
        return null;
    }
  },
  { shouldMockEvents: true },
);
usePlaylistStore.setState({ autoPlayNext: true, autoPlayRelated: false, loopPlayback: false });

// 搜索/UP 投稿队列的形态：条目没有 cid（0 占位），当前稿件后面还跟着别的稿件。
const searchQueue = [
  { bvid: "BV1parts", aid: "456", cid: null, title: "自动续播回归" },
  { bvid: "BV1other", aid: "789", cid: null, title: "搜索结果的下一部" },
].map((item, index) => ({
  id: `${item.bvid}_${item.cid ?? 0}`,
  bvid: item.bvid,
  cid: item.cid ?? 0,
  epId: null,
  aid: item.aid,
  title: item.title,
  index: String(index + 1),
  duration: 10,
}));
usePlaylistStore.getState().setPlaylist(searchQueue, "BV1parts_0", "sequence");

const router = createMemoryRouter(
  [
    { path: "/video/play", element: <VideoPlayerPage /> },
    { path: "/away", element: <p>已离开播放页</p> },
  ],
  // 点搜索卡：链接只带 bvid（条目没有 cid），cid 由历史续播补成 P2。
  { initialEntries: ["/video/play?bvid=BV1parts&aid=456"] },
);
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
createRoot(document.getElementById("fixture")!).render(
  <QueryClientProvider client={client}>
    <RouterProvider router={router} />
  </QueryClientProvider>,
);
Object.assign(window, { resumeNextFixture: { router, store: usePlaylistStore } });
