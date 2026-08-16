import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { CircleAlert, Maximize2, Pause, Play, RefreshCw, Volume2, VolumeX, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AudioOnlyIndicator } from "@/shared/components/player/AudioOnlyIndicator";
import {
  PLAYER_CONTROL_BUTTON_CLASS,
  PLAYER_CONTROL_ICON_CLASS,
  PLAYER_OVERLAY_CONTROL_BUTTON_CLASS,
  PlayerControls,
} from "@/shared/components/player/PlayerControls";
import { RoomIdentityLine } from "@/shared/components/player/RoomIdentityLine";
import { cn, normalizeImageUrl } from "@/lib/utils";
import { invokeCmd } from "@/shared/api/tauri";
import type { LiveRoomDetail } from "@/shared/types/live";
import { useAsrCaptions } from "@/features/asr/useAsrCaptions";
import { DanmakuComposer } from "@/features/room/BilibiliDanmakuComposer";
import { DanmuJsDanmaku } from "@/features/room/danmaku/DanmuJsDanmaku";
import { useDanmakuConnection } from "@/features/room/danmaku/useDanmakuConnection";
import { usePlaybackController } from "@/features/room/playback/usePlaybackController";
import type { PlaybackController } from "@/features/room/playback/usePlaybackController";
import { useWebPlayer } from "@/features/room/player/useWebPlayer";
import type { WebPlayerApi } from "@/features/room/player/useWebPlayer";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import { useMultiRoomStore, type MultiRoomEntry } from "./multiRoomStore";

const MULTI_ROOM_CONTROLS_HIDE_DELAY_MS = 2_600;
type MultiRoomOverlayInteractionSource = "controls" | "composer";

function playbackErrorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    const message = String(error.message ?? "").trim();
    if (message) return message;
  }
  return "当前直播流不可用";
}

function OverlayIconButton({
  label,
  onClick,
  children,
  disabled,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className={cn(
              PLAYER_CONTROL_BUTTON_CLASS,
              PLAYER_CONTROL_ICON_CLASS,
              PLAYER_OVERLAY_CONTROL_BUTTON_CLASS,
            )}
            aria-label={label}
            disabled={disabled}
            onClick={onClick}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

type MainMultiRoomControlsProps = {
  room: MultiRoomEntry;
  detail: LiveRoomDetail | undefined;
  playback: PlaybackController;
  player: WebPlayerApi;
  loading: boolean;
  error: unknown;
  audioOnly: boolean;
  onToggleAudioOnly: () => void;
  onRefresh: () => void;
  onVolume: (value: unknown) => void;
  onToggleMute: () => void;
  onControlsOverlayInteractionChange: (open: boolean) => void;
  onComposerOverlayInteractionChange: (open: boolean) => void;
};

function MainMultiRoomControls({
  room,
  detail,
  playback,
  player,
  loading,
  error,
  audioOnly,
  onToggleAudioOnly,
  onRefresh,
  onVolume,
  onToggleMute,
  onControlsOverlayInteractionChange,
  onComposerOverlayInteractionChange,
}: MainMultiRoomControlsProps) {
  const [osdOn, setOsdOn] = useState(false);
  const asrEnabled = useSettingsStore((state) => state.asrEnabled);
  const asrPending = useSettingsStore((state) => state.asrPending);
  const asrWindowSeconds = useSettingsStore((state) => state.asrWindowSeconds);
  const asrFontSize = useSettingsStore((state) => state.asrFontSize);
  const asrSpeakerDiarizationEnabled = useSettingsStore(
    (state) => state.asrSpeakerDiarizationEnabled,
  );
  const asrTranslationEnabled = useSettingsStore((state) => state.asrTranslationEnabled);
  const asrTranslationFrom = useSettingsStore((state) => state.asrTranslationFrom);
  const asrTranslationTo = useSettingsStore((state) => state.asrTranslationTo);
  const setAsrTranslationEnabled = useSettingsStore((state) => state.setAsrTranslationEnabled);
  const setAsrTranslationFrom = useSettingsStore((state) => state.setAsrTranslationFrom);
  const setAsrTranslationTo = useSettingsStore((state) => state.setAsrTranslationTo);
  const setAsrSpeakerDiarizationEnabled = useSettingsStore(
    (state) => state.setAsrSpeakerDiarizationEnabled,
  );
  const danmaku = useDanmakuConnection({
    siteId: room.siteId,
    roomId: room.roomId,
    detailRoomId: detail?.room_id,
    enabled: true,
  });
  const showHost = !loading && error == null && !!playback.playUrl;
  const sessionKey = `multi-room:${room.key}`;
  const asr = useAsrCaptions({
    videoRef: player.videoRef,
    mediaKey: player.mediaKey,
    sessionKey,
    featureEnabled: asrEnabled,
    settingPending: asrPending,
    mediaAvailable: showHost,
    chunkSeconds: asrWindowSeconds,
    translationEnabled: asrTranslationEnabled,
    translationFrom: asrTranslationFrom,
    translationTo: asrTranslationTo,
  });
  const loadError = playback.loadError ?? player.loadError ?? player.fullscreenError;
  const toggleAudioOnly = useCallback(() => {
    if (!audioOnly && player.pictureInPictureActive) {
      void player.togglePictureInPicture();
    }
    onToggleAudioOnly();
  }, [audioOnly, onToggleAudioOnly, player]);
  const floatingDanmakuActive = danmaku.active && osdOn && !audioOnly;

  return (
    <>
      {showHost && !audioOnly && (
        <DanmuJsDanmaku
          active={floatingDanmakuActive}
          sessionKey={sessionKey}
          siteId={room.siteId}
          roomId={detail?.room_id || room.roomId}
          roomTitle={detail?.title || room.title}
          roomUserName={detail?.user_name || room.userName}
          // Fullscreen puts the picture a whole display away, where the compact
          // pill is hard to aim at. Grid cells are small enough already.
          large={player.mode === "fullscreen"}
          className="absolute inset-0 z-10"
        />
      )}
      {showHost && audioOnly && player.running && <AudioOnlyIndicator />}
      {showHost &&
        !audioOnly &&
        (asr.captionsOn || asr.notice) &&
        (asr.notice ||
          asr.caption ||
          asr.translatedCaption ||
          asr.translationNotice ||
          asr.partial) && (
          <div
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className="pointer-events-none absolute inset-x-4 bottom-[4.5rem] z-20 flex justify-center"
          >
            <p
              className={`flex max-h-[min(7em,45dvh)] min-w-0 max-w-[min(48rem,92%)] flex-col justify-end overflow-hidden rounded-md bg-black/78 px-3 py-1.5 text-center leading-relaxed font-medium text-white shadow-md [text-shadow:0_1px_2px_rgb(0_0_0_/_0.9)]${asr.noticeIsError ? " border border-destructive/45 text-red-100" : ""}`}
              style={{ fontSize: `${asrFontSize}px` }}
            >
              {asr.notice ?? (
                <span className="flex shrink-0 flex-col gap-0.5 whitespace-pre-line break-words">
                  {asr.caption ? <span>{asr.caption}</span> : null}
                  {asr.translatedCaption ? (
                    <span
                      lang={asrTranslationTo === "auto" ? undefined : asrTranslationTo}
                      className="text-white/82"
                    >
                      {asr.translatedCaption}
                    </span>
                  ) : null}
                  {asr.translationNotice ? (
                    <span className="text-xs font-normal text-destructive">
                      {asr.translationNotice}
                    </span>
                  ) : null}
                  {asr.partial ? <span className="text-white/60">{asr.partial}</span> : null}
                </span>
              )}
            </p>
          </div>
        )}
      <div className="pointer-events-auto absolute inset-x-0 bottom-0 z-30">
        <PlayerControls
          paused={player.paused}
          volume={player.volume}
          muted={player.muted}
          audioOnly={audioOnly}
          osdOn={osdOn}
          asrVisible={asr.desktopClient}
          asrOn={asr.captionsOn}
          asrLabel={asr.controlLabel}
          asrDisabled={asr.controlDisabled}
          asrBusy={asr.controlBusy}
          asrTranslationEnabled={asrTranslationEnabled}
          asrTranslationFrom={asrTranslationFrom}
          asrTranslationTo={asrTranslationTo}
          asrTranslationBusy={asr.translationPending}
          asrSpeakerDiarizationEnabled={asrSpeakerDiarizationEnabled}
          asrSettingsPending={asrPending}
          qualities={playback.qualities}
          qualityIndex={playback.qualityIndex}
          lines={playback.lines}
          lineIndex={playback.lineIndex}
          fullscreen={player.mode === "fullscreen"}
          pictureInPictureSupported={player.pictureInPictureSupported}
          pictureInPictureActive={player.pictureInPictureActive}
          pictureInPictureDisabled={!player.running || player.mode === "fullscreen" || audioOnly}
          disabled={!showHost}
          refreshDisabled={loading || !playback.playUrl}
          loadError={loadError}
          overlay
          // One cell of the director grid: outside fullscreen there is always
          // more grid below, so the chrome is not on the window's bottom edge.
          stackedBelowPlayer
          portalContainer={player.stageRef}
          centerSlot={
            <DanmakuComposer
              siteId={room.siteId}
              roomId={room.roomId}
              overlay
              onOverlayInteractionChange={onComposerOverlayInteractionChange}
            />
          }
          onOverlayInteractionChange={onControlsOverlayInteractionChange}
          onRefresh={onRefresh}
          onTogglePause={player.togglePause}
          onVolume={(value) => onVolume(value)}
          onToggleMute={onToggleMute}
          onToggleAudioOnly={toggleAudioOnly}
          onToggleOsd={() => setOsdOn((visible) => !visible)}
          onToggleAsr={asr.toggle}
          onAsrTranslationEnabledChange={setAsrTranslationEnabled}
          onAsrTranslationFromChange={setAsrTranslationFrom}
          onAsrTranslationToChange={setAsrTranslationTo}
          onAsrSpeakerDiarizationEnabledChange={setAsrSpeakerDiarizationEnabled}
          onQualityChange={playback.onQualityChange}
          onLineChange={playback.onLineChange}
          onTogglePictureInPicture={() => void player.togglePictureInPicture()}
          onToggleFullscreen={() => void player.toggleFullscreen()}
        />
      </div>
    </>
  );
}

export function MultiRoomPlayer({
  room,
  main,
  dragHandle,
}: {
  room: MultiRoomEntry;
  main: boolean;
  dragHandle?: ReactNode;
}) {
  const setMainRoom = useMultiRoomStore((state) => state.setMainRoom);
  const removeRoom = useMultiRoomStore((state) => state.removeRoom);
  const updateAudio = useMultiRoomStore((state) => state.updateAudio);
  const updateMetadata = useMultiRoomStore((state) => state.updateMetadata);
  const [audioOnly, setAudioOnly] = useState(false);
  const controlsHideTimerRef = useRef<number | null>(null);
  const controlsRef = useRef<HTMLDivElement | null>(null);
  const hudRef = useRef<HTMLDivElement | null>(null);
  const controlsVisibleRef = useRef(true);
  const controlsFocusWithinRef = useRef(false);
  const overlayInteractionOpenRef = useRef(false);
  const overlayInteractionSourcesRef = useRef<Record<MultiRoomOverlayInteractionSource, boolean>>({
    controls: false,
    composer: false,
  });
  const lastControlsActivityAtRef = useRef(Date.now());
  const detailQuery = useQuery({
    queryKey: ["room_detail", room.siteId, room.roomId],
    queryFn: () =>
      invokeCmd<LiveRoomDetail>("site_get_room_detail", {
        siteId: room.siteId,
        roomId: room.roomId,
      }),
  });
  const refetchDetail = detailQuery.refetch;
  const refreshDetail = useCallback(async () => {
    const result = await refetchDetail();
    if (result.isError) throw result.error;
    return result.data;
  }, [refetchDetail]);
  const playback = usePlaybackController({
    siteId: room.siteId,
    roomId: room.roomId,
    detail: detailQuery.data,
    refreshDetail,
    enabled: !!detailQuery.data,
  });
  const player = useWebPlayer({
    playUrl: playback.playUrl,
    siteId: room.siteId,
    quality: playback.qualities[playback.qualityIndex]?.quality ?? null,
    sessionKey: `multi-room:${room.key}`,
    initialVolume: room.volume,
    initialMuted: room.muted,
    // Every feed shares one window, so only the main one may read or drive
    // fullscreen; otherwise all six would report themselves as fullscreen.
    fullscreenOwner: main,
    reloadToken: playback.reloadToken,
    onMediaFailure: playback.onPlayerMediaFailure,
    onPlaying: playback.onPlayerPlaying,
  });
  const playerVolume = player.volume;
  const playerMuted = player.muted;
  const setPlayerAudio = player.setAudio;
  const exitPlayerFullscreen = player.exitFullscreen;

  useEffect(() => {
    if (!main) setAudioOnly(false);
  }, [main]);

  // A feed can be demoted, dragged away or removed while it is the fullscreen
  // stage. Fullscreen belongs to whichever feed is main, so give it up as soon
  // as this one stops being main — including on unmount — instead of leaving
  // the window fullscreen around the whole director grid.
  useEffect(() => {
    if (!main) return;
    return () => {
      void exitPlayerFullscreen();
    };
  }, [exitPlayerFullscreen, main]);

  useEffect(() => {
    if (detailQuery.data) updateMetadata(room.key, detailQuery.data);
  }, [detailQuery.data, room.key, updateMetadata]);

  useEffect(() => {
    if (playerVolume === room.volume && playerMuted === room.muted) return;
    setPlayerAudio(room.volume, room.muted);
  }, [playerMuted, playerVolume, room.muted, room.volume, setPlayerAudio]);

  const detail = detailQuery.data;
  const title = detail?.title || room.title;
  const userName = detail?.user_name || room.userName;
  const userAvatar = detail?.user_avatar;
  const online = detail?.online;
  const cover = normalizeImageUrl(detail?.cover || room.cover);
  const loading = detailQuery.isLoading || playback.loading;
  const error = detailQuery.error ?? playback.error ?? playback.loadError ?? player.loadError;
  const audibleVolume = player.muted ? 0 : player.volume;

  function changeVolume(value: unknown) {
    const volume = Number(value);
    if (!Number.isFinite(volume)) return;
    player.changeVolume(volume);
    updateAudio(room.key, volume, volume === 0);
  }

  function toggleMute() {
    if (player.muted || player.volume === 0) {
      const restoredVolume = room.volume > 0 ? room.volume : 80;
      player.toggleMute();
      updateAudio(room.key, restoredVolume, false);
      return;
    }
    player.toggleMute();
    updateAudio(room.key, player.volume, true);
  }

  function retry() {
    if (detailQuery.isError) {
      void detailQuery.refetch();
      return;
    }
    playback.retryPlay();
  }

  const fullscreen = main && player.mode === "fullscreen";

  const clearControlsHideTimer = useCallback(() => {
    if (controlsHideTimerRef.current === null) return;
    window.clearTimeout(controlsHideTimerRef.current);
    controlsHideTimerRef.current = null;
  }, []);

  const setControlsVisible = useCallback((visible: boolean) => {
    // Room-keyed tiles change roles in place, so stale inert state must always be resynced.
    controlsVisibleRef.current = visible;
    for (const layer of [controlsRef.current, hudRef.current]) {
      if (!layer) continue;
      layer.dataset.visible = visible ? "true" : "false";
      layer.setAttribute("aria-hidden", String(!visible));
      layer.toggleAttribute("inert", !visible);
    }
  }, []);

  const hasKeyboardFocusWithinControls = useCallback(() => {
    if (!controlsFocusWithinRef.current) return false;
    const activeElement = document.activeElement;
    if (!(activeElement instanceof HTMLElement) || !activeElement.matches(":focus-visible")) {
      return false;
    }
    return (
      controlsRef.current?.contains(activeElement) === true ||
      hudRef.current?.contains(activeElement) === true
    );
  }, []);

  const scheduleControlsHide = useCallback(() => {
    clearControlsHideTimer();
    setControlsVisible(true);
    if (
      !main ||
      !player.running ||
      player.paused ||
      overlayInteractionOpenRef.current ||
      hasKeyboardFocusWithinControls()
    ) {
      return;
    }

    const hideWhenIdle = () => {
      const remaining =
        MULTI_ROOM_CONTROLS_HIDE_DELAY_MS - (Date.now() - lastControlsActivityAtRef.current);
      if (remaining > 0) {
        controlsHideTimerRef.current = window.setTimeout(hideWhenIdle, remaining);
        return;
      }
      controlsHideTimerRef.current = null;
      if (
        !main ||
        !player.running ||
        player.paused ||
        overlayInteractionOpenRef.current ||
        hasKeyboardFocusWithinControls()
      ) {
        setControlsVisible(true);
        return;
      }
      setControlsVisible(false);
    };

    controlsHideTimerRef.current = window.setTimeout(
      hideWhenIdle,
      Math.max(
        0,
        MULTI_ROOM_CONTROLS_HIDE_DELAY_MS - (Date.now() - lastControlsActivityAtRef.current),
      ),
    );
  }, [
    clearControlsHideTimer,
    hasKeyboardFocusWithinControls,
    main,
    player.paused,
    player.running,
    setControlsVisible,
  ]);

  const holdControlsVisible = useCallback(() => {
    lastControlsActivityAtRef.current = Date.now();
    clearControlsHideTimer();
    setControlsVisible(true);
  }, [clearControlsHideTimer, setControlsVisible]);

  const revealControls = useCallback(() => {
    lastControlsActivityAtRef.current = Date.now();
    setControlsVisible(true);
    scheduleControlsHide();
  }, [scheduleControlsHide, setControlsVisible]);

  const resumeControlsAutoHide = useCallback(() => {
    lastControlsActivityAtRef.current = Date.now();
    scheduleControlsHide();
  }, [scheduleControlsHide]);

  const handleOverlayInteractionChange = useCallback(
    (source: MultiRoomOverlayInteractionSource, open: boolean) => {
      overlayInteractionSourcesRef.current[source] = open;
      const hasOpenOverlay = Object.values(overlayInteractionSourcesRef.current).some(Boolean);
      overlayInteractionOpenRef.current = hasOpenOverlay;
      if (hasOpenOverlay) holdControlsVisible();
      else resumeControlsAutoHide();
    },
    [holdControlsVisible, resumeControlsAutoHide],
  );

  const handleControlsOverlayInteractionChange = useCallback(
    (open: boolean) => handleOverlayInteractionChange("controls", open),
    [handleOverlayInteractionChange],
  );

  const handleComposerOverlayInteractionChange = useCallback(
    (open: boolean) => handleOverlayInteractionChange("composer", open),
    [handleOverlayInteractionChange],
  );

  const handleChromePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.stopPropagation();
      holdControlsVisible();
    },
    [holdControlsVisible],
  );

  const handleChromeFocusCapture = useCallback(() => {
    controlsFocusWithinRef.current = true;
    holdControlsVisible();
  }, [holdControlsVisible]);

  const handleChromeBlurCapture = useCallback(
    (event: ReactFocusEvent<HTMLDivElement>) => {
      const nextFocused = event.relatedTarget;
      if (
        nextFocused instanceof Node &&
        (controlsRef.current?.contains(nextFocused) === true ||
          hudRef.current?.contains(nextFocused) === true)
      ) {
        controlsFocusWithinRef.current = true;
        holdControlsVisible();
        return;
      }
      controlsFocusWithinRef.current = false;
      resumeControlsAutoHide();
    },
    [holdControlsVisible, resumeControlsAutoHide],
  );

  useEffect(() => {
    controlsFocusWithinRef.current = false;
    overlayInteractionOpenRef.current = false;
    overlayInteractionSourcesRef.current.controls = false;
    overlayInteractionSourcesRef.current.composer = false;
    lastControlsActivityAtRef.current = Date.now();
    setControlsVisible(true);
    scheduleControlsHide();
    return clearControlsHideTimer;
  }, [
    clearControlsHideTimer,
    main,
    player.paused,
    player.running,
    scheduleControlsHide,
    setControlsVisible,
  ]);

  return (
    <article
      ref={player.stageRef}
      data-multi-room-player={room.key}
      data-main={main ? "true" : "false"}
      // Only the main feed carries the stage markers. Fullscreen then lifts
      // this one article out of the 3x3 grid as a fixed, full-window layer
      // (see the [data-player-stage] rule in styles.css) instead of merely
      // growing the window around the whole director matrix.
      data-player-stage={main ? "" : undefined}
      data-fullscreen={fullscreen ? "true" : undefined}
      className="group/player relative size-full min-h-0 overflow-hidden bg-black outline-none"
      tabIndex={0}
      aria-label={`${main ? "主画面" : "副画面"}：${title}`}
      onPointerEnter={main ? revealControls : undefined}
      onPointerMove={main ? revealControls : undefined}
      onPointerDown={main ? revealControls : undefined}
      onPointerLeave={main ? resumeControlsAutoHide : undefined}
      onDoubleClick={() => {
        if (!main) setMainRoom(room.key);
      }}
    >
      {cover && (
        <img
          src={cover}
          alt=""
          draggable={false}
          className="absolute inset-0 size-full object-cover opacity-35"
          referrerPolicy="no-referrer"
        />
      )}
      <div
        ref={player.playerRootRef}
        data-player-engine-root
        className={`absolute inset-0 size-full overflow-hidden bg-black/70${audioOnly ? " invisible" : ""}`}
      >
        <video
          key={player.mediaKey}
          ref={player.videoRef}
          data-player-video
          className="absolute inset-0 size-full bg-black object-contain"
          crossOrigin="anonymous"
          playsInline
          autoPlay
          controls={false}
          disablePictureInPicture={audioOnly}
        />
      </div>

      {loading && !player.running && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <Spinner className="size-7 text-white/80" aria-label="正在加载直播流" />
        </div>
      )}

      {!loading && error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/60 px-4 text-center text-white">
          <CircleAlert className="size-5 text-white/75" aria-hidden />
          <p className="line-clamp-2 text-xs text-white/80">{playbackErrorMessage(error)}</p>
          <Button type="button" variant="secondary" size="sm" onClick={retry}>
            <RefreshCw data-icon="inline-start" aria-hidden />
            重试
          </Button>
        </div>
      )}

      <div
        ref={hudRef}
        data-player-hud={main ? true : undefined}
        data-visible={main ? (controlsVisibleRef.current ? "true" : "false") : undefined}
        aria-hidden={main ? !controlsVisibleRef.current : undefined}
        className={cn(
          "pointer-events-none absolute inset-x-0 top-0 z-30 flex min-w-0 items-center gap-2 bg-gradient-to-b from-black/80 to-transparent p-2 pb-6 text-white opacity-0 transition-opacity",
          main
            ? "[will-change:opacity] duration-150 ease-out motion-reduced:transition-none data-[visible=true]:opacity-100 data-[visible=false]:pointer-events-none data-[visible=false]:opacity-0"
            : "group-focus-within/player:opacity-100 group-hover/player:opacity-100",
        )}
        onPointerEnter={main ? holdControlsVisible : undefined}
        onPointerMove={
          main
            ? (event) => {
                event.stopPropagation();
                holdControlsVisible();
              }
            : undefined
        }
        onPointerDown={main ? handleChromePointerDown : undefined}
        onPointerLeave={main ? resumeControlsAutoHide : undefined}
        onFocusCapture={main ? handleChromeFocusCapture : undefined}
        onBlurCapture={main ? handleChromeBlurCapture : undefined}
      >
        <div className="pointer-events-auto flex min-w-0 flex-1 items-center gap-1.5">
          {dragHandle}
          {main && <Badge variant="secondary">主画面</Badge>}
          <RoomIdentityLine
            siteId={room.siteId}
            roomId={detail?.room_id || room.roomId}
            title={title}
            userName={userName}
            userAvatar={userAvatar}
            online={online}
            density="tile"
            className="flex-1"
          />
        </div>
        <div className="pointer-events-auto flex shrink-0 items-center gap-1">
          {!main && (
            <OverlayIconButton label="设为主画面" onClick={() => setMainRoom(room.key)}>
              <Maximize2 aria-hidden />
            </OverlayIconButton>
          )}
          <OverlayIconButton label="刷新此路" onClick={retry}>
            <RefreshCw aria-hidden />
          </OverlayIconButton>
          <OverlayIconButton label="移除此路" onClick={() => removeRoom(room.key)}>
            <X aria-hidden />
          </OverlayIconButton>
        </div>
      </div>

      {main ? (
        <div
          ref={controlsRef}
          data-player-controls
          data-visible={controlsVisibleRef.current ? "true" : "false"}
          aria-hidden={!controlsVisibleRef.current}
          className="absolute inset-x-0 bottom-0 z-30 [will-change:opacity] transition-opacity duration-150 ease-out motion-reduced:transition-none data-[visible=false]:pointer-events-none data-[visible=false]:opacity-0"
          onPointerEnter={holdControlsVisible}
          onPointerMove={(event) => {
            event.stopPropagation();
            holdControlsVisible();
          }}
          onPointerDown={handleChromePointerDown}
          onPointerLeave={resumeControlsAutoHide}
          onFocusCapture={handleChromeFocusCapture}
          onBlurCapture={handleChromeBlurCapture}
        >
          <MainMultiRoomControls
            room={room}
            detail={detail}
            playback={playback}
            player={player}
            loading={loading}
            error={error}
            audioOnly={audioOnly}
            onToggleAudioOnly={() => setAudioOnly((enabled) => !enabled)}
            onRefresh={retry}
            onVolume={changeVolume}
            onToggleMute={toggleMute}
            onControlsOverlayInteractionChange={handleControlsOverlayInteractionChange}
            onComposerOverlayInteractionChange={handleComposerOverlayInteractionChange}
          />
        </div>
      ) : (
        <div className="absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-gradient-to-t from-black/85 to-transparent p-2 pt-7 text-white opacity-0 transition-opacity group-focus-within/player:opacity-100 group-hover/player:opacity-100">
          <OverlayIconButton
            label={player.paused ? "继续播放" : "暂停播放"}
            onClick={player.togglePause}
            disabled={!playback.playUrl}
          >
            {player.paused ? <Play aria-hidden /> : <Pause aria-hidden />}
          </OverlayIconButton>
          <OverlayIconButton
            label={player.muted || player.volume === 0 ? "取消静音" : "静音"}
            onClick={toggleMute}
            disabled={!playback.playUrl}
          >
            {player.muted || player.volume === 0 ? (
              <VolumeX aria-hidden />
            ) : (
              <Volume2 aria-hidden />
            )}
          </OverlayIconButton>
          <Slider
            className="min-w-16 max-w-36 flex-1"
            aria-label={`${title}音量`}
            value={audibleVolume}
            min={0}
            max={100}
            step={1}
            disabled={!playback.playUrl}
            onValueChange={changeVolume}
          />
          <output className="w-8 shrink-0 text-right text-[10px] tabular-nums text-white/70">
            {audibleVolume}%
          </output>
        </div>
      )}
    </article>
  );
}
