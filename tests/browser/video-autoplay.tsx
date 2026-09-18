import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { VideoPlayerPage } from "../../src/features/video/VideoPlayerPage";
import { usePlaylistStore } from "../../src/features/video/playlistStore";
import type { VideoArchive } from "../../src/shared/types/video";

// 真实播放页、查询、播放列表与导航；仅 IPC 和 DASH 外部引擎使用桩。
Object.assign(window, { isTauri: true });
mockWindows("main");
const archive: VideoArchive = {
  bvid: "BV1xx411c7mD",
  aid: "456",
  cid: 123,
  title: "自动切集回归",
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
    { page: 1, cid: 123, part: "第一集", duration: 10 },
    { page: 2, cid: 124, part: "第二集", duration: 10 },
  ],
};
mockIPC(
  (command) => {
    switch (command) {
      case "video_get_archive":
        return archive;
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
const router = createMemoryRouter(
  [
    { path: "/video/play", element: <VideoPlayerPage /> },
    { path: "/away", element: <p>已离开播放页</p> },
  ],
  { initialEntries: ["/video/play?bvid=BV1xx411c7mD&cid=123&aid=456"] },
);
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
createRoot(document.getElementById("fixture")!).render(
  <QueryClientProvider client={client}>
    <RouterProvider router={router} />
  </QueryClientProvider>,
);
Object.assign(window, { autoplayFixture: { router, store: usePlaylistStore } });
