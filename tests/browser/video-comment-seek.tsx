import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { CommentsPanel } from "../../src/features/video/CommentsPanel";
import { VideoPlayerPage } from "../../src/features/video/VideoPlayerPage";
import type { VideoComment } from "../../src/shared/types/video";
import "../../src/styles.css";

// 真实播放页、侧栏与评论，只替换 IPC 和媒体外部引擎。夹具不请求真实站点。
// 由浏览器测试在 invokeCmd 模块边界接管，不修改主窗口只读的原生桥。
const reply: VideoComment = {
  rpid: "2",
  mid: "2",
  uname: "回复作者",
  avatar: "",
  level: 3,
  is_upper: false,
  ctime: 0,
  like: 0,
  rcount: 0,
  message: "回复空降 00:05",
  emotes: [],
  pictures: [],
  replies: [],
};
const comment: VideoComment = {
  ...reply,
  rpid: "1",
  mid: "1",
  uname: "楼主",
  rcount: 1,
  message: "开场00:00 [测试]高能00:03\n长视频1:02:03 非法1:99 外链https://example.com/01:23",
  emotes: [
    {
      text: "[测试]",
      url: "https://example.invalid/comment-emote.svg",
    },
  ],
  replies: [{ ...reply, message: "预览空降 00:04" }],
};
Object.assign(window, {
  commentSeekInvoke: (command: string) => {
    switch (command) {
      case "video_get_archive":
        return {
          bvid: "BV1comment",
          aid: "123",
          cid: 456,
          title: "评论空降回归",
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
          reply: 1,
          ugc_season: null,
          pages: [],
        };
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
      case "video_get_comments":
        return { items: [comment], has_more: false, all_count: 1, next: 0 };
      case "video_get_comment_replies":
        return { items: [reply], has_more: false, all_count: 1 };
      case "video_get_subtitles":
        return [];
      case "video_get_danmaku":
        return { entries: [], segment_index: 1 };
      case "video_get_related":
        return { items: [], has_more: false };
      default:
        return null;
    }
  },
});

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const router = createMemoryRouter([{ path: "/video/play", element: <VideoPlayerPage /> }], {
  initialEntries: ["/video/play?bvid=BV1comment&aid=123&cid=456"],
});
const root = createRoot(document.getElementById("fixture")!);
root.render(
  <QueryClientProvider client={client}>
    <RouterProvider router={router} />
  </QueryClientProvider>,
);

Object.assign(window, {
  commentSeekFixture: {
    // 验证复用方未提供 onSeek 时（短视频现状）没有失效的空降按钮。
    renderWithoutSeek() {
      root.render(
        <QueryClientProvider client={client}>
          <CommentsPanel aid="123" />
        </QueryClientProvider>,
      );
    },
    renderMobileComments() {
      Object.defineProperty(navigator, "userAgent", { configurable: true, value: "Android" });
      root.render(
        <QueryClientProvider client={client}>
          <CommentsPanel
            aid="123"
            onSeek={(seconds) => {
              window.dispatchEvent(new CustomEvent("fixture-seek", { detail: seconds }));
            }}
          />
        </QueryClientProvider>,
      );
    },
  },
});
