import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import {
  Captions,
  CaptionsOff,
  Check,
  ChevronLeft,
  ExternalLink,
  FastForward,
  Home,
  Maximize2,
  Minimize2,
  Tv,
} from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { Spinner } from "@/components/ui/spinner";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ErrorState } from "@/shared/components/ErrorState";
import { PlayerControls } from "@/shared/components/player/PlayerControls";
import { useCompactPlayerViewport } from "@/shared/hooks/usePlayerViewport";
import { useScreenWakeLock } from "@/shared/hooks/useScreenWakeLock";
import { canNavigateBackInApp } from "@/shared/appHistory";
import { cn } from "@/lib/utils";
import {
  createXgPlayer,
  loadXgPlayerModules,
  xgPlayerErrorMessage,
  type XgPlaybackKind,
  type XgPlayerInstance,
} from "@/features/room/player/xgPlayer";
import { requestPlayerAutoplay } from "@/features/room/player/autoplay";
import { useRecordingPlayerFullscreen } from "@/features/recording/useRecordingPlayerFullscreen";
import { formatRecordingDuration } from "@/features/recording/recording";
import type { VideoPlayInfo, VideoSessionIds } from "@/shared/types/video";
import { DanmakuComposer } from "@/features/room/BilibiliDanmakuComposer";
import { videoGetArchive, videoGetCastUrl, videoGetDanmaku, videoGetPlayInfo, videoGetSubtitle, videoGetSubtitles, videoStopPlay } from "./videoApi";
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
  showPlayerControlsCenterSlot,
} from "@/shared/components/player/PlayerControls";
import {
  glassOptionClass,
  glassOptionSelectedClass,
  glassPanelClass,
  glassTitleClass,
} from "@/shared/components/player/glassSurface";
import { VideoDanmakuLayer } from "./VideoDanmakuLayer";
import { VideoSidebar } from "./VideoSidebar";
import {
  mergeVideoDanmakuEntries,
  videoDanmakuEntries,
  videoDanmakuSegmentsFor,
  type VideoDanmakuEntry,
} from "./videoDanmaku";
import { VIDEO_HOME_PATH, parseVideoPlayParams, videoOriginalUrl, videoPlayPath } from "./videoRoute";
import {
  usePlaylistStore,
  playlistItemFromArchivePage,
  playlistItemFromSeasonEpisode,
  type PlaylistItem,
} from "./playlistStore";
import { openUrl } from "@tauri-apps/plugin-opener";
import { notify } from "@/components/ui/toast";

const CONTROLS_HIDE_DELAY_MS = 2_600;
const SINGLE_CLICK_DELAY_MS = 220;

/** 倍速档位：菜单可选 0.5x–2x；3x 只作为长按的临时档位，不进菜单。 */
const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

/** 长按倍速：按住画面临时 3 倍速，松开回到菜单选中的档位（B 站移动端同款）。 */
const LONG_PRESS_RATE = 3;
const LONG_PRESS_TRIGGER_MS = 500;
/** 移动超过这个距离视为滑动手势，取消长按判定。 */
const LONG_PRESS_CANCEL_MOVE_PX = 12;

function isPlayerControlTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(
    target.closest(
      'button, input, select, textarea, [role="button"], [role="slider"], [role="dialog"], [data-player-controls]',
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

/**
 * `/video/play`：B 站视频（VOD）播放页。
 *
 * 与录制回放（`RecordingPlayer`）共用同一套 chrome —— `PlayerControls`、
 * 全屏适配器、紧凑视口与屏幕常亮 —— 因为它们是同一类表面：一条有确定时长、
 * 可拖进度的本地代理媒体。差别只在协议内核（DASH）与弹幕调度源。
 */
export function VideoPlayerPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const params = parseVideoPlayParams(searchParams);

  const stageRef = useRef<HTMLDivElement | null>(null);
  const hudRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const playerRef = useRef<XgPlayerInstance | null>(null);
  const controlsRef = useRef<HTMLDivElement | null>(null);
  const controlsHideTimerRef = useRef<number | null>(null);
  const clickTimerRef = useRef<number | null>(null);
  // 长按倍速的临时状态全在 ref 里：按住期间不应触发重渲染（弹幕层在动，
  // 状态更新会打扰合成器），只有角标的显示与否走 state。
  const speedHoldTimerRef = useRef<number | null>(null);
  const speedHoldRef = useRef(false);
  const suppressClickRef = useRef(false);
  const speedHoldStartRef = useRef<{ x: number; y: number } | null>(null);
  const volumeRef = useRef(80);
  const mutedRef = useRef(false);
  const previousVolumeRef = useRef(80);
  const sliderTargetRef = useRef<number | null>(null);

  const [loading, setLoading] = useState(true);
  const [waiting, setWaiting] = useState(false);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [paused, setPaused] = useState(true);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(80);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [bufferedTime, setBufferedTime] = useState(0);
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
  /** 画中画进出状态（监听媒体元素事件，WebView2 支持；Android WebView 无此 API）。 */
  const [pipActive, setPipActive] = useState(false);
  /** 投屏与 CC 字幕弹层的开关态。 */
  const [castOpen, setCastOpen] = useState(false);
  const [subtitleOpen, setSubtitleOpen] = useState(false);
  /** 选中的字幕语言（null = 关闭字幕）。 */
  const [subtitleLan, setSubtitleLan] = useState<string | null>(null);
  /** 当前字幕的 VTT blob 地址。 */
  const [subtitleVttUrl, setSubtitleVttUrl] = useState<string | null>(null);
  // 换画质时记住切换前的位置与播放状态：播放器必然重建（新的代理端口 = 新的
  // MPD 地址），不存就会从头播。换视频（相关/分集跳转）不会碰它，天然从头播。
  const resumeAtRef = useRef<{ position: number; playing: boolean } | null>(null);

  const compact = useCompactPlayerViewport();
  const fullscreen = useRecordingPlayerFullscreen(stageRef);
  useScreenWakeLock(!paused && !loading && !playbackError);

  const rawCid = params?.cid ?? 0;

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
  const cid = rawCid > 0 ? rawCid : (archiveQuery.data?.cid ?? 0);
  // 弹幕发送历史与 PGC 分集都用 aid；URL 直入时用详情补齐。
  const aid = params?.aid || archiveQuery.data?.aid || null;

  // 播放列表状态
  const playlistStore = usePlaylistStore();
  const nextItem = playlistStore.getNextItem();
  const prevItem = playlistStore.getPreviousItem();

  /** 跳到播放列表的另一项：自动连播、控制条按钮与键盘快捷键共用。 */
  const goToPlaylistItem = useCallback(
    (item: PlaylistItem) => {
      navigate(
        videoPlayPath({
          bvid: item.bvid,
          cid: item.cid,
          epId: item.epId,
          title: item.title,
          aid: item.aid,
        }),
      );
    },
    [navigate],
  );

  // 当前播放项更新时同步到 store
  useEffect(() => {
    if (params && playlistStore.items.length > 0) {
      const currentId = `${params.bvid || ""}_${params.cid}`;
      if (playlistStore.currentId !== currentId) {
        const exists = playlistStore.items.some((item) => item.id === currentId);
        if (exists) {
          playlistStore.setCurrentItem(currentId);
        }
      }
    }
  }, [params, playlistStore]);

  // 结构化列表优先：多 P 稿件用分 P 列表、合集稿件用合集替换播放列表
  // （覆盖搜索/投稿快照），自动连播与「下一个」沿结构化列表走。
  // 多 P 优先于合集：分 P 是同一稿件内部的选集，语义更具体；
  // 链接可能没带 cid，多 P 以 bvid+caid 定位当前项、合集以 bvid。
  useEffect(() => {
    const archive = archiveQuery.data;
    if (!archive || !params?.bvid) return;
    let items: PlaylistItem[] | null = null;
    let startId: string | null = null;
    if (archive.pages.length > 0) {
      items = archive.pages.map((page) =>
        playlistItemFromArchivePage(archive.bvid, archive.aid, page),
      );
      // 链接缺 cid（搜索进入）时用详情补齐的首 P cid 定位。
      const cid = params.cid > 0 ? params.cid : archive.cid;
      startId = `${params.bvid}_${cid}`;
    } else if (archive.ugc_season) {
      items = archive.ugc_season.episodes.map(playlistItemFromSeasonEpisode);
      const current = items.find((item) => item.bvid === params.bvid);
      startId = current?.id ?? null;
    }
    if (!items || !startId) return; // 列表里没有当前稿件则不动现有列表
    const alreadyActive =
      playlistStore.items.length === items.length &&
      playlistStore.items.every((item, i) => item.id === items[i]?.id) &&
      playlistStore.currentId === startId;
    if (!alreadyActive) {
      playlistStore.setPlaylist(items, startId);
    }
  }, [archiveQuery.data, params, playlistStore]);

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
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  const playInfo: VideoPlayInfo | undefined = playInfoQuery.data;

  /** 切换画质：记录续播点后带着 qn 重取。 */
  const changeQuality = useCallback((qn: number) => {
    if (qn === qualityQn) return;
    const media = videoRef.current;
    if (media) {
      resumeAtRef.current = { position: media.currentTime, playing: !media.paused };
    }
    setQualityQn(qn);
  }, [qualityQn]);

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

  /**
   * 离开播放页停掉三个代理会话。
   *
   * 三条流（video / audio / mpd）各占一个 session_id，必须一起停，否则三条本机监听器
   * 与其上游连接都会泄漏。用 ref 存最后一份 session_ids 而不是放进依赖数组：清理必须
   * 在**卸载**时跑，而按 session_ids 作依赖会让它在每次取到新播放信息时提前触发，
   * 把正在播的会话停掉。
   */
  const sessionIdsRef = useRef<VideoSessionIds | null>(null);
  if (playInfo) sessionIdsRef.current = playInfo.session_ids;
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
    previousSessionsRef.current = playInfo?.session_ids ?? null;
    if (previous && playInfo && previous.mpd !== playInfo.session_ids.mpd) {
      void videoStopPlay(previous);
    }
  }, [playInfo]);

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
  }, [cid]);

  const ensureDanmakuSegments = useCallback(
    (positionMs: number) => {
      if (!cid || !danmakuVisibleRef.current) return;
      for (const segment of videoDanmakuSegmentsFor(positionMs)) {
        const exhaustedFrom = exhaustedFromRef.current;
        if (exhaustedFrom !== null && segment >= exhaustedFrom) continue;
        if (loadedSegmentsRef.current.has(segment)) continue;
        if (inFlightSegmentsRef.current.has(segment)) continue;
        inFlightSegmentsRef.current.add(segment);
        void videoGetDanmaku(cid, segment)
          .then((result) => {
            loadedSegmentsRef.current.set(segment, videoDanmakuEntries(result.items, segment));
            // `has_more === false` 是上游 HTTP 304 的封装：这一段之后没有内容了。
            if (!result.has_more) {
              exhaustedFromRef.current =
                exhaustedFromRef.current === null
                  ? segment + 1
                  : Math.min(exhaustedFromRef.current, segment + 1);
            }
            setDanmakuEntries(mergeVideoDanmakuEntries([...loadedSegmentsRef.current.values()]));
          })
          .catch(() => {
            // 单段失败不影响其余段落；下次经过这个位置会再试一次。
          })
          .finally(() => {
            inFlightSegmentsRef.current.delete(segment);
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
      const clamped = Math.max(0, duration > 0 ? Math.min(target, duration) : target);
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

  useEffect(() => {
    const video = videoRef.current;
    const root = rootRef.current;
    if (!video || !root || !playUrl) return;
    const media = video;
    let cancelled = false;

    setLoading(true);
    setWaiting(false);
    setPlaybackError(null);
    setPaused(true);
    setCurrentTime(0);
    setBufferedTime(0);
    setDuration(playInfo?.duration ?? 0);

    function syncTime() {
      if (cancelled) return;
      const actual = Number.isFinite(media.currentTime) ? Math.max(0, media.currentTime) : 0;
      if (sliderTargetRef.current === null) setCurrentTime(actual);
      ensureDanmakuSegments(actual * 1_000);
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
      if (!cancelled) setPaused(true);
    }
    function onReady() {
      if (cancelled) return;
      setLoading(false);
      setWaiting(false);
      syncTime();
      syncDuration();
      syncBuffered();
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
      // 自动播放下一集
      if (playlistStore.autoPlayNext && nextItem) {
        const target = nextItem;
        setTimeout(() => {
          if (cancelled) return;
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
          const recoverMutedAutoplay = () => {
            if (mutedRef.current) return false;
            mutedRef.current = false;
            setMuted(false);
            return true;
          };
          requestPlayerAutoplay(
            player,
            media,
            () => !cancelled && playerRef.current === player,
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
      cancelled = true;
      media.removeEventListener("timeupdate", syncTime);
      media.removeEventListener("durationchange", syncDuration);
      media.removeEventListener("progress", syncBuffered);
      media.removeEventListener("loadedmetadata", onReady);
      media.removeEventListener("canplay", onReady);
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
  }, [ensureDanmakuSegments, playUrl, playInfo?.duration, playKind]);

  const togglePlayback = useCallback(() => {
    const player = playerRef.current;
    const media = videoRef.current;
    if (!player || !media) return;
    if (media.paused) {
      void Promise.resolve(player.play()).catch((cause) => {
        setPlaybackError(xgPlayerErrorMessage(cause, "播放失败"));
      });
    } else {
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

  const engageSpeedHold = useCallback(() => {
    const media = videoRef.current;
    // 没有时长（还没取到流）或已出错时按住没有意义。
    if (!media || !Number.isFinite(media.duration) || media.duration <= 0) return;
    speedHoldRef.current = true;
    suppressClickRef.current = true;
    media.playbackRate = LONG_PRESS_RATE;
    setSpeedHoldActive(true);
  }, []);

  const releaseSpeedHold = useCallback(() => {
    if (speedHoldTimerRef.current !== null) {
      window.clearTimeout(speedHoldTimerRef.current);
      speedHoldTimerRef.current = null;
    }
    speedHoldStartRef.current = null;
    if (!speedHoldRef.current) return;
    speedHoldRef.current = false;
    const media = videoRef.current;
    if (media) media.playbackRate = playbackRate;
    setSpeedHoldActive(false);
  }, [playbackRate]);

  const handleSurfacePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || isPlayerControlTarget(event.target)) return;
      // 新手势开始：清掉上一次长按残留的 click 抑制。
      suppressClickRef.current = false;
      speedHoldStartRef.current = { x: event.clientX, y: event.clientY };
      if (speedHoldTimerRef.current !== null) {
        window.clearTimeout(speedHoldTimerRef.current);
      }
      speedHoldTimerRef.current = window.setTimeout(() => {
        speedHoldTimerRef.current = null;
        engageSpeedHold();
      }, LONG_PRESS_TRIGGER_MS);
    },
    [engageSpeedHold],
  );

  const handleSurfacePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const start = speedHoldStartRef.current;
    if (!start) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (dx * dx + dy * dy > LONG_PRESS_CANCEL_MOVE_PX * LONG_PRESS_CANCEL_MOVE_PX) {
      // 滑动超过阈值：不是长按，取消判定，也别让后续 click 被吞。
      if (speedHoldTimerRef.current !== null) {
        window.clearTimeout(speedHoldTimerRef.current);
        speedHoldTimerRef.current = null;
      }
      speedHoldStartRef.current = null;
      suppressClickRef.current = false;
    }
  }, []);

  const toggleMute = useCallback(() => {
    const media = videoRef.current;
    if (mutedRef.current || volumeRef.current === 0) {
      const restored = previousVolumeRef.current || 80;
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
    setPlayerRevision((revision) => revision + 1);
  }, []);

  const clearControlsHideTimer = useCallback(() => {
    if (controlsHideTimerRef.current === null) return;
    window.clearTimeout(controlsHideTimerRef.current);
    controlsHideTimerRef.current = null;
  }, []);

  const setChromeVisible = useCallback((visible: boolean) => {
    for (const layer of [controlsRef.current, hudRef.current]) {
      if (!layer) continue;
      layer.dataset.visible = visible ? "true" : "false";
      layer.setAttribute("aria-hidden", String(!visible));
    }
  }, []);

  const scheduleControlsHide = useCallback(() => {
    clearControlsHideTimer();
    if (paused || loading || playbackError || overlayInteractionOpen) {
      setChromeVisible(true);
      return;
    }
    controlsHideTimerRef.current = window.setTimeout(() => {
      controlsHideTimerRef.current = null;
      setChromeVisible(false);
    }, CONTROLS_HIDE_DELAY_MS);
  }, [
    clearControlsHideTimer,
    loading,
    overlayInteractionOpen,
    paused,
    playbackError,
    setChromeVisible,
  ]);

  const revealControls = useCallback(() => {
    setChromeVisible(true);
    scheduleControlsHide();
  }, [scheduleControlsHide, setChromeVisible]);

  const holdControlsVisible = useCallback(() => {
    clearControlsHideTimer();
    setChromeVisible(true);
  }, [clearControlsHideTimer, setChromeVisible]);

  const handleStagePointerActivity = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (isPlayerControlTarget(event.target)) holdControlsVisible();
      else revealControls();
    },
    [holdControlsVisible, revealControls],
  );

  useEffect(() => {
    revealControls();
  }, [fullscreen.fullscreen, revealControls]);

  useEffect(
    () => () => {
      clearControlsHideTimer();
      if (clickTimerRef.current !== null) window.clearTimeout(clickTimerRef.current);
    },
    [clearControlsHideTimer],
  );

  const handleSurfaceClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (event.detail !== 1 || isPlayerControlTarget(event.target)) return;
      // 长按倍速松开后的那次 click 不是暂停意图。
      if (suppressClickRef.current) {
        suppressClickRef.current = false;
        return;
      }
      if (clickTimerRef.current !== null) window.clearTimeout(clickTimerRef.current);
      clickTimerRef.current = window.setTimeout(() => {
        clickTimerRef.current = null;
        togglePlayback();
      }, SINGLE_CLICK_DELAY_MS);
    },
    [togglePlayback],
  );

  const handleSurfaceDoubleClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (isPlayerControlTarget(event.target)) return;
      if (clickTimerRef.current !== null) {
        window.clearTimeout(clickTimerRef.current);
        clickTimerRef.current = null;
      }
      void fullscreen.toggle();
    },
    [fullscreen],
  );

  const handleStageKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      if (isPlayerControlTarget(event.target)) return;
      const key = event.key.toLowerCase();
      if (key === " " || key === "k") {
        event.preventDefault();
        togglePlayback();
      } else if (key === "m") {
        event.preventDefault();
        toggleMute();
      } else if (key === "f" && !event.repeat) {
        event.preventDefault();
        void fullscreen.toggle();
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
      nextItem,
      prevItem,
      revealControls,
      seekTo,
      setPlayerVolume,
      toggleMute,
      togglePlayback,
      volume,
    ],
  );

  // 进入播放页即聚焦画面：键盘快捷键不需要先点一下才生效。`autoFocus` 属性
  // 只在文档加载期生效，SPA 路由挂载的元素必须命令式聚焦。
  useEffect(() => {
    stageRef.current?.focus({ preventScroll: true });
  }, []);

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

  // 跳原始地址：控制栏工具区按钮。优先系统浏览器（opener 插件），失败回退
  // window.open（开发预览里仍可用）；与直播页卡片同一套通知反馈。
  const openOriginalUrl = useCallback(() => {
    if (!originalUrl) return;
    void openUrl(originalUrl)
      .then(() => notify.success("已在浏览器中打开"))
      .catch(() => {
        const opened = window.open(originalUrl, "_blank", "noopener,noreferrer");
        if (opened) notify.success("已在浏览器中打开");
        else notify.error("无法在浏览器中打开", "请稍后重试。");
      });
  }, [originalUrl]);

  const title = params?.title || "视频播放";

  /** 顶栏右侧的低频工具（跳原址/投屏）：常用播放控制与字幕留在控制栏，
   *  这里只放旁观类入口，与直播页顶栏右侧的定时/投屏工具同一布局语义。 */
  const topBarTools = (
    <div className="flex items-center gap-1">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              className="rounded-lg hover:bg-muted/70"
              aria-label="在浏览器中打开原始地址"
              disabled={!originalUrl}
              onClick={openOriginalUrl}
            >
              <ExternalLink aria-hidden className="size-4" />
            </Button>
          }
        />
        <TooltipContent>在浏览器中打开</TooltipContent>
      </Tooltip>

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
          <Tv data-icon="inline-start" aria-hidden className="size-4" />
        </PopoverTrigger>
        <PopoverContent
          container={fullscreen.fullscreen ? stageRef : undefined}
          side="bottom"
          align="end"
          collisionPadding={12}
          glass
          className={cn("w-72 overflow-y-auto p-1.5", glassPanelClass())}
        >
          <PopoverTitle className={cn("px-2 py-1", glassTitleClass())}>投屏</PopoverTitle>
          <CastMenu
            castUrl={castQuery.data?.url ?? null}
            headers={castQuery.data?.headers ?? {}}
            title={params?.title ?? "视频"}
            variant="overlay"
            showHeader={false}
          />
        </PopoverContent>
      </Popover>

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
            <Home data-icon="inline-start" aria-hidden className="size-4" />
          </TooltipTrigger>
          <TooltipContent>返回主页</TooltipContent>
        </Tooltip>
      </div>
      <div className="pointer-events-none absolute inset-x-24 flex min-w-0 items-center justify-center px-16">
        <p className="truncate text-sm font-semibold tracking-tight" title={title}>
          {title}
        </p>
      </div>
      <div className="absolute right-3 z-10">{topBarTools}</div>
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
      </span>
    </div>
  );

  const playlistPosition = playlistStore.getCurrentPosition();
  const playlistCenterSlot =
    playlistStore.items.length > 1 && playlistPosition ? (
      <div className="flex shrink-0 items-center gap-1 px-1.5 text-white/75">
        <span className="whitespace-nowrap font-mono text-[11px] tabular-nums">
          {playlistPosition.current} / {playlistPosition.total}
        </span>
      </div>
    ) : undefined;

  // 视频页专属工具（投屏/字幕），挂进 PlayerControls 的 toolsSlot。与内部按钮同一套
  // 样式常量（见 multi-room 的同类用法）；没字幕轨的稿件不渲染字幕按钮。
  // 弹层用绝对定位的轻量面板而不是 Popover：挂在控制条内可同步悬停保活，
  // 关闭只需点按钮切换。
  // WebView2 桌面支持画中画；Android WebView 无此 API 时按钮由 PlayerControls 隐藏。
  const pipSupported =
    typeof document !== "undefined" && document.pictureInPictureEnabled;
  /** 控制栏工具（字幕/窗口全屏）：与内部按钮同一套样式常量；没字幕轨的稿件
   *  不渲染字幕按钮。窗口全屏与画面全屏共享同一 toggle（桌面即原生窗口全屏），
   *  图标用 Maximize/Minimize 与底部全屏按钮区分语义。 */
  const toolsSlot = (
    <>
      {subtitles.length > 0 && (
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
            collisionBoundary={typeof document !== "undefined" ? document.documentElement : undefined}
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
      )}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={fullscreen.fullscreen ? "退出窗口全屏" : "窗口全屏"}
              aria-pressed={fullscreen.fullscreen}
              className={cn(
                PLAYER_CONTROL_BUTTON_CLASS,
                PLAYER_CONTROL_ICON_CLASS,
                PLAYER_OVERLAY_CONTROL_BUTTON_CLASS,
              )}
              onClick={() => void fullscreen.toggle()}
            />
          }
        >
          {fullscreen.fullscreen ? (
            <Minimize2 aria-hidden />
          ) : (
            <Maximize2 aria-hidden />
          )}
        </TooltipTrigger>
        <TooltipContent>
          {fullscreen.fullscreen ? "退出窗口全屏" : "窗口全屏"}
        </TooltipContent>
      </Tooltip>
    </>
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

  const playlistSettings =
    playlistStore.items.length > 1 ? (
      <div className="flex flex-col gap-1 px-1 py-1">
        <button
          type="button"
          onClick={() => playlistStore.toggleAutoPlayNext()}
          className="flex min-h-9 items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-muted/50"
        >
          <div
            className={cn(
              "flex size-4 shrink-0 items-center justify-center rounded border-2 transition-colors",
              playlistStore.autoPlayNext
                ? "border-primary bg-primary"
                : "border-muted-foreground/50",
            )}
          >
            {playlistStore.autoPlayNext && (
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
          <span className="flex-1">自动播放下一集</span>
        </button>
        <button
          type="button"
          onClick={() => playlistStore.toggleReversed()}
          className="flex min-h-9 items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-muted/50"
        >
          <div
            className={cn(
              "flex size-4 shrink-0 items-center justify-center rounded border-2 transition-colors",
              playlistStore.reversed
                ? "border-primary bg-primary"
                : "border-muted-foreground/50",
            )}
          >
            {playlistStore.reversed && (
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
          <span className="flex-1">倒序播放</span>
        </button>
      </div>
    ) : undefined;

  const fatalError = playInfoQuery.isError
    ? playInfoQuery.error
    : cid <= 0 && archiveQuery.isError
      ? archiveQuery.error
      : null;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {topBar}
      {/* 宽屏：播放器占满主列，右侧栏固定宽度；窄屏：播放器锁 16:9，
          右侧栏改列在下方滚动。两种形态同一条侧栏组件。 */}
      <main className="flex min-h-0 flex-1 flex-col bg-black lg:flex-row">
        <section
          ref={stageRef}
          data-player-stage
          data-fullscreen={fullscreen.fullscreen && fullscreen.nativeLayer ? "true" : undefined}
          className={cn(
            "relative flex min-w-0 flex-col overflow-hidden bg-black",
            "aspect-video w-full max-lg:max-h-[56%]",
            "lg:aspect-auto lg:w-auto lg:flex-1",
            "data-[fullscreen=true]:rounded-none data-[fullscreen=true]:border-0",
          )}
          aria-label={`${title}；按空格或 K 播放或暂停，左右方向键快退或快进（Shift 加速 30 秒），上下方向键调音量，M 静音，F 全屏`}
          aria-keyshortcuts="Space K ArrowLeft ArrowRight ArrowUp ArrowDown M F"
          onPointerEnter={handleStagePointerActivity}
          onPointerMove={handleStagePointerActivity}
          onPointerLeave={scheduleControlsHide}
          onKeyDown={handleStageKeyDown}
          tabIndex={0}
        >
          <div
            data-player-video-surface
            className="relative min-h-0 flex-1 overflow-hidden bg-black"
            onClick={handleSurfaceClick}
            onDoubleClick={handleSurfaceDoubleClick}
            onPointerDown={handleSurfacePointerDown}
            onPointerMove={handleSurfacePointerMove}
            onPointerUp={releaseSpeedHold}
            onPointerCancel={releaseSpeedHold}
            onPointerLeave={releaseSpeedHold}
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

            {(loading || waiting || playInfoQuery.isPending) && !playbackError && !fatalError && (
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

          {fullscreen.fullscreen && (
            <div
              ref={hudRef}
              data-player-hud
              data-visible="true"
              aria-hidden="false"
              className={cn(
                "absolute inset-x-0 top-0 z-30 transition-opacity duration-150 ease-out",
                "motion-reduced:transition-none data-[visible=false]:pointer-events-none data-[visible=false]:opacity-0",
                "player-scrim-overlay-top flex min-w-0 items-center gap-2 bg-transparent pr-[max(0.375rem,env(safe-area-inset-right))] pl-[max(0.75rem,env(safe-area-inset-left))] pt-[max(0.375rem,env(safe-area-inset-top))] text-white",
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
                aria-label="退出窗口全屏"
                className={cn(
                  PLAYER_CONTROL_BUTTON_CLASS,
                  PLAYER_CONTROL_ICON_CLASS,
                  PLAYER_OVERLAY_CONTROL_BUTTON_CLASS,
                  "shrink-0",
                )}
                onClick={() => void fullscreen.exit()}
              >
                <ChevronLeft data-icon="inline-start" aria-hidden />
              </Button>
              <p className="min-w-0 flex-1 truncate px-1 text-sm font-semibold" title={title}>
                {title}
              </p>
              {topBarTools}
            </div>
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
            {/* 弹幕输入条（overlay 变体，portal 进舞台避免全屏压盖）：
                常规视口放控制栏居中槽位（直播页同款落点）；compact 且非全屏时
                PlayerControls 不渲染 centerSlot，回退到控制条上沿，保持可用。 */}
            {compact && !fullscreen.fullscreen && (
              <DanmakuComposer
                overlay
                portalContainer={stageRef}
                roomTitle={title}
                video={{
                  cid,
                  aid: aid ?? "",
                  progressSecs: Math.floor(currentTime),
                }}
                onOverlayInteractionChange={setOverlayInteractionOpen}
              />
            )}
            <PlayerControls
              paused={paused}
              volume={volume}
              muted={muted}
              osdOn={danmakuVisible}
              fullscreen={fullscreen.fullscreen}
              disabled={loading}
              refreshDisabled={loading}
              loadError={fullscreen.error}
              stackedBelowPlayer={compact}
              compact={compact}
              portalContainer={stageRef}
              centerSlot={
                showPlayerControlsCenterSlot(compact, fullscreen.fullscreen) ? (
                  <>
                    <DanmakuComposer
                      overlay
                      portalContainer={stageRef}
                      roomTitle={title}
                      video={{
                        cid,
                        aid: aid ?? "",
                        progressSecs: Math.floor(currentTime),
                      }}
                      onOverlayInteractionChange={setOverlayInteractionOpen}
                    />
                    {playlistCenterSlot}
                  </>
                ) : undefined
              }
              timeline={timeline}
              playbackSettings={
                <>
                  {rateSettings}
                  {playlistSettings && (
                    <>
                      <Separator className="my-1 max-md:my-0.5" />
                      {playlistSettings}
                    </>
                  )}
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
              audioOnly={audioOnly}
              onToggleAudioOnly={toggleAudioOnly}
              pictureInPictureSupported={pipSupported}
              pictureInPictureActive={pipActive}
              onTogglePictureInPicture={togglePictureInPicture}
              onTogglePause={togglePlayback}
              onToggleMute={toggleMute}
              onVolume={setPlayerVolume}
              onToggleOsd={() => setDanmakuVisible((visible) => !visible)}
              onToggleFullscreen={() => void fullscreen.toggle()}
            />
          </div>
        </section>
        <aside
          className={cn(
            // 与直播播放页右侧栏同一套规格：bg-sidebar、边框、断点宽度，
            // 窄屏则如直播的紧凑侧栏一样列在播放器下方。
            "flex min-h-0 flex-1 flex-col border-t border-border/80 bg-sidebar",
            "lg:w-[300px] lg:flex-none lg:border-t-0 lg:border-l xl:w-[320px]",
          )}
        >
          <VideoSidebar
            bvid={params.bvid}
            epId={params.epId}
            aid={params.aid}
            cid={cid}
            danmaku={{
              entries: danmakuEntries,
              positionMs: currentTime * 1000,
              loading: danmakuEntries.length === 0 && danmakuVisible && !playbackError,
            }}
          />
        </aside>
      </main>
    </div>
  );
}
