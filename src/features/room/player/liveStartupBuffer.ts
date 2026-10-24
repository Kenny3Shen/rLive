import type { SiteId } from "@/shared/types/live";
import type Mpegts from "mpegts.js";
import type { VideoJsPlaybackKind } from "./videoJsPlayer";

/** Bilibili FLV 起播前积累的可播余量，约等于一个较宽的网络抖动窗口。 */
export const BILIBILI_FLV_STARTUP_BUFFER_SECONDS = 3;

const STARTUP_BUFFER_POLL_MS = 100;
/** 首段媒体时间戳通常略晚于 `currentTime = 0`，这点空隙仍可视为连续起播。 */
export const STARTUP_BUFFER_MAX_LEAD_SECONDS = 0.25;

type BufferedMedia = {
  currentTime: number;
  buffered: Pick<TimeRanges, "length" | "start" | "end">;
};

type StartupBufferMedia = BufferedMedia &
  Pick<EventTarget, "addEventListener" | "removeEventListener">;

export type StartupBufferResult = "ready" | "stopped" | "cancelled" | "error" | "ended";

/**
 * 从当前位置起，单一连续缓冲区间还能播放多久。
 *
 * 不允许跨过未缓冲空洞累加多个区间，否则网络停顿时会把两段不相邻的数据
 * 误当成足够的安全余量。
 */
export function contiguousBufferedAheadSeconds(
  media: BufferedMedia,
  maxLeadSeconds = STARTUP_BUFFER_MAX_LEAD_SECONDS,
): number {
  const currentTime = media.currentTime;
  if (!Number.isFinite(currentTime)) return 0;

  let nearestStart = Number.POSITIVE_INFINITY;
  let available = 0;
  for (let index = 0; index < media.buffered.length; index += 1) {
    const start = media.buffered.start(index);
    const end = media.buffered.end(index);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= currentTime) continue;
    if (start > currentTime + maxLeadSeconds) continue;
    // 只取起点最接近 currentTime 的连续段。允许起始空隙时，时间轴更靠后的
    // 第二段不能被误当成从当前位置延续。
    if (start < nearestStart) {
      nearestStart = start;
      available = end - Math.max(currentTime, start);
    }
  }
  return available;
}

/** 只对 Bilibili FLV 的自动起播生效；多画面对齐自行管理直播延迟。 */
export function shouldPrimeBilibiliFlvStartup(
  siteId: SiteId | undefined,
  playbackKind: VideoJsPlaybackKind | null,
  syncHold: boolean,
): boolean {
  return siteId === "bilibili" && playbackKind === "flv" && !syncHold;
}

/** Bilibili FLV 使用更宽的追帧余量；其他站点保持各自原有延迟策略。 */
export function bilibiliFlvLatencyConfig(
  siteId: SiteId | undefined,
  syncHold: boolean,
): Pick<Mpegts.Config, "liveBufferLatencyMinRemain" | "liveBufferLatencyMaxLatency"> {
  if (!shouldPrimeBilibiliFlvStartup(siteId, "flv", syncHold)) return {};
  return { liveBufferLatencyMinRemain: BILIBILI_FLV_STARTUP_BUFFER_SECONDS };
}

/**
 * 等待连续可播缓冲达到目标值。
 *
 * `shouldContinue()` 表达本次等待是否仍有效。取消、用户暂停、手动起播或播放器
 * 换代都应让它返回 false，并立即释放监听器与轮询定时器。返回值区分正常就绪、
 * 用户停止、外部取消、媒体错误与结束，供调用方决定是否继续自动起播。
 */
export function waitForContinuousBuffer(
  media: StartupBufferMedia,
  targetSeconds: number,
  shouldContinue: () => boolean,
  signal?: AbortSignal,
): Promise<StartupBufferResult> {
  if (signal?.aborted) return Promise.resolve("cancelled");
  if (!shouldContinue()) return Promise.resolve("stopped");
  if (!(targetSeconds > 0)) return Promise.resolve("ready");

  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const cleanup = () => {
      if (timer != null) {
        clearInterval(timer);
        timer = null;
      }
      media.removeEventListener("loadedmetadata", check);
      media.removeEventListener("canplay", check);
      media.removeEventListener("progress", check);
      media.removeEventListener("timeupdate", check);
      media.removeEventListener("play", check);
      media.removeEventListener("pause", check);
      media.removeEventListener("error", onError);
      media.removeEventListener("ended", onEnded);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (result: StartupBufferResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const check = () => {
      if (signal?.aborted) return finish("cancelled");
      if (!shouldContinue()) return finish("stopped");
      if (contiguousBufferedAheadSeconds(media) >= targetSeconds) finish("ready");
    };
    const onAbort = () => finish("cancelled");
    const onError = () => finish("error");
    const onEnded = () => finish("ended");

    media.addEventListener("loadedmetadata", check);
    media.addEventListener("canplay", check);
    media.addEventListener("progress", check);
    media.addEventListener("timeupdate", check);
    media.addEventListener("play", check);
    media.addEventListener("pause", check);
    media.addEventListener("error", onError);
    media.addEventListener("ended", onEnded);
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setInterval(check, STARTUP_BUFFER_POLL_MS);
    check();
  });
}
