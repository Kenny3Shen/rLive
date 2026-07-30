import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type Hls from "hls.js";
import { invokeCmd } from "@/shared/api/tauri";
import type { PlayUrl, SiteId } from "@/shared/types/live";
import type { PlayerEvent, PlayerUiMode } from "@/shared/types/player";
import type { AppError } from "@/shared/types/error";
import type { MpegtsStatic, Player as MpegtsPlayer } from "@/vendor/mpegts";
import { createSerialTaskQueue } from "./serialTaskQueue";

/** Load vendored UMD from /mpegts.js (public/) — no npm github deps on Windows. */
export async function loadMpegts(): Promise<MpegtsStatic> {
  const w = window as unknown as { mpegts?: MpegtsStatic };
  if (w.mpegts?.createPlayer) return w.mpegts;
  await new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>("script[data-rlive-mpegts]");
    if (existing) {
      if (w.mpegts?.createPlayer) {
        resolve();
        return;
      }
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("mpegts load failed")), {
        once: true,
      });
      return;
    }
    const s = document.createElement("script");
    s.src = "/mpegts.js";
    s.async = true;
    s.dataset.rliveMpegts = "1";
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("mpegts.js failed to load"));
    document.head.appendChild(s);
  });
  if (!w.mpegts?.createPlayer) {
    throw new Error("mpegts.js global not found after script load");
  }
  return w.mpegts;
}

type HlsConstructor = typeof Hls;

let hlsModulePromise: Promise<HlsConstructor> | null = null;

/**
 * hls.js is only useful for a manifest stream. Keeping it in a separate
 * chunk avoids parsing its transmuxer in the far more common FLV/MPEG-TS room
 * path, while caching the module means later HLS switches do not download it
 * again.
 */
export function loadHls(): Promise<HlsConstructor> {
  if (!hlsModulePromise) {
    hlsModulePromise = import("hls.js").then(({ default: HlsModule }) => HlsModule);
  }
  return hlsModulePromise;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => window.setTimeout(r, ms));
}

function nextFrame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

/**
 * Request autoplay without making the proxy lifecycle wait for the browser to
 * resolve it. `HTMLMediaElement.play()` can remain pending while a live MSE
 * stream is waiting for its first media segment. Awaiting that promise inside
 * the serialized proxy queue meant that a quick leave/re-enter could leave
 * the old proxy and MSE player ahead of every later room session.
 *
 * The caller must make the player reachable by its normal teardown before
 * invoking this helper. Every continuation is fenced by `isCurrent`, so an
 * old autoplay rejection can never mute or otherwise modify a newer session.
 */
export function requestPlayerAutoplay(
  player: Pick<MpegtsPlayer, "play">,
  video: Pick<HTMLVideoElement, "muted">,
  isCurrent: () => boolean,
  onMutedAutoplayRecovered: () => void,
): void {
  void (async () => {
    try {
      await player.play();
      return;
    } catch {
      // Some WebView2 configurations reject unmuted autoplay even though the
      // user just selected a room. Retry once muted, but never touch a player
      // that has been torn down or superseded in the meantime.
      if (!isCurrent()) return;
      video.muted = true;
      try {
        await player.play();
        await sleep(80);
        if (!isCurrent()) return;
        video.muted = false;
        onMutedAutoplayRecovered();
      } catch {
        // mpegts.js emits the actionable media error through its event API.
      }
    }
  })();
}

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

function getPictureInPictureDocument(): PictureInPictureDocument | null {
  return typeof document === "undefined" ? null : (document as PictureInPictureDocument);
}

async function exitPictureInPictureForVideo(
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

function getFullscreenDocument(): FullscreenDocument | null {
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
  videoRef: React.RefObject<HTMLVideoElement | null>;
  stageRef: React.RefObject<HTMLDivElement | null>;
  togglePause: () => void;
  changeVolume: (v: number) => void;
  toggleMute: () => void;
  togglePictureInPicture: () => Promise<void>;
  toggleFullscreen: () => Promise<void>;
};

/** Whether a live URL requires an HLS manifest player rather than mpegts.js. */
export function isHlsStream(url: string): boolean {
  return /\.m3u8(?:[?#]|$)/i.test(url) || /[/?&=_-]hls(?:[/?&=_-]|$)/i.test(url);
}

const TWITCH_COMMERCIAL_RETRY_DELAY_MS = 8_000;

export type HlsFatalRecoveryAction =
  | { type: "restart" }
  | { type: "refresh_play_url"; retryAfterMs: number };

/**
 * hls.js has already exhausted its own request policy before exposing a fatal
 * error. Retry the loaded playlist once, then ask Twitch for a fresh signed
 * playlist instead of repeatedly loading an expired URL forever.
 */
export function nextHlsFatalRecoveryAction(
  failureCount: number,
  commercialBreak = false,
  authorizationFailed = false,
): HlsFatalRecoveryAction {
  // A 401/403 on a Twitch media playlist is normally a short-lived signed
  // URL expiring. Restarting hls.js against the same URL only repeats it.
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
    reason?: unknown;
    error?: { message?: unknown };
    response?: { data?: unknown };
  };
  const candidates = [value.reason, value.error?.message, value.response?.data];
  return candidates.some(
    (candidate) =>
      typeof candidate === "string" && /commercial\s+break\s+in\s+progress/i.test(candidate),
  );
}

export function hlsResponseStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const code = (error as { response?: { code?: unknown } }).response?.code;
  return typeof code === "number" && Number.isFinite(code) ? code : null;
}

export function playUrlKey(playUrl: PlayUrl | null): string {
  if (!playUrl) return "";
  // Include a stable header fingerprint so cookie/referer changes also reload.
  // JSON keeps separators in URLs/header values unambiguous and can be
  // reconstructed into an immutable playback snapshot below.
  return JSON.stringify([
    playUrl.url,
    Object.entries(playUrl.headers ?? {}).sort(([a], [b]) => a.localeCompare(b)),
  ]);
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
    return { url: parsed[0], headers: Object.fromEntries(entries) };
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
 * reused MediaSource / expired CDN URL / half-destroyed mpegts instance.
 */
export function useWebPlayer(opts: {
  playUrl: PlayUrl | null;
  siteId?: SiteId;
  /** Rebuild even when two rooms happen to resolve to the same stream URL. */
  sessionKey?: string;
  reloadToken?: number;
  onMediaFailure?: (event: PlayerEvent) => void;
  onPlaying?: () => void;
}): WebPlayerApi {
  const { playUrl, siteId, sessionKey = "", reloadToken = 0, onMediaFailure, onPlaying } = opts;
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const playerRef = useRef<MpegtsPlayer | null>(null);
  const playerInstanceIdRef = useRef<string | null>(null);
  const genRef = useRef(0);
  const mediaLifecycleVersionRef = useRef(0);
  const volumeRef = useRef(80);
  const mutedRef = useRef(false);

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

  if (playerInstanceIdRef.current === null) {
    playerInstanceIdRef.current = createPlayerInstanceId();
  }

  volumeRef.current = volume;
  mutedRef.current = muted;

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
    setPictureInPictureSupported(false);

    const hls = hlsRef.current;
    hlsRef.current = null;
    if (hls) {
      try {
        hls.destroy();
      } catch {
        /* A partly initialized HLS instance is still safe to discard. */
      }
    }

    const p = playerRef.current;
    playerRef.current = null;
    if (p) {
      try {
        p.pause();
      } catch {
        /* ignore */
      }
      try {
        p.unload();
      } catch {
        /* ignore */
      }
      try {
        p.detachMediaElement();
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

  // Open / replace stream whenever the logical stream identity changes.
  useEffect(() => {
    let cancelled = false;
    const gen = ++genRef.current;
    const proxySessionId = `${playerInstanceIdRef.current}:${gen}`;

    const stopProxy = async () => {
      try {
        await invokeCmd("stream_proxy_stop", { sessionId: proxySessionId });
      } catch {
        /* ignore */
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

    const hlsSource = isHlsStream(playbackSource.url);
    // Start fetching only the engine the selected transport needs while the
    // serialized proxy queue tears down the previous session. HLS uses a lazy
    // chunk; giving its manifest to mpegts.js would try to demux playlist
    // text, and loading hls.js for an FLV room needlessly delays first paint.
    const mpegtsPromise = hlsSource ? null : loadMpegts();
    const hlsPromise = hlsSource ? loadHls() : null;
    // If a fast room switch cancels the queued setup before it reaches the
    // await below, retain a rejection handler so the speculative preload never
    // becomes an unhandled promise rejection.
    void mpegtsPromise?.catch(() => {});
    void hlsPromise?.catch(() => {});

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

          // 3) Fresh proxy (new port) + cache-bust query so the browser never
          // reuses a closed keep-alive to the previous listener.
          const localUrl = await invokeCmd<string>("stream_proxy_start", {
            url: playbackSource.url,
            headers: playbackSource.headers,
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

          if (hlsSource) {
            let HlsModule: HlsConstructor | null = null;
            try {
              HlsModule = hlsPromise ? await hlsPromise : null;
            } catch {
              // Safari and other native-HLS environments can still play the
              // stream even if the optional JavaScript engine cannot load.
            }
            if (cancelled || genRef.current !== gen) {
              await stopProxy();
              return;
            }

            if (HlsModule?.isSupported()) {
              const hls = new HlsModule({
                enableWorker: true,
                lowLatencyMode: true,
                backBufferLength: 30,
              });
              hlsRef.current = hls;
              const isCurrentHls = () =>
                !cancelled && genRef.current === gen && hlsRef.current === hls;
              // hls.js has already applied its own request retry policy when
              // it reports a fatal error. Keep one in-place retry for a short
              // network hiccup, then renew Twitch's short-lived signed HLS URL
              // instead of retrying the same expired child playlist forever.
              let hlsFatalFailureCount = 0;

              hls.on(HlsModule.Events.MANIFEST_PARSED, () => {
                if (!isCurrentHls()) return;
                requestPlayerAutoplay(
                  { play: () => video.play() },
                  video,
                  isCurrentHls,
                  recoverMutedAutoplay,
                );
              });
              hls.on(HlsModule.Events.FRAG_BUFFERED, () => {
                if (isCurrentHls()) hlsFatalFailureCount = 0;
              });
              hls.on(HlsModule.Events.ERROR, (_event, data) => {
                if (!isCurrentHls() || !data.fatal) return;

                if (siteId === "twitch") {
                  const commercialBreak = isTwitchCommercialBreak(data);
                  const responseStatus = hlsResponseStatus(data);
                  const action = nextHlsFatalRecoveryAction(
                    ++hlsFatalFailureCount,
                    commercialBreak,
                    responseStatus === 401 || responseStatus === 403,
                  );
                  if (action.type === "restart") {
                    if (data.type === HlsModule.ErrorTypes.MEDIA_ERROR) {
                      hls.recoverMediaError();
                    } else {
                      hls.startLoad();
                    }
                    return;
                  }

                  // A commercial break remains Twitch-delivered content. We
                  // only wait for the normal playlist transition and request a
                  // new token afterwards; no playlist or media segment is
                  // filtered, skipped, or replaced here.
                  const message = commercialBreak
                    ? "Twitch 正在播放广告，广告结束后将自动恢复"
                    : `Twitch HLS 连接中断（${data.details}），正在更新播放地址…`;
                  if (hlsRef.current === hls) hlsRef.current = null;
                  try {
                    hls.destroy();
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
                  return;
                }

                if (data.type === HlsModule.ErrorTypes.NETWORK_ERROR) {
                  hls.startLoad();
                  return;
                }
                if (data.type === HlsModule.ErrorTypes.MEDIA_ERROR) {
                  hls.recoverMediaError();
                  return;
                }
                const message = `HLS 播放失败：${data.details}`;
                setLoadError(message);
                setRunning(false);
                try {
                  hls.destroy();
                } catch {
                  /* A fatal HLS error can already have released internals. */
                }
                if (hlsRef.current === hls) hlsRef.current = null;
                onMediaFailureRef.current?.({
                  epoch: gen,
                  generation: gen,
                  kind: "error",
                  message,
                });
              });
              hls.loadSource(playLocal);
              hls.attachMedia(video);
              return;
            }

            if (video.canPlayType("application/vnd.apple.mpegurl")) {
              const isCurrentNativeHls = () => !cancelled && genRef.current === gen;
              video.src = playLocal;
              video.load();
              requestPlayerAutoplay(
                { play: () => video.play() },
                video,
                isCurrentNativeHls,
                recoverMutedAutoplay,
              );
              return;
            }

            if (!HlsModule) {
              throw {
                code: "web_player_hls_load",
                message: "HLS 播放器加载失败，请重试",
                site: null,
                retryable: true,
              } satisfies AppError;
            }

            throw {
              code: "web_player_no_hls",
              message: "当前环境不支持 HLS 直播播放",
              site: null,
              retryable: false,
            } satisfies AppError;
          }

          if (!mpegtsPromise) {
            throw {
              code: "web_player_no_mpegts",
              message: "MPEG-TS 播放器尚未准备好",
              site: null,
              retryable: true,
            } satisfies AppError;
          }
          const mpegts = await mpegtsPromise;
          if (cancelled || genRef.current !== gen) {
            await stopProxy();
            return;
          }

          if (!mpegts.getFeatureList().mseLivePlayback) {
            throw {
              code: "web_player_no_mse",
              message: "当前环境不支持 MSE 直播播放",
              site: null,
              retryable: false,
            } satisfies AppError;
          }

          const player = mpegts.createPlayer(
            {
              type: "flv",
              isLive: true,
              url: playLocal,
              hasAudio: true,
              hasVideo: true,
            },
            {
              enableWorker: false,
              enableStashBuffer: true,
              stashInitialSize: 384,
              liveBufferLatencyChasing: true,
              liveBufferLatencyMaxLatency: 2.5,
              liveBufferLatencyMinRemain: 0.4,
              autoCleanupSourceBuffer: true,
            } as Parameters<MpegtsStatic["createPlayer"]>[1],
          );

          // Register ownership before any MSE or autoplay work. In
          // particular, `player.play()` may remain pending indefinitely while
          // waiting for a live segment; route cleanup must still be able to
          // destroy this provisional player immediately.
          playerRef.current = player;
          const isCurrentPlayer = () =>
            !cancelled && genRef.current === gen && playerRef.current === player;

          player.on(mpegts.Events.ERROR, (...args: unknown[]) => {
            if (!isCurrentPlayer()) return;
            const [type, detail, info] = args;
            const message =
              (info && typeof info === "object" && info !== null && "msg" in info
                ? String((info as { msg?: string }).msg)
                : null) ||
              `${String(type ?? "")} ${String(detail ?? "")}`.trim() ||
              "播放失败";
            setLoadError(message);
            setRunning(false);
            onMediaFailureRef.current?.({
              epoch: gen,
              generation: gen,
              kind: "error",
              message,
            });
          });

          player.attachMediaElement(video);
          player.load();

          // Do not await this promise in `proxyLifecycleQueue`: it can stay
          // pending until the first live media segment arrives. The queue must
          // remain free so route cleanup can stop this proxy and a re-entered
          // room can start its replacement session right away.
          requestPlayerAutoplay(player, video, isCurrentPlayer, recoverMutedAutoplay);

          // If we already have frames, mark running; otherwise wait for play event.
          if (!video.paused && video.readyState >= 2) {
            setRunning(true);
            setLoadError(null);
            onPlayingRef.current?.();
          } else {
            // Give the demuxer a moment; spinner stays until 'playing'.
            window.setTimeout(() => {
              if (cancelled || genRef.current !== gen) return;
              if (playerRef.current === player && !video.paused) {
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
  }, [streamKey, reloadToken, destroyPlayer, playbackSource, siteId]);

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
      setPictureInPictureSupported(false);
      setPictureInPictureActive(false);
      return;
    }

    const pictureInPictureDocument = getPictureInPictureDocument();
    const syncPictureInPicture = () => {
      // A leave event from the <video> that was just replaced must never
      // overwrite the state of the new MediaSource node.
      if (videoRef.current !== video) return;
      setPictureInPictureSupported(canUsePictureInPicture(pictureInPictureDocument, video));
      setPictureInPictureActive(pictureInPictureDocument?.pictureInPictureElement === video);
    };

    const onPlay = () => {
      setPaused(false);
      setRunning(true);
      setLoadError(null);
      onPlayingRef.current?.();
    };
    const onPlaying = () => {
      setPaused(false);
      setRunning(true);
      setLoadError(null);
      onPlayingRef.current?.();
    };
    const onPause = () => setPaused(true);
    const onEnterPictureInPicture = () => syncPictureInPicture();
    const onLeavePictureInPicture = () => syncPictureInPicture();
    const onEnded = () => {
      onMediaFailureRef.current?.({
        epoch: genRef.current,
        generation: genRef.current,
        kind: "eof",
        message: "stream ended",
      });
    };
    syncPictureInPicture();
    video.addEventListener("play", onPlay);
    video.addEventListener("playing", onPlaying);
    video.addEventListener("pause", onPause);
    video.addEventListener("ended", onEnded);
    video.addEventListener("enterpictureinpicture", onEnterPictureInPicture);
    video.addEventListener("leavepictureinpicture", onLeavePictureInPicture);
    return () => {
      video.removeEventListener("play", onPlay);
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("ended", onEnded);
      video.removeEventListener("enterpictureinpicture", onEnterPictureInPicture);
      video.removeEventListener("leavepictureinpicture", onLeavePictureInPicture);
    };
  }, [mediaKey, streamKey]);

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
    // Nudge playback if demuxer is up but element stayed paused after re-entry.
    const video = videoRef.current;
    if (video && video.paused && (playerRef.current || hlsRef.current)) {
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
      if (ev.key === "Escape" && fullscreenElementFor(getFullscreenDocument())) {
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
    videoRef,
    stageRef,
    togglePause,
    changeVolume,
    toggleMute,
    togglePictureInPicture,
    toggleFullscreen,
  };
}
