import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { VideoPlayerPage } from "../../src/features/video/VideoPlayerPage";
import { usePlaylistStore } from "../../src/features/video/playlistStore";
import { useSettingsStore } from "../../src/shared/stores/settingsStore";
import type { VideoArchive } from "../../src/shared/types/video";

/**
 * 「下一分集预加载只在当前集末片进缓冲之后」的真实播放页夹具。
 *
 * 真实播放页、查询与播放列表都照旧，只有两处是桩：IPC（记录 `video_preload_next`
 * 的调用）与 DASH 引擎（`window.nextPreloadEngine.bufferUpTo()` 手动推进缓冲末端）。
 * 缓冲末端与 `progress` 事件都由夹具控制，因此「闸门什么时候开」是可断言的。
 */
Object.assign(window, { isTauri: true });
mockWindows("main");

const archive: VideoArchive = {
  bvid: "BV1preload2",
  aid: "456",
  cid: 123,
  title: "下一分集预加载回归",
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

/** `video_preload_next` 的调用记录：断言闸门开合的唯一样本。 */
const preloadCalls: unknown[] = [];
const ipcCalls: string[] = [];
Object.assign(window, { nextPreloadCalls: preloadCalls, nextPreloadIpcCalls: ipcCalls });

/**
 * 每次 `video_get_play_info` 都返回一份新的取流地址，与真实代理会话一致
 * （每轮都新绑端口）。重试/换画质因此确实会换掉闸门记账的会话身份。
 */
let playInfoCalls = 0;

mockIPC(
  (command, payload) => {
    ipcCalls.push(command);
    switch (command) {
      case "video_get_archive":
        return archive;
      case "video_history_find":
        return null;
      case "video_history_add":
        return null;
      case "video_get_play_info":
        playInfoCalls += 1;
        return {
          mpd_url: `test-${playInfoCalls}.mpd`,
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
      case "video_preload_next":
        preloadCalls.push(payload);
        return true;
      case "video_stop_play":
        return null;
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

// 预加载开关默认关闭，这条回归要覆盖的是开启后的触发时机。
useSettingsStore.setState({ videoNextEpisodePreload: true, hydratedFromBackend: true });
usePlaylistStore.setState({ autoPlayNext: true, autoPlayRelated: false, loopPlayback: false });

const router = createMemoryRouter(
  [
    { path: "/video/play", element: <VideoPlayerPage /> },
    { path: "/video", element: <p>视频首页</p> },
  ],
  { initialEntries: ["/video/play?bvid=BV1preload2&cid=123&aid=456"] },
);
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
createRoot(document.getElementById("fixture")!).render(
  <QueryClientProvider client={client}>
    <RouterProvider router={router} />
  </QueryClientProvider>,
);
Object.assign(window, {
  nextPreloadFixture: { router, store: usePlaylistStore, settings: useSettingsStore },
});
