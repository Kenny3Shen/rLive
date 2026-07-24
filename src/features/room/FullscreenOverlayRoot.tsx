import { useCallback, useEffect, useRef, useState } from "react";
import { listen, emitTo, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invokeCmd } from "@/shared/api/tauri";
import type { PlayerStatus } from "@/shared/types/player";
import type { AppError } from "@/shared/types/error";
import { CanvasDanmaku } from "./canvas/CanvasDanmaku";
import { closeOverlay } from "./overlayLifecycle";
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
  /** `windowed` means a click-through overlay over the embedded video host. */
  presentation?: "windowed" | "fullscreen";
  danmakuOn?: boolean;
  /** The native lifecycle token supplied by the main WebView. */
  overlayEpoch?: number;
  /** The matching native mpv session token supplied by the main WebView. */
  playerEpoch?: number;
};

function validOverlayEpoch(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validPlayerEpoch(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

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
  const exitNotifiedRef = useRef(false);
  const currentEpochRef = useRef<number | null>(null);
  const isFullscreen = init?.presentation === "fullscreen";
  const canvasSessionKey = init?.overlayEpoch ?? currentEpochRef.current ?? "pending";

  useEffect(() => {
    document.documentElement.classList.add("dark", "overlay-window");
    document.body.classList.add("bg-transparent", "overflow-hidden");
    return () => {
      document.documentElement.classList.remove("dark", "overlay-window");
      document.body.classList.remove("bg-transparent", "overflow-hidden");
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | undefined;
    let readyTimer: number | null = null;

    void (async () => {
      try {
        const stopListening = await listen<OverlayInitPayload>("overlay-init", (event) => {
          if (cancelled) return;
          const payload = event.payload;
          if (!validOverlayEpoch(payload.overlayEpoch)) return;

          const priorEpoch = currentEpochRef.current;
          if (priorEpoch != null && payload.overlayEpoch < priorEpoch) return;

          const isNewSession = payload.overlayEpoch !== priorEpoch;
          currentEpochRef.current = payload.overlayEpoch;
          setInit(payload);
          if (isNewSession) exitNotifiedRef.current = false;
          if (typeof payload.volume === "number") setVolume(payload.volume);
          if (typeof payload.paused === "boolean") setPaused(payload.paused);
          if (typeof payload.danmakuOn === "boolean") setDanmakuOn(payload.danmakuOn);
          if (readyTimer != null) {
            window.clearInterval(readyTimer);
            readyTimer = null;
          }
          void emitTo("main", "overlay-initialized", { epoch: payload.overlayEpoch });
        });

        if (cancelled) {
          await stopListening();
          return;
        }

        unlisten = stopListening;
        let readyAttempts = 0;
        const announceReady = () => {
          if (cancelled || currentEpochRef.current != null) {
            if (readyTimer != null) {
              window.clearInterval(readyTimer);
              readyTimer = null;
            }
            return;
          }
          readyAttempts += 1;
          void emitTo("main", "overlay-ready", { epoch: currentEpochRef.current });
          if (readyAttempts >= 40 && readyTimer != null) {
            window.clearInterval(readyTimer);
            readyTimer = null;
          }
        };
        announceReady();
        readyTimer = window.setInterval(announceReady, 250);
      } catch {
        return;
      }
    })();

    return () => {
      cancelled = true;
      if (readyTimer != null) window.clearInterval(readyTimer);
      void unlisten?.();
    };
  }, []);

  const bumpChrome = useCallback(() => {
    if (!isFullscreen) return;
    setShowChrome(true);
    if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = window.setTimeout(() => setShowChrome(false), 3000);
  }, [isFullscreen]);

  useEffect(() => {
    if (!isFullscreen) {
      setShowChrome(false);
      return;
    }
    bumpChrome();
    const onMove = () => bumpChrome();
    window.addEventListener("mousemove", onMove);
    return () => {
      window.removeEventListener("mousemove", onMove);
      if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
    };
  }, [bumpChrome, isFullscreen]);

  const notifyFullscreenExit = useCallback(async () => {
    const epoch = init?.overlayEpoch;
    if (!validOverlayEpoch(epoch) || currentEpochRef.current !== epoch) return;
    if (exitNotifiedRef.current) return;
    exitNotifiedRef.current = true;
    try {
      await emitTo("main", "overlay-fullscreen-exited", { epoch });
    } catch {
      /* main may already be closing */
    }
  }, [init?.overlayEpoch]);

  const exit = useCallback(async () => {
    if (!init || !isFullscreen) {
      try {
        await getCurrentWindow().close();
      } catch {
        /* ignore */
      }
      return;
    }
    setLoadError(null);
    if (!validPlayerEpoch(init.playerEpoch)) {
      setLoadError("播放器会话已结束");
      return;
    }
    try {
      await invokeCmd("player_exit_fullscreen", {
        epoch: init.playerEpoch,
        url: init.url,
        headers: init.headers,
        title: init.title ?? null,
        bounds: null,
      });
      // Notify main first. It waits for the epoch-aware close before it
      // creates a compact successor, so this old WebView cannot close a
      // freshly repurposed native window.
      await notifyFullscreenExit();
      if (init.overlayEpoch != null) {
        await closeOverlay(init.overlayEpoch).catch(() => {});
      }
    } catch (e) {
      const msg =
        typeof e === "object" && e && "message" in e ? String((e as AppError).message) : String(e);
      setLoadError(msg || "退出全屏失败");
    }
  }, [init, isFullscreen, notifyFullscreenExit]);

  useEffect(() => {
    if (!isFullscreen) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        void exit();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [exit, isFullscreen]);

  async function togglePause() {
    const playerEpoch = init?.playerEpoch;
    if (!validPlayerEpoch(playerEpoch)) return;
    const next = !paused;
    try {
      await invokeCmd("player_set_pause", { epoch: playerEpoch, paused: next });
      setPaused(next);
    } catch {
      /* ignore */
    }
  }

  async function changeVolume(v: number) {
    const playerEpoch = init?.playerEpoch;
    if (!validPlayerEpoch(playerEpoch)) return;
    const vol = Math.max(0, Math.min(100, Math.round(v)));
    setVolume(vol);
    setMuted(vol === 0);
    try {
      await invokeCmd("player_set_volume", { epoch: playerEpoch, volume: vol });
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
          if (isFullscreen && st.mode === "windowed") {
            void notifyFullscreenExit().then(() => {
              if (init?.overlayEpoch != null) {
                void closeOverlay(init.overlayEpoch).catch(() => {});
              }
            });
          }
        })
        .catch(() => {});
    }, 1500);
    return () => window.clearInterval(t);
  }, [init?.overlayEpoch, isFullscreen, notifyFullscreenExit]);

  return (
    <div className="relative h-full w-full bg-transparent text-foreground" onMouseMove={bumpChrome}>
      {danmakuOn && (
        <CanvasDanmaku
          key={canvasSessionKey}
          sessionKey={canvasSessionKey}
          active
          className="z-10"
        />
      )}

      {isFullscreen && (
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
                void emitTo("main", "overlay-request-quality", {});
              }}
              onLineChange={() => {
                void emitTo("main", "overlay-request-line", {});
              }}
              onToggleFullscreen={() => void exit()}
            />
          </div>
        </div>
      )}
    </div>
  );
}
