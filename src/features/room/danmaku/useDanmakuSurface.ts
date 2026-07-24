import { useCallback, useEffect, useRef } from "react";
import type { PlayUrl } from "@/shared/types/live";
import type { PlayerUiMode } from "@/shared/types/player";
import type { PlayerEpoch } from "../playerLifecycle";
import {
  beginOverlay,
  closeOverlay,
  forgetOverlay,
  isCurrentOverlay,
  openOverlay,
  setOverlayBounds,
  type OverlayBounds,
  type OverlayEpoch,
} from "../overlayLifecycle";
import { isCurrentPlayer } from "../playerLifecycle";

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
  presentation?: PlayerUiMode;
  danmakuOn?: boolean;
  overlayEpoch?: number;
  playerEpoch?: number;
};

/**
 * Single companion-window surface for windowed + fullscreen floating danmaku.
 * Re-binds bounds while windowed; re-inits presentation on mode changes.
 */
export function useDanmakuSurface(opts: {
  playUrl: PlayUrl | null;
  playerEpoch: PlayerEpoch | null;
  playerRunning: boolean;
  mode: PlayerUiMode;
  title?: string;
  volume: number;
  paused: boolean;
  qualities: { quality: string }[];
  qualityIndex: number;
  lines: { url: string }[];
  lineIndex: number;
  osdOn: boolean;
  measureHostBounds: () => Promise<OverlayBounds | null>;
  onFullscreenExited?: () => void;
}) {
  const {
    playUrl,
    playerEpoch,
    playerRunning,
    mode,
    title,
    volume,
    paused,
    qualities,
    qualityIndex,
    lines,
    lineIndex,
    osdOn,
    measureHostBounds,
    onFullscreenExited,
  } = opts;

  const overlayRequestRef = useRef(0);
  const overlayEpochRef = useRef<OverlayEpoch | null>(null);
  const overlayInitAckRef = useRef<OverlayEpoch | null>(null);
  const overlayInitRetryRef = useRef<number | null>(null);
  const overlayInitRetryEpochRef = useRef<OverlayEpoch | null>(null);
  const mountedRef = useRef(false);
  const modeRef = useRef(mode);
  const osdOnRef = useRef(osdOn);
  const payloadRef = useRef({
    playUrl,
    title,
    volume,
    paused,
    qualities,
    qualityIndex,
    lines,
    lineIndex,
  });
  const onFullscreenExitedRef = useRef(onFullscreenExited);

  modeRef.current = mode;
  osdOnRef.current = osdOn;
  onFullscreenExitedRef.current = onFullscreenExited;
  payloadRef.current = {
    playUrl,
    title,
    volume,
    paused,
    qualities,
    qualityIndex,
    lines,
    lineIndex,
  };

  const clearOverlayInitRetry = useCallback((epoch?: OverlayEpoch) => {
    if (epoch != null && overlayInitRetryEpochRef.current !== epoch) return;
    if (overlayInitRetryRef.current != null) {
      window.clearInterval(overlayInitRetryRef.current);
      overlayInitRetryRef.current = null;
    }
    overlayInitRetryEpochRef.current = null;
  }, []);

  const releaseOverlay = useCallback(
    async (epoch = overlayEpochRef.current) => {
      if (epoch == null) return;
      if (overlayEpochRef.current === epoch) overlayEpochRef.current = null;
      if (overlayInitAckRef.current === epoch) overlayInitAckRef.current = null;
      clearOverlayInitRetry(epoch);
      await closeOverlay(epoch);
    },
    [clearOverlayInitRetry],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      overlayRequestRef.current += 1;
      // Unmount must close the companion window. React will not re-run the
      // playUrl effect with null on unmount — only this cleanup runs.
      void releaseOverlay().catch(() => {});
    };
  }, [releaseOverlay]);

  const emitOverlayInit = useCallback(
    async (
      presentation: PlayerUiMode,
      danmakuVisible?: boolean,
      overlayEpoch = overlayEpochRef.current,
    ) => {
      const payload = payloadRef.current;
      if (!payload.playUrl) return;
      if (overlayEpoch == null || !isCurrentOverlay(overlayEpoch)) return;
      if (playerEpoch == null || !isCurrentPlayer(playerEpoch)) return;
      try {
        const { emitTo } = await import("@tauri-apps/api/event");
        await emitTo("danmaku-overlay", "overlay-init", {
          url: payload.playUrl.url,
          headers: payload.playUrl.headers,
          title: payload.title ?? null,
          volume: payload.volume,
          paused: payload.paused,
          qualities: payload.qualities,
          qualityIndex: payload.qualityIndex,
          lines: payload.lines,
          lineIndex: payload.lineIndex,
          presentation,
          danmakuOn: danmakuVisible ?? osdOnRef.current,
          overlayEpoch,
          playerEpoch,
        } satisfies OverlayInitPayload);
      } catch {
        /* outside tauri */
      }
    },
    [playerEpoch],
  );

  const retryOverlayInitUntilAck = useCallback(
    (presentation: PlayerUiMode, overlayEpoch: OverlayEpoch) => {
      if (!isCurrentOverlay(overlayEpoch)) return;
      clearOverlayInitRetry();
      overlayInitAckRef.current = null;
      overlayInitRetryEpochRef.current = overlayEpoch;
      let attempts = 0;
      const send = () => {
        if (
          overlayInitRetryEpochRef.current !== overlayEpoch ||
          !mountedRef.current ||
          !isCurrentOverlay(overlayEpoch)
        ) {
          clearOverlayInitRetry(overlayEpoch);
          return;
        }
        if (overlayInitAckRef.current === overlayEpoch) {
          clearOverlayInitRetry(overlayEpoch);
          return;
        }
        attempts += 1;
        void emitOverlayInit(presentation, osdOnRef.current, overlayEpoch);
        if (attempts >= 30) clearOverlayInitRetry(overlayEpoch);
      };
      send();
      overlayInitRetryRef.current = window.setInterval(send, 250);
    },
    [clearOverlayInitRetry, emitOverlayInit],
  );

  // Keep overlay payload fresh without recreating the window.
  useEffect(() => {
    const epoch = overlayEpochRef.current;
    if (epoch != null && isCurrentOverlay(epoch)) {
      void emitOverlayInit(modeRef.current, osdOn, epoch);
    }
  }, [
    emitOverlayInit,
    lineIndex,
    lines,
    osdOn,
    paused,
    playUrl,
    qualities,
    qualityIndex,
    title,
    volume,
  ]);

  // Ensure a surface exists while the player is running.
  useEffect(() => {
    if (!playUrl || !playerRunning || playerEpoch == null) {
      void releaseOverlay().catch(() => {});
      return;
    }
    if (!isCurrentPlayer(playerEpoch)) return;

    let cancelled = false;
    const requestId = ++overlayRequestRef.current;
    let epoch: OverlayEpoch | null = null;

    void (async () => {
      // Reuse existing surface when possible; re-open to switch geometry mode.
      const existing = overlayEpochRef.current;
      if (existing != null && isCurrentOverlay(existing)) {
        try {
          if (mode === "windowed") {
            const bounds = await measureHostBounds();
            if (
              !bounds ||
              cancelled ||
              overlayRequestRef.current !== requestId ||
              !isCurrentOverlay(existing)
            ) {
              return;
            }
            // openOverlay with bounds reconfigures inline click-through geometry.
            const opened = await openOverlay(existing, bounds);
            if (!opened || cancelled || !mountedRef.current) return;
          } else {
            // Fullscreen: cover the monitor (no host bounds).
            const opened = await openOverlay(existing);
            if (!opened || cancelled || !mountedRef.current) return;
          }
          retryOverlayInitUntilAck(mode, existing);
        } catch {
          /* keep playback if overlay fails */
        }
        return;
      }

      const bounds =
        mode === "windowed" ? await measureHostBounds() : undefined;
      if (mode === "windowed" && !bounds) return;
      if (
        cancelled ||
        overlayRequestRef.current !== requestId ||
        !isCurrentPlayer(playerEpoch)
      ) {
        return;
      }

      epoch = await beginOverlay();
      if (
        cancelled ||
        overlayRequestRef.current !== requestId ||
        !isCurrentOverlay(epoch)
      ) {
        await closeOverlay(epoch).catch(() => {});
        return;
      }
      overlayEpochRef.current = epoch;
      try {
        const opened = await openOverlay(epoch, bounds ?? undefined);
        if (
          cancelled ||
          overlayRequestRef.current !== requestId ||
          !opened ||
          !mountedRef.current
        ) {
          await releaseOverlay(epoch).catch(() => {});
          return;
        }
        retryOverlayInitUntilAck(mode, epoch);
      } catch {
        if (epoch != null) await releaseOverlay(epoch).catch(() => {});
      }
    })();

    return () => {
      cancelled = true;
      // Tear down on leave / mode change / player stop. The previous "keep
      // surface" path left the transparent window alive after exiting a room.
      if (epoch != null) {
        void releaseOverlay(epoch).catch(() => {});
      } else if (overlayEpochRef.current != null) {
        void releaseOverlay().catch(() => {});
      }
    };
  }, [
    playUrl,
    playerRunning,
    playerEpoch,
    mode,
    measureHostBounds,
    releaseOverlay,
    retryOverlayInitUntilAck,
  ]);

  // Sync bounds while windowed.
  useEffect(() => {
    if (mode !== "windowed" || !playUrl) return;
    const timer = window.setInterval(() => {
      const epoch = overlayEpochRef.current;
      if (epoch == null || !isCurrentOverlay(epoch)) return;
      void measureHostBounds().then((bounds) => {
        if (bounds && isCurrentOverlay(epoch)) {
          void setOverlayBounds(epoch, bounds).catch(() => {});
        }
      });
    }, 400);
    return () => window.clearInterval(timer);
  }, [mode, playUrl, measureHostBounds]);

  // Overlay lifecycle events from companion webview.
  useEffect(() => {
    let unlistenReady: (() => void) | undefined;
    let unlistenInitialized: (() => void) | undefined;
    let unlistenExit: (() => void) | undefined;
    void import("@tauri-apps/api/event").then(({ listen }) => {
      void listen<{ epoch?: number | null }>("overlay-ready", (event) => {
        const epoch = overlayEpochRef.current;
        const readyEpoch = event.payload?.epoch;
        if (epoch == null) return;
        if (readyEpoch != null && readyEpoch !== epoch) return;
        retryOverlayInitUntilAck(modeRef.current, epoch);
      }).then((fn) => {
        unlistenReady = fn;
      });
      void listen<{ epoch?: number | null }>("overlay-initialized", (event) => {
        const epoch = overlayEpochRef.current;
        const initializedEpoch = event.payload?.epoch;
        if (epoch == null || initializedEpoch !== epoch) return;
        overlayInitAckRef.current = epoch;
        clearOverlayInitRetry(epoch);
      }).then((fn) => {
        unlistenInitialized = fn;
      });
      void listen<{ epoch?: number }>("overlay-fullscreen-exited", (event) => {
        const epoch = event.payload?.epoch;
        if (epoch == null || overlayEpochRef.current !== epoch) return;
        void (async () => {
          await releaseOverlay(epoch).catch(() => {});
          if (!mountedRef.current) return;
          forgetOverlay(epoch);
          onFullscreenExitedRef.current?.();
        })();
      }).then((fn) => {
        unlistenExit = fn;
      });
    });
    return () => {
      unlistenReady?.();
      unlistenInitialized?.();
      unlistenExit?.();
    };
  }, [clearOverlayInitRetry, releaseOverlay, retryOverlayInitUntilAck]);

  // Full teardown when stream goes away.
  useEffect(() => {
    if (playUrl) return;
    void releaseOverlay().catch(() => {});
  }, [playUrl, releaseOverlay]);

  return {
    overlayEpoch: overlayEpochRef.current,
    releaseOverlay,
    emitOverlayInit,
    retryOverlayInitUntilAck,
  };
}
