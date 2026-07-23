import { useCallback, useEffect, useRef, useState } from "react";
import { listen, emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invokeCmd } from "@/shared/api/tauri";
import type { PlayerStatus } from "@/shared/types/player";
import type { AppError } from "@/shared/types/error";
import { CanvasDanmaku } from "./canvas/CanvasDanmaku";
import { PlayerControls } from "./PlayerControls";
import { cn } from "@/lib/utils";

export type OverlayInitPayload = {
  url: string;
  headers: Record<string, string>;
  title?: string | null;
  volume?: number;
  paused?: boolean;
  qualities?: { quality: string }[];
  qualityIndex?: number;
  lines?: { url: string }[];
  lineIndex?: number;
};

/**
 * Transparent always-on-top shell: canvas danmaku + auto-hiding controls.
 * Bootstrapped via `index.html?overlay=1`.
 */
export function FullscreenOverlayRoot() {
  const [init, setInit] = useState<OverlayInitPayload | null>(null);
  const [paused, setPaused] = useState(false);
  const [volume, setVolume] = useState(80);
  const [muted, setMuted] = useState(false);
  const [prevVolume, setPrevVolume] = useState(80);
  const [danmakuOn, setDanmakuOn] = useState(true);
  const [showChrome, setShowChrome] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const hideTimerRef = useRef<number | null>(null);

  useEffect(() => {
    document.documentElement.classList.add("dark");
    document.body.classList.add("bg-transparent", "overflow-hidden");
    return () => {
      document.body.classList.remove("bg-transparent", "overflow-hidden");
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void listen<OverlayInitPayload>("overlay-init", (e) => {
      if (cancelled) return;
      const p = e.payload;
      setInit(p);
      if (typeof p.volume === "number") setVolume(p.volume);
      if (typeof p.paused === "boolean") setPaused(p.paused);
    });
    // Ask main to re-send if we mounted late
    void emit("overlay-ready", {});
    return () => {
      cancelled = true;
    };
  }, []);

  const bumpChrome = useCallback(() => {
    setShowChrome(true);
    if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = window.setTimeout(() => setShowChrome(false), 3000);
  }, []);

  useEffect(() => {
    bumpChrome();
    const onMove = () => bumpChrome();
    window.addEventListener("mousemove", onMove);
    return () => {
      window.removeEventListener("mousemove", onMove);
      if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
    };
  }, [bumpChrome]);

  const exit = useCallback(async () => {
    if (!init) {
      try {
        await getCurrentWindow().close();
      } catch {
        /* ignore */
      }
      return;
    }
    setLoadError(null);
    try {
      await invokeCmd("player_exit_fullscreen", {
        url: init.url,
        headers: init.headers,
        title: init.title ?? null,
        bounds: null,
      });
      await invokeCmd("overlay_close").catch(() => {});
      try {
        await getCurrentWindow().close();
      } catch {
        /* closed by rust */
      }
    } catch (e) {
      const msg =
        typeof e === "object" && e && "message" in e
          ? String((e as AppError).message)
          : String(e);
      setLoadError(msg || "退出全屏失败");
    }
  }, [init]);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        void exit();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [exit]);

  async function togglePause() {
    const next = !paused;
    try {
      await invokeCmd("player_set_pause", { paused: next });
      setPaused(next);
    } catch {
      /* ignore */
    }
  }

  async function changeVolume(v: number) {
    const vol = Math.max(0, Math.min(100, Math.round(v)));
    setVolume(vol);
    setMuted(vol === 0);
    try {
      await invokeCmd("player_set_volume", { volume: vol });
    } catch {
      /* ignore */
    }
  }

  async function toggleMute() {
    if (muted || volume === 0) {
      const restore = prevVolume || 80;
      setMuted(false);
      await changeVolume(restore);
    } else {
      setPrevVolume(volume);
      setMuted(true);
      await changeVolume(0);
    }
  }

  // Poll status lightly
  useEffect(() => {
    const t = window.setInterval(() => {
      void invokeCmd<PlayerStatus>("player_status")
        .then((st) => {
          setPaused(st.paused);
          setVolume(st.volume);
          if (st.mode === "windowed") {
            void getCurrentWindow().close().catch(() => {});
          }
        })
        .catch(() => {});
    }, 1500);
    return () => window.clearInterval(t);
  }, []);

  return (
    <div
      className="relative h-full w-full bg-transparent text-foreground"
      onMouseMove={bumpChrome}
    >
      {danmakuOn && <CanvasDanmaku active className="z-10" />}

      <div
        className={cn(
          "absolute inset-x-0 bottom-0 z-20 transition-opacity duration-300",
          showChrome ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      >
        <div className="bg-black/55 backdrop-blur-sm">
          <PlayerControls
            paused={paused}
            volume={volume}
            muted={muted}
            danmakuOn={danmakuOn}
            qualities={init?.qualities ?? []}
            qualityIndex={init?.qualityIndex ?? 0}
            lines={init?.lines ?? (init ? [{ url: init.url }] : [])}
            lineIndex={init?.lineIndex ?? 0}
            fullscreen
            loadError={loadError}
            disabled={!init}
            onTogglePause={() => void togglePause()}
            onVolume={(v) => void changeVolume(v)}
            onToggleMute={() => void toggleMute()}
            onToggleDanmaku={() => setDanmakuOn((v) => !v)}
            onQualityChange={() => {
              /* quality change from overlay: exit FS and let main handle — emit */
              void emit("overlay-request-quality", {});
            }}
            onLineChange={() => {
              void emit("overlay-request-line", {});
            }}
            onToggleFullscreen={() => void exit()}
          />
        </div>
      </div>
    </div>
  );
}
