import { describe, expect, mock, test } from "bun:test";
import { requestPlayerAutoplay } from "../src/features/room/player/autoplay";

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks() {
  // 两种降级各最多一次，只需清空微任务，不等待真实定时器。
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function createHarness(muted = false) {
  const video = { muted, volume: 0.4 };
  const session = { current: true };
  const player = { play: mock<() => Promise<void> | null>(() => Promise.resolve()) };
  const onAutoplayMuted = mock(() => {});
  const onAutoplayStarted = mock(() => {});
  const request = () =>
    requestPlayerAutoplay(player, video, () => session.current, onAutoplayMuted, onAutoplayStarted);
  return { player, video, session, onAutoplayMuted, onAutoplayStarted, request };
}

function playbackError(name: string) {
  return new DOMException("播放请求失败", name);
}

describe("播放器自动起播", () => {
  test.each([false, true])("直接成功保留原音频状态（静音：%s）", async (muted) => {
    const harness = createHarness(muted);

    expect(harness.request()).toBeUndefined();
    await flushMicrotasks();

    expect(harness.player.play).toHaveBeenCalledTimes(1);
    expect(harness.onAutoplayMuted).not.toHaveBeenCalled();
    expect(harness.onAutoplayStarted).toHaveBeenCalledTimes(1);
    expect(harness.video).toEqual({ muted, volume: 0.4 });
  });

  test("NotAllowedError 先同步静音界面再重试，成功后保持静音", async () => {
    const harness = createHarness();
    const events: string[] = [];
    harness.player.play.mockImplementation(() => {
      events.push(`播放:${harness.video.muted}`);
      return harness.video.muted
        ? Promise.resolve()
        : Promise.reject(playbackError("NotAllowedError"));
    });
    harness.onAutoplayMuted.mockImplementation(() => {
      events.push(`静音通知:${harness.video.muted}`);
    });
    harness.onAutoplayStarted.mockImplementation(() => {
      events.push(`开始通知:${harness.video.muted}`);
    });

    harness.request();
    await flushMicrotasks();

    expect(events).toEqual(["播放:false", "静音通知:true", "播放:true", "开始通知:true"]);
    expect(harness.player.play).toHaveBeenCalledTimes(2);
    expect(harness.onAutoplayMuted).toHaveBeenCalledTimes(1);
    expect(harness.onAutoplayStarted).toHaveBeenCalledTimes(1);
    expect(harness.video).toEqual({ muted: true, volume: 0.4 });
  });

  test("已经静音时遭遇策略拒绝不再重试", async () => {
    const harness = createHarness(true);
    harness.player.play.mockRejectedValue(playbackError("NotAllowedError"));

    harness.request();
    await flushMicrotasks();

    expect(harness.player.play).toHaveBeenCalledTimes(1);
    expect(harness.onAutoplayMuted).not.toHaveBeenCalled();
    expect(harness.onAutoplayStarted).not.toHaveBeenCalled();
    expect(harness.video).toEqual({ muted: true, volume: 0.4 });
  });

  test("静音降级仍被拒绝时停止，不恢复声音", async () => {
    const harness = createHarness();
    harness.player.play.mockRejectedValue(playbackError("NotAllowedError"));

    harness.request();
    await flushMicrotasks();

    expect(harness.player.play).toHaveBeenCalledTimes(2);
    expect(harness.onAutoplayMuted).toHaveBeenCalledTimes(1);
    expect(harness.onAutoplayStarted).not.toHaveBeenCalled();
    expect(harness.video).toEqual({ muted: true, volume: 0.4 });
  });

  test.each([false, true])("AbortError 按原音量重试后成功（静音：%s）", async (muted) => {
    const harness = createHarness(muted);
    const audioStates: (typeof harness.video)[] = [];
    harness.player.play.mockImplementation(() => {
      audioStates.push({ ...harness.video });
      return audioStates.length === 1
        ? Promise.reject(playbackError("AbortError"))
        : Promise.resolve();
    });

    harness.request();
    await flushMicrotasks();

    expect(audioStates).toEqual([
      { muted, volume: 0.4 },
      { muted, volume: 0.4 },
    ]);
    expect(harness.onAutoplayMuted).not.toHaveBeenCalled();
    expect(harness.onAutoplayStarted).toHaveBeenCalledTimes(1);
  });

  test("连续 AbortError 最多重试一次，不改变音频", async () => {
    const harness = createHarness();
    harness.player.play.mockRejectedValue(playbackError("AbortError"));

    harness.request();
    await flushMicrotasks();

    expect(harness.player.play).toHaveBeenCalledTimes(2);
    expect(harness.onAutoplayMuted).not.toHaveBeenCalled();
    expect(harness.onAutoplayStarted).not.toHaveBeenCalled();
    expect(harness.video).toEqual({ muted: false, volume: 0.4 });
  });

  test.each([
    ["AbortError", "NotAllowedError"],
    ["NotAllowedError", "AbortError"],
  ])("先 %s 再 %s 各重试一次后成功", async (first, second) => {
    const harness = createHarness();
    harness.player.play
      .mockRejectedValueOnce(playbackError(first))
      .mockRejectedValueOnce(playbackError(second));

    harness.request();
    await flushMicrotasks();

    expect(harness.player.play).toHaveBeenCalledTimes(3);
    expect(harness.onAutoplayMuted).toHaveBeenCalledTimes(1);
    expect(harness.onAutoplayStarted).toHaveBeenCalledTimes(1);
    expect(harness.video).toEqual({ muted: true, volume: 0.4 });
  });

  test("两种重试机会耗尽后再次中断，不进行第四次播放", async () => {
    const harness = createHarness();
    harness.player.play
      .mockRejectedValueOnce(playbackError("AbortError"))
      .mockRejectedValueOnce(playbackError("NotAllowedError"))
      .mockRejectedValue(playbackError("AbortError"));

    harness.request();
    await flushMicrotasks();

    expect(harness.player.play).toHaveBeenCalledTimes(3);
    expect(harness.onAutoplayMuted).toHaveBeenCalledTimes(1);
    expect(harness.onAutoplayStarted).not.toHaveBeenCalled();
  });

  test("即使静音通知修改音频状态，也只允许一次静音降级", async () => {
    const harness = createHarness();
    harness.player.play.mockRejectedValue(playbackError("NotAllowedError"));
    harness.onAutoplayMuted.mockImplementation(() => {
      harness.video.muted = false;
    });

    harness.request();
    await flushMicrotasks();

    expect(harness.player.play).toHaveBeenCalledTimes(2);
    expect(harness.onAutoplayMuted).toHaveBeenCalledTimes(1);
    expect(harness.onAutoplayStarted).not.toHaveBeenCalled();
  });

  test.each([
    ["网络故障", playbackError("NetworkError")],
    ["解码故障", playbackError("EncodingError")],
    ["格式不支持", playbackError("NotSupportedError")],
    ["媒体错误对象", { code: 3, message: "媒体解码失败" }],
    ["普通异常", new Error("媒体失败")],
    ["空拒绝原因", null],
  ])("%s 不重试、不修改音频并吸收拒绝", async (_label, error) => {
    const harness = createHarness();
    harness.player.play.mockRejectedValue(error);

    harness.request();
    await flushMicrotasks();

    expect(harness.player.play).toHaveBeenCalledTimes(1);
    expect(harness.onAutoplayMuted).not.toHaveBeenCalled();
    expect(harness.onAutoplayStarted).not.toHaveBeenCalled();
    expect(harness.video).toEqual({ muted: false, volume: 0.4 });
  });

  test("请求前会话已经失效时不调用播放或回调", async () => {
    const harness = createHarness();
    harness.session.current = false;

    harness.request();
    await flushMicrotasks();

    expect(harness.player.play).not.toHaveBeenCalled();
    expect(harness.onAutoplayMuted).not.toHaveBeenCalled();
    expect(harness.onAutoplayStarted).not.toHaveBeenCalled();
  });

  test.each(["成功", "AbortError", "NotAllowedError"])(
    "播放挂起时会话失效，随后%s 不回调也不重试",
    async (outcome) => {
      const harness = createHarness();
      const pending = deferred();
      harness.player.play.mockReturnValueOnce(pending.promise);

      expect(harness.request()).toBeUndefined();
      expect(harness.player.play).toHaveBeenCalledTimes(1);
      expect(harness.onAutoplayStarted).not.toHaveBeenCalled();
      harness.session.current = false;
      if (outcome === "成功") pending.resolve();
      else pending.reject(playbackError(outcome));
      await flushMicrotasks();

      expect(harness.player.play).toHaveBeenCalledTimes(1);
      expect(harness.onAutoplayMuted).not.toHaveBeenCalled();
      expect(harness.onAutoplayStarted).not.toHaveBeenCalled();
      expect(harness.video).toEqual({ muted: false, volume: 0.4 });
    },
  );

  test.each(["成功", "AbortError"])(
    "静音重试挂起时用户暂停，随后%s 不再播放或通知开始",
    async (outcome) => {
      const harness = createHarness();
      const pending = deferred();
      harness.player.play
        .mockRejectedValueOnce(playbackError("NotAllowedError"))
        .mockReturnValueOnce(pending.promise);

      harness.request();
      await flushMicrotasks();
      expect(harness.player.play).toHaveBeenCalledTimes(2);
      expect(harness.onAutoplayMuted).toHaveBeenCalledTimes(1);
      harness.session.current = false;
      if (outcome === "成功") pending.resolve();
      else pending.reject(playbackError(outcome));
      await flushMicrotasks();

      expect(harness.player.play).toHaveBeenCalledTimes(2);
      expect(harness.onAutoplayMuted).toHaveBeenCalledTimes(1);
      expect(harness.onAutoplayStarted).not.toHaveBeenCalled();
      expect(harness.video).toEqual({ muted: true, volume: 0.4 });
    },
  );

  test("静音通知中用户暂停，下一次播放前检查会话并停止", async () => {
    const harness = createHarness();
    harness.player.play.mockRejectedValueOnce(playbackError("NotAllowedError"));
    harness.onAutoplayMuted.mockImplementation(() => {
      harness.session.current = false;
    });

    harness.request();
    await flushMicrotasks();

    expect(harness.player.play).toHaveBeenCalledTimes(1);
    expect(harness.onAutoplayMuted).toHaveBeenCalledTimes(1);
    expect(harness.onAutoplayStarted).not.toHaveBeenCalled();
  });

  test("回调均可省略，播放返回 null 时仍立即返回 void", async () => {
    const player = { play: mock(() => null) };
    const video = { muted: false };

    expect(requestPlayerAutoplay(player, video, () => true)).toBeUndefined();
    await flushMicrotasks();

    expect(player.play).toHaveBeenCalledTimes(1);
    expect(video.muted).toBe(false);
  });

  test("同步抛出的播放异常同样被吸收，不静音重试", async () => {
    const harness = createHarness();
    harness.player.play.mockImplementation(() => {
      throw playbackError("NotSupportedError");
    });

    expect(() => harness.request()).not.toThrow();
    await flushMicrotasks();

    expect(harness.player.play).toHaveBeenCalledTimes(1);
    expect(harness.onAutoplayMuted).not.toHaveBeenCalled();
    expect(harness.onAutoplayStarted).not.toHaveBeenCalled();
    expect(harness.video).toEqual({ muted: false, volume: 0.4 });
  });
});
