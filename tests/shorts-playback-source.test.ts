import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { mockIPC } from "@tauri-apps/api/mocks";
import {
  BILIBILI_SHORTS_SOURCE,
  DOUYIN_SHORTS_SOURCE,
} from "../src/features/shorts/shortsPlaybackSource";
import { shortsItemKey } from "../src/features/shorts/shortsFeed";
import type { DouyinVideoItem, DouyinVideoPlayback } from "../src/features/shorts/douyinVideoApi";
import {
  SHORTS_RETENTION_EMPTY,
  shortsRetentionExpire,
  shortsRetentionPark,
  shortsRetentionPeek,
  shortsRetentionRelease,
  type ShortsRetentionState,
} from "../src/features/shorts/shortsSessionRetention";
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
  session_ids: { mpd: "mpd-1", video: "video-1", audio: "audio-1" },
};
const douyin: DouyinVideoItem = {
  id: "90071992547409931",
  title: "抖音测试",
  author: "作者",
  cover: "cover",
  width: 720,
  height: 1280,
  duration: 13.5,
  share_url: "https://www.douyin.com/video/test",
};
const native: DouyinVideoPlayback = {
  item: douyin,
  play_url: "http://127.0.0.1/native",
  session_id: "douyin-session-1",
};

// 仅桩 IPC 边界，不启动 WebView、浏览器或真实代理；每例恢复全局，避免污染别的测试。
describe("短视频平台适配器", () => {
  let windowDescriptor: PropertyDescriptor | undefined;
  let tauriDescriptor: PropertyDescriptor | undefined;
  const calls: { cmd: string; payload: unknown }[] = [];
  beforeEach(() => {
    windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
    tauriDescriptor = Object.getOwnPropertyDescriptor(globalThis, "isTauri");
    Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
    Object.defineProperty(globalThis, "isTauri", { configurable: true, value: true });
    calls.length = 0;
    mockIPC((cmd, payload) => {
      calls.push({ cmd, payload });
      if (cmd === "video_get_play_info") return dash;
      if (cmd === "douyin_video_resolve") return native;
      return undefined;
    });
  });
  afterEach(() => {
    if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
    else Reflect.deleteProperty(globalThis, "window");
    if (tauriDescriptor) Object.defineProperty(globalThis, "isTauri", tauriDescriptor);
    else Reflect.deleteProperty(globalThis, "isTauri");
  });

  test("B 站沿用原条目键、DASH 元数据及可播放条件", () => {
    const source = BILIBILI_SHORTS_SOURCE;
    expect(source.kind).toBe("dash");
    expect(source.key(video)).toBe(shortsItemKey(video));
    expect(source.canPlay(video)).toBe(true);
    expect(source.canPlay({ ...video, cid: null })).toBe(false);
    expect(source.canPlay({ ...video, cid: 0 })).toBe(false);
    expect(source.canPlay({ ...video, bvid: "" })).toBe(false);
    expect(source.sessionId(dash)).toBe("mpd-1");
    expect(source.url(dash)).toBe(dash.mpd_url);
    expect(source.duration(dash)).toBe(61);
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
      { cmd: "video_stop_play", payload: { sessionIds: dash.session_ids } },
    ]);
  });

  test("抖音身份保留字符串命名空间，元数据无需伪造 bvid/cid", async () => {
    const source = DOUYIN_SHORTS_SOURCE;
    expect(source.id).not.toBe(BILIBILI_SHORTS_SOURCE.id);
    expect(source.kind).toBe("native");
    expect(source.key(douyin)).toBe(`douyin:${douyin.id}`);
    expect(source.canPlay(douyin)).toBe(true);
    expect(source.canPlay({ ...douyin, id: " " })).toBe(false);
    expect(source.sessionId(native)).toBe(native.session_id);
    expect(source.url(native)).toBe(native.play_url);
    expect(source.duration(native)).toBe(13.5);
    expect(source.reportProgress).toBeUndefined();
    expect(await source.load(douyin)).toBe(native);
    await source.stop(native);
    expect(calls).toEqual([
      { cmd: "douyin_video_resolve", payload: { input: douyin.id, requireLogin: true } },
      { cmd: "douyin_video_stop", payload: { sessionId: native.session_id } },
    ]);
  });

  test("只有 B 站适配器写观看历史，并失效原历史查询", async () => {
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
      DOUYIN_SHORTS_SOURCE.reportProgress?.(douyin, native, 10, 123456, queryClient);
      expect(calls).toHaveLength(1);
    } finally {
      unsubscribe();
      queryClient.clear();
    }
  });
});

describe("原生短视频共用单保留位", () => {
  test("只读 peek 与幂等 release 保留原生播放信息，不访问 B 站字段", () => {
    const { state } = shortsRetentionPark(SHORTS_RETENTION_EMPTY, "douyin:one", native, 1000);
    expect(shortsRetentionPeek(state, "douyin:one", 1001)).toBe(native);
    expect(shortsRetentionPeek(state, "douyin:one", 1002)).toBe(native);
    const released = shortsRetentionRelease(state, "douyin:one");
    expect(released.released?.playInfo).toBe(native);
    expect(released.state).toBe(SHORTS_RETENTION_EMPTY);
    expect(shortsRetentionRelease(released.state, "douyin:one").released).toBeNull();
    expect(shortsRetentionExpire(released.state, 16000).expired).toBeNull();
  });

  test("K=1 顶替与默认 15 秒 TTL，回收信息只交出一次", () => {
    let state: ShortsRetentionState<DouyinVideoPlayback> = SHORTS_RETENTION_EMPTY;
    state = shortsRetentionPark(state, "douyin:one", native, 1000).state;
    const again = shortsRetentionPark(state, "douyin:one", native, 5000);
    expect(again.state).toBe(state);
    expect(again.displaced).toBeNull();
    const next = { ...native, session_id: "douyin-session-2" };
    const replaced = shortsRetentionPark(state, "douyin:two", next, 2000);
    expect(replaced.displaced?.playInfo).toBe(native);
    expect(shortsRetentionPeek(replaced.state, "douyin:one", 2001)).toBeNull();
    expect(shortsRetentionPeek(replaced.state, "douyin:two", 16999)).toBe(next);
    expect(shortsRetentionPeek(replaced.state, "douyin:two", 17000)).toBeNull();
    const expired = shortsRetentionExpire(replaced.state, 17000);
    expect(expired.expired?.playInfo).toBe(next);
    expect(shortsRetentionExpire(expired.state, 17001).expired).toBeNull();
  });
});
