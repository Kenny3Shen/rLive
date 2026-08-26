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
 * Desktop Tauri (Windows/macOS/Linux) drives fullscreen through the native OS
 * window rather than the HTML Fullscreen API. WebView2 does not grow the
 * native window past the work area when the window is maximized, so an HTML
 * `:fullscreen` element renders at screen height while the viewport is still
 * only work-area height — the taskbar-height black band users hit at the
 * bottom. A real window fullscreen covers the taskbar and the stage overlays
 * the room chrome as an in-page fixed layer.
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

/**
 * Keep the capability check separate from the DOM lifecycle so the control
 * can disappear cleanly in WebViews that do not expose native video PiP.
 */
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
    // The native window can already be closing while a route is changing.
  }
}

/**
 * Toggle native video PiP without assuming the embedding WebView implements
 * it. Kept DOM-argument driven so the compatibility behavior stays unit-testable
 * without a browser DOM.
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
      // A different native PiP window still owns the document, so asking the
      // browser to open ours would just fail and produce a noisy rejection.
      if (documentRef.pictureInPictureElement) return false;
    }

    await video.requestPictureInPicture();
    return true;
  } catch {
    return false;
  }
}

/**
 * Android WebView versions in the wild expose either the standard Fullscreen
 * API or its older WebKit-prefixed counterpart. Keep the compatibility layer
 * DOM-argument driven, just like PiP above, so it stays testable without a
 * browser runtime.
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

/** Returns false only when this WebView exposes no usable fullscreen API. */
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
 * Native window fullscreen is a property of the window, not of one player, so
 * several players mounted in the same window all observe the same state. Only
 * the player that owns the fullscreen control may report or drive it; the rest
 * stay windowed so multi-room secondaries keep their normal grid chrome while
 * the main feed is the surface that fills the screen.
 */
export function playerOwnsFullscreen(fullscreenOwner: boolean | undefined): boolean {
  return fullscreenOwner !== false;
}

/** How a feed's media timeline maps onto wall-clock time, if at all. */
export type LivePlayerClockKind = "program-date" | "stream-anchor" | "none";

export type LivePlayerTimeline = {
  /** Playing, with at least one buffered range: safe to correct. */
  ready: boolean;
  mediaTime: number;
  bufferStart: number;
  /** Live edge on this feed's own media timeline. */
  bufferEnd: number;
  clockKind: LivePlayerClockKind;
  /** Epoch (ms) matching `mediaTime === 0`; null without a clock. */
  epochAtMediaZeroMs: number | null;
  playbackRate: number;
  paused: boolean;
};

/**
 * Imperative handle used by the multi-view clock alignment.
 *
 * Sampling and correcting several feeds once per second must not re-render
 * anything, so this is a stable object read through refs rather than state.
 */
export type LivePlayerSyncApi = {
  readTimeline: () => LivePlayerTimeline;
  /** Jump inside the retained buffer; no-op when the media is gone. */
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
  /** A non-fatal fullscreen failure that must never replace the media view. */
  fullscreenError: string | null;
  setLoadError: (msg: string | null) => void;
  /** Bump forces a brand-new <video> node (clears stuck MediaSource). */
  mediaKey: number;
  /** Decoded frame ratio, or null until the first metadata arrives. */
  aspectRatio: number | null;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  /** Exclusive DOM root managed by xgplayer; overlays remain outside it. */
  playerRootRef: React.RefObject<HTMLDivElement | null>;
  stageRef: React.RefObject<HTMLDivElement | null>;
  togglePause: () => void;
  /** Apply a gesture frame directly without reconciling the player tree. */
  previewVolume: (v: number) => void;
  changeVolume: (v: number) => void;
  setAudio: (volume: number, muted: boolean) => void;
  toggleMute: () => void;
  togglePictureInPicture: () => Promise<void>;
  exitPictureInPicture: () => Promise<void>;
  toggleFullscreen: () => Promise<void>;
  /** Leave fullscreen without toggling back in; safe to call when windowed. */
  exitFullscreen: () => Promise<void>;
  /** Live clock sampling / correction used by the multi-view alignment. */
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

/** Apply one normalized audio snapshot to the active room's media element. */
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

/** Whether a live URL requires xgplayer's HLS plugin rather than its FLV plugin. */
export function isHlsStream(url: string): boolean {
  return /\.m3u8(?:[?#]|$)/i.test(url) || /[/?&=_-]hls(?:[/?&=_-]|$)/i.test(url);
}

/**
 * `HTMLMediaElement.play()` clears `paused` before the first frame is ready.
 * Treating that intermediate state as healthy resets the Twitch renewal budget
 * while the stream is still loading and can create an endless reload loop.
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
 * hls.js has already attempted its built-in recovery before the player error
 * reaches this boundary. Retry once, then report that transport recovery is
 * exhausted so the playback session can choose the next domain action.
 */
export function nextHlsFatalRecoveryAction(
  failureCount: number,
  commercialBreak = false,
  authorizationFailed = false,
): HlsFatalRecoveryAction {
  // A 401/403 on a Twitch media playlist is normally a short-lived signed
  // URL expiring. Replaying against the same URL only repeats the failure.
  if (authorizationFailed && !commercialBreak) {
    return { type: "recovery_exhausted" };
  }
  if (failureCount <= 1) return { type: "restart" };
  return { type: "recovery_exhausted" };
}

/**
 * A commercial break is platform-delivered content, not an error to bypass.
 * Some transient playlist responses include this text instead of a manifest;
 * recognizing it lets us wait and refresh normally once the break changes.
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
  // Include a stable header fingerprint so cookie/referer changes also reload.
  // JSON keeps separators in URLs/header values unambiguous and can be
  // reconstructed into an immutable playback snapshot below.
  return JSON.stringify([
    playUrl.url,
    Object.entries(playUrl.headers).sort(([a], [b]) => a.localeCompare(b)),
    playUrl.source_id,
    playUrl.label,
    playUrl.protocol,
    playUrl.priority,
  ]);
}

export function webPlaybackKind(source: Pick<PlayUrl, "url" | "protocol">): XgPlaybackKind {
  switch (playbackProtocol(source)) {
    case "hls":
      return "hls";
    case "mpeg_ts":
      return "mpegts";
    case "native":
      return "native";
    default:
      return "flv";
  }
}

/**
 * Keep a modest latency and cleanup window for continuous FLV. Mobile receives
 * a wider live window for its tighter decode and scheduling budget.
 *
 * `syncHold` is the multi-view clock-alignment profile: the built-in latency
 * chasing would jump the feed back to the live edge as soon as the alignment
 * holds it further behind, so it is turned off and the backward window is
 * widened to the range an alignment offset may use.
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
 * hls.js options for one live feed.
 *
 * Under `syncHold` the alignment owns the distance to the live edge, so hls.js
 * must neither force a jump forward once that distance grows nor discard the
 * back buffer the alignment seeks into.
 */
export function liveHlsPlaybackOptions(syncHold = false): Record<string, unknown> {
  return {
    lowLatencyMode: false,
    backBufferLength: syncHold ? LIVE_SYNC_HOLD_MAX_BACKWARD_SECONDS : 30,
    maxBufferLength: syncHold ? 45 : 30,
    liveSyncDurationCount: 3,
    liveMaxLatencyDurationCount: syncHold ? 90 : 6,
    // Any hls.js rate correction would fight the alignment's own rate trim.
    maxLiveSyncPlaybackRate: 1,
    manifestLoadingMaxRetry: 3,
    levelLoadingMaxRetry: 3,
    fragLoadingMaxRetry: 3,
  };
}

/** MPEG-TS (IPTV-style) live options, mirroring the FLV sync-hold rules. */
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
 * Backward buffer retained per feed while a multi-view alignment is active.
 *
 * The alignment only ever delays a feed by seeking into media it has already
 * buffered, so this window bounds the offset it can apply. It is deliberately
 * finite: six feeds each retaining a minute of video would cost far more memory
 * than the alignment is worth.
 */
export const LIVE_SYNC_HOLD_MIN_BACKWARD_SECONDS = 30;
export const LIVE_SYNC_HOLD_MAX_BACKWARD_SECONDS = 42;
/** Rate bounds a sync correction may request on a muted secondary feed. */
export const LIVE_SYNC_MIN_PLAYBACK_RATE = 0.9;
export const LIVE_SYNC_MAX_PLAYBACK_RATE = 1.1;
/**
 * Longest buffered span that may still be treated as "freshly started".
 *
 * The stream anchor pairs the proxy's first media byte with the media position
 * that byte produced, which is only knowable while the transport has just
 * started. After a soft switch the element can still hold a long retained
 * buffer, and its start no longer marks where the replacement stream began, so
 * that feed keeps no estimated clock instead of an invented one.
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

// Serialize frontend lifecycle commands so a teardown and a same-session soft
// switch cannot cross. The native proxy keeps independent listeners per
// session, so this queue does not transfer ownership between player instances.
const proxyLifecycleQueue = createSerialTaskQueue();

let nextPlayerInstanceId = 0;

function createPlayerInstanceId(): string {
  nextPlayerInstanceId = (nextPlayerInstanceId + 1) % Number.MAX_SAFE_INTEGER;
  // Keep IDs unique across a WebView reload too: a delayed command from the
  // prior JS context must not accidentally own a freshly opened proxy.
  const entropy = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  return `web-player-${entropy}-${nextPlayerInstanceId}`;
}

/**
 * DOM live player (HLS / MSE, no mpv). Streams through the localhost proxy so
 * CDN headers and nested HLS resources work consistently.
 *
 * Re-entry fix: each open bumps `mediaKey` (new <video>), stops proxy, waits a
 * tick, then starts a fresh proxy URL with cache-bust. Avoids black screen from
 * reused MediaSource / expired CDN URL / half-destroyed xgplayer instance.
 */
export type MediaLifecycleOptions = {
  playUrl: PlayUrl | null;
  siteId?: SiteId;
  quality?: string | null;
  /** Rebuild even when two rooms happen to resolve to the same stream URL. */
  sessionKey?: string;
  /** Per-instance audio defaults; multi-room secondary players start silent. */
  initialVolume?: number;
  initialMuted?: boolean;
  /**
   * Whether this player may drive and observe fullscreen. Multi-room mounts
   * several players in one window, where fullscreen belongs to the main feed
   * alone; pass false for the secondaries. Defaults to true.
   */
  fullscreenOwner?: boolean;
  /** Semantic rebuild key; changing it recreates the transport for the same source. */
  reloadToken?: number | string;
  /**
   * Configure the transport for multi-view clock alignment: no built-in latency
   * chasing and a wider backward buffer. Changing it rebuilds the transport,
   * because both protocol plugins read these options only at creation.
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
  /** Identity of the current media timeline; every anchor below belongs to it. */
  const syncTimelineTokenRef = useRef("");
  const syncStreamAnchorRef = useRef<{ token: string; epochAtMediaZeroMs: number } | null>(null);
  const syncMediaTimeOriginRef = useRef<{ token: string; mediaTime: number } | null>(null);
  const softSwitchSequenceRef = useRef(0);
  const softSwitchInFlightRef = useRef<{ player: XgPlayerInstance; sequence: number } | null>(null);
  const qualityRef = useRef<string | null>(quality);
  const nativeFullscreenSessionRef = useRef(createNativeFullscreenSession());
  // Releases the shell-padding freeze held across an entering fullscreen
  // transition; null whenever no freeze is active.
  const fullscreenInsetFreezeRef = useRef<(() => void) | null>(null);
  const fullscreenInsetFreezeTimerRef = useRef<number | null>(null);
  /** Mirrors the in-page fullscreen state for teardown paths that have no `mode`. */
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
    // A PiP request is asynchronous. Bumping the version here lets its
    // continuation detect a room switch and close any stale native window.
    mediaLifecycleVersionRef.current += 1;

    const video = videoRef.current;
    void exitPictureInPictureForVideo(getPictureInPictureDocument(), video);
    setPictureInPictureActive(false);
    // `pictureInPictureSupported` is a device/document capability, not a
    // per-stream state. Clearing it here made the control unmount on every
    // teardown, so a stall's reconnect loop flickered the button in and out.
    // Leave it sticky; `togglePictureInPicture` re-checks availability anyway.

    const p = playerRef.current;
    playerRef.current = null;
    if (p) {
      try {
        p.pause();
      } catch {
        /* ignore */
      }
      try {
        p.destroy();
      } catch {
        /* ignore */
      }
    }
    if (video) {
      try {
        video.pause();
        video.removeAttribute("src");
        video.srcObject = null;
        video.load();
      } catch {
        /* ignore */
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
  // Query results can replace an equivalent PlayUrl object while the player
  // is running. Snapshot the semantic source by `streamKey` so that harmless
  // object-identity churn does not tear down MSE, recreate the <video>, and
  // restart the process-global proxy.
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
  // During a quality query the controller can briefly have no URL. Keep the
  // active source alive so soft switching does not introduce a black frame
  // while the replacement metadata is loading.
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

  // Open / replace stream whenever the logical stream identity changes.
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
        /* ignore */
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
    // Start fetching xgplayer and only the selected protocol plugin while the
    // serialized proxy queue tears down the previous session.
    const xgModulesPromise = loadXgPlayerModules(playbackKind);
    // If a fast room switch cancels the queued setup before it reaches the
    // await below, retain a rejection handler so the speculative preload never
    // becomes an unhandled promise rejection.
    void xgModulesPromise.catch(() => {});

    void proxyLifecycleQueue
      .enqueue(async () => {
        // An earlier route's queued setup may be reached only after a newer
        // route has rendered. It must still stop its own stale proxy before
        // allowing the replacement operation through the queue.
        if (cancelled || genRef.current !== gen) {
          await stopProxy();
          return;
        }

        try {
          // 1) Tear down the previous MSE completely. The upcoming proxy
          // start atomically replaces any previous listener; cleanup only
          // ever stops the listener it owns (see proxySessionId above).
          destroyPlayer();
          // Let the OS release the previous listen socket / MediaSource settle.
          await sleep(50);
          if (cancelled || genRef.current !== gen) return;

          // 2) Force a brand-new <video> node so MediaSource is never reused.
          setMediaKey((k) => k + 1);
          await nextFrame();
          await nextFrame();
          if (cancelled || genRef.current !== gen) return;

          // Wait until the new video element is mounted (ref attached).
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

          // The initial source can be superseded while modules are loading.
          // Use the latest same-protocol candidate instead of briefly opening
          // an obsolete line and immediately soft-switching it.
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

          // 3) Fresh proxy (new port) + cache-bust query so the browser never
          // reuses a closed keep-alive to the previous listener.
          const localUrl = await invokeCmd<string>("stream_proxy_start", {
            url: selectedSource.url,
            headers: selectedSource.headers,
            sessionId: proxySessionId,
            // Twitch and other HLS sites need the proxy to rewrite child
            // playlists, keys and segments to the same local session.
            hls: hlsSource,
            twitchAdRecovery: selectedSource.twitch_ad_recovery,
          });
          if (cancelled || genRef.current !== gen) {
            await stopProxy();
            return;
          }
          const playLocal = `${localUrl}${localUrl.includes("?") ? "&" : "?"}t=${Date.now()}_${gen}`;
          activeProxySessionIdRef.current = proxySessionId;

          // Hard-reset the element before either MSE player attaches. This is
          // also required for native HLS fallback after a previous MSE room.
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

          // Register ownership before autoplay: play() can remain pending until
          // the first live segment, while route cleanup must stay immediate.
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
          // A fresh transport means a fresh media timeline: the wall-clock
          // anchors derived below must never survive it.
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

          // HLS fatal events use their protocol-specific recovery below.
          // Non-HLS errors continue through xgplayer's standard event path.
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
                  /* A fatal HLS error can already have released internals. */
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
              // HlsJsPlugin immediately calls startLoad/recoverMediaError for
              // the first fatal event. Escalate only when that recovery also
              // fails, then obtain fresh site metadata and rebuild the player.
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
              // Replaying or renewing the same rendition cannot change a
              // browser codec decision. Let the controller move to a lower
              // Twitch video variant instead of burning the URL retry budget.
              playerRef.current = null;
              try {
                player.destroy();
              } catch {
                /* A fatal decoder error can already have released internals. */
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
                    // A subsequent hls.js fatal event advances to URL renewal.
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
                /* A fatal HLS error can already have released internals. */
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
              // The plugin starts its built-in recovery immediately after
              // emitting HLS_ERROR. Defer our retry accounting so destroying
              // a failed player cannot invalidate that synchronous callback.
              window.setTimeout(() => handleFatalHlsFailure(event, true), 0);
            });
            player.on("error", (cause) => {
              handleFatalHlsFailure(cause);
            });
          }

          // Do not await this promise in `proxyLifecycleQueue`: it can stay
          // pending until the first live media segment arrives. The queue must
          // remain free so route cleanup can stop this proxy and a re-entered
          // room can start its replacement session right away.
          requestPlayerAutoplay(player, video, isCurrentPlayer, recoverMutedAutoplay);

          // If we already have frames, mark running; otherwise wait for play event.
          if (hasStartedPlayback(video)) {
            setRunning(true);
            setLoadError(null);
            onPlayingRef.current?.();
          } else {
            // Give the protocol plugin a moment; do not clear retry budgets
            // until the element has decoded at least one frame.
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
        // The setup body reports recoverable failures to the controller. This
        // catch only prevents an unexpected queue failure from becoming an
        // unhandled promise rejection.
      });

    return () => {
      cancelled = true;
      destroyPlayer();
      void proxyLifecycleQueue.enqueue(stopProxy);
    };
  }, [hardStreamKey, reloadToken, destroyPlayer, liveSyncHold, mobileClient, profile, siteId]);

  // Same-protocol source changes can retain the media element and MSE state.
  // Live CDN timestamp continuity is not uniform, so any setup/switch failure
  // increments the hard key and rebuilds cleanly.
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
          // The plugin rebuilt its transport, so the clock anchors have to be
          // derived again from the replacement stream.
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

  // Reflect transport controls onto the element.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    applyWebPlayerAudio(video, volume, muted);
  }, [volume, muted, mediaKey]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      // A momentary null (mid mediaKey swap) is not a loss of the device
      // capability. Only the active flag, which is element-specific, resets.
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
      // A leave event from the <video> that was just replaced must never
      // overwrite the state of the new MediaSource node.
      if (videoRef.current !== video) return;
      // Support is monotonic: latch it on once so a reconnect loop cannot
      // unmount the control. `canUsePictureInPicture` gates the actual toggle.
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
    // Android fullscreen auto-rotation is decided from the decoded frame size,
    // so the ratio has to follow both the first metadata and later resolution
    // switches an adaptive ladder makes mid-stream.
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
        // Browser previews and an already-closing native session still produce
        // useful media-element metrics without proxy counters.
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
   * Derive the wall-clock anchor for containers without a program clock.
   *
   * FLV and MPEG-TS timestamps start near zero, so the only absolute reference
   * available is the epoch at which the proxy received this session's first
   * media byte. Pairing it with the media position that byte produced turns
   * `currentTime` into an estimated capture time. The CDN's edge burst is part
   * of that estimate, which is why it is only comparable between feeds.
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
      // The first retained sample is the closest stand-in for the media
      // position of the session's first byte.
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
        // A browser preview has no native proxy; those feeds simply stay on the
        // manual hold instead of the estimated clock.
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
      playbackRate: video?.playbackRate ?? 1,
      paused: video?.paused ?? true,
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
      playbackRate: video.playbackRate,
      paused: video.paused,
      ...clock,
    };
  }, []);

  const seekSyncMediaTime = useCallback((seconds: number) => {
    const video = videoRef.current;
    if (!video || !Number.isFinite(seconds)) return;
    const target = Math.max(0, seconds);
    // mpegts.js owns its own seek path: writing the element directly would let
    // its seeking handler treat the jump as an unbuffered seek and flush MSE.
    if (mpegtsCoreRef.current?.seek?.(target)) return;
    try {
      video.currentTime = target;
    } catch {
      /* A mid-teardown element rejects the assignment; the next tick retries. */
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

  // Leaving the alignment (or the page) must not leave a trimmed rate behind.
  useEffect(() => {
    if (liveSyncHold) return;
    const video = videoRef.current;
    if (video && video.playbackRate !== 1) video.playbackRate = 1;
  }, [liveSyncHold, mediaKey]);

  const freezeFullscreenInsets = useCallback(() => {
    if (typeof document === "undefined") return;
    if (!shouldFreezeFullscreenInsets(getClientPlatform())) return;
    // A previous freeze can still be open if the user toggles twice in quick
    // succession. Release it first so only one is ever outstanding.
    releaseFullscreenInsets();
    const shell = document.querySelector<HTMLElement>(".app-shell");
    const root = document.documentElement;
    if (!shell || !root) return;
    // Pin the padding the shell already has rather than a guess, so the freeze
    // is a true hold: the layout must not move at the moment it is installed.
    const frozen = frozenSafeAreaTopValue(window.getComputedStyle(shell).paddingTop);
    if (!frozen) return;
    fullscreenInsetFreezeRef.current = beginFullscreenTransition(root, frozen);
    // Backstop for a WebView that resolves the request without ever firing
    // fullscreenchange, so a freeze can never outlive the interaction.
    fullscreenInsetFreezeTimerRef.current = window.setTimeout(
      releaseFullscreenInsets,
      FULLSCREEN_TRANSITION_TIMEOUT_MS,
    );
  }, [releaseFullscreenInsets]);

  // Nothing may outlive the player: a route change mid-transition would
  // otherwise leave the shell pinned to a stale padding.
  useEffect(() => releaseFullscreenInsets, [releaseFullscreenInsets]);

  useEffect(() => {
    if (!ownsFullscreen) {
      setMode("windowed");
      // Losing ownership mid-fullscreen (a secondary player taking over) drops
      // the in-page layer, so the bars it hid have to come back with it.
      if (inPageFullscreenRef.current) {
        inPageFullscreenRef.current = false;
        void setAndroidImmersive(false).catch(() => {});
      }
      return;
    }
    // Android Tauri and desktop Tauri both own `mode` themselves. Syncing from
    // the fullscreen element there would immediately force `windowed`, since
    // neither path ever produces one.
    if (isTauriDesktop() || runningOnAndroidTauri()) return;
    const syncMode = () => {
      const el = stageRef.current;
      const fs = fullscreenElementFor(getFullscreenDocument());
      setMode(fs && el && (fs === el || el.contains(fs)) ? "fullscreen" : "windowed");
    };
    const onFs = () => {
      syncMode();
      // The stage now owns the screen, so any further inset change reflows only
      // what it already covers. Ending the freeze here keeps it as short as the
      // transition itself instead of leaning on the timeout backstop.
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

  // Desktop Tauri drives fullscreen through the native window, so the OS (F11,
  // a window manager shortcut, or exiting via the title bar) can change it
  // without an HTML fullscreenchange event. Reconcile `mode` from the window's
  // own resize stream so the stage overlay and the control icon stay correct.
  useEffect(() => {
    // Secondary players share this window, so its fullscreen state says nothing
    // about them. Reading it here would mark all of them fullscreen at once.
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
            /* The window may be mid-teardown during a route change. */
          }
        };
        await sync();
        unlisten = await appWindow.onResized(() => void sync());
      } catch {
        // A browser preview without a native window keeps the HTML path above.
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
    // Nudge playback if the protocol plugin is up but playback stayed paused.
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

    // A request can resolve after a quality/line/room switch has replaced the
    // video node. Do not leave that detached source in a native PiP window.
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
   * Enters or leaves the in-page fullscreen layer used by Android Tauri.
   *
   * `mode` is the whole layout switch here — no browser fullscreen element is
   * involved — so it is set first and the native bars follow. A failed or
   * missing native command still leaves a working fullscreen (just with the
   * status bar visible), which is why the invoke never blocks the mode change.
   *
   * The bar animation still moves `env(safe-area-inset-top)` over several
   * frames, and `.app-shell` behind the layer consumes it as `padding-top`. The
   * stage is already `position: fixed` by then so the picture itself cannot
   * move, but the room chrome underneath would still reflow — visible around
   * the edges before the layer settles. Freezing the shell padding across the
   * transition holds it still; the timeout releases it, since no
   * `fullscreenchange` is coming on this path.
   */
  const setInPageFullscreen = useCallback(
    (next: boolean) => {
      if (next) freezeFullscreenInsets();
      else releaseFullscreenInsets();
      setMode(next ? "fullscreen" : "windowed");
      inPageFullscreenRef.current = next;
      void setAndroidImmersive(next).catch(() => {
        // An older APK without the command must not break fullscreen.
      });
    },
    [freezeFullscreenInsets, releaseFullscreenInsets],
  );

  const toggleFullscreen = useCallback(async () => {
    if (!ownsFullscreen) return;
    // Desktop Tauri uses a real OS-window fullscreen. This covers the taskbar
    // (unlike WebView2's HTML fullscreen from a maximized window) and drives
    // `mode` through the resulting resize; the stage then overlays the room
    // chrome as a fixed in-page layer (see the CSS rule for data-fullscreen).
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

    // Android Tauri reuses the same in-page layer. Requesting browser
    // fullscreen there makes Chromium reparent the rendered content into a new
    // View, and that surface handoff is the black flicker (see androidImmersive).
    if (runningOnAndroidTauri()) {
      setInPageFullscreen(mode !== "fullscreen");
      setFullscreenError(null);
      return;
    }

    const stage = stageRef.current;
    if (!stage) return;
    // Entering fullscreen moves the system-bar insets before `:fullscreen`
    // applies, which would reflow the still-windowed room for a few frames (see
    // fullscreenTransition). Freeze the shell padding across the request; the
    // fullscreenchange handler releases it once the stage owns the screen.
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
    // Desktop Tauri drives fullscreen through the native window, which has no
    // HTML fullscreen element to exit. Leave the OS window fullscreen and let
    // the resulting resize move `mode` back to windowed.
    if (isTauriDesktop()) {
      try {
        const appWindow = getCurrentWindow();
        if (await appWindow.isFullscreen()) {
          await setNativePlayerFullscreen(appWindow, false, nativeFullscreenSessionRef.current);
          setMode("windowed");
        }
      } catch {
        /* A missing native window action must not trap the user. */
      }
      return;
    }
    // Android's in-page layer is page state, so leaving it is a mode change
    // plus restoring the system bars. Driven off the ref rather than `mode` so
    // this callback keeps a stable identity for its many consumers.
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
   * The immersive bars belong to the fullscreen player, not to the Activity.
   *
   * Leaving the room straight from fullscreen (Back on the room, a route
   * change, a room switch) unmounts this hook without any exit call, so restore
   * the bars here or the next page would be laid out under hidden ones.
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
