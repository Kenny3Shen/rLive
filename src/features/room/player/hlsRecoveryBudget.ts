import type { SiteId } from "@/shared/types/live";
import { playbackWasStable } from "../playback/playbackRecoverySession";

export const BILIBILI_HLS_FATAL_RECOVERY_GRACE_MS = 20_000;

export type HlsFatalRecoveryAction = { type: "restart" } | { type: "recovery_exhausted" };

/**
 * 播放器错误如何进入 HLS 恢复链。
 *
 * `@videojs/hlsjs-video` 的适配器已经过滤非 fatal 的 hls.js 事件；这里仍显式
 * 忽略 `fatal: false`，避免其他错误入口把普通分片重试升级成重载。只有
 * networkError / mediaError 能由 hls.js 的公开恢复 API 处理，其余错误保留
 * 既有播放器错误上报路径。
 */
export type HlsPlayerErrorDisposition =
  | { type: "ignore" }
  | { type: "player_error" }
  | { type: "fatal"; recovery: "startLoad" | "recoverMediaError" };

function hlsErrorPayload(error: unknown): { fatal?: unknown; type?: unknown } | null {
  if (!error || typeof error !== "object") return null;
  // Video.js 的 MediaError 外层也有 fatal；真正的 hls.js type 与 response 在 data。
  if ("data" in error && error.data && typeof error.data === "object") {
    return error.data as { fatal?: unknown; type?: unknown };
  }
  return error;
}

export function classifyHlsPlayerError(error: unknown): HlsPlayerErrorDisposition {
  const payload = hlsErrorPayload(error);
  if (!payload || typeof payload.fatal !== "boolean") {
    return { type: "player_error" };
  }
  if (!payload.fatal) return { type: "ignore" };
  if (payload.type === "networkError") {
    return { type: "fatal", recovery: "startLoad" };
  }
  if (payload.type === "mediaError") {
    return { type: "fatal", recovery: "recoverMediaError" };
  }
  return { type: "player_error" };
}

export function shouldEscalateNonTwitchHlsFatal(input: {
  siteId: SiteId | undefined;
  failureCount: number;
  firstFailureAt: number;
  now: number;
}): boolean {
  if (input.failureCount <= 1) return false;
  if (input.siteId !== "bilibili") return true;
  return input.now - input.firstFailureAt >= BILIBILI_HLS_FATAL_RECOVERY_GRACE_MS;
}

/**
 * 播放器错误到达这一边界之前 hls.js 已经尝试过其内建恢复。再重试一次，
 * 然后报告传输恢复已耗尽，让播放会话选择下一个领域动作。
 */
export function nextHlsFatalRecoveryAction(
  failureCount: number,
  commercialBreak = false,
  authorizationFailed = false,
): HlsFatalRecoveryAction {
  // Twitch 媒体清单上的 401/403 通常只是短时效签名 URL 过期。
  // 对着同一 URL 重放只会重复失败。
  if (authorizationFailed && !commercialBreak) {
    return { type: "recovery_exhausted" };
  }
  if (failureCount <= 1) return { type: "restart" };
  return { type: "recovery_exhausted" };
}

export function isTwitchCommercialBreak(error: unknown): boolean {
  if (typeof error === "string") {
    return /commercial\s+break\s+in\s+progress/i.test(error);
  }
  if (!error || typeof error !== "object") return false;
  const value = error as {
    message?: unknown;
    errorMessage?: unknown;
    reason?: unknown;
    originError?: unknown;
    error?: { message?: unknown };
    response?: { data?: unknown };
    data?: {
      message?: unknown;
      errorMessage?: unknown;
      reason?: unknown;
      originError?: unknown;
      error?: { message?: unknown };
      response?: { data?: unknown };
    };
  };
  const payload = value.data ?? value;
  const candidates = [
    payload.message,
    payload.errorMessage,
    payload.reason,
    payload.originError,
    payload.error?.message,
    payload.response?.data,
  ];
  return candidates.some(
    (candidate) =>
      typeof candidate === "string" && /commercial\s+break\s+in\s+progress/i.test(candidate),
  );
}

export function hlsResponseStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const value = error as {
    httpCode?: unknown;
    status?: unknown;
    response?: { code?: unknown; status?: unknown };
    ext?: { httpCode?: unknown; response?: { code?: unknown; status?: unknown } };
    data?: {
      httpCode?: unknown;
      status?: unknown;
      response?: { code?: unknown; status?: unknown };
      ext?: { httpCode?: unknown; response?: { code?: unknown; status?: unknown } };
    };
  };
  const payload = value.data ?? value;
  const candidates = [
    payload.httpCode,
    payload.status,
    payload.response?.status,
    payload.response?.code,
    payload.ext?.httpCode,
    payload.ext?.response?.status,
    payload.ext?.response?.code,
  ];
  const status = candidates.find(
    (candidate): candidate is number => typeof candidate === "number" && Number.isFinite(candidate),
  );
  return status ?? null;
}

export type HlsRecoveryBudgetAction =
  | { type: "restart"; recovery: "startLoad" | "recoverMediaError" }
  | { type: "recovery_exhausted"; commercialBreak: boolean };

export type HlsRecoveryBudget = {
  /** 播放重新开始；连续计时只在首个 playing 起算，重复事件不重置。 */
  notePlaying(): void;
  /**
   * timeupdate 观察到媒体时间真实前进时调用。
   *
   * network fatal 恢复后浏览器可能不再补发 playing；实际时间进展同样开启连续
   * 计时。与 notePlaying 共用起点，重复调用不会延长或缩短稳定窗口。
   */
  noteProgress(): void;
  /** waiting / pause / seeking 终止连续播放计时，已满 30 秒的稳定事实仍保留到下次 fatal。 */
  noteInterrupted(): void;
  recordFatal(input: {
    recovery: "startLoad" | "recoverMediaError";
    commercialBreak?: boolean;
    responseStatus?: number | null;
  }): HlsRecoveryBudgetAction;
};

/**
 * 每个 HLS 传输一份恢复预算。
 *
 * 不读取 DOM，也不触发 React 更新；调用方只在媒体事件和 fatal 到达时推进。
 * 短暂 playing 不会清零；连续有效播放满 30 秒后，下一次 fatal 先清零旧预算，
 * 再把自身计为新一轮的第一条 fatal。
 */
export function createHlsRecoveryBudget(input: {
  siteId: SiteId | undefined;
  now?: () => number;
}): HlsRecoveryBudget {
  const now = input.now ?? Date.now;
  let failureCount = 0;
  let firstFailureAt: number | null = null;
  let playingStartedAt: number | null = null;
  let stablePlaybackNeedsReset = false;

  /** 返回这次事件是否跨越了稳定播放边界。 */
  const settlePlayingInterval = (at: number): boolean => {
    const crossedBoundary = playbackWasStable(playingStartedAt, at);
    playingStartedAt = null;
    return crossedBoundary;
  };

  const reset = () => {
    failureCount = 0;
    firstFailureAt = null;
    playingStartedAt = null;
    stablePlaybackNeedsReset = false;
  };

  return {
    notePlaying() {
      if (playingStartedAt == null) playingStartedAt = now();
    },
    noteProgress() {
      if (playingStartedAt == null) playingStartedAt = now();
    },
    noteInterrupted() {
      if (settlePlayingInterval(now())) stablePlaybackNeedsReset = true;
    },
    recordFatal(fatal) {
      const at = now();
      const crossedStableBoundary = settlePlayingInterval(at);
      // 当前 fatal 到达时已满 30 秒，它本身就是「稳定后的下一条 fatal」：
      // 先清零旧预算，再把它计为新一轮的第一条，不能等到再下一条。
      if (crossedStableBoundary || stablePlaybackNeedsReset) reset();

      failureCount += 1;
      firstFailureAt ??= at;
      const commercialBreak = fatal.commercialBreak === true;
      const action =
        input.siteId === "twitch"
          ? nextHlsFatalRecoveryAction(
              failureCount,
              commercialBreak,
              fatal.responseStatus === 401 || fatal.responseStatus === 403,
            )
          : shouldEscalateNonTwitchHlsFatal({
                siteId: input.siteId,
                failureCount,
                firstFailureAt,
                now: at,
              })
            ? { type: "recovery_exhausted" as const }
            : { type: "restart" as const };

      return action.type === "restart"
        ? { type: "restart", recovery: fatal.recovery }
        : { type: "recovery_exhausted", commercialBreak };
    },
  };
}
