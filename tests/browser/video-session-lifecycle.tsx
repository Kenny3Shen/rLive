import "../../src/styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { VideoPlayerPage } from "../../src/features/video/VideoPlayerPage";
import { usePlaylistStore } from "../../src/features/video/playlistStore";
import { useSettingsStore } from "../../src/shared/stores/settingsStore";
import type { VideoArchive, VideoHistoryItem, VideoPlayInfo } from "../../src/shared/types/video";

// 真播放页、query 与路由；只把 IPC 的成功/失败顺序交给回归脚本控制。
Object.assign(window, { isTauri: true });
mockWindows("main");
const archive: VideoArchive = {
  bvid: "BVsession",
  aid: "1",
  cid: 1,
  title: "会话交接",
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
  pages: [1, 2].map((cid) => ({ page: cid, cid, part: `P${cid}`, duration: 600 })),
};
const fixture = {
  manual: false,
  requests: [] as { id: string; resolve: () => void; reject: () => void }[],
  stopped: [] as string[],
  reports: [] as VideoHistoryItem[],
};
mockIPC(
  (command, payload) => {
    if (command === "video_get_archive") return archive;
    if (command === "video_history_find") return null;
    if (command === "video_history_add") {
      fixture.reports.push((payload as { item: VideoHistoryItem }).item);
      return;
    }
    if (command === "video_stop_play") {
      fixture.stopped.push((payload as { sessionIds: { mpd: string } }).sessionIds.mpd);
      return;
    }
    if (command === "video_get_play_info") {
      const id = `session-${fixture.requests.length + 1}`;
      return new Promise<VideoPlayInfo>((resolve, reject) => {
        const request = {
          id,
          resolve: () =>
            resolve({
              mpd_url: `${id}.mpd`,
              video_url: "",
              audio_url: "",
              duration: 600,
              quality: 80,
              quality_label: "1080P",
              codecs: "avc1",
              accept_quality: [],
              session_ids: { video: `${id}-v`, audio: `${id}-a`, mpd: id },
              audio_only: false,
            }),
          reject: () => reject(new Error("测试取流失败")),
        };
        fixture.requests.push(request);
        if (!fixture.manual) request.resolve();
      });
    }
    if (command === "video_get_subtitles") return [];
    if (command === "video_get_danmaku" || command === "video_get_related")
      return { items: [], has_more: false };
    if (command === "video_get_comments")
      return { items: [], has_more: false, all_count: 0, next: 0 };
    return null;
  },
  { shouldMockEvents: true },
);
useSettingsStore.setState({ hydratedFromBackend: true });
usePlaylistStore.setState({ autoPlayNext: false, autoPlayRelated: false, loopPlayback: false });
const router = createMemoryRouter(
  [
    { path: "/video/play", element: <VideoPlayerPage /> },
    { path: "/away", element: <p>已离开</p> },
  ],
  { initialEntries: ["/video/play?bvid=BVsession&cid=1&aid=1"] },
);
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
// 保留同一个对象，manual 和调用记录由脚本直接控制。
Object.assign(window, { vodSessionFixture: Object.assign(fixture, { router }) });
createRoot(document.getElementById("fixture")!).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
