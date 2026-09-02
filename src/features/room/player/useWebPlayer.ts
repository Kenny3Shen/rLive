import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invokeCmd } from "@/shared/api/tauri";
import { getClientPlatform } from "@/shared/clientPlatform";
import type { PlayUrl, SiteId } from "@/shared/types/live";
import type { PlayerEvent, PlayerUiMode, StreamProxyTelemetry } from "@/shared/types/player";
import type { AppError } from "@/shared/types/error";
import { playbackProtocol, playbackSourceId } from "@/lib/playUrl";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import {
  createNativeFullscreenSession,
  restoreNativePlayerMaximizedState,
  setNativePlayerFullscreen,
  toggleNativePlayerFullscreen,
} from "@/shared/nativePlayerFullscreen";
import {
  beginFullscreenTransition,
  frozenSafeAreaTopValue,
  shouldFreezeFullscreenInsets,
  FULLSCREEN_TRANSITION_TIMEOUT_MS,
} from "@/shared/fullscreenTransition";
import { runningOnAndroidTauri, setAndroidImmersive } from "./androidImmersive";
import { videoAspectRatio } from "./androidOrientation";
import { requestPlayerAutoplay } from "./autoplay";
import { createSerialTaskQueue } from "./serialTaskQueue";
import {
  createXgPlayer,
  getXgHlsCore,
  getXgMpegtsCore,
  isXgPlayerDecodeError,
  loadXgPlayerModules,
  switchXgPlaybackSource,
  webPlaybackKind,
  xgPlayerErrorMessage,
  type XgPlaybackKind,
  type XgPlayerInstance,
} from "./xgPlayer";
import {
  createPlaybackTelemetrySession,
  markTelemetryLongTask,
  markTelemetryPlaying,
  markTelemetryStalled,
  markTelemetryWaiting,
  samplePlaybackTelemetry,
  type PlaybackTelemetrySession,
} from "./playbackTelemetry";

/**
 * 位于 `media.currentTime` 处那一帧的挂钟时间，取自播放列表的
 * `EXT-X-PROGRAM-DATE-TIME`。清单不带节目时钟时为 null。
 */
export function isTauriDesktop(): boolean {
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in window &&
    getClientPlatform() === "desktop"
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => window.setTimeout(r, ms));
}

function nextFrame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

export { requestPlayerAutoplay } from "./autoplay";

export type PictureInPictureDocument = {
  pictureInPictureEnabled?: boolean;
  pictureInPictureElement?: Element | null;
  exitPictureInPicture?: () => Promise<void>;
};

/** 协议内核挂载时直接使用 mpegts.js 的 seek 路径。 */
export function canUsePictureInPicture(
  documentRef: Pick<PictureInPictureDocument, "pictureInPictureEnabled"> | null | undefined,
  video:
    | Pick<HTMLVideoElement, "disablePictureInPicture" | "requestPictureInPicture">
    | null
    | undefined,
): boolean {
  return Boolean(
    documentRef?.pictureInPictureEnabled &&
    video &&
    !video.disablePictureInPicture &&
    typeof video.requestPictureInPicture === "function",
  );
}

export function getPictureInPictureDocument(): PictureInPictureDocument | null {
  return typeof document === "undefined" ? null : (document as PictureInPictureDocument);
}

export async function exitPictureInPictureForVideo(
  documentRef: PictureInPictureDocument | null,
  video: HTMLVideoElement | null,
): Promise<void> {
  if (
    !documentRef ||
    !video ||
    documentRef.pictureInPictureElement !== video ||
    typeof documentRef.exitPictureInPicture !== "function"
  ) {
    return;
  }

  try {
    await documentRef.exitPictureInPicture();
  } catch {
    // 按所选直播源惰性加载所需的唯一协议插件。
  }
}

/**
 * 插件在每次 URL 变化时销毁并重建其 mpegts.js 实例。即使调用本助手时第一个
 * 内核已经存在，也要把订阅挂在当前实例上。
 */
export async function toggleVideoPictureInPicture(
  documentRef: PictureInPictureDocument | null | undefined,
  video:
    | Pick<HTMLVideoElement, "disablePictureInPicture" | "requestPictureInPicture">
    | null
    | undefined,
): Promise<boolean> {
  if (!documentRef || !video || !canUsePictureInPicture(documentRef, video)) return false;

  try {
    if (documentRef.pictureInPictureElement === (video as unknown as Element)) {
      if (typeof documentRef.exitPictureInPicture !== "function") return false;
      await documentRef.exitPictureInPicture();
      return true;
    }

    if (documentRef.pictureInPictureElement) {
      if (typeof documentRef.exitPictureInPicture !== "function") return false;
      await documentRef.exitPictureInPicture();
      // xgplayer-mpegts.js 在 URL_CHANGE 时重建自己的 transmuxer/MSE 状态。保留外层
      // 播放器与媒体元素，但不要求跨相互独立的 FLV CDN 保持时间戳无缝。
      if (documentRef.pictureInPictureElement) return false;
    }

    await video.requestPictureInPicture();
    return true;
  } catch {
    return false;
  }
}

/**
 * xgplayer 从 Player.start() 启动协议插件，且插件在 URL 变化时替换 hls.js 实例。
 * 始终经由插件读取，使恢复调用与时钟读取对两者都保持有效。
 */
export type FullscreenDocument = {
  fullscreenElement?: Element | null;
  webkitFullscreenElement?: Element | null;
  exitFullscreen?: () => Promise<void> | void;
  webkitExitFullscreen?: () => Promise<void> | void;
  webkitCancelFullScreen?: () => Promise<void> | void;
};

export type FullscreenTarget = {
  requestFullscreen?: () => Promise<void> | void;
  webkitRequestFullscreen?: () => Promise<void> | void;
  webkitRequestFullScreen?: () => Promise<void> | void;
};

export function fullscreenElementFor(
  documentRef: FullscreenDocument | null | undefined,
): Element | null {
  return documentRef?.fullscreenElement ?? documentRef?.webkitFullscreenElement ?? null;
}

/** Chromium 经多层上报 HLS/MSE 解码失败：原生媒体错误用 code 3，而 xgplayer 协议
插件可能给出 code 5103 或只保留浏览器的 pipeline message。检查保持结构化，
使 Twitch 能降级不兼容的渲染档，
而不把网络失败当成编解码问题。 */
export async function toggleElementFullscreen(
  documentRef: FullscreenDocument | null | undefined,
  target: FullscreenTarget | null | undefined,
): Promise<boolean> {
  if (!documentRef || !target) return false;

  const activeElement = fullscreenElementFor(documentRef);
  if (activeElement) {
    const exit =
      documentRef.exitFullscreen ??
      documentRef.webkitExitFullscreen ??
      documentRef.webkitCancelFullScreen;
    if (!exit) return false;
    await exit.call(documentRef);
    return true;
  }

  const request =
    target.requestFullscreen ?? target.webkitRequestFullscreen ?? target.webkitRequestFullScreen;
  if (!request) return false;
  await request.call(target);
  return true;
}

export function getFullscreenDocument(): FullscreenDocument | null {
  return typeof document === "undefined" ? null : (document as FullscreenDocument);
}

/**
 * 原生窗口全屏属于窗口而不属于某个播放器，同一窗口中挂载的多个播放器观察到的
 * 都是同一状态。只有拥有全屏控制权的播放器可以上报或驱动它；其余保持窗口化，
 * 使多房间的次要流保留常规网格 chrome，
 * 而主流是铺满屏幕的那个表面。
 */
export function playerOwnsFullscreen(fullscreenOwner: boolean | undefined): boolean {
  return fullscreenOwner !== false;
}

/** 一条流的媒体时间轴如何映射到挂钟时间（若有）。 */
export type LivePlayerClockKind = "program-date" | "stream-anchor" | "none";

export type LivePlayerTimeline = {
  /** 正在播放且至少有一个已缓冲区段：可以安全校正。 */
  ready: boolean;
  mediaTime: number;
  bufferStart: number;
  /** 该流自身媒体时间轴上的直播边缘。 */
  bufferEnd: number;
  clockKind: LivePlayerClockKind;
  /** 与 `mediaTime === 0` 对应的纪元（毫秒）；无时钟时为 null。 */
  epochAtMediaZeroMs: number | null;
};

/**
 * 多视图时钟对齐使用的命令式句柄。
 *
 * 每秒采样并校正多条流绝不能触发任何重渲染，
 * 因此这是一个稳定的对象、通过 refs 读取而不是 state。
 */
export type LivePlayerSyncApi = {
  readTimeline: () => LivePlayerTimeline;
  /** 在保留缓冲区内跳转；媒体不存在时为无操作。 */
  seekMediaTime: (seconds: number) => void;
  setPlaybackRate: (rate: number) => void;
};

export type WebPlayerApi = {
  mode: PlayerUiMode;
  paused: boolean;
  volume: number;
  muted: boolean;
  mediaAvailable: boolean;
  running: boolean;
  pictureInPictureSupported: boolean;
  pictureInPictureActive: boolean;
  loadError: string | null;
  /** 非致命的全屏失败，绝不能替换媒体视图。 */
  fullscreenError: string | null;
  setLoadError: (msg: string | null) => void;
  /** 自增强制全新的 <video> 节点（清除卡死的 MediaSource）。 */
  mediaKey: number;
  /** 解码帧宽高比；首个元数据到达前为 null。 */
  aspectRatio: number | null;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  /** 由 xgplayer 管理的独占 DOM 根；浮层留在其外部。 */
  playerRootRef: React.RefObject<HTMLDivElement | null>;
  stageRef: React.RefObject<HTMLDivElement | null>;
  togglePause: () => void;
  /** 直接应用手势帧，不协调播放器树。 */
  previewVolume: (v: number) => void;
  changeVolume: (v: number) => void;
  setAudio: (volume: number, muted: boolean) => void;
  toggleMute: () => void;
  togglePictureInPicture: () => Promise<void>;
  exitPictureInPicture: () => Promise<void>;
  toggleFullscreen: () => Promise<void>;
  /** 退出全屏且不再切回；窗口化状态下调用是安全的。 */
  exitFullscreen: () => Promise<void>;
  /** 多视图对齐使用的直播时钟采样/校正。 */
  sync: LivePlayerSyncApi;
};

export type MediaLifecycleProfile = Readonly<{
  retainSourceDuringGap: boolean;
  resetAudioOnSessionChange: boolean;
  softSwitch: "settings" | "disabled";
  telemetry: boolean;
  flvOptions(mobileClient: boolean, syncHold: boolean): Record<string, unknown>;
}>;

function clampWebPlayerVolume(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

export function normalizeWebPlayerAudio(
  initialVolume = 80,
  initialMuted = false,
): { volume: number; muted: boolean; previousVolume: number } {
  const volume = clampWebPlayerVolume(initialVolume);
  return {
    volume,
    muted: initialMuted || volume === 0,
    previousVolume: volume > 0 ? volume : 80,
  };
}

/** 把一份归一化的音频快照应用到活动房间的媒体元素上。 */
export function applyWebPlayerAudio(
  video: Pick<HTMLMediaElement, "volume" | "muted">,
  volume: number,
  muted: boolean,
): { volume: number; muted: boolean } {
  const normalizedVolume = clampWebPlayerVolume(volume);
  const normalizedMuted = muted || normalizedVolume === 0;
  video.volume = normalizedVolume / 100;
  video.muted = normalizedMuted;
  return { volume: normalizedVolume, muted: normalizedMuted };
}

/** 直播地址是否需要 xgplayer 的 HLS 插件而非 FLV 插件。 */
export function isHlsStream(url: string): boolean {
  return /\.m3u8(?:[?#]|$)/i.test(url) || /[/?&=_-]hls(?:[/?&=_-]|$)/i.test(url);
}

/**
 * `HTMLMediaElement.play()` 在首帧就绪之前就清除 `paused`。把这个中间状态当作
 * 健康会在流仍在加载时重置 Twitch 续期预算，
 * 并可能造成无限重载循环。
 */
export function hasStartedPlayback(
  video: Pick<HTMLMediaElement, "paused" | "readyState">,
): boolean {
  return !video.paused && video.readyState >= 2;
}

export const BILIBILI_HLS_FATAL_RECOVERY_GRACE_MS = 20_000;

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

export type HlsFatalRecoveryAction = { type: "restart" } | { type: "recovery_exhausted" };

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

/**
 * 广告插播是平台下发的内容，不是要绕过的错误。部分瞬态清单响应以此文本代替
 * 清单；识别它可以等待并在插播结束后正常刷新。
 */
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
  };
  const candidates = [
    value.message,
    value.errorMessage,
    value.reason,
    value.originError,
    value.error?.message,
    value.response?.data,
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
  };
  const candidates = [
    value.httpCode,
    value.status,
    value.response?.status,
    value.response?.code,
    value.ext?.httpCode,
    value.ext?.response?.status,
    value.ext?.response?.code,
  ];
  const status = candidates.find(
    (candidate): candidate is number => typeof candidate === "number" && Number.isFinite(candidate),
  );
  return status ?? null;
}

export function playUrlKey(playUrl: PlayUrl | null): string {
  if (!playUrl) return "";
  // 包含稳定的头部指纹，使 cookie/referer 变化也会触发重载。JSON 使 URL 与请求头
  // 取值中的分隔符无歧义，并可在下方重建为不可变的播放快照。
  return JSON.stringify([
    playUrl.url,
    Object.entries(playUrl.headers).sort(([a], [b]) => a.localeCompare(b)),
    playUrl.source_id,
    playUrl.label,
    playUrl.protocol,
    playUrl.priority,
  ]);
}

/**
 * 为连续 FLV 保持适度的延迟与清理窗口。移动端解码和调度预算更紧，
 * 获得更宽的直播窗口。
 *
 * `syncHold` 是多视图时钟对齐配置：内建的延迟追赶会在对齐把流拉得更靠后时立刻
 * 跳回直播边缘，因此关闭它并把向后窗口拓宽到对齐偏移可能用到的范围。
 */
export function liveFlvPlaybackOptions(
  mobileClient: boolean,
  syncHold = false,
): Record<string, unknown> {
  return {
    mediaDataSource: {
      type: "flv",
      isLive: true,
      hasAudio: true,
      hasVideo: true,
    },
    mpegtsConfig: {
      enableWorker: false,
      enableStashBuffer: true,
      stashInitialSize: 384,
      liveBufferLatencyChasing: !syncHold,
      liveBufferLatencyMaxLatency: mobileClient ? 6 : 5,
      liveBufferLatencyMinRemain: mobileClient ? 1.5 : 1,
      autoCleanupSourceBuffer: true,
      autoCleanupMaxBackwardDuration: syncHold
        ? LIVE_SYNC_HOLD_MAX_BACKWARD_SECONDS
        : mobileClient
          ? 20
          : 15,
      autoCleanupMinBackwardDuration: syncHold
        ? LIVE_SYNC_HOLD_MIN_BACKWARD_SECONDS
        : mobileClient
          ? 10
          : 8,
    },
  };
}

/**
 * 单场直播流的 hls.js 选项。
 *
 * 在 `syncHold` 下与直播边缘的距离由对齐负责，hls.js 既不能在该距离增大时强行
 * 前跳，也不能丢弃对齐要 seek 进去的后向缓冲。
 */
export function liveHlsPlaybackOptions(syncHold = false): Record<string, unknown> {
  return {
    lowLatencyMode: false,
    backBufferLength: syncHold ? LIVE_SYNC_HOLD_MAX_BACKWARD_SECONDS : 30,
    maxBufferLength: syncHold ? 45 : 30,
    liveSyncDurationCount: 3,
    liveMaxLatencyDurationCount: syncHold ? 90 : 6,
    // 任何 hls.js 的速率校正都会与对齐自身的速率微调打架。
    maxLiveSyncPlaybackRate: 1,
    manifestLoadingMaxRetry: 3,
    levelLoadingMaxRetry: 3,
    fragLoadingMaxRetry: 3,
  };
}

/** MPEG-TS（IPTV 风格）直播选项，对齐 FLV 的 sync-hold 规则。 */
export function liveMpegtsPlaybackOptions(syncHold = false): Record<string, unknown> {
  return {
    mediaDataSource: {
      type: "mpegts",
      isLive: true,
      hasAudio: true,
      hasVideo: true,
    },
    mpegtsConfig: {
      enableWorker: false,
      enableStashBuffer: true,
      stashInitialSize: 384,
      liveBufferLatencyChasing: !syncHold,
      liveBufferLatencyMaxLatency: 3,
      liveBufferLatencyMinRemain: 0.5,
      autoCleanupSourceBuffer: true,
      ...(syncHold
        ? {
            autoCleanupMaxBackwardDuration: LIVE_SYNC_HOLD_MAX_BACKWARD_SECONDS,
            autoCleanupMinBackwardDuration: LIVE_SYNC_HOLD_MIN_BACKWARD_SECONDS,
          }
        : {}),
    },
  };
}

export function iptvFlvPlaybackOptions(): Record<string, unknown> {
  return {
    mediaDataSource: {
      type: "flv",
      isLive: true,
      hasAudio: true,
      hasVideo: true,
    },
    mpegtsConfig: {
      enableWorker: false,
      enableStashBuffer: true,
      stashInitialSize: 384,
      liveBufferLatencyChasing: true,
      liveBufferLatencyMaxLatency: 3,
      liveBufferLatencyMinRemain: 0.5,
      autoCleanupSourceBuffer: true,
    },
  };
}

export const LIVE_MEDIA_LIFECYCLE_PROFILE: MediaLifecycleProfile = {
  retainSourceDuringGap: true,
  resetAudioOnSessionChange: true,
  softSwitch: "settings",
  telemetry: true,
  flvOptions: liveFlvPlaybackOptions,
};

export const IPTV_MEDIA_LIFECYCLE_PROFILE: MediaLifecycleProfile = {
  retainSourceDuringGap: false,
  resetAudioOnSessionChange: false,
  softSwitch: "disabled",
  telemetry: false,
  flvOptions: () => iptvFlvPlaybackOptions(),
};

/**
 * 多视图对齐激活期间每条流保留的后向缓冲。
 *
 * 对齐只会通过 seek 进已缓冲的媒体来延迟一条流，因此这个窗口限制它能施加的
 * 偏移量。刻意设为有限：六条流各保留一分钟视频的内存代价
 * 远高于对齐本身的价值。
 */
export const LIVE_SYNC_HOLD_MIN_BACKWARD_SECONDS = 30;
export const LIVE_SYNC_HOLD_MAX_BACKWARD_SECONDS = 42;
/** 同步校正可以在静音次要流上请求的速率范围。 */
export const LIVE_SYNC_MIN_PLAYBACK_RATE = 0.9;
export const LIVE_SYNC_MAX_PLAYBACK_RATE = 1.1;
/**
 * 仍可视为"刚启动"的最长已缓冲跨度。
 *
 * 流锚点把代理的首媒体字节与该字节产生的媒体位置配对，而这只有在传输刚刚开始
 * 时才可知。软切换之后元素可能仍持有很长的保留缓冲，其起点不再标记替代流的
 * 起点，因此该流不携带估计时钟，而不是编造一个。
 */
export const LIVE_SYNC_ANCHOR_FRESH_BUFFER_SECONDS = 20;

export function shouldUsePlaybackSoftSwitch(
  configured: boolean,
  playbackKind: XgPlaybackKind | null,
): boolean {
  return (
    configured && (playbackKind === "flv" || playbackKind === "hls" || playbackKind === "mpegts")
  );
}

export function canSoftSwitchPlaybackSource(input: {
  enabled: boolean;
  activeSourceKey: string;
  targetSourceKey: string;
  activeKind: XgPlaybackKind | null;
  targetKind: XgPlaybackKind | null;
}): boolean {
  return Boolean(
    input.enabled &&
    input.activeSourceKey &&
    input.targetSourceKey &&
    input.activeSourceKey !== input.targetSourceKey &&
    input.activeKind &&
    input.activeKind === input.targetKind,
  );
}

function playbackSourceFromKey(key: string): PlayUrl | null {
  if (!key) return null;
  try {
    const parsed: unknown = JSON.parse(key);
    if (!Array.isArray(parsed) || typeof parsed[0] !== "string" || !Array.isArray(parsed[1])) {
      return null;
    }
    const entries = parsed[1].filter(
      (entry): entry is [string, string] =>
        Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "string",
    );
    const protocol = parsed[4];
    if (
      protocol !== "flv" &&
      protocol !== "hls" &&
      protocol !== "mpeg_ts" &&
      protocol !== "native" &&
      protocol !== "unknown"
    ) {
      return null;
    }
    const sourceId = parsed[2];
    const label = parsed[3];
    const priority = parsed[5];
    if (
      typeof sourceId !== "string" ||
      typeof label !== "string" ||
      typeof priority !== "number" ||
      !Number.isFinite(priority)
    ) {
      return null;
    }
    return {
      url: parsed[0],
      headers: Object.fromEntries(entries),
      source_id: sourceId,
      label,
      protocol,
      priority,
    };
  } catch {
    return null;
  }
}

// 串行化前端生命周期命令，使销毁与同会话软切换无法交错。原生代理为每个会话
// 维护独立监听器，此队列不在播放器实例之间转移所有权。
const proxyLifecycleQueue = createSerialTaskQueue();

let nextPlayerInstanceId = 0;

function createPlayerInstanceId(): string {
  nextPlayerInstanceId = (nextPlayerInstanceId + 1) % Number.MAX_SAFE_INTEGER;
  // ID 也要跨 WebView 重载保持唯一：来自先前 JS 上下文的延迟命令
  // 不得意外接管新打开的代理。
  const entropy = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  return `web-player-${entropy}-${nextPlayerInstanceId}`;
}

/**
 * DOM 直播播放器（HLS / MSE，不用 mpv）。经本机代理推流，
 * 使 CDN 请求头与嵌套 HLS 资源始终一致工作。
 *
 * 重进修复：每次打开都自增 `mediaKey`（新 <video>）、停止代理、等待一个 tick、
 * 再以缓存穿透参数启动全新代理 URL。避免复用的 MediaSource / 过期的 CDN URL /
 * 半销毁的 xgplayer 实例导致的黑屏。
 */
export type MediaLifecycleOptions = {
  playUrl: PlayUrl | null;
  siteId?: SiteId;
  quality?: string | null;
  /** 即使两个房间碰巧解析出同一个流地址也重建。 */
  sessionKey?: string;
  /** 实例各自的音频默认值；多房间次要播放器默认静音启动。 */
  initialVolume?: number;
  initialMuted?: boolean;
  /**
   * 该播放器是否可以驱动并观察全屏。多房间在一个窗口中挂载多个播放器，
   * 全屏只属于主流；次要播放器传 false。默认 true。
   */
  fullscreenOwner?: boolean;
  /** 语义重建 key；变化时为同一来源重建传输层。 */
  reloadToken?: number | string;
  /**
   * 为多视图时钟对齐配置传输层：关闭内建延迟追赶并加宽后向缓冲。变更它会重建
   * 传输层，因为两个协议插件都只在创建时读取这些选项。
   */
  liveSyncHold?: boolean;
  onMediaFailure?: (event: PlayerEvent) => void;
  onReady?: () => void;
  onWaiting?: () => void;
  onPause?: () => void;
  onPlaying?: () => void;
  profile: MediaLifecycleProfile;
};

export type WebPlayerOptions = Omit<MediaLifecycleOptions, "profile">;

export function useMediaLifecycle(opts: MediaLifecycleOptions): WebPlayerApi {
  const {
    playUrl,
    siteId,
    quality = null,
    sessionKey = "",
    initialVolume = 80,
    initialMuted = false,
    fullscreenOwner = true,
    reloadToken = 0,
    liveSyncHold = false,
    onMediaFailure,
    onReady,
    onWaiting,
    onPause,
    onPlaying,
    profile,
  } = opts;
  const initialAudio = normalizeWebPlayerAudio(initialVolume, initialMuted);
  const softSwitchConfigured = useSettingsStore((state) => state.playbackSoftSwitchEnabled);
  const clientPlatform = getClientPlatform();
  const mobileClient = clientPlatform !== "desktop";
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const playerRootRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<XgPlayerInstance | null>(null);
  const playerInstanceIdRef = useRef<string | null>(null);
  const genRef = useRef(0);
  const mediaLifecycleVersionRef = useRef(0);
  const volumeRef = useRef(initialAudio.volume);
  const mutedRef = useRef(initialAudio.muted);
  const activeProxySessionIdRef = useRef<string | null>(null);
  const activeSourceKeyRef = useRef("");
  const activePlaybackKindRef = useRef<XgPlaybackKind | null>(null);
  const telemetrySessionRef = useRef<PlaybackTelemetrySession | null>(null);
  const hlsCoreRef = useRef<ReturnType<typeof getXgHlsCore>>(null);
  const mpegtsCoreRef = useRef<ReturnType<typeof getXgMpegtsCore>>(null);
  /** 当前媒体时间轴的身份；下方所有锚点都属于它。 */
  const syncTimelineTokenRef = useRef("");
  const syncStreamAnchorRef = useRef<{ token: string; epochAtMediaZeroMs: number } | null>(null);
  const syncMediaTimeOriginRef = useRef<{ token: string; mediaTime: number } | null>(null);
  const softSwitchSequenceRef = useRef(0);
  const softSwitchInFlightRef = useRef<{ player: XgPlayerInstance; sequence: number } | null>(null);
  const qualityRef = useRef<string | null>(quality);
  const nativeFullscreenSessionRef = useRef(createNativeFullscreenSession());
  // 释放在进入全屏过渡期间持有的 shell 内边距冻结；无冻结时为 null。
  const fullscreenInsetFreezeRef = useRef<(() => void) | null>(null);
  const fullscreenInsetFreezeTimerRef = useRef<number | null>(null);
  /** 为没有 `mode` 的销毁路径镜像页面内全屏状态。 */
  const inPageFullscreenRef = useRef(false);

  const [mode, setMode] = useState<PlayerUiMode>("windowed");
  const [paused, setPaused] = useState(false);
  const [volume, setVolume] = useState(initialAudio.volume);
  const [muted, setMuted] = useState(initialAudio.muted);
  const [prevVolume, setPrevVolume] = useState(initialAudio.previousVolume);
  const [mediaAvailable, setMediaAvailable] = useState(false);
  const [running, setRunning] = useState(false);
  const [pictureInPictureSupported, setPictureInPictureSupported] = useState(false);
  const [pictureInPictureActive, setPictureInPictureActive] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [fullscreenError, setFullscreenError] = useState<string | null>(null);
  const [mediaKey, setMediaKey] = useState(0);
  const [aspectRatio, setAspectRatio] = useState<number | null>(null);
  const [softFallbackToken, setSoftFallbackToken] = useState(0);
  const [activeSourceKey, setActiveSourceKey] = useState("");

  if (playerInstanceIdRef.current === null) {
    playerInstanceIdRef.current = createPlayerInstanceId();
  }

  const ownsFullscreen = playerOwnsFullscreen(fullscreenOwner);

  qualityRef.current = quality;

  useEffect(() => {
    volumeRef.current = volume;
    mutedRef.current = muted;
  }, [muted, volume]);

  const previousSessionKeyRef = useRef(sessionKey);
  useEffect(() => {
    if (previousSessionKeyRef.current === sessionKey) return;
    previousSessionKeyRef.current = sessionKey;
    if (!profile.resetAudioOnSessionChange) return;
    volumeRef.current = initialAudio.volume;
    mutedRef.current = initialAudio.muted;
    setVolume(initialAudio.volume);
    setMuted(initialAudio.muted);
    setPrevVolume(initialAudio.previousVolume);
  }, [
    initialAudio.muted,
    initialAudio.previousVolume,
    initialAudio.volume,
    profile.resetAudioOnSessionChange,
    sessionKey,
  ]);

  const onMediaFailureRef = useRef(onMediaFailure);
  const onReadyRef = useRef(onReady);
  const onWaitingRef = useRef(onWaiting);
  const onPauseRef = useRef(onPause);
  const onPlayingRef = useRef(onPlaying);
  onMediaFailureRef.current = onMediaFailure;
  onReadyRef.current = onReady;
  onWaitingRef.current = onWaiting;
  onPauseRef.current = onPause;
  onPlayingRef.current = onPlaying;

  const destroyPlayer = useCallback(() => {
    // PiP 请求是异步的。在这里自增版本使其续体检测到房间切换并关闭过期的原生窗口。
    mediaLifecycleVersionRef.current += 1;

    const video = videoRef.current;
    void exitPictureInPictureForVideo(getPictureInPictureDocument(), video);
    setPictureInPictureActive(false);
    // `pictureInPictureSupported` 是设备/文档能力，不是逐流状态。在这里清除它会让
    // 控件在每次销毁时卸载，卡顿的重连循环会让按钮闪烁。
    // 让它保持粘性；`togglePictureInPicture` 反正会重新检查可用性。

    const p = playerRef.current;
    playerRef.current = null;
    if (p) {
      try {
        p.pause();
      } catch {
        /* 忽略 */
      }
      try {
        p.destroy();
      } catch {
        /* 忽略 */
      }
    }
    if (video) {
      try {
        video.pause();
        video.removeAttribute("src");
        video.srcObject = null;
        video.load();
      } catch {
        /* 忽略 */
      }
    }
    activeSourceKeyRef.current = "";
    setActiveSourceKey("");
    activePlaybackKindRef.current = null;
    hlsCoreRef.current = null;
    mpegtsCoreRef.current = null;
    syncTimelineTokenRef.current = "";
    syncStreamAnchorRef.current = null;
    syncMediaTimeOriginRef.current = null;
    softSwitchInFlightRef.current = null;
    telemetrySessionRef.current = null;
    setMediaAvailable(false);
    setRunning(false);
  }, []);

  const playbackSourceKey = playUrlKey(playUrl);
  const streamKey = `${sessionKey}::${playbackSourceKey}`;
  // 查询结果可能在播放器运行期间替换等价的 PlayUrl 对象。按 `streamKey` 快照语义
  // 来源，使无害的对象身份抖动不会拆掉 MSE、重建 <video>
  // 并重启进程级代理。
  const playbackSource = useMemo(
    () => playbackSourceFromKey(playbackSourceKey),
    [playbackSourceKey],
  );
  const retainedPlaybackSourceRef = useRef<{
    roomKey: string;
    sourceKey: string;
    source: PlayUrl;
  } | null>(null);
  if (retainedPlaybackSourceRef.current?.roomKey !== sessionKey) {
    retainedPlaybackSourceRef.current = null;
  }
  if (playbackSource) {
    retainedPlaybackSourceRef.current = {
      roomKey: sessionKey,
      sourceKey: playbackSourceKey,
      source: playbackSource,
    };
  } else if (!profile.retainSourceDuringGap) {
    retainedPlaybackSourceRef.current = null;
  }
  // 画质查询期间控制器可能短暂没有地址。保持活动来源存活，
  // 使软切换不会在替代元数据加载时引入黑帧。
  const effectivePlaybackSource =
    playbackSource ??
    (profile.retainSourceDuringGap ? retainedPlaybackSourceRef.current?.source : null) ??
    null;
  const effectivePlaybackSourceKey =
    playbackSourceKey ||
    (profile.retainSourceDuringGap ? retainedPlaybackSourceRef.current?.sourceKey : "") ||
    "";
  const effectivePlaybackKind = effectivePlaybackSource
    ? webPlaybackKind(effectivePlaybackSource)
    : null;
  const softSwitchEnabled = shouldUsePlaybackSoftSwitch(
    profile.softSwitch === "settings" && softSwitchConfigured,
    effectivePlaybackKind,
  );
  const effectivePlaybackSourceRef = useRef<PlayUrl | null>(effectivePlaybackSource);
  effectivePlaybackSourceRef.current = effectivePlaybackSource;
  const hardStreamKey = softSwitchEnabled
    ? `${sessionKey}::${effectivePlaybackKind ?? "none"}::${softFallbackToken}::${liveSyncHold ? "sync" : "free"}`
    : `${streamKey}::${softFallbackToken}::${liveSyncHold ? "sync" : "free"}`;

  // 逻辑流身份变化时打开/替换流。
  useEffect(() => {
    let cancelled = false;
    const gen = ++genRef.current;
    const proxySessionId = `${playerInstanceIdRef.current}:${gen}`;
    let playbackSource = effectivePlaybackSourceRef.current;
    let sourceKey = playUrlKey(playbackSource);

    const stopProxy = async () => {
      try {
        await invokeCmd("stream_proxy_stop", { sessionId: proxySessionId });
      } catch {
        /* 忽略 */
      }
      if (activeProxySessionIdRef.current === proxySessionId) {
        activeProxySessionIdRef.current = null;
      }
    };

    if (!playbackSource) {
      destroyPlayer();
      void proxyLifecycleQueue.enqueue(stopProxy);
      setLoadError(null);
      return () => {
        cancelled = true;
        destroyPlayer();
        void proxyLifecycleQueue.enqueue(stopProxy);
      };
    }

    setLoadError(null);
    setFullscreenError(null);
    setPaused(false);
    const playbackKind = webPlaybackKind(playbackSource);
    const hlsSource = playbackKind === "hls";
    // 在串行化代理队列拆除上一会话的同时，开始抓取 xgplayer 与所选的唯一协议插件。
    const xgModulesPromise = loadXgPlayerModules(playbackKind);
    // 快速房间切换可能在到达下方 await 之前取消排队中的初始化。
    // 保留一个 rejection 处理器，使投机预加载永远不会变成未处理的 promise 拒绝。
    void xgModulesPromise.catch(() => {});

    void proxyLifecycleQueue
      .enqueue(async () => {
        // 更早路由排队的初始化可能在更新的路由渲染之后才被处理。它仍必须先停掉自己
        // 过期的代理，再允许替换操作通过队列。
        if (cancelled || genRef.current !== gen) {
          await stopProxy();
          return;
        }

        try {
          // 1) 彻底拆除上一个 MSE。即将开始的代理启动会原子地替换任何先前的监听器；
          // 清理只停止它自己拥有的监听器（见上方 proxySessionId）。
          destroyPlayer();
          // 让操作系统释放上一个监听套接字 / MediaSource 并稳定下来。
          await sleep(50);
          if (cancelled || genRef.current !== gen) return;

          // 2) 强制全新的 <video> 节点，绝不复用 MediaSource。
          setMediaKey((k) => k + 1);
          await nextFrame();
          await nextFrame();
          if (cancelled || genRef.current !== gen) return;

          // 等待新的 video 元素挂载完成（ref 已附着）。
          let video: HTMLVideoElement | null = null;
          for (let i = 0; i < 20; i += 1) {
            video = videoRef.current;
            if (video) break;
            await sleep(16);
          }
          if (!video) {
            throw {
              code: "web_player_no_video",
              message: "video element not ready",
              site: null,
              retryable: true,
            } satisfies AppError;
          }
          const activeVideo = video;

          // 模块加载期间初始来源可能已被取代。使用最新的同协议候选，
          // 而不是短暂打开一条过期线路又立即软切换。
          const latestSource = effectivePlaybackSourceRef.current;
          if (latestSource && (playbackProtocol(latestSource) === "hls") === hlsSource) {
            playbackSource = latestSource;
            sourceKey = playUrlKey(latestSource);
          }
          const selectedSource = playbackSource;
          if (!selectedSource) {
            throw new Error("播放源已失效");
          }
          telemetrySessionRef.current = profile.telemetry
            ? createPlaybackTelemetrySession({
                sessionId: proxySessionId,
                siteId: siteId ?? null,
                sourceId: playbackSourceId(selectedSource, 0),
                protocol: playbackProtocol(selectedSource),
                quality: qualityRef.current,
                switchMode: "hard",
              })
            : null;

          // 3) 全新代理（新端口）+ 缓存穿透 query，
          // 使浏览器绝不会复用到上一个监听器的已关闭 keep-alive 连接。
          const localUrl = await invokeCmd<string>("stream_proxy_start", {
            url: selectedSource.url,
            headers: selectedSource.headers,
            sessionId: proxySessionId,
            // Twitch 等 HLS 站点需要代理把子播放列表、密钥和分片改写到同一个本地会话。
            hls: hlsSource,
            twitchAdRecovery: selectedSource.twitch_ad_recovery,
          });
          if (cancelled || genRef.current !== gen) {
            await stopProxy();
            return;
          }
          const playLocal = `${localUrl}${localUrl.includes("?") ? "&" : "?"}t=${Date.now()}_${gen}`;
          activeProxySessionIdRef.current = proxySessionId;

          // 在任一 MSE 播放器附着之前硬复位元素。在上一个 MSE 房间之后的原生 HLS 兜底
          // 也需要这一步。
          video.pause();
          video.removeAttribute("src");
          video.srcObject = null;
          video.load();
          applyWebPlayerAudio(video, volumeRef.current, mutedRef.current);

          const recoverMutedAutoplay = () => {
            if (mutedRef.current) return false;
            mutedRef.current = false;
            setMuted(false);
            return true;
          };

          const modules = await xgModulesPromise;
          if (cancelled || genRef.current !== gen) {
            await stopProxy();
            return;
          }
          const playerRoot = playerRootRef.current;
          if (!playerRoot) {
            throw {
              code: "web_player_no_root",
              message: "播放器容器尚未准备好",
              site: null,
              retryable: true,
            } satisfies AppError;
          }

          const player = createXgPlayer(modules, {
            root: playerRoot,
            video,
            url: playLocal,
            kind: playbackKind,
            isLive: playbackKind !== "native",
            hls: {
              hlsOpts: liveHlsPlaybackOptions(liveSyncHold),
            },
            flv: profile.flvOptions(mobileClient, liveSyncHold),
            mpegts: liveMpegtsPlaybackOptions(liveSyncHold),
          });

          // 在自动播放之前登记所有权：play() 可能挂起直到首个直播分片到达，
          // 而路由清理必须保持即时。
          playerRef.current = player;
          setMediaAvailable(true);
          activeSourceKeyRef.current = sourceKey;
          setActiveSourceKey(sourceKey);
          activePlaybackKindRef.current = playbackKind;
          const isCurrentPlayer = () =>
            !cancelled && genRef.current === gen && playerRef.current === player;
          const hlsCore = playbackKind === "hls" ? getXgHlsCore(player) : null;
          const mpegtsCore =
            playbackKind === "flv" || playbackKind === "mpegts" ? getXgMpegtsCore(player) : null;
          hlsCoreRef.current = hlsCore;
          mpegtsCoreRef.current = mpegtsCore;
          // 全新传输意味着全新媒体时间轴：
          // 下方派生的挂钟锚点绝不能延续到它上面。
          syncTimelineTokenRef.current = proxySessionId;
          syncStreamAnchorRef.current = null;
          syncMediaTimeOriginRef.current = null;

          if (mpegtsCore) {
            mpegtsCore.on("loading_complete", () => {
              if (!isCurrentPlayer() || softSwitchInFlightRef.current?.player === player) {
                return;
              }
              setLoadError(null);
              setRunning(false);
              onMediaFailureRef.current?.({
                epoch: gen,
                generation: gen,
                kind: "eof",
                message: "直播流已结束",
                protocol: playbackKind,
              });
            });
          }

          // HLS 致命事件走下方协议专属恢复。非 HLS 错误继续经过 xgplayer 的标准事件路径。
          if (!hlsCore) {
            const reportPlayerError = (error: unknown) => {
              if (!isCurrentPlayer()) return;
              const message = xgPlayerErrorMessage(error);
              setLoadError(message);
              setRunning(false);
              onMediaFailureRef.current?.({
                epoch: gen,
                generation: gen,
                kind: "error",
                message,
                protocol: playbackKind,
              });
            };
            player.on("error", reportPlayerError);
            if (playbackKind === "flv" || playbackKind === "mpegts") {
              player.on("mpegts_error", reportPlayerError);
            }
          }

          if (hlsCore && siteId !== "twitch") {
            let hlsFatalFailureCount = 0;
            let firstHlsFatalFailureAt: number | null = null;
            player.on("playing", () => {
              if (!isCurrentPlayer()) return;
              hlsFatalFailureCount = 0;
              firstHlsFatalFailureAt = null;
            });
            const reportHlsFailure = (cause: unknown, recoveryExhausted = false) => {
              if (!isCurrentPlayer()) return;
              const message = xgPlayerErrorMessage(cause, "HLS 连接中断");
              setRunning(false);
              if (recoveryExhausted) {
                playerRef.current = null;
                try {
                  player.destroy();
                } catch {
                  /* 致命 HLS 错误可能已经释放了内部状态。 */
                }
                setLoadError(null);
              } else {
                setLoadError(message);
              }
              onMediaFailureRef.current?.({
                epoch: gen,
                generation: gen,
                kind: "error",
                message,
                protocol: "hls",
                recoveryExhausted,
              });
            };
            player.on("HLS_ERROR", (cause) => {
              if (!isCurrentPlayer() || !cause || typeof cause !== "object") return;
              const event = cause as {
                errorType?: unknown;
                errorFatal?: unknown;
              };
              if (event.errorFatal !== true) return;
              const type = String(event.errorType ?? "").toLowerCase();
              if (type !== "networkerror" && type !== "mediaerror") return;
              // HlsJsPlugin 会为第一个致命事件立即调用 startLoad/recoverMediaError。
              // 只有那次恢复也失败时才升级，
              // 然后获取新的站点元数据并重建播放器。
              hlsFatalFailureCount += 1;
              const now = Date.now();
              firstHlsFatalFailureAt ??= now;
              if (
                !shouldEscalateNonTwitchHlsFatal({
                  siteId,
                  failureCount: hlsFatalFailureCount,
                  firstFailureAt: firstHlsFatalFailureAt,
                  now,
                })
              ) {
                setRunning(false);
                return;
              }
              window.setTimeout(() => reportHlsFailure(event, true), 0);
            });
            player.on("error", (cause) => reportHlsFailure(cause));
          }

          if (hlsCore && siteId === "twitch") {
            const twitchHlsCore = hlsCore;
            let hlsFatalFailureCount = 0;
            let decoderFailureReported = false;
            if (import.meta.env.DEV) {
              player.on("media_info", (info) => {
                if (!isCurrentPlayer()) return;
                console.debug("[rLive][Twitch hls.js] media info", info);
              });
            }
            function failDecoder() {
              if (decoderFailureReported || !isCurrentPlayer()) return;
              decoderFailureReported = true;
              activeVideo.removeEventListener("error", onNativeMediaError);
              // 重放或续期同一渲染档无法改变浏览器的编解码决定。让控制器切换到更低的
              // Twitch 视频变体，而不是烧掉 URL 重试预算。
              playerRef.current = null;
              try {
                player.destroy();
              } catch {
                /* 致命解码错误可能已经释放了内部状态。 */
              }
              setLoadError(null);
              setRunning(false);
              onMediaFailureRef.current?.({
                epoch: gen,
                generation: gen,
                kind: "error",
                message: "当前 Twitch 清晰度无法解码",
                protocol: "hls",
                decodeError: true,
              });
            }
            function onNativeMediaError() {
              if (activeVideo.error?.code === 3) failDecoder();
            }
            activeVideo.addEventListener("error", onNativeMediaError);
            player.on("playing", () => {
              if (isCurrentPlayer()) hlsFatalFailureCount = 0;
            });
            function handleFatalHlsFailure(cause: unknown, recoveryAlreadyStarted = false) {
              if (!isCurrentPlayer()) return;

              const hlsJsDetails =
                cause && typeof cause === "object" && "errorDetails" in cause
                  ? String((cause as { errorDetails?: unknown }).errorDetails ?? "")
                  : "";
              const errorMessage = hlsJsDetails
                ? `Twitch HLS ${hlsJsDetails}`
                : xgPlayerErrorMessage(cause, "Twitch HLS 连接中断");
              if (isXgPlayerDecodeError(cause)) {
                failDecoder();
                return;
              }

              const commercialBreak = isTwitchCommercialBreak(cause);
              const responseStatus = hlsResponseStatus(cause);
              const action = nextHlsFatalRecoveryAction(
                ++hlsFatalFailureCount,
                commercialBreak,
                responseStatus === 401 || responseStatus === 403,
              );
              if (action.type === "restart") {
                setRunning(false);
                if (!recoveryAlreadyStarted) {
                  try {
                    twitchHlsCore.startLoad();
                  } catch {
                    // 后续的 hls.js 致命事件推进到 URL 续期。
                  }
                }
                return;
              }

              const message = commercialBreak
                ? "Twitch 正在播放广告"
                : `${errorMessage}，HLS 内部恢复已耗尽`;
              activeVideo.removeEventListener("error", onNativeMediaError);
              playerRef.current = null;
              try {
                player.destroy();
              } catch {
                /* 致命 HLS 错误可能已经释放了内部状态。 */
              }
              setLoadError(null);
              setRunning(false);
              onMediaFailureRef.current?.({
                epoch: gen,
                generation: gen,
                kind: "error",
                message,
                protocol: "hls",
                httpStatus: responseStatus,
                recoveryExhausted: true,
                commercialBreak,
              });
            }
            player.on("HLS_ERROR", (cause) => {
              if (!isCurrentPlayer() || !cause || typeof cause !== "object") return;
              const event = cause as {
                errorType?: unknown;
                errorDetails?: unknown;
                errorFatal?: unknown;
              };
              if (import.meta.env.DEV) {
                console.debug("[rLive][Twitch hls.js] error", event);
              }
              if (event.errorFatal !== true) return;
              const type = String(event.errorType ?? "").toLowerCase();
              if (type !== "networkerror" && type !== "mediaerror") return;
              // 插件在发出 HLS_ERROR 后立即启动其内建恢复。推迟我们的重试记账，
              // 使销毁失败的播放器不会使那个同步回调失效。
              window.setTimeout(() => handleFatalHlsFailure(event, true), 0);
            });
            player.on("error", (cause) => {
              handleFatalHlsFailure(cause);
            });
          }

          // 不要在 `proxyLifecycleQueue` 中 await 这个 promise：它可能一直挂起直到第一个
          // 直播媒体分片到达。队列必须保持空闲，路由清理才能停止本代理，
          // 重进的房间才能立刻启动替代会话。
          requestPlayerAutoplay(player, video, isCurrentPlayer, recoverMutedAutoplay);

          // 已有帧则标记运行中；否则等待 play 事件。
          if (hasStartedPlayback(video)) {
            setRunning(true);
            setLoadError(null);
            onPlayingRef.current?.();
          } else {
            // 给协议插件一点时间；元素至少解码出一帧之前不清零重试预算。
            window.setTimeout(() => {
              if (cancelled || genRef.current !== gen) return;
              if (playerRef.current === player && hasStartedPlayback(video)) {
                setRunning(true);
                setLoadError(null);
                onPlayingRef.current?.();
              }
            }, 400);
          }
        } catch (e) {
          if (cancelled || genRef.current !== gen) return;
          const msg =
            typeof e === "object" && e && "message" in e
              ? String((e as AppError).message)
              : String(e);
          setLoadError(msg || "播放失败");
          setRunning(false);
          destroyPlayer();
          await stopProxy();
          onMediaFailureRef.current?.({
            epoch: gen,
            generation: gen,
            kind: "error",
            message: msg,
            protocol: playbackKind,
          });
        }
      })
      .catch(() => {
        // 初始化主体会向控制器上报可恢复失败。这里的 catch 只是防止意外的队列失败
        // 变成未处理的 promise 拒绝。
      });

    return () => {
      cancelled = true;
      destroyPlayer();
      void proxyLifecycleQueue.enqueue(stopProxy);
    };
  }, [hardStreamKey, reloadToken, destroyPlayer, liveSyncHold, mobileClient, profile, siteId]);

  // 同协议的来源变化可以保留媒体元素与 MSE 状态。各直播 CDN 的时间戳连续性并不
  // 统一，任何初始化/切换失败都会自增硬 key 并干净重建。
  useEffect(() => {
    if (!effectivePlaybackSource || !effectivePlaybackKind) return;
    if (
      !canSoftSwitchPlaybackSource({
        enabled: softSwitchEnabled,
        activeSourceKey,
        targetSourceKey: effectivePlaybackSourceKey,
        activeKind: activePlaybackKindRef.current,
        targetKind: effectivePlaybackKind,
      })
    ) {
      return;
    }

    const player = playerRef.current;
    const proxySessionId = activeProxySessionIdRef.current;
    if (!player || !proxySessionId || typeof player.switchURL !== "function") {
      setSoftFallbackToken((token) => token + 1);
      return;
    }

    let cancelled = false;
    const sequence = ++softSwitchSequenceRef.current;
    const targetSource = effectivePlaybackSource;
    const targetKey = effectivePlaybackSourceKey;
    const targetKind = effectivePlaybackKind;

    void proxyLifecycleQueue
      .enqueue(async () => {
        if (
          cancelled ||
          sequence !== softSwitchSequenceRef.current ||
          playerRef.current !== player ||
          activeProxySessionIdRef.current !== proxySessionId
        ) {
          return;
        }

        const inFlight = { player, sequence };
        softSwitchInFlightRef.current = inFlight;
        try {
          const localUrl = await invokeCmd<string>("stream_proxy_start", {
            url: targetSource.url,
            headers: targetSource.headers,
            sessionId: proxySessionId,
            hls: targetKind === "hls",
            twitchAdRecovery: targetSource.twitch_ad_recovery,
          });
          if (
            cancelled ||
            sequence !== softSwitchSequenceRef.current ||
            playerRef.current !== player
          ) {
            return;
          }
          const localSource = `${localUrl}${localUrl.includes("?") ? "&" : "?"}switch=${Date.now()}_${sequence}`;
          telemetrySessionRef.current = profile.telemetry
            ? createPlaybackTelemetrySession({
                sessionId: `${proxySessionId}:soft:${sequence}`,
                siteId: siteId ?? null,
                sourceId: playbackSourceId(targetSource, 0),
                protocol: playbackProtocol(targetSource),
                quality: qualityRef.current,
                switchMode: "soft",
              })
            : null;
          await switchXgPlaybackSource(player, localSource, targetKind);
          if (
            cancelled ||
            sequence !== softSwitchSequenceRef.current ||
            playerRef.current !== player
          ) {
            return;
          }
          activeSourceKeyRef.current = targetKey;
          setActiveSourceKey(targetKey);
          activePlaybackKindRef.current = targetKind;
          // 插件重建了它的传输层，
          // 时钟锚点必须从替代流重新推导。
          syncTimelineTokenRef.current = `${proxySessionId}:soft:${sequence}`;
          syncStreamAnchorRef.current = null;
          syncMediaTimeOriginRef.current = null;
          setLoadError(null);
        } finally {
          if (softSwitchInFlightRef.current === inFlight) {
            softSwitchInFlightRef.current = null;
          }
        }
      })
      .catch(() => {
        if (cancelled || sequence !== softSwitchSequenceRef.current) return;
        setLoadError(null);
        setSoftFallbackToken((token) => token + 1);
      });

    return () => {
      cancelled = true;
    };
  }, [
    activeSourceKey,
    effectivePlaybackKind,
    effectivePlaybackSource,
    effectivePlaybackSourceKey,
    profile,
    siteId,
    softSwitchEnabled,
  ]);

  // 把传输控制反映到元素上。
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    applyWebPlayerAudio(video, volume, muted);
  }, [volume, muted, mediaKey]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      // 短暂的 null（mediaKey 交换中途）不代表设备能力丢失。只有随元素走的 active
      // 标志被重置。
      setPictureInPictureActive(false);
      return;
    }
    const generation = genRef.current;
    const playbackKind = effectivePlaybackKind;

    const pictureInPictureDocument = getPictureInPictureDocument();
    const isCurrentMedia = () =>
      videoRef.current === video &&
      genRef.current === generation &&
      playerRef.current?.media === video;
    const syncPictureInPicture = () => {
      // 来自刚被替换的 <video> 的 leave 事件
      // 绝不能覆盖新 MediaSource 节点的状态。
      if (videoRef.current !== video) return;
      // 支持性是单调的：锁存一次即可，重连循环不会卸载控件。
      // `canUsePictureInPicture` 把关实际切换。
      if (canUsePictureInPicture(pictureInPictureDocument, video)) {
        setPictureInPictureSupported(true);
      }
      setPictureInPictureActive(pictureInPictureDocument?.pictureInPictureElement === video);
    };

    const onPlay = () => {
      if (!isCurrentMedia()) return;
      setPaused(false);
    };
    const onPlaying = () => {
      if (!isCurrentMedia()) return;
      const telemetry = telemetrySessionRef.current;
      if (telemetry) markTelemetryPlaying(telemetry, performance.now());
      setPaused(false);
      setRunning(true);
      setLoadError(null);
      onPlayingRef.current?.();
    };
    const onPause = () => {
      if (!isCurrentMedia()) return;
      setPaused(true);
      onPauseRef.current?.();
    };
    const onWaiting = () => {
      if (!isCurrentMedia()) return;
      const telemetry = telemetrySessionRef.current;
      if (telemetry) markTelemetryWaiting(telemetry, performance.now());
      onWaitingRef.current?.();
    };
    const onStalled = () => {
      if (!isCurrentMedia()) return;
      const telemetry = telemetrySessionRef.current;
      if (telemetry) markTelemetryStalled(telemetry, performance.now());
    };
    // Android 全屏自动旋转依据解码后的帧尺寸决定，
    // 因此比例既要跟随首个元数据，也要跟随自适应阶梯在流中进行的后续分辨率切换。
    const syncAspectRatio = () => {
      if (videoRef.current !== video) return;
      setAspectRatio(videoAspectRatio(video));
    };
    const onCanPlay = () => {
      if (!isCurrentMedia()) return;
      setPaused(video.paused);
      onReadyRef.current?.();
    };
    const onEnterPictureInPicture = () => syncPictureInPicture();
    const onLeavePictureInPicture = () => syncPictureInPicture();
    const onEnded = () => {
      if (!isCurrentMedia()) return;
      onMediaFailureRef.current?.({
        epoch: generation,
        generation,
        kind: "eof",
        message: "直播流已结束",
        protocol: playbackKind ?? undefined,
      });
    };
    syncPictureInPicture();
    syncAspectRatio();
    video.addEventListener("play", onPlay);
    video.addEventListener("playing", onPlaying);
    video.addEventListener("pause", onPause);
    video.addEventListener("waiting", onWaiting);
    video.addEventListener("canplay", onCanPlay);
    video.addEventListener("stalled", onStalled);
    video.addEventListener("ended", onEnded);
    video.addEventListener("loadedmetadata", syncAspectRatio);
    video.addEventListener("resize", syncAspectRatio);
    video.addEventListener("enterpictureinpicture", onEnterPictureInPicture);
    video.addEventListener("leavepictureinpicture", onLeavePictureInPicture);
    return () => {
      video.removeEventListener("play", onPlay);
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("canplay", onCanPlay);
      video.removeEventListener("stalled", onStalled);
      video.removeEventListener("ended", onEnded);
      video.removeEventListener("loadedmetadata", syncAspectRatio);
      video.removeEventListener("resize", syncAspectRatio);
      video.removeEventListener("enterpictureinpicture", onEnterPictureInPicture);
      video.removeEventListener("leavepictureinpicture", onLeavePictureInPicture);
    };
  }, [effectivePlaybackKind, mediaKey, streamKey]);

  useEffect(() => {
    if (!profile.telemetry) return;
    if (typeof PerformanceObserver === "undefined") return;
    if (!PerformanceObserver.supportedEntryTypes?.includes("longtask")) return;
    let observer: PerformanceObserver | null = null;
    try {
      observer = new PerformanceObserver((list) => {
        const telemetry = telemetrySessionRef.current;
        if (!telemetry) return;
        for (const entry of list.getEntries()) {
          markTelemetryLongTask(telemetry, entry.duration);
        }
      });
      observer.observe({ entryTypes: ["longtask"] });
    } catch {
      observer?.disconnect();
      return;
    }
    return () => observer?.disconnect();
  }, [profile.telemetry]);

  useEffect(() => {
    if (!profile.telemetry) return;
    let cancelled = false;
    let sampling = false;
    const sample = async () => {
      if (cancelled || sampling) return;
      const telemetry = telemetrySessionRef.current;
      const video = videoRef.current;
      const proxySessionId = activeProxySessionIdRef.current;
      if (!telemetry || !video || !proxySessionId) return;
      sampling = true;
      let proxy: StreamProxyTelemetry | null = null;
      try {
        proxy = await invokeCmd<StreamProxyTelemetry | null>("stream_proxy_telemetry", {
          sessionId: proxySessionId,
        });
      } catch {
        // 浏览器预览和正在关闭的原生会话在没有代理计数器的情况下
        // 也能产出有用的媒体元素指标。
      } finally {
        sampling = false;
      }
      if (cancelled || telemetrySessionRef.current !== telemetry || videoRef.current !== video) {
        return;
      }
      samplePlaybackTelemetry({ session: telemetry, video, proxy });
    };
    const interval = window.setInterval(() => void sample(), 2_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [hardStreamKey, mediaKey, profile.telemetry]);

  const releaseFullscreenInsets = useCallback(() => {
    if (fullscreenInsetFreezeTimerRef.current !== null) {
      window.clearTimeout(fullscreenInsetFreezeTimerRef.current);
      fullscreenInsetFreezeTimerRef.current = null;
    }
    fullscreenInsetFreezeRef.current?.();
    fullscreenInsetFreezeRef.current = null;
  }, []);

  /**
   * 为没有节目时钟的容器推导挂钟锚点。
   *
   * FLV 和 MPEG-TS 时间戳从接近零开始，唯一可用的绝对参照就是代理收到本会话
   * 首个媒体字节的纪元。把它与该字节产生的媒体位置配对，
   * 即可把 `currentTime` 变成估计的采集时刻。CDN 边缘突发是该估计的一部分，
   * 这正是它只在多条流之间可比的原因。
   */
  useEffect(() => {
    if (!liveSyncHold) {
      syncStreamAnchorRef.current = null;
      syncMediaTimeOriginRef.current = null;
      return;
    }
    let cancelled = false;
    let sampling = false;

    const captureMediaTimeOrigin = () => {
      const token = syncTimelineTokenRef.current;
      const video = videoRef.current;
      if (!token || !video || video.readyState < 2 || video.buffered.length === 0) return null;
      const existing = syncMediaTimeOriginRef.current;
      if (existing?.token === token) return existing.mediaTime;
      const bufferStart = video.buffered.start(0);
      const bufferEnd = video.buffered.end(video.buffered.length - 1);
      if (bufferEnd - bufferStart > LIVE_SYNC_ANCHOR_FRESH_BUFFER_SECONDS) return null;
      // 第一条保留样本是会话首字节媒体位置最接近的替身。
      const mediaTime = Math.min(bufferStart, video.currentTime);
      if (!Number.isFinite(mediaTime)) return null;
      syncMediaTimeOriginRef.current = { token, mediaTime };
      return mediaTime;
    };

    const deriveAnchor = async () => {
      if (cancelled || sampling) return;
      const token = syncTimelineTokenRef.current;
      const proxySessionId = activeProxySessionIdRef.current;
      if (!token || !proxySessionId) return;
      if (syncStreamAnchorRef.current?.token === token) return;
      const mediaTimeOrigin = captureMediaTimeOrigin();
      if (mediaTimeOrigin == null) return;
      sampling = true;
      let proxy: StreamProxyTelemetry | null = null;
      try {
        proxy = await invokeCmd<StreamProxyTelemetry | null>("stream_proxy_telemetry", {
          sessionId: proxySessionId,
        });
      } catch {
        // 浏览器预览没有原生代理；那些流保持在手动滞留模式，
        // 而不使用估计时钟。
      } finally {
        sampling = false;
      }
      const firstMediaAtMs = proxy?.first_media_at_ms ?? null;
      if (cancelled || !firstMediaAtMs || syncTimelineTokenRef.current !== token) return;
      syncStreamAnchorRef.current = {
        token,
        epochAtMediaZeroMs: firstMediaAtMs - mediaTimeOrigin * 1_000,
      };
    };

    void deriveAnchor();
    const interval = window.setInterval(() => void deriveAnchor(), 1_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [hardStreamKey, liveSyncHold, mediaKey]);

  const readSyncTimeline = useCallback((): LivePlayerTimeline => {
    const video = videoRef.current;
    const idle: LivePlayerTimeline = {
      ready: false,
      mediaTime: 0,
      bufferStart: 0,
      bufferEnd: 0,
      clockKind: "none",
      epochAtMediaZeroMs: null,
    };
    if (!video || video.buffered.length === 0) return idle;

    const mediaTime = video.currentTime;
    const bufferStart = video.buffered.start(0);
    const bufferEnd = video.buffered.end(video.buffered.length - 1);
    if (![mediaTime, bufferStart, bufferEnd].every(Number.isFinite)) return idle;

    const programDateMs = hlsCoreRef.current?.programDateMs() ?? null;
    const anchor =
      syncStreamAnchorRef.current?.token === syncTimelineTokenRef.current
        ? syncStreamAnchorRef.current
        : null;
    const clock: Pick<LivePlayerTimeline, "clockKind" | "epochAtMediaZeroMs"> =
      programDateMs != null
        ? {
            clockKind: "program-date",
            epochAtMediaZeroMs: programDateMs - mediaTime * 1_000,
          }
        : anchor
          ? { clockKind: "stream-anchor", epochAtMediaZeroMs: anchor.epochAtMediaZeroMs }
          : { clockKind: "none", epochAtMediaZeroMs: null };

    return {
      ready: video.readyState >= 2 && !video.paused,
      mediaTime,
      bufferStart,
      bufferEnd,
      ...clock,
    };
  }, []);

  const seekSyncMediaTime = useCallback((seconds: number) => {
    const video = videoRef.current;
    if (!video || !Number.isFinite(seconds)) return;
    const target = Math.max(0, seconds);
    // mpegts.js 拥有自己的 seek 路径：直接写元素会让它的 seeking 处理器把这次跳转
    // 当作无缓冲 seek 并冲刷 MSE。
    if (mpegtsCoreRef.current?.seek?.(target)) return;
    try {
      video.currentTime = target;
    } catch {
      /* 销毁中途的元素会拒绝赋值；下一个 tick 重试。 */
    }
  }, []);

  const setSyncPlaybackRate = useCallback((rate: number) => {
    const video = videoRef.current;
    if (!video || !Number.isFinite(rate)) return;
    const next = Math.min(LIVE_SYNC_MAX_PLAYBACK_RATE, Math.max(LIVE_SYNC_MIN_PLAYBACK_RATE, rate));
    if (Math.abs(video.playbackRate - next) < 0.001) return;
    video.playbackRate = next;
  }, []);

  const sync = useMemo<LivePlayerSyncApi>(
    () => ({
      readTimeline: readSyncTimeline,
      seekMediaTime: seekSyncMediaTime,
      setPlaybackRate: setSyncPlaybackRate,
    }),
    [readSyncTimeline, seekSyncMediaTime, setSyncPlaybackRate],
  );

  // 离开对齐（或页面）时不能留下被调过的速率。
  useEffect(() => {
    if (liveSyncHold) return;
    const video = videoRef.current;
    if (video && video.playbackRate !== 1) video.playbackRate = 1;
  }, [liveSyncHold, mediaKey]);

  const freezeFullscreenInsets = useCallback(() => {
    if (typeof document === "undefined") return;
    if (!shouldFreezeFullscreenInsets(getClientPlatform())) return;
    // 用户快速连续切换两次时上一次冻结可能仍然打开。先释放它，
    // 保证始终至多一个未决冻结。
    releaseFullscreenInsets();
    const shell = document.querySelector<HTMLElement>(".app-shell");
    const root = document.documentElement;
    if (!shell || !root) return;
    // 钉住外壳已有的内边距而不是猜测值，使冻结成为真正的保持：
    // 安装的那一刻布局不得移动。
    const frozen = frozenSafeAreaTopValue(window.getComputedStyle(shell).paddingTop);
    if (!frozen) return;
    fullscreenInsetFreezeRef.current = beginFullscreenTransition(root, frozen);
    // 兜底 WebView 不触发 fullscreenchange 就 resolve 请求的情况，
    // 使冻结绝不能比这次交互活得更久。
    fullscreenInsetFreezeTimerRef.current = window.setTimeout(
      releaseFullscreenInsets,
      FULLSCREEN_TRANSITION_TIMEOUT_MS,
    );
  }, [releaseFullscreenInsets]);

  // 没有任何东西可以比播放器活得更久：过渡中途的路由变更否则会把外壳
  // 钉在过期的内边距上。
  useEffect(() => releaseFullscreenInsets, [releaseFullscreenInsets]);

  useEffect(() => {
    if (!ownsFullscreen) {
      setMode("windowed");
      // 全屏中途失去所有权（次要播放器接管）会撤掉页面内固定层，
      // 它隐藏的系统栏必须随之恢复。
      if (inPageFullscreenRef.current) {
        inPageFullscreenRef.current = false;
        void setAndroidImmersive(false).catch(() => {});
      }
      return;
    }
    // Android Tauri 与桌面 Tauri 都自行持有 `mode`。在那里从全屏元素同步
    // 会立刻强制 `windowed`，因为两条路径都不会产生全屏元素。
    if (isTauriDesktop() || runningOnAndroidTauri()) return;
    const syncMode = () => {
      const el = stageRef.current;
      const fs = fullscreenElementFor(getFullscreenDocument());
      setMode(fs && el && (fs === el || el.contains(fs)) ? "fullscreen" : "windowed");
    };
    const onFs = () => {
      syncMode();
      // 舞台此刻拥有整个屏幕，后续任何 inset 变化只回流它已覆盖的内容。
      // 在这里结束冻结使其与过渡一样短，
      // 而不必依赖超时兜底。
      releaseFullscreenInsets();
    };
    syncMode();
    document.addEventListener("fullscreenchange", onFs);
    document.addEventListener("webkitfullscreenchange", onFs);
    return () => {
      document.removeEventListener("fullscreenchange", onFs);
      document.removeEventListener("webkitfullscreenchange", onFs);
    };
  }, [ownsFullscreen, releaseFullscreenInsets]);

  // 桌面 Tauri 经原生窗口驱动全屏，没有可退出的 HTML 全屏元素。保持 OS 窗口全屏，
  // 让随之而来的 resize 把 `mode` 移回窗口化。
  useEffect(() => {
    // 次要播放器共享这个窗口，其全屏状态说明不了它们各自的情况。
    // 在这里读取它会把所有次要播放器同时标记为全屏。
    if (!ownsFullscreen || !isTauriDesktop()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        const appWindow = getCurrentWindow();
        const sync = async () => {
          try {
            const fullscreen = await appWindow.isFullscreen();
            if (!fullscreen) {
              await restoreNativePlayerMaximizedState(
                appWindow,
                nativeFullscreenSessionRef.current,
              );
            }
            if (!disposed) setMode(fullscreen ? "fullscreen" : "windowed");
          } catch {
            /* 路由变更期间窗口可能正在拆除。 */
          }
        };
        await sync();
        unlisten = await appWindow.onResized(() => void sync());
      } catch {
        // 没有原生窗口的浏览器预览继续使用上方的 HTML 路径。
      }
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [ownsFullscreen]);

  const togglePause = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      void video.play().catch(() => {});
    } else {
      video.pause();
    }
  }, []);

  const previewVolume = useCallback((v: number) => {
    const vol = clampWebPlayerVolume(v);
    const nextMuted = vol === 0;
    volumeRef.current = vol;
    mutedRef.current = nextMuted;
    const video = videoRef.current;
    if (video) applyWebPlayerAudio(video, vol, nextMuted);
  }, []);

  const changeVolume = useCallback((v: number) => {
    const vol = clampWebPlayerVolume(v);
    const nextMuted = vol === 0;
    volumeRef.current = vol;
    mutedRef.current = nextMuted;
    const video = videoRef.current;
    if (video) applyWebPlayerAudio(video, vol, nextMuted);
    setVolume(vol);
    setMuted(nextMuted);
    // 协议插件已就绪但播放仍未开始时，轻推一次播放。
    if (video && video.paused && playerRef.current) {
      void video.play().catch(() => {});
    }
  }, []);

  const setAudio = useCallback((nextVolume: number, nextMuted: boolean) => {
    const normalizedVolume = clampWebPlayerVolume(nextVolume);
    const normalizedMuted = nextMuted || normalizedVolume === 0;
    volumeRef.current = normalizedVolume;
    mutedRef.current = normalizedMuted;
    const video = videoRef.current;
    if (video) applyWebPlayerAudio(video, normalizedVolume, normalizedMuted);
    setVolume(normalizedVolume);
    setMuted(normalizedMuted);
  }, []);

  const toggleMute = useCallback(() => {
    if (muted || volume === 0) {
      const restore = prevVolume || 80;
      volumeRef.current = restore;
      mutedRef.current = false;
      if (videoRef.current) applyWebPlayerAudio(videoRef.current, restore, false);
      setMuted(false);
      setVolume(restore);
    } else {
      mutedRef.current = true;
      if (videoRef.current) applyWebPlayerAudio(videoRef.current, volume, true);
      setPrevVolume(volume);
      setMuted(true);
    }
  }, [muted, volume, prevVolume]);

  const togglePictureInPicture = useCallback(async () => {
    const video = videoRef.current;
    const pictureInPictureDocument = getPictureInPictureDocument();
    if (!video || !canUsePictureInPicture(pictureInPictureDocument, video)) return;

    const lifecycleVersion = mediaLifecycleVersionRef.current;
    const changed = await toggleVideoPictureInPicture(pictureInPictureDocument, video);

    // 请求可能在画质/线路/房间切换替换了 video 节点之后才 resolve。
    // 不要把那个已分离的源留在原生画中画窗口里。
    if (
      changed &&
      (lifecycleVersion !== mediaLifecycleVersionRef.current || videoRef.current !== video)
    ) {
      await exitPictureInPictureForVideo(pictureInPictureDocument, video);
    }
  }, []);

  const exitPictureInPicture = useCallback(async () => {
    await exitPictureInPictureForVideo(getPictureInPictureDocument(), videoRef.current);
  }, []);

  /**
   * 进入或离开 Android Tauri 使用的页面内全屏固定层。
   *
   * 这里 `mode` 就是整个布局切换 —— 不涉及浏览器全屏元素 —— 因此先设置它，
   * 原生系统栏随之跟进。原生命令失败或缺失时仍然能得到可用的全屏
   * （只是状态栏可见），这正是 invoke 绝不阻塞模式变更的原因。
   *
   * 系统栏动画仍会让 `env(safe-area-inset-top)` 经过数帧变化，
   * 而固定层背后的 `.app-shell` 把它消费为 `padding-top`。那时舞台已经是
   * `position: fixed`，画面本身动不了，但其下的房间 chrome 仍会回流 ——
   * 在固定层稳定之前会在边缘周围显露。跨过渡冻结外壳内边距使其保持不动；
   * 由于这条路径不会迎来 `fullscreenchange`，由超时负责释放。
   */
  const setInPageFullscreen = useCallback(
    (next: boolean) => {
      if (next) freezeFullscreenInsets();
      else releaseFullscreenInsets();
      setMode(next ? "fullscreen" : "windowed");
      inPageFullscreenRef.current = next;
      void setAndroidImmersive(next).catch(() => {
        // 缺少该命令的旧 APK 不得破坏全屏。
      });
    },
    [freezeFullscreenInsets, releaseFullscreenInsets],
  );

  const toggleFullscreen = useCallback(async () => {
    if (!ownsFullscreen) return;
    // 桌面 Tauri 使用真正的 OS 窗口全屏。它会盖住任务栏
    // （不同于 WebView2 在最大化窗口下的 HTML 全屏），并经随后的 resize 驱动
    // `mode`；舞台随即作为页面内固定层覆盖房间 chrome
    // （见 data-fullscreen 的 CSS 规则）。
    if (isTauriDesktop()) {
      try {
        const appWindow = getCurrentWindow();
        const next = await toggleNativePlayerFullscreen(
          appWindow,
          nativeFullscreenSessionRef.current,
        );
        setMode(next ? "fullscreen" : "windowed");
        setFullscreenError(null);
      } catch (e) {
        const msg =
          typeof e === "object" && e && "message" in e
            ? String((e as { message: string }).message)
            : String(e);
        setFullscreenError(msg || "全屏切换失败");
      }
      return;
    }

    // Android Tauri 复用同一个页面内固定层。在那里请求浏览器全屏会让 Chromium
    // 把渲染内容重新挂载到新 View，
    // 那次表面交接正是黑屏闪烁（见 androidImmersive）。
    if (runningOnAndroidTauri()) {
      setInPageFullscreen(mode !== "fullscreen");
      setFullscreenError(null);
      return;
    }

    const stage = stageRef.current;
    if (!stage) return;
    // 进入全屏会在 `:fullscreen` 生效之前移动系统栏 inset，
    // 使仍在窗口化的房间回流数帧（见 fullscreenTransition）。
    // 在请求期间冻结外壳内边距；舞台接管屏幕后
    // 由 fullscreenchange 处理器释放。
    const entering = !fullscreenElementFor(getFullscreenDocument());
    if (entering) freezeFullscreenInsets();
    try {
      const toggled = await toggleElementFullscreen(getFullscreenDocument(), stage);
      if (!toggled) {
        releaseFullscreenInsets();
        setFullscreenError("当前设备不支持全屏播放");
        return;
      }
      setFullscreenError(null);
    } catch (e) {
      releaseFullscreenInsets();
      const msg =
        typeof e === "object" && e && "message" in e
          ? String((e as { message: string }).message)
          : String(e);
      setFullscreenError(msg || "全屏切换失败");
    }
  }, [freezeFullscreenInsets, mode, ownsFullscreen, releaseFullscreenInsets, setInPageFullscreen]);

  const exitFullscreen = useCallback(async () => {
    // 桌面 Tauri 经原生窗口驱动全屏，没有可退出的 HTML 全屏元素。保持 OS 窗口全屏，
    // 让随之而来的 resize 把 `mode` 移回窗口化。
    if (isTauriDesktop()) {
      try {
        const appWindow = getCurrentWindow();
        if (await appWindow.isFullscreen()) {
          await setNativePlayerFullscreen(appWindow, false, nativeFullscreenSessionRef.current);
          setMode("windowed");
        }
      } catch {
        /* 缺少原生窗口操作时绝不能困住用户。 */
      }
      return;
    }
    // Android 的页面内固定层是页面状态，离开它是模式变更加上恢复系统栏。由 ref 驱动
    // 而不是 `mode`，使这个回调为其众多消费者保持稳定身份。
    if (runningOnAndroidTauri()) {
      if (inPageFullscreenRef.current) setInPageFullscreen(false);
      return;
    }
    if (!fullscreenElementFor(getFullscreenDocument())) return;
    const documentRef = getFullscreenDocument();
    const exit =
      documentRef?.exitFullscreen ??
      documentRef?.webkitExitFullscreen ??
      documentRef?.webkitCancelFullScreen;
    if (exit && documentRef) {
      await Promise.resolve(exit.call(documentRef)).catch(() => {});
    }
  }, [setInPageFullscreen]);

  /**
   * 沉浸式系统栏属于全屏播放器而不属于 Activity。
   *
   * 直接从全屏离开房间（在房间里按 Back、路由变更、切换房间）会在没有任何退出
   * 调用的情况下卸载本 hook，因此在这里恢复系统栏，
   * 否则下一页会被布局在隐藏的系统栏之下。
   */
  useEffect(
    () => () => {
      if (!inPageFullscreenRef.current) return;
      inPageFullscreenRef.current = false;
      void setAndroidImmersive(false).catch(() => {});
    },
    [],
  );

  useEffect(() => {
    if (mode !== "fullscreen") return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      void exitFullscreen();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [exitFullscreen, mode]);

  return {
    mode,
    paused,
    volume,
    muted,
    mediaAvailable,
    running,
    pictureInPictureSupported,
    pictureInPictureActive,
    loadError,
    fullscreenError,
    setLoadError,
    mediaKey,
    aspectRatio,
    videoRef,
    playerRootRef,
    stageRef,
    togglePause,
    previewVolume,
    changeVolume,
    setAudio,
    toggleMute,
    togglePictureInPicture,
    exitPictureInPicture,
    toggleFullscreen,
    exitFullscreen,
    sync,
  };
}

export function useWebPlayer(opts: WebPlayerOptions): WebPlayerApi {
  return useMediaLifecycle({ ...opts, profile: LIVE_MEDIA_LIFECYCLE_PROFILE });
}
