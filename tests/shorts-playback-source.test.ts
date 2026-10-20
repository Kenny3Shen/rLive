import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { mockIPC } from "@tauri-apps/api/mocks";
import { BILIBILI_SHORTS_SOURCE } from "../src/features/shorts/shortsPlaybackSource";
import { VIDEO_HISTORY_QUERY_KEY } from "../src/features/video/videoHistory";
import type { VideoItem, VideoPlayInfo } from "../src/shared/types/video";
const video: VideoItem = {
  bvid: "BV-one",
  aid: "1",
  cid: 123,
  title: "测试视频",
  cover: "cover",
  author: "作者",
  author_face: null,
  duration: 60,
  view: 0,
  danmaku: 0,
  pubdate: 0,
  rcmd_reason: null,
};
const dash: VideoPlayInfo = {
  mpd_url: "http://127.0.0.1/dash",
  video_url: "http://127.0.0.1/video",
  audio_url: "http://127.0.0.1/audio",
  duration: 61,
  quality: 80,
  quality_label: "1080P",
  codecs: "avc1",
  accept_quality: [],
  audio_only: false,
  session_ids: {
    mpd: "mpd-1",
    video: "video-1",
    audio: "audio-1",
  },
};
// 仅桩 IPC 边界，不启动 WebView、浏览器或真实代理；每例恢复全局，避免污染别的测试。
// 抖音短视频已下线，这里只剩 B 站适配器：多余的 IPC 直接判失败，防止旧取流命令复活。
describe("短视频平台适配器", () => {
  let windowDescriptor: PropertyDescriptor | undefined;
  let tauriDescriptor: PropertyDescriptor | undefined;
  const calls: {
    cmd: string;
    payload: unknown;
  }[] = [];
  beforeEach(() => {
    windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
    tauriDescriptor = Object.getOwnPropertyDescriptor(globalThis, "isTauri");
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {},
    });
    Object.defineProperty(globalThis, "isTauri", {
      configurable: true,
      value: true,
    });
    calls.length = 0;
    mockIPC((cmd, payload) => {
      calls.push({
        cmd,
        payload,
      });
      if (cmd === "video_get_play_info") return dash;
      // 抖音取流命令随下线一起删除；若适配器退回旧命令，这里会直接失败。
      if (cmd.startsWith("douyin_")) throw new Error(`已下线的抖音命令被调用：${cmd}`);
      return undefined;
    });
  });
  afterEach(() => {
    if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
    else Reflect.deleteProperty(globalThis, "window");
    if (tauriDescriptor) Object.defineProperty(globalThis, "isTauri", tauriDescriptor);
    else Reflect.deleteProperty(globalThis, "isTauri");
  });
  test("B 站取流开启媒体缓存，停止时透传完整会话身份", async () => {
    expect(await BILIBILI_SHORTS_SOURCE.load(video)).toBe(dash);
    await BILIBILI_SHORTS_SOURCE.stop(dash);
    expect(calls).toEqual([
      {
        cmd: "video_get_play_info",
        payload: {
          request: {
            bvid: video.bvid,
            cid: video.cid,
            ep_id: null,
            qn: null,
            audio_only: false,
            media_cache: true,
          },
        },
      },
      {
        cmd: "video_stop_play",
        payload: {
          sessionIds: dash.session_ids,
        },
      },
    ]);
  });
  test("B 站适配器写观看历史，并失效原历史查询", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(VIDEO_HISTORY_QUERY_KEY, []);
    let finish!: () => void;
    const invalidated = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const unsubscribe = queryClient.getQueryCache().subscribe(() => {
      if (queryClient.getQueryState(VIDEO_HISTORY_QUERY_KEY)?.isInvalidated) finish();
    });
    try {
      BILIBILI_SHORTS_SOURCE.reportProgress?.(video, dash, 25, 123456, queryClient);
      await invalidated;
      expect(calls).toEqual([
        {
          cmd: "video_history_add",
          payload: {
            item: {
              kind: "ugc",
              oid: video.bvid,
              title: video.title,
              cover: video.cover,
              author: video.author,
              part_title: "",
              bvid: video.bvid,
              cid: video.cid,
              ep_id: "",
              aid: video.aid,
              progress: 25,
              duration: 61,
              watched_at: 123456,
            },
          },
        },
      ]);
    } finally {
      unsubscribe();
      queryClient.clear();
    }
  });
});
