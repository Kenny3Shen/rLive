import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useQuery, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import {
  Captions,
  CaptionsOff,
  Cast,
  Check,
  ChevronLeft,
  Ellipsis,
  ExternalLink,
  FastForward,
  Home,
  Link2,
  MessageSquareText,
  Smartphone,
  Users,
  Video,
} from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ANDROID_BACK_EVENT, dismissTopmostPopup } from "@/app/androidBackNavigation";
import { isMobileClient } from "@/shared/clientPlatform";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  Drawer,
  DrawerContent,
  DrawerScope,
  DrawerTitle,
  DrawerTrigger,
  DrawerViewport,
} from "@/components/ui/drawer";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { Spinner } from "@/components/ui/spinner";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ErrorState } from "@/shared/components/ErrorState";
import { PlayerControls } from "@/shared/components/player/PlayerControls";
import { useCompactPlayerViewport } from "@/shared/hooks/usePlayerViewport";
import { usePlayerChromeIdle } from "@/shared/hooks/usePlayerChromeIdle";
import { useScreenWakeLock } from "@/shared/hooks/useScreenWakeLock";
import { copyText } from "@/shared/clipboard";
import { openExternalUrl } from "@/shared/externalUrl";
import { canNavigateBackInApp } from "@/shared/appHistory";
import {
  DEFAULT_PLAYER_VOLUME,
  readPlayerVolume,
  rememberPlayerVolume,
} from "@/shared/playerVolume";
import { cn, formatOnline, normalizeImageUrl, normalizeVideoCoverUrl } from "@/lib/utils";
import {
  horizontalSwipeDragOffset,
  horizontalSwipeSettleDuration,
  horizontalSwipeShouldCommit,
  horizontalSwipeVelocity,
  type HorizontalSwipeSample,
} from "@/shared/gestures/horizontalSwipe";
import { prefersReducedMotion, SWIPE_SETTLE_EASING } from "@/shared/motion/tokens";
import { tween } from "@/shared/motion/tween";
import {
  createXgPlayer,
  isInterruptedPlayRequest,
  loadXgPlayerModules,
  xgPlayerErrorMessage,
  type XgPlaybackKind,
  type XgDashSegmentTimeline,
  type XgPlayerInstance,
} from "@/features/room/player/xgPlayer";
import { requestPlayerAutoplay } from "@/features/room/player/autoplay";
import {
  videoAspectRatio,
  setAndroidPlayerOrientation,
} from "@/features/room/player/androidOrientation";
import {
  runningOnAndroidTauri,
  setAndroidImmersive,
} from "@/features/room/player/androidImmersive";
import { useRecordingPlayerFullscreen } from "@/features/recording/useRecordingPlayerFullscreen";
import { formatRecordingDuration } from "@/features/recording/recording";
import type {
  VideoHistoryItem,
  VideoHistoryKind,
  VideoPlayInfo,
  VideoSessionIds,
} from "@/shared/types/video";
import { DanmakuComposer } from "@/features/room/BilibiliDanmakuComposer";
import {
  videoGetArchive,
  videoGetCastUrl,
  videoGetDanmaku,
  videoGetPlayInfo,
  videoGetSeason,
  videoGetSubtitle,
  videoGetSubtitles,
  videoStopPlay,
} from "./videoApi";
import {
  videoHistoryAdd,
  videoHistoryFind,
  videoPgcEntryEpisode,
  videoResumeCid,
  videoResumePosition,
  VIDEO_HISTORY_QUERY_KEY,
} from "./videoHistory";
import { isWatchProgressWorthKeeping, shouldReportWatchProgress } from "@/shared/watchProgress";
import { subtitleJsonToVtt } from "./subtitleVtt";
import { CastMenu } from "@/features/room/CastMenu";
import {
  getPictureInPictureDocument,
  toggleVideoPictureInPicture,
} from "@/features/room/player/useWebPlayer";
import {
  PLAYER_CONTROL_BUTTON_CLASS,
  PLAYER_CONTROL_ICON_CLASS,
  PLAYER_OVERLAY_CONTROL_BUTTON_CLASS,
} from "@/shared/components/player/PlayerControls";
import {
  PlayerHudOverflowMenu,
  PlayerToolPanel,
  PlayerToolTile,
} from "@/shared/components/player/PlayerHudMenu";
import {
  glassOptionClass,
  glassOptionSelectedClass,
  glassPanelClass,
  glassTitleClass,
} from "@/shared/components/player/glassSurface";
import { VideoDanmakuLayer } from "./VideoDanmakuLayer";
import { VideoSidebar, type SidebarTab } from "./VideoSidebar";
import { UploaderDrawer } from "./UploaderDrawer";
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
import {
  usePlaylistStore,
  playlistContainsCurrentItem,
  playlistItemFromArchivePage,
  videoEndedAction,
  videoSwipeDirection,
  videoWheelDirection,
  type VideoWheelGesture,
  type PlaylistItem,
} from "./playlistStore";
import { notify, setToastPortalContainer } from "@/components/ui/toast";

const SINGLE_CLICK_DELAY_MS = 220;

/** 倍速档位：菜单可选 0.5x–2x；3x 只作为长按的临时档位，不进菜单。 */
const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

/** 长按倍速：按住画面临时 3 倍速，松开回到菜单选中的档位（B 站移动端同款）。 */
const LONG_PRESS_RATE = 3;
const LONG_PRESS_TRIGGER_MS = 500;
/** 移动超过这个距离视为滑动手势，取消长按判定。 */
const LONG_PRESS_CANCEL_MOVE_PX = 12;

function isPlayerControlTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(
    target.closest(
      'button, a, input, select, textarea, [contenteditable="true"], [role="button"], [role="slider"], [role="dialog"], [data-player-controls]',
    ),
  );
}

function bufferedRangeEnd(video: HTMLVideoElement): number {
  let end = 0;
  for (let index = 0; index < video.buffered.length; index += 1) {
    end = Math.max(end, video.buffered.end(index));
  }
  return Number.isFinite(end) ? end : 0;
}

function VideoSwipePreview({ item, label }: { item: PlaylistItem | null; label: string }) {
  return (
    <div
      data-video-swipe-preview
      aria-hidden
      className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center overflow-hidden bg-black text-white"
    >
      {item?.cover && (
        <img
          src={normalizeVideoCoverUrl(item.cover)}
          alt=""
          draggable={false}
          className="absolute inset-0 size-full object-contain"
        />
      )}
      <div className="relative flex max-w-full flex-col gap-2 rounded-xl bg-black/60 px-5 py-3 text-center">
        <p className="text-xs text-white/70">{label}</p>
        {item && <p className="line-clamp-2 text-sm font-medium">{item.title}</p>}
      </div>
    </div>
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
    <DrawerScope>
      <VideoPlayerPageContent />
    </DrawerScope>
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
  const swipeTrackRef = useRef<HTMLDivElement | null>(null);
  const swipeOffsetRef = useRef(0);
  const swipeAnimationRef = useRef<Animation | null>(null);
  const wheelGestureRef = useRef<VideoWheelGesture>({
    lastTime: -Infinity,
    distance: 0,
    committed: false,
  });
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const playerRef = useRef<XgPlayerInstance | null>(null);
  const controlsRef = useRef<HTMLDivElement | null>(null);
  const clickTimerRef = useRef<number | null>(null);
  // 长按倍速的临时状态全在 ref 里：按住期间不应触发重渲染（弹幕层在动，
  // 状态更新会打扰合成器），只有角标的显示与否走 state。
  const speedHoldTimerRef = useRef<number | null>(null);
  const speedHoldRef = useRef(false);
  const suppressClickRef = useRef(false);
  const surfacePressRef = useRef<{
    pointerId: number;
    x: number;
    y: number;
    swipe: boolean;
    moved: boolean;
    height: number;
    index: number;
    count: number;
    reducedMotion: boolean;
    samples: HorizontalSwipeSample[];
  } | null>(null);
  /** 上次记住的音量与静音态：所有会话级播放表面共享一份（见 shared/playerVolume）。 */
  const [initialAudio] = useState(readPlayerVolume);
  const volumeRef = useRef(initialAudio.volume);
  const mutedRef = useRef(initialAudio.muted);
  const previousVolumeRef = useRef(initialAudio.volume);
  const sliderTargetRef = useRef<number | null>(null);

  const [loading, setLoading] = useState(true);
  const [waiting, setWaiting] = useState(false);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [paused, setPaused] = useState(true);
  const [muted, setMuted] = useState(initialAudio.muted);
  const [volume, setVolume] = useState(initialAudio.volume);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [bufferedTime, setBufferedTime] = useState(0);
  const [frameSize, setFrameSize] = useState<{ key: string; ratio: number | null } | null>(null);
  const [shortVideo, setShortVideo] = useState(false);
  const [infoHidden, setInfoHidden] = useState(false);
  const [uploaderOpen, setUploaderOpen] = useState(false);
  const [detailsKey, setDetailsKey] = useState<string | null>(null);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab | null>(null);
  const shortVideoRef = useRef(false);
  const [swipePoster, setSwipePoster] = useState<PlaylistItem | null>(null);
  const [danmakuVisible, setDanmakuVisible] = useState(true);
  const [playerRevision, setPlayerRevision] = useState(0);
  /** 菜单选中的倍速；长按倍速是临时覆盖，不经过这个状态。 */
  const [playbackRate, setPlaybackRate] = useState(1);
  const [speedHoldActive, setSpeedHoldActive] = useState(false);
  const [overlayInteractionOpen, setOverlayInteractionOpen] = useState(false);
  /** 期望画质（null = 后端自选最高可用档）。切换后带着它重取播放信息。 */
  const [qualityQn, setQualityQn] = useState<number | null>(null);
  /** 仅音频（听视频）：跳过视频轨代理省流，切换时记录续播点后重建播放器。 */
  const [audioOnly, setAudioOnly] = useState(false);

  useEffect(() => {
    // 播放器模块与取流 IPC 同时准备，所有画幅共用已有 import 缓存。
    void loadXgPlayerModules(audioOnly ? "native" : "dash").catch(() => {});
  }, [audioOnly]);
  /** 画中画进出状态（监听媒体元素事件，WebView2 支持；Android WebView 无此 API）。 */
  const [pipActive, setPipActive] = useState(false);
  /** 投屏面板与 CC 字幕弹层的开关态。投屏面板窗口化时是顶栏 Popover，
   *  全屏时是 HUD 溢出菜单里的二级面板 —— 两者互斥（见 `stageOwnsTopBar`）。 */
  const [castOpen, setCastOpen] = useState(false);
  /** 全屏 HUD 右上角 `⋮` 溢出菜单的开关态（与直播页 HUD 同一形态）。 */
  const [hudMenuOpen, setHudMenuOpen] = useState(false);
  /** 正在投屏的设备名（null = 无会话），供入口磁贴展示「投屏中」。 */
  const [castingDevice, setCastingDevice] = useState<string | null>(null);
  const [subtitleOpen, setSubtitleOpen] = useState(false);
  /** 窗口全屏（应用内全屏）：隐藏页面 chrome（顶栏/侧栏/底部 Shell）让舞台
   *  撑满应用窗口，但保留系统窗口栏（最小化/最大化/关闭），与直播页的
   *  网页全屏同一语义；与画面全屏（元素级 top layer）相互独立、可叠加。 */
  const [webFullscreen, setWebFullscreen] = useState(false);
  /** 选中的字幕语言（null = 关闭字幕）。 */
  const [subtitleLan, setSubtitleLan] = useState<string | null>(null);
  /** 当前字幕的 VTT blob 地址。 */
  const [subtitleVttUrl, setSubtitleVttUrl] = useState<string | null>(null);
  // 换画质时记住切换前的位置与播放状态：播放器必然重建（新的代理端口 = 新的
  // MPD 地址），不存就会从头播。换视频（相关/分集跳转）不会碰它，天然从头播。
  const resumeAtRef = useRef<{ position: number; playing: boolean } | null>(null);
  // 用户在起播完成前按过暂停。自动起播的静音重试必须尊重它，
  // 否则卡加载时点暂停会被重试重新拉起，按钮状态与实际播放相反。
  const userPausedRef = useRef(false);

  const compact = useCompactPlayerViewport();
  const mobileClient = isMobileClient();
  const fullscreen = useRecordingPlayerFullscreen(stageRef);
  useScreenWakeLock(!paused && !loading && !playbackError);

  useEffect(() => {
    if (!fullscreen.fullscreen && !shortVideo) return;
    setToastPortalContainer(stageRef.current);
    return () => setToastPortalContainer(null);
  }, [fullscreen.fullscreen, shortVideo]);

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
  const frameAspectRatio = frameSize?.key === videoKey ? frameSize.ratio : null;
  const portraitVideo = !audioOnly && frameAspectRatio !== null && frameAspectRatio < 1;
  const mobilePortrait = mobileClient && !params?.epId && portraitVideo;
  const returningToShortVideo =
    mobileClient && !audioOnly && !params?.epId && detailsKey === videoKey && !shortVideo;

  useLayoutEffect(() => {
    if (audioOnly || params?.epId) {
      setShortVideo(false);
    } else if (
      mobileClient &&
      frameAspectRatio !== null &&
      frameAspectRatio < 1 &&
      detailsKey !== videoKey
    ) {
      setShortVideo(true);
    }
    // 画幅只决定首次进入；刷到横屏视频或等待首帧时都保持沉浸会话。
  }, [audioOnly, detailsKey, frameAspectRatio, mobileClient, params?.epId, videoKey]);

  useLayoutEffect(() => {
    // ended 读取即时模式；模式切换不进入播放器重建依赖。
    shortVideoRef.current = shortVideo;
  }, [shortVideo]);

  useEffect(() => {
    if (!shortVideo || !runningOnAndroidTauri()) return;
    // 复用直播的页面内全屏，不走会重新挂载 WebView 表面的 HTML 全屏。
    void setAndroidImmersive(true).catch(() => {});
    void setAndroidPlayerOrientation("portrait").catch(() => {});
    return () => {
      void setAndroidImmersive(false).catch(() => {});
      void setAndroidPlayerOrientation("auto").catch(() => {});
    };
  }, [shortVideo]);

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
  if (historyEntry) historyEntryRef.current = historyEntry;
  const historyResumeAtRef = useRef(0);
  historyResumeAtRef.current = videoResumePosition(resumeQuery.data, {
    cid,
    epId: params?.epId ?? null,
  });
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

  // 播放列表状态
  const playlistStore = usePlaylistStore();
  const nextItem = playlistStore.getNextItem();
  const prevItem = playlistStore.getPreviousItem();
  const bvid = params?.bvid ?? null;
  const epId = params?.epId ?? null;

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

  // 只响应路由身份变化：点相关/投稿卡片会先装新队列，再提交导航，
  // 不能因 store 更新而拿旧路由把新队列清空或抢回旧选集。
  useEffect(() => {
    const list = usePlaylistStore.getState();
    const currentId = `${bvid ?? ""}_${rawCid}`;
    if (list.currentId !== currentId && list.items.some((item) => item.id === currentId)) {
      list.setCurrentItem(currentId);
    }
  }, [bvid, rawCid]);

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
  const settledCidRef = useRef<number | null>(null);
  if (!playInfoQuery.isPlaceholderData) settledCidRef.current = cid;
  const switchingItem = playInfoQuery.isPlaceholderData && settledCidRef.current !== cid;
  const playInfo: VideoPlayInfo | undefined = switchingItem ? undefined : playInfoQuery.data;

  // 换集过渡：清掉旧集的播放错误并停住旧画面/声音（playInfo 已抹成 undefined，
  // 播放器 effect 会随之销毁旧实例），等新集信息就位再重建。
  useEffect(() => {
    if (!switchingItem) return;
    setPlaybackError(null);
    setPaused(true);
    const media = videoRef.current;
    if (media && !media.paused) media.pause();
  }, [switchingItem]);

  /** 切换画质：记录续播点后带着 qn 重取。 */
  const changeQuality = useCallback(
    (qn: number) => {
      if (qn === qualityQn) return;
      const media = videoRef.current;
      if (media) {
        resumeAtRef.current = { position: media.currentTime, playing: !media.paused };
      }
      setQualityQn(qn);
    },
    [qualityQn],
  );

  /** 仅音频（听视频）：与切画质同一重建链路（记录续播点 → 重取播放信息）。 */
  const toggleAudioOnly = useCallback(() => {
    const media = videoRef.current;
    if (media) {
      resumeAtRef.current = { position: media.currentTime, playing: !media.paused };
    }
    setAudioOnly((value) => !value);
  }, []);

  const togglePictureInPicture = useCallback(() => {
    void toggleVideoPictureInPicture(getPictureInPictureDocument(), videoRef.current);
  }, []);

  // CC 字幕列表：多数稿件没有，空列表/失败都按无字幕处理（按钮直接不渲染）。
  const subtitlesQuery = useQuery({
    queryKey: ["video_subtitles", cid, params?.bvid ?? "", params?.epId ?? ""],
    enabled: cid > 0,
    queryFn: () =>
      videoGetSubtitles({ bvid: params?.bvid ?? null, cid, ep_id: params?.epId ?? null }),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const subtitles = subtitlesQuery.data ?? [];

  // 投屏直链：打开弹层时才取（html5 playurl 的 MP4，与主播放链路无关）。
  const castQuery = useQuery({
    queryKey: ["video_cast_url", cid, params?.bvid ?? "", params?.epId ?? ""],
    enabled: castOpen && cid > 0,
    queryFn: () =>
      videoGetCastUrl({ bvid: params?.bvid ?? null, cid, ep_id: params?.epId ?? null }),
    staleTime: 5 * 60_000,
    retry: false,
  });

  const sessionIdsRef = useRef<VideoSessionIds | null>(null);
  // 用 query 的原始数据而不是上面换集时被抹成 undefined 的 `playInfo`：
  // session 链必须 A→B 连续（见下），中间出现 undefined 会丢掉旧引用、泄漏会话。
  if (playInfoQuery.data) sessionIdsRef.current = playInfoQuery.data.session_ids;
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
  danmakuVisibleRef.current = danmakuVisible;

  // 换视频要丢掉上一条的弹幕，否则新视频会投放旧视频的内容。
  useEffect(() => {
    loadedSegmentsRef.current = new Map();
    inFlightSegmentsRef.current = new Set();
    exhaustedFromRef.current = null;
    setDanmakuEntries([]);
    setDanmakuSegmentSettled(false);
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
      sliderTargetRef.current = null;
      setCurrentTime(clamped);
      setWaiting(true);
      // DASH 的 seek 走原生 `currentTime`：插件在 TIME_UPDATE 里按当前位置补拉分片
      // （见 xgplayer-dash 的 `loadData`），不需要也没有单独的 seek 入口。
      media.currentTime = clamped;
    },
    [duration],
  );

  const mpdUrl = playInfo?.mpd_url;
  // 仅音频时直接播音轨地址（完整 fMP4，代理转发 Range）；xgplayer-dash 写死假设
  // 视频轨存在，纯音 MPD 会崩，因此走 native 内核而不是 DASH。
  const playUrl = playInfo?.audio_only ? playInfo.audio_url : mpdUrl;
  const playKind: XgPlaybackKind = playInfo?.audio_only ? "native" : "dash";
  // DASH 专用：真实分片时间轴（插件自己按等长分片算的那份会选错分片，
  // 见 `applyXgDashSegmentTimeline`）。仅音频走原生内核，没有分片表。
  //
  // 存 ref 而不是进重建 effect 的依赖：它是随 play-info 一起到的新数组，放进依赖
  // 会让任何一次 refetch（同一个 mpd_url）都重建播放器。与 `sessionIdsRef` 同一手法。
  const dashSegmentTimelineRef = useRef<XgDashSegmentTimeline | undefined>(undefined);
  dashSegmentTimelineRef.current =
    playInfo && !playInfo.audio_only
      ? { video: playInfo.video_segment_times, audio: playInfo.audio_segment_times }
      : undefined;

  useEffect(() => {
    const video = videoRef.current;
    const root = rootRef.current;
    if (!video || !root || !playUrl) return;
    // 续播位置还没查出来就先不建播放器：先从 0 起播再跳会让画面闪一下，
    // 而这条查询是本地 SQLite，通常早于 playUrl（网络请求）就位。
    if (resumePending) return;
    const media = video;
    let cancelled = false;
    // 这一轮播放器对应的分集。上报前用它比对 ref 里的身份，
    // 避免换集过渡期把旧集进度记到新集身上。
    const reportedCid = cid;
    // 换集/换画质都会重建播放器：节流窗口按播放器实例重置，
    // 新的一集因此能立刻记下第一笔。
    historyReportedAtRef.current = null;

    setLoading(true);
    setWaiting(false);
    setPlaybackError(null);
    setPaused(true);
    userPausedRef.current = false;
    setCurrentTime(0);
    setBufferedTime(0);
    setDuration(playInfo?.duration ?? 0);

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
      if (sliderTargetRef.current === null) setCurrentTime(actual);
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
    function syncBuffered() {
      if (cancelled) return;
      setBufferedTime(bufferedRangeEnd(media));
    }
    function onPlay() {
      if (cancelled) return;
      setPaused(false);
      setWaiting(false);
      setLoading(false);
    }
    function onPause() {
      if (cancelled) return;
      setPaused(true);
      // 暂停是「可能马上要走」的最强信号：立刻落盘，不等节流窗口。
      reportProgress(Number.isFinite(media.currentTime) ? media.currentTime : 0, true);
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
      syncBuffered();
      syncAspectRatio();
      if (media.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        setSwipePoster((poster) =>
          poster && (poster.cid > 0 ? poster.cid === reportedCid : poster.bvid === bvid)
            ? null
            : poster,
        );
      }
    }
    function onWaiting() {
      if (!cancelled && !media.ended) setWaiting(true);
    }
    function onSeeked() {
      if (!cancelled) setWaiting(false);
    }
    function onEnded() {
      if (cancelled) return;
      setPaused(true);
      // 播完记满进度：历史卡的进度条画到底，续播判定据此认定「已看完」并从头播。
      const total = totalDuration();
      reportProgress(total > 0 ? total : media.currentTime, true);
      // 偏好可能在播放期间被改，读 store 快照而不是播放器挂载时的闭包值。
      const { autoPlayNext, loopPlayback, getNextItem } = usePlaylistStore.getState();
      const nextItem = getNextItem();
      const action = videoEndedAction(
        shortVideoRef.current || loopPlayback,
        autoPlayNext,
        nextItem != null,
      );
      if (action === "loop") {
        // 循环播放：从头重播当前集（DASH 的 seek 同样走原生 currentTime）。
        media.currentTime = 0;
        void media.play().catch(() => {
          // 自动重播被浏览器策略拦下时留在暂停态，用户点一下即可。
        });
        return;
      }
      if (action === "next" && nextItem) {
        const target = nextItem;
        setTimeout(() => {
          if (cancelled || shortVideoRef.current || !media.ended) return;
          goToPlaylistItem(target);
        }, 1_000);
      }
    }
    function onNativeError() {
      if (cancelled || !media.error) return;
      setPlaybackError(media.error.message || "视频播放失败");
      setLoading(false);
      setWaiting(false);
    }

    media.volume = volumeRef.current / 100;
    media.muted = mutedRef.current;
    media.addEventListener("timeupdate", syncTime);
    media.addEventListener("durationchange", syncDuration);
    media.addEventListener("progress", syncBuffered);
    media.addEventListener("loadedmetadata", onReady);
    media.addEventListener("canplay", onReady);
    media.addEventListener("resize", syncAspectRatio);
    media.addEventListener("play", onPlay);
    media.addEventListener("pause", onPause);
    media.addEventListener("waiting", onWaiting);
    media.addEventListener("seeked", onSeeked);
    media.addEventListener("ended", onEnded);
    media.addEventListener("error", onNativeError);

    void loadXgPlayerModules(playKind)
      .then((modules) => {
        if (cancelled) return;
        const player = createXgPlayer(modules, {
          root,
          video: media,
          // 喂的是 `mpd_url`（HTTP），不是 blob：xgplayer-dash 取清单的 XHR 会给地址
          // 拼 `?`，blob URL 走精确匹配因此 404。别「优化」成 blob。
          // 仅音频时喂音轨代理地址并走 native 内核。
          url: playUrl,
          kind: playKind,
          // VOD 必须显式关掉直播模式：`createXgPlayer` 默认 `isLive: true`，
          // 那会让 xgplayer 隐藏进度条并把时长当成不确定值。
          isLive: false,
          dashSegmentTimeline: dashSegmentTimelineRef.current,
        });
        playerRef.current = player;
        player.on("error", (cause) => {
          if (cancelled) return;
          setPlaybackError(xgPlayerErrorMessage(cause, "视频播放失败"));
          setLoading(false);
          setWaiting(false);
        });
        // 进页自动起播，与直播同源：先试带声音的 play()，被自动播放策略拒绝时
        // 降级为静音起播再立刻尝试恢复声音；用户手动静音过则保持静音。
        // 换画质重建时优先续播：恢复到切换前位置与播放状态，跳过起播策略。
        const resume = resumeAtRef.current;
        resumeAtRef.current = null;
        if (resume) {
          // 元数据就位前赋值 currentTime 会作为默认起播位置被采纳。
          media.currentTime = resume.position;
          setCurrentTime(resume.position);
          if (resume.playing) {
            void Promise.resolve(player.play()).catch(() => undefined);
          }
        } else {
          // 观看历史续播：上次看到一半的同一分集，从那个位置起播。位置写在
          // 起播之前，与换画质走同一条「元数据就位前赋值 currentTime」的路径；
          // 起播仍交给自动播放策略，否则被浏览器策略拒绝时会停在续播点不动。
          const historyResumeAt = historyResumeAtRef.current;
          if (historyResumeAt > 0) {
            media.currentTime = historyResumeAt;
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
        setPlaybackError(xgPlayerErrorMessage(cause, "无法初始化视频播放器"));
        setLoading(false);
      });

    return () => {
      // 销毁前记下最后一次进度:媒体元素此刻还能读 currentTime。
      // 放在 `cancelled = true` 之前,让它与其它 flush 走同一条 reportProgress。
      reportProgress(Number.isFinite(media.currentTime) ? media.currentTime : 0, true);
      cancelled = true;
      media.removeEventListener("timeupdate", syncTime);
      media.removeEventListener("durationchange", syncDuration);
      media.removeEventListener("progress", syncBuffered);
      media.removeEventListener("loadedmetadata", onReady);
      media.removeEventListener("canplay", onReady);
      media.removeEventListener("resize", syncAspectRatio);
      media.removeEventListener("play", onPlay);
      media.removeEventListener("pause", onPause);
      media.removeEventListener("waiting", onWaiting);
      media.removeEventListener("seeked", onSeeked);
      media.removeEventListener("ended", onEnded);
      media.removeEventListener("error", onNativeError);
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
    ensureDanmakuSegments,
    playUrl,
    playInfo?.duration,
    playKind,
    reportVideoProgress,
    resumePending,
    videoKey,
  ]);

  const togglePlayback = useCallback(() => {
    const player = playerRef.current;
    const media = videoRef.current;
    if (!player || !media) return;
    if (media.paused) {
      userPausedRef.current = false;
      void Promise.resolve(player.play()).catch((cause) => {
        if (isInterruptedPlayRequest(cause)) return;
        setPlaybackError(xgPlayerErrorMessage(cause, "播放失败"));
      });
    } else {
      userPausedRef.current = true;
      player.pause();
    }
  }, []);

  const setPlayerVolume = useCallback((next: number) => {
    const media = videoRef.current;
    const clamped = Math.max(0, Math.min(100, next));
    volumeRef.current = clamped;
    mutedRef.current = clamped === 0;
    if (clamped > 0) previousVolumeRef.current = clamped;
    setVolume(clamped);
    setMuted(clamped === 0);
    if (media) {
      media.volume = clamped / 100;
      media.muted = clamped === 0;
    }
  }, []);

  // 音量记忆：状态每变一档就落盘。同一个值不会触发重渲染，因此一次拖动最多
  // 写它经过的档位数，不需要额外节流。
  useEffect(() => {
    rememberPlayerVolume(volume, muted);
  }, [muted, volume]);

  // 倍速直接写到媒体元素上；换源（新播放地址）后重时应用一次。
  useEffect(() => {
    const media = videoRef.current;
    if (media) media.playbackRate = playbackRate;
  }, [playbackRate, playUrl]);

  // 画中画事件在媒体元素上触发且不冒泡；挂捕获阶段监听舞台，播放器重建也能接住。
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onEnter = () => setPipActive(true);
    const onLeave = () => setPipActive(false);
    stage.addEventListener("enterpictureinpicture", onEnter, true);
    stage.addEventListener("leavepictureinpicture", onLeave, true);
    return () => {
      stage.removeEventListener("enterpictureinpicture", onEnter, true);
      stage.removeEventListener("leavepictureinpicture", onLeave, true);
    };
  }, []);

  // 选中的字幕轨 → 后端代拉 JSON → 转 VTT blob；换语言时回收旧 blob。
  useEffect(() => {
    const subtitle = subtitles.find((item) => item.lan === subtitleLan);
    if (!subtitle) {
      setSubtitleVttUrl((previous) => {
        if (previous) URL.revokeObjectURL(previous);
        return null;
      });
      return;
    }
    let cancelled = false;
    videoGetSubtitle(subtitle.url)
      .then((raw) => {
        if (cancelled) return;
        const vtt = subtitleJsonToVtt(raw);
        if (!vtt) return;
        setSubtitleVttUrl((previous) => {
          if (previous) URL.revokeObjectURL(previous);
          return URL.createObjectURL(new Blob([vtt], { type: "text/vtt" }));
        });
      })
      .catch(() => undefined); // 拉取失败保持无字幕，下次选中重试
    return () => {
      cancelled = true;
    };
  }, [subtitleLan, subtitles]);

  // 把 VTT 挂到媒体元素（<track> 原生渲染）；换源重建媒体元素后重挂。
  useEffect(() => {
    const media = videoRef.current;
    if (!media) return;
    for (const track of [...media.querySelectorAll("track")]) track.remove();
    if (!subtitleVttUrl) return;
    const track = document.createElement("track");
    track.kind = "subtitles";
    track.srclang = subtitleLan ?? "zh";
    track.label = subtitles.find((item) => item.lan === subtitleLan)?.lan_doc ?? "字幕";
    track.src = subtitleVttUrl;
    media.appendChild(track);
    track.track.mode = "showing";
  }, [subtitleLan, subtitleVttUrl, playUrl, subtitles]);

  const playlistGestureEnabled =
    shortVideo &&
    !audioOnly &&
    !overlayInteractionOpen &&
    !uploaderOpen &&
    !pipActive &&
    playlistStore.items.length > 1 &&
    (playlistContainsCurrentItem(playlistStore.items, params?.bvid ?? null, rawCid) ||
      playlistContainsCurrentItem(playlistStore.items, params?.bvid ?? null, cid));
  const portraitSwipeEnabled = playlistGestureEnabled && swipePoster === null && !switchingItem;

  // 只移动画面与邻项封面，控制栏和全屏宿主不动，也不预建第二个播放器。
  const settleSwipe = useCallback((target: number, velocity = 0, complete?: () => void) => {
    const track = swipeTrackRef.current;
    const previous = swipeAnimationRef.current;
    const from =
      track && previous
        ? new DOMMatrixReadOnly(getComputedStyle(track).transform).m42
        : swipeOffsetRef.current;
    swipeAnimationRef.current = null;
    previous?.cancel();
    const finish = () => {
      swipeOffsetRef.current = target;
      if (track) {
        track.style.transform = target === 0 ? "" : `translate3d(0, ${target}px, 0)`;
        track.style.willChange = "";
      }
      complete?.();
    };
    if (!track || prefersReducedMotion() || Math.abs(from - target) < 1) {
      finish();
      return;
    }
    track.style.willChange = "transform";
    const animation = tween(
      track,
      [
        { transform: `translate3d(0, ${from}px, 0)` },
        { transform: `translate3d(0, ${target}px, 0)` },
      ],
      {
        duration: horizontalSwipeSettleDuration(target - from, velocity),
        easing: SWIPE_SETTLE_EASING,
        fill: "both",
      },
    );
    swipeAnimationRef.current = animation;
    void animation.finished
      .then(() => {
        if (swipeAnimationRef.current !== animation) return;
        swipeAnimationRef.current = null;
        finish();
        animation.cancel();
      })
      .catch(() => {});
  }, []);

  const stepPlaylist = useCallback(
    (direction: 1 | -1, velocity = 0) => {
      const list = usePlaylistStore.getState();
      const target = direction === 1 ? list.getNextItem() : list.getPreviousItem();
      if (!target) {
        settleSwipe(0, velocity);
        notify.info(direction === 1 ? "已经是最后一个视频" : "已经是第一个视频");
        return;
      }
      settleSwipe(-direction * (stageRef.current?.clientHeight ?? 0), velocity, () => {
        // 邻项封面接住画面，首帧到达后撤下；手势换片不累积返回栈。
        setSwipePoster(target);
        goToPlaylistItem(target, true);
      });
    },
    [goToPlaylistItem, settleSwipe],
  );

  useEffect(() => {
    const stage = stageRef.current;
    if (mobileClient || !stage) return;
    const onWheel = (event: WheelEvent) => {
      if (
        !playlistGestureEnabled ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        isPlayerControlTarget(event.target) ||
        Math.abs(event.deltaY) <= Math.abs(event.deltaX) * 1.25
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? stage.clientHeight : 1;
      const direction = videoWheelDirection(
        wheelGestureRef.current,
        event.deltaY * unit,
        event.timeStamp,
      );
      if (
        swipePoster !== null ||
        switchingItem ||
        swipeAnimationRef.current ||
        surfacePressRef.current
      ) {
        wheelGestureRef.current.committed = true;
        return;
      }
      if (direction !== null) stepPlaylist(direction);
    };
    // React 的 wheel 监听是 passive；在舞台上注册才能阻止换片时连带滚动页面。
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [mobileClient, playlistGestureEnabled, stepPlaylist, swipePoster, switchingItem]);

  useLayoutEffect(() => {
    swipeAnimationRef.current?.cancel();
    swipeAnimationRef.current = null;
    swipeOffsetRef.current = 0;
    const track = swipeTrackRef.current;
    if (track) {
      track.style.transform = "";
      track.style.willChange = "";
    }
  }, [bvid, cid, swipePoster]);

  const engageSpeedHold = useCallback(() => {
    if (surfacePressRef.current) surfacePressRef.current.swipe = false;
    const media = videoRef.current;
    // DASH 的 media.duration 可能为 Infinity，使用已有的真实分片时长。
    if (!media || duration <= 0 || loading || playbackError) return;
    speedHoldRef.current = true;
    suppressClickRef.current = true;
    media.playbackRate = LONG_PRESS_RATE;
    setSpeedHoldActive(true);
  }, [duration, loading, playbackError]);

  const releaseSpeedHold = useCallback(() => {
    if (speedHoldTimerRef.current !== null) {
      window.clearTimeout(speedHoldTimerRef.current);
      speedHoldTimerRef.current = null;
    }
    if (!speedHoldRef.current) return;
    speedHoldRef.current = false;
    const media = videoRef.current;
    if (media) media.playbackRate = playbackRate;
    setSpeedHoldActive(false);
  }, [playbackRate]);

  const cancelSurfacePress = useCallback(() => {
    if (surfacePressRef.current) suppressClickRef.current = true;
    surfacePressRef.current = null;
    releaseSpeedHold();
    settleSwipe(0);
  }, [releaseSpeedHold, settleSwipe]);

  useEffect(() => {
    const cancelMultiTouch = (event: PointerEvent) => {
      if (!event.isPrimary) cancelSurfacePress();
    };
    window.addEventListener("pointerdown", cancelMultiTouch, true);
    window.addEventListener("blur", cancelSurfacePress);
    window.addEventListener("resize", cancelSurfacePress);
    window.visualViewport?.addEventListener("resize", cancelSurfacePress);
    return () => {
      cancelSurfacePress();
      swipeAnimationRef.current?.cancel();
      swipeAnimationRef.current = null;
      if (clickTimerRef.current !== null) {
        window.clearTimeout(clickTimerRef.current);
        clickTimerRef.current = null;
      }
      window.removeEventListener("pointerdown", cancelMultiTouch, true);
      window.removeEventListener("blur", cancelSurfacePress);
      window.removeEventListener("resize", cancelSurfacePress);
      window.visualViewport?.removeEventListener("resize", cancelSurfacePress);
    };
  }, [cid, audioOnly, cancelSurfacePress]);

  const handleSurfacePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!event.isPrimary || event.button !== 0 || isPlayerControlTarget(event.target)) return;
      if (swipeAnimationRef.current || swipePoster !== null) {
        suppressClickRef.current = true;
        event.preventDefault();
        return;
      }
      // 新手势开始才清除抑制，避免拖动后的 click/dblclick 暂停或全屏下一条视频。
      suppressClickRef.current = false;
      surfacePressRef.current = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        swipe:
          portraitSwipeEnabled && (event.pointerType === "touch" || event.pointerType === "pen"),
        moved: false,
        height: event.currentTarget.clientHeight,
        index: prevItem ? 1 : 0,
        count: 1 + Number(prevItem !== null) + Number(nextItem !== null),
        reducedMotion: prefersReducedMotion(),
        samples: [{ x: event.clientY, time: event.timeStamp }],
      };
      if (speedHoldTimerRef.current !== null) {
        window.clearTimeout(speedHoldTimerRef.current);
      }
      speedHoldTimerRef.current = window.setTimeout(() => {
        speedHoldTimerRef.current = null;
        engageSpeedHold();
      }, LONG_PRESS_TRIGGER_MS);
    },
    [engageSpeedHold, nextItem, portraitSwipeEnabled, prevItem, swipePoster],
  );

  const handleSurfacePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const start = surfacePressRef.current;
      if (!start || start.pointerId !== event.pointerId) return;
      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      if (dx * dx + dy * dy <= LONG_PRESS_CANCEL_MOVE_PX * LONG_PRESS_CANCEL_MOVE_PX) return;
      if (!start.moved) {
        // 一旦起步为横滑就不再转成切片；长按已触发时 swipe 也已撤销。
        start.swipe &&= videoSwipeDirection(dx, dy, LONG_PRESS_CANCEL_MOVE_PX) !== null;
        start.moved = true;
        releaseSpeedHold();
        suppressClickRef.current = true;
        if (clickTimerRef.current !== null) {
          window.clearTimeout(clickTimerRef.current);
          clickTimerRef.current = null;
        }
        if (start.swipe) event.currentTarget.setPointerCapture(event.pointerId);
      }
      if (start.swipe) {
        // 速度采样与翻页阻尼沿用共享横滑算法，只把活动轴换成 Y。
        start.samples.push({ x: event.clientY, time: event.timeStamp });
        if (start.samples.length > 8) start.samples.shift();
        const offset = horizontalSwipeDragOffset(start.index, start.count, dy, start.height);
        swipeOffsetRef.current = offset;
        const track = swipeTrackRef.current;
        if (track && !start.reducedMotion) {
          track.style.willChange = "transform";
          track.style.transform = `translate3d(0, ${offset}px, 0)`;
        }
        event.preventDefault();
        event.stopPropagation();
      }
    },
    [releaseSpeedHold],
  );

  const handleSurfacePointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const start = surfacePressRef.current;
      if (!start || start.pointerId !== event.pointerId) return;
      surfacePressRef.current = null;
      releaseSpeedHold();
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      if (!start.swipe || !start.moved || !portraitSwipeEnabled) {
        settleSwipe(0);
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      start.samples.push({ x: event.clientY, time: event.timeStamp });
      const velocity = horizontalSwipeVelocity(start.samples);
      const deltaY = event.clientY - start.y;
      const direction = videoSwipeDirection(
        event.clientX - start.x,
        deltaY,
        LONG_PRESS_CANCEL_MOVE_PX,
      );
      const commit =
        direction !== null && horizontalSwipeShouldCommit(deltaY, velocity, start.height);
      if (!commit) {
        settleSwipe(0, velocity);
        return;
      }
      stepPlaylist(direction, velocity);
    },
    [portraitSwipeEnabled, releaseSpeedHold, settleSwipe, stepPlaylist],
  );

  const toggleMute = useCallback(() => {
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
  }, []);

  /**
   * 重试。
   *
   * 必须重新取一次播放信息而不是只重建播放器：失败常见于代理返回 502，而设计文档第四节
   * 记录过那条真实故障 —— 插件走 `MPD.init` 重试路径时会把 `mediaList.audio` 换成新
   * 数组从而**丢掉音轨**，画面在播但没有声音。重新起一轮会话是唯一能保证音轨挂回来的
   * 做法，因此失败态必须可见、可重试，不能静默。
   */
  const retryPlayback = useCallback(() => {
    setPlaybackError(null);
    setWaiting(false);
    setLoading(true);
    // 记下当前位置：重建走的是换画质那条续播路径，否则会退回观看历史里的
    // 旧位置（续播查询是进页时的快照，不随边看边上报更新）。
    const media = videoRef.current;
    if (media && media.currentTime > 0) {
      resumeAtRef.current = { position: media.currentTime, playing: !media.paused };
    }
    setPlayerRevision((revision) => revision + 1);
  }, []);

  const { revealControls, holdControlsVisible, scheduleControlsHide } = usePlayerChromeIdle({
    controlsRef,
    hudRef,
    keepVisible:
      shortVideo || paused || loading || Boolean(playbackError) || overlayInteractionOpen,
  });

  const openVideoDetails = useCallback(
    async (tab: SidebarTab = "related") => {
      cancelSurfacePress();
      if (fullscreen.fullscreen) await fullscreen.exit();
      setDetailsKey(videoKey);
      setShortVideo(false);
      setWebFullscreen(false);
      setSidebarTab(tab);
      setHudMenuOpen(false);
      setOverlayInteractionOpen(false);
      requestAnimationFrame(() => detailsRef.current?.focus({ preventScroll: true }));
    },
    [cancelSurfacePress, fullscreen.exit, fullscreen.fullscreen, videoKey],
  );

  const enterShortVideo = useCallback(async () => {
    cancelSurfacePress();
    wheelGestureRef.current.lastTime = -Infinity;
    if (fullscreen.fullscreen) await fullscreen.exit();
    setDetailsKey(null);
    setWebFullscreen(false);
    setInfoHidden(false);
    setShortVideo(true);
    requestAnimationFrame(() => stageRef.current?.focus({ preventScroll: true }));
  }, [cancelSurfacePress, fullscreen.exit, fullscreen.fullscreen]);

  const togglePlayerFullscreen = useCallback(() => {
    if (mobilePortrait || shortVideo || returningToShortVideo) {
      if (shortVideo) void openVideoDetails();
      else void enterShortVideo();
    } else {
      void fullscreen.toggle();
    }
  }, [
    enterShortVideo,
    fullscreen.toggle,
    mobilePortrait,
    openVideoDetails,
    returningToShortVideo,
    shortVideo,
  ]);

  const handleStagePointerActivity = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (isPlayerControlTarget(event.target)) holdControlsVisible();
      else revealControls();
    },
    [holdControlsVisible, revealControls],
  );

  useEffect(() => {
    revealControls();
  }, [fullscreen.fullscreen, shortVideo, revealControls]);

  const handleSurfaceClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (event.detail !== 1 || isPlayerControlTarget(event.target)) return;
      // 长按与滑动松开后的合成点击都不是暂停意图。
      if (suppressClickRef.current) return;
      if (shortVideo) {
        togglePlayback();
        return;
      }
      if (clickTimerRef.current !== null) window.clearTimeout(clickTimerRef.current);
      clickTimerRef.current = window.setTimeout(() => {
        clickTimerRef.current = null;
        togglePlayback();
      }, SINGLE_CLICK_DELAY_MS);
    },
    [shortVideo, togglePlayback],
  );

  const handleSurfaceDoubleClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (shortVideo) return;
      if (suppressClickRef.current || isPlayerControlTarget(event.target)) return;
      if (clickTimerRef.current !== null) {
        window.clearTimeout(clickTimerRef.current);
        clickTimerRef.current = null;
      }
      togglePlayerFullscreen();
    },
    [shortVideo, togglePlayerFullscreen],
  );

  const handleStageKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
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
        setPlayerVolume(volume + 10);
      } else if (key === "arrowdown") {
        event.preventDefault();
        setPlayerVolume(volume - 10);
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
      volume,
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

  const handlePageBack = useCallback(() => {
    if (returningToShortVideo) void enterShortVideo();
    else goBack();
  }, [enterShortVideo, goBack, returningToShortVideo]);

  useEffect(() => {
    if (!returningToShortVideo && !shortVideo) return;
    const onAndroidBack = (event: Event) => {
      if (event.defaultPrevented || fullscreen.fullscreen || webFullscreen) return;
      event.preventDefault();
      if (!mobileClient && shortVideo) void openVideoDetails();
      else handlePageBack();
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (dismissTopmostPopup(document)) return;
      onAndroidBack(event);
    };
    window.addEventListener(ANDROID_BACK_EVENT, onAndroidBack);
    window.addEventListener("keydown", onEscape);
    return () => {
      window.removeEventListener(ANDROID_BACK_EVENT, onAndroidBack);
      window.removeEventListener("keydown", onEscape);
    };
  }, [
    fullscreen.fullscreen,
    handlePageBack,
    mobileClient,
    openVideoDetails,
    returningToShortVideo,
    shortVideo,
    webFullscreen,
  ]);

  // 当前分 P 序号：多 P 稿件按 cid 从详情对出（链接缺 cid 时详情已补齐首 P），
  // 单 P 或详情未到时为 1，不影响地址正确性（P1 省略 ?p=）。
  const originalUrl = useMemo(() => {
    if (!params) return null;
    const page = archiveQuery.data?.pages.find((item) => item.cid === cid)?.page ?? 1;
    return videoOriginalUrl(params.bvid, params.epId, page);
  }, [archiveQuery.data, cid, params]);

  // 跳原址与复制链接：桌面端住底部 Shell、移动端住顶栏 `⋮` 抽屉（全屏时
  // 舞台盖住两者，HUD 里另有一份镜像）；打开与回退细节见 `openExternalUrl`，
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

  const title = params?.title || "视频播放";

  /** 沉浸/全屏舞台接管顶栏，工具只在顶栏或 HUD 中挂载一份。 */
  const stageOwnsTopBar = shortVideo || fullscreen.fullscreen || webFullscreen;

  /** 投屏源：顶栏 Popover 与 HUD 溢出菜单里的面板共用同一份参数，
   *  两处互斥渲染（见 `stageOwnsTopBar`），因此不会出现两个投屏会话入口。 */
  const castMenuProps = {
    castUrl: castQuery.data?.url ?? null,
    headers: castQuery.data?.headers ?? {},
    title: params?.title ?? "视频",
    variant: "overlay" as const,
    onCastingDeviceChange: setCastingDevice,
  };

  /** 顶栏右侧的低频工具（投屏）：与直播页顶栏右侧的定时/投屏工具同一布局
   *  语义。复制链接/跳原址在桌面端住底部 Shell，移动端收进 `⋮` 抽屉；
   *  全屏时顶栏被舞台吃掉，同一批入口改由 HUD 的 `⋮` 溢出菜单承载。 */
  const topBarTools = (
    <div className="flex items-center gap-1">
      {!mobileClient && params?.bvid && !params.epId && !audioOnly && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="进入刷视频模式"
          onClick={() => void enterShortVideo()}
        >
          <Smartphone aria-hidden />
        </Button>
      )}
      <Popover open={castOpen} onOpenChange={setCastOpen}>
        <PopoverTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              className="rounded-lg hover:bg-muted/70"
              aria-label="投屏"
              aria-expanded={castOpen}
            />
          }
        >
          <Cast data-icon="inline-start" aria-hidden className="size-4" />
        </PopoverTrigger>
        <PopoverContent
          side="bottom"
          align="end"
          collisionPadding={12}
          glass
          className={cn("w-72 overflow-y-auto p-1.5", glassPanelClass())}
        >
          <PopoverTitle className={cn("px-2 py-1", glassTitleClass())}>投屏</PopoverTitle>
          <CastMenu {...castMenuProps} showHeader={false} />
        </PopoverContent>
      </Popover>
      {mobileClient && (
        <VideoMobileActions
          originalUrl={originalUrl}
          onCopy={copyOriginalUrl}
          onOpen={openOriginalUrl}
        />
      )}
    </div>
  );

  const topBar = (
    <header className="relative flex h-11 shrink-0 items-center justify-center border-b border-border/80 bg-sidebar/90">
      <div className="absolute left-3 flex items-center gap-1">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                className="motion-back-button rounded-lg hover:bg-muted/70"
                aria-label={returningToShortVideo ? "返回短视频" : "返回视频列表"}
                onClick={handlePageBack}
              />
            }
          >
            <ChevronLeft data-icon="inline-start" aria-hidden />
          </TooltipTrigger>
          <TooltipContent>{returningToShortVideo ? "返回短视频" : "返回视频列表"}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                className="rounded-lg hover:bg-muted/70"
                aria-label={mobilePortrait ? "竖屏全屏" : "返回主页"}
                onClick={
                  mobilePortrait ? () => void enterShortVideo() : () => navigate(VIDEO_HOME_PATH)
                }
              />
            }
          >
            {mobilePortrait ? (
              <Smartphone data-icon="inline-start" aria-hidden />
            ) : (
              <Home data-icon="inline-start" aria-hidden />
            )}
          </TooltipTrigger>
          <TooltipContent>{mobilePortrait ? "竖屏全屏" : "返回主页"}</TooltipContent>
        </Tooltip>
      </div>
      <div className="pointer-events-none absolute inset-x-24 flex min-w-0 items-center justify-center px-16">
        <p className="truncate text-sm font-semibold tracking-tight" title={title}>
          {title}
        </p>
      </div>
      {!stageOwnsTopBar && <div className="absolute right-3 z-10">{topBarTools}</div>}
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

  const playlistPosition = playlistStore.getCurrentPosition();
  const timeline = (
    <div className="flex min-w-0 items-center gap-2 py-0.5 text-white/85">
      <Slider
        value={currentTime}
        min={0}
        max={duration || 1}
        step={0.1}
        variant="player"
        buffered={duration > 0 ? (bufferedTime / duration) * 100 : 0}
        disabled={!duration}
        aria-label="播放进度"
        aria-valuetext={`${formatRecordingDuration(currentTime * 1_000)} / ${formatRecordingDuration(duration * 1_000)}`}
        className="min-w-0 flex-1"
        onValueChange={(value) => {
          const next = Number(Array.isArray(value) ? value[0] : value);
          if (!Number.isFinite(next)) return;
          sliderTargetRef.current = next;
          setCurrentTime(next);
        }}
        onValueCommitted={(value) => {
          const next = Number(Array.isArray(value) ? value[0] : value);
          if (Number.isFinite(next)) seekTo(next);
        }}
      />
      <span className="shrink-0 font-mono text-[11px] tabular-nums text-white/80">
        {formatRecordingDuration(currentTime * 1_000)}
        <span className="px-1 text-white/45" aria-hidden>
          /
        </span>
        {formatRecordingDuration(duration * 1_000)}
        {(playlistStore.uploader || (!shortVideo && playlistStore.items.length > 1)) &&
          playlistPosition && (
            <span
              className="pl-2 text-white/60"
              aria-label={`${playlistStore.uploader ? "UP 主投稿" : "播放列表"}第 ${playlistPosition.current} 个，共 ${playlistPosition.total} 个`}
            >
              {playlistPosition.current}/{playlistPosition.total}
            </span>
          )}
      </span>
    </div>
  );

  // WebView2 桌面支持画中画；Android WebView 无此 API 时按钮由 PlayerControls 隐藏。
  const pipSupported = document.pictureInPictureEnabled;
  /** 控制栏工具（字幕）：与内部按钮同一套样式常量；没字幕轨的稿件不渲染
   *  字幕按钮。窗口全屏/画面全屏用 PlayerControls 内置的两个按钮（网页全屏
   *  toggle 应用内全屏，全屏走元素级 top layer）。 */
  const toolsSlot = subtitles.length > 0 && (
    <Popover open={subtitleOpen} onOpenChange={setSubtitleOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={subtitleLan ? "关闭字幕" : "开启字幕"}
            aria-pressed={Boolean(subtitleLan)}
            className={cn(
              PLAYER_CONTROL_BUTTON_CLASS,
              PLAYER_CONTROL_ICON_CLASS,
              PLAYER_OVERLAY_CONTROL_BUTTON_CLASS,
            )}
          />
        }
      >
        {subtitleLan ? <Captions aria-hidden /> : <CaptionsOff aria-hidden />}
      </PopoverTrigger>
      <PopoverContent
        container={stageRef}
        side="top"
        align="end"
        collisionBoundary={document.documentElement}
        collisionPadding={{ top: 24, right: 12, bottom: 12, left: 12 }}
        sticky
        glass
        className={cn("w-52 gap-0 overflow-y-auto p-1.5", glassPanelClass({ overlay: true }))}
      >
        <PopoverTitle className={cn("px-2 py-1", glassTitleClass({ overlay: true }))}>
          字幕
        </PopoverTitle>
        <Button
          variant="ghost"
          className={cn(
            "w-full justify-between max-md:h-10",
            glassOptionClass(),
            !subtitleLan && glassOptionSelectedClass(),
          )}
          aria-pressed={!subtitleLan}
          onClick={() => {
            setSubtitleLan(null);
            setSubtitleOpen(false);
          }}
        >
          <span className="truncate">关闭字幕</span>
          {!subtitleLan && <Check data-icon="inline-end" aria-hidden />}
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
            onClick={() => {
              setSubtitleLan(subtitle.lan);
              setSubtitleOpen(false);
            }}
          >
            <span className="truncate">{subtitle.lan_doc}</span>
            {subtitleLan === subtitle.lan && <Check data-icon="inline-end" aria-hidden />}
          </Button>
        ))}
      </PopoverContent>
    </Popover>
  );

  /** 倍速选择区：与播放列表设置同一个弹层，只有这一页需要它。 */
  const rateSettings = (
    <div className="flex flex-col gap-1 px-1 py-1">
      <p className="px-2.5 py-1 text-xs text-muted-foreground">倍速</p>
      <div className="flex flex-wrap gap-1.5 px-1.5 py-1">
        {PLAYBACK_RATES.map((rate) => (
          <button
            key={rate}
            type="button"
            onClick={() => setPlaybackRate(rate)}
            aria-pressed={rate === playbackRate}
            className={cn(
              "min-h-9 rounded-md px-2.5 text-sm tabular-nums transition-colors hover:bg-muted/50",
              rate === playbackRate && "bg-primary text-primary-foreground hover:bg-primary",
            )}
          >
            {rate === 1 ? "1.0x" : `${rate}x`}
          </button>
        ))}
      </div>
    </div>
  );

  /** 短视频固定单条循环；普通详情保留原有循环/连播设置。 */
  const playbackToggles = (
    <div className="flex flex-col gap-1 px-1 py-1">
      {shortVideo ? (
        <p className="px-2.5 py-1.5 text-sm">短视频模式单条循环，上下滑动切换视频。</p>
      ) : (
        <PlaybackSettingRow
          label="循环播放"
          checked={playlistStore.loopPlayback}
          onToggle={playlistStore.toggleLoopPlayback}
        />
      )}
      {playlistStore.items.length > 1 && (
        <>
          {!shortVideo && (
            <PlaybackSettingRow
              label="自动播放下一集"
              checked={playlistStore.autoPlayNext}
              onToggle={playlistStore.toggleAutoPlayNext}
            />
          )}
          <PlaybackSettingRow
            label="倒序播放"
            checked={playlistStore.reversed}
            onToggle={playlistStore.toggleReversed}
          />
        </>
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
      {!webFullscreen && !shortVideo && topBar}
      {/* 详情页按画面比例分配高度；沉浸模式让同一舞台铺满屏幕。 */}
      <main className="flex min-h-0 flex-1 flex-col bg-black lg:flex-row">
        <section
          ref={stageRef}
          data-player-stage
          data-video-mode={shortVideo ? "short" : "details"}
          data-fullscreen={
            (shortVideo && mobileClient) || (fullscreen.fullscreen && fullscreen.nativeLayer)
              ? "true"
              : undefined
          }
          className={cn(
            "relative flex min-w-0 flex-col overflow-hidden bg-black",
            shortVideo || webFullscreen
              ? "aspect-auto max-h-none flex-1"
              : portraitVideo || swipePoster !== null
                ? "aspect-[9/16] w-full max-lg:max-h-[56%]"
                : "aspect-video w-full max-lg:max-h-[56%]",
            "lg:aspect-auto lg:w-auto lg:flex-1",
            "data-[fullscreen=true]:rounded-none data-[fullscreen=true]:border-0",
          )}
          aria-label={`${title}；按空格或 K 播放或暂停，左右方向键快退或快进（Shift 加速 30 秒），上下方向键调音量，M 静音，F 全屏`}
          aria-keyshortcuts="Space K ArrowLeft ArrowRight ArrowUp ArrowDown M F"
          aria-description={
            portraitSwipeEnabled ? "竖屏画面上滑播放下一个，下滑播放上一个" : undefined
          }
          onPointerEnter={handleStagePointerActivity}
          onPointerMove={handleStagePointerActivity}
          onPointerLeave={scheduleControlsHide}
          onKeyDown={handleStageKeyDown}
          tabIndex={0}
        >
          <div
            data-player-video-surface
            className={cn(
              "relative min-h-0 flex-1 overflow-hidden bg-black",
              portraitSwipeEnabled && "touch-none select-none",
            )}
            onClick={handleSurfaceClick}
            onDoubleClick={handleSurfaceDoubleClick}
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
            <div ref={swipeTrackRef} data-video-swipe-track className="absolute inset-0">
              <div
                className="pointer-events-none absolute inset-x-0 bottom-full h-full"
                aria-hidden
              >
                <VideoSwipePreview
                  item={prevItem}
                  label={prevItem ? "上一个" : "已经是第一个视频"}
                />
              </div>
              <div className="pointer-events-none absolute inset-x-0 top-full h-full" aria-hidden>
                <VideoSwipePreview
                  item={nextItem}
                  label={nextItem ? "下一个" : "已经是最后一个视频"}
                />
              </div>
              <div
                ref={rootRef}
                data-player-engine-root
                className="absolute inset-0 size-full overflow-hidden bg-black"
              >
                <video
                  ref={videoRef}
                  data-player-video
                  playsInline
                  preload="metadata"
                  controls={false}
                  className="absolute inset-0 size-full bg-black object-contain"
                />
              </div>

              {danmakuEntries.length > 0 && (
                <VideoDanmakuLayer
                  videoRef={videoRef}
                  entries={danmakuEntries}
                  active={danmakuVisible}
                />
              )}

              {swipePoster && <VideoSwipePreview item={swipePoster} label="正在加载视频…" />}

              {speedHoldActive && (
                <div
                  role="status"
                  aria-live="polite"
                  className="pointer-events-none absolute left-1/2 top-4 z-20 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-black/70 px-3 py-1 text-sm font-medium text-white backdrop-blur-sm"
                >
                  <FastForward className="size-3.5" aria-hidden />
                  {LONG_PRESS_RATE.toFixed(1)}x 倍速中
                </div>
              )}

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
            </div>
          </div>

          {stageOwnsTopBar && (
            <div
              ref={shortVideo ? undefined : hudRef}
              data-player-hud
              data-visible="true"
              aria-hidden="false"
              className={cn(
                "absolute inset-x-0 top-0 z-30 transition-opacity duration-150 ease-out",
                "motion-reduced:transition-none data-[visible=false]:pointer-events-none data-[visible=false]:opacity-0",
                "player-scrim-overlay-top flex min-w-0 items-center justify-between gap-2 bg-transparent pr-[max(0.375rem,env(safe-area-inset-right))] pl-[max(0.75rem,env(safe-area-inset-left))] pt-[max(0.375rem,env(safe-area-inset-top))] text-white",
                compact ? "pb-3" : "pb-6",
              )}
              onPointerEnter={holdControlsVisible}
              onPointerLeave={scheduleControlsHide}
              onFocusCapture={holdControlsVisible}
              onBlurCapture={scheduleControlsHide}
            >
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={
                  shortVideo
                    ? mobileClient
                      ? "返回视频列表"
                      : "退出刷视频模式"
                    : fullscreen.fullscreen
                      ? "退出全屏"
                      : "退出窗口全屏"
                }
                className={cn(
                  PLAYER_CONTROL_BUTTON_CLASS,
                  PLAYER_CONTROL_ICON_CLASS,
                  PLAYER_OVERLAY_CONTROL_BUTTON_CLASS,
                  "shrink-0",
                )}
                // 与直播页 HUD 的返回箭头同一层级语义：两层全屏叠加时一次只收
                // 一层（原生/元素全屏优先，窗口全屏留给下一次）。
                onClick={() => {
                  if (shortVideo) {
                    if (mobileClient) goBack();
                    else void openVideoDetails();
                  } else if (fullscreen.fullscreen) void fullscreen.exit();
                  else setWebFullscreen(false);
                }}
              >
                <ChevronLeft data-icon="inline-start" aria-hidden />
              </Button>
              {(!shortVideo || !mobileClient) && (
                <p className="min-w-0 flex-1 truncate px-1 text-sm font-semibold" title={title}>
                  {title}
                </p>
              )}
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
                // 固定沉浸层和画面全屏都需舞台内 portal；窗口全屏仍走默认宿主。
                portalContainer={shortVideo || fullscreen.fullscreen ? stageRef : undefined}
              >
                <div className="grid grid-cols-4 gap-1.5 max-md:gap-2">
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
          )}

          {shortVideo && (
            // 这层只负责渐变底衬，不带 z-index：控制栏（z-30）要画在渐变之上，
            // 否则它自己的 `from-black/70` 最浓端会压暗进度条与按钮。
            // 文字/按钮各自带 `relative z-40` 逃到控制栏遮罩之上（父层一旦有
            // z-index 就自建层叠上下文，子层再高也出不去）。
            <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end gap-3 bg-linear-to-t from-black/70 to-transparent px-4 pt-12 pb-[calc(5.5rem+env(safe-area-inset-bottom))] text-white">
              <div
                data-video-short-info
                data-visible={!infoHidden}
                aria-hidden={infoHidden}
                inert={infoHidden}
                className="relative z-40 min-w-0 flex-1 transition-opacity duration-150 motion-reduced:transition-none data-[visible=false]:opacity-0"
              >
                {archiveQuery.data?.author && (
                  <div className="mb-2 flex min-w-0 items-center gap-2.5">
                    <button
                      type="button"
                      aria-label={`查看 ${archiveQuery.data.author} 的投稿视频`}
                      disabled={!archiveQuery.data.author_mid}
                      className="pointer-events-auto shrink-0 rounded-full focus-ring-overlay"
                      onClick={() => {
                        setUploaderOpen(true);
                        setOverlayInteractionOpen(true);
                      }}
                    >
                      <Avatar size="lg">
                        <AvatarImage
                          src={normalizeImageUrl(archiveQuery.data.author_face)}
                          alt={`${archiveQuery.data.author} 的头像`}
                          referrerPolicy="no-referrer"
                        />
                        <AvatarFallback>
                          {Array.from(archiveQuery.data.author)[0] ?? "?"}
                        </AvatarFallback>
                      </Avatar>
                    </button>
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <p className="truncate text-sm font-semibold leading-5">
                        {archiveQuery.data.author}
                      </p>
                      <div className="flex items-center gap-2 text-xs leading-4 text-white/70">
                        <span
                          className="inline-flex items-center gap-1"
                          title={`粉丝：${formatOnline(archiveQuery.data.author_fans)}`}
                        >
                          <Users aria-hidden className="size-3.5" />
                          <span className="tabular-nums">
                            {formatOnline(archiveQuery.data.author_fans)}
                          </span>
                        </span>
                        <span
                          className="inline-flex items-center gap-1"
                          title={`视频：${formatOnline(archiveQuery.data.author_videos)}`}
                        >
                          <Video aria-hidden className="size-3.5" />
                          <span className="tabular-nums">
                            {formatOnline(archiveQuery.data.author_videos)}
                          </span>
                        </span>
                      </div>
                    </div>
                  </div>
                )}
                <p className="line-clamp-2 text-sm font-semibold leading-5 tracking-tight">
                  {swipePoster?.title ?? title}
                </p>
              </div>
              <Button
                variant="ghost"
                className={cn(
                  PLAYER_OVERLAY_CONTROL_BUTTON_CLASS,
                  "pointer-events-auto relative z-40 h-auto min-h-11 shrink-0 flex-col gap-1 px-3 py-2",
                )}
                aria-label="查看视频评论"
                onClick={() => void openVideoDetails("comments")}
              >
                <MessageSquareText data-icon="inline-start" aria-hidden />
                <span className="text-xs">评论</span>
              </Button>
            </div>
          )}
          {shortVideo && archiveQuery.data?.author_mid && (
            <UploaderDrawer
              open={uploaderOpen}
              onOpenChange={(open) => {
                setUploaderOpen(open);
                setOverlayInteractionOpen(open);
              }}
              mid={archiveQuery.data.author_mid}
              uploaderName={archiveQuery.data.author}
              container={stageRef}
            />
          )}

          <div
            ref={controlsRef}
            data-player-controls
            data-visible="true"
            aria-hidden="false"
            className="absolute inset-x-0 bottom-0 z-30 transition-opacity duration-150 ease-out motion-reduced:transition-none data-[visible=false]:pointer-events-none data-[visible=false]:opacity-0"
            onPointerEnter={holdControlsVisible}
            onPointerLeave={scheduleControlsHide}
            onFocusCapture={holdControlsVisible}
            onBlurCapture={scheduleControlsHide}
          >
            <PlayerControls
              paused={paused}
              volume={volume}
              muted={muted}
              osdOn={danmakuVisible}
              webFullscreen={webFullscreen}
              fullscreen={shortVideo || fullscreen.fullscreen}
              onToggleWebFullscreen={
                mobilePortrait || shortVideo || returningToShortVideo
                  ? togglePlayerFullscreen
                  : () => setWebFullscreen((value) => !value)
              }
              disabled={loading}
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
              timeline={timeline}
              playbackSettings={
                <>
                  {rateSettings}
                  <Separator className="my-1 max-md:my-0.5" />
                  {playbackToggles}
                </>
              }
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
              onNext={nextItem ? () => goToPlaylistItem(nextItem) : undefined}
              toolsSlot={toolsSlot}
              infoVisible={!infoHidden}
              onToggleInfo={shortVideo ? () => setInfoHidden((hidden) => !hidden) : undefined}
              audioOnly={audioOnly}
              onToggleAudioOnly={toggleAudioOnly}
              pictureInPictureSupported={pipSupported}
              pictureInPictureActive={pipActive}
              onTogglePictureInPicture={togglePictureInPicture}
              onTogglePause={togglePlayback}
              onToggleMute={toggleMute}
              onVolume={setPlayerVolume}
              onToggleOsd={() => setDanmakuVisible((visible) => !visible)}
              onToggleFullscreen={togglePlayerFullscreen}
            />
          </div>
        </section>
        {!webFullscreen && (
          <aside
            ref={detailsRef}
            tabIndex={-1}
            aria-label="视频详情"
            className={cn(
              // 与直播播放页右侧栏同一套规格：bg-sidebar、边框、断点宽度，
              // 窄屏则如直播的紧凑侧栏一样列在播放器下方。
              "relative isolate flex min-h-0 flex-1 flex-col border-t border-border/80 bg-sidebar max-md:pb-[env(safe-area-inset-bottom)]",
              "lg:w-[300px] lg:flex-none lg:border-t-0 lg:border-l xl:w-[320px] lg:pb-0",
              shortVideo && "hidden",
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
            <DrawerViewport active={!fullscreen.fullscreen && !shortVideo} />
          </aside>
        )}
      </main>
      {/* 底部 Shell 只在桌面端常驻（与直播页底部操作行同一画法）：移动端
          的两个入口收进顶栏 `⋮` 抽屉。全屏（元素级 top layer）时被舞台盖住，
          HUD 的 `⋮` 溢出菜单里另有镜像；窗口全屏时从布局卸载。 */}
      {!webFullscreen && !shortVideo && !mobileClient && (
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
 * 播放设置面板里的勾选行。三个播放偏好共用同一画法，勾选框是内联 SVG
 * 而不是 `Switch`：面板走的是紧凑列表形态，与倍速档位并排。
 */
function PlaybackSettingRow({
  label,
  checked,
  onToggle,
}: {
  label: string;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={checked}
      className="flex min-h-9 items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-muted/50"
    >
      <div
        className={cn(
          "flex size-4 shrink-0 items-center justify-center rounded border-2 transition-colors",
          checked ? "border-primary bg-primary" : "border-muted-foreground/50",
        )}
      >
        {checked && (
          <svg
            viewBox="0 0 12 12"
            fill="none"
            className="size-3 text-primary-foreground"
            aria-hidden="true"
          >
            <path
              d="M10 3L4.5 8.5L2 6"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </div>
      <span className="flex-1">{label}</span>
    </button>
  );
}

/** 手机和平板的链接操作复用直播页顶栏抽屉形态。 */
function VideoMobileActions({
  originalUrl,
  onCopy,
  onOpen,
}: {
  originalUrl: string | null;
  onCopy: () => void;
  onOpen: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Drawer open={open} onOpenChange={setOpen}>
      <DrawerTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            className="rounded-lg hover:bg-muted/70"
            aria-label="更多视频操作"
          />
        }
      >
        <Ellipsis data-icon="inline-start" aria-hidden />
      </DrawerTrigger>
      <DrawerContent
        side="bottom"
        glass
        className={cn("space-y-2", glassPanelClass({ overlay: true }))}
      >
        <DrawerTitle className={cn("px-1 pb-1", glassTitleClass({ overlay: true }))}>
          视频操作
        </DrawerTitle>
        <div className="grid grid-cols-4 gap-2">
          <PlayerToolTile
            icon={Link2}
            label="复制链接"
            disabled={!originalUrl}
            onClick={() => {
              setOpen(false);
              onCopy();
            }}
          />
          <PlayerToolTile
            icon={ExternalLink}
            label="在浏览器中打开"
            disabled={!originalUrl}
            onClick={() => {
              setOpen(false);
              onOpen();
            }}
          />
        </div>
      </DrawerContent>
    </Drawer>
  );
}
