import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { requestPlayerAutoplay } from "@/features/room/player/autoplay";
import {
  createVideoJsPlayer,
  loadVideoJsModules,
  switchVideoJsDashSource,
  videoJsPlayerErrorMessage,
  type VideoJsPlayerInstance,
} from "@/features/room/player/videoJsPlayer";
import { videoGetPlayInfo, videoStopPlay } from "@/features/video/videoApi";
import { VIDEO_HISTORY_QUERY_KEY, videoHistoryAdd } from "@/features/video/videoHistory";
import { isWatchProgressWorthKeeping, shouldReportWatchProgress } from "@/shared/watchProgress";
import type { VideoItem, VideoPlayInfo, VideoSessionIds } from "@/shared/types/video";
import { shortsItemKey, type ShortsIntrinsicSize, type ShortsSlotId } from "./shortsFeed";

/**
 * 竖屏舞台的起播链路 —— **一个槽位一份**。
 *
 * 刻意**不**从 `VideoPlayerPage` 抽取共用 hook：那一页的核心 effect 同时背着画质
 * 切换、仅音频、字幕、storyboard、投屏、播放列表连播与跨分 P 续播，其顺序约束
 * （`resumePending` → `switchingItem` → `session_ids` 三处）是那些能力共同压出来的。
 * 短视频这一版一条都不需要，照搬会把两个表面绑在同一份高风险 effect 上。
 * 这里保留的是不可省的四件事，其余全部去掉：
 *
 * 1. `video_get_play_info` 取流（DASH + 本机代理），`gcTime: 0` —— 缓存命中会返回
 *    指向**已经停掉**的代理会话的 MPD。
 * 2. 换片与卸载都必须 `video_stop_play`，否则每滑一条泄漏三个本机监听器。
 * 3. 播完从头重播（短视频的默认消费语义是循环，不是停在最后一帧）。
 * 4. 观看历史上报，与播放页同一套节流与身份约定。
 *
 * 不做续播定位：短视频从头看是唯一合理的起点，上次停在第 8 秒不构成「续播」。
 * 历史仍然记 —— 它是「看过什么」的账，与要不要跳位无关。
 *
 * ## 槽位与播放器复用
 *
 * 短视频页有两个槽位（见 `useShortsSlots`），它们轮换承担「活动」与「预热」。
 * 本 hook 只管**一个**槽位，因此它面对的是「同一个 `<video>` 上换了一条内容」
 * 而不是「挂载/卸载」：
 *
 * - `<video>` 元素与 Video.js 实例都属于槽位，**不随条目销毁重建**。换片走
 *   `switchVideoJsDashSource`（dash.js 的 `attachSource`），省掉引擎与 DOM 的重建。
 * - 事件监听同样只绑一次（绑在媒体元素上），通过 `sessionRef` 读当次会话的
 *   上下文，因此换源不需要重新注册。
 * - `mode` 决定这一轮要不要真的起播：`"warm"` 只取流 + 缓冲到 `canplay`，
 *   不 `play()`、不上报历史。预热命中时换片因此不必等取流。
 */

/**
 * 槽位这一轮的角色。
 *
 * - `"play"`：起播、循环、可 seek/倍速、上报观看历史。
 * - `"warm"`：只取流并缓冲到 `canplay`，不播放也不上报 —— 它在屏幕外等着被提升。
 */
export type ShortsSlotMode = "play" | "warm";

export type ShortsPlaybackState = {
  /** 取流中或播放器尚未就绪。封面在这段时间盖住舞台。 */
  loading: boolean;
  /** 缓冲中（媒体已就绪但数据不够）。 */
  waiting: boolean;
  paused: boolean;
  /** 可读的失败原因；null 表示没有错误。 */
  error: string | null;
  /** 当前播放位置（秒）。弹幕层按它投放，这里只驱动进度条。 */
  currentTime: number;
  /** 总时长（秒）：后端 sidx 累加值优先，缺失时退回媒体元数据。 */
  duration: number;
  muted: boolean;
  /**
   * 媒体自报的画幅（`videoWidth` / `videoHeight`）；元数据到达前是 null。
   *
   * 舞台按它定画面框：列表下发的 `dimension` 只是起播前的先验，真正要显示的
   * 比例只有媒体自己知道（两者不一致时按错误比例定框会让画面在框内再留一次边）。
   */
  intrinsicSize: ShortsIntrinsicSize | null;
  /**
   * 当前播放速率。长按倍速期间是 [`LONG_PRESS_SPEED_RATE`]，其余时候是 1。
   *
   * 暴露出来而不是只给一个「倍速中」的布尔：提示条上的那个数字必须与真正生效的
   * 速率同源，否则显示 3.0x 而实际还是 1.0x 这种漂移没人看得出来。
   */
  rate: number;
  /**
   * 媒体已可播（`canplay` 到达过）。
   *
   * 编排层用它放行预热槽位的取流：当前这条还没出画之前，不该让另一条去抢带宽。
   */
  ready: boolean;
  /** 点按切换播放/暂停。 */
  togglePlay: () => void;
  toggleMuted: () => void;
  /** 跳到指定秒数。进度条拖动释放时调用。 */
  seek: (seconds: number) => void;
  /** 设置播放速率。长按倍速用它进出，松开时传回 1。 */
  setRate: (rate: number) => void;
  /** 重试当前条目（重新取流并重建播放器）。 */
  retry: () => void;
};

type UseShortsPlaybackSlotOptions = {
  /** 槽位当前持有的条目；null 表示这一轮没有内容（此时拆除播放器）。 */
  item: VideoItem | null;
  /** 槽位独占的媒体元素。跨条目稳定，是播放器复用的前提。 */
  videoRef: RefObject<HTMLVideoElement | null>;
  /** 槽位标识。进 queryKey：两个槽位的取流互不复用（各自的会话生命周期独立）。 */
  slotId: ShortsSlotId;
  mode: ShortsSlotMode;
  /**
   * 是否允许取流。
   *
   * 预热槽位要等活动槽位出画之后才放行 —— 首屏与弱网下不该让第二条抢带宽。
   */
  warmAllowed: boolean;
  /** 播放位置推进的回调：弹幕分段按它加载。只有活动槽位会收到。 */
  onProgress?: ((positionMs: number) => void) | undefined;
};

/** 监听闭包读的会话上下文。换源时整体替换，因此监听不必重新注册。 */
type SlotSession = {
  cid: number;
  itemKey: string;
  playInfo: VideoPlayInfo | null;
  mode: ShortsSlotMode;
  onProgress: ((positionMs: number) => void) | undefined;
  reportedAt: number | null;
  userPaused: boolean;
  /** 本次 attach 的代号。迟到的事件（换源之前发出）据此作废。 */
  token: number;
};

export function useShortsPlaybackSlot({
  item,
  videoRef,
  slotId,
  mode,
  warmAllowed,
  onProgress,
}: UseShortsPlaybackSlotOptions): ShortsPlaybackState {
  const queryClient = useQueryClient();
  const [loading, setLoading] = useState(true);
  const [waiting, setWaiting] = useState(false);
  const [paused, setPaused] = useState(true);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [muted, setMuted] = useState(false);
  /**
   * 媒体自报的画幅，起播后才有。
   *
   * 竖屏舞台按它给画面定框（见 `shortsMediaAspect`）：列表下发的 `dimension`
   * 只是起播前的先验，真正要按比例显示的是实际取到的那条流。
   */
  const [intrinsicSize, setIntrinsicSize] = useState<ShortsIntrinsicSize | null>(null);
  /**
   * 当前播放倍速。
   *
   * 短视频没有倍速菜单，这个值只由长按倍速临时改写（见 `ShortsPage`），松手即回 1。
   * 仍然进 state 而不是只写媒体元素：界面上那枚「3.0x 倍速中」的提示读的是它，
   * 两处各存一份就会出现「提示还在、倍速已经回落」。
   */
  const [rate, setRate] = useState(1);
  const [revision, setRevision] = useState(0);

  const cid = item?.cid ?? 0;
  const bvid = item?.bvid ?? "";
  const itemKey = item ? shortsItemKey(item) : "";

  const playInfoQuery = useQuery({
    // revision 进 key：重试就是换一份取流（旧会话已停，MPD 不可复用）。
    // slotId 进 key：两个槽位各自持有会话，绝不复用另一个槽位可能已停的 MPD。
    queryKey: ["shorts_play_info", slotId, bvid, cid, revision],
    enabled: item !== null && cid > 0 && bvid !== "" && warmAllowed,
    queryFn: () =>
      videoGetPlayInfo({
        bvid,
        cid,
        ep_id: null,
        qn: null,
        audio_only: false,
        // 短视频的回滑与重进会重复请求同一条的分片，让代理把它们落盘。
        // 播放页不传：那里的取流只在开播时发生一次，缓存只有磁盘成本。
        media_cache: true,
      }),
    // 与代理会话同生命周期：绝不能缓存（见本文件头注）。
    gcTime: 0,
    retry: false,
  });
  const playInfo = playInfoQuery.data;
  const playUrl = playInfo?.mpd_url;

  /**
   * 代理会话的拆除。
   *
   * 三条路径都必须走到：换片（itemKey 变）、槽位被清空与卸载。会话链必须 A→B
   * 连续，因此用原始 query 数据而不是任何会在过渡期变成 undefined 的派生值。
   */
  const sessionsRef = useRef<VideoSessionIds | null>(null);
  useLayoutEffect(() => {
    if (playInfoQuery.data) sessionsRef.current = playInfoQuery.data.session_ids;
  }, [playInfoQuery.data]);
  useEffect(
    () => () => {
      const sessions = sessionsRef.current;
      sessionsRef.current = null;
      if (sessions) void videoStopPlay(sessions);
    },
    [],
  );
  // 上一条的会话要在新会话替换它之前停掉。
  const previousSessionsRef = useRef<VideoSessionIds | null>(null);
  useEffect(() => {
    const previous = previousSessionsRef.current;
    const current = playInfoQuery.data;
    previousSessionsRef.current = current?.session_ids ?? null;
    if (previous && current && previous.mpd !== current.session_ids.mpd) {
      void videoStopPlay(previous);
    }
  }, [playInfoQuery.data]);

  const itemRef = useRef(item);
  useLayoutEffect(() => {
    if (item) itemRef.current = item;
  }, [item]);

  const onProgressRef = useRef(onProgress);
  useLayoutEffect(() => {
    onProgressRef.current = onProgress;
  }, [onProgress]);

  /**
   * 监听闭包读的会话上下文。
   *
   * 监听绑在媒体元素上、只绑一次，因此它不能闭包捕获 cid/playInfo —— 那些在换源
   * 之后就过期了。全部经这个 ref 读取。
   */
  const sessionRef = useRef<SlotSession>({
    cid: 0,
    itemKey: "",
    playInfo: null,
    mode: "warm",
    onProgress: undefined,
    reportedAt: null,
    userPaused: false,
    token: 0,
  });
  const mutedRef = useRef(false);
  const playerRef = useRef<VideoJsPlayerInstance | null>(null);
  /** 已经绑过监听的媒体元素；元素换了（面板重挂载）就必须重新绑。 */
  const boundMediaRef = useRef<HTMLVideoElement | null>(null);
  const unbindRef = useRef<(() => void) | null>(null);
  /** 当前附着的 MPD 地址：没变就不重新 attach。 */
  const attachedUrlRef = useRef<string | null>(null);
  const attachTokenRef = useRef(0);

  /** 记下进度：身份经 ref 读取，并用 cid 比对挡住错位。 */
  const reportProgress = useCallback(
    (position: number, force: boolean) => {
      const session = sessionRef.current;
      // 预热不记账：它从未播放过，写进历史等于把没看的条目记成看过。
      if (session.mode !== "play") return;
      const current = itemRef.current;
      if (!current || (current.cid ?? 0) !== session.cid) return;
      const now = Date.now();
      if (force) {
        if (!isWatchProgressWorthKeeping(position)) return;
      } else if (!shouldReportWatchProgress(position, session.reportedAt, now)) {
        return;
      }
      session.reportedAt = now;
      void videoHistoryAdd({
        kind: "ugc",
        // UGC 的 oid 就是 bvid，两个字段同源。
        oid: current.bvid,
        title: current.title,
        cover: current.cover,
        author: current.author,
        // 短视频都是单 P，分 P 标题留空。
        part_title: "",
        bvid: current.bvid,
        cid: current.cid ?? 0,
        ep_id: "",
        aid: current.aid,
        progress: position,
        duration: session.playInfo?.duration ?? 0,
        watched_at: now,
      })
        .then(() => queryClient.invalidateQueries({ queryKey: VIDEO_HISTORY_QUERY_KEY }))
        .catch(() => undefined);
    },
    [queryClient],
  );

  /**
   * 起播（含自动播放降级）。
   *
   * 与附着分开：预热槽位被提升为活动槽位时不换源，只需要开始播放；而 `ready`
   * 在换源时会先落回 false 再置真，因此这条 effect 在真正换片后也会重跑。
   */
  const requestAutoplay = useCallback(
    (player: VideoJsPlayerInstance, media: HTMLVideoElement, token: number) => {
      // 与直播/播放页同源：先试带声音，被自动播放策略拒绝时降级静音起播再
      // 立刻尝试恢复声音；用户手动静音过则保持静音。
      requestPlayerAutoplay(
        player,
        media,
        () => sessionRef.current.token === token && !sessionRef.current.userPaused,
        () => {
          if (mutedRef.current) return false;
          setMuted(false);
          return true;
        },
      );
    },
    [],
  );

  /** 绑定媒体监听。每个媒体元素只绑一次，跨换源保留。 */
  const bindListeners = useCallback(
    (media: HTMLVideoElement) => {
      function totalDuration() {
        const fromInfo = sessionRef.current.playInfo?.duration ?? 0;
        if (fromInfo > 0) return fromInfo;
        return Number.isFinite(media.duration) && media.duration > 0 ? media.duration : 0;
      }
      function syncTime() {
        const actual = Number.isFinite(media.currentTime) ? Math.max(0, media.currentTime) : 0;
        setCurrentTime(actual);
        sessionRef.current.onProgress?.(actual * 1_000);
        reportProgress(actual, false);
      }
      function syncDuration() {
        // 后端从 sidx 累加出的时长更早可用也更精确，只有它缺失才退回媒体元数据。
        if ((sessionRef.current.playInfo?.duration ?? 0) > 0) return;
        if (Number.isFinite(media.duration) && media.duration > 0) setDuration(media.duration);
      }
      /** 画幅：`loadedmetadata` 时首次可得，`resize` 在换轨/旋转后再报。 */
      function syncIntrinsicSize() {
        const width = media.videoWidth;
        const height = media.videoHeight;
        if (!(width > 0) || !(height > 0)) return;
        setIntrinsicSize((current) =>
          current?.width === width && current.height === height ? current : { width, height },
        );
      }
      function onReady() {
        setLoading(false);
        setWaiting(false);
        setReady(true);
        syncTime();
        syncDuration();
        syncIntrinsicSize();
      }
      function onPlay() {
        setPaused(false);
        setWaiting(false);
        setLoading(false);
      }
      function onPlaying() {
        setWaiting(false);
        setLoading(false);
      }
      function onPause() {
        setPaused(true);
        // 暂停是「可能马上要走」的最强信号：立刻落盘，不等节流窗口。
        reportProgress(Number.isFinite(media.currentTime) ? media.currentTime : 0, true);
      }
      function onWaiting() {
        if (!media.ended) setWaiting(true);
      }
      function onSeeked() {
        setWaiting(false);
      }
      function syncAudio() {
        const nextMuted = media.muted || media.volume === 0;
        mutedRef.current = nextMuted;
        setMuted(nextMuted);
      }
      /**
       * 播完从头重播。
       *
       * 短视频的默认消费语义就是循环：停在最后一帧等于内容消失，而自动跳下一条
       * 会替用户做决定 —— 换片是他上滑的手势，不是播放器的自作主张。
       * 用户自己暂停过则不重播，尊重那个暂停。
       *
       * **重播必须晚于 dash.js 自己的 `ended` 处理。** 适配器在媒体元素的 `ended`
       * 上挂了它自己的处理，里面无条件 `pause()`（`DashAdapter` 内部 → dash.js
       * `MediaPlayer` 的 `pause()`）。监听按注册顺序触发，而我们的监听先于
       * `createVideoJsPlayer` 注册，因此直接 `play()` 会被紧随其后的 `pause()`
       * 打断 —— 表现为 `play()` 以 `AbortError: The play() request was interrupted
       * by a call to pause()` 拒绝，媒体停在 0 秒且暂停，也就是「播完不重播」。
       *
       * 用 `setTimeout(0)` 推到下一个宏任务：本次 `ended` 派发的全部监听（含
       * dash.js 那个）都已跑完，`pause()` 不会再落到我们身上。
       */
      function onEnded() {
        const total = totalDuration();
        // 播完记满进度：历史卡的进度条画到底，也让「已看完」判定成立。
        reportProgress(total > 0 ? total : media.currentTime, true);
        if (sessionRef.current.userPaused) {
          setPaused(true);
          return;
        }
        const token = sessionRef.current.token;
        setTimeout(() => {
          // 延迟期间可能已经换片、卸载或用户手动暂停：那些情况下不该再起播。
          if (sessionRef.current.token !== token) return;
          if (sessionRef.current.userPaused) return;
          if (media.paused === false) return;
          media.currentTime = 0;
          void media.play().catch(() => {
            // 自动重播被浏览器策略拦下时留在暂停态，用户点一下即可。
          });
        }, 0);
      }

      media.addEventListener("timeupdate", syncTime);
      media.addEventListener("durationchange", syncDuration);
      media.addEventListener("loadedmetadata", onReady);
      media.addEventListener("canplay", onReady);
      media.addEventListener("play", onPlay);
      media.addEventListener("playing", onPlaying);
      media.addEventListener("pause", onPause);
      media.addEventListener("waiting", onWaiting);
      media.addEventListener("seeked", onSeeked);
      media.addEventListener("ended", onEnded);
      media.addEventListener("volumechange", syncAudio);
      media.addEventListener("resize", syncIntrinsicSize);
      return () => {
        media.removeEventListener("timeupdate", syncTime);
        media.removeEventListener("durationchange", syncDuration);
        media.removeEventListener("loadedmetadata", onReady);
        media.removeEventListener("canplay", onReady);
        media.removeEventListener("play", onPlay);
        media.removeEventListener("playing", onPlaying);
        media.removeEventListener("pause", onPause);
        media.removeEventListener("waiting", onWaiting);
        media.removeEventListener("seeked", onSeeked);
        media.removeEventListener("ended", onEnded);
        media.removeEventListener("volumechange", syncAudio);
        media.removeEventListener("resize", syncIntrinsicSize);
      };
    },
    [reportProgress],
  );

  /** 拆掉播放器（卸载、槽位清空、媒体元素被换掉时使用）。 */
  const teardown = useCallback(
    (flushProgress: boolean) => {
      if (flushProgress) {
        const media = videoRef.current;
        reportProgress(media && Number.isFinite(media.currentTime) ? media.currentTime : 0, true);
      }
      unbindRef.current?.();
      unbindRef.current = null;
      boundMediaRef.current = null;
      attachedUrlRef.current = null;
      const player = playerRef.current;
      playerRef.current = null;
      try {
        player?.pause();
        player?.destroy();
      } catch {
        // 协议插件可能已经释放了它的 MediaSource。
      }
    },
    [reportProgress, videoRef],
  );

  // 槽位被清空（只有一条内容、流缩短）：拆播放器、停会话，不留三个本机监听器。
  useEffect(() => {
    if (item) return;
    teardown(true);
    const sessions = sessionsRef.current;
    sessionsRef.current = null;
    previousSessionsRef.current = null;
    if (sessions) void videoStopPlay(sessions);
  }, [item, teardown]);

  /**
   * 取流完成 → 附着到媒体元素。
   *
   * 两种进入方式，只有第二种真正建播放器：
   *
   * - **换源**（槽位已有播放器）：`switchVideoJsDashSource` 走 dash.js 的
   *   `attachSource`，引擎、媒体元素与监听全部保留。这就是「播放器复用」。
   * - **首次/媒体元素已换**：`createVideoJsPlayer` 新建。
   *
   * 刻意**不**在清理函数里拆播放器：这个函数会在每次依赖变化时跑，而换片正是
   * 依赖变化 —— 拆了就退化成「每片重建」，预热省下的时间全花回引擎初始化上。
   * 拆除只发生在卸载、槽位清空与媒体元素被换掉的时候。
   *
   * **依赖里刻意没有 `mode`**：预热槽位被提升为活动槽位时只有角色变了，内容没
   * 变。若把 `mode` 放进依赖，那一次提升会重跑本 effect —— 于是 `setLoading(true)`
   * 与 `media.pause()` 会作用在一个**已经缓冲好、正在播**的媒体上，换片反而闪一
   * 下封面再卡一下。角色变化由下面的 `mode` effect 单独处理。
   */
  useEffect(() => {
    const media = videoRef.current;
    if (!media || !item || !playUrl) return;
    // 同一条内容不重复附着：角色变化（预热 → 活动）不该动媒体。
    if (attachedUrlRef.current === playUrl && sessionRef.current.itemKey === itemKey) return;

    // 换源前先把上一条的最后一次进度落盘：此刻媒体元素还能读 currentTime。
    if (attachedUrlRef.current !== null) {
      reportProgress(Number.isFinite(media.currentTime) ? media.currentTime : 0, true);
    }

    const reused = playerRef.current !== null && boundMediaRef.current === media;
    if (!reused) {
      // 媒体元素换过（面板重挂载）：旧的播放器与监听绑在已经消失的元素上。
      teardown(false);
    }

    const token = attachTokenRef.current + 1;
    attachTokenRef.current = token;
    attachedUrlRef.current = playUrl;
    sessionRef.current = {
      cid,
      itemKey,
      playInfo: playInfo ?? null,
      mode,
      onProgress: onProgressRef.current,
      reportedAt: null,
      userPaused: false,
      token,
    };

    // oxlint-disable-next-line react/set-state-in-effect
    setLoading(true);
    setWaiting(false);
    setReady(false);
    setError(null);
    setPaused(true);
    setCurrentTime(0);
    setDuration(playInfo?.duration ?? 0);
    setIntrinsicSize(null);
    media.muted = mutedRef.current;
    // 倍速不跨条目继承：长按倍速是临时状态，按住不放地滑动换片时这里会先于
    // pointerup 跑，新条目必须从 1x 起。
    media.playbackRate = 1;
    // oxlint-disable-next-line react/set-state-in-effect
    setRate(1);
    // 换源前先停声：旧内容不该在新 MPD 缓冲好之前继续出声。
    if (!media.paused) media.pause();

    if (reused && playerRef.current) {
      switchVideoJsDashSource(playerRef.current, playUrl);
      return;
    }

    boundMediaRef.current = media;
    unbindRef.current = bindListeners(media);
    let cancelled = false;
    void loadVideoJsModules("dash")
      .then((modules) => {
        if (cancelled || playerRef.current) return;
        const player = createVideoJsPlayer(modules, {
          video: media,
          url: playUrl,
          kind: "dash",
          isLive: false,
        });
        playerRef.current = player;
        player.on("error", (cause) => {
          if (sessionRef.current.token !== token) return;
          setError(videoJsPlayerErrorMessage(cause, "视频播放失败"));
          setLoading(false);
          setWaiting(false);
        });
        if (mode === "play") requestAutoplay(player, media, token);
      })
      .catch((cause) => {
        if (cancelled || sessionRef.current.token !== token) return;
        setError(videoJsPlayerErrorMessage(cause, "无法初始化视频播放器"));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    /*
     * `mode` 与 `requestAutoplay` 刻意不在依赖里。
     *
     * `mode` 有自己那条 effect（见上）：把它放进这里会在角色变化时重新附着，把已经
     * 缓冲好的内容推回加载态。`requestAutoplay` 是 `useCallback([])` 的稳定引用，
     * 加进去既不会改变行为也不会更正确。
     */
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [bindListeners, cid, item, itemKey, playInfo, playUrl, reportProgress, teardown, videoRef]);

  /**
   * 角色变化（预热 ↔ 活动）：只更新会话上下文，不动媒体。
   *
   * 历史上报与弹幕推进都按 `mode` 门控，因此提升的那一刻必须让监听闭包看到新角色
   * —— 但**不能**重新附着，那会把已经缓冲好的内容推回加载态。
   */
  useEffect(() => {
    sessionRef.current.mode = mode;
    sessionRef.current.onProgress = onProgressRef.current;
  }, [mode]);

  /**
   * 起播（含自动播放降级）。
   *
   * 预热槽位被提升为活动槽位时不换源，只需要开始播放 —— 这条 effect 就是那一步。
   * `ready` 在真正换片（内容变了）时会先落回 false 再置真，因此新内容缓冲好之后
   * 也会走到这里。
   *
   * 只在还暂停着时才请求起播：已经在播的媒体不该被反复 `play()`（那会打断
   * 播放位置，也可能让自动播放的静音降级路径重复跑）。
   */
  useEffect(() => {
    if (mode !== "play" || !ready) return;
    const media = videoRef.current;
    const player = playerRef.current;
    if (!media || !player || !media.paused) return;
    requestAutoplay(player, media, attachTokenRef.current);
  }, [mode, ready, requestAutoplay, videoRef]);

  // 不再是活动槽位时立刻停声：媒体元素被预热的新内容接管之前不该还在播。
  useEffect(() => {
    if (mode === "play") return;
    const media = videoRef.current;
    if (media && !media.paused) media.pause();
  }, [mode, videoRef]);

  const togglePlay = useCallback(() => {
    const media = videoRef.current;
    if (!media) return;
    if (media.paused) {
      sessionRef.current.userPaused = false;
      void media.play().catch(() => {
        // 起播被拦下时保持暂停，界面上的暂停图标仍然诚实。
      });
    } else {
      sessionRef.current.userPaused = true;
      media.pause();
    }
  }, [videoRef]);

  const toggleMuted = useCallback(() => {
    const media = videoRef.current;
    if (!media) return;
    const next = !(media.muted || media.volume === 0);
    media.muted = next;
    // 静音时音量归零会让恢复后没有声音，只切 muted。
    if (!next && media.volume === 0) media.volume = 1;
    mutedRef.current = next;
    setMuted(next);
  }, [videoRef]);

  /**
   * 跳转播放位置。
   *
   * 同步写一次 `currentTime` 并立即更新 state：媒体的 `timeupdate` 要等到 seek 完成
   * 才会来，中间那几十毫秒里进度条必须已经停在手指抬起的位置，否则会先弹回
   * 原处再跳过去。
   */
  const seek = useCallback(
    (seconds: number) => {
      const media = videoRef.current;
      if (!media) return;
      const total =
        Number.isFinite(media.duration) && media.duration > 0 ? media.duration : duration;
      if (!(total > 0)) return;
      const next = Math.max(0, Math.min(total, seconds));
      media.currentTime = next;
      setCurrentTime(next);
    },
    [duration, videoRef],
  );

  /**
   * 改播放倍速。
   *
   * 只写媒体元素而不碰 Video.js 播放器实例：短视频用的是裸 `<video>` + 本机代理，
   * `playbackRate` 是元素自身的属性，媒体源不受影响（不会重新起播）。
   */
  const changeRate = useCallback(
    (next: number) => {
      const value = Number.isFinite(next) && next > 0 ? next : 1;
      const media = videoRef.current;
      if (media) media.playbackRate = value;
      setRate(value);
    },
    [videoRef],
  );

  const retry = useCallback(() => {
    setError(null);
    setRevision((value) => value + 1);
  }, []);

  // 换片重置错误态：新条目不该继承上一条的失败面板。
  const [settledKey, setSettledKey] = useState(itemKey);
  if (settledKey !== itemKey) {
    setSettledKey(itemKey);
    setError(null);
    setLoading(true);
    setReady(false);
    setCurrentTime(0);
    setDuration(0);
    // 画幅也要清：留着上一条的比例会让新条目先按错误的框画一帧。
    setIntrinsicSize(null);
  }

  return {
    // 取流本身也算加载：封面要一直盖到播放器真的出画为止。
    loading: loading || (warmAllowed && playInfoQuery.isFetching),
    waiting,
    paused,
    error: error ?? (playInfoQuery.error ? "取流失败，请重试" : null),
    currentTime,
    duration,
    muted,
    intrinsicSize,
    rate,
    ready,
    togglePlay,
    toggleMuted,
    setRate: changeRate,
    seek,
    retry,
  };
}
