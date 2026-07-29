import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { X } from "lucide-react";
import { ANDROID_BACK_EVENT } from "@/app/androidBackNavigation";
import type { PlayUrl, SiteId } from "@/shared/types/live";
import { ErrorState } from "@/shared/components/ErrorState";
import { DanmakuPanel } from "./DanmakuPanel";
import { DanmakuSettingsPanel } from "./DanmakuSettingsPanel";
import { FollowPanel } from "./FollowPanel";
import { SuperChatPanel } from "./SuperChatPanel";
import { DanmakuComposer } from "./BilibiliDanmakuComposer";
import { PlayerControls } from "./PlayerControls";
import { CanvasDanmaku } from "./canvas/CanvasDanmaku";
import { useLocalAsrCaptions } from "./asr/useLocalAsrCaptions";
import { useAutoDanmakuSend } from "./danmaku/useAutoDanmakuSend";
import { useWebPlayer } from "./player/useWebPlayer";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useScreenWakeLock } from "@/shared/hooks/useScreenWakeLock";
import type { PlayerEvent } from "@/shared/types/player";

export type RoomSideTab = "chat" | "sc" | "settings" | "follow";

const CONTROLS_HIDE_DELAY_MS = 2_600;
const OVERLAY_FOCUS_RESTORE_DELAY_MS = 160;
const COMPACT_LANDSCAPE_VIEWPORT_QUERY =
  "(orientation: landscape) and (max-height: 540px) and (pointer: coarse)";
const COMPACT_VIEWPORT_QUERY = `(max-width: 767px), ${COMPACT_LANDSCAPE_VIEWPORT_QUERY}`;
type OverlayInteractionSource = "controls" | "composer";

function isCompactViewport(): boolean {
  return typeof window !== "undefined" && window.matchMedia(COMPACT_VIEWPORT_QUERY).matches;
}

function useCompactViewport(): boolean {
  const [compact, setCompact] = useState(isCompactViewport);

  useEffect(() => {
    const query = window.matchMedia(COMPACT_VIEWPORT_QUERY);
    const update = () => setCompact(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return compact;
}

function isCompactLandscapeViewport(): boolean {
  return (
    typeof window !== "undefined" && window.matchMedia(COMPACT_LANDSCAPE_VIEWPORT_QUERY).matches
  );
}

function useCompactLandscapeViewport(): boolean {
  const [compactLandscape, setCompactLandscape] = useState(isCompactLandscapeViewport);

  useEffect(() => {
    const query = window.matchMedia(COMPACT_LANDSCAPE_VIEWPORT_QUERY);
    const update = () => setCompactLandscape(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return compactLandscape;
}

/**
 * On phones the side panel covers most of the video. Stop the obscured canvas
 * renderer until the drawer closes, while the chat and SC panels keep their
 * own bounded event subscriptions alive.
 */
export function shouldRunDanmakuCanvas({
  danmakuActive,
  osdOn,
  compactViewport,
  sidePanelOpen,
}: {
  danmakuActive: boolean;
  osdOn: boolean;
  compactViewport: boolean;
  sidePanelOpen: boolean;
}): boolean {
  return danmakuActive && osdOn && !(compactViewport && sidePanelOpen);
}

function isPlayerInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(
    target.closest(
      'button, input, select, textarea, [role="button"], [role="combobox"], [role="slider"], [contenteditable="true"]',
    ),
  );
}

type PlayerPaneProps = {
  playUrl: PlayUrl | null;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  /** Compact streamer identity shown above the side tabs. */
  sideHeader?: ReactNode;
  danmakuActive?: boolean;
  danmakuStatusText?: string | null;
  qualities?: { quality: string }[];
  qualityIndex?: number;
  onQualityChange?: (index: number) => void;
  lines?: { url: string }[];
  lineIndex?: number;
  onLineChange?: (index: number) => void;
  /** Refresh the active stream metadata and rebuild the MSE session. */
  onRefresh?: () => void;
  loadError?: string | null;
  reloadToken?: number;
  onPlayerMediaFailure?: (event: PlayerEvent) => void;
  onPlayerPlaying?: () => void;
  /** Stable room identity, used to discard messages during direct room switches. */
  roomSessionKey?: string;
  /** Controlled by RoomPage so a follow-list room switch keeps this tab open. */
  sideTab?: RoomSideTab;
  onSideTabChange?: (tab: RoomSideTab) => void;
  /** The canonical room identity for platform-specific chat controls. */
  siteId?: SiteId;
  roomId?: string;
};

/**
 * Room player — **web MSE path** (mpegts.js + localhost stream proxy).
 *
 * No mpv / no native HWND / no companion overlay window. Video + scrolling
 * danmaku share one DOM stack; leave-room unmount stops everything cleanly.
 */
export function PlayerPane({
  playUrl,
  loading,
  error,
  onRetry,
  sideHeader,
  danmakuActive = false,
  danmakuStatusText,
  qualities = [],
  qualityIndex = 0,
  onQualityChange,
  lines = [],
  lineIndex = 0,
  onLineChange,
  onRefresh,
  loadError: externalLoadError,
  reloadToken = 0,
  onPlayerMediaFailure,
  onPlayerPlaying,
  roomSessionKey,
  sideTab,
  onSideTabChange,
  siteId,
  roomId,
}: PlayerPaneProps) {
  const compactViewport = useCompactViewport();
  const compactLandscapeViewport = useCompactLandscapeViewport();
  // On a phone the side panel opens over the video. Start with the picture
  // unobstructed; portrait uses a bottom drawer while short landscape screens
  // use a narrower right drawer so the video keeps meaningful height.
  const [sidePanelOpen, setSidePanelOpen] = useState(() => !isCompactViewport());
  const shouldMountSidePanel = sidePanelOpen || !compactViewport;
  const [osdOn, setOsdOn] = useState(true);
  const [captionFontSize, setCaptionFontSize] = useState(20);
  const [overlayInteractionOpen, setOverlayInteractionOpen] = useState(false);
  const [scUnreadCount, setScUnreadCount] = useState(0);
  const controlsHideTimerRef = useRef<number | null>(null);
  const controlsRef = useRef<HTMLDivElement | null>(null);
  const controlsVisibleRef = useRef(true);
  // Track focus inside the bottom chrome. A clicked button also takes DOM
  // focus, so the idle guard below additionally checks :focus-visible before
  // treating that focus as a keyboard interaction that must keep it present.
  const controlsFocusWithinRef = useRef(false);
  const lastControlsActivityAtRef = useRef(Date.now());
  const overlayInteractionOpenRef = useRef(false);
  const overlayInteractionSourcesRef = useRef<Record<OverlayInteractionSource, boolean>>({
    controls: false,
    composer: false,
  });

  const player = useWebPlayer({
    playUrl,
    siteId,
    sessionKey: roomSessionKey,
    reloadToken,
    onMediaFailure: onPlayerMediaFailure,
    onPlaying: onPlayerPlaying,
  });
  useScreenWakeLock(player.running && !player.paused);
  // This stays above the conditional side panel, so hiding that panel never
  // silently stops a session the user explicitly enabled.
  const autoDanmakuSend = useAutoDanmakuSend({ siteId, roomId, roomSessionKey });

  const displayError =
    error ??
    (player.loadError
      ? {
          code: "play_error",
          message: player.loadError,
          site: null,
          retryable: true,
        }
      : null);
  const showHost = !loading && displayError == null && !!playUrl;
  const localCaptions = useLocalAsrCaptions({
    videoRef: player.videoRef,
    roomSessionKey,
    mediaKey: player.mediaKey,
    playbackAvailable: showHost,
    volume: player.volume,
    muted: player.muted,
  });
  const transportDisabled = !showHost;
  // A failed MSE session still has a stream URL and must be refreshable; the
  // error state is precisely where this control is most useful.
  const refreshDisabled = loading || !playUrl;
  const loadError = externalLoadError ?? player.loadError;
  const danmakuSessionKey = `${roomSessionKey ?? "room"}:${playUrl?.url ?? "idle"}`;
  const canAutoHideControls =
    showHost && player.running && !player.paused && !overlayInteractionOpen;
  const canvasActive = shouldRunDanmakuCanvas({
    danmakuActive,
    osdOn,
    compactViewport,
    sidePanelOpen,
  });
  const mobileDrawerOpen = compactViewport && sidePanelOpen;
  const compactSidePanelClassName = compactLandscapeViewport
    ? "absolute inset-y-0 right-0 z-50 h-full w-[min(22rem,78vw)] max-w-full overscroll-contain rounded-l-2xl border-l border-border/80 pb-[env(safe-area-inset-bottom)] pr-[env(safe-area-inset-right)] shadow-2xl"
    : "absolute inset-x-0 bottom-0 z-50 h-[min(26rem,72dvh)] min-h-64 w-full overscroll-contain rounded-t-2xl border-t border-border/80 pb-[env(safe-area-inset-bottom)] shadow-2xl";

  // The desktop rail is visible by default, while the phone drawer should
  // begin closed so playback stays unobstructed. Reset only when crossing the
  // responsive breakpoint; a manual desktop toggle remains intact otherwise.
  useEffect(() => {
    setSidePanelOpen(!compactViewport);
  }, [compactViewport]);

  // A landscape rotation is a viewing-first transition. Do not carry an
  // already opened portrait drawer across it and cover the newly wide video.
  useEffect(() => {
    if (compactLandscapeViewport) setSidePanelOpen(false);
  }, [compactLandscapeViewport]);

  useEffect(() => {
    if (!mobileDrawerOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setSidePanelOpen(false);
    };
    const closeOnAndroidBack = (event: Event) => {
      event.preventDefault();
      setSidePanelOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener(ANDROID_BACK_EVENT, closeOnAndroidBack);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener(ANDROID_BACK_EVENT, closeOnAndroidBack);
    };
  }, [mobileDrawerOpen]);

  const clearControlsHideTimer = useCallback(() => {
    if (controlsHideTimerRef.current !== null) {
      window.clearTimeout(controlsHideTimerRef.current);
      controlsHideTimerRef.current = null;
    }
  }, []);

  const setControlVisibility = useCallback((visible: boolean) => {
    if (controlsVisibleRef.current === visible) return;
    controlsVisibleRef.current = visible;

    // Hiding controls used to update PlayerPane state. That re-rendered the
    // live canvas and every keep-mounted side tab at the exact moment the
    // animation started, which is perceptible during a busy danmaku stream.
    // This small DOM-only state is deliberately isolated to the overlay: CSS
    // still performs the composited fade, while the video, canvas and lists
    // continue their existing work without a React reconciliation.
    const controls = controlsRef.current;
    if (!controls) return;
    controls.dataset.visible = visible ? "true" : "false";
    controls.setAttribute("aria-hidden", String(!visible));
    controls.toggleAttribute("inert", !visible);
  }, []);

  const markControlsActivity = useCallback(() => {
    lastControlsActivityAtRef.current = Date.now();
  }, []);

  const hasKeyboardFocusWithinControls = useCallback(() => {
    if (!controlsFocusWithinRef.current) return false;
    const activeElement = document.activeElement;
    return (
      activeElement instanceof HTMLElement &&
      controlsRef.current?.contains(activeElement) === true &&
      activeElement.matches(":focus-visible")
    );
  }, []);

  const scheduleControlsHide = useCallback(() => {
    clearControlsHideTimer();
    if (
      !canAutoHideControls ||
      overlayInteractionOpenRef.current ||
      hasKeyboardFocusWithinControls()
    ) {
      setControlVisibility(true);
      return;
    }

    // Pointer events can fire at display refresh rate. Rather than resetting a
    // timeout for each one, keep one timer and let it check the latest activity
    // timestamp when it wakes up. This leaves the video/danmaku main thread
    // free while retaining an exact idle-delay contract.
    const hideWhenIdle = () => {
      const remaining = CONTROLS_HIDE_DELAY_MS - (Date.now() - lastControlsActivityAtRef.current);
      if (remaining > 0) {
        controlsHideTimerRef.current = window.setTimeout(hideWhenIdle, remaining);
        return;
      }

      controlsHideTimerRef.current = null;
      if (
        !canAutoHideControls ||
        overlayInteractionOpenRef.current ||
        hasKeyboardFocusWithinControls()
      ) {
        setControlVisibility(true);
        return;
      }
      setControlVisibility(false);
    };

    const initialDelay = Math.max(
      0,
      CONTROLS_HIDE_DELAY_MS - (Date.now() - lastControlsActivityAtRef.current),
    );
    controlsHideTimerRef.current = window.setTimeout(hideWhenIdle, initialDelay);
  }, [
    canAutoHideControls,
    clearControlsHideTimer,
    hasKeyboardFocusWithinControls,
    setControlVisibility,
  ]);

  const revealControls = useCallback(() => {
    markControlsActivity();
    setControlVisibility(true);
    if (controlsHideTimerRef.current === null) scheduleControlsHide();
  }, [markControlsActivity, scheduleControlsHide, setControlVisibility]);

  const holdControlsVisible = useCallback(() => {
    markControlsActivity();
    clearControlsHideTimer();
    setControlVisibility(true);
  }, [clearControlsHideTimer, markControlsActivity, setControlVisibility]);

  const resumeControlsAutoHide = useCallback(() => {
    markControlsActivity();
    scheduleControlsHide();
  }, [markControlsActivity, scheduleControlsHide]);

  const handleOverlayInteractionChange = useCallback(
    (source: OverlayInteractionSource, open: boolean) => {
      overlayInteractionSourcesRef.current[source] = open;
      const hasOpenOverlay =
        overlayInteractionSourcesRef.current.controls ||
        overlayInteractionSourcesRef.current.composer;
      overlayInteractionOpenRef.current = hasOpenOverlay;
      setOverlayInteractionOpen(hasOpenOverlay);
      if (hasOpenOverlay) holdControlsVisible();
    },
    [holdControlsVisible],
  );

  const handleControlsOverlayInteractionChange = useCallback(
    (open: boolean) => handleOverlayInteractionChange("controls", open),
    [handleOverlayInteractionChange],
  );

  const handleComposerOverlayInteractionChange = useCallback(
    (open: boolean) => handleOverlayInteractionChange("composer", open),
    [handleOverlayInteractionChange],
  );

  const handleScUnreadCountChange = useCallback((count: number) => {
    setScUnreadCount(count);
  }, []);

  const handleSideTabValueChange = useCallback(
    (value: string) => {
      const nextTab = value as RoomSideTab;
      if (nextTab === "sc") setScUnreadCount(0);
      onSideTabChange?.(nextTab);
    },
    [onSideTabChange],
  );

  const handleStagePointerActivity = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.type === "pointerdown") {
        event.currentTarget.focus({ preventScroll: true });
      }
      // The hidden bar deliberately has no pointer events.  Revealing on the
      // first stage movement makes its whole bottom edge immediately usable
      // without querying layout on every pointer event.
      revealControls();
    },
    [revealControls],
  );

  const focusFirstControl = useCallback(() => {
    // A hidden transparent bar must not be in the tab sequence.  After Tab
    // reveals it, explicitly put focus on its first usable control instead of
    // relying on an asynchronous React state update to affect this key's
    // native tab traversal.
    window.requestAnimationFrame(() => {
      const target = controlsRef.current?.querySelector<HTMLElement>(
        'button:not(:disabled), [role="combobox"]:not([aria-disabled="true"])',
      );
      target?.focus({ preventScroll: true });
    });
  }, []);

  const handleStageKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (
        event.defaultPrevented ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.nativeEvent.isComposing ||
        isPlayerInteractiveTarget(event.target)
      ) {
        return;
      }

      if (event.key === "Tab") {
        event.preventDefault();
        revealControls();
        focusFirstControl();
        return;
      }

      if (event.repeat) return;
      const key = event.key.toLowerCase();
      if (key !== " " && key !== "k" && key !== "m" && key !== "f") return;

      event.preventDefault();
      revealControls();
      if (key === " " || key === "k") {
        player.togglePause();
      } else if (key === "m") {
        player.toggleMute();
      } else {
        void player.toggleFullscreen();
      }
    },
    [focusFirstControl, player, revealControls],
  );

  // Live playback stays unobstructed by default, while every pointer, touch
  // or keyboard interaction brings the bottom chrome back immediately.
  useEffect(() => {
    markControlsActivity();
    setControlVisibility(true);
    scheduleControlsHide();
    return clearControlsHideTimer;
  }, [
    roomSessionKey,
    scheduleControlsHide,
    clearControlsHideTimer,
    markControlsActivity,
    setControlVisibility,
  ]);

  useEffect(() => {
    // A direct room switch unmounts popovers, but reset the source fence as a
    // fallback so a closing portal can never pin controls for the next room.
    overlayInteractionSourcesRef.current.controls = false;
    overlayInteractionSourcesRef.current.composer = false;
    overlayInteractionOpenRef.current = false;
    controlsFocusWithinRef.current = false;
    setOverlayInteractionOpen(false);
    setScUnreadCount(0);
  }, [roomSessionKey]);

  useEffect(() => {
    if (overlayInteractionOpen) return;
    // Base UI returns focus from a portalled Select/Popover to its trigger.
    // Its exit transition is 100ms, so schedule after focus restoration rather
    // than allowing that focus handler to clear the idle timer.
    const timer = window.setTimeout(resumeControlsAutoHide, OVERLAY_FOCUS_RESTORE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [overlayInteractionOpen, resumeControlsAutoHide]);

  useEffect(() => {
    const onFullscreenChange = () => revealControls();
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, [revealControls]);

  return (
    <div className="relative flex h-full min-h-0 w-full bg-black">
      <div className="relative flex min-w-0 flex-1 flex-col bg-black">
        <div className="flex min-h-0 flex-1 flex-col">
          <div
            ref={player.stageRef}
            className="relative min-h-0 flex-1 overflow-hidden bg-black"
            tabIndex={0}
            aria-label="直播播放器；按空格或 K 播放或暂停，M 静音，F 全屏"
            aria-keyshortcuts="Space K M F"
            onPointerEnter={handleStagePointerActivity}
            onPointerMove={handleStagePointerActivity}
            onPointerDown={handleStagePointerActivity}
            onKeyDown={handleStageKeyDown}
          >
            {loading && (
              <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 text-muted-foreground">
                <Spinner className="size-8 text-primary" />
                <p className="text-sm">正在解析线路…</p>
              </div>
            )}
            {!loading && displayError != null && (
              <div className="absolute inset-0 z-20 flex items-center justify-center p-6">
                <div className="w-full max-w-md">
                  <ErrorState error={displayError} title="播放不可用" onRetry={onRetry} />
                </div>
              </div>
            )}
            {!loading && displayError == null && !playUrl && (
              <div className="absolute inset-0 z-20 flex items-center justify-center text-sm text-muted-foreground">
                未选择流
              </div>
            )}

            {/* key=mediaKey forces a clean <video> after leave/re-enter (MSE). */}
            <video
              key={player.mediaKey}
              ref={player.videoRef}
              className="absolute inset-0 h-full w-full bg-black object-contain"
              crossOrigin="anonymous"
              playsInline
              autoPlay
              controls={false}
            />

            {showHost && !player.running && (
              <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
                <Spinner className="size-8 text-white/70" />
              </div>
            )}

            {/* Floating danmaku over the picture (same DOM stack as Simple Live). */}
            {showHost && osdOn && (
              <CanvasDanmaku
                active={canvasActive}
                sessionKey={danmakuSessionKey}
                className="z-10"
              />
            )}

            {/* Local Whisper captions: DOM text stays above danmaku (z-10),
                below the bottom playback chrome (z-30), and is intentionally
                absent from native PiP because PiP owns only the video frame. */}
            {showHost && (
              <>
                {localCaptions.message && (
                  <div className="pointer-events-none absolute top-3 right-3 z-20 max-w-[min(22rem,calc(100%-1.5rem))]">
                    <span
                      role="status"
                      aria-live="polite"
                      className="rounded-md border border-white/10 bg-black/72 px-2 py-1 text-xs text-white/85 shadow-sm"
                    >
                      {localCaptions.message}
                    </span>
                  </div>
                )}

                {localCaptions.caption && (
                  <div
                    aria-live="polite"
                    aria-atomic="true"
                    className="pointer-events-none absolute right-6 bottom-[calc(5rem+env(safe-area-inset-bottom))] left-6 z-20 flex justify-center"
                  >
                    <p
                      className="max-w-[min(56rem,92%)] rounded-xl border border-white/10 bg-black/72 px-4 py-2 text-center leading-relaxed font-medium text-white shadow-lg"
                      style={{ fontSize: `${captionFontSize}px` }}
                    >
                      {localCaptions.caption}
                    </p>
                  </div>
                )}
              </>
            )}

            <div
              ref={controlsRef}
              data-player-controls
              data-visible="true"
              className={cn(
                // The player is busy with MSE + canvas danmaku. Keep this one
                // transient layer composited: no layout property, blur, or
                // gradient is animated when the controls auto-hide. The data
                // attribute is changed imperatively above, avoiding a full
                // PlayerPane reconciliation at the start of the fade.
                "absolute inset-x-0 bottom-0 z-30 px-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] transform-gpu [backface-visibility:hidden] [will-change:transform,opacity] transition-[opacity,transform] duration-150 ease-out motion-reduce:transition-none data-[visible=false]:pointer-events-none data-[visible=false]:translate-y-2 data-[visible=false]:opacity-0",
              )}
              onPointerEnter={holdControlsVisible}
              onPointerDown={(event) => {
                event.stopPropagation();
                holdControlsVisible();
              }}
              onPointerLeave={resumeControlsAutoHide}
              onFocusCapture={() => {
                controlsFocusWithinRef.current = true;
                holdControlsVisible();
              }}
              onBlurCapture={(event) => {
                const nextFocused = event.relatedTarget;
                if (nextFocused instanceof Node && event.currentTarget.contains(nextFocused)) {
                  controlsFocusWithinRef.current = true;
                  holdControlsVisible();
                  return;
                }
                controlsFocusWithinRef.current = false;
                resumeControlsAutoHide();
              }}
            >
              <PlayerControls
                paused={player.paused}
                volume={player.volume}
                muted={player.muted}
                sidePanelOpen={sidePanelOpen}
                sidePanelLabel={
                  compactViewport
                    ? sidePanelOpen
                      ? "收起直播间面板"
                      : "打开直播间面板"
                    : undefined
                }
                osdOn={osdOn}
                qualities={qualities}
                qualityIndex={qualityIndex}
                lines={lines}
                lineIndex={lineIndex}
                fullscreen={player.mode === "fullscreen"}
                pictureInPictureSupported={showHost && player.pictureInPictureSupported}
                pictureInPictureActive={player.pictureInPictureActive}
                pictureInPictureDisabled={!player.running || player.mode === "fullscreen"}
                loadError={loadError}
                disabled={transportDisabled}
                overlay
                captions={{
                  enabled: localCaptions.enabled,
                  pending: localCaptions.pending,
                  ready: localCaptions.ready,
                  onToggle: localCaptions.toggle,
                }}
                centerSlot={
                  <DanmakuComposer
                    siteId={siteId}
                    roomId={roomId}
                    overlay
                    onOverlayInteractionChange={handleComposerOverlayInteractionChange}
                  />
                }
                onOverlayInteractionChange={handleControlsOverlayInteractionChange}
                refreshDisabled={refreshDisabled}
                onRefresh={onRefresh}
                onTogglePause={() => player.togglePause()}
                onVolume={(v) => player.changeVolume(v)}
                onToggleMute={player.toggleMute}
                onToggleSidePanel={() => setSidePanelOpen((open) => !open)}
                onToggleOsd={() => setOsdOn((v) => !v)}
                onQualityChange={onQualityChange ?? (() => {})}
                onLineChange={onLineChange ?? (() => {})}
                onTogglePictureInPicture={() => void player.togglePictureInPicture()}
                onToggleFullscreen={() => void player.toggleFullscreen()}
              />
            </div>
          </div>
        </div>
      </div>

      {mobileDrawerOpen && (
        <Button
          type="button"
          variant="ghost"
          tabIndex={-1}
          aria-hidden
          className="absolute inset-0 z-40 h-auto w-auto rounded-none bg-black/45 p-0 hover:bg-black/45"
          onClick={() => setSidePanelOpen(false)}
        />
      )}

      {shouldMountSidePanel && (
        <aside
          aria-hidden={!sidePanelOpen}
          aria-labelledby={compactViewport ? "room-side-panel-title" : undefined}
          aria-modal={compactViewport ? true : undefined}
          role={compactViewport ? "dialog" : undefined}
          className={cn(
            "flex shrink-0 flex-col bg-sidebar",
            compactViewport
              ? compactSidePanelClassName
              : "w-[300px] border-l border-border/80 lg:w-[320px]",
            !sidePanelOpen && "hidden",
          )}
        >
          {compactViewport && (
            <h2 id="room-side-panel-title" className="sr-only">
              直播间面板
            </h2>
          )}
          {sideHeader}
          <Tabs
            {...(sideTab ? { value: sideTab } : { defaultValue: "chat" })}
            className="flex min-h-0 flex-1 flex-col gap-0"
            onValueChange={handleSideTabValueChange}
          >
            <div className="flex h-11 shrink-0 items-center border-b border-border/80 pr-2">
              <TabsList
                variant="line"
                className="h-11! min-w-0 flex-1 justify-start rounded-none bg-transparent px-2"
              >
                <TabsTrigger value="chat" className="px-3 text-sm">
                  弹幕
                </TabsTrigger>
                <TabsTrigger
                  value="sc"
                  className="text-sm"
                  aria-label={
                    scUnreadCount > 0
                      ? `SC，${scUnreadCount > 99 ? "99+" : scUnreadCount} 条新醒目留言`
                      : "SC"
                  }
                >
                  SC
                  {scUnreadCount > 0 && (
                    <span
                      aria-hidden="true"
                      className="rounded-full bg-primary px-1.5 py-px text-[10px] leading-4 font-semibold text-primary-foreground tabular-nums"
                    >
                      {scUnreadCount > 99 ? "99+" : scUnreadCount}
                    </span>
                  )}
                </TabsTrigger>
                <TabsTrigger value="follow" className="text-sm">
                  关注
                </TabsTrigger>
                <TabsTrigger value="settings" className="text-sm">
                  设置
                </TabsTrigger>
              </TabsList>
              {compactViewport && (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className="max-md:size-11 max-md:touch-manipulation"
                        aria-label="关闭直播间面板"
                        onClick={() => setSidePanelOpen(false)}
                      />
                    }
                  >
                    <X data-icon="inline-start" aria-hidden />
                  </TooltipTrigger>
                  <TooltipContent>关闭直播间面板</TooltipContent>
                </Tooltip>
              )}
            </div>
            <TabsContent
              value="chat"
              keepMounted
              className="mt-0 min-h-0 flex-1 data-[hidden]:hidden"
            >
              <DanmakuPanel
                key={`chat:${roomSessionKey ?? "room"}`}
                active={danmakuActive}
                siteId={siteId}
                roomId={roomId}
                visible={sidePanelOpen && (sideTab === undefined || sideTab === "chat")}
                statusText={danmakuStatusText}
                className="h-full"
              />
            </TabsContent>
            <TabsContent
              value="sc"
              keepMounted
              className="mt-0 min-h-0 flex-1 data-[hidden]:hidden"
            >
              <SuperChatPanel
                key={`sc:${roomSessionKey ?? "room"}`}
                active={danmakuActive}
                siteId={siteId}
                danmakuStatusText={danmakuStatusText}
                visible={sidePanelOpen && (sideTab === undefined || sideTab === "sc")}
                onUnreadCountChange={handleScUnreadCountChange}
                className="h-full"
              />
            </TabsContent>
            <TabsContent
              value="follow"
              keepMounted
              className="mt-0 min-h-0 flex-1 data-[hidden]:hidden"
            >
              <FollowPanel className="h-full" />
            </TabsContent>
            <TabsContent
              value="settings"
              keepMounted
              className="mt-0 min-h-0 flex-1 data-[hidden]:hidden"
            >
              <DanmakuSettingsPanel
                className="h-full"
                autoSend={autoDanmakuSend}
                captions={{
                  enabled: localCaptions.enabled,
                  pending: localCaptions.pending,
                  ready: localCaptions.ready,
                  state: localCaptions.state,
                  message: localCaptions.message,
                  fontSize: captionFontSize,
                  onFontSizeChange: (size) => {
                    setCaptionFontSize(Math.max(16, Math.min(36, Math.round(size))));
                  },
                }}
              />
            </TabsContent>
          </Tabs>
        </aside>
      )}
    </div>
  );
}
