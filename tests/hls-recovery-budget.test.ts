import { describe, expect, test } from "bun:test";
import {
  BILIBILI_HLS_FATAL_RECOVERY_GRACE_MS,
  classifyHlsPlayerError,
  createHlsRecoveryBudget,
  hlsResponseStatus,
  isTwitchCommercialBreak,
  nextHlsFatalRecoveryAction,
  shouldEscalateNonTwitchHlsFatal,
  type HlsRecoveryBudgetAction,
} from "../src/features/room/player/hlsRecoveryBudget";

function manualNow(start = 1_000) {
  let value = start;
  return {
    now: () => value,
    advance(ms: number) {
      value += ms;
    },
  };
}

function networkFatal(
  budget: ReturnType<typeof createHlsRecoveryBudget>,
  commercialBreak = false,
  responseStatus: number | null = null,
): HlsRecoveryBudgetAction {
  return budget.recordFatal({
    recovery: "startLoad",
    commercialBreak,
    responseStatus,
  });
}

describe("HLS fatal 预算", () => {
  test("反复短暂 playing 不会清零，第二次 fatal 有界上报恢复耗尽", () => {
    const clock = manualNow();
    const budget = createHlsRecoveryBudget({ siteId: "douyu", now: clock.now });

    budget.notePlaying();
    clock.advance(2_000);
    expect(networkFatal(budget)).toEqual({ type: "restart", recovery: "startLoad" });

    // 同一次传输再次出帧，但不足 30 秒，不得把第一次 fatal 当作已经恢复。
    budget.notePlaying();
    clock.advance(10_000);
    expect(networkFatal(budget)).toEqual({ type: "recovery_exhausted", commercialBreak: false });
  });

  test("连续有效播放满 30 秒后，下一次 fatal 先清零再计数", () => {
    const clock = manualNow();
    const budget = createHlsRecoveryBudget({ siteId: "douyu", now: clock.now });

    budget.notePlaying();
    clock.advance(30_000);
    expect(networkFatal(budget)).toEqual({ type: "restart", recovery: "startLoad" });
    // 当前 fatal 已成为新一轮的第一条，紧接着的下一条才耗尽。
    expect(networkFatal(budget)).toEqual({ type: "recovery_exhausted", commercialBreak: false });
  });

  test("旧预算已耗尽后连续播放满 30 秒，当前 fatal 只重启", () => {
    const clock = manualNow();
    const budget = createHlsRecoveryBudget({ siteId: "douyu", now: clock.now });
    expect(networkFatal(budget)).toEqual({ type: "restart", recovery: "startLoad" });

    budget.notePlaying();
    clock.advance(30_000);
    // 不依赖 waiting/pause：fatal 到达时自行观察到稳定窗口并先清零。
    expect(networkFatal(budget)).toEqual({ type: "restart", recovery: "startLoad" });
    expect(networkFatal(budget)).toEqual({
      type: "recovery_exhausted",
      commercialBreak: false,
    });
  });

  test("恢复后只有时间进展、没有新 playing，稳定 30 秒后新 fatal 仍重启", () => {
    const clock = manualNow();
    const budget = createHlsRecoveryBudget({ siteId: "douyu", now: clock.now });
    expect(networkFatal(budget)).toEqual({ type: "restart", recovery: "startLoad" });

    budget.noteProgress();
    clock.advance(10_000);
    budget.noteProgress();
    clock.advance(20_000);
    budget.noteProgress();
    expect(networkFatal(budget)).toEqual({ type: "restart", recovery: "startLoad" });
    expect(networkFatal(budget)).toEqual({ type: "recovery_exhausted", commercialBreak: false });
  });

  test("稳定播放已结束但尚未遇到 fatal 时，保留待清零事实", () => {
    const clock = manualNow();
    const budget = createHlsRecoveryBudget({ siteId: "douyu", now: clock.now });

    budget.notePlaying();
    clock.advance(30_000);
    budget.noteInterrupted();
    expect(networkFatal(budget)).toEqual({ type: "restart", recovery: "startLoad" });
    expect(networkFatal(budget)).toEqual({ type: "recovery_exhausted", commercialBreak: false });
  });

  test("暂停、缓冲或寻址后重新有进展才重新开始计时", () => {
    const clock = manualNow();
    const budget = createHlsRecoveryBudget({ siteId: "douyu", now: clock.now });
    expect(networkFatal(budget)).toEqual({ type: "restart", recovery: "startLoad" });

    budget.noteProgress();
    clock.advance(29_000);
    budget.noteInterrupted();
    clock.advance(2_000);
    expect(networkFatal(budget)).toEqual({ type: "recovery_exhausted", commercialBreak: false });

    const resumed = createHlsRecoveryBudget({ siteId: "douyu", now: clock.now });
    expect(networkFatal(resumed)).toEqual({ type: "restart", recovery: "startLoad" });
    // 中断前不足 30 秒，不能把中断期间的时间算成稳定播放。
    resumed.noteProgress();
    clock.advance(29_000);
    resumed.noteInterrupted();
    clock.advance(2_000);
    expect(networkFatal(resumed)).toEqual({ type: "recovery_exhausted", commercialBreak: false });

    const afterProgress = createHlsRecoveryBudget({ siteId: "douyu", now: clock.now });
    expect(networkFatal(afterProgress)).toEqual({ type: "restart", recovery: "startLoad" });
    afterProgress.noteProgress();
    clock.advance(30_000);
    expect(networkFatal(afterProgress)).toEqual({ type: "restart", recovery: "startLoad" });
  });

  test("waiting 与 pause 终止连续计时，缓冲时长不伪装成稳定播放", () => {
    const clock = manualNow();
    const budget = createHlsRecoveryBudget({ siteId: "huya", now: clock.now });

    budget.notePlaying();
    clock.advance(29_000);
    budget.noteInterrupted();
    clock.advance(2_000);
    expect(networkFatal(budget)).toEqual({ type: "restart", recovery: "startLoad" });

    budget.notePlaying();
    clock.advance(20_000);
    budget.noteInterrupted();
    clock.advance(20_000);
    expect(networkFatal(budget)).toEqual({ type: "recovery_exhausted", commercialBreak: false });
  });

  test("重复 playing 不刷新起点，稳定判定仍从首次 playing 起算", () => {
    const clock = manualNow();
    const budget = createHlsRecoveryBudget({ siteId: "bilibili", now: clock.now });

    budget.notePlaying();
    clock.advance(20_000);
    budget.notePlaying();
    clock.advance(10_000);
    expect(networkFatal(budget)).toEqual({ type: "restart", recovery: "startLoad" });
  });

  test("媒体 fatal 使用 recoverMediaError，网络 fatal 使用 startLoad", () => {
    const clock = manualNow();
    const budget = createHlsRecoveryBudget({ siteId: "douyu", now: clock.now });
    expect(budget.recordFatal({ recovery: "recoverMediaError" })).toEqual({
      type: "restart",
      recovery: "recoverMediaError",
    });
  });
});

describe("非 Twitch HLS 升级与 B 站宽限", () => {
  test("非 B 站第二次 fatal 立即升级", () => {
    expect(
      shouldEscalateNonTwitchHlsFatal({
        siteId: "douyu",
        failureCount: 1,
        firstFailureAt: 1_000,
        now: 100_000,
      }),
    ).toBe(false);
    expect(
      shouldEscalateNonTwitchHlsFatal({
        siteId: "douyu",
        failureCount: 2,
        firstFailureAt: 1_000,
        now: 1_001,
      }),
    ).toBe(true);
  });

  test("B 站第二次 fatal 在 20 秒窗口内仍重启，达到边界后升级", () => {
    const firstFailureAt = 5_000;
    expect(
      shouldEscalateNonTwitchHlsFatal({
        siteId: "bilibili",
        failureCount: 2,
        firstFailureAt,
        now: firstFailureAt + BILIBILI_HLS_FATAL_RECOVERY_GRACE_MS - 1,
      }),
    ).toBe(false);
    expect(
      shouldEscalateNonTwitchHlsFatal({
        siteId: "bilibili",
        failureCount: 2,
        firstFailureAt,
        now: firstFailureAt + BILIBILI_HLS_FATAL_RECOVERY_GRACE_MS,
      }),
    ).toBe(true);
  });

  test("B 站预算也遵守短 playing 不清零与稳定后重置", () => {
    const clock = manualNow();
    const budget = createHlsRecoveryBudget({ siteId: "bilibili", now: clock.now });

    budget.notePlaying();
    clock.advance(1_000);
    expect(networkFatal(budget).type).toBe("restart");
    budget.notePlaying();
    clock.advance(2_000);
    expect(networkFatal(budget).type).toBe("restart");
    clock.advance(BILIBILI_HLS_FATAL_RECOVERY_GRACE_MS);
    expect(networkFatal(budget).type).toBe("recovery_exhausted");

    const stable = createHlsRecoveryBudget({ siteId: "bilibili", now: clock.now });
    expect(networkFatal(stable).type).toBe("restart");
    stable.notePlaying();
    clock.advance(30_000);
    // 当前 fatal 到达时已稳定 30 秒，直接开启新预算，不依赖中间事件。
    expect(networkFatal(stable).type).toBe("restart");
    clock.advance(BILIBILI_HLS_FATAL_RECOVERY_GRACE_MS);
    expect(networkFatal(stable).type).toBe("recovery_exhausted");
  });
});

describe("Twitch HLS 原有语义", () => {
  test("401/403 非广告第一次 fatal 即耗尽，广告豁免授权即时失败", () => {
    for (const status of [401, 403]) {
      expect(nextHlsFatalRecoveryAction(1, false, true)).toEqual({
        type: "recovery_exhausted",
      });
      expect(nextHlsFatalRecoveryAction(1, true, true)).toEqual({ type: "restart" });
      expect(
        networkFatal(
          createHlsRecoveryBudget({ siteId: "twitch", now: manualNow().now }),
          false,
          status,
        ),
      ).toEqual({ type: "recovery_exhausted", commercialBreak: false });
    }
  });

  test("广告错误标记 commercialBreak 并允许先重启一次", () => {
    const clock = manualNow();
    const budget = createHlsRecoveryBudget({ siteId: "twitch", now: clock.now });
    expect(networkFatal(budget, true, 403)).toEqual({ type: "restart", recovery: "startLoad" });
    expect(networkFatal(budget, true, 403)).toEqual({
      type: "recovery_exhausted",
      commercialBreak: true,
    });
  });

  test("Twitch 短暂 playing 后第二次 fatal 仍有界，稳定 30 秒后才重置", () => {
    const clock = manualNow();
    const budget = createHlsRecoveryBudget({ siteId: "twitch", now: clock.now });

    budget.notePlaying();
    clock.advance(2_000);
    expect(networkFatal(budget)).toEqual({ type: "restart", recovery: "startLoad" });
    budget.notePlaying();
    clock.advance(3_000);
    expect(networkFatal(budget)).toEqual({ type: "recovery_exhausted", commercialBreak: false });

    const stable = createHlsRecoveryBudget({ siteId: "twitch", now: clock.now });
    expect(networkFatal(stable)).toEqual({ type: "restart", recovery: "startLoad" });
    stable.notePlaying();
    clock.advance(30_000);
    // 稳定窗口后的当前 fatal 必须先清零旧预算，自己只触发一次 restart。
    expect(networkFatal(stable)).toEqual({ type: "restart", recovery: "startLoad" });
    expect(networkFatal(stable)).toEqual({ type: "recovery_exhausted", commercialBreak: false });
  });

  test("广告文本与 Video.js MediaError.data 中的状态可识别", () => {
    expect(isTwitchCommercialBreak("Commercial break in progress")).toBe(true);
    expect(
      isTwitchCommercialBreak({
        message: "manifest failed",
        data: { reason: "Commercial Break in Progress" },
      }),
    ).toBe(true);
    expect(isTwitchCommercialBreak({ message: "network failed" })).toBe(false);
    expect(
      hlsResponseStatus({
        code: 2,
        fatal: true,
        data: { type: "networkError", response: { code: 403 } },
      }),
    ).toBe(403);
  });
});

describe("HLS player 错误分流", () => {
  test("非 fatal 显式忽略，普通 player 错误保留既有上报", () => {
    expect(
      classifyHlsPlayerError({
        fatal: false,
        type: "networkError",
        details: "fragLoadError",
      }),
    ).toEqual({ type: "ignore" });
    expect(classifyHlsPlayerError(new Error("play failed"))).toEqual({
      type: "player_error",
    });
    expect(classifyHlsPlayerError(new DOMException("blocked", "NotAllowedError"))).toEqual({
      type: "player_error",
    });
  });

  test("Video.js 外层 MediaError 优先使用 data 中的 hls.js 事实", () => {
    expect(
      classifyHlsPlayerError({
        code: 2,
        fatal: true,
        message: "network",
        data: { fatal: false, type: "networkError", details: "fragLoadError" },
      }),
    ).toEqual({ type: "ignore" });
    expect(
      classifyHlsPlayerError({
        code: 2,
        fatal: true,
        data: { fatal: true, type: "networkError", details: "manifestLoadError" },
      }),
    ).toEqual({ type: "fatal", recovery: "startLoad" });
    expect(
      classifyHlsPlayerError({
        code: 3,
        fatal: true,
        data: { fatal: true, type: "mediaError", details: "bufferAppendError" },
      }),
    ).toEqual({ type: "fatal", recovery: "recoverMediaError" });
  });

  test("非 network/media 的 hls fatal 不调用恢复 API", () => {
    expect(
      classifyHlsPlayerError({
        fatal: true,
        type: "keySystemError",
        details: "keySystemNoKeys",
      }),
    ).toEqual({ type: "player_error" });
  });
});
