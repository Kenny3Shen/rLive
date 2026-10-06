import { describe, expect, test } from "bun:test";
import { QueryClient, QueryObserver, keepPreviousData } from "@tanstack/query-core";
import type { VideoHistoryItem, VideoPlayInfo } from "../src/shared/types/video";
import {
  VideoPlaybackHistory,
  VideoPlaybackSessions,
  videoPlaybackForKey,
  videoPlaybackSnapshot,
  type VideoPlaybackResult,
} from "../src/features/video/videoPlaybackLifecycle";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function info(id: string): VideoPlayInfo {
  return {
    mpd_url: `http://127.0.0.1/${id}.mpd`,
    video_url: "",
    audio_url: "",
    duration: 600,
    quality: 80,
    quality_label: "1080P",
    codecs: "avc1",
    accept_quality: [],
    session_ids: { video: `${id}-v`, audio: `${id}-a`, mpd: id },
    audio_only: false,
  };
}

function sessions() {
  const stopped: string[] = [];
  return { owner: new VideoPlaybackSessions((ids) => stopped.push(ids.mpd)), stopped };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function entry(cid: number, title = "标题"): VideoHistoryItem {
  return {
    kind: "ugc",
    oid: "BVparts",
    bvid: "BVparts",
    cid,
    title,
    cover: "",
    author: "",
    part_title: `P${cid}`,
    ep_id: "",
    aid: "1",
    progress: 0,
    duration: 600,
    watched_at: 0,
  };
}

describe("VOD query/session 所有权", () => {
  test("真实 query 在卸载时 abort，迟到的 Tauri 结果仍释放代理", async () => {
    const { owner, stopped } = sessions();
    const request = deferred<VideoPlayInfo>();
    const client = new QueryClient();
    let signal: AbortSignal | undefined;
    const observer = new QueryObserver(client, {
      queryKey: ["video_play_info", "unmount"],
      queryFn: (context) => {
        signal = context.signal;
        return owner.acquire("A:1", context.signal, () => request.promise);
      },
      gcTime: 0,
      retry: false,
      structuralSharing: false,
    });
    const unsubscribe = observer.subscribe(() => {});
    unsubscribe();
    expect(signal?.aborted).toBe(true);
    owner.clear();
    request.resolve(info("late"));
    await tick();
    expect(stopped).toEqual(["late"]);
    client.clear();
  });

  test("已返回但未提交的结果也在请求被替代时回收", async () => {
    const { owner, stopped } = sessions();
    const a = await owner.acquire("A:1", new AbortController().signal, async () => info("A"));
    const b = await owner.acquire("B:2", new AbortController().signal, async () => info("B"));
    expect(stopped).toEqual([a.info.session_ids.mpd]);
    owner.retain(b);
    owner.clear();
    expect(stopped).toEqual(["A", "B"]);
  });

  test("快速换画质：后到的旧请求只释放自己，不会停止已接管的新会话", async () => {
    const { owner, stopped } = sessions();
    const old = deferred<VideoPlayInfo>();
    const pending = owner.acquire("A:1", new AbortController().signal, () => old.promise);
    // 先安装 rejection handler，等旧 invoke 真正落定后再断言，避免 matcher 等待
    // 尚未 resolve 的 Promise 阻塞后续步骤。
    const rejected = pending.catch((error: unknown) => error);
    const current = await owner.acquire("A:1", new AbortController().signal, async () =>
      info("new"),
    );
    owner.retain(current);
    old.resolve(info("old"));
    expect(await rejected).toMatchObject({ name: "AbortError" });
    expect(stopped).toEqual(["old"]);
    owner.clear();
    expect(stopped).toEqual(["old", "new"]);
  });

  test("已接管 placeholder 不随旧 query 的 abort 停止，交接晚于引擎 cleanup", async () => {
    const { owner, stopped } = sessions();
    const controller = new AbortController();
    const a = await owner.acquire("A:1", controller.signal, async () => info("A"));
    owner.retain(a);
    controller.abort();
    expect(stopped).toEqual([]);
    const b = await owner.acquire("A:1", new AbortController().signal, async () => info("B"));
    owner.retain(b);
    // layout 只移交所有权；旧引擎此时可能尚未 passive cleanup。
    expect(stopped).toEqual([]);
    owner.releasePrevious();
    expect(stopped).toEqual(["A"]);
    owner.retain(b);
    owner.releasePrevious();
    expect(stopped).toEqual(["A"]);
    owner.clear();
    owner.clear();
    expect(stopped).toEqual(["A", "B"]);
  });

  test("A→error/undefined→B 不丢旧会话，卸载同时释放未提交结果", async () => {
    const { owner, stopped } = sessions();
    const a = await owner.acquire("A:1", new AbortController().signal, async () => info("A"));
    owner.retain(a);
    await expect(
      owner.acquire("B:2", new AbortController().signal, async () => {
        throw new Error("取流失败");
      }),
    ).rejects.toThrow("取流失败");
    owner.releasePrevious();
    expect(stopped).toEqual([]);
    const b = await owner.acquire("B:2", new AbortController().signal, async () => info("B"));
    owner.retain(b);
    owner.releasePrevious();
    await owner.acquire("C:3", new AbortController().signal, async () => info("C"));
    owner.clear();
    expect(stopped).toEqual(["A", "C", "B"]);
  });

  test("切集失败再重试：真实 keepPreviousData 返回 A，但不能当作 B 播放", async () => {
    const { owner, stopped } = sessions();
    const client = new QueryClient();
    const requests = new Map<number, ReturnType<typeof deferred<VideoPlayInfo>>>();
    const options = (key: string, revision: number) => ({
      queryKey: ["video_play_info", key, revision],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        owner.acquire(key, signal, () => {
          const request = deferred<VideoPlayInfo>();
          requests.set(revision, request);
          return request.promise;
        }),
      placeholderData: keepPreviousData<VideoPlaybackResult>,
      structuralSharing: false,
      gcTime: 0,
      retry: false,
    });
    const observer = new QueryObserver(client, options("A:1", 0));
    const unsubscribe = observer.subscribe(() => {});
    try {
      requests.get(0)!.resolve(info("A"));
      await tick();
      const a = observer.getCurrentResult().data!;
      owner.retain(a);
      observer.setOptions(options("B:2", 1));
      expect(observer.getCurrentResult().isPlaceholderData).toBe(true);
      expect(videoPlaybackForKey(observer.getCurrentResult().data, "B:2")).toBeUndefined();
      requests.get(1)!.reject(new Error("B 失败"));
      await tick();
      expect(observer.getCurrentResult().isError).toBe(true);
      expect(observer.getCurrentResult().data).toBeUndefined();
      observer.setOptions(options("B:2", 2));
      expect(observer.getCurrentResult().data).toBe(a);
      expect(observer.getCurrentResult().isPlaceholderData).toBe(true);
      expect(videoPlaybackForKey(observer.getCurrentResult().data, "B:2")).toBeUndefined();
      expect(stopped).toEqual([]);
      requests.get(2)!.resolve(info("B"));
      await tick();
      const b = observer.getCurrentResult().data!;
      expect(videoPlaybackForKey(b, "B:2")?.session_ids.mpd).toBe("B");
      owner.retain(b);
      owner.releasePrevious();
      expect(stopped).toEqual(["A"]);
    } finally {
      unsubscribe();
      owner.clear();
      client.clear();
    }
    expect(stopped).toEqual(["A", "B"]);
  });
});

describe("VOD 同内容重建的断点", () => {
  test("清理时的最新 seek 和暂停覆盖点击切换时的快照", () => {
    const clicked = { key: "A:1", position: 120, playing: true };
    expect(videoPlaybackSnapshot(clicked, "A:1", { currentTime: 300, paused: true }, true)).toEqual(
      { key: "A:1", position: 300, playing: false },
    );
  });

  test("初始化失败不把既有断点覆盖成 0，重复重试继续使用它", () => {
    const resume = { key: "A:1", position: 300, playing: true };
    const failed = videoPlaybackSnapshot(resume, "A:1", { currentTime: 0, paused: true }, false);
    expect(failed).toBe(resume);
    expect(videoPlaybackSnapshot(failed, "A:1", { currentTime: 0, paused: true }, false)).toBe(
      resume,
    );
  });

  test("就绪后主动回到 0 秒必须保留，非有限位置不能污染断点", () => {
    const resume = { key: "A:1", position: 300, playing: true };
    expect(videoPlaybackSnapshot(resume, "A:1", { currentTime: 0, paused: true }, true)).toEqual({
      key: "A:1",
      position: 0,
      playing: false,
    });
    expect(videoPlaybackSnapshot(resume, "A:1", { currentTime: NaN, paused: false }, true)).toBe(
      resume,
    );
  });
});

describe("VOD 换集历史 flush", () => {
  test("新集 layout 更新后，旧实例仍用旧集最后补齐的元数据上报", () => {
    const a = new VideoPlaybackHistory(1);
    a.update(entry(1, "未补齐"));
    a.update(entry(1, "已补齐的稿件标题"));
    const flushA = () => ({ ...a.entry!, progress: 604 });
    const b = new VideoPlaybackHistory(2);
    b.update(entry(2));
    expect(flushA()).toMatchObject({ cid: 1, title: "已补齐的稿件标题", progress: 604 });
    expect(b.entry?.cid).toBe(2);
  });

  test("离开路由的 null 和别集元数据都不能抹掉本轮身份", () => {
    const a = new VideoPlaybackHistory(1);
    const current = entry(1);
    a.update(current);
    a.update(null);
    a.update(entry(2));
    expect(a.entry).toBe(current);
  });
});
