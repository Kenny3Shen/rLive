import { describe, expect, test } from "bun:test";
import { QueryClient, QueryObserver, keepPreviousData } from "@tanstack/query-core";
import type { VideoHistoryItem, VideoPlayInfo } from "../src/shared/types/video";
import {
  VideoPlaybackHistory,
  VideoPlaybackSessions,
  resumeSnapshotFor,
  shouldCaptureResume,
  videoPlaybackForKey,
  videoPlaybackSnapshot,
  type VideoPlaybackResult,
} from "../src/features/video/videoPlaybackLifecycle";
import { deferred, settle as tick } from "./helpers/async";

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

  test("迟到首帧恢复时自动取流交还原 held，新代理只停一次", async () => {
    const { owner, stopped } = sessions();
    const held = await owner.acquire("A:1", new AbortController().signal, async () => info("A"));
    owner.retain(held);
    const fresh = deferred<VideoPlayInfo>();
    let settledCount = 0;
    let checkedHeld: VideoPlaybackResult | null = null;
    const pending = owner.acquire("A:1", new AbortController().signal, () => fresh.promise, {
      autoRecoveryCheck: (current) => {
        checkedHeld = current;
        return { keepHeld: true };
      },
      onSettled: () => {
        settledCount += 1;
      },
    });
    fresh.resolve(info("B"));
    expect(await pending).toBe(held);
    expect(checkedHeld).toBe(held);
    expect(settledCount).toBe(1);
    expect(stopped).toEqual(["B"]);
    // query 的 layout 提交重复调用也不能把旧会话误标为 retired。
    owner.retain(held);
    owner.releasePrevious();
    expect(stopped).toEqual(["B"]);
    owner.clear();
    expect(stopped.toSorted()).toEqual(["A", "B"]);
  });

  test("手动轮次、换集及无 held 时不撤销自动恢复式取流", async () => {
    const { owner, stopped } = sessions();
    const first = await owner.acquire("A:1", new AbortController().signal, async () => info("A"));
    expect(videoPlaybackForKey(first, "A:1")?.mpd_url).toContain("A.mpd");
    owner.clear();
    expect(stopped).toEqual(["A"]);
    // 首屏和换集没有可保留的旧会话，新结果必须正常提交。
    const fresh = await owner.acquire("B:2", new AbortController().signal, async () => info("B"), {
      autoRecoveryCheck: () => ({ keepHeld: true }),
    });
    expect(videoPlaybackForKey(fresh, "B:2")?.mpd_url).toContain("B.mpd");
    owner.retain(fresh);
    // 手动轮次不传检查器：即使旧媒体已恢复也提交新结果。
    const manual = await owner.acquire("B:2", new AbortController().signal, async () => info("C"));
    expect(manual).not.toBe(fresh);
    owner.retain(manual);
    owner.releasePrevious();
    expect(stopped).toEqual(["A", "B"]);
    owner.clear();
    expect(stopped).toEqual(["A", "B", "C"]);
  });

  test("自动恢复请求失败但旧媒体已恢复时沿用原会话", async () => {
    const { owner, stopped } = sessions();
    const held = await owner.acquire("A:1", new AbortController().signal, async () => info("A"));
    owner.retain(held);
    const result = await owner.acquire(
      "A:1",
      new AbortController().signal,
      async () => {
        throw new Error("取流失败");
      },
      { autoRecoveryCheck: () => ({ keepHeld: true }) },
    );
    expect(result).toBe(held);
    expect(stopped).toEqual([]);
    owner.clear();
    expect(stopped).toEqual(["A"]);
  });

  test("QueryObserver 取消自动恢复请求后不提交 held，也不重复停代理", async () => {
    const { owner, stopped } = sessions();
    const client = new QueryClient();
    const held = await owner.acquire("A:1", new AbortController().signal, async () => info("A"));
    owner.retain(held);
    const fresh = deferred<VideoPlayInfo>();
    const observer = new QueryObserver(client, {
      queryKey: ["video_play_info", "auto-recovery"],
      queryFn: ({ signal }) =>
        owner.acquire("A:1", signal, () => fresh.promise, {
          autoRecoveryCheck: () => ({ keepHeld: true }),
        }),
      gcTime: 0,
      retry: false,
      structuralSharing: false,
    });
    const unsubscribe = observer.subscribe(() => {});
    const cancelled = client.cancelQueries({
      queryKey: ["video_play_info", "auto-recovery"],
      exact: true,
    });
    fresh.resolve(info("B"));
    await cancelled;
    await tick();
    // 取消之后 query 保持原来的 held；被取消的结果不得再以 success 顶掉它。
    expect(observer.getCurrentResult().data).toBeUndefined();
    unsubscribe();
    expect(stopped).toEqual(["B"]);
    owner.retain(held);
    owner.releasePrevious();
    owner.clear();
    expect(stopped).toEqual(["B", "A"]);
    client.clear();
  });

  test("结果落地后、撤销判定前的 clear 不能把已释放结果提交给播放器", async () => {
    const { owner, stopped } = sessions();
    const held = await owner.acquire("A:1", new AbortController().signal, async () => info("A"));
    owner.retain(held);
    let resolveFresh!: (value: VideoPlayInfo) => void;
    const checked: VideoPlaybackResult[] = [];
    const pending = owner.acquire(
      "A:1",
      new AbortController().signal,
      () => new Promise<VideoPlayInfo>((resolve) => (resolveFresh = resolve)),
      {
        autoRecoveryCheck: (current) => {
          checked.push(current);
          return { keepHeld: true };
        },
      },
    );
    const outcome = pending.then(
      (result) => ({ kind: "resolved" as const, result }),
      (error) => ({ kind: "rejected" as const, name: (error as Error).name }),
    );
    resolveFresh(info("B"));
    // PendingPlaybackRequests 的 acquire 已落地，但外层 then 尚未运行。
    owner.clear();
    expect(await outcome).toEqual({ kind: "rejected", name: "AbortError" });
    expect(checked).toEqual([]);
    expect(stopped.toSorted()).toEqual(["A", "B"]);
  });

  test("迟到的取流错误在 clear 后不能把已释放的 held 当作成功结果", async () => {
    const { owner, stopped } = sessions();
    const held = await owner.acquire("A:1", new AbortController().signal, async () => info("A"));
    owner.retain(held);
    const error = deferred<VideoPlayInfo>();
    const checked: VideoPlaybackResult[] = [];
    const pending = owner.acquire("A:1", new AbortController().signal, () => error.promise, {
      autoRecoveryCheck: (current) => {
        checked.push(current);
        return { keepHeld: true };
      },
    });
    const outcome = pending.then(
      (result) => ({ kind: "resolved" as const, result }),
      (reason: unknown) => ({ kind: "rejected" as const, reason }),
    );
    error.reject(new Error("取流失败"));
    // 旧请求的错误还在 Promise 链上，页面卸载已释放本轮所有权。
    owner.clear();
    expect(await outcome).toMatchObject({ kind: "rejected", reason: { name: "AbortError" } });
    expect(checked).toEqual([]);
    expect(stopped).toEqual(["A"]);
  });

  test("迟到的取流错误在新一轮 acquire 后不能沿用旧 held", async () => {
    const { owner, stopped } = sessions();
    const held = await owner.acquire("A:1", new AbortController().signal, async () => info("A"));
    owner.retain(held);
    const error = deferred<VideoPlayInfo>();
    const checked: VideoPlaybackResult[] = [];
    const pending = owner.acquire("A:1", new AbortController().signal, () => error.promise, {
      autoRecoveryCheck: (current) => {
        checked.push(current);
        return { keepHeld: true };
      },
    });
    const outcome = pending.then(
      (result) => ({ kind: "resolved" as const, result }),
      (reason: unknown) => ({ kind: "rejected" as const, reason }),
    );
    error.reject(new Error("取流失败"));
    const replacement = await owner.acquire("A:1", new AbortController().signal, async () =>
      info("B"),
    );
    expect(await outcome).toMatchObject({ kind: "rejected", reason: { name: "AbortError" } });
    expect(checked).toEqual([]);
    expect(replacement.info.session_ids.mpd).toBe("B");
    expect(stopped).toEqual([]);
    owner.retain(replacement);
    owner.clear();
    expect(stopped.toSorted()).toEqual(["A", "B"]);
  });

  test("撤销回调清掉 held 或释放新结果时不返回断流会话", async () => {
    for (const action of ["clear", "retain"] as const) {
      const { owner, stopped } = sessions();
      const held = await owner.acquire("A:1", new AbortController().signal, async () => info("A"));
      owner.retain(held);
      const pending = owner.acquire("A:1", new AbortController().signal, async () => info("B"), {
        autoRecoveryCheck: () => {
          if (action === "clear") {
            owner.clear();
          } else {
            owner.retain({ key: "A:1", info: info("C") });
          }
          return { keepHeld: true };
        },
      });
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      // clear 立即停掉新结果与旧 held；retain 把旧 held 留待播放器 cleanup。
      if (action === "clear") {
        expect(stopped).toEqual(["B", "A"]);
        owner.releasePrevious();
        expect(stopped).toEqual(["B", "A"]);
      } else {
        expect(stopped).toEqual([]);
        owner.releasePrevious();
        expect(stopped).toEqual(["A"]);
      }
      owner.clear();
    }
  });

  test("成功、真实失败和被替代的取消都在取流终态结算本轮自动恢复令牌", async () => {
    const { owner, stopped } = sessions();
    const held = await owner.acquire("A:1", new AbortController().signal, async () => info("A"));
    owner.retain(held);
    const first = () => true;
    const second = () => true;
    let settledCount = 0;
    // 模拟发起自动恢复时登记本轮令牌。
    let token: (() => boolean) | null = first;
    const settleFirst = () => {
      if (token === first) token = null;
      settledCount += 1;
    };
    const success = await owner.acquire(
      "A:1",
      new AbortController().signal,
      async () => info("B"),
      { onSettled: settleFirst },
    );
    expect(success.info.session_ids.mpd).toBe("B");
    expect(token).toBeNull();
    owner.retain(success);
    // 真实失败必须清掉自己这轮的令牌，不依赖 placeholder 渲染或撤销回调。
    token = first;
    const failure = owner.acquire(
      "A:1",
      new AbortController().signal,
      async () => {
        throw new Error("取流失败");
      },
      { onSettled: settleFirst },
    );
    await expect(failure).rejects.toThrow("取流失败");
    expect(token).toBeNull();
    // 下一轮令牌已登记，旧轮次迟到的错误不能把它清掉。
    token = second;
    const error = deferred<VideoPlayInfo>();
    const stale = owner.acquire("A:1", new AbortController().signal, () => error.promise, {
      onSettled: settleFirst,
    });
    const staleOutcome = stale.catch((reason: unknown) => reason);
    const fresh = deferred<VideoPlayInfo>();
    const current = owner.acquire("A:1", new AbortController().signal, () => fresh.promise);
    error.reject(new Error("旧请求迟到"));
    expect(await staleOutcome).toMatchObject({ name: "AbortError" });
    expect(token).toBe(second);
    fresh.resolve(info("D"));
    expect((await current).info.session_ids.mpd).toBe("D");
    expect(settledCount).toBe(3);
    owner.clear();
    expect(stopped.toSorted()).toEqual(["A", "B", "D"]);
  });

  test("第一轮请求迟到不会通过运行时读取的结算器清掉第二轮令牌", async () => {
    const { owner, stopped } = sessions();
    let token: (() => boolean) | null = null;
    let settle: () => void = () => {};
    const beginAutoRecovery = () => {
      const attempt = () => true;
      token = attempt;
      settle = () => {
        if (token === attempt) token = null;
      };
    };
    const captureAttempt = () => {
      const attempt = token;
      const onSettled = settle;
      return {
        autoRecoveryCheck: () => {
          return { keepHeld: Boolean(attempt?.()) };
        },
        onSettled,
      };
    };

    beginAutoRecovery();
    const first = deferred<VideoPlayInfo>();
    const stale = owner.acquire(
      "A:1",
      new AbortController().signal,
      () => first.promise,
      captureAttempt(),
    );
    const staleOutcome = stale.catch((reason: unknown) => reason);
    const second = token;
    beginAutoRecovery();
    const third = token;
    const fresh = deferred<VideoPlayInfo>();
    const current = owner.acquire(
      "A:1",
      new AbortController().signal,
      () => fresh.promise,
      captureAttempt(),
    );
    first.resolve(info("B"));
    expect(await staleOutcome).toMatchObject({ name: "AbortError" });
    expect(token).toBe(third);
    expect(token).not.toBe(second);
    fresh.resolve(info("C"));
    expect((await current).info.session_ids.mpd).toBe("C");
    owner.clear();
    expect(stopped).toEqual(["B", "C"]);
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

describe("VOD 相关视频返回后的续播位置", () => {
  test("换视频时 cleanup 仍记下本轮位置，不被已切走的全局 key 拦下", () => {
    // 点相关视频的瞬间，布局阶段先把全局键指向 B，随后 A 的播放器才 cleanup。
    expect(shouldCaptureResume("B:2", "A:1", false)).toBe(false);
    expect(shouldCaptureResume("B:2", "A:1", true)).toBe(true);
  });

  test("同内容重建与内容未切换的事件照常写快照", () => {
    expect(shouldCaptureResume("A:1", "A:1", false)).toBe(true);
    expect(shouldCaptureResume("A:1", "A:1", true)).toBe(true);
  });

  test("返回 A 时只接受 A 自己的快照，旧内容快照不会顶替磁盘历史", () => {
    const stale = { key: "A:1", position: 40, playing: true };
    expect(resumeSnapshotFor(stale, "A:1")).toEqual(stale);
    expect(resumeSnapshotFor(stale, "B:2")).toBeNull();
    expect(resumeSnapshotFor(null, "A:1")).toBeNull();
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
