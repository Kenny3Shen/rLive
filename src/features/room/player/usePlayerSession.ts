import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invokeCmd } from "@/shared/api/tauri";
import type { PlayUrl } from "@/shared/types/live";
import type {
  PlayerEvent,
  PlayerStatus,
  PlayerUiMode,
} from "@/shared/types/player";
import type { AppError } from "@/shared/types/error";
import {
  beginPlayer,
  isCurrentPlayer,
  stopPlayer,
  type PlayerEpoch,
} from "../playerLifecycle";
import type { OverlayBounds } from "../overlayLifecycle";

async function measureClientBounds(el: HTMLElement): Promise<OverlayBounds | null> {
  try {
    const win = getCurrentWindow();
    const factor = await win.scaleFactor();
    const rect = el.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) return null;
    return {
      x: Math.round(rect.left * factor),
      y: Math.round(rect.top * factor),
      width: Math.max(16, Math.round(rect.width * factor)),
      height: Math.max(16, Math.round(rect.height * factor)),
    };
  } catch {
    return null;
  }
}

export type UsePlayerSessionOpts = {
  playUrl: PlayUrl | null;
  title?: string;
  /** Bumps force a load of the same URL (failover retry). */
  reloadToken?: number;
  hostRef: React.RefObject<HTMLElement | null>;
  onMediaFailure?: (event: PlayerEvent) => void;
  onPlaying?: () => void;
};

export type PlayerSessionApi = {
  epoch: PlayerEpoch | null;
  status: PlayerStatus | null;
  mode: PlayerUiMode;
  paused: boolean;
  volume: number;
  muted: boolean;
  mpvError: unknown;
  loadError: string | null;
  setLoadError: (msg: string | null) => void;
  showHost: boolean;
  togglePause: () => Promise<void>;
  changeVolume: (v: number) => Promise<void>;
  toggleMute: () => Promise<void>;
  toggleFullscreen: () => Promise<void>;
  pushBounds: () => Promise<void>;
  refreshStatus: () => Promise<void>;
  measureHostBounds: () => Promise<OverlayBounds | null>;
};

export function usePlayerSession(opts: UsePlayerSessionOpts): PlayerSessionApi {
  const {
    playUrl,
    title,
    reloadToken = 0,
    hostRef,
    onMediaFailure,
    onPlaying,
  } = opts;

  const [status, setStatus] = useState<PlayerStatus | null>(null);
  const [paused, setPaused] = useState(false);
  const [volume, setVolume] = useState(80);
  const [muted, setMuted] = useState(false);
  const [prevVolume, setPrevVolume] = useState(80);
  const [mode, setMode] = useState<PlayerUiMode>("windowed");
  const [mpvError, setMpvError] = useState<unknown>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [epoch, setEpoch] = useState<PlayerEpoch | null>(null);

  const modeRef = useRef<PlayerUiMode>("windowed");
  const playerRequestRef = useRef(0);
  const playerEpochRef = useRef<PlayerEpoch | null>(null);
  const mountedRef = useRef(false);
  const playUrlRef = useRef(playUrl);
  const titleRef = useRef(title);
  const onMediaFailureRef = useRef(onMediaFailure);
  const onPlayingRef = useRef(onPlaying);

  playUrlRef.current = playUrl;
  titleRef.current = title;
  onMediaFailureRef.current = onMediaFailure;
  onPlayingRef.current = onPlaying;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  const refreshStatus = useCallback(async () => {
    try {
      const st = await invokeCmd<PlayerStatus>("player_status");
      setStatus(st);
      setPaused(st.paused);
      setVolume(st.volume);
      modeRef.current = st.mode;
      setMode(st.mode);
    } catch {
      /* ignore */
    }
  }, []);

  const measureHostBounds = useCallback(async () => {
    const el = hostRef.current;
    if (!el) return null;
    return measureClientBounds(el);
  }, [hostRef]);

  const pushBounds = useCallback(async () => {
    if (!mountedRef.current) return;
    const playerEpoch = playerEpochRef.current;
    if (playerEpoch == null || !isCurrentPlayer(playerEpoch)) return;
    const bounds = await measureHostBounds();
    if (!bounds || !isCurrentPlayer(playerEpoch)) return;
    try {
      await invokeCmd("player_set_bounds", { epoch: playerEpoch, bounds });
    } catch {
      /* not running */
    }
  }, [measureHostBounds]);

  // Open / replace media when playUrl or reloadToken changes.
  useEffect(() => {
    let cancelled = false;
    const requestId = ++playerRequestRef.current;
    let playerEpoch: PlayerEpoch | null = null;

    const releasePlayer = async (epoch = playerEpoch) => {
      // Prefer the local effect epoch, but fall back to the ref so a cleanup
      // that races beginPlayer still stops the session that owns the HWND.
      const target = epoch ?? playerEpochRef.current;
      if (target == null) return;
      if (playerEpochRef.current === target) {
        playerEpochRef.current = null;
        setEpoch(null);
      }
      await stopPlayer(target);
    };

    if (!playUrl) {
      void releasePlayer(playerEpochRef.current).catch(() => {});
      setMpvError(null);
      setStatus(null);
      setEpoch(null);
      return () => {
        cancelled = true;
        void releasePlayer(playerEpochRef.current).catch(() => {});
      };
    }

    setMpvError(null);
    setLoadError(null);
    modeRef.current = "windowed";
    setMode("windowed");

    void (async () => {
      try {
        playerEpoch = await beginPlayer();
        if (cancelled || playerRequestRef.current !== requestId) {
          await releasePlayer(playerEpoch);
          return;
        }
        playerEpochRef.current = playerEpoch;
        setEpoch(playerEpoch);

        // Never open libmpv without host bounds — that used to create a
        // detached force-window that survived leave-room as an extra HWND.
        let bounds = await measureHostBounds();
        for (let attempt = 0; attempt < 12 && !bounds; attempt += 1) {
          if (cancelled || playerRequestRef.current !== requestId) {
            await releasePlayer(playerEpoch);
            return;
          }
          await new Promise((r) => window.setTimeout(r, 50));
          bounds = await measureHostBounds();
        }
        if (!bounds) {
          throw {
            code: "player_missing_bounds",
            message: "视频区域尚未就绪，请重试",
            site: null,
            retryable: true,
          } satisfies AppError;
        }
        if (
          cancelled ||
          playerRequestRef.current !== requestId ||
          !isCurrentPlayer(playerEpoch)
        ) {
          await releasePlayer(playerEpoch);
          return;
        }
        await invokeCmd("player_open", {
          epoch: playerEpoch,
          url: playUrl.url,
          headers: playUrl.headers,
          title: title ?? null,
          bounds,
          preferChild: true,
        });
        if (
          cancelled ||
          playerRequestRef.current !== requestId ||
          !isCurrentPlayer(playerEpoch)
        ) {
          // Late open lost the race with leave-room — always stop this epoch.
          await releasePlayer(playerEpoch);
          return;
        }
        await refreshStatus();
        window.setTimeout(() => void pushBounds(), 120);
        window.setTimeout(() => void pushBounds(), 400);
      } catch (e) {
        if (!cancelled) setMpvError(e);
        // Open failed or was cancelled: never leave a half-started native session
        // (especially a force-window from an older build path).
        await releasePlayer(playerEpoch).catch(() => {});
      }
    })();

    return () => {
      cancelled = true;
      // Capture the epoch that this effect owns (or the ref if open is still
      // assigning). Leaving without stopPlayer is what keeps mpv on screen
      // after navigating away from the room.
      void releasePlayer(playerEpoch ?? playerEpochRef.current).catch(() => {});
    };
    // reloadToken intentionally included so failover retries re-open.
  }, [playUrl, title, reloadToken, measureHostBounds, refreshStatus, pushBounds]);

  // Keep embed geometry in sync.
  useEffect(() => {
    if (!playUrl) return;
    const el = hostRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => void pushBounds());
    ro.observe(el);
    const onWin = () => void pushBounds();
    window.addEventListener("resize", onWin);
    const timer = window.setInterval(() => void pushBounds(), 400);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", onWin);
      window.clearInterval(timer);
    };
  }, [playUrl, hostRef, pushBounds]);

  // Native media events → failover / playing.
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    void listen<PlayerEvent>("player_event", (event) => {
      const payload = event.payload;
      const epoch = playerEpochRef.current;
      if (epoch == null || payload.epoch !== epoch) return;
      if (!isCurrentPlayer(epoch)) return;
      if (payload.kind === "playing") {
        onPlayingRef.current?.();
        return;
      }
      if (payload.kind === "error" || payload.kind === "eof") {
        onMediaFailureRef.current?.(payload);
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  const togglePause = useCallback(async () => {
    const playerEpoch = playerEpochRef.current;
    if (playerEpoch == null || !isCurrentPlayer(playerEpoch)) return;
    const next = !paused;
    try {
      await invokeCmd("player_set_pause", { epoch: playerEpoch, paused: next });
      setPaused(next);
      await refreshStatus();
    } catch (e) {
      setMpvError(e);
    }
  }, [paused, refreshStatus]);

  const changeVolume = useCallback(async (v: number) => {
    const playerEpoch = playerEpochRef.current;
    if (playerEpoch == null || !isCurrentPlayer(playerEpoch)) return;
    const vol = Math.max(0, Math.min(100, Math.round(v)));
    setVolume(vol);
    setMuted(vol === 0);
    try {
      await invokeCmd("player_set_volume", { epoch: playerEpoch, volume: vol });
    } catch {
      /* ignore */
    }
  }, []);

  const toggleMute = useCallback(async () => {
    if (muted || volume === 0) {
      const restore = prevVolume || 80;
      setMuted(false);
      await changeVolume(restore);
    } else {
      setPrevVolume(volume);
      setMuted(true);
      await changeVolume(0);
    }
  }, [muted, volume, prevVolume, changeVolume]);

  const toggleFullscreen = useCallback(async () => {
    const current = playUrlRef.current;
    if (!current) return;
    const playerEpoch = playerEpochRef.current;
    if (playerEpoch == null || !isCurrentPlayer(playerEpoch)) return;
    const prior = modeRef.current;
    setLoadError(null);
    try {
      if (prior === "fullscreen") {
        const bounds = await measureHostBounds();
        await invokeCmd("player_exit_fullscreen", {
          epoch: playerEpoch,
          url: current.url,
          headers: current.headers,
          title: titleRef.current ?? null,
          bounds,
        });
        if (!mountedRef.current || !isCurrentPlayer(playerEpoch)) return;
        modeRef.current = "windowed";
        setMode("windowed");
        window.setTimeout(() => void pushBounds(), 120);
        window.setTimeout(() => void pushBounds(), 400);
      } else {
        await invokeCmd("player_enter_fullscreen", {
          epoch: playerEpoch,
          url: current.url,
          headers: current.headers,
          title: titleRef.current ?? null,
        });
        if (!mountedRef.current || !isCurrentPlayer(playerEpoch)) return;
        modeRef.current = "fullscreen";
        setMode("fullscreen");
      }
      await refreshStatus();
    } catch (e) {
      if (!mountedRef.current) return;
      modeRef.current = prior;
      setMode(prior);
      const msg =
        typeof e === "object" && e && "message" in e
          ? String((e as AppError).message)
          : String(e);
      setLoadError(msg || "全屏切换失败");
    }
  }, [measureHostBounds, pushBounds, refreshStatus]);

  // Esc exits fullscreen from main window.
  useEffect(() => {
    if (mode !== "fullscreen") return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        void toggleFullscreen();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, toggleFullscreen]);

  const showHost = !!playUrl && mpvError == null;

  return {
    epoch,
    status,
    mode,
    paused,
    volume,
    muted,
    mpvError,
    loadError,
    setLoadError,
    showHost,
    togglePause,
    changeVolume,
    toggleMute,
    toggleFullscreen,
    pushBounds,
    refreshStatus,
    measureHostBounds,
  };
}
