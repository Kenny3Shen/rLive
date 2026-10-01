import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { Shell } from "../../src/app/layout/Shell";
import { VideoPage } from "../../src/features/video/VideoPage";
import { VideoPlayerPage } from "../../src/features/video/VideoPlayerPage";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import type { VideoArchive, VideoListPage } from "../../src/shared/types/video";

/**
 * 真实 `Shell` + 真实视频发现页/播放页的外壳夹具。
 *
 * 用来验证「播放页 ⇄ 视频页」的整页转场（`PageZoom`）与播放页内的侧栏布局：
 * 只有经过 Shell 的沉浸式分支，移动端才会走 Zoom 那一层而不是 `PagePan`，
 * 因此单元级夹具（只挂播放页）看不到这条路径。
 */
Object.assign(window, { isTauri: true });
mockWindows("main");

const archive: VideoArchive = {
  bvid: "BV1shell",
  aid: "456",
  cid: 1001,
  title: "外壳转场回归",
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
  reply: 0,
  pubdate: 0,
  ugc_season: null,
  pages: [{ page: 1, cid: 1001, part: "第一集", duration: 10 }],
};

const recommendPage: VideoListPage = {
  items: Array.from({ length: 12 }).map((_, index) => ({
    bvid: `BV1shell${index}`,
    aid: String(100 + index),
    cid: 1001,
    title: `回归条目 ${index + 1}`,
    cover: "",
    author: "测试",
    duration: 120,
    pubdate: 0,
    view: 1000 + index,
    danmaku: 10,
    dimension: { width: 1920, height: 1080, rotate: 0 },
  })),
  has_more: false,
};

mockIPC(
  (command) => {
    switch (command) {
      case "video_get_recommend":
      case "video_get_popular":
      case "video_get_zone":
        return recommendPage;
      case "video_zone_list":
        return [];
      case "video_get_pgc_index":
        return { items: [], has_more: false };
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
      case "image_proxy_url":
        return "";
      default:
        return null;
    }
  },
  { shouldMockEvents: true },
);

const router = createMemoryRouter(
  [
    {
      element: <Shell />,
      children: [
        { path: "/video", element: <VideoPage /> },
        { path: "/video/play", element: <VideoPlayerPage /> },
        { path: "/", element: <p>首页</p> },
      ],
    },
  ],
  { initialEntries: ["/video"] },
);
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
createRoot(document.getElementById("fixture")!).render(
  <QueryClientProvider client={client}>
    <TooltipProvider>
      <RouterProvider router={router} />
    </TooltipProvider>
  </QueryClientProvider>,
);
Object.assign(window, { shellFixture: { router } });
