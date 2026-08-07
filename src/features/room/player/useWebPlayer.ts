import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invokeCmd } from "@/shared/api/tauri";
import { getClientPlatform } from "@/shared/clientPlatform";
import type { PlayUrl, SiteId } from "@/shared/types/live";
import type { PlayerEvent, PlayerUiMode, StreamProxyTelemetry } from "@/shared/types/player";
import type { AppError } from "@/shared/types/error";
import { playbackProtocol, playbackSourceId } from "@/lib/playUrl";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import { videoAspectRatio } from "./androidOrientation";
import { requestPlayerAutoplay } from "./autoplay";
import { createSerialTaskQueue } from "./serialTaskQueue";
import {
  createXgPlayer,
  getXgHlsCore,
  getXgMpegtsCore,
  isXgPlayerDecodeError,
  loadXgPlayerModules,
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

export type WebPlayerApi = {
  mode: PlayerUiMode;
  paused: boolean;
  volume: number;
  muted: boolean;
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
  changeVolume: (v: number) => void;
  toggleMute: () => void;
  togglePictureInPicture: () => Promise<void>;
  toggleFullscreen: () => Promise<void>;
};

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

export const PLAYBACK_STALL_SWITCH_DELAY_MS = 8_000;
const PLAYBACK_STALL_PROGRESS_EPSILON_SECONDS = 0.25;

export function shouldReportPlaybackStall(
  video: Pick<HTMLMediaElement, "currentTime" | "ended" | "paused">,
  stalledAtSeconds: number,
): boolean {
  if (video.paused || video.ended) return false;
  const progress = video.currentTime - stalledAtSeconds;
  return !Number.isFinite(progress) || progress < PLAYBACK_STALL_PROGRESS_EPSILON_SECONDS;
}

const TWITCH_COMMERCIAL_RETRY_DELAY_MS = 8_000;

export type HlsFatalRecoveryAction =
  | { type: "restart" }
  | { type: "refresh_play_url"; retryAfterMs: number };

/**
 * hls.js has already attempted its built-in recovery before the player error
 * reaches this boundary. Retry once, then ask Twitch for a fresh signed URL
 * instead of repeatedly loading an expired URL forever.
 */
export function nextHlsFatalRecoveryAction(
  failureCount: number,
  commercialBreak = false,
  authorizationFailed = false,
): HlsFatalRecoveryAction {
  // A 401/403 on a Twitch media playlist is normally a short-lived signed
  // URL expiring. Replaying against the same URL only repeats the failure.
  if (authorizationFailed && !commercialBreak) {
    return { type: "refresh_play_url", retryAfterMs: 0 };
  }
  if (failureCount <= 1) return { type: "restart" };
  return {
    type: "refresh_play_url",
    retryAfterMs: commercialBreak ? TWITCH_COMMERCIAL_RETRY_DELAY_MS : 0,
  };
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
    Object.entries(playUrl.headers ?? {}).sort(([a], [b]) => a.localeCompare(b)),
    playUrl.source_id ?? null,
    playUrl.label ?? null,
    playUrl.protocol ?? null,
    playUrl.priority ?? null,
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
 */
export function liveFlvPlaybackOptions(mobileClient: boolean): Record<string, unknown> {
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
      liveBufferLatencyMaxLatency: mobileClient ? 6 : 5,
      liveBufferLatencyMinRemain: mobileClient ? 1.5 : 1,
      autoCleanupSourceBuffer: true,
      autoCleanupMaxBackwardDuration: mobileClient ? 20 : 15,
      autoCleanupMinBackwardDuration: mobileClient ? 10 : 8,
    },
  };
}

/** FLV CDNs do not guarantee timestamp continuity across lines or reconnects. */
export function shouldUsePlaybackSoftSwitch(
  configured: boolean,
  playbackKind: XgPlaybackKind | null,
): boolean {
  return configured && playbackKind != null && playbackKind !== "flv";
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
    return {
      url: parsed[0],
      headers: Object.fromEntries(entries),
      source_id: typeof parsed[2] === "string" ? parsed[2] : undefined,
      label: typeof parsed[3] === "string" ? parsed[3] : undefined,
      protocol:
        parsed[4] === "flv" ||
        parsed[4] === "hls" ||
        parsed[4] === "mpeg_ts" ||
        parsed[4] === "native" ||
        parsed[4] === "unknown"
          ? parsed[4]
          : undefined,
      priority: typeof parsed[5] === "number" && Number.isFinite(parsed[5]) ? parsed[5] : undefined,
    };
  } catch {
    return null;
  }
}

// The native proxy has one process-global active listener. Queue the complete
// teardown/start sequence so an async cleanup from room A cannot stop the
// listener room B has just opened.
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
export function useWebPlayer(opts: {
  playUrl: PlayUrl | null;
  siteId?: SiteId;
  quality?: string | null;
  /** Rebuild even when two rooms happen to resolve to the same stream URL. */
  sessionKey?: string;
  reloadToken?: number;
  onMediaFailure?: (event: PlayerEvent) => void;
  onPlaying?: () => void;
}): WebPlayerApi {
  const {
    playUrl,
    siteId,
    quality = null,
    sessionKey = "",
    reloadToken = 0,
    onMediaFailure,
    onPlaying,
  } = opts;
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
  const volumeRef = useRef(80);
  const mutedRef = useRef(false);
  const activeProxySessionIdRef = useRef<string | null>(null);
  const activeSourceKeyRef = useRef("");
  const activePlaybackKindRef = useRef<XgPlaybackKind | null>(null);
  const telemetrySessionRef = useRef<PlaybackTelemetrySession | null>(null);
  const softSwitchSequenceRef = useRef(0);
  const qualityRef = useRef<string | null>(quality);

  const [mode, setMode] = useState<PlayerUiMode>("windowed");
  const [paused, setPaused] = useState(false);
  const [volume, setVolume] = useState(80);
  const [muted, setMuted] = useState(false);
  const [prevVolume, setPrevVolume] = useState(80);
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

  volumeRef.current = volume;
  mutedRef.current = muted;
  qualityRef.current = quality;

  const onMediaFailureRef = useRef(onMediaFailure);
  const onPlayingRef = useRef(onPlaying);
  onMediaFailureRef.current = onMediaFailure;
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
    telemetrySessionRef.current = null;
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
  }
  // During a quality query the controller can briefly have no URL. Keep the
  // active source alive so soft switching does not introduce a black frame
  // while the replacement metadata is loading.
  const effectivePlaybackSource =
    playbackSource ?? retainedPlaybackSourceRef.current?.source ?? null;
  const effectivePlaybackSourceKey =
    playbackSourceKey || retainedPlaybackSourceRef.current?.sourceKey || "";
  const effectivePlaybackKind = effectivePlaybackSource
    ? webPlaybackKind(effectivePlaybackSource)
    : null;
  const softSwitchEnabled = shouldUsePlaybackSoftSwitch(
    softSwitchConfigured,
    effectivePlaybackKind,
  );
  const effectivePlaybackSourceRef = useRef<PlayUrl | null>(effectivePlaybackSource);
  effectivePlaybackSourceRef.current = effectivePlaybackSource;
  const hardStreamKey = softSwitchEnabled
    ? `${sessionKey}::${effectivePlaybackKind ?? "none"}::${softFallbackToken}`
    : `${streamKey}::${softFallbackToken}`;

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
    // Fresh volume defaults on each room open (avoid sticky mute from autoplay).
    setMuted(false);
    mutedRef.current = false;

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
          telemetrySessionRef.current = createPlaybackTelemetrySession({
            sessionId: proxySessionId,
            siteId: siteId ?? null,
            sourceId: playbackSourceId(selectedSource, 0),
            protocol: playbackProtocol(selectedSource),
            quality: qualityRef.current,
            switchMode: "hard",
          });

          // 3) Fresh proxy (new port) + cache-bust query so the browser never
          // reuses a closed keep-alive to the previous listener.
          const localUrl = await invokeCmd<string>("stream_proxy_start", {
            url: selectedSource.url,
            headers: selectedSource.headers,
            sessionId: proxySessionId,
            // Twitch and other HLS sites need the proxy to rewrite child
            // playlists, keys and segments to the same local session.
            hls: hlsSource,
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
          video.volume = Math.max(0, Math.min(1, volumeRef.current / 100));
          video.muted = mutedRef.current;

          const recoverMutedAutoplay = () => {
            mutedRef.current = false;
            setMuted(false);
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
              hlsOpts: {
                lowLatencyMode: false,
                backBufferLength: 30,
                maxBufferLength: 30,
                liveSyncDurationCount: 3,
                liveMaxLatencyDurationCount: 6,
                manifestLoadingMaxRetry: 3,
                levelLoadingMaxRetry: 3,
                fragLoadingMaxRetry: 3,
              },
            },
            flv: liveFlvPlaybackOptions(mobileClient),
            mpegts: {
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
                liveBufferLatencyChasing: true,
                liveBufferLatencyMaxLatency: 3,
                liveBufferLatencyMinRemain: 0.5,
                autoCleanupSourceBuffer: true,
              },
            },
          });

          // Register ownership before autoplay: play() can remain pending until
          // the first live segment, while route cleanup must stay immediate.
          playerRef.current = player;
          activeSourceKeyRef.current = sourceKey;
          setActiveSourceKey(sourceKey);
          activePlaybackKindRef.current = playbackKind;
          const isCurrentPlayer = () =>
            !cancelled && genRef.current === gen && playerRef.current === player;
          const hlsCore = playbackKind === "hls" ? getXgHlsCore(player) : null;
          const mpegtsCore =
            playbackKind === "flv" || playbackKind === "mpegts" ? getXgMpegtsCore(player) : null;

          if (mpegtsCore) {
            mpegtsCore.on("loading_complete", () => {
              if (!isCurrentPlayer()) return;
              setLoadError(null);
              setRunning(false);
              onMediaFailureRef.current?.({
                epoch: gen,
                generation: gen,
                kind: "eof",
                message: "直播流已结束",
                refreshPlayUrl: playbackKind === "flv",
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
              });
            };
            player.on("error", reportPlayerError);
            if (playbackKind === "flv" || playbackKind === "mpegts") {
              player.on("mpegts_error", reportPlayerError);
            }
          }

          if (hlsCore && siteId !== "twitch") {
            let hlsFatalFailureCount = 0;
            player.on("playing", () => {
              if (isCurrentPlayer()) hlsFatalFailureCount = 0;
            });
            const reportHlsFailure = (cause: unknown, refreshPlayUrl = false) => {
              if (!isCurrentPlayer()) return;
              const message = xgPlayerErrorMessage(cause, "HLS 连接中断");
              setRunning(false);
              if (refreshPlayUrl) {
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
                refreshPlayUrl,
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
              if (++hlsFatalFailureCount <= 1) {
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
                ? "Twitch 正在播放广告，广告结束后将自动恢复"
                : `${errorMessage}，正在更新播放地址…`;
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
                refreshPlayUrl: true,
                retryAfterMs: action.retryAfterMs,
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
  }, [hardStreamKey, reloadToken, destroyPlayer, mobileClient, siteId]);

  // Same-protocol source changes can retain the media element and MSE state.
  // Live CDN timestamp continuity is not uniform, so any setup/switch failure
  // increments the hard key and rebuilds cleanly.
  useEffect(() => {
    if (!effectivePlaybackSource) return;
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

        const localUrl = await invokeCmd<string>("stream_proxy_start", {
          url: targetSource.url,
          headers: targetSource.headers,
          sessionId: proxySessionId,
          hls: targetKind === "hls",
        });
        if (
          cancelled ||
          sequence !== softSwitchSequenceRef.current ||
          playerRef.current !== player
        ) {
          return;
        }
        const localSource = `${localUrl}${localUrl.includes("?") ? "&" : "?"}switch=${Date.now()}_${sequence}`;
        telemetrySessionRef.current = createPlaybackTelemetrySession({
          sessionId: `${proxySessionId}:soft:${sequence}`,
          siteId: siteId ?? null,
          sourceId: playbackSourceId(targetSource, 0),
          protocol: playbackProtocol(targetSource),
          quality: qualityRef.current,
          switchMode: "soft",
        });
        await Promise.resolve(player.switchURL?.(localSource, { seamless: true }));
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
        setLoadError(null);
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
    siteId,
    softSwitchEnabled,
  ]);

  // Reflect transport controls onto the element.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.volume = Math.max(0, Math.min(1, volume / 100));
    video.muted = muted;
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
    let stallTimer: number | null = null;
    let stalledAtSeconds = video.currentTime;

    const clearStallTimer = () => {
      if (stallTimer == null) return;
      window.clearTimeout(stallTimer);
      stallTimer = null;
    };
    const armStallTimer = () => {
      if (stallTimer != null || video.paused || video.ended) return;
      stalledAtSeconds = video.currentTime;
      stallTimer = window.setTimeout(() => {
        stallTimer = null;
        if (
          videoRef.current !== video ||
          genRef.current !== generation ||
          !shouldReportPlaybackStall(video, stalledAtSeconds)
        ) {
          return;
        }
        onMediaFailureRef.current?.({
          epoch: generation,
          generation,
          kind: "stall",
          message: "播放持续卡顿",
        });
      }, PLAYBACK_STALL_SWITCH_DELAY_MS);
    };

    const pictureInPictureDocument = getPictureInPictureDocument();
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
      setPaused(false);
    };
    const onPlaying = () => {
      clearStallTimer();
      const telemetry = telemetrySessionRef.current;
      if (telemetry) markTelemetryPlaying(telemetry, performance.now());
      setPaused(false);
      setRunning(true);
      setLoadError(null);
      onPlayingRef.current?.();
    };
    const onPause = () => {
      clearStallTimer();
      setPaused(true);
    };
    const onWaiting = () => {
      const telemetry = telemetrySessionRef.current;
      if (telemetry) markTelemetryWaiting(telemetry, performance.now());
      armStallTimer();
    };
    const onStalled = () => {
      const telemetry = telemetrySessionRef.current;
      if (telemetry) markTelemetryStalled(telemetry, performance.now());
      armStallTimer();
    };
    const onTimeUpdate = () => {
      if (stallTimer != null && !shouldReportPlaybackStall(video, stalledAtSeconds)) {
        clearStallTimer();
      }
    };
    // Android fullscreen auto-rotation is decided from the decoded frame size,
    // so the ratio has to follow both the first metadata and later resolution
    // switches an adaptive ladder makes mid-stream.
    const syncAspectRatio = () => {
      if (videoRef.current !== video) return;
      setAspectRatio(videoAspectRatio(video));
    };
    const onEnterPictureInPicture = () => syncPictureInPicture();
    const onLeavePictureInPicture = () => syncPictureInPicture();
    const onEnded = () => {
      clearStallTimer();
      if (
        videoRef.current !== video ||
        genRef.current !== generation ||
        playerRef.current?.media !== video
      ) {
        return;
      }
      onMediaFailureRef.current?.({
        epoch: generation,
        generation,
        kind: "eof",
        message: "直播流已结束",
        refreshPlayUrl: playbackKind === "flv",
      });
    };
    syncPictureInPicture();
    syncAspectRatio();
    video.addEventListener("play", onPlay);
    video.addEventListener("playing", onPlaying);
    video.addEventListener("pause", onPause);
    video.addEventListener("waiting", onWaiting);
    video.addEventListener("stalled", onStalled);
    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("ended", onEnded);
    video.addEventListener("loadedmetadata", syncAspectRatio);
    video.addEventListener("resize", syncAspectRatio);
    video.addEventListener("enterpictureinpicture", onEnterPictureInPicture);
    video.addEventListener("leavepictureinpicture", onLeavePictureInPicture);
    return () => {
      clearStallTimer();
      video.removeEventListener("play", onPlay);
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("stalled", onStalled);
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("ended", onEnded);
      video.removeEventListener("loadedmetadata", syncAspectRatio);
      video.removeEventListener("resize", syncAspectRatio);
      video.removeEventListener("enterpictureinpicture", onEnterPictureInPicture);
      video.removeEventListener("leavepictureinpicture", onLeavePictureInPicture);
    };
  }, [effectivePlaybackKind, mediaKey, streamKey]);

  useEffect(() => {
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
  }, []);

  useEffect(() => {
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
  }, [hardStreamKey, mediaKey]);

  useEffect(() => {
    const onFs = () => {
      const el = stageRef.current;
      const fs = fullscreenElementFor(getFullscreenDocument());
      setMode(fs && el && (fs === el || el.contains(fs)) ? "fullscreen" : "windowed");
    };
    onFs();
    document.addEventListener("fullscreenchange", onFs);
    document.addEventListener("webkitfullscreenchange", onFs);
    return () => {
      document.removeEventListener("fullscreenchange", onFs);
      document.removeEventListener("webkitfullscreenchange", onFs);
    };
  }, []);

  // Desktop Tauri drives fullscreen through the native window, so the OS (F11,
  // a window manager shortcut, or exiting via the title bar) can change it
  // without an HTML fullscreenchange event. Reconcile `mode` from the window's
  // own resize stream so the stage overlay and the control icon stay correct.
  useEffect(() => {
    if (!isTauriDesktop()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        const appWindow = getCurrentWindow();
        const sync = async () => {
          try {
            const fullscreen = await appWindow.isFullscreen();
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
  }, []);

  const togglePause = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      void video.play().catch(() => {});
    } else {
      video.pause();
    }
  }, []);

  const changeVolume = useCallback((v: number) => {
    const vol = Math.max(0, Math.min(100, Math.round(v)));
    setVolume(vol);
    setMuted(vol === 0);
    // Nudge playback if the protocol plugin is up but playback stayed paused.
    const video = videoRef.current;
    if (video && video.paused && playerRef.current) {
      void video.play().catch(() => {});
    }
  }, []);

  const toggleMute = useCallback(() => {
    if (muted || volume === 0) {
      const restore = prevVolume || 80;
      setMuted(false);
      setVolume(restore);
    } else {
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

  const toggleFullscreen = useCallback(async () => {
    // Desktop Tauri uses a real OS-window fullscreen. This covers the taskbar
    // (unlike WebView2's HTML fullscreen from a maximized window) and drives
    // `mode` through the resulting resize; the stage then overlays the room
    // chrome as a fixed in-page layer (see the CSS rule for data-fullscreen).
    if (isTauriDesktop()) {
      try {
        const appWindow = getCurrentWindow();
        const next = !(await appWindow.isFullscreen());
        await appWindow.setFullscreen(next);
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

    const stage = stageRef.current;
    if (!stage) return;
    try {
      const toggled = await toggleElementFullscreen(getFullscreenDocument(), stage);
      if (!toggled) {
        setFullscreenError("当前设备不支持全屏播放");
        return;
      }
      setFullscreenError(null);
    } catch (e) {
      const msg =
        typeof e === "object" && e && "message" in e
          ? String((e as { message: string }).message)
          : String(e);
      setFullscreenError(msg || "全屏切换失败");
    }
  }, []);

  useEffect(() => {
    if (mode !== "fullscreen") return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      // Desktop Tauri drives fullscreen through the native window, which has no
      // HTML fullscreen element to exit. Leave the OS window fullscreen and let
      // the resulting resize move `mode` back to windowed.
      if (isTauriDesktop()) {
        void (async () => {
          try {
            const appWindow = getCurrentWindow();
            if (await appWindow.isFullscreen()) {
              await appWindow.setFullscreen(false);
              setMode("windowed");
            }
          } catch {
            /* A missing native window action must not trap the user. */
          }
        })();
        return;
      }
      if (fullscreenElementFor(getFullscreenDocument())) {
        const documentRef = getFullscreenDocument();
        const exit =
          documentRef?.exitFullscreen ??
          documentRef?.webkitExitFullscreen ??
          documentRef?.webkitCancelFullScreen;
        if (exit && documentRef) {
          void Promise.resolve(exit.call(documentRef)).catch(() => {});
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode]);

  return {
    mode,
    paused,
    volume,
    muted,
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
    changeVolume,
    toggleMute,
    togglePictureInPicture,
    toggleFullscreen,
  };
}
