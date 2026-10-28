import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invokeCmd } from "@/shared/api/tauri";
import { getClientPlatform } from "@/shared/clientPlatform";
import type { PlayUrl, SiteId } from "@/shared/types/live";
import type { PlayerEvent, PlayerUiMode, StreamProxyTelemetry } from "@/shared/types/player";
import type { AppError } from "@/shared/types/error";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import {
  createNativeFullscreenSession,
  restoreNativePlayerMaximizedState,
  setNativePlayerFullscreen,
  toggleNativePlayerFullscreen,
} from "@/shared/nativePlayerFullscreen";
import { usePlayerStartupGate } from "@/shared/hooks/usePlayerStartupGate";
import { useFullscreenInsetFreeze } from "@/shared/hooks/useFullscreenInsetFreeze";
import { runningOnAndroidTauri, setAndroidImmersive } from "./androidImmersive";
import { videoAspectRatio, retainMeasuredAspectRatio } from "./androidOrientation";
import { requestPlayerAutoplay } from "./autoplay";
import { watchDesktopFullscreen } from "./desktopFullscreenWatcher";
import {
  classifyHlsPlayerError,
  createHlsRecoveryBudget,
  hlsResponseStatus,
  isTwitchCommercialBreak,
} from "./hlsRecoveryBudget";
import { watchHlsMediaProgress } from "./hlsMediaWatch";
import { createSerialTaskQueue } from "./serialTaskQueue";
import { softSwitchOwnsTransport } from "./softSwitchTransaction";
import { streamProxyStartArgs } from "./streamProxyStart";
import {
  playbackSourceFromKey,
  playUrlKey,
  shouldSoftSwitchToSource,
} from "../playback/sourceIdentity";
import {
  canSwitchVideoJsSource,
  classifyTransportFailure,
  createVideoJsPlayer,
  getVideoJsHlsCore,
  getVideoJsMpegtsCore,
  isVideoJsDecodeError,
  loadVideoJsModules,
  switchVideoJsPlaybackSource,
  webPlaybackKind,
  videoJsPlayerErrorMessage,
  type VideoJsHlsCore,
  type VideoJsMpegtsCore,
  type VideoJsPlaybackKind,
  type VideoJsPlayerInstance,
  type VideoJsHlsOptions,
  type VideoJsMpegtsOptions,
} from "./videoJsPlayer";

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

/**
 * Video.js 适配器从 HTMLMediaElement 的原生 API 启动协议内核；HLS 的 hls.js
 * 实例仅作为 Video.js 的受控高级能力读取。
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

/** 全屏直接使用浏览器 DOM API，保留 WebKit 兼容入口。 */
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
  /** 当前来源已可播；暂停/缓冲不清除，换源或重建立即复位。 */
  ready: boolean;
  loadError: string | null;
  /** 非致命的全屏失败，绝不能替换媒体视图。 */
  fullscreenError: string | null;
  setLoadError: (msg: string | null) => void;
  /** 自增强制全新的 <video> 节点（清除卡死的 MediaSource）。 */
  mediaKey: number;
  /** 解码帧宽高比；首个元数据到达前为 null。 */
  aspectRatio: number | null;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  /** React 管理的媒体布局容器；适配器只附着 video，不修改 DOM 树。 */
  playerRootRef: React.RefObject<HTMLDivElement | null>;
  stageRef: React.RefObject<HTMLDivElement | null>;
  togglePause: () => void;
  /** 直接应用手势帧，不协调播放器树。 */
  previewVolume: (v: number) => void;
  changeVolume: (v: number) => void;
  setAudio: (volume: number, muted: boolean) => void;
  toggleMute: () => void;
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
  flvOptions(mobileClient: boolean, syncHold: boolean): VideoJsMpegtsOptions;
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

/**
 * 恢复会话存在时，播放器本地不抢先展示终止错误；没有会话所有者的 EOF
 * 仍保持既有静默语义，其他终态错误则回退到本地文案。
 */
export function mediaFailureLocalError(
  event: Pick<PlayerEvent, "kind" | "message">,
  hasRecoveryOwner: boolean,
): string | null {
  if (hasRecoveryOwner || event.kind === "eof") return null;
  return event.message?.trim() || "播放失败";
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
): VideoJsMpegtsOptions {
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
      // mpegts.js 默认按音频时间戳缺口补静音帧，且帧数没有上限：上游时间戳
      // 跳变过大时会一次性构造十几万个帧并撑爆调用栈（`push.apply`），
      // 表现为一次 NetworkError。关闭后不再批量补静音帧，时间戳异常时音画
      // 同步不做保证。
      fixAudioTimestampGap: false,
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
export function liveHlsPlaybackOptions(syncHold = false): VideoJsHlsOptions {
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
export function liveMpegtsPlaybackOptions(syncHold = false): VideoJsMpegtsOptions {
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
      // 同 FLV：不再批量补静音帧，避免时间戳跳变打爆调用栈；异常时间戳下
      // 音画同步不做保证。
      fixAudioTimestampGap: false,
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

export function iptvFlvPlaybackOptions(): VideoJsMpegtsOptions {
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
      // 同直播 FLV：不再批量补静音帧，避免时间戳跳变打爆调用栈；异常时间戳下
      // 音画同步不做保证。
      fixAudioTimestampGap: false,
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
  flvOptions: liveFlvPlaybackOptions,
};

export const IPTV_MEDIA_LIFECYCLE_PROFILE: MediaLifecycleProfile = {
  retainSourceDuringGap: false,
  resetAudioOnSessionChange: false,
  softSwitch: "disabled",
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
  playbackKind: VideoJsPlaybackKind | null,
): boolean {
  return (
    configured && (playbackKind === "flv" || playbackKind === "hls" || playbackKind === "mpegts")
  );
}

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
 * 半销毁的 Video.js 适配器导致的黑屏。
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
   * 「同一来源需要重新打开传输」的信号。变化时优先保留媒体元素与适配器，
   * 只重新打开本机代理与传输；做不到时才完整重建。用于自动续期，
   * 使用户看不到一次整窗重载。
   */
  renewToken?: number | string;
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
    renewToken = 0,
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
  const playerRef = useRef<VideoJsPlayerInstance | null>(null);
  const [playerInstanceId] = useState(createPlayerInstanceId);
  // 每个实例持有稳定队列：自己的启动、切源与清理仍串行，其他画面不必等待
  // 本实例的 DOM、IPC 或 canplay。重渲染和 generation 变化不能重建队列。
  const [proxyLifecycleQueue] = useState(createSerialTaskQueue);
  const genRef = useRef(0);
  const volumeRef = useRef(initialAudio.volume);
  const mutedRef = useRef(initialAudio.muted);
  const activeProxySessionIdRef = useRef<string | null>(null);
  const activeSourceKeyRef = useRef("");
  const activePlaybackKindRef = useRef<VideoJsPlaybackKind | null>(null);
  const hlsCoreRef = useRef<VideoJsHlsCore | null>(null);
  const mpegtsCoreRef = useRef<VideoJsMpegtsCore | null>(null);
  /** 当前媒体时间轴的身份；下方所有锚点都属于它。 */
  const syncTimelineTokenRef = useRef("");
  const syncStreamAnchorRef = useRef<{ token: string; epochAtMediaZeroMs: number } | null>(null);
  const syncMediaTimeOriginRef = useRef<{ token: string; mediaTime: number } | null>(null);
  const softSwitchSequenceRef = useRef(0);
  const softSwitchInFlightRef = useRef<{ player: VideoJsPlayerInstance; sequence: number } | null>(
    null,
  );
  const qualityRef = useRef<string | null>(quality);
  const nativeFullscreenSessionRef = useRef(createNativeFullscreenSession());
  /** 为没有 `mode` 的销毁路径镜像页面内全屏状态。 */
  const inPageFullscreenRef = useRef(false);
  // 用户在起播完成前按过暂停。自动起播的静音重试必须尊重它，
  // 否则卡加载时点暂停会被重试重新拉起，按钮状态与实际播放相反。
  const userPausedRef = useRef(false);
  /**
   * 上一次硬重建的身份。
   *
   * 只有「同一房间、未手动刷新、仅因续期或软切换失败而自动重建」这一种重建要
   * 沿用用户的暂停意图；首次进入房间、换房与手动刷新仍按原有语义自动起播。
   */
  const lastHardBuildRef = useRef<{
    sessionKey: string;
    reloadToken: number | string;
    renewToken: number | string;
    softFallbackToken: number;
  } | null>(null);

  const [mode, setMode] = useState<PlayerUiMode>("windowed");
  const [paused, setPaused] = useState(false);
  const [volume, setVolume] = useState(initialAudio.volume);
  const [muted, setMuted] = useState(initialAudio.muted);
  const [prevVolume, setPrevVolume] = useState(initialAudio.previousVolume);
  const [mediaAvailable, setMediaAvailable] = useState(false);
  const [running, setRunning] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [fullscreenError, setFullscreenError] = useState<string | null>(null);
  const [mediaKey, setMediaKey] = useState(0);
  const [aspectRatio, setAspectRatio] = useState<number | null>(null);
  /**
   * 上一次量到的画幅及其所属内容身份。
   *
   * 画幅是**流**的属性而不是 `<video>` 节点的属性，因此换线路、故障转移与元数据
   * 续期重建出来的新节点（首个元数据前恒为 0×0）不该把它抹成 `null`：那会连带
   * 释放 Android 的方向锁，正在全屏的播放器随物理方向转回竖屏，全屏也跟着旋转
   * 联动一起退出。只有内容真的换了（换房、换片）才丢弃。
   */
  const measuredAspectRatioRef = useRef<{ sessionKey: string; ratio: number } | null>(null);
  const [softFallbackToken, setSoftFallbackToken] = useState(0);
  const [activeSourceKey, setActiveSourceKey] = useState("");
  /**
   * 已被应用（或由新建传输直接吸收）的续期序号。
   *
   * 它是「这次续期是否还需要软切换」的唯一判据：初始化 effect 新建传输时会把
   * 当时的 token 记入，因此同一 token 不会再多触发一次重连；而重渲染本身不会
   * 让 token 变化，恢复会话也不会重复发布同一个值。
   */
  const appliedRenewTokenRef = useRef<number | string>(renewToken);
  /** 初始化 effect 读取的是本次运行生效的续期序号，不能依赖 ref 的旧值。 */
  const renewTokenRef = useRef<number | string>(renewToken);
  useLayoutEffect(() => {
    renewTokenRef.current = renewToken;
  }, [renewToken]);

  const ownsFullscreen = playerOwnsFullscreen(fullscreenOwner);

  useLayoutEffect(() => {
    qualityRef.current = quality;
  }, [quality]);

  useEffect(() => {
    volumeRef.current = volume;
    mutedRef.current = muted;
  }, [muted, volume]);

  const [previousSessionKey, setPreviousSessionKey] = useState(sessionKey);
  if (previousSessionKey !== sessionKey) {
    setPreviousSessionKey(sessionKey);
    if (profile.resetAudioOnSessionChange) {
      setVolume(initialAudio.volume);
      setMuted(initialAudio.muted);
      setPrevVolume(initialAudio.previousVolume);
    }
  }

  const onMediaFailureRef = useRef(onMediaFailure);
  const onReadyRef = useRef(onReady);
  const onWaitingRef = useRef(onWaiting);
  const onPauseRef = useRef(onPause);
  const onPlayingRef = useRef(onPlaying);
  useLayoutEffect(() => {
    onMediaFailureRef.current = onMediaFailure;
    onReadyRef.current = onReady;
    onWaitingRef.current = onWaiting;
    onPauseRef.current = onPause;
    onPlayingRef.current = onPlaying;
  }, [onMediaFailure, onReady, onWaiting, onPause, onPlaying]);

  /**
   * 有恢复会话所有者时，播放器只发布传输事实，由所有者持有恢复预算并决定
   * 后续线路/续期，不在本地抢先展示错误卡；没有所有者时沿用本地错误文案。
   */
  const reportMediaFailure = useCallback((event: PlayerEvent) => {
    const owner = onMediaFailureRef.current;
    setLoadError(mediaFailureLocalError(event, owner != null));
    owner?.(event);
  }, []);

  const destroyPlayer = useCallback(() => {
    // 销毁者（初始化 effect、离开页面、硬回退）之后的续期由新传输承担，
    // 不应再由软切换对着一个已拆除的播放器重连。
    appliedRenewTokenRef.current = renewTokenRef.current;
    const video = videoRef.current;
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
    setMediaAvailable(false);
    setRunning(false);
  }, []);

  const playbackSourceKey = playUrlKey(playUrl);
  const streamKey = `${sessionKey}::${playbackSourceKey}`;
  const { ready, release: releaseMediaReady } = usePlayerStartupGate(
    JSON.stringify([streamKey, reloadToken, mediaKey, softFallbackToken]),
  );
  // 查询结果可能在播放器运行期间替换等价的 PlayUrl 对象。按 `streamKey` 快照语义
  // 来源，使无害的对象身份抖动不会拆掉 MSE、重建 <video>
  // 并重启进程级代理。
  const playbackSource = useMemo(
    () => playbackSourceFromKey(playbackSourceKey),
    [playbackSourceKey],
  );
  const [retainedPlaybackSource, setRetainedPlaybackSource] = useState<{
    roomKey: string;
    sourceKey: string;
    source: PlayUrl;
  } | null>(null);
  if (playbackSource) {
    if (
      retainedPlaybackSource?.roomKey !== sessionKey ||
      retainedPlaybackSource.sourceKey !== playbackSourceKey
    ) {
      setRetainedPlaybackSource({
        roomKey: sessionKey,
        sourceKey: playbackSourceKey,
        source: playbackSource,
      });
    }
  } else if (
    retainedPlaybackSource &&
    (retainedPlaybackSource.roomKey !== sessionKey || !profile.retainSourceDuringGap)
  ) {
    setRetainedPlaybackSource(null);
  }
  // 来源记忆只在同一房间生效；查询间隙保活，切房绝不回退到旧房间的地址。
  const retainedSource =
    profile.retainSourceDuringGap && retainedPlaybackSource?.roomKey === sessionKey
      ? retainedPlaybackSource
      : null;
  const effectivePlaybackSource = playbackSource ?? retainedSource?.source ?? null;
  const effectivePlaybackSourceKey = playbackSourceKey || retainedSource?.sourceKey || "";
  const effectivePlaybackKind = effectivePlaybackSource
    ? webPlaybackKind(effectivePlaybackSource)
    : null;
  const softSwitchEnabled = shouldUsePlaybackSoftSwitch(
    profile.softSwitch === "settings" && softSwitchConfigured,
    effectivePlaybackKind,
  );
  const effectivePlaybackSourceRef = useRef<PlayUrl | null>(effectivePlaybackSource);
  useLayoutEffect(() => {
    effectivePlaybackSourceRef.current = effectivePlaybackSource;
  }, [effectivePlaybackSource]);
  // 软切换开启时，同一房间的硬 key 不包含具体来源：换线与续期都走原地软切换
  // （失败才递增 `softFallbackToken` 硬回退），媒体元素与播放器不再因每次地址
  // 变化被拆除重建。关闭软切换时任何来源变化仍直接硬重建，续期同样如此。
  const hardStreamKey = softSwitchEnabled
    ? `${sessionKey}::${effectivePlaybackKind ?? "none"}::${softFallbackToken}::${liveSyncHold ? "sync" : "free"}`
    : `${streamKey}::${softFallbackToken}::${renewToken}::${liveSyncHold ? "sync" : "free"}`;

  // 逻辑流身份变化时打开/替换流。
  useEffect(() => {
    let cancelled = false;
    let stopHlsMediaProgress: (() => void) | null = null;
    const gen = ++genRef.current;
    const proxySessionId = `${playerInstanceId}:${gen}`;
    let playbackSource = effectivePlaybackSourceRef.current;
    let sourceKey = playUrlKey(playbackSource);
    // 这次硬重建本身就从当前来源重新打开传输，续期信号已被吸收。
    appliedRenewTokenRef.current = renewTokenRef.current;

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
      // 空来源时同步拆除媒体及代理，避免继续播放上一条流。
      // oxlint-disable-next-line react/set-state-in-effect
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
    // 仅同房间的自动重建沿用用户暂停：解码失败等场景下用户按下的暂停不该被
    // 一次后台重建重新拉起。换房与手动刷新保持自动起播的既有语义。
    // 软切换关闭时续期直接改 `renewToken` 触发硬重建，也算自动重建。
    const previousBuild = lastHardBuildRef.current;
    const preserveUserPause =
      previousBuild !== null &&
      previousBuild.sessionKey === sessionKey &&
      previousBuild.reloadToken === reloadToken &&
      (softFallbackToken !== previousBuild.softFallbackToken ||
        renewTokenRef.current !== previousBuild.renewToken) &&
      userPausedRef.current;
    lastHardBuildRef.current = {
      sessionKey,
      reloadToken,
      renewToken: renewTokenRef.current,
      softFallbackToken,
    };
    setPaused(preserveUserPause);
    userPausedRef.current = preserveUserPause;
    const playbackKind = webPlaybackKind(playbackSource);
    const hlsSource = playbackKind === "hls";
    // 在串行化代理队列拆除上一会话的同时，开始加载所选的 Video.js 适配器。
    const videoJsModulesPromise = loadVideoJsModules(playbackKind);
    void videoJsModulesPromise.catch(() => {});

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

          // 模块加载期间初始来源可能已被取代。使用最新的同协议候选，
          // 而不是短暂打开一条过期线路又立即软切换。
          const latestSource = effectivePlaybackSourceRef.current;
          if (latestSource && webPlaybackKind(latestSource) === playbackKind) {
            playbackSource = latestSource;
            sourceKey = playUrlKey(latestSource);
          }
          const selectedSource = playbackSource;
          if (!selectedSource) {
            throw new Error("播放源已失效");
          }

          // 3) 全新代理（新端口）+ 缓存穿透 query，
          // 使浏览器绝不会复用到上一个监听器的已关闭 keep-alive 连接。
          const localUrl = await invokeCmd<string>(
            "stream_proxy_start",
            // Twitch 等 HLS 站点需要代理把子播放列表、密钥和分片改写到同一个本地会话。
            streamProxyStartArgs(selectedSource, proxySessionId, hlsSource),
          );
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

          const onAutoplayMuted = () => {
            mutedRef.current = true;
            setMuted(true);
          };

          const modules = await videoJsModulesPromise;
          if (cancelled || genRef.current !== gen) {
            await stopProxy();
            return;
          }

          const player = createVideoJsPlayer(modules, {
            video,
            url: playLocal,
            kind: playbackKind,
            isLive: playbackKind !== "native",
            hls: liveHlsPlaybackOptions(liveSyncHold),
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
          const hlsCore = playbackKind === "hls" ? getVideoJsHlsCore(player) : null;
          const mpegtsCore =
            playbackKind === "flv" || playbackKind === "mpegts"
              ? getVideoJsMpegtsCore(player)
              : null;
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
              setRunning(false);
              reportMediaFailure({
                epoch: gen,
                generation: gen,
                kind: "eof",
                message: "直播流已结束",
                protocol: playbackKind,
              });
            });
          }

          // HlsJsAdapter 既可能委托 hls.js MSE，也可能回退到浏览器原生 HLS。
          // 两条路径共用同一个 adapter error 事件，但只有 MSE 暴露恢复 API。
          const reportPlayerError = (error: unknown) => {
            if (!isCurrentPlayer()) return;
            // 软切进行中，本次失败的传输由 `switchSource` 的 error 监听认领：
            // 它会 reject，调用方据此走既有硬回退。这里若再发布一次失败，恢复
            // 会话会在代理重开与 `switchSource` 结算之前另起一次恢复，形成双恢复。
            // 准备期的旧错误同样只退役旧传输，新传输仍按事务建立。
            if (softSwitchOwnsTransport(softSwitchInFlightRef.current, player)) return;
            const failure = classifyTransportFailure(error, playbackKind);
            const message = failure.message;
            // 早断流与 `loading_complete` 同属可续签的结束事实：先不弹错误卡，
            // 续期失败或预算耗尽时由恢复会话给出提示。
            setRunning(false);
            reportMediaFailure({
              epoch: gen,
              generation: gen,
              kind: failure.kind,
              message,
              protocol: playbackKind,
              ...(failure.decodeError ? { decodeError: true } : {}),
            });
          };
          if (!hlsCore) player.on("error", reportPlayerError);

          if (hlsCore && siteId !== "twitch") {
            const recoveryBudget = createHlsRecoveryBudget({ siteId });
            player.on("playing", () => {
              if (!isCurrentPlayer()) return;
              recoveryBudget.notePlaying();
            });
            stopHlsMediaProgress = watchHlsMediaProgress(
              video,
              () => recoveryBudget.noteProgress(),
              () => recoveryBudget.noteInterrupted(),
              isCurrentPlayer,
            );
            const reportHlsFailure = (cause: unknown, recoveryExhausted = false) => {
              if (!isCurrentPlayer()) return;
              const message = videoJsPlayerErrorMessage(cause, "HLS 连接中断");
              setRunning(false);
              if (recoveryExhausted) {
                playerRef.current = null;
                try {
                  player.destroy();
                } catch {
                  /* 致命 HLS 错误可能已经释放了内部状态。 */
                }
              }
              reportMediaFailure({
                epoch: gen,
                generation: gen,
                kind: "error",
                message,
                protocol: "hls",
                recoveryExhausted,
              });
            };
            player.on("error", (cause) => {
              // hls.js 的 fatal 可能已经释放 engine；MSE 判定必须在事件栈内快照。
              const isMse = hlsCore.isMse();
              const disposition = classifyHlsPlayerError(cause);
              queueMicrotask(() => {
                if (!isCurrentPlayer()) return;
                if (!isMse) {
                  reportPlayerError(cause);
                  return;
                }
                if (disposition.type === "ignore") return;
                if (disposition.type === "player_error") {
                  reportPlayerError(cause);
                  return;
                }
                const action = recoveryBudget.recordFatal({
                  recovery: disposition.recovery,
                });
                if (action.type === "recovery_exhausted") {
                  reportHlsFailure(cause, true);
                  return;
                }
                setRunning(false);
                // Video.js 上报终止错误但不替应用重启；使用 hls.js 的公开恢复 API。
                if (disposition.recovery === "recoverMediaError") hlsCore.recoverMediaError();
                else hlsCore.startLoad();
              });
            });
          }

          if (hlsCore && siteId === "twitch") {
            const twitchHlsCore = hlsCore;
            const recoveryBudget = createHlsRecoveryBudget({ siteId });
            let decoderFailureReported = false;
            /**
             * Twitch 的 HLS 失败与播放器自身错误共用 adapter 的 error 事件。
             * 只有已确认的 hls.js fatal 才进入 startLoad / 续期；其余错误必须
             * 回到既有 reportPlayerError，尤其不能把 play() 拒绝当成清单失败。
             */
            function reportTwitchHlsFailure(cause: unknown, recoveryExhausted: boolean) {
              const event = cause as { details?: string } | null;
              const hlsJsDetails = event?.details ?? "";
              const errorMessage = hlsJsDetails
                ? `Twitch HLS ${hlsJsDetails}`
                : videoJsPlayerErrorMessage(cause, "Twitch HLS 连接中断");
              const commercialBreak = isTwitchCommercialBreak(cause);
              const responseStatus = hlsResponseStatus(cause);
              if (recoveryExhausted) {
                playerRef.current = null;
                try {
                  player.destroy();
                } catch {
                  /* 致命 HLS 错误可能已经释放了内部状态。 */
                }
              }
              setRunning(false);
              reportMediaFailure({
                epoch: gen,
                generation: gen,
                kind: "error",
                message: recoveryExhausted
                  ? commercialBreak
                    ? "Twitch 正在播放广告"
                    : `${errorMessage}，HLS 内部恢复已耗尽`
                  : errorMessage,
                protocol: "hls",
                ...(responseStatus != null ? { httpStatus: responseStatus } : {}),
                ...(recoveryExhausted ? { recoveryExhausted: true } : {}),
                ...(commercialBreak ? { commercialBreak: true } : {}),
              });
            }
            function failDecoder() {
              if (decoderFailureReported || !isCurrentPlayer()) return;
              decoderFailureReported = true;
              // 重放或续期同一渲染档无法改变浏览器的编解码决定。让控制器切换到更低的
              // Twitch 视频变体，而不是烧掉 URL 重试预算。
              playerRef.current = null;
              try {
                player.destroy();
              } catch {
                /* 致命解码错误可能已经释放了内部状态。 */
              }
              setRunning(false);
              reportMediaFailure({
                epoch: gen,
                generation: gen,
                kind: "error",
                message: "当前 Twitch 清晰度无法解码",
                protocol: "hls",
                decodeError: true,
              });
            }
            player.on("playing", () => {
              if (isCurrentPlayer()) recoveryBudget.notePlaying();
            });
            stopHlsMediaProgress = watchHlsMediaProgress(
              video,
              () => recoveryBudget.noteProgress(),
              () => recoveryBudget.noteInterrupted(),
              isCurrentPlayer,
            );
            function handleFatalHlsFailure(cause: unknown) {
              if (!isCurrentPlayer()) return;
              const disposition = classifyHlsPlayerError(cause);
              if (disposition.type === "ignore") return;
              if (disposition.type === "player_error") {
                reportPlayerError(cause);
                return;
              }
              if (isVideoJsDecodeError(cause)) {
                failDecoder();
                return;
              }

              const commercialBreak = isTwitchCommercialBreak(cause);
              const responseStatus = hlsResponseStatus(cause);
              const action = recoveryBudget.recordFatal({
                recovery: disposition.recovery,
                commercialBreak,
                responseStatus,
              });
              if (action.type === "restart") {
                setRunning(false);
                try {
                  if (action.recovery === "recoverMediaError") {
                    twitchHlsCore.recoverMediaError();
                  } else {
                    twitchHlsCore.startLoad();
                  }
                } catch {
                  // 后续致命事件推进到播放地址续期。
                }
                return;
              }

              reportTwitchHlsFailure(cause, true);
            }
            player.on("error", (cause) => {
              // fatal 可能同步释放 engine；在事件栈内快照原生/MSE 分流。
              // 微任务中的 helper 只处理已确认的 MSE 路径。
              const isMse = twitchHlsCore.isMse();
              queueMicrotask(() => {
                if (!isCurrentPlayer()) return;
                if (!isMse) {
                  reportPlayerError(cause);
                  return;
                }
                handleFatalHlsFailure(cause);
              });
            });
          }

          // 不要在 `proxyLifecycleQueue` 中 await 这个 promise：它可能一直挂起直到第一个
          // 直播媒体分片到达。队列必须保持空闲，路由清理才能停止本代理，
          // 重进的房间才能立刻启动替代会话。
          const canAutoPlay = () => isCurrentPlayer() && !userPausedRef.current;
          requestPlayerAutoplay(player, video, canAutoPlay, onAutoplayMuted);

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
          setRunning(false);
          destroyPlayer();
          await stopProxy();
          if (cancelled || genRef.current !== gen) return;
          reportMediaFailure({
            epoch: gen,
            generation: gen,
            kind: "error",
            message: msg || "播放失败",
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
      stopHlsMediaProgress?.();
      stopHlsMediaProgress = null;
      destroyPlayer();
      void proxyLifecycleQueue.enqueue(stopProxy);
    };
  }, [
    hardStreamKey,
    reloadToken,
    destroyPlayer,
    liveSyncHold,
    mobileClient,
    playerInstanceId,
    profile,
    proxyLifecycleQueue,
    reportMediaFailure,
    sessionKey,
    siteId,
    softFallbackToken,
  ]);

  // 同协议的来源变化可以保留媒体元素与 MSE 状态。各直播 CDN 的时间戳连续性并不
  // 统一，任何初始化/切换失败都会自增硬 key 并干净重建。
  // 每次续期都要重新打开传输，即使 `playUrlKey` 没变（签名地址常常原样返回）。
  // `appliedRenewTokenRef` 记录已消费的续期序号：同一 token 只重连一次，
  // 重渲染不会重复应用；新建传输则直接吸收当前 token。
  useEffect(() => {
    if (!effectivePlaybackSource || !effectivePlaybackKind) return;
    if (
      !shouldSoftSwitchToSource({
        enabled: softSwitchEnabled,
        activeSourceKey,
        targetSourceKey: effectivePlaybackSourceKey,
        activeKind: activePlaybackKindRef.current,
        targetKind: effectivePlaybackKind,
        force: renewToken !== appliedRenewTokenRef.current,
      })
    ) {
      return;
    }

    const player = playerRef.current;
    const proxySessionId = activeProxySessionIdRef.current;
    if (!player || !proxySessionId) {
      appliedRenewTokenRef.current = renewToken;
      setSoftFallbackToken((token) => token + 1);
      return;
    }

    let cancelled = false;
    const sequence = ++softSwitchSequenceRef.current;
    const targetSource = effectivePlaybackSource;
    const targetKey = effectivePlaybackSourceKey;
    const targetKind = effectivePlaybackKind;
    // 续期重连保留用户的暂停意图；普通换源维持「原本在播就继续播」。
    const isRenewal = renewToken !== appliedRenewTokenRef.current;
    // 续期只在同协议时走到这里；即便来源 key 不变，传输也要重新打开。
    appliedRenewTokenRef.current = renewToken;
    // 共享的媒体首错 guard：当前 <video> 已不能安全承载新传输时，直接触发
    // 硬回退，不为一次必然失败的软切先重开代理。
    if (!canSwitchVideoJsSource(player)) {
      setLoadError(null);
      setSoftFallbackToken((token) => token + 1);
      return;
    }
    // 只尊重用户自己的暂停意图：`ended` 或流中断造成的 `paused` 必须照常恢复，
    // 否则一次自动续期只会把画面停在黑屏上。
    const resumePlayback = !userPausedRef.current;
    // 代理启动与媒体就绪都要经过 IPC/事件循环；届时重新读取同一份暂停意图。
    const canAutoPlay = () => !userPausedRef.current;
    // 事务要在排队前就登记：从这一刻起旧传输的失败都归 `switchSource` 处理。
    // 若等到队列内再登记，排在后面的旧 core 错误会先一步发布给恢复会话。
    const inFlight = { player, sequence };
    softSwitchInFlightRef.current = inFlight;

    void proxyLifecycleQueue
      .enqueue(async () => {
        if (
          cancelled ||
          sequence !== softSwitchSequenceRef.current ||
          playerRef.current !== player ||
          activeProxySessionIdRef.current !== proxySessionId
        ) {
          if (softSwitchInFlightRef.current === inFlight) softSwitchInFlightRef.current = null;
          return null;
        }

        let handedOff = false;
        try {
          const localUrl = await invokeCmd<string>(
            "stream_proxy_start",
            streamProxyStartArgs(targetSource, proxySessionId, targetKind === "hls"),
          );
          if (
            cancelled ||
            sequence !== softSwitchSequenceRef.current ||
            playerRef.current !== player
          ) {
            return null;
          }
          const localSource = `${localUrl}${localUrl.includes("?") ? "&" : "?"}switch=${Date.now()}_${sequence}`;
          // 换源在队列内发起，与代理所有权变更保持有序；媒体就绪的等待放到队列外。
          // 它最长 12 秒，把它留在队列里会让本实例后续的切源、硬重建和退出一起等。
          const ready = switchVideoJsPlaybackSource(player, localSource, targetKind, undefined, {
            autoPlay: isRenewal ? resumePlayback : undefined,
            canAutoPlay,
          });
          // 真正的处理在队列外，这里立刻吸收拒绝，避免中间的微任务窗口产生
          // 未处理拒绝告警；取消与超时仍按下方 settled 的结果走原有分支。
          const settled = ready.then(
            () => null,
            (error: unknown) => ({ error }),
          );
          handedOff = true;
          return { inFlight, settled };
        } finally {
          // 只有交接失败（IPC 抛错或已被取代）才在这里清理；否则所有权随媒体等待转出。
          if (!handedOff && softSwitchInFlightRef.current === inFlight) {
            softSwitchInFlightRef.current = null;
          }
        }
      })
      .then(async (prepared) => {
        if (!prepared) return;
        const { inFlight, settled } = prepared;
        try {
          const failure = await settled;
          if (failure) throw failure.error;
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
        // 硬重建或恢复耗尽可能已经销毁了这次软切换的播放器；它不再拥有
        // 触发硬回退的资格，避免一次多余的代理重启与黑帧。
        if (
          cancelled ||
          sequence !== softSwitchSequenceRef.current ||
          playerRef.current !== player
        ) {
          return;
        }
        setLoadError(null);
        setSoftFallbackToken((token) => token + 1);
      });

    return () => {
      cancelled = true;
      // 取消只解除本次事务对错误的认领；已在 `switchSource` 内的失败仍由它
      // 自己的监听 reject，交给调用方走既有硬回退。
      if (softSwitchInFlightRef.current === inFlight) softSwitchInFlightRef.current = null;
    };
  }, [
    activeSourceKey,
    effectivePlaybackKind,
    effectivePlaybackSource,
    effectivePlaybackSourceKey,
    liveSyncHold,
    profile,
    proxyLifecycleQueue,
    renewToken,
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
    if (!video) return;
    const generation = genRef.current;
    const playbackKind = effectivePlaybackKind;

    const isCurrentMedia = () =>
      videoRef.current === video &&
      genRef.current === generation &&
      playerRef.current?.media === video;

    const onPlay = () => {
      if (!isCurrentMedia()) return;
      setPaused(false);
    };
    const onPlaying = () => {
      if (!isCurrentMedia()) return;
      releaseMediaReady();
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
    const onVolumeChange = () => {
      if (!isCurrentMedia()) return;
      const nextVolume = clampWebPlayerVolume(video.volume * 100);
      const nextMuted = video.muted || nextVolume === 0;
      volumeRef.current = nextVolume;
      mutedRef.current = nextMuted;
      if (nextVolume > 0) setPrevVolume(nextVolume);
      setVolume(nextVolume);
      setMuted(nextMuted);
    };
    const onWaiting = () => {
      if (!isCurrentMedia()) return;
      onWaitingRef.current?.();
    };
    // Android 全屏自动全屏依据解码后的帧尺寸决定，
    // 因此比例既要跟随首个元数据，也要跟随自适应阶梯在流中进行的后续分辨率切换。
    // 重建出来的节点在元数据到达前报告 0×0，那不是「未知画幅」而是「还没量」，
    // 因此同内容期间沿用上一次量到的值（见 `measuredAspectRatioRef`）。
    const syncAspectRatio = () => {
      if (videoRef.current !== video) return;
      const measured = videoAspectRatio(video);
      const retained = measuredAspectRatioRef.current;
      const previous = retained?.sessionKey === sessionKey ? retained.ratio : null;
      if (measured != null) measuredAspectRatioRef.current = { sessionKey, ratio: measured };
      setAspectRatio(retainMeasuredAspectRatio(previous, measured));
    };
    const onCanPlay = () => {
      if (!isCurrentMedia()) return;
      releaseMediaReady();
      setPaused(video.paused);
      onReadyRef.current?.();
    };
    const onEnded = () => {
      if (!isCurrentMedia()) return;
      setRunning(false);
      reportMediaFailure({
        epoch: generation,
        generation,
        kind: "eof",
        message: "直播流已结束",
        protocol: playbackKind ?? undefined,
      });
    };
    syncAspectRatio();
    video.addEventListener("play", onPlay);
    video.addEventListener("playing", onPlaying);
    video.addEventListener("pause", onPause);
    video.addEventListener("waiting", onWaiting);
    video.addEventListener("canplay", onCanPlay);
    video.addEventListener("ended", onEnded);
    video.addEventListener("loadedmetadata", syncAspectRatio);
    video.addEventListener("resize", syncAspectRatio);
    video.addEventListener("volumechange", onVolumeChange);
    return () => {
      video.removeEventListener("play", onPlay);
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("canplay", onCanPlay);
      video.removeEventListener("ended", onEnded);
      video.removeEventListener("loadedmetadata", syncAspectRatio);
      video.removeEventListener("resize", syncAspectRatio);
      video.removeEventListener("volumechange", onVolumeChange);
    };
  }, [
    effectivePlaybackKind,
    mediaKey,
    sessionKey,
    streamKey,
    releaseMediaReady,
    reportMediaFailure,
  ]);
  // `sessionKey` 已包含在 `streamKey` 里，多列一次不会多跑 effect；它被单列是因为
  // `syncAspectRatio` 直接读它来判断画幅该不该跨媒体重建保留。

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
    // mpegts.js 由 Video.js 适配层托管；同步时使用适配层暴露的 seek 入口。
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

  const { freeze: freezeFullscreenInsets, release: releaseFullscreenInsets } =
    useFullscreenInsetFreeze();

  useEffect(() => {
    if (!ownsFullscreen) {
      // 全屏所有权属于原生窗口，失去所有权需同步撤销页面固定层。
      // oxlint-disable-next-line react/set-state-in-effect
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
    return watchDesktopFullscreen({
      getWindow: getCurrentWindow,
      restoreMaximized: (appWindow) =>
        restoreNativePlayerMaximizedState(appWindow, nativeFullscreenSessionRef.current),
      setMode,
    });
  }, [ownsFullscreen]);

  const togglePause = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      userPausedRef.current = false;
      void video.play().catch(() => {});
    } else {
      userPausedRef.current = true;
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
    // 协议插件已就绪但播放仍未开始时，轻推一次播放；用户自己按下的暂停不推。
    if (video && video.paused && playerRef.current && !userPausedRef.current) {
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
    ready,
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
    toggleFullscreen,
    exitFullscreen,
    sync,
  };
}

export function useWebPlayer(opts: WebPlayerOptions): WebPlayerApi {
  return useMediaLifecycle({ ...opts, profile: LIVE_MEDIA_LIFECYCLE_PROFILE });
}
