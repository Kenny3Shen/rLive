import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { PlayUrl } from "../../shared/types/live";
import { ErrorState } from "../../shared/components/ErrorState";
import { invokeCmd } from "../../shared/api/tauri";
import { DanmakuPanel } from "./DanmakuPanel";

type PlayerPaneProps = {
  playUrl: PlayUrl | null;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  title?: string;
  danmakuActive?: boolean;
};

type PlayerStatus = {
  running: boolean;
  mpv_path: string;
  paused: boolean;
  volume: number;
  embed_mode: "child" | "geometry" | "window";
};

/** Client-relative physical-pixel bounds for child HWND embed. */
type Bounds = { x: number; y: number; width: number; height: number };

async function measureClientBounds(el: HTMLElement): Promise<Bounds | null> {
  try {
    const win = getCurrentWindow();
    const factor = await win.scaleFactor();
    const rect = el.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) return null;
    // Child windows use client coordinates of the main HWND.
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

/**
 * Layout:
 *  ┌──────────────┬─────────┐
 *  │  video host  │ danmaku │
 *  │  (mpv wid)   │  panel  │
 *  └──────────────┴─────────┘
 *  │ controls               │
 */
export function PlayerPane({
  playUrl,
  loading,
  error,
  onRetry,
  title,
  danmakuActive = false,
}: PlayerPaneProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [mpvError, setMpvError] = useState<unknown>(null);
  const [status, setStatus] = useState<PlayerStatus | null>(null);
  const [paused, setPaused] = useState(false);
  const [volume, setVolume] = useState(80);
  const [danmakuOn, setDanmakuOn] = useState(true);
  const [osdOn, setOsdOn] = useState(true);

  const refreshStatus = useCallback(async () => {
    try {
      const st = await invokeCmd<PlayerStatus>("player_status");
      setStatus(st);
      setPaused(st.paused);
      setVolume(st.volume);
    } catch {
      /* ignore */
    }
  }, []);

  const pushBounds = useCallback(async () => {
    const el = hostRef.current;
    if (!el) return;
    const bounds = await measureClientBounds(el);
    if (!bounds) return;
    try {
      await invokeCmd("player_set_bounds", { bounds });
    } catch {
      /* not running */
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!playUrl) {
      void invokeCmd("player_stop").catch(() => {});
      setMpvError(null);
      setStatus(null);
      return;
    }

    setMpvError(null);
    void (async () => {
      try {
        const bounds = hostRef.current
          ? await measureClientBounds(hostRef.current)
          : null;
        await invokeCmd("player_open", {
          url: playUrl.url,
          headers: playUrl.headers,
          title: title ?? null,
          bounds,
          preferChild: true,
        });
        if (!cancelled) {
          await refreshStatus();
          window.setTimeout(() => void pushBounds(), 120);
          window.setTimeout(() => void pushBounds(), 400);
        }
      } catch (e) {
        if (!cancelled) setMpvError(e);
      }
    })();

    return () => {
      cancelled = true;
      void invokeCmd("player_stop").catch(() => {});
    };
  }, [playUrl?.url, title, refreshStatus, pushBounds]);

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
  }, [playUrl?.url, pushBounds]);

  async function togglePause() {
    const next = !paused;
    try {
      await invokeCmd("player_set_pause", { paused: next });
      setPaused(next);
      await refreshStatus();
    } catch (e) {
      setMpvError(e);
    }
  }

  async function changeVolume(v: number) {
    const vol = Math.max(0, Math.min(100, Math.round(v)));
    setVolume(vol);
    try {
      await invokeCmd("player_set_volume", { volume: vol });
    } catch {
      /* ignore */
    }
  }

  const displayError = error ?? mpvError;
  const showHost = !loading && displayError == null && !!playUrl;

  return (
    <div className="flex w-full flex-col gap-2">
      <div className="flex min-h-[280px] w-full gap-2 lg:min-h-[360px]">
        {/* Video host — native mpv child window sits here via --wid */}
        <div
          ref={hostRef}
          className="relative min-w-0 flex-1 overflow-hidden rounded-lg border border-zinc-200 bg-black dark:border-zinc-700"
        >
          {loading && (
            <div className="flex h-full min-h-[240px] items-center justify-center text-sm text-zinc-400">
              Resolving play URL…
            </div>
          )}
          {!loading && displayError != null && (
            <div className="flex h-full min-h-[240px] items-center justify-center p-4">
              <ErrorState
                error={displayError}
                title="Playback unavailable"
                onRetry={onRetry}
              />
            </div>
          )}
          {!loading && displayError == null && !playUrl && (
            <div className="flex h-full min-h-[240px] items-center justify-center text-sm text-zinc-500">
              No stream selected
            </div>
          )}
          {showHost && (
            <div className="pointer-events-none absolute inset-0 flex items-end justify-start p-2">
              <span className="rounded bg-black/50 px-1.5 py-0.5 text-[10px] text-zinc-300">
                {status?.embed_mode === "child"
                  ? "embedded (wid)"
                  : status?.embed_mode === "geometry"
                    ? "embedded (geometry)"
                    : status?.running
                      ? "mpv"
                      : "starting…"}
              </span>
            </div>
          )}
        </div>

        {/* Right danmaku column */}
        <div className="hidden w-[280px] shrink-0 sm:block md:w-[320px]">
          <DanmakuPanel active={danmakuActive && danmakuOn} osd={osdOn && !!playUrl} />
        </div>
      </div>

      {/* Mobile: danmaku below video */}
      <div className="h-48 sm:hidden">
        <DanmakuPanel active={danmakuActive && danmakuOn} osd={false} />
      </div>

      {showHost && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900/60">
          <button
            type="button"
            onClick={() => void togglePause()}
            className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
          >
            {paused ? "Play" : "Pause"}
          </button>

          <label className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-300">
            <span className="w-12">Vol {volume}</span>
            <input
              type="range"
              min={0}
              max={100}
              value={volume}
              onChange={(e) => void changeVolume(Number(e.target.value))}
              className="w-32 accent-zinc-900 dark:accent-zinc-100"
            />
          </label>

          <label className="flex items-center gap-1.5 text-sm text-zinc-600 dark:text-zinc-300">
            <input
              type="checkbox"
              checked={danmakuOn}
              onChange={(e) => setDanmakuOn(e.target.checked)}
            />
            弹幕栏
          </label>

          <label className="flex items-center gap-1.5 text-sm text-zinc-600 dark:text-zinc-300">
            <input
              type="checkbox"
              checked={osdOn}
              onChange={(e) => setOsdOn(e.target.checked)}
            />
            画面弹幕
          </label>

          {title && (
            <span className="ml-auto max-w-[40%] truncate text-xs text-zinc-500">
              {title}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
