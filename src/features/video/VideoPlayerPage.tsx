import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useQuery, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import {
  Captions,
  CaptionsOff,
  Cast,
  Check,
  ChevronLeft,
  ExternalLink,
  FastForward,
  Home,
  Link2,
  Smartphone,
} from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { getClientPlatform } from "@/shared/clientPlatform";
import { preloadImageProxy } from "@/shared/api/imageProxy";
import { Button } from "@/components/ui/button";
import { DrawerScope, DrawerViewport } from "@/components/ui/drawer";
import { Field, FieldLabel } from "@/components/ui/field";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Button as MediaButton } from "@/components/videojs/ui/button";
import { ButtonTooltip } from "@/components/videojs/ui/button-tooltip";
import { ErrorState } from "@/shared/components/ErrorState";
import {
  AsrSettingsBody,
  PLAYER_HUD_BUTTON_CLASS,
  PLAYER_HUD_ICON_CLASS,
  PLAYER_HUD_TITLE_SIZE_CLASS,
  PlayerControls,
  VOD_PLAYBACK_RATES,
  formatPlaybackRateLabel,
  PlayerMenuRadioGroup,
  type PlayerMenuRadioOption,
} from "@/shared/components/player/PlayerControls";
import { useCompactPlayerViewport, usePortraitOrientation } from "@/shared/hooks/usePlayerViewport";
import { usePlayerChromeIdle } from "@/shared/hooks/usePlayerChromeIdle";
import { usePlayerEdgeGesture } from "@/shared/hooks/usePlayerEdgeGesture";
import { usePlayerStageTapGestures } from "@/shared/hooks/usePlayerStageTapGestures";
import { isTouchLikePointer } from "@/shared/gestures/playerEdgeGesture";
import { LONG_PRESS_SPEED_RATE, LONG_PRESS_TRIGGER_MS } from "@/shared/gestures/longPress";
import {
  PlayerBrightnessShade,
  PlayerEdgeGestureFeedback,
} from "@/shared/components/player/PlayerEdgeGestureOverlays";
import {
  PlayerFullscreenLock,
  showPlayerFullscreenLock,
} from "@/shared/components/player/PlayerFullscreenLock";
import { useScreenWakeLock } from "@/shared/hooks/useScreenWakeLock";
import { copyText } from "@/shared/clipboard";
import { openExternalUrl } from "@/shared/externalUrl";
import { canNavigateBackInApp } from "@/shared/appHistory";
import {
  DEFAULT_PLAYER_VOLUME,
  readPlayerVolume,
  rememberPlayerVolume,
} from "@/shared/playerVolume";
import { cn } from "@/lib/utils";
import {
  createVideoJsPlayer,
  isInterruptedPlayRequest,
  loadVideoJsModules,
  videoJsPlayerErrorMessage,
  type VideoJsPlaybackKind,
  type VideoJsPlayerInstance,
} from "@/features/room/player/videoJsPlayer";
import { requestPlayerAutoplay } from "@/features/room/player/autoplay";
import {
  useVideoJsPiP,
  useVideoJsPlaybackRate,
  VideoJsContainer,
  VideoJsPlayerProvider,
  VideoJsVideo,
} from "@/features/room/player/videoJsControls";
import { useAndroidPlayerControls } from "@/features/room/player/androidPlayerControls";
import {
  videoAspectRatio,
  useAndroidFullscreenOrientation,
} from "@/features/room/player/androidOrientation";
import { runningOnAndroidTauri } from "@/features/room/player/androidImmersive";
import { useRecordingPlayerFullscreen } from "@/features/recording/useRecordingPlayerFullscreen";
import type {
  VideoHistoryItem,
  VideoHistoryKind,
  VideoItem,
  VideoPlayInfo,
  VideoSessionIds,
} from "@/shared/types/video";
import { DanmakuComposer } from "@/features/room/BilibiliDanmakuComposer";
import {
  videoGetArchive,
  videoGetCastUrl,
  videoGetDanmaku,
  videoGetPlayInfo,
  videoGetRelated,
  videoGetSeason,
  videoGetStoryboard,
  videoGetSubtitle,
  videoGetSubtitles,
  videoStopPlay,
} from "./videoApi";
import {
  formatVideoDuration,
  videoHistoryAdd,
  videoHistoryFind,
  videoPgcEntryEpisode,
  videoResumeCid,
  videoResumePosition,
  VIDEO_HISTORY_QUERY_KEY,
} from "./videoHistory";
import { videoSeekGestureIntent, videoSeekGestureTarget } from "./videoSurfaceGesture";
import { createVideoWaitingRecovery, type VideoWaitingRecovery } from "./videoWaitingRecovery";
import { isWatchProgressWorthKeeping, shouldReportWatchProgress } from "@/shared/watchProgress";
import { subtitleJsonToVtt } from "./subtitleVtt";
import { storyboardToVtt } from "./storyboardVtt";
import { CastMenu } from "@/features/room/CastMenu";
import { applyWebPlayerAudio } from "@/features/room/player/useWebPlayer";
import { useAsrCaptions } from "@/features/asr/useAsrCaptions";
import { AsrCaptionOverlay } from "@/features/asr/AsrCaptionOverlay";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import {
  PlayerHudOverflowMenu,
  PlayerToolPanel,
  PlayerToolTile,
} from "@/shared/components/player/PlayerHudMenu";
import {
  glassMutedTextClass,
  glassOptionClass,
  glassOptionSelectedClass,
  glassPanelClass,
  glassSeparatorClass,
} from "@/shared/components/player/glassSurface";
import { VideoDanmakuLayer } from "./VideoDanmakuLayer";
import { VideoSidebar, type SidebarTab } from "./VideoSidebar";
import { useHoverOpen } from "@/components/videojs/lib/use-hover-open";
import { mediaPopupTriggerOpenClass } from "@/components/videojs/lib/popup-surface";
import {
  mergeVideoDanmakuEntries,
  videoDanmakuEntries,
  videoDanmakuSegmentsFor,
  type VideoDanmakuEntry,
} from "./videoDanmaku";
import {
  VIDEO_HOME_PATH,
  parseVideoPlayParams,
  videoOriginalUrl,
  videoPlayPath,
} from "./videoRoute";
import { shortsPath } from "@/features/shorts/shortsFeed";
import {
  dedupeVideoItems,
  nextSelectionItem,
  playlistContainsCurrentItem,
  playlistItemFromArchivePage,
  playlistItemFromVideoItem,
  usePlaylistStore,
  videoEndedAction,
  type PlaylistItem,
} from "./playlistStore";
import { notify, setToastPortalContainer } from "@/components/ui/toast";

/** 自动连播相关视频的等待时长：播完后留出反悔时间，也比换集慢一拍。 */
const RELATED_AUTOPLAY_DELAY_MS = 3_000;
/** 移动超过这个距离视为滑动手势，取消长按判定。 */
const LONG_PRESS_CANCEL_MOVE_PX = 12;
/**
 * 手势认领后封锁点按识别器的时长（ms）。
 *
 * 必须盖住识别器自身的双击判定窗口（约 200ms）：滑动/长按抬手后到达的延迟单击、
 * 以及与下一次轻点凑成的双击，都要在这段时间里被否决。取值同量级于共享横滑的
 * click 抑制（420ms）但更短，滑动之后有意的连点仍然来得及生效。
 */
const SURFACE_TAP_SUPPRESSION_MS = 300;

function relatedPlaylistItems(
  items: readonly VideoItem[] | undefined,
  currentBvid: string,
): PlaylistItem[] {
  return dedupeVideoItems(items?.filter((item) => item.bvid !== currentBvid) ?? []).map(
    playlistItemFromVideoItem,
  );
}

function isPlayerControlTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(
    target.closest(
      'button, a, input, select, textarea, [contenteditable="true"], [role="button"], [role="slider"], [role="dialog"], [data-player-controls], [data-player-hud], [data-player-fullscreen-lock]',
    ),
  );
}

/**
 * `/video/play`：B 站视频（VOD）播放页。
 *
 * 与录制回放（`RecordingPlayer`）共用同一套 chrome —— `PlayerControls`、
 * 全屏适配器、紧凑视口与屏幕常亮 —— 因为它们是同一类表面：一条有确定时长、
 * 可拖进度的本地代理媒体。差别只在协议内核（DASH）与弹幕调度源。
 */
export function VideoPlayerPage() {
  return (
    <VideoJsPlayerProvider>
      <DrawerScope>
        <VideoPlayerPageContent />
      </DrawerScope>
    </VideoJsPlayerProvider>
  );
}

function VideoPlayerPageContent() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const detailsRef = useRef<HTMLElement | null>(null);
  const params = parseVideoPlayParams(searchParams);

  const stageRef = useRef<HTMLDivElement | null>(null);
  const hudRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const playerRef = useRef<VideoJsPlayerInstance | null>(null);
  const controlsRef = useRef<HTMLDivElement | null>(null);
  const lockRef = useRef<HTMLDivElement | null>(null);
  const [fullscreenLocked, setFullscreenLocked] = useState(false);
  // 长按倍速的临时状态全在 ref 里：按住期间不应触发重渲染（弹幕层在动，
  // 状态更新会打扰合成器），只有角标的显示与否走 state。
  const speedHoldTimerRef = useRef<number | null>(null);
  const speedHoldRef = useRef(false);
  const speedHoldRestoreRateRef = useRef(1);
  /**
   * 被手势认领过的按压对点按识别器的封锁截止时刻（`Date.now()` 毫秒）。
   *
   * 用截止时刻而不是布尔量：识别器的单击回调要等满双击窗口才触发，双击回调更晚，
   * 那时这次按压早已结束。若在下一次 pointerdown 把标志清零，一次横滑之后紧跟的
   * 轻点就会与滑动那一下凑成「双击」，凭空切换播放状态。窗口按抬手时刻续期，
   * 越过它的点按才重新算数。
   */
  const suppressTapUntilRef = useRef(0);
  /**
   * 画面上这一次按压的完整归属。
   *
   * `mode` 是显式的所有权而不是若干并列布尔量：横向 seek、长按倍速与左右半屏
   * 亮度/音量共享同一次 pointer session，谁认领了指针必须一眼可读，否则会出现
   * 「方向已判定却没有手势接手」的空档（横向滑动此前既不调节也不快进就是这个空档）。
   */
  const surfacePressRef = useRef<{
    pointerId: number;
    x: number;
    y: number;
    mode: "pending" | "seek";
    /** pointerdown 时算出的候选资格，方向锁定时据此选归属。 */
    seek: boolean;
    moved: boolean;
    width: number;
    /** 本次拖动的 seek 基准：按下瞬间的媒体位置与该分集时长。 */
    startTime: number;
    duration: number;
    seekTarget: number;
  } | null>(null);
  const seekPreviewRef = useRef<HTMLDivElement | null>(null);
  const seekPreviewTimeRef = useRef<HTMLSpanElement | null>(null);
  const seekPreviewDeltaRef = useRef<HTMLSpanElement | null>(null);
  /** 上次记住的音量与静音态：所有会话级播放表面共享一份（见 shared/playerVolume）。 */
  const [initialAudio] = useState(() =>
    runningOnAndroidTauri() ? { volume: 100, muted: false } : readPlayerVolume(),
  );
  const volumeRef = useRef(initialAudio.volume);
  const mutedRef = useRef(initialAudio.muted);
  const previousVolumeRef = useRef(initialAudio.volume);

  const [loading, setLoading] = useState(true);
  const [waiting, setWaiting] = useState(false);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [paused, setPaused] = useState(true);
  const [muted, setMuted] = useState(initialAudio.muted);
  const [volume, setVolume] = useState(initialAudio.volume);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [frameSize, setFrameSize] = useState<{
    key: string;
    ratio: number | null;
  } | null>(null);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab | null>(null);
  const [danmakuVisible, setDanmakuVisible] = useState(true);
  const [playerRevision, setPlayerRevision] = useState(0);
  const [speedHoldActive, setSpeedHoldActive] = useState(false);
  const [overlayInteractionOpen, setOverlayInteractionOpen] = useState(false);
  /** 期望画质（null = 后端自选最高可用档）。切换后带着它重取播放信息。 */
  const [qualityQn, setQualityQn] = useState<number | null>(null);
  /** 仅音频（听视频）：跳过视频轨代理省流，切换时记录续播点后重建播放器。 */
  const [audioOnly, setAudioOnly] = useState(false);

  useEffect(() => {
    // 播放器模块与取流 IPC 同时准备，所有画幅共用已有 import 缓存。
    void loadVideoJsModules(audioOnly ? "native" : "dash").catch(() => {});
  }, [audioOnly]);
  const pictureInPicture = useVideoJsPiP();
  const playbackRate = useVideoJsPlaybackRate();
  /** 投屏面板与 CC 字幕弹层的开关态。投屏面板住在 HUD 溢出菜单里
   *  （`PlayerToolPanel` + `CastMenu`），窗口化与全屏同一入口。 */
  const [castOpen, setCastOpen] = useState(false);
  /** 全屏 HUD 右上角 `⋮` 溢出菜单的开关态（与直播页 HUD 同一形态）。 */
  const [hudMenuOpen, setHudMenuOpen] = useState(false);
  /** 正在投屏的设备名（null = 无会话），供入口磁贴展示「投屏中」。 */
  const [castingDevice, setCastingDevice] = useState<string | null>(null);
  const [subtitleOpen, setSubtitleOpen] = useState(false);
  const setSubtitleMenuOpen = useCallback((open: boolean) => {
    setSubtitleOpen(open);
  }, []);
  // 字幕按钮悬停展开与控制栏播放设置菜单同一套时序（useHoverOpen 带
  // 嵌套弹层防护：本地字幕设置里的 Select 展开期间不收起）。
  const subtitleHover = useHoverOpen(subtitleOpen, setSubtitleMenuOpen);
  /** 窗口全屏（应用内全屏）：隐藏页面 chrome（顶栏/侧栏/底部 Shell）让舞台
   *  撑满应用窗口，但保留系统窗口栏（最小化/最大化/关闭），与直播页的
   *  网页全屏同一语义；与画面全屏（元素级 top layer）相互独立、可叠加。 */
  const [webFullscreen, setWebFullscreen] = useState(false);
  /** 选中的字幕语言（null = 关闭字幕）。 */
  const [subtitleLan, setSubtitleLan] = useState<string | null>(null);
  /** 当前字幕的 VTT blob 地址。 */
  const [subtitleVttUrl, setSubtitleVttUrl] = useState<string | null>(null);
  const asrEnabled = useSettingsStore((state) => state.asrEnabled);
  const asrPending = useSettingsStore((state) => state.asrPending);
  const asrWindowSeconds = useSettingsStore((state) => state.asrWindowSeconds);
  const asrFontSize = useSettingsStore((state) => state.asrFontSize);
  const asrTranslationEnabled = useSettingsStore((state) => state.asrTranslationEnabled);
  const asrTranslationFrom = useSettingsStore((state) => state.asrTranslationFrom);
  const asrTranslationTo = useSettingsStore((state) => state.asrTranslationTo);
  const asrSpeakerDiarizationEnabled = useSettingsStore(
    (state) => state.asrSpeakerDiarizationEnabled,
  );
  const setAsrTranslationEnabled = useSettingsStore((state) => state.setAsrTranslationEnabled);
  const setAsrTranslationFrom = useSettingsStore((state) => state.setAsrTranslationFrom);
  const setAsrTranslationTo = useSettingsStore((state) => state.setAsrTranslationTo);
  const setAsrSpeakerDiarizationEnabled = useSettingsStore(
    (state) => state.setAsrSpeakerDiarizationEnabled,
  );
  // 记住重建前的位置与播放状态：画质/仅音频/重试都会重建播放器（新的代理端口
  // = 新的 MPD 地址），不存就会从头播。快照带上当时的 videoKey —— 换集后旧
  // key 的快照自动作废，否则上一集的卡顿现场（waiting）会被下一集当成续播点。
  // 记录方在 videoKey 之前定义，经 ref 读它：进 deps 会撞 TDZ，靠闭包又会
  // 捕获旧值（回调按其他依赖记忆），只有 ref 两边都避得开。
  const videoKeyRef = useRef("");
  const resumeAtRef = useRef<{ key: string; position: number; playing: boolean } | null>(null);
  // 用户在起播完成前按过暂停。自动起播的静音重试必须尊重它，
  // 否则卡加载时点暂停会被重试重新拉起，按钮状态与实际播放相反。
  const userPausedRef = useRef(false);

  /**
   * 进入下一轮播放会话。它不读取媒体 ref，既供 waiting 控制器的惰性初始化
   * 安全持有，也作为手动重试完成现场快照后的统一重建入口。
   */
  const advancePlaybackSession = useCallback(() => {
    setPlaybackError(null);
    setWaiting(false);
    setLoading(true);
    setPlayerRevision((revision) => revision + 1);
  }, []);

  /** 手动重建前记录当前位置；自动恢复已在 waiting 事件发生时记录现场。 */
  const rebuildPlaybackSession = useCallback(() => {
    const media = videoRef.current;
    if (media && media.currentTime > 0) {
      resumeAtRef.current = {
        key: videoKeyRef.current,
        position: media.currentTime,
        playing: !media.paused,
      };
    }
    advancePlaybackSession();
  }, [advancePlaybackSession]);

  // 点播 waiting 自动恢复：超时判定/预算/稳定重置收在纯逻辑模块（见
  // ./videoWaitingRecovery），页面只把媒体事件喂进去、把决策接回上面的重建
  // 链路。惰性 state 初始化只创建一次控制器；控制器本身不参与渲染。
  const [waitingRecovery] = useState<VideoWaitingRecovery>(() =>
    createVideoWaitingRecovery({
      onAutoRetry: () => advancePlaybackSession(),
      onExhausted: () => {
        // 自动预算耗尽：改走可见错误面板，把重试交还给用户（retryPlayback 会
        // 清预算，手动重试不受影响）。
        setPlaybackError("视频长时间无响应，自动恢复未成功。请点击重试，或稍后再试");
        setLoading(false);
        setWaiting(false);
      },
    }),
  );

  /**
   * 手动重试（错误面板的重试按钮、HUD 的刷新播放）：用户亲自出手视同预算
   * 重置，再走与自动恢复同一条重建链路。
   */
  const retryPlayback = useCallback(() => {
    waitingRecovery.notifyManualRetry();
    rebuildPlaybackSession();
  }, [rebuildPlaybackSession, waitingRecovery]);

  const compact = useCompactPlayerViewport();
  const portraitOrientation = usePortraitOrientation();
  const clientPlatform = getClientPlatform();
  const mobileClient = clientPlatform !== "desktop";
  const {
    revealControls,
    toggleControls,
    holdControlsVisible,
    scheduleControlsHide,
    dismissControls,
  } = usePlayerChromeIdle({
    controlsRef,
    hudRef,
    lockRef,
    fullscreenLocked,
    keepVisible:
      paused ||
      loading ||
      waiting ||
      Boolean(playbackError) ||
      overlayInteractionOpen ||
      subtitleOpen,
  });
  const fullscreen = useRecordingPlayerFullscreen(stageRef, () => {
    if (!fullscreenLocked) return true;
    revealControls();
    return false;
  });
  const { exit: fullscreenExit, toggle: fullscreenToggle } = fullscreen;
  const fullscreenLockMounted = showPlayerFullscreenLock(fullscreen.fullscreen);
  useScreenWakeLock(!paused && !loading && !playbackError);

  useEffect(() => {
    if (!fullscreen.fullscreen) return;
    setToastPortalContainer(stageRef.current);
    return () => setToastPortalContainer(null);
  }, [fullscreen.fullscreen]);

  const rawCid = params?.cid ?? 0;

  // 番剧 / 影视卡片直入：链接只带 season（索引/排行榜接口都不给 bvid/cid），
  // 先取 season 详情挑出要播的那一集，再把 URL 规范成带完整取流键的形态
  // （replace，不占返回栈）。挑集规则与历史卡一致：上次看到的那一集还挂在
  // 分集表里就进它，否则首集；换集仍走右侧栏「分集」。bvid/cid 已在手
  // （搜索、历史、分集链路）时不经此路径。
  const seasonEntry = params && params.cid <= 0 && !params.bvid ? params.seasonId : null;
  const entrySeasonQuery = useQuery({
    queryKey: ["video_season", seasonEntry ?? "", ""],
    enabled: seasonEntry !== null,
    queryFn: () => videoGetSeason({ seasonId: seasonEntry! }),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const entryHistoryQuery = useQuery({
    // 与下方续播查询同 key 形状与选项：这里读过的记录，播放页挂上同 key
    // 查询时可能仍在缓存里直接复用；被回收了也只是多一次本地读盘。
    queryKey: ["video_history_resume", "pgc", seasonEntry ?? ""],
    enabled: seasonEntry !== null,
    queryFn: () => videoHistoryFind("pgc", seasonEntry!),
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
  });

  useEffect(() => {
    if (seasonEntry === null) return;
    const season = entrySeasonQuery.data;
    // 历史也落定后才挑集：它慢半拍就把人打发到首集，续播语义就破了。
    if (!season || entryHistoryQuery.isPending) return;
    // 空分集（版权/地区限制）不跳转，留在直入失败态给出可读解释。
    const episode = videoPgcEntryEpisode(season.episodes, entryHistoryQuery.data);
    if (!episode) return;
    navigate(
      videoPlayPath({
        bvid: episode.bvid,
        cid: episode.cid,
        epId: episode.ep_id,
        title: season.title,
        aid: episode.aid,
      }),
      { replace: true },
    );
  }, [
    seasonEntry,
    entrySeasonQuery.data,
    entryHistoryQuery.data,
    entryHistoryQuery.isPending,
    navigate,
  ]);

  // 稿件详情：搜索/UP 列表条目没有 cid 时补齐取流键（P1），同时取 UGC 合集——
  // 稿件属于合集时连播沿合集走。与右侧栏 archive 查询同 key、同 staleTime，
  // 共享一次请求。PGC（epId）有专属分集接口，不经此路径。
  const archiveQuery = useQuery({
    queryKey: ["video_archive", params?.bvid ?? ""],
    enabled: Boolean(params?.bvid) && !params?.epId,
    queryFn: () => videoGetArchive(params!.bvid!),
    staleTime: 5 * 60_000,
    retry: false,
  });

  // PGC 剧集详情：观看历史按「作品」去重，PGC 的作品标识是 season_id，而 URL 只带
  // ep_id，必须靠它换出 season_id 与剧集名。与右侧栏 season 查询同 key、同
  // staleTime，共享一次请求（侧栏本来就要这份数据，这里不额外发起网络请求）。
  const seasonQuery = useQuery({
    queryKey: ["video_season", "", params?.epId ?? ""],
    enabled: Boolean(params?.epId),
    queryFn: () => videoGetSeason({ epId: params!.epId! }),
    staleTime: 5 * 60_000,
    retry: false,
  });

  /**
   * 本次播放属于哪部作品，即观看历史的主键。
   *
   * 刻意不经 `cid` 推导：跨分 P 续播要拿这条历史反过来决定播哪一个 cid，
   * 身份若再依赖 cid 就成了环。UGC 的 oid 是 URL 直接给的 bvid，
   * PGC 的 oid 是 season_id（要等 season 详情换出来）。
   */
  const historyKind: VideoHistoryKind | null = !params
    ? null
    : params.epId
      ? "pgc"
      : params.bvid
        ? "ugc"
        : null;
  const historyOid = (params?.epId ? seasonQuery.data?.season_id : params?.bvid) ?? "";

  /**
   * 这部作品上次看到哪。
   *
   * 独立的 key 前缀（不是 `VIDEO_HISTORY_QUERY_KEY`）：历史页清空/删除时按
   * `["video-history"]` 前缀写缓存，续播查询的数据形状是单条记录而不是列表，
   * 混在同一前缀下会被写成数组。`staleTime: Infinity` 让它一次解析后不再变动——
   * 边看边上报会不断改写这部作品的历史，但续播位置只在进页时有意义。
   */
  const resumeQuery = useQuery({
    queryKey: ["video_history_resume", historyKind ?? "", historyOid],
    enabled: historyKind !== null && historyOid.length > 0,
    queryFn: () => videoHistoryFind(historyKind!, historyOid),
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
  });
  /** 身份已定但历史还没查完：播放器要等它，否则先从 0 播再跳会闪一下。 */
  const resumePending = resumeQuery.isPending && historyKind !== null && historyOid.length > 0;
  // 取流键。URL 带了就用它（用户明确点的那一集）；只带 bvid 进来（首页/搜索/UP 主
  // 卡片）时，上次看到一半的那一 P 优先于详情给的 P1 —— 「上次退出的地方」包含
  // 「上次看的是哪一 P」。续播查询未落定前保持 0：先按 P1 取流再切到上次那一 P
  // 会白起一轮代理会话，还要多一次播放器重建。
  const cid =
    rawCid > 0 ? rawCid : resumePending ? 0 : videoResumeCid(resumeQuery.data, archiveQuery.data);
  // 弹幕发送历史与 PGC 分集都用 aid；URL 直入时用详情补齐。
  const aid = params?.aid || archiveQuery.data?.aid || null;

  const videoKey = `${params?.bvid ?? params?.epId ?? ""}:${cid}`;
  // 渲染期不读 ref：内容键同步给记录续播快照的回调。
  useLayoutEffect(() => {
    videoKeyRef.current = videoKey;
  }, [videoKey]);
  const frameAspectRatio = frameSize?.key === videoKey ? frameSize.ratio : null;
  const androidPlayerControls = useAndroidPlayerControls(clientPlatform === "android", videoKey);
  const nativePlayerControlsActive = androidPlayerControls.supported;
  const playerControlVolume = androidPlayerControls.state?.mediaVolume ?? volume;
  const playerControlMuted = androidPlayerControls.state
    ? androidPlayerControls.state.mediaVolume <= 0
    : muted;
  // 旋转与全屏绑定：转到横屏自动全屏，转回竖屏自动退出（仅限自动进来的那次）。
  useAndroidFullscreenOrientation({
    enabled: clientPlatform === "android",
    fullscreen: fullscreen.fullscreen,
    aspectRatio: frameAspectRatio,
    isLandscape: !portraitOrientation,
    enterFullscreen: fullscreenToggle,
    exitFullscreen: fullscreenExit,
  });

  const [lockSession, setLockSession] = useState({
    fullscreen: fullscreen.fullscreen,
    videoKey,
  });
  if (lockSession.fullscreen !== fullscreen.fullscreen || lockSession.videoKey !== videoKey) {
    setLockSession({ fullscreen: fullscreen.fullscreen, videoKey });
    setFullscreenLocked(false);
  }

  /**
   * 本次播放要写进观看历史的那一行。
   *
   * `oid` 为空表示身份还没解析出来（PGC 的 season 详情未到、或 UGC 连 bvid 都没有），
   * 此时不上报——宁可漏记开头几秒，也不能写一行认不出是哪部作品的历史。
   */
  const historyEntry = useMemo<VideoHistoryItem | null>(() => {
    if (!params || historyKind === null || historyOid.length === 0) return null;
    const watchedAt = 0; // 上报时取当前时间，这里只组装身份与元数据。
    if (historyKind === "pgc") {
      const season = seasonQuery.data;
      const episode = season?.episodes.find((item) => item.ep_id === params.epId) ?? null;
      if (!season) return null;
      return {
        kind: "pgc",
        oid: historyOid,
        title: season.title,
        cover: episode?.cover || season.cover,
        // 剧集没有单一作者，副行留给分集标题。
        author: "",
        part_title: episode?.long_title || episode?.title || "",
        bvid: episode?.bvid ?? "",
        cid: episode?.cid ?? params.cid,
        ep_id: params.epId ?? "",
        aid: episode?.aid || params.aid || "",
        progress: 0,
        duration: 0,
        watched_at: watchedAt,
      };
    }
    const archive = archiveQuery.data;
    // 分 P 标题：多 P 稿件才有意义，单 P 稿件的 pages 为空，留空即可。
    const part = archive?.pages.find((page) => page.cid === cid) ?? null;
    return {
      kind: "ugc",
      // UGC 的 oid 就是 bvid，两个字段同源。
      oid: historyOid,
      // 详情未到时用 URL 带的标题兜底：至少历史里不是空标题。
      title: archive?.title || params.title || "",
      cover: archive?.cover ?? "",
      author: archive?.author ?? "",
      part_title: part ? part.part || `P${part.page}` : "",
      bvid: historyOid,
      cid,
      ep_id: "",
      aid: aid ?? "",
      progress: 0,
      duration: 0,
      watched_at: watchedAt,
    };
  }, [aid, archiveQuery.data, cid, historyKind, historyOid, params, seasonQuery.data]);

  // 播放器 effect 只依赖播放地址，不该因为历史/元数据变化就重建播放器，
  // 因此这三样经 ref 读取。
  const historyEntryRef = useRef<VideoHistoryItem | null>(null);
  // 离开播放页的路由切换会先以 params=null 再渲染一次(此时 entry 为 null)再卸载,
  // 若直接赋值,卸载 flush 读到的会是 null,最后一段进度就丢了。因此只在新身份
  // 存在时覆盖:离开页面时 ref 保留旧作品,flush 仍能对上 reportedCid。
  const historyResumeAtRef = useRef(0);
  useLayoutEffect(() => {
    if (historyEntry) historyEntryRef.current = historyEntry;
    historyResumeAtRef.current = videoResumePosition(resumeQuery.data, {
      cid,
      epId: params?.epId ?? null,
    });
  }, [cid, historyEntry, params?.epId, resumeQuery.data]);
  /**
   * 跨分 P 续播的提示。
   *
   * 同一分 P 内的位置续播是静默的（用户看到的还是他点开的那个内容），但落到
   * 别的一 P 是内容身份的变化，不说一声会让人以为点错了。按 cid 记忆去重，
   * 换画质/重试不会重复弹。
   */
  const crossPartNoticeRef = useRef(0);
  useEffect(() => {
    const archive = archiveQuery.data;
    if (rawCid > 0 || cid <= 0 || !archive || cid === archive.cid) return;
    if (crossPartNoticeRef.current === cid) return;
    crossPartNoticeRef.current = cid;
    const part = archive.pages.find((page) => page.cid === cid);
    notify.info(
      part ? `已续播上次观看的 P${part.page}` : "已续播上次观看的分 P",
      part?.part || undefined,
    );
  }, [archiveQuery.data, cid, rawCid]);

  /** 这一集上次写盘的时刻；null = 还没写过。换集时由播放器 effect 重置。 */
  const historyReportedAtRef = useRef<number | null>(null);

  const queryClient = useQueryClient();

  /**
   * 把进度写进本地观看历史。
   *
   * 身份经 `historyEntryRef` 读取而不是闭包捕获:稿件详情(标题/封面/UP 主)晚于
   * 播放器就位,捕获旧值会把这些字段写成空。错位风险由 `reportProgress` 里的
   * `reportedCid` 比对挡住——换集后 ref 指向新集,旧实例的 flush 因此被丢弃。
   * `force` 用于暂停/播完/离开这三个「最后一次」的时机,绕过节流窗口。
   * 失败只吞掉——历史是本地记账,不该让它的故障打断播放。
   */
  const reportVideoProgress = useCallback(
    (entry: VideoHistoryItem, position: number, totalDuration: number, force: boolean) => {
      const now = Date.now();
      if (force) {
        if (!isWatchProgressWorthKeeping(position)) return;
      } else if (!shouldReportWatchProgress(position, historyReportedAtRef.current, now)) {
        return;
      }
      historyReportedAtRef.current = now;
      void videoHistoryAdd({
        ...entry,
        progress: position,
        duration: totalDuration > 0 ? totalDuration : 0,
        watched_at: now,
      })
        .then(() => queryClient.invalidateQueries({ queryKey: VIDEO_HISTORY_QUERY_KEY }))
        .catch(() => undefined);
    },
    [queryClient],
  );
  const playlistStore = usePlaylistStore();
  const nextItem = playlistStore.getNextItem();
  const prevItem = playlistStore.getPreviousItem();
  const bvid = params?.bvid ?? null;
  const epId = params?.epId ?? null;

  /**
   * 控制条「播放下一个」的目标：当前视频自身选集里的下一项。它与来源队列无关，
   * 没有选集或已在最后一集时为 null（按钮随之不出现）。
   */
  const selectionNextItem = nextSelectionItem({
    epId,
    bvid,
    cid,
    episodes: seasonQuery.data?.episodes,
    archive: archiveQuery.data,
  });

  /** 自动连播、控件、快捷键与滑动共用导航；滑动不往返回栈里逐条堆视频。 */
  const goToPlaylistItem = useCallback(
    (item: PlaylistItem, replace = false) => {
      navigate(
        videoPlayPath({
          bvid: item.bvid,
          cid: item.cid,
          epId: item.epId,
          title: item.title,
          aid: item.aid,
        }),
        { replace },
      );
    },
    [navigate],
  );

  /** 来源队列没有下一项时，按相关视频接口顺序建立新的推荐队列并跳转。 */
  const playRelatedItem = useCallback(
    (canNavigate: () => boolean) => {
      void queryClient
        .fetchQuery({
          queryKey: ["video_related", bvid ?? ""],
          queryFn: () => videoGetRelated(bvid!),
          staleTime: 5 * 60_000,
        })
        .then((page) => {
          if (!canNavigate()) return;
          const items = relatedPlaylistItems(page.items, bvid ?? "");
          const target = items[0];
          if (!target) return;
          const state = usePlaylistStore.getState();
          state.setPlaylist(items, target.id, "feed");
          goToPlaylistItem(target);
        })
        .catch(() => undefined);
    },
    [bvid, goToPlaylistItem, queryClient],
  );

  // 只响应路由身份变化：点相关/投稿卡片会先装新队列，再提交导航，
  // 不能因 store 更新而拿旧路由把新队列清空或抢回旧选集。若新视频不在旧队列中，
  // 立即丢弃旧队列，避免结束事件在稿件详情到达前沿用推荐页的下一项。
  useEffect(() => {
    const list = usePlaylistStore.getState();
    const matchesCurrent =
      Boolean(bvid) &&
      (playlistContainsCurrentItem(list.items, bvid, rawCid) ||
        (cid > 0 && playlistContainsCurrentItem(list.items, bvid, cid)));
    if (matchesCurrent) {
      const currentId = `${bvid}_${rawCid}`;
      if (list.currentId !== currentId && list.items.some((item) => item.id === currentId)) {
        list.setCurrentItem(currentId);
      }
      return;
    }
    if (bvid && (rawCid > 0 || cid > 0) && list.items.length > 0) list.clearPlaylist();
  }, [bvid, cid, rawCid]);

  // PGC 分集不经 archiveQuery：进入的剧集不在播放列表（epId 维度，UGC
  // 列表项的 epId 恒为 null）时，那份列表是残留快照，同样清空——否则
  // 「下一个」会跳回之前看过的 UGC 视频。侧栏「播放全部」/「加入列表」
  // 装好分集列表后含当前 epId，不受影响。
  useEffect(() => {
    const list = usePlaylistStore.getState();
    if (!epId || list.items.length === 0) return;
    if (list.items.some((item) => item.epId === epId)) return;
    list.clearPlaylist();
  }, [epId]);

  // 来源队列优先；没有有效来源时才为多 P 直链建立选集队列。
  // 合集只展示在侧栏，不能凭稿件元数据接管推荐、搜索或 UP 投稿顺序。
  useEffect(() => {
    const archive = archiveQuery.data;
    const list = usePlaylistStore.getState();
    if (!archive || !bvid || cid <= 0) return;
    if (
      playlistContainsCurrentItem(list.items, bvid, rawCid) ||
      playlistContainsCurrentItem(list.items, bvid, cid)
    )
      return;
    if (archive.pages.length > 0) {
      list.setPlaylist(
        archive.pages.map((page) => playlistItemFromArchivePage(archive.bvid, archive.aid, page)),
        `${bvid}_${cid}`,
        "sequence",
      );
    } else if (list.items.length > 0) {
      list.clearPlaylist();
    }
  }, [archiveQuery.data, bvid, cid, rawCid]);

  /**
   * 取播放信息。
   *
   * 每次进入播放页都重新取而不是复用缓存：后端在这一步拉起三条代理会话并合成 MPD，
   * 缓存命中会返回一份指向**已经停掉**的会话的 MPD 地址。`staleTime: 0` +
   * `gcTime: 0` 让这条 query 与代理会话同生命周期。
   */
  const playInfoQuery = useQuery({
    queryKey: [
      "video_play_info",
      cid,
      params?.bvid ?? "",
      params?.epId ?? "",
      qualityQn,
      audioOnly,
      playerRevision,
    ],
    enabled: params !== null && cid > 0,
    queryFn: () =>
      videoGetPlayInfo({
        bvid: params?.bvid ?? null,
        cid,
        ep_id: params?.epId ?? null,
        qn: qualityQn,
        audio_only: audioOnly,
      }),
    // 换画质/重试期间保留旧数据：旧播放器继续播到新信息就位，而不是先黑屏等请求。
    placeholderData: keepPreviousData,
    gcTime: 0,
    retry: false,
  });
  // 换集（cid 变）过渡期不能沿用旧集数据：keepPreviousData 留下的旧 playInfo
  // 会让旧播放器继续显示旧画面（直到新集就位），seek/时长/画质也是旧集的值。
  // 换画质/重试（同 cid）仍走 keepPreviousData 的无缝续播路径。VideoPlayInfo
  // 不回传 cid，用「数据与 cid 对齐时刻」的 cid 比对判定。
  const [settledCid, setSettledCid] = useState<number | null>(null);
  if (!playInfoQuery.isPlaceholderData && settledCid !== cid) setSettledCid(cid);
  const switchingItem = playInfoQuery.isPlaceholderData && settledCid !== cid;
  const playInfo: VideoPlayInfo | undefined = switchingItem ? undefined : playInfoQuery.data;

  // 换集过渡：清掉旧集的播放错误并停住旧画面/声音（playInfo 已抹成 undefined，
  // 播放器 effect 会随之销毁旧实例），等新集信息就位再重建。
  const [wasSwitchingItem, setWasSwitchingItem] = useState(switchingItem);
  if (switchingItem !== wasSwitchingItem) {
    setWasSwitchingItem(switchingItem);
    if (switchingItem) {
      setPlaybackError(null);
      setPaused(true);
    }
  }
  useEffect(() => {
    if (!switchingItem) return;
    const media = videoRef.current;
    if (media && !media.paused) media.pause();
  }, [switchingItem]);

  /** 切换画质：记录续播点后带着 qn 重取。 */
  const changeQuality = useCallback(
    (qn: number) => {
      if (qn === qualityQn) return;
      const media = videoRef.current;
      if (media) {
        resumeAtRef.current = {
          key: videoKeyRef.current,
          position: media.currentTime,
          playing: !media.paused,
        };
      }
      setQualityQn(qn);
    },
    [qualityQn],
  );

  /** 仅音频（听视频）：与切画质同一重建链路（记录续播点 → 重取播放信息）。 */
  const toggleAudioOnly = useCallback(() => {
    const media = videoRef.current;
    if (media) {
      resumeAtRef.current = {
        key: videoKeyRef.current,
        position: media.currentTime,
        playing: !media.paused,
      };
    }
    const nextAudioOnly = !audioOnly;
    if (nextAudioOnly && pictureInPicture?.pip) {
      void pictureInPicture.exitPictureInPicture().catch(() => undefined);
    }
    setAudioOnly(nextAudioOnly);
  }, [audioOnly, pictureInPicture]);

  // CC 字幕列表：多数稿件没有，空列表/失败都按无字幕处理（按钮直接不渲染）。
  const subtitlesQuery = useQuery({
    queryKey: ["video_subtitles", cid, params?.bvid ?? "", params?.epId ?? ""],
    enabled: cid > 0,
    queryFn: () =>
      videoGetSubtitles({
        bvid: params?.bvid ?? null,
        cid,
        ep_id: params?.epId ?? null,
      }),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const subtitles = useMemo(() => subtitlesQuery.data ?? [], [subtitlesQuery.data]);

  // 视频缩略图（storyboard）快照：无快照或纯音频不请求。
  const storyboardQuery = useQuery({
    queryKey: ["video_storyboard", cid, bvid ?? "", epId ?? ""],
    enabled: cid > 0 && !audioOnly,
    queryFn: async () => {
      // 雪碧图必须经本机图片代理（videoshot CDN 拒绝非 bilibili Referer），
      // 而代理端口是异步取回的。先等它就绪，否则 VTT 可能烧进直连 URL ——
      // VTT 只在快照数据变化时重算，错过就是整页没有缩略图。
      await preloadImageProxy();
      return videoGetStoryboard({ bvid, cid, ep_id: epId });
    },
    staleTime: 10 * 60_000,
    retry: false,
  });

  const [storyboardVttUrl, setStoryboardVttUrl] = useState<string | null>(null);
  const storyboardData = storyboardQuery.data;
  useEffect(() => {
    if (!storyboardData) {
      // oxlint-disable-next-line react/set-state-in-effect
      setStoryboardVttUrl(null);
      return;
    }
    const vtt = storyboardToVtt(storyboardData, duration);
    if (!vtt) {
      // oxlint-disable-next-line react/set-state-in-effect
      setStoryboardVttUrl(null);
      return;
    }
    const objectUrl = URL.createObjectURL(new Blob([vtt], { type: "text/vtt" }));
    // oxlint-disable-next-line react/set-state-in-effect
    setStoryboardVttUrl(objectUrl);
    return () => {
      URL.revokeObjectURL(objectUrl);
    };
  }, [storyboardData, duration]);

  // 投屏直链：打开弹层时才取（html5 playurl 的 MP4，与主播放链路无关）。
  const castQuery = useQuery({
    queryKey: ["video_cast_url", cid, params?.bvid ?? "", params?.epId ?? ""],
    enabled: castOpen && cid > 0,
    queryFn: () =>
      videoGetCastUrl({
        bvid: params?.bvid ?? null,
        cid,
        ep_id: params?.epId ?? null,
      }),
    staleTime: 5 * 60_000,
    retry: false,
  });

  const sessionIdsRef = useRef<VideoSessionIds | null>(null);
  // 用 query 的原始数据而不是上面换集时被抹成 undefined 的 `playInfo`：
  // session 链必须 A→B 连续（见下），中间出现 undefined 会丢掉旧引用、泄漏会话。
  useLayoutEffect(() => {
    if (playInfoQuery.data) sessionIdsRef.current = playInfoQuery.data.session_ids;
  }, [playInfoQuery.data]);
  useEffect(
    () => () => {
      const sessions = sessionIdsRef.current;
      sessionIdsRef.current = null;
      if (sessions) void videoStopPlay(sessions);
    },
    [],
  );
  // 换画质/重试会换一份 session_ids；旧的那份要在新的替换它之前停掉。
  const previousSessionsRef = useRef<VideoSessionIds | null>(null);
  useEffect(() => {
    const previous = previousSessionsRef.current;
    const current = playInfoQuery.data;
    previousSessionsRef.current = current?.session_ids ?? null;
    if (previous && current && previous.mpd !== current.session_ids.mpd) {
      void videoStopPlay(previous);
    }
  }, [playInfoQuery.data]);

  /**
   * 弹幕分段懒加载。
   *
   * 6 分钟一段，按播放进度取当前段与下一段（跨段的滚动弹幕要提前入场，见
   * `videoDanmakuSegmentsFor`）。已请求过的段号不再请求；`has_more === false`
   * 表示段号越界，之后不再向更大的段号推进。
   */
  const [danmakuEntries, setDanmakuEntries] = useState<readonly VideoDanmakuEntry[]>([]);
  const loadedSegmentsRef = useRef(new Map<number, readonly VideoDanmakuEntry[]>());
  const exhaustedFromRef = useRef<number | null>(null);
  const inFlightSegmentsRef = useRef(new Set<number>());
  // 在途请求计数与「是否已有段落定」驱动弹幕栏的加载态：空结果只有在本段
  // 请求落定之后才能宣布「暂无弹幕」，否则无弹幕视频的弹幕栏会永远转圈。
  const [danmakuRequestsInFlight, setDanmakuRequestsInFlight] = useState(0);
  const [danmakuSegmentSettled, setDanmakuSegmentSettled] = useState(false);
  // 弹幕开关只影响这个 ref 的读数，不进 `ensureDanmakuSegments` 的依赖：
  // 播放器 effect 依赖那个回调，若它的身份随开关变化，开关弹幕会把整个播放器
  // 销毁重建、从 0 秒重播（弹幕是叠加层，没有理由动到媒体本身）。
  const danmakuVisibleRef = useRef(danmakuVisible);
  useLayoutEffect(() => {
    danmakuVisibleRef.current = danmakuVisible;
  }, [danmakuVisible]);

  // 换视频要丢掉上一条的弹幕，否则新视频会投放旧视频的内容。
  const [danmakuCid, setDanmakuCid] = useState(cid);
  if (danmakuCid !== cid) {
    setDanmakuCid(cid);
    setDanmakuEntries([]);
    setDanmakuSegmentSettled(false);
  }
  useEffect(() => {
    loadedSegmentsRef.current = new Map();
    inFlightSegmentsRef.current = new Set();
    exhaustedFromRef.current = null;
  }, [cid]);

  const ensureDanmakuSegments = useCallback(
    (positionMs: number) => {
      if (!cid || !danmakuVisibleRef.current) return;
      // 换视频会把 map/set 换成新实例；在途请求带着旧引用回来时据此丢弃，
      // 否则旧视频的段落会写进新视频的弹幕里。
      const segmentsMap = loadedSegmentsRef.current;
      const inFlight = inFlightSegmentsRef.current;
      for (const segment of videoDanmakuSegmentsFor(positionMs)) {
        const exhaustedFrom = exhaustedFromRef.current;
        if (exhaustedFrom !== null && segment >= exhaustedFrom) continue;
        if (segmentsMap.has(segment)) continue;
        if (inFlight.has(segment)) continue;
        inFlight.add(segment);
        setDanmakuRequestsInFlight((count) => count + 1);
        void videoGetDanmaku(cid, segment)
          .then((result) => {
            if (loadedSegmentsRef.current !== segmentsMap) return;
            segmentsMap.set(segment, videoDanmakuEntries(result.items, segment));
            // `has_more === false` 是上游 HTTP 304 的封装：这一段之后没有内容了。
            if (!result.has_more) {
              exhaustedFromRef.current =
                exhaustedFromRef.current === null
                  ? segment + 1
                  : Math.min(exhaustedFromRef.current, segment + 1);
            }
            setDanmakuSegmentSettled(true);
            setDanmakuEntries(mergeVideoDanmakuEntries([...segmentsMap.values()]));
          })
          .catch(() => {
            // 单段失败不影响其余段落；下次经过这个位置会再试一次。
            // 失败不算落定：加载态继续为真，比误报「暂无弹幕」诚实。
          })
          .finally(() => {
            inFlight.delete(segment);
            setDanmakuRequestsInFlight((count) => count - 1);
          });
      }
    },
    [cid],
  );

  // 首屏与开启弹幕时先把 0 位置那一段拉起来。
  useEffect(() => {
    if (danmakuVisible) ensureDanmakuSegments(0);
  }, [danmakuVisible, ensureDanmakuSegments]);

  const seekTo = useCallback(
    (target: number) => {
      const media = videoRef.current;
      if (!media || !Number.isFinite(target)) return;
      // 上限离时长留 0.25s 余量：跳到正正好 duration 会被媒体元素当成播放结束，
      // 留余量让最后一帧真的播出来、再自然触发 ended（自动连播走它的正常路径）。
      const clamped = Math.max(0, duration > 0 ? Math.min(target, duration - 0.25) : target);
      setCurrentTime(clamped);
      setWaiting(true);
      // DASH 的 seek 走原生 `currentTime`，Video.js DASH 适配器会按当前位置处理分片。
      // 不维护播放器私有分片时间轴补丁。
      media.currentTime = clamped;
    },
    [duration],
  );

  const mpdUrl = playInfo?.mpd_url;
  // 仅音频时直接播音轨地址并使用浏览器原生媒体能力；视频轨使用 Video.js 的 DASH 适配器。
  const playUrl = playInfo?.audio_only ? playInfo.audio_url : mpdUrl;
  const playKind: VideoJsPlaybackKind = playInfo?.audio_only ? "native" : "dash";
  // Video.js 的 dash.js 适配器原生处理带 SegmentList 的 MPD，不再维护私有分片时间轴补丁。

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !playUrl) return;
    // 续播位置还没查出来就先不建播放器：先从 0 起播再跳会让画面闪一下，
    // 而这条查询是本地 SQLite，通常早于 playUrl（网络请求）就位。
    if (resumePending) return;
    const media = video;
    let cancelled = false;
    let endedTimer: ReturnType<typeof setTimeout> | null = null;
    let endedSequence = 0;
    // 初始续播 seek：DASH 的时间轴要等清单异步解析（loadedmetadata），媒体源
    // 就绪前写 currentTime 会被丢弃。先记下目标，等 onReady 的真实媒体事件
    // 一次性应用；此后的用户 seek 不再被覆盖。
    let pendingInitialSeek: { position: number; playing: boolean } | null = null;
    // 这一轮播放器对应的分集。上报前用它比对 ref 里的身份，
    // 避免换集过渡期把旧集进度记到新集身上。
    const reportedCid = cid;
    // 换集/换画质都会重建播放器：节流窗口按播放器实例重置，
    // 新的一集因此能立刻记下第一笔。
    historyReportedAtRef.current = null;

    // 初始化外部媒体会话时同步 UI，后续状态由媒体事件接管。
    // oxlint-disable-next-line react/set-state-in-effect
    setLoading(true);
    setWaiting(false);
    setPlaybackError(null);
    setPaused(true);
    userPausedRef.current = false;
    setCurrentTime(0);
    setDuration(playInfo?.duration ?? 0);
    // 本轮播放器会话向 waiting 自动恢复登记：同 key 续用预算，换 key 重置；
    // 上一会话挂起的计时在模块内随之作废。
    waitingRecovery.beginSession(videoKey);

    /** 当前分集的总时长：后端算出的值优先，缺失时退回媒体元数据。 */
    function totalDuration() {
      const fromInfo = playInfo?.duration ?? 0;
      if (fromInfo > 0) return fromInfo;
      return Number.isFinite(media.duration) && media.duration > 0 ? media.duration : 0;
    }
    /**
     * 上报这一集的进度。
     *
     * 只在 ref 里的身份仍指向本播放器实例正在播的这一集时才上报：换集后
     * 清理函数里的最后一次 flush 会读到新集的身份，写下去就是错位的进度。
     */
    function reportProgress(position: number, force: boolean) {
      const entry = historyEntryRef.current;
      if (!entry || entry.cid !== reportedCid) return;
      reportVideoProgress(entry, position, totalDuration(), force);
    }

    function syncTime() {
      if (cancelled) return;
      const actual = Number.isFinite(media.currentTime) ? Math.max(0, media.currentTime) : 0;
      setCurrentTime(actual);
      ensureDanmakuSegments(actual * 1_000);
      reportProgress(actual, false);
    }
    function syncDuration() {
      if (cancelled) return;
      // 后端从 sidx 时间轴累加出的时长比媒体元数据更早可用也更精确；
      // 只有它缺失时才退回 `media.duration`。
      const fromInfo = playInfo?.duration ?? 0;
      if (fromInfo > 0) return;
      if (Number.isFinite(media.duration) && media.duration > 0) setDuration(media.duration);
    }
    function onPlay() {
      if (cancelled) return;
      endedSequence += 1;
      setPaused(false);
      setWaiting(false);
      setLoading(false);
      waitingRecovery.notifyResumed();
    }
    function onPause() {
      if (cancelled) return;
      setPaused(true);
      // 暂停是「可能马上要走」的最强信号：立刻落盘，不等节流窗口。
      reportProgress(Number.isFinite(media.currentTime) ? media.currentTime : 0, true);
      // 用户暂停不该被自动恢复拉起：waiting 判定计时随之作废。
      waitingRecovery.notifyPaused();
    }
    function syncAspectRatio() {
      if (!cancelled) setFrameSize({ key: videoKey, ratio: videoAspectRatio(media) });
    }
    function onReady() {
      if (cancelled) return;
      setLoading(false);
      setWaiting(false);
      syncTime();
      syncDuration();
      syncAspectRatio();
      // canplay/loadedmetadata 说明数据重新流动：即使引擎没补发 playing，
      // 也别让上一轮 waiting 的判定计时继续空转。
      waitingRecovery.notifyResumed();
      // 加载态时间轴不可操作；元数据就绪后一次性应用待续播位置。
      if (pendingInitialSeek) {
        const initialSeek = pendingInitialSeek;
        pendingInitialSeek = null;
        // loadedmetadata 早于任何画面解码，在这里续播不会闪出 0 秒帧。
        media.currentTime = initialSeek.position;
        setCurrentTime(initialSeek.position);
        // 用户在加载期间按过暂停就保持暂停，不被自动续播重新拉起。
        if (initialSeek.playing && !userPausedRef.current) {
          void media.play().catch(() => {
            // 自动续播被策略拦截时留在暂停态，用户点一下即可。
          });
        }
      }
    }
    function onPlaying() {
      if (cancelled) return;
      setWaiting(false);
      setLoading(false);
      // 缓冲恢复的权威信号：waiting 判定计时必须在这里解除。play 事件只在
      // 暂停→播放转换时触发，覆盖不了卡顿恢复；漏掉 playing 会让正常播放
      // 中的视频被看门狗误重建、耗尽预算后弹出错误面板。
      waitingRecovery.notifyResumed();
    }
    function onWaiting() {
      if (cancelled) return;
      if (!media.ended) setWaiting(true);
      // 自动恢复回调本身不读取 ref；在真实媒体事件里保存最后可续播位置。
      if (!media.ended && !media.paused) {
        if (media.currentTime > 0) {
          resumeAtRef.current = { key: videoKey, position: media.currentTime, playing: true };
        }
        waitingRecovery.notifyWaiting();
      }
    }
    function onSeeked() {
      if (cancelled) return;
      setWaiting(false);
      // seek 的短暂 waiting 到此解除：判定计时取消，稳定播放重新起算。
      waitingRecovery.notifyResumed();
    }
    function syncAudio() {
      if (cancelled) return;
      const nextVolume = Math.round(media.volume * 100);
      const nextMuted = media.muted || nextVolume === 0;
      volumeRef.current = nextVolume;
      mutedRef.current = nextMuted;
      if (nextVolume > 0) previousVolumeRef.current = nextVolume;
      setVolume(nextVolume);
      setMuted(nextMuted);
    }
    function onEnded() {
      if (cancelled) return;
      if (endedTimer !== null) clearTimeout(endedTimer);
      const sequence = ++endedSequence;
      setPaused(true);
      setWaiting(false);
      setLoading(false);
      waitingRecovery.notifyEnded();
      // 播完记满进度：历史卡的进度条画到底，续播判定据此认定「已看完」并从头播。
      const total = totalDuration();
      reportProgress(total > 0 ? total : media.currentTime, true);
      // 偏好可能在播放期间被改，读 store 快照而不是播放器挂载时的闭包值。
      const state = usePlaylistStore.getState();
      const nextItem = state.getNextAutoPlayItem();
      const action = videoEndedAction(
        state.loopPlayback,
        state.autoPlayNext,
        nextItem !== null,
        // PGC 剧集没有相关视频列表，也没有可定位的 bvid，开关对它不生效。
        state.autoPlayRelated && !epId && Boolean(bvid),
      );
      if (action === "loop") {
        // 等 dash.js 本轮结束处理里的 pause 完成，再从头播放。
        endedTimer = setTimeout(() => {
          if (
            cancelled ||
            sequence !== endedSequence ||
            !playerRef.current?.ended ||
            userPausedRef.current ||
            !usePlaylistStore.getState().loopPlayback
          )
            return;
          media.currentTime = 0;
          void media.play().catch(() => {
            // 自动重播被浏览器策略拦下时留在暂停态，用户点一下即可。
          });
        }, 0);
        return;
      }
      if (action === "stop") return;
      /**
       * 跳转前重读一遍状态：等待期间用户可能自己换了片、按了暂停，或关掉了
       * 正在生效的那个连播开关。`action` 已经定下这一轮走哪条路，这里只校验
       * 它对应开关的现值。
       */
      const stillWanted = () => {
        const current = usePlaylistStore.getState();
        if (
          cancelled ||
          sequence !== endedSequence ||
          !playerRef.current?.ended ||
          userPausedRef.current ||
          current.loopPlayback
        )
          return false;
        return action === "related" ? current.autoPlayRelated : current.autoPlayNext;
      };
      // 自动连播相关视频是「看完了随便接着看」，比换集多留两秒。
      const delay = action === "related" ? RELATED_AUTOPLAY_DELAY_MS : 1_000;
      endedTimer = setTimeout(() => {
        if (action === "next") {
          if (stillWanted() && nextItem) goToPlaylistItem(nextItem);
          return;
        }
        playRelatedItem(stillWanted);
      }, delay);
    }

    media.volume = volumeRef.current / 100;
    media.muted = mutedRef.current;
    media.addEventListener("timeupdate", syncTime);
    media.addEventListener("durationchange", syncDuration);
    media.addEventListener("loadedmetadata", onReady);
    media.addEventListener("canplay", onReady);
    media.addEventListener("resize", syncAspectRatio);
    media.addEventListener("play", onPlay);
    media.addEventListener("playing", onPlaying);
    media.addEventListener("pause", onPause);
    media.addEventListener("waiting", onWaiting);
    media.addEventListener("seeked", onSeeked);
    media.addEventListener("volumechange", syncAudio);

    void loadVideoJsModules(playKind)
      .then((modules) => {
        if (cancelled) return;
        const player = createVideoJsPlayer(modules, {
          video: media,
          url: playUrl,
          kind: playKind,
          isLive: false,
        });
        playerRef.current = player;
        player.on("ended", onEnded);
        player.on("error", (cause) => {
          if (cancelled) return;
          setPlaybackError(videoJsPlayerErrorMessage(cause, "视频播放失败"));
          setLoading(false);
          setWaiting(false);
          waitingRecovery.notifyError();
        });
        // 进页自动起播，与直播同源：先试带声音的 play()，被自动播放策略拒绝时
        // 降级为静音起播再立刻尝试恢复声音；用户手动静音过则保持静音。
        // 续播位置不直接写 currentTime：DASH 的 MPD 清单异步解析，媒体时间轴
        // 就绪前写入会被丢弃（画质切换/仅音频切换同走这条重建路径）。登记为
        // pendingInitialSeek，由 onReady 的 loadedmetadata/canplay 一次性应用。
        // 只有同一集的快照才算续播点：换集后留着的是上一集的卡顿/重试现场，
        // 照搬会把新点开的那一集跳到错误位置（改走历史续播或从头播）。
        const snapshot = resumeAtRef.current;
        resumeAtRef.current = null;
        const resume = snapshot?.key === videoKey ? snapshot : null;
        if (resume) {
          pendingInitialSeek = {
            position: resume.position,
            playing: resume.playing,
          };
          setCurrentTime(resume.position);
        } else {
          const historyResumeAt = historyResumeAtRef.current;
          if (historyResumeAt > 0) {
            pendingInitialSeek = { position: historyResumeAt, playing: false };
            setCurrentTime(historyResumeAt);
          }
          const recoverMutedAutoplay = () => {
            if (mutedRef.current) return false;
            mutedRef.current = false;
            setMuted(false);
            return true;
          };
          requestPlayerAutoplay(
            player,
            media,
            () => !cancelled && playerRef.current === player && !userPausedRef.current,
            recoverMutedAutoplay,
          );
        }
      })
      .catch((cause) => {
        if (cancelled) return;
        setPlaybackError(videoJsPlayerErrorMessage(cause, "无法初始化视频播放器"));
        setLoading(false);
      });

    return () => {
      // 销毁前记下最后一次进度:媒体元素此刻还能读 currentTime。
      // 放在 `cancelled = true` 之前,让它与其它 flush 走同一条 reportProgress。
      reportProgress(Number.isFinite(media.currentTime) ? media.currentTime : 0, true);
      cancelled = true;
      if (endedTimer !== null) clearTimeout(endedTimer);
      // 播放器会话拆除：waiting 自动恢复的判定计时随之作废（新会话另行登记）。
      waitingRecovery.endSession();
      media.removeEventListener("timeupdate", syncTime);
      media.removeEventListener("durationchange", syncDuration);
      media.removeEventListener("loadedmetadata", onReady);
      media.removeEventListener("canplay", onReady);
      media.removeEventListener("resize", syncAspectRatio);
      media.removeEventListener("play", onPlay);
      media.removeEventListener("playing", onPlaying);
      media.removeEventListener("pause", onPause);
      media.removeEventListener("waiting", onWaiting);
      media.removeEventListener("seeked", onSeeked);
      media.removeEventListener("volumechange", syncAudio);
      const player = playerRef.current;
      playerRef.current = null;
      try {
        player?.pause();
        player?.destroy();
      } catch {
        // 协议插件可能已经释放了它的 MediaSource。
      }
    };
  }, [
    bvid,
    cid,
    epId,
    ensureDanmakuSegments,
    goToPlaylistItem,
    playUrl,
    playInfo?.duration,
    playKind,
    playRelatedItem,
    reportVideoProgress,
    resumePending,
    videoKey,
    waitingRecovery,
  ]);

  const togglePlayback = useCallback(() => {
    const player = playerRef.current;
    const media = videoRef.current;
    if (!player || !media) return;
    if (media.paused) {
      userPausedRef.current = false;
      void Promise.resolve(player.play()).catch((cause) => {
        if (isInterruptedPlayRequest(cause)) return;
        setPlaybackError(videoJsPlayerErrorMessage(cause, "播放失败"));
      });
    } else {
      userPausedRef.current = true;
      player.pause();
    }
  }, []);

  const previewPlayerVolume = useCallback((next: number) => {
    const clamped = Math.max(0, Math.min(100, next));
    volumeRef.current = clamped;
    mutedRef.current = clamped === 0;
    const media = videoRef.current;
    if (media) applyWebPlayerAudio(media, clamped, clamped === 0);
  }, []);

  const commitPlayerVolume = useCallback((next: number, nextMuted: boolean) => {
    const clamped = Math.max(0, Math.min(100, next));
    const silent = nextMuted || clamped === 0;
    volumeRef.current = clamped;
    mutedRef.current = silent;
    if (clamped > 0) previousVolumeRef.current = clamped;
    const media = videoRef.current;
    if (media) applyWebPlayerAudio(media, clamped, silent);
    setVolume(clamped);
    setMuted(silent);
  }, []);

  const setPlayerVolume = useCallback(
    (next: number) => {
      if (nativePlayerControlsActive && androidPlayerControls.setMediaVolume(next)) return;
      commitPlayerVolume(next, next === 0);
    },
    [androidPlayerControls, commitPlayerVolume, nativePlayerControlsActive],
  );

  // 音量记忆：状态每变一档就落盘。同一个值不会触发重渲染，因此一次拖动最多
  // 写它经过的档位数，不需要额外节流。
  useEffect(() => {
    if (nativePlayerControlsActive) return;
    rememberPlayerVolume(volume, muted);
  }, [muted, nativePlayerControlsActive, volume]);

  // 选中的字幕轨 → 后端代拉 JSON → 转 VTT blob；换语言时回收旧 blob。
  const subtitleUrl = subtitles.find((item) => item.lan === subtitleLan)?.url;
  useEffect(() => {
    // Blob 的寿命属于本次外部请求；切轨时清空，清理时释放，updater 保持纯函数。
    // oxlint-disable-next-line react/set-state-in-effect
    setSubtitleVttUrl(null);
    if (!subtitleUrl) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    videoGetSubtitle(subtitleUrl)
      .then((raw) => {
        if (cancelled) return;
        const vtt = subtitleJsonToVtt(raw);
        if (!vtt) return;
        objectUrl = URL.createObjectURL(new Blob([vtt], { type: "text/vtt" }));
        setSubtitleVttUrl(objectUrl);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [subtitleUrl]);

  // 把 VTT 挂到媒体元素（<track> 原生渲染）；换源重建媒体元素后重挂。
  useEffect(() => {
    const media = videoRef.current;
    if (!media) return;
    for (const track of media.querySelectorAll('track[kind="subtitles"]')) track.remove();
    if (!subtitleVttUrl) return;
    const track = document.createElement("track");
    track.kind = "subtitles";
    track.srclang = subtitleLan ?? "zh";
    track.label = subtitles.find((item) => item.lan === subtitleLan)?.lan_doc ?? "字幕";
    track.src = subtitleVttUrl;
    media.appendChild(track);
    track.track.mode = "showing";
  }, [subtitleLan, subtitleVttUrl, playUrl, subtitles]);

  // 把缩略图（storyboard）VTT 挂到媒体元素（供 Video.js TimeSlider 缩略图预览使用）。
  useEffect(() => {
    const media = videoRef.current;
    if (!media) return;
    for (const track of media.querySelectorAll('track[data-track-kind="thumbnails"]')) {
      track.remove();
    }
    if (!storyboardVttUrl) return;
    const track = document.createElement("track");
    track.kind = "metadata";
    track.label = "thumbnails";
    track.default = true;
    track.setAttribute("data-track-kind", "thumbnails");
    track.src = storyboardVttUrl;
    media.appendChild(track);
    track.track.mode = "hidden";
  }, [storyboardVttUrl, playUrl]);

  // 语音字幕（本地 ASR）：与直播间、IPTV 共用同一条管线。点播的媒体元素跨会话
  // 复用（不按 key 重建），因此 mediaKey 取播放器换代计数、sessionKey 取稿件
  // 身份 + 取流地址 —— 换集、换画质与切「仅音频」都会重建取流，识别状态必须
  // 随之清空，否则下一段字幕会从上一段语句中间续写。
  const asr = useAsrCaptions({
    videoRef,
    mediaKey: playerRevision,
    sessionKey: `vod:${videoKey}:${playUrl ?? "idle"}`,
    featureEnabled: asrEnabled,
    settingPending: asrPending,
    mediaAvailable: Boolean(playUrl) && !loading && !switchingItem && !playbackError,
    chunkSeconds: asrWindowSeconds,
    translationEnabled: asrTranslationEnabled,
    translationFrom: asrTranslationFrom,
    translationTo: asrTranslationTo,
  });

  /** 横向 seek 的目标时间预览。逐帧写 DOM，不走 React 状态：弹幕层与画面都在动。 */
  const showSeekPreview = useCallback((target: number, total: number, delta: number) => {
    const root = seekPreviewRef.current;
    if (!root) return;
    root.dataset.visible = "true";
    if (seekPreviewTimeRef.current) {
      seekPreviewTimeRef.current.textContent = `${formatVideoDuration(target)} / ${formatVideoDuration(total)}`;
    }
    if (seekPreviewDeltaRef.current) {
      const seconds = Math.round(delta);
      seekPreviewDeltaRef.current.textContent = `${seconds >= 0 ? "+" : "-"}${Math.abs(seconds)} 秒`;
    }
  }, []);

  const hideSeekPreview = useCallback(() => {
    const root = seekPreviewRef.current;
    if (root) root.dataset.visible = "false";
  }, []);

  /** 认领手势时封锁点按识别器，并在抬手时续期（延迟回调那时才到）。 */
  const suppressSurfaceTaps = useCallback(() => {
    suppressTapUntilRef.current = Date.now() + SURFACE_TAP_SUPPRESSION_MS;
  }, []);

  const engageSpeedHold = useCallback(() => {
    // 长按已经认领这次按压：此后的位移只用来取消倍速，不再转成 seek。
    const press = surfacePressRef.current;
    if (press) press.seek = false;
    const media = videoRef.current;
    // DASH 的 media.duration 可能为 Infinity，使用已有的真实分片时长。
    if (!media || !playbackRate || duration <= 0 || loading || playbackError) return;
    speedHoldRef.current = true;
    suppressSurfaceTaps();
    speedHoldRestoreRateRef.current = playbackRate.playbackRate;
    playbackRate.setPlaybackRate(LONG_PRESS_SPEED_RATE);
    setSpeedHoldActive(true);
  }, [duration, loading, playbackError, playbackRate, suppressSurfaceTaps]);

  const releaseSpeedHold = useCallback(() => {
    if (speedHoldTimerRef.current !== null) {
      window.clearTimeout(speedHoldTimerRef.current);
      speedHoldTimerRef.current = null;
    }
    if (!speedHoldRef.current) return;
    speedHoldRef.current = false;
    playbackRate?.setPlaybackRate(speedHoldRestoreRateRef.current);
    setSpeedHoldActive(false);
  }, [playbackRate]);

  const cancelPendingSurfaceActions = useCallback(() => {
    suppressSurfaceTaps();
    surfacePressRef.current = null;
    hideSeekPreview();
    releaseSpeedHold();
  }, [hideSeekPreview, releaseSpeedHold, suppressSurfaceTaps]);

  const edgeGesture = usePlayerEdgeGesture({
    enabled: mobileClient && !fullscreenLocked && !loading && !playbackError,
    volume,
    muted,
    onPreviewVolume: previewPlayerVolume,
    onCommitVolume: commitPlayerVolume,
    native: nativePlayerControlsActive ? androidPlayerControls : null,
    nativeState: androidPlayerControls.state,
    isIgnoredTarget: isPlayerControlTarget,
    onAdjustStart: cancelPendingSurfaceActions,
    sessionKey: videoKey,
  });
  const {
    cancel: edgeGestureCancel,
    start: edgeGestureStart,
    move: edgeGestureMove,
    end: edgeGestureEnd,
    brightnessShadeRef: edgeGestureBrightnessShadeRef,
    feedback: edgeGestureFeedback,
  } = edgeGesture;

  const cancelSurfacePress = useCallback(() => {
    edgeGestureCancel();
    if (surfacePressRef.current) suppressSurfaceTaps();
    surfacePressRef.current = null;
    hideSeekPreview();
    releaseSpeedHold();
  }, [edgeGestureCancel, hideSeekPreview, releaseSpeedHold, suppressSurfaceTaps]);

  /**
   * 长按倍速会改写播放倍数，`useVideoJsPlaybackRate()` 随之返回新对象，
   * `releaseSpeedHold` -> `cancelSurfacePress` 的 identity 因此逐层失效。
   * 下面的窗口监听若直接依赖这个回调，engage 之后的那次渲染就会重挂 effect，
   * cleanup 中的取消把刚提上去的倍速立即还原（实测按住 600ms 升到 3x、660ms 掉回 1x，
   * 期间没有任何用户事件）。用 ref 转发最新实现，让监听只随会话（cid/audioOnly）重挂。
   */
  const cancelSurfacePressRef = useRef(cancelSurfacePress);
  useEffect(() => {
    cancelSurfacePressRef.current = cancelSurfacePress;
  }, [cancelSurfacePress]);

  useEffect(() => {
    const cancel = () => cancelSurfacePressRef.current();
    const cancelMultiTouch = (event: PointerEvent) => {
      if (!event.isPrimary) cancel();
    };
    window.addEventListener("pointerdown", cancelMultiTouch, true);
    window.addEventListener("blur", cancel);
    window.addEventListener("resize", cancel);
    window.visualViewport?.addEventListener("resize", cancel);
    return () => {
      cancel();
      window.removeEventListener("pointerdown", cancelMultiTouch, true);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("resize", cancel);
      window.visualViewport?.removeEventListener("resize", cancel);
    };
  }, [cid, audioOnly]);

  const handleSurfacePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!event.isPrimary || event.button !== 0 || isPlayerControlTarget(event.target)) return;
      if (fullscreenLocked) {
        event.preventDefault();
        revealControls();
        return;
      }
      // 这里刻意不清除封锁：它按时刻过期，否则一次滑动之后紧跟的轻点会与滑动
      // 那一下凑成双击。
      edgeGestureStart(event);
      const media = videoRef.current;
      const touchLike = isTouchLikePointer(event.pointerType);
      // seek 基准取媒体元素的实时位置（`currentTime` state 有节流），时长用后端
      // 算出的分集长度：DASH 的 `media.duration` 可能是 Infinity。
      const startTime = media?.currentTime ?? 0;
      surfacePressRef.current = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        mode: "pending",
        seek:
          touchLike &&
          media !== null &&
          Number.isFinite(duration) &&
          duration > 0 &&
          !loading &&
          !playbackError,
        moved: false,
        width: event.currentTarget.clientWidth,
        startTime,
        duration,
        seekTarget: startTime,
      };
      if (speedHoldTimerRef.current !== null) {
        window.clearTimeout(speedHoldTimerRef.current);
      }
      speedHoldTimerRef.current = window.setTimeout(() => {
        speedHoldTimerRef.current = null;
        engageSpeedHold();
      }, LONG_PRESS_TRIGGER_MS);
    },
    [
      duration,
      edgeGestureStart,
      engageSpeedHold,
      fullscreenLocked,
      loading,
      playbackError,
      revealControls,
    ],
  );

  const handleSurfacePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      // 已确认为纵向的亮度/音量独占这次触摸（它在 onAdjustStart 时就作废了点按）。
      if (edgeGestureMove(event)) return;
      const press = surfacePressRef.current;
      if (!press || press.pointerId !== event.pointerId) return;
      const dx = event.clientX - press.x;
      const dy = event.clientY - press.y;

      if (press.mode === "pending") {
        const intent = videoSeekGestureIntent(dx, dy, press.seek);
        if (intent === "pending") return;
        // 方向一旦明确，无论谁接手都当场作废点按与长按：识别器的单击回调要等满
        // 双击窗口才触发，那时按压状态已清理，只有这个封锁还能否决它。
        press.moved = true;
        releaseSpeedHold();
        suppressSurfaceTaps();
        if (intent === "reject") return;
        press.mode = "seek";
        // 确认后才捕获指针：短促接触必须保持原始目标，弹幕层要靠它完成命中测试。
        event.currentTarget.setPointerCapture(event.pointerId);
      }

      if (press.mode === "seek") {
        press.seekTarget = videoSeekGestureTarget(press.startTime, dx, press.width, press.duration);
        showSeekPreview(press.seekTarget, press.duration, press.seekTarget - press.startTime);
        event.preventDefault();
        event.stopPropagation();
      }
    },
    [edgeGestureMove, releaseSpeedHold, showSeekPreview, suppressSurfaceTaps],
  );

  const handleSurfacePointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const press = surfacePressRef.current;
      const owned = press?.pointerId === event.pointerId ? press.mode : "pending";
      // 已被本页手势认领的按压先收尾。只有仍未定归属的按压才交还给认领了
      // pointerup 的子级浮层（弹幕层在 document 捕获阶段命中测试）。
      if (owned === "pending") {
        if (event.defaultPrevented) {
          cancelPendingSurfaceActions();
          edgeGestureCancel();
          return;
        }
        // 已生效的亮度/音量把这次触摸整个吃掉。
        if (edgeGestureEnd(event)) return;
        if (fullscreenLocked) {
          revealControls();
          return;
        }
      }
      if (!press || press.pointerId !== event.pointerId) return;
      surfacePressRef.current = null;
      releaseSpeedHold();
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      // 识别器的延迟回调从抬手起算，因此封锁窗口也要从这一刻续期。
      if (press.moved) suppressSurfaceTaps();

      if (press.mode === "seek") {
        event.preventDefault();
        event.stopPropagation();
        hideSeekPreview();
        // 整个拖动只提交一次，走播放页原有的统一 seek 入口。
        seekTo(press.seekTarget);
        revealControls();
      }
    },
    [
      cancelPendingSurfaceActions,
      edgeGestureCancel,
      edgeGestureEnd,
      fullscreenLocked,
      hideSeekPreview,
      releaseSpeedHold,
      revealControls,
      seekTo,
      suppressSurfaceTaps,
    ],
  );

  const toggleMute = useCallback(() => {
    if (nativePlayerControlsActive && androidPlayerControls.toggleMediaMute()) return;
    const media = videoRef.current;
    if (mutedRef.current || volumeRef.current === 0) {
      const restored = previousVolumeRef.current || DEFAULT_PLAYER_VOLUME;
      volumeRef.current = restored;
      mutedRef.current = false;
      setVolume(restored);
      setMuted(false);
      if (media) {
        media.volume = restored / 100;
        media.muted = false;
      }
      return;
    }
    previousVolumeRef.current = volumeRef.current;
    mutedRef.current = true;
    setMuted(true);
    if (media) media.muted = true;
  }, [androidPlayerControls, nativePlayerControlsActive]);

  const togglePlayerFullscreen = useCallback(() => {
    if (fullscreen.fullscreen) {
      void fullscreenExit();
      return;
    }
    void fullscreenToggle();
  }, [fullscreenExit, fullscreen.fullscreen, fullscreenToggle]);

  const handleStagePointerActivity = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (isPlayerControlTarget(event.target)) {
        holdControlsVisible();
        return;
      }
      // 桌面/鼠标保持「指针划过就显示」。移动端触摸整个交给点按识别器，与直播页一致：
      // 只有判定成立的单击才改变 chrome 可见性。这里若顺手唤出，按下时 chrome 就已可见，
      // 约 200ms 后（满双击窗口）才跑的单击回调会按「已可见」把它收掉，HUD 于是闪一下即灭。
      if (mobileClient && isTouchLikePointer(event.pointerType)) return;
      revealControls();
    },
    [holdControlsVisible, mobileClient, revealControls],
  );

  /**
   * 鼠标离开播放器区域：HUD 与控制条立即收起，不等空闲倒计时。
   *
   * 触摸抬手同样派发 pointerleave，但移动端一律忽略，交给点按识别器决定可见性：
   * 在这里排隐藏会先撞上 `scheduleControlsHide` 的 `keepVisible` 守卫——暂停、缓冲、
   * 失败时它把 chrome 置为可见，紧随其后的单击回调便只会收起，暂停态永远点不出 HUD。
   * chrome 的隐藏倒计时由 `revealControls` 自己续期，不依赖这条退出路径。
   */
  const handleStagePointerLeave = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (mobileClient && isTouchLikePointer(event.pointerType)) return;
      if (event.pointerType !== "mouse") {
        scheduleControlsHide();
        return;
      }
      dismissControls();
    },
    [dismissControls, mobileClient, scheduleControlsHide],
  );

  useEffect(() => {
    revealControls();
  }, [fullscreen.fullscreen, revealControls]);

  /**
   * 画面点按：识别器与单双击判定窗口来自 Video.js 官方钩子，动作仍是本页的
   * `togglePlayback`（唯一更新 `userPausedRef` 记账的入口）与 `togglePlayerFullscreen`
   * （Android 页内层 / 桌面原生窗口两路径由 fullscreen 钩子适配）。
   *
   * 语义按指针类型分叉，与直播页一致：
   * - 移动端触摸：单击切换 HUD（隐藏时唤出、已可见时收起），双击播放/暂停。
   *   收起走 `toggleControls` 里越过 `keepVisible` 的那条路径，否则暂停态点不掉。
   * - 桌面鼠标：沿用点画面暂停、双击全屏，不受移动端手势改动影响。
   *
   * 一个 target 上只能有一个识别器实例，因此不能按 `pointer` 分别注册两套，
   * 只能在回调里读 `pointerType` 分流。
   *
   * 长按倍速与滑动的抑制走 `suppressTapUntilRef`：识别器是挂在舞台上的原生监听，
   * 早于 React 委托的事件，`defaultPrevented` 在这里不可靠，而该封锁在 pointermove
   * 锁定方向或长按触发的当场就已置位、抬手时续期。它同时充当识别器缺少的位移阈值
   * （底层只看按压时长与交互目标，不看走了多远）。
   */
  usePlayerStageTapGestures({
    target: stageRef,
    onTap: (event) => {
      // 锁定态点按只唤回解锁按钮，不参与切换：此时唯一可见的是解锁按钮，
      // 把它收起会让人无从解锁。
      if (fullscreenLocked) {
        revealControls();
        return;
      }
      if (isTouchLikePointer(event.pointerType)) {
        toggleControls();
        return;
      }
      togglePlayback();
    },
    onDoubleTap: fullscreenLocked
      ? undefined
      : (event) => {
          if (isTouchLikePointer(event.pointerType)) {
            togglePlayback();
            revealControls();
            return;
          }
          togglePlayerFullscreen();
        },
    // 锁定态要放行以便点按唤出解锁按钮，其余抑制照旧。
    shouldIgnore: (event) =>
      isPlayerControlTarget(event.target) ||
      (!fullscreenLocked && Date.now() < suppressTapUntilRef.current),
  });

  const handleStageKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      if (event.defaultPrevented) return;
      if (fullscreenLocked) {
        if (!lockRef.current?.contains(event.target as Node)) {
          event.preventDefault();
          revealControls();
          lockRef.current?.querySelector("button")?.focus();
        }
        return;
      }
      if (isPlayerControlTarget(event.target)) return;
      const key = event.key.toLowerCase();
      if (key === " " || key === "k") {
        event.preventDefault();
        togglePlayback();
      } else if (key === "escape" && webFullscreen && !fullscreen.fullscreen) {
        // 元素全屏时 Escape 由浏览器自己收（退出全屏）；这里只收应用内窗口全屏。
        event.preventDefault();
        setWebFullscreen(false);
      } else if (key === "m") {
        event.preventDefault();
        toggleMute();
      } else if (key === "f" && !event.repeat) {
        event.preventDefault();
        togglePlayerFullscreen();
      } else if (key === "arrowleft") {
        event.preventDefault();
        seekTo(currentTime - (event.shiftKey ? 30 : 5));
      } else if (key === "arrowright") {
        event.preventDefault();
        seekTo(currentTime + (event.shiftKey ? 30 : 5));
      } else if (key === "arrowup") {
        event.preventDefault();
        setPlayerVolume((playerControlMuted ? 0 : playerControlVolume) + 5);
      } else if (key === "arrowdown") {
        event.preventDefault();
        setPlayerVolume((playerControlMuted ? 0 : playerControlVolume) - 5);
      } else if ((key === "n" || key === "]") && nextItem && !event.repeat) {
        event.preventDefault();
        goToPlaylistItem(nextItem);
      } else if ((key === "p" || key === "[") && prevItem && !event.repeat) {
        event.preventDefault();
        goToPlaylistItem(prevItem);
      } else {
        return;
      }
      revealControls();
    },
    [
      currentTime,
      fullscreen,
      fullscreenLocked,
      playerControlMuted,
      playerControlVolume,
      goToPlaylistItem,
      webFullscreen,
      nextItem,
      prevItem,
      revealControls,
      seekTo,
      setPlayerVolume,
      toggleMute,
      togglePlayback,
      togglePlayerFullscreen,
    ],
  );

  // 进入播放页即聚焦画面：键盘快捷键不需要先点一下才生效。`autoFocus` 属性
  // 只在文档加载期生效，SPA 路由挂载的元素必须命令式聚焦。挂在 cid 上而不是
  // 仅挂载时：PGC 直入解析完成后舞台才首次挂载（cid 0 → 有效值），换集时也
  // 重新聚焦——观众接下来的输入几乎总是给播放器的。
  useEffect(() => {
    stageRef.current?.focus({ preventScroll: true });
  }, [cid]);

  const goBack = useCallback(() => {
    if (canNavigateBackInApp(window.history.state)) {
      navigate(-1);
      return;
    }
    navigate(VIDEO_HOME_PATH, { replace: true });
  }, [navigate]);

  // 当前分 P 序号：多 P 稿件按 cid 从详情对出（链接缺 cid 时详情已补齐首 P），
  // 单 P 或详情未到时为 1，不影响地址正确性（P1 省略 ?p=）。
  const originalUrl = useMemo(() => {
    if (!params) return null;
    const page = archiveQuery.data?.pages.find((item) => item.cid === cid)?.page ?? 1;
    return videoOriginalUrl(params.bvid, params.epId, page);
  }, [archiveQuery.data, cid, params]);

  // 跳原址与复制链接：桌面端住底部 Shell，移动端与全屏住 HUD 的 `⋮`
  // 溢出菜单；打开与回退细节见 `openExternalUrl`，
  // 通知反馈与直播页卡片同一套。
  const openOriginalUrl = useCallback(() => {
    if (!originalUrl) return;
    void openExternalUrl(originalUrl).then((opened) => {
      if (opened) notify.success("已在浏览器中打开");
      else notify.error("无法在浏览器中打开", "请稍后重试。");
    });
  }, [originalUrl]);

  const copyOriginalUrl = useCallback(() => {
    if (!originalUrl) return;
    void copyText(originalUrl).then((copied) => {
      if (copied) notify.success("已复制视频链接");
      else notify.error("复制失败", "请手动选择并复制。");
    });
  }, [originalUrl]);

  /**
   * 进入短视频流，并以当前这条为种子（上游据此换出一组从本片开始的新窗口）。
   * bvid 缺失（PGC 分集）时退回裸 `/shorts`，由后端用最近观看历史当种子。
   * 先把全屏收干净再走：短视频页是沉浸路由，留着元素全屏会盖在它上面。
   */
  const openShorts = useCallback(async () => {
    setHudMenuOpen(false);
    setOverlayInteractionOpen(false);
    await fullscreenExit();
    navigate(shortsPath(bvid));
  }, [bvid, fullscreenExit, navigate]);

  const title = params?.title || "视频播放";

  /** 桌面普通详情（无任何沉浸/全屏层）：旧流内顶栏的返回主页入口迁入
   *  舞台 HUD，与移动端/全屏共用同一份挂载。 */
  const desktopDetails = !mobileClient && !fullscreen.fullscreen && !webFullscreen;

  /** 投屏源：HUD 溢出菜单里的投屏面板（窗口化与全屏同一入口）。 */
  const castMenuProps = {
    castUrl: castQuery.data?.url ?? null,
    headers: castQuery.data?.headers ?? {},
    title: params?.title ?? "视频",
    variant: "overlay" as const,
    onCastingDeviceChange: setCastingDevice,
  };

  /** 兜底顶栏：仅在无有效参数或 PGC 解析态（没有可覆盖的播放舞台）时渲染，
   *  只留返回与标题，不挂工具。 */
  const topBar = (
    <header className="relative flex min-h-11 shrink-0 items-center justify-center border-b border-border/80 bg-sidebar/90">
      <div className="absolute left-3 flex items-center gap-1">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                className="motion-back-button rounded-lg hover:bg-muted/70"
                aria-label="返回视频列表"
                onClick={goBack}
              />
            }
          >
            <ChevronLeft data-icon="inline-start" aria-hidden />
          </TooltipTrigger>
          <TooltipContent>返回视频列表</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                className="rounded-lg hover:bg-muted/70"
                aria-label="返回主页"
                onClick={() => navigate(VIDEO_HOME_PATH)}
              />
            }
          >
            <Home data-icon="inline-start" aria-hidden />
          </TooltipTrigger>
          <TooltipContent>返回主页</TooltipContent>
        </Tooltip>
      </div>
      <div className="pointer-events-none absolute inset-x-24 flex min-w-0 items-center justify-center px-16">
        <p className="truncate text-sm font-semibold tracking-tight" title={title}>
          {title}
        </p>
      </div>
    </header>
  );

  if (!params) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-background">
        {topBar}
        <main className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4 md:p-6">
          <div className="w-full max-w-xl">
            <ErrorState
              error={new Error("缺少有效的视频参数，请从视频页重新选择内容。")}
              title="无效的视频播放链接"
            />
          </div>
        </main>
      </div>
    );
  }

  // 直入解析态：season 详情落定前不挂播放器与侧栏（此刻侧栏会以缺 epId 的
  // 形态初始化出错误的页签），只保留顶栏 + 解析指示；失败给可读的错误态。
  if (seasonEntry !== null) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-background">
        {topBar}
        <main className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4 md:p-6">
          <div className="w-full max-w-xl">
            {entrySeasonQuery.isError ? (
              <ErrorState
                error={entrySeasonQuery.error}
                title="剧集信息加载失败"
                onRetry={() => void entrySeasonQuery.refetch()}
              />
            ) : entrySeasonQuery.data && entrySeasonQuery.data.episodes.length === 0 ? (
              <ErrorState
                error={new Error("这部剧集暂时没有可播放的分集，可能受版权或地区限制。")}
                title="无法播放"
              />
            ) : (
              <Spinner className="mx-auto size-6" aria-label="正在打开剧集" />
            )}
          </div>
        </main>
      </div>
    );
  }

  /**
   * 控制栏字幕控件：与直播同一契约 —— 常驻右侧按钮组、固定在全屏按钮左侧，
   * 由 `PlayerControls` 的 `captionsSlot` 渲染。片源没有 CC 轨时按钮不摘掉
   * （摘掉会让它挤到全屏按钮右侧，且位置随片源跳动）。
   *
   * 菜单里「字幕（本地）」是常驻项：桌面客户端永远列出，不依赖片源有没有 CC 轨，
   * 选中即用本地 ASR 实时识别当前音轨。三种来源互斥 —— 选 CC 轨会关掉本地识别，
   * 选本地识别会卸掉 CC 轨（`subtitleLan` 置空后 `<track>` 随之移除）。
   */
  const localCaptionsAvailable = asr.desktopClient;
  const captionsActive = Boolean(subtitleLan) || asr.captionsOn;
  /** 本地识别不可用/未就绪时把原因写在选项下方；就绪且可切换时不占行。 */
  const localCaptionsHint =
    asr.controlDisabled || asr.modelStatus?.state !== "ready" || asr.modelQueryError
      ? asr.controlLabel
      : null;
  const selectNoCaptions = () => {
    setSubtitleLan(null);
    if (asr.captionsOn) asr.toggle();
    setSubtitleMenuOpen(false);
  };
  const selectSubtitleTrack = (lan: string) => {
    setSubtitleLan(lan);
    if (asr.captionsOn) asr.toggle();
    setSubtitleMenuOpen(false);
  };
  const selectLocalCaptions = () => {
    if (asr.captionsOn) {
      setSubtitleMenuOpen(false);
      return;
    }
    setSubtitleLan(null);
    // 模型未就绪时 toggle 只做重试/无操作；此时留着弹层，让状态文案可见。
    asr.toggle();
    if (asr.modelStatus?.state === "ready") setSubtitleMenuOpen(false);
  };
  const captionsSlot =
    subtitles.length === 0 && !localCaptionsAvailable ? (
      <ButtonTooltip label="当前视频没有字幕" side="top">
        <MediaButton
          aria-label="字幕"
          aria-disabled
          disabled
          className="r-live-media-extension-button"
        >
          <CaptionsOff className="size-6" aria-hidden />
        </MediaButton>
      </ButtonTooltip>
    ) : (
      <Popover open={subtitleOpen} onOpenChange={subtitleHover.onOpenChange}>
        <PopoverTrigger
          {...subtitleHover.trigger}
          render={
            <MediaButton
              aria-label={captionsActive ? "关闭字幕" : "开启字幕"}
              aria-pressed={captionsActive}
              className={cn(
                "r-live-media-extension-button",
                // 与控制栏其他开启态一致：中性白填充，不再用 accent 蓝。
                subtitleOpen && mediaPopupTriggerOpenClass,
                captionsActive && glassOptionSelectedClass(),
              )}
            >
              {captionsActive ? (
                <Captions className="size-6" aria-hidden />
              ) : (
                <CaptionsOff className="size-6" aria-hidden />
              )}
            </MediaButton>
          }
        />
        <PopoverContent
          container={stageRef}
          side="top"
          align="end"
          collisionBoundary={document.documentElement}
          collisionPadding={{ top: 24, right: 12, bottom: 12, left: 12 }}
          sticky
          glass
          className={cn(
            "flex w-72 flex-col gap-0 overflow-y-auto p-1.5 whitespace-nowrap [&_*]:whitespace-nowrap",
            glassPanelClass({ overlay: true }),
          )}
          {...subtitleHover.popup}
        >
          <>
            <Button
              variant="ghost"
              className={cn(
                "w-full justify-between max-md:h-10",
                glassOptionClass(),
                !captionsActive && glassOptionSelectedClass(),
              )}
              aria-pressed={!captionsActive}
              onClick={selectNoCaptions}
            >
              <span className="truncate">关闭字幕</span>
              {!captionsActive && <Check data-icon="inline-end" aria-hidden />}
            </Button>
            {subtitles.map((subtitle) => (
              <Button
                key={subtitle.lan}
                variant="ghost"
                className={cn(
                  "w-full justify-between max-md:h-10",
                  glassOptionClass(),
                  subtitleLan === subtitle.lan && glassOptionSelectedClass(),
                )}
                aria-pressed={subtitleLan === subtitle.lan}
                onClick={() => selectSubtitleTrack(subtitle.lan)}
              >
                <span className="truncate">{subtitle.lan_doc}</span>
                {subtitleLan === subtitle.lan && <Check data-icon="inline-end" aria-hidden />}
              </Button>
            ))}
            {localCaptionsAvailable && (
              <>
                {subtitles.length > 0 && (
                  <Separator className={cn("my-1", glassSeparatorClass())} />
                )}
                <Button
                  variant="ghost"
                  className={cn(
                    "h-auto min-h-9 w-full justify-between py-1.5 max-md:min-h-10",
                    glassOptionClass(),
                    asr.captionsOn && glassOptionSelectedClass(),
                  )}
                  aria-pressed={asr.captionsOn}
                  aria-disabled={asr.controlDisabled || undefined}
                  disabled={asr.controlDisabled}
                  onClick={selectLocalCaptions}
                >
                  <span className="flex min-w-0 flex-col items-start gap-0.5 text-left">
                    <span className="truncate">字幕（本地）</span>
                    {localCaptionsHint && (
                      <span className={cn("text-xs font-normal", glassMutedTextClass())}>
                        {localCaptionsHint}
                      </span>
                    )}
                  </span>
                  {asr.controlBusy ? (
                    <Spinner data-icon="inline-end" aria-hidden />
                  ) : asr.captionsOn ? (
                    <Check data-icon="inline-end" aria-hidden />
                  ) : null}
                </Button>
                <Separator className={cn("my-1", glassSeparatorClass())} />
                <div className="px-2 py-2">
                  <AsrSettingsBody
                    portalContainer={stageRef}
                    translationEnabled={asrTranslationEnabled}
                    translationFrom={asrTranslationFrom}
                    translationTo={asrTranslationTo}
                    speakerDiarizationEnabled={asrSpeakerDiarizationEnabled}
                    onTranslationEnabledChange={setAsrTranslationEnabled}
                    onTranslationFromChange={setAsrTranslationFrom}
                    onTranslationToChange={setAsrTranslationTo}
                    onSpeakerDiarizationEnabledChange={setAsrSpeakerDiarizationEnabled}
                  />
                </div>
              </>
            )}
          </>
        </PopoverContent>
      </Popover>
    );

  const currentPlaybackRate = String(
    VOD_PLAYBACK_RATES.find((rate) => rate === playbackRate?.playbackRate) ?? 1,
  );
  const playbackRateMenuOptions: PlayerMenuRadioOption[] = VOD_PLAYBACK_RATES.map((rate) => ({
    value: String(rate),
    label: formatPlaybackRateLabel(rate),
  }));

  /** 循环/连播偏好与播放倍数调节。 */
  const playbackToggles = (
    <div className="flex flex-col gap-2 px-1 py-1">
      {playbackRateMenuOptions.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className={cn("px-2 pt-1 text-xs", glassMutedTextClass())}>播放倍数</span>
          <PlayerMenuRadioGroup
            label="播放倍数"
            value={currentPlaybackRate}
            options={playbackRateMenuOptions}
            columns={playbackRateMenuOptions.length}
            onValueChange={(nextValue) => playbackRate?.setPlaybackRate(Number(nextValue))}
          />
        </div>
      )}
      {playbackRateMenuOptions.length > 0 && <Separator className={glassSeparatorClass()} />}
      <PlaybackSettingRow
        id="video-playback-loop"
        label="循环播放"
        checked={playlistStore.loopPlayback}
        onToggle={playlistStore.toggleLoopPlayback}
      />
      {playlistStore.items.length > 1 && (
        <PlaybackSettingRow
          id="video-playback-next"
          label="自动切集"
          checked={playlistStore.autoPlayNext}
          onToggle={playlistStore.toggleAutoPlayNext}
        />
      )}
      {!epId && (
        <PlaybackSettingRow
          id="video-playback-related"
          label="自动连播"
          checked={playlistStore.autoPlayRelated}
          onToggle={playlistStore.toggleAutoPlayRelated}
        />
      )}
    </div>
  );

  const fatalError = playInfoQuery.isError
    ? playInfoQuery.error
    : cid <= 0 && archiveQuery.isError
      ? archiveQuery.error
      : null;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {/* 与直播页同构：外层普通 div 持画幅比，Container 只负责铺满。
          画幅比不能和 h-full 挂在同一元素上 —— 显式高度优先级高于
          aspect-ratio，画幅比会被静默丢掉（这正是原先的黑边根因）。
          比值取实测源画幅（`--stage-ar`），元数据到位前回退 16/9。 */}
      <main className="flex min-h-0 flex-1 flex-col bg-black lg:flex-row">
        <div
          data-video-player-frame
          style={
            frameAspectRatio && frameAspectRatio > 0
              ? ({ "--stage-ar": String(frameAspectRatio) } as CSSProperties)
              : undefined
          }
          className={cn(
            "relative flex min-w-0 flex-col bg-black",
            webFullscreen
              ? "min-h-0 flex-1"
              : "h-auto w-full flex-none aspect-[var(--stage-ar,16/9)] max-lg:max-h-[70%]",
            // 宽屏回 flex 填充：舞台要与 340px 详情栏共享一行，若在这里按比值
            // 反推宽 + flex-none，宽比值下会撑到满宽把详情栏顶出视口（实测
            // 1400+340 溢出）。这一档主列形状不等于源比值，仍靠 contain 居中,
            // 与直播页宽屏一致；要真消掉需让详情栏可折叠。
            !webFullscreen && "lg:aspect-auto lg:h-full lg:w-auto lg:min-h-0 lg:flex-1",
          )}
        >
          <VideoJsContainer
            variant="vod"
            ref={stageRef}
            data-player-stage
            data-video-mode="details"
            data-fullscreen={fullscreen.fullscreen && fullscreen.nativeLayer ? "true" : undefined}
            className={cn(
              "relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-black",
              "data-[fullscreen=true]:rounded-none data-[fullscreen=true]:border-0",
            )}
            aria-label={`${title}；按空格或 K 播放或暂停，左右方向键快退或快进（Shift 加速 30 秒），上下方向键调音量，M 静音，F 全屏`}
            aria-keyshortcuts="Space K ArrowLeft ArrowRight ArrowUp ArrowDown M F"
            aria-description={
              mobileClient
                ? [
                    "单击画面显示控制层，双击播放或暂停，左右滑动快退或快进",
                    "画面左半边上下滑动调亮度，右半边调音量",
                    "长按临时 3 倍速",
                  ].join("；")
                : undefined
            }
            onPointerEnter={handleStagePointerActivity}
            onPointerMove={handleStagePointerActivity}
            onPointerLeave={handleStagePointerLeave}
            onKeyDown={handleStageKeyDown}
            tabIndex={0}
            controls={
              <PlayerControls
                chrome={{
                  ref: controlsRef,
                  "data-player-controls": true,
                  "data-visible": "true",
                  "aria-hidden": false,
                  className:
                    "absolute inset-x-0 bottom-0 z-30 transition-opacity duration-150 ease-out motion-reduced:transition-none data-[visible=false]:pointer-events-none data-[visible=false]:opacity-0",
                  onPointerEnter: holdControlsVisible,
                  onPointerLeave: scheduleControlsHide,
                  onFocusCapture: holdControlsVisible,
                  onBlurCapture: scheduleControlsHide,
                }}
                externalAudioControls={
                  nativePlayerControlsActive
                    ? {
                        volume: playerControlVolume,
                        muted: playerControlMuted,
                        onVolumeChange: setPlayerVolume,
                        onToggleMute: toggleMute,
                      }
                    : undefined
                }
                osdOn={danmakuVisible}
                webFullscreen={webFullscreen}
                fullscreen={fullscreen.fullscreen}
                nativeFullscreen={!fullscreen.nativeLayer}
                onToggleWebFullscreen={() => setWebFullscreen((value) => !value)}
                disabled={loading}
                pictureInPictureDisabled={loading || audioOnly || fullscreen.fullscreen}
                refreshDisabled={loading}
                loadError={fullscreen.error}
                stackedBelowPlayer={compact}
                compact={compact}
                portalContainer={stageRef}
                centerSlot={
                  <DanmakuComposer
                    overlay
                    portalContainer={stageRef}
                    roomTitle={title}
                    video={{
                      cid,
                      aid: aid ?? "",
                      progressMs: Math.floor(currentTime * 1000),
                    }}
                    onOverlayInteractionChange={setOverlayInteractionOpen}
                  />
                }
                playbackSettings={playbackToggles}
                playbackSettingsTitle="播放设置"
                qualities={playInfo?.accept_quality.map((quality) => ({
                  quality: quality.label,
                  // 不可用档位仍列出但置灰：匿名/非大会员能直接看出画质上限的
                  // 原因，而不是以为客户端坏了。
                  disabled: !quality.available,
                  hint: quality.available ? undefined : "登录或大会员后可用",
                }))}
                qualityIndex={(() => {
                  if (!playInfo) return 0;
                  const index = playInfo.accept_quality.findIndex(
                    (quality) => quality.qn === playInfo.quality,
                  );
                  return index >= 0 ? index : 0;
                })()}
                onQualityChange={(index) => {
                  const quality = playInfo?.accept_quality[index];
                  if (quality?.available) changeQuality(quality.qn);
                }}
                onOverlayInteractionChange={setOverlayInteractionOpen}
                onRefresh={retryPlayback}
                onNext={selectionNextItem ? () => goToPlaylistItem(selectionNextItem) : undefined}
                captionsSlot={captionsSlot}
                audioOnly={audioOnly}
                onToggleAudioOnly={toggleAudioOnly}
                onToggleOsd={() => setDanmakuVisible((visible) => !visible)}
                onToggleFullscreen={fullscreen.nativeLayer ? togglePlayerFullscreen : undefined}
              />
            }
          >
            <div data-video-viewport className="relative flex min-h-0 flex-1 flex-col bg-black">
              <div data-video-frame className="relative flex min-h-0 flex-1 flex-col">
                <div
                  data-player-video-surface
                  className={cn(
                    "relative min-h-0 flex-1 overflow-hidden bg-black",
                    mobileClient && "touch-none select-none",
                  )}
                  onPointerDown={handleSurfacePointerDown}
                  onPointerMove={handleSurfacePointerMove}
                  onPointerUp={handleSurfacePointerUp}
                  onPointerCancel={cancelSurfacePress}
                  onLostPointerCapture={(event) => {
                    // video 的隐式捕获交给 surface 时也会冒泡 lost；只处理自身丢失捕获。
                    if (
                      event.target === event.currentTarget &&
                      surfacePressRef.current?.pointerId === event.pointerId
                    ) {
                      cancelSurfacePress();
                    }
                  }}
                  onPointerLeave={(event) => {
                    if (
                      surfacePressRef.current?.pointerId === event.pointerId &&
                      !event.currentTarget.hasPointerCapture(event.pointerId)
                    ) {
                      cancelSurfacePress();
                    }
                  }}
                  onContextMenu={(event) => {
                    // 长按倍速会触发系统的长按菜单，按住期间一律压掉。
                    if (speedHoldRef.current || speedHoldTimerRef.current !== null) {
                      event.preventDefault();
                    }
                  }}
                >
                  <div
                    ref={rootRef}
                    data-player-engine-root
                    className="absolute inset-0 size-full overflow-hidden bg-black"
                  >
                    <VideoJsVideo
                      ref={videoRef}
                      data-player-video
                      playsInline
                      preload="metadata"
                      controls={false}
                      crossOrigin="anonymous"
                      disablePictureInPicture={audioOnly}
                      className="absolute inset-0 size-full bg-black object-contain"
                    />
                  </div>

                  {danmakuEntries.length > 0 && (
                    <VideoDanmakuLayer
                      videoRef={videoRef}
                      entries={danmakuEntries}
                      active={danmakuVisible}
                      interactive={!fullscreenLocked && !switchingItem}
                      cid={cid}
                      aid={aid ?? ""}
                      title={title}
                      large={!compact && (fullscreen.fullscreen || webFullscreen)}
                      tapMaxDistance={LONG_PRESS_CANCEL_MOVE_PX}
                    />
                  )}
                  <PlayerBrightnessShade ref={edgeGestureBrightnessShadeRef} />

                  {speedHoldActive && (
                    <div
                      role="status"
                      aria-live="polite"
                      className="pointer-events-none absolute left-1/2 top-4 z-20 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-black/70 px-3 py-1 text-sm font-medium text-white backdrop-blur-sm"
                    >
                      <FastForward className="size-3.5" aria-hidden />
                      {LONG_PRESS_SPEED_RATE.toFixed(1)}x 倍速中
                    </div>
                  )}

                  {/* 横向拖动的目标时间预览。逐帧只改 textContent 与 data-visible，
                      不进 React 状态；已提交的位置由控制栏时间与进度条播报，
                      这层只是拖动中的取景器，故对辅助技术隐藏。 */}
                  <div
                    ref={seekPreviewRef}
                    data-player-seek-preview
                    data-visible="false"
                    aria-hidden
                    className="pointer-events-none absolute left-1/2 top-1/2 z-20 -translate-x-1/2 -translate-y-1/2 rounded-lg bg-black/70 px-3.5 py-2 text-center text-white opacity-0 backdrop-blur-sm transition-opacity duration-100 ease-out data-[visible=true]:opacity-100 motion-reduced:transition-none"
                  >
                    <span
                      ref={seekPreviewTimeRef}
                      data-player-seek-preview-time
                      className="block text-base font-medium leading-5 tabular-nums"
                    />
                    <span
                      ref={seekPreviewDeltaRef}
                      data-player-seek-preview-delta
                      className="mt-0.5 block text-xs leading-4 tabular-nums text-white/75"
                    />
                  </div>

                  {(loading || waiting || playInfoQuery.isPending || switchingItem) &&
                    !playbackError &&
                    !fatalError && (
                      <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-black/25">
                        <Spinner className="text-white" aria-label="正在加载视频" />
                      </div>
                    )}

                  {/* 失败态必须可见、可重试：设计文档第四节记录过代理 502 会连带打掉音轨，
              静默失败会让用户看到「在播但没声音」而无从下手。 */}
                  {(playbackError || fatalError) && (
                    <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/65 p-6">
                      <ErrorState
                        error={playbackError ?? fatalError}
                        title="视频播放失败"
                        onRetry={retryPlayback}
                        className="w-full max-w-md bg-card shadow-2xl shadow-black/50"
                      />
                    </div>
                  )}
                  <PlayerEdgeGestureFeedback refs={edgeGestureFeedback} />
                </div>

                {/* 语音字幕叠加层：CC 轨由 `<track>` 原生渲染，本地识别是 DOM 叠加层。
                    两者互斥，不会同时出现。锚在画面框底边上方，位于控制栏之下。 */}
                <AsrCaptionOverlay
                  asr={asr}
                  fontSize={asrFontSize}
                  translationTo={asrTranslationTo}
                />

                {/* 顶部 HUD：所有模式（含桌面普通详情）共用，承载返回/标题与低频工具，
              与底部控制栏同一套空闲显隐。 */}
                <div
                  ref={hudRef}
                  data-player-hud
                  data-visible="true"
                  aria-hidden={false}
                  className={cn(
                    "absolute inset-x-0 top-0 z-30 transition-opacity duration-150 ease-out",
                    "motion-reduced:transition-none data-[visible=false]:pointer-events-none data-[visible=false]:opacity-0",
                    // 标题与留白穿透到弹幕；仅可见、可用的按钮接收指针。
                    "pointer-events-none [&[data-visible=true]_button:enabled]:pointer-events-auto",
                  )}
                  onPointerEnter={holdControlsVisible}
                  onPointerLeave={scheduleControlsHide}
                  onFocusCapture={holdControlsVisible}
                  onBlurCapture={scheduleControlsHide}
                >
                  <div
                    className={cn(
                      "player-scrim-overlay-top flex min-w-0 items-center justify-between gap-2 bg-transparent pr-[max(0.375rem,env(safe-area-inset-right))] pl-[max(0.75rem,env(safe-area-inset-left))] pt-[max(0.375rem,var(--player-safe-area-top,0px))] text-white",
                      compact ? "pb-3" : "pb-6",
                    )}
                  >
                    <MediaButton
                      type="button"
                      aria-label={
                        fullscreen.fullscreen
                          ? "退出全屏"
                          : webFullscreen
                            ? "退出窗口全屏"
                            : "返回视频列表"
                      }
                      className={PLAYER_HUD_BUTTON_CLASS}
                      // 与直播页 HUD 的返回箭头同一层级语义：两层全屏叠加时一次只收
                      // 一层（原生/元素全屏优先，窗口全屏留给下一次）。
                      onClick={() => {
                        if (fullscreen.fullscreen) void fullscreenExit();
                        else if (webFullscreen) setWebFullscreen(false);
                        else goBack();
                      }}
                    >
                      <ChevronLeft
                        className={PLAYER_HUD_ICON_CLASS}
                        data-icon="inline-start"
                        aria-hidden
                      />
                    </MediaButton>
                    {/* 桌面普通详情：旧流内顶栏的返回主页入口。 */}
                    {desktopDetails && (
                      <MediaButton
                        type="button"
                        aria-label="返回主页"
                        title="返回主页"
                        className={PLAYER_HUD_BUTTON_CLASS}
                        onClick={() => navigate(VIDEO_HOME_PATH)}
                      >
                        <Home
                          className={PLAYER_HUD_ICON_CLASS}
                          data-icon="inline-start"
                          aria-hidden
                        />
                      </MediaButton>
                    )}
                    <div className="flex h-media-control min-w-0 flex-1 items-center px-1">
                      <p
                        className={cn(
                          "truncate font-semibold leading-none text-white [text-shadow:0_1px_3px_rgb(0_0_0_/_0.75)]",
                          PLAYER_HUD_TITLE_SIZE_CLASS,
                        )}
                        title={title}
                      >
                        {title}
                      </p>
                    </div>
                    {/* 短视频入口：以当前这条为种子进入竖屏流（滑到哪就从哪继续）。
                        与 `⋮` 同级常驻，不藏进溢出菜单 —— 它是这一页的消费方式切换，
                        不是低频工具。bvid 缺失（PGC）时后端退回最近观看历史。 */}
                    <MediaButton
                      type="button"
                      aria-label="以当前视频为种子进入短视频"
                      title="看短视频"
                      className={PLAYER_HUD_BUTTON_CLASS}
                      onClick={() => void openShorts()}
                    >
                      <Smartphone
                        className={PLAYER_HUD_ICON_CLASS}
                        data-icon="inline-start"
                        aria-hidden
                      />
                    </MediaButton>
                    <PlayerHudOverflowMenu
                      label="更多操作"
                      title="播放操作"
                      open={hudMenuOpen}
                      onOpenChange={(open) => {
                        setHudMenuOpen(open);
                        // 菜单开着时空闲计时器不能把 chrome 淡出。
                        setOverlayInteractionOpen(open);
                      }}
                      compact={compact}
                      // 画面全屏需舞台内 portal；窗口全屏仍走默认宿主。
                      portalContainer={fullscreen.fullscreen ? stageRef : undefined}
                    >
                      <div className="grid grid-cols-4 gap-1.5 max-md:gap-2">
                        {mobileClient && (
                          <PlayerToolTile
                            icon={Home}
                            label="返回主页"
                            onClick={async () => {
                              setHudMenuOpen(false);
                              setOverlayInteractionOpen(false);
                              await fullscreenExit();
                              navigate(VIDEO_HOME_PATH);
                            }}
                          />
                        )}
                        <PlayerToolTile
                          icon={Cast}
                          label={castingDevice ? "投屏中" : "投屏"}
                          pressed={castOpen || castingDevice != null}
                          active={castingDevice != null}
                          onClick={() => setCastOpen((open) => !open)}
                        />
                        <PlayerToolTile
                          icon={Link2}
                          label="复制链接"
                          disabled={!originalUrl}
                          onClick={() => {
                            setHudMenuOpen(false);
                            setOverlayInteractionOpen(false);
                            copyOriginalUrl();
                          }}
                        />
                        <PlayerToolTile
                          icon={ExternalLink}
                          label="在浏览器中打开"
                          disabled={!originalUrl}
                          onClick={() => {
                            setHudMenuOpen(false);
                            setOverlayInteractionOpen(false);
                            openOriginalUrl();
                          }}
                        />
                      </div>
                      {castOpen && (
                        <PlayerToolPanel>
                          <CastMenu {...castMenuProps} />
                        </PlayerToolPanel>
                      )}
                    </PlayerHudOverflowMenu>
                  </div>
                </div>
              </div>
            </div>

            {fullscreenLockMounted && (
              <PlayerFullscreenLock
                ref={lockRef}
                visible={true}
                locked={fullscreenLocked}
                onToggle={() => {
                  cancelSurfacePress();
                  setFullscreenLocked((locked) => !locked);
                }}
                onPointerEnter={holdControlsVisible}
                onPointerDown={holdControlsVisible}
                onPointerLeave={scheduleControlsHide}
                onFocusCapture={holdControlsVisible}
                onBlurCapture={scheduleControlsHide}
              />
            )}
          </VideoJsContainer>
        </div>
        {!webFullscreen && (
          <aside
            ref={detailsRef}
            tabIndex={-1}
            aria-label="视频详情"
            className={cn(
              // 与直播/IPTV 播放页右侧栏同一套规格：bg-sidebar、边框、断点宽度
              // （320/340，UP 信息卡的「播放/评论/发布时间 + 简介开关」典型值
              // 单行放下，超长数值退到第二行而非截断），窄屏则列在播放器下方。
              "relative isolate flex min-h-0 flex-1 flex-col border-t border-border/80 bg-sidebar max-md:pb-[env(safe-area-inset-bottom)]",
              "lg:w-[320px] lg:flex-none lg:border-t-0 lg:border-l xl:w-[340px] lg:pb-0",
            )}
          >
            <VideoSidebar
              tab={sidebarTab}
              onTabChange={setSidebarTab}
              bvid={params.bvid}
              epId={params.epId}
              aid={params.aid}
              cid={cid}
              danmaku={{
                entries: danmakuEntries,
                positionMs: currentTime * 1000,
                // 空列表只有在「本段已落定且没有在途请求」时才不是加载中，
                // 否则无弹幕的视频会永远显示加载动画。
                loading:
                  danmakuVisible &&
                  !playbackError &&
                  (danmakuRequestsInFlight > 0 || !danmakuSegmentSettled),
                onSeek: (positionMs) => seekTo(positionMs / 1000),
              }}
            />
            <DrawerViewport active={!fullscreen.fullscreen} />
          </aside>
        )}
      </main>
      {/* 底部 Shell 只在桌面端常驻（与直播页底部操作行同一画法）：移动端
          的两个入口收进顶栏 `⋮` 抽屉。全屏（元素级 top layer）时被舞台盖住，
          HUD 的 `⋮` 溢出菜单里另有镜像；窗口全屏时从布局卸载。 */}
      {!webFullscreen && !mobileClient && (
        <footer className="hidden shrink-0 flex-wrap items-center justify-end gap-1.5 border-t border-border/80 bg-sidebar/90 px-3 pt-1.5 pb-[calc(0.375rem+env(safe-area-inset-bottom))] md:flex">
          <Button variant="ghost" size="sm" disabled={!originalUrl} onClick={copyOriginalUrl}>
            <Link2 data-icon="inline-start" />
            复制链接
          </Button>
          <Button variant="ghost" size="sm" disabled={!originalUrl} onClick={openOriginalUrl}>
            <ExternalLink data-icon="inline-start" />
            在浏览器中打开
          </Button>
        </footer>
      )}
    </div>
  );
}

/**
 * 播放设置面板里的开关行。偏好项共用同一画法：与设置页、字幕菜单的开关
 * 同源（`Switch` + `FieldLabel`），标签文字同样可点。
 */
function PlaybackSettingRow({
  id,
  label,
  checked,
  onToggle,
}: {
  id: string;
  label: string;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <Field orientation="horizontal" className="min-h-9 px-2.5 py-1.5">
      <FieldLabel htmlFor={id} className="text-sm font-normal">
        {label}
      </FieldLabel>
      <Switch id={id} size="sm" checked={checked} onCheckedChange={() => onToggle()} />
    </Field>
  );
}
