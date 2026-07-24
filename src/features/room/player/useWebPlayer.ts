import { useCallback, useEffect, useRef, useState } from "react";
import { invokeCmd } from "@/shared/api/tauri";
import type { PlayUrl } from "@/shared/types/live";
import type { PlayerEvent, PlayerUiMode } from "@/shared/types/player";
import type { AppError } from "@/shared/types/error";
import type { MpegtsStatic, Player as MpegtsPlayer } from "@/vendor/mpegts";

/** Load vendored UMD from /mpegts.js (public/) — no npm github deps on Windows. */
async function loadMpegts(): Promise<MpegtsStatic> {
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => window.setTimeout(r, ms));
}

function nextFrame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

export type WebPlayerApi = {
  mode: PlayerUiMode;
  paused: boolean;
  volume: number;
  muted: boolean;
  running: boolean;
  loadError: string | null;
  setLoadError: (msg: string | null) => void;
  /** Bump forces a brand-new <video> node (clears stuck MediaSource). */
  mediaKey: number;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  stageRef: React.RefObject<HTMLDivElement | null>;
  togglePause: () => void;
  changeVolume: (v: number) => void;
  toggleMute: () => void;
  toggleFullscreen: () => Promise<void>;
};

function isHls(url: string): boolean {
  return /\.m3u8(?:[?#]|$)/i.test(url) || /[/?&=_-]hls(?:[/?&=_-]|$)/i.test(url);
}

function mediaType(url: string): string {
  return isHls(url) ? "mse" : "flv";
}

function playUrlKey(playUrl: PlayUrl | null): string {
  if (!playUrl) return "";
  // Include a stable header fingerprint so cookie/referer changes also reload.
  const headerKey = Object.entries(playUrl.headers ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  return `${playUrl.url}::${headerKey}`;
}

/**
 * DOM/MSE live player (no mpv). Streams via localhost proxy so CDN headers work.
 *
 * Re-entry fix: each open bumps `mediaKey` (new <video>), stops proxy, waits a
 * tick, then starts a fresh proxy URL with cache-bust. Avoids black screen from
 * reused MediaSource / expired CDN URL / half-destroyed mpegts instance.
 */
export function useWebPlayer(opts: {
  playUrl: PlayUrl | null;
  reloadToken?: number;
  onMediaFailure?: (event: PlayerEvent) => void;
  onPlaying?: () => void;
}): WebPlayerApi {
  const { playUrl, reloadToken = 0, onMediaFailure, onPlaying } = opts;
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<MpegtsPlayer | null>(null);
  const genRef = useRef(0);
  const volumeRef = useRef(80);
  const mutedRef = useRef(false);

  const [mode, setMode] = useState<PlayerUiMode>("windowed");
  const [paused, setPaused] = useState(false);
  const [volume, setVolume] = useState(80);
  const [muted, setMuted] = useState(false);
  const [prevVolume, setPrevVolume] = useState(80);
  const [running, setRunning] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mediaKey, setMediaKey] = useState(0);

  volumeRef.current = volume;
  mutedRef.current = muted;

  const onMediaFailureRef = useRef(onMediaFailure);
  const onPlayingRef = useRef(onPlaying);
  onMediaFailureRef.current = onMediaFailure;
  onPlayingRef.current = onPlaying;

  const destroyPlayer = useCallback(() => {
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
    const video = videoRef.current;
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

  const streamKey = playUrlKey(playUrl);

  // Open / replace stream whenever the logical stream identity changes.
  useEffect(() => {
    let cancelled = false;
    const gen = ++genRef.current;

    const stopProxy = async () => {
      try {
        await invokeCmd("stream_proxy_stop");
      } catch {
        /* ignore */
      }
    };

    if (!playUrl || !streamKey) {
      destroyPlayer();
      void stopProxy();
      setLoadError(null);
      return () => {
        cancelled = true;
        destroyPlayer();
        void stopProxy();
      };
    }

    setLoadError(null);
    setPaused(false);
    // Fresh volume defaults on each room open (avoid sticky mute from autoplay).
    setMuted(false);
    mutedRef.current = false;

    void (async () => {
      try {
        // 1) Tear down previous MSE + proxy completely.
        destroyPlayer();
        await stopProxy();
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
          url: playUrl.url,
          headers: playUrl.headers,
        });
        if (cancelled || genRef.current !== gen) {
          await stopProxy();
          return;
        }
        const playLocal = `${localUrl}${localUrl.includes("?") ? "&" : "?"}t=${Date.now()}_${gen}`;

        const mpegts = await loadMpegts();
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

        // Hard-reset the element before attach.
        video.pause();
        video.removeAttribute("src");
        video.srcObject = null;
        video.load();

        const player = mpegts.createPlayer(
          {
            type: mediaType(playUrl.url),
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

        player.attachMediaElement(video);
        player.load();

        player.on(mpegts.Events.ERROR, (...args: unknown[]) => {
          if (cancelled || genRef.current !== gen) return;
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

        // Apply current transport prefs (unmuted after room re-entry).
        video.volume = Math.max(0, Math.min(1, volumeRef.current / 100));
        video.muted = mutedRef.current;

        // User navigated into the room — treat as gesture-friendly autoplay.
        try {
          await player.play();
        } catch {
          // Last resort: brief muted start then unmute (WebView2 policy).
          video.muted = true;
          try {
            await player.play();
            await sleep(80);
            if (!cancelled && genRef.current === gen) {
              video.muted = false;
              mutedRef.current = false;
              setMuted(false);
            }
          } catch {
            /* play() may still reject; error event will surface */
          }
        }

        if (cancelled || genRef.current !== gen) {
          try {
            player.destroy();
          } catch {
            /* ignore */
          }
          await stopProxy();
          return;
        }

        playerRef.current = player;

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
    })();

    return () => {
      cancelled = true;
      destroyPlayer();
      void stopProxy();
    };
  }, [streamKey, reloadToken, destroyPlayer, playUrl]);

  // Reflect transport controls onto the element.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.volume = Math.max(0, Math.min(1, volume / 100));
    video.muted = muted;
  }, [volume, muted, mediaKey]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
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
    const onEnded = () => {
      onMediaFailureRef.current?.({
        epoch: genRef.current,
        generation: genRef.current,
        kind: "eof",
        message: "stream ended",
      });
    };
    video.addEventListener("play", onPlay);
    video.addEventListener("playing", onPlaying);
    video.addEventListener("pause", onPause);
    video.addEventListener("ended", onEnded);
    return () => {
      video.removeEventListener("play", onPlay);
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("ended", onEnded);
    };
  }, [mediaKey, streamKey]);

  useEffect(() => {
    const onFs = () => {
      const el = stageRef.current;
      const fs = document.fullscreenElement;
      setMode(fs && el && (fs === el || el.contains(fs)) ? "fullscreen" : "windowed");
    };
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
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

  const toggleFullscreen = useCallback(async () => {
    const stage = stageRef.current;
    if (!stage) return;
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await stage.requestFullscreen();
      }
    } catch (e) {
      const msg =
        typeof e === "object" && e && "message" in e
          ? String((e as { message: string }).message)
          : String(e);
      setLoadError(msg || "全屏切换失败");
    }
  }, []);

  useEffect(() => {
    if (mode !== "fullscreen") return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape" && document.fullscreenElement) {
        void document.exitFullscreen().catch(() => {});
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
    loadError,
    setLoadError,
    mediaKey,
    videoRef,
    stageRef,
    togglePause,
    changeVolume,
    toggleMute,
    toggleFullscreen,
  };
}
