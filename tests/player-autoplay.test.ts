import { describe, expect, mock, test } from "bun:test";
import { requestPlayerAutoplay } from "../src/features/room/player/autoplay";
import { deferred, settle } from "./helpers/async";

function harness(muted = false) {
  const video = { muted, volume: 0.4 };
  const session = { current: true };
  const player = { play: mock<() => Promise<void> | null>(() => Promise.resolve()) };
  const onMuted = mock(() => {});
  const onStarted = mock(() => {});
  const request = () =>
    requestPlayerAutoplay(player, video, () => session.current, onMuted, onStarted);
  return { video, session, player, onMuted, onStarted, request };
}
const error = (name: string) => new DOMException("播放失败", name);

describe("自动起播降级", () => {
  test.each([
    [[], false, 1, false, true],
    [[], true, 1, true, true],
    [["NotAllowedError"], false, 2, true, true],
    [["NotAllowedError"], true, 1, true, false],
    [["NotAllowedError", "NotAllowedError"], false, 2, true, false],
    [["AbortError"], false, 2, false, true],
    [["AbortError"], true, 2, true, true],
    [["AbortError", "AbortError"], false, 2, false, false],
    [["AbortError", "NotAllowedError"], false, 3, true, true],
    [["NotAllowedError", "AbortError"], false, 3, true, true],
    [["AbortError", "NotAllowedError", "AbortError"], false, 3, true, false],
    [["NetworkError"], false, 1, false, false],
    [["NotSupportedError"], false, 1, false, false],
  ] as const)("有界重试 %j，初始静音 %s", async (errors, initial, calls, muted, started) => {
    const h = harness(initial);
    errors.forEach((name) => h.player.play.mockRejectedValueOnce(error(name)));
    expect(h.request()).toBeUndefined();
    await settle();
    expect(h.player.play).toHaveBeenCalledTimes(calls);
    expect(h.onMuted).toHaveBeenCalledTimes(!initial && muted ? 1 : 0);
    expect(h.onStarted).toHaveBeenCalledTimes(started ? 1 : 0);
    expect(h.video).toEqual({ muted, volume: 0.4 });
  });

  test("静音状态先同步给界面，通知即使改回音频也不无限重试", async () => {
    const h = harness();
    const events: string[] = [];
    h.player.play.mockImplementation(() => {
      events.push(`play:${h.video.muted}`);
      return Promise.reject(error("NotAllowedError"));
    });
    h.onMuted.mockImplementation(() => {
      events.push(`muted:${h.video.muted}`);
      h.video.muted = false;
    });
    h.request();
    await settle();
    expect(events).toEqual(["play:false", "muted:true", "play:false"]);
    expect(h.onStarted).not.toHaveBeenCalled();
  });

  test.each([null, new Error("媒体失败"), { code: 3 }])(
    "非策略错误吸收拒绝且不重试：%j",
    async (reason) => {
      const h = harness();
      h.player.play.mockRejectedValue(reason);
      h.request();
      await settle();
      expect(h.player.play).toHaveBeenCalledTimes(1);
      expect(h.onMuted).not.toHaveBeenCalled();
      expect(h.onStarted).not.toHaveBeenCalled();
    },
  );
});

describe("自动起播会话失效", () => {
  for (const retry of [false, true]) {
    test.each(["成功", "AbortError", "NotAllowedError"])(
      `挂起期间失效，重试阶段 ${retry}，结果 %s`,
      async (outcome) => {
        const h = harness();
        const pending = deferred();
        if (retry) h.player.play.mockRejectedValueOnce(error("NotAllowedError"));
        h.player.play.mockReturnValueOnce(pending.promise);
        h.request();
        await settle();
        h.session.current = false;
        if (outcome === "成功") pending.resolve();
        else pending.reject(error(outcome));
        await settle();
        expect(h.player.play).toHaveBeenCalledTimes(retry ? 2 : 1);
        expect(h.onMuted).toHaveBeenCalledTimes(retry ? 1 : 0);
        expect(h.onStarted).not.toHaveBeenCalled();
      },
    );
  }

  test("失效会话不开始，静音回调中暂停也不能再发起播放", async () => {
    const h = harness();
    h.session.current = false;
    h.request();
    expect(h.player.play).not.toHaveBeenCalled();
    h.session.current = true;
    h.player.play.mockRejectedValueOnce(error("NotAllowedError"));
    h.onMuted.mockImplementation(() => {
      h.session.current = false;
    });
    h.request();
    await settle();
    expect(h.player.play).toHaveBeenCalledTimes(1);
    expect(h.onStarted).not.toHaveBeenCalled();
  });

  test("同步异常同样吸收，不静音重试", () => {
    const h = harness();
    h.player.play.mockImplementation(() => {
      throw error("NotSupportedError");
    });
    expect(h.request).not.toThrow();
    expect(h.player.play).toHaveBeenCalledTimes(1);
    expect(h.onMuted).not.toHaveBeenCalled();
  });
});
