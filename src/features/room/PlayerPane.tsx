import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { PlayUrl } from "../../shared/types/live";
import { ErrorState } from "../../shared/components/ErrorState";
import { invokeCmd } from "../../shared/api/tauri";
import { DanmakuLayer } from "./DanmakuLayer";

type PlayerPaneProps = {
  playUrl: PlayUrl | null;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  title?: string;
  /** Show flying danmaku overlay (frontend layer). */
  danmakuActive?: boolean;
};

type PlayerStatus = {
  running: boolean;
  mpv_path: string;
  paused: boolean;
  volume: number;
  embed: boolean;
};

type Bounds = { x: number; y: number; width: number; height: number };

async function measureHostBounds(el: HTMLElement): Promise<Bounds | null> {
  try {
    const win = getCurrentWindow();
    const factor = await win.scaleFactor();
    const pos = await win.innerPosition();
    const rect = el.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) return null;
    return {
      x: Math.round(pos.x + rect.left * factor),
      y: Math.round(pos.y + rect.top * factor),
      width: Math.max(16, Math.round(rect.width * factor)),
      height: Math.max(16, Math.round(rect.height * factor)),
    };
  } catch {
    // Outside Tauri / no window API.
    return null;
  }
}

/** Embedded mpv host + controls + danmaku overlay. */
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
    const bounds = await measureHostBounds(el);
    if (!bounds) return;
    try {
      await invokeCmd("player_set_bounds", { bounds });
    } catch {
      /* player may not be running yet */
    }
  }, []);

  // Open / stop player when URL changes.
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
          ? await measureHostBounds(hostRef.current)
          : null;
        await invokeCmd("player_open", {
          url: playUrl.url,
          headers: playUrl.headers,
          title: title ?? null,
          bounds,
          embed: true,
        });
        if (!cancelled) {
          await refreshStatus();
          // Re-sync bounds after window maps.
          window.setTimeout(() => {
            void pushBounds();
          }, 200);
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

  // Keep embed rect synced with layout / window move.
  useEffect(() => {
    if (!playUrl) return;
    const el = hostRef.current;
    if (!el) return;

    const ro = new ResizeObserver(() => {
      void pushBounds();
    });
    ro.observe(el);

    const onScroll = () => void pushBounds();
    const onResize = () => void pushBounds();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);

    // Also poll lightly — window drag may not fire resize.
    const timer = window.setInterval(() => void pushBounds(), 500);

    return () => {
      ro.disconnect();
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
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
      <div
        ref={hostRef}
        className="relative flex aspect-video w-full flex-col overflow-hidden rounded-lg border border-zinc-200 bg-black dark:border-zinc-700"
      >
        {loading && (
          <div className="flex flex-1 items-center justify-center text-sm text-zinc-400">
            Resolving play URL…
          </div>
        )}

        {!loading && displayError != null && (
          <div className="flex flex-1 items-center justify-center p-4">
            <ErrorState
              error={displayError}
              title="Playback unavailable"
              onRetry={onRetry}
            />
          </div>
        )}

        {!loading && displayError == null && !playUrl && (
          <div className="flex flex-1 items-center justify-center text-sm text-zinc-500">
            No stream selected
          </div>
        )}

        {showHost && (
          <>
            {/* Transparent host: native mpv window sits on top via geometry embed */}
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <p className="text-xs text-zinc-600">
                {status?.running ? "Playing (embedded mpv)" : "Starting mpv…"}
              </p>
            </div>
            <DanmakuLayer active={danmakuActive && danmakuOn} mode="both" />
          </>
        )}
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
            Danmaku
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
