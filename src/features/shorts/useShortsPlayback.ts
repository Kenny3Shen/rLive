import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { requestPlayerAutoplay } from "@/features/room/player/autoplay";
import {
  createVideoJsPlayer,
  loadVideoJsModules,
  switchVideoJsDashSource,
  videoJsPlayerErrorMessage,
  videoJsDashBufferSettings,
  type VideoJsPlayerInstance,
} from "@/features/room/player/videoJsPlayer";
import { videoGetPlayInfo, videoStopPlay } from "@/features/video/videoApi";
import { VIDEO_HISTORY_QUERY_KEY, videoHistoryAdd } from "@/features/video/videoHistory";
import { isWatchProgressWorthKeeping, shouldReportWatchProgress } from "@/shared/watchProgress";
import type { VideoItem, VideoPlayInfo } from "@/shared/types/video";
import { shortsItemKey, type ShortsIntrinsicSize, type ShortsSlotId } from "./shortsFeed";
import { shortsShouldRetainSession } from "./shortsSessionRetention";
import { PendingPlaybackRequests } from "./pendingPlaybackRequests";

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
 * 短视频页有三个槽位（见 `useShortsSlots`），它们轮换承担「活动」与「预热」。
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
  /** 取流中或播放器尚未就绪，此时不显示暂停指示。 */
  loading: boolean;
  paused: boolean;
  /** 可读的失败原因；null 表示没有错误。 */
  error: string | null;
  /** 按需读取进度，不用 timeupdate 驱动整页渲染。 */
  getCurrentTime: () => number;
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
  /** 槽位标识。进 queryKey：三个槽位的取流互不复用（各自的会话生命周期独立）。 */
  slotId: ShortsSlotId;
  mode: ShortsSlotMode;
  /**
   * 是否允许**下载媒体**（附着到媒体元素、开始缓冲分片）。
   *
   * 预热槽位要等活动槽位出画之后才放行 —— 首屏与弱网下不该让第二条抢带宽。
   *
   * 只闸媒体、**不闸取流**：签名 playurl 与两条 sidx 是控制面请求（几 KB），
   * 抢不走正在播的那条的媒体带宽，却是预热链路上最贵的一段（实测中位 560ms，
   * 占总就绪时间一半）。放它先跑，就绪时间随之减半，连刷的命中窗口从约 1.7s
   * 扩到约 1.1s。
   */
  mediaAllowed: boolean;
  /**
   * 只读查看这一条是否有可复用的保留会话（渲染期安全，幂等）。
   *
   * 命中时本槽位不再取流：那份 playInfo 指向的会话仍由保留位续着。
   */
  claimPlayInfo?: ((itemKey: string) => VideoPlayInfo | null) | undefined;
  /** 把保留会话从保留位移出、所有权交给本槽位（幂等，**不停它**）。 */
  releasePlayInfo?: ((itemKey: string) => void) | undefined;
  /** 把本槽位刚丢下的会话交回保留位（只有用户看过的才值得留）。 */
  parkPlayInfo?: ((itemKey: string, playInfo: VideoPlayInfo) => void) | undefined;
  /** 播放位置推进的回调：弹幕分段按它加载。只有活动槽位会收到。 */
  onProgress?: ((positionMs: number) => void) | undefined;
};

/** 监听闭包读的会话上下文。换源时整体替换，因此监听不必重新注册。 */
type SlotSession = {
  item: VideoItem | null;
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
  mediaAllowed,
  claimPlayInfo,
  releasePlayInfo,
  parkPlayInfo,
  onProgress,
}: UseShortsPlaybackSlotOptions): ShortsPlaybackState {
  const queryClient = useQueryClient();
  const [loading, setLoading] = useState(true);
  const [paused, setPaused] = useState(true);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ownerId = useId();
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

  /**
   * 接管保留会话。
   *
   * 渲染期只做**只读**的 `claimPlayInfo`（幂等，可被 React 丢弃后重来），并把
   * 结果记进 ref。记进 ref 而不是每次渲染重新查，是因为接管后所有权就移交给本
   * 槽位（见下面的 release effect），保留位里不再有这一条 —— 再查会是 null，
   * `enabled` 会翻回 true 而白取一次流。
   */
  const adoptedRef = useRef<{ key: string; info: VideoPlayInfo } | null>(null);
  /** 已因错误退回过取流的条目，保证每条只退一次，避免失败循环。 */
  const fellBackRef = useRef<string | null>(null);
  if (adoptedRef.current?.key !== itemKey) {
    // 退回过取流的条目不再重新接管：保留位里那份已被 release 移出，而且它已经
    // 表现过一次不可用（上游签名过期、后端异常、进程重启），再接管只会再失败一次。
    const peeked =
      fellBackRef.current === itemKey || !itemKey ? null : (claimPlayInfo?.(itemKey) ?? null);
    adoptedRef.current = peeked ? { key: itemKey, info: peeked } : null;
  }
  const adopted = adoptedRef.current?.key === itemKey ? adoptedRef.current.info : null;

  // 每个查询身份独立管理未交接的资源，旧查询清理不会误停新查询。
  const pendingRequests = useMemo(
    () =>
      new PendingPlaybackRequests<VideoPlayInfo>((info) => {
        void videoStopPlay(info.session_ids).catch(() => undefined);
      }),
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [ownerId, bvid, cid, revision],
  );
  useEffect(() => () => pendingRequests.clear(), [pendingRequests]);

  const playInfoQuery = useQuery({
    // revision 进 key：重试就是换一份取流（旧会话已停，MPD 不可复用）。
    // slotId 进 key：三个槽位各自持有会话，绝不复用另一个槽位可能已停的 MPD。
    queryKey: ["shorts_play_info", ownerId, slotId, bvid, cid, revision],
    // 取流不受闸门约束（见 `mediaAllowed`）：只有条目本身可用性的前置条件。
    // 已接管保留会话时不取流 —— 那份 playInfo 指向的会话仍然存活，重取既多余
    // 又会把新端口写进 MPD 而让旧地址作废。
    enabled: item !== null && cid > 0 && bvid !== "" && adopted === null,
    queryFn: ({ signal }) =>
      pendingRequests.acquire(signal, () =>
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
      ),
    // 实例不是可自动刷新的数据；重试必须显式推进 revision。
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    structuralSharing: false,
    // 与代理会话同生命周期：绝不能缓存（见本文件头注）。
    gcTime: 0,
    retry: false,
  });
  // 接管的那份 playInfo 与正常取回的**形状完全一致**，因此附着、换源、会话上报
  // 全部无需区分来源。
  const playInfo = adopted ?? playInfoQuery.data;
  const playUrl = playInfo?.mpd_url;

  // 所有权移交：接管的那一刻把会话从保留位移出，此后由本槽位负责它的存亡
  // （`heldRef` 的交接与卸载两条路径）。刻意不在渲染期做 —— 渲染可能被丢弃，
  // 非幂等的移出会让会话被取走却没人管。
  useEffect(() => {
    if (!adopted) return;
    releasePlayInfo?.(itemKey);
  }, [adopted, itemKey, releasePlayInfo]);

  /**
   * 接管的会话可能已经不可用（上游签名过期、后端异常、进程重启）。
   *
   * 保留位在放回时会同时停会话，因此「条目还在保留位里但会话已死」理论上不会
   * 发生 —— 但这不是可以依赖的保证：进程重启后一切本机状态都归零。因此必须留
   * 一条退回取流的通道：丢掉接管的 playInfo、清错，让查询重新成立。
   */
  useEffect(() => {
    if (!error || !adopted) return;
    if (fellBackRef.current === itemKey) return;
    fellBackRef.current = itemKey;
    adoptedRef.current = null;
    setError(null);
    setRevision((value) => value + 1);
  }, [error, adopted, itemKey]);

  /**
   * 本槽位当前持有的会话（**所有权归本槽位**）。
   *
   * 所有权必须唯一：一条会话要么属于某个槽位的活媒体，要么属于保留位，不能同时
   * 属于两边 —— 否则会「两边都以为自己该停它」（重复停）或「两边都以为对方管」
   * （泄漏）。因此交出去的那一刻就清空这里。
   *
   * 用 `playInfo`（含接管来的那份）而不是 `playInfoQuery.data`：接管的会话同样
   * 由本槽位负责存亡。
   */
  const heldRef = useRef<{ key: string; playInfo: VideoPlayInfo } | null>(null);

  /**
   * 角色快照：当前条目的角色，以及**上一个条目的角色**。
   *
   * 为什么需要「上一份」：交接发生在条目变化后的某一帧（新 playInfo 到达时），
   * 而那时 `mode` 早已是新条目的角色。同一次提交里两个槽位会同时换条目
   * （方向翻转的第一次），只有「离开时在播」的那个值得保留，因此必须能读到
   * **旧条目当时的角色**。
   *
   * 为什么在渲染期写：放进 effect 的话，条目变化那一帧就会把快照覆写成新条目的
   * 角色，而交接要到新数据到达才跑 —— 快照里就没有旧条目的角色了（实测会让该
   * 保留的那条被停掉）。渲染期写 ref 是幂等的（StrictMode 双渲染写同一个值），
   * 与 `adoptedRef` 同一手法。
   */
  const roleRef = useRef<{ key: string; playing: boolean } | null>(null);
  const previousRoleRef = useRef<{ key: string; playing: boolean } | null>(null);
  {
    const playing = mode === "play";
    if (roleRef.current?.key !== itemKey) {
      previousRoleRef.current = roleRef.current;
      roleRef.current = itemKey ? { key: itemKey, playing } : null;
    } else if (roleRef.current.playing !== playing) {
      // 角色变化（预热 ↔ 活动）不换条目：只更新当前快照，不动「上一份」。
      roleRef.current = { key: itemKey, playing };
    }
  }

  /**
   * 会话交接：条目换了（或重试换了一份取流）时，处理上一份会话。
   *
   * 过渡期必须**保留**旧引用：换片时 queryKey 变、新数据未到，`data` 会变成
   * `undefined`。若在这一帧把引用写成 null，等新数据到达时 `previous` 已是 null，
   * 交接就永远不会发生 —— 旧会话（三个回环监听器）永不释放。实机验证过这一点：
   * 换片 12 次 `video_stop_play` 调用 0 次，进程回环监听端口线性增长（每次 +3）。
   *
   * 播放页同一份逻辑是好的，因为它有 `placeholderData: keepPreviousData`；短视频
   * 不能加那一行（会拿旧 MPD 打已停会话）。
   *
   * **交给保留位而不是停掉**：刚看过的那条很可能马上被回退到，停掉就得重新取流
   * （实测 386~481ms）。只有用户真正看过（离开时在播）的才值得留 —— 只是被预载
   * 过的那条用户没看过，而它恰好又成了新方向上的预热目标。
   */
  useEffect(() => {
    const previous = heldRef.current;
    const current = playInfo;
    if (!current || !previous) return;
    // 同一条同一份取流：不需要交接。用 `session_ids.mpd` 比：它是本次取流的身份
    // （重试会换一份新的 session_ids）。
    if (previous.key === itemKey && previous.playInfo.session_ids.mpd === current.session_ids.mpd) {
      return;
    }

    const wasPlaying =
      previousRoleRef.current?.key === previous.key && previousRoleRef.current.playing;
    if (wasPlaying && shortsShouldRetainSession(true) && previous.key !== itemKey && parkPlayInfo) {
      // 所有权移交给保留位：此后由它的 TTL 负责停这条会话。
      parkPlayInfo(previous.key, previous.playInfo);
      return;
    }
    // 重试（同一条换了一份取流）与「只是预载过」都直接停：前者旧 MPD 已作废，
    // 后者用户没看过。
    void videoStopPlay(previous.playInfo.session_ids);
  }, [playInfo, itemKey, parkPlayInfo]);

  // 记下本槽位当前持有的会话（声明顺序在交接之后：交接先读上一轮的旧值）。
  useEffect(() => {
    if (!playInfo) return;
    pendingRequests.claim(playInfo);
    heldRef.current = { key: itemKey, playInfo };
  }, [playInfo, itemKey, pendingRequests]);

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
    item: null,
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
  const expectedItemRef = useRef(itemKey);
  useLayoutEffect(() => {
    expectedItemRef.current = itemKey;
  }, [itemKey]);
  const attachTokenRef = useRef(0);

  /** 记下进度：身份经 ref 读取，并用 cid 比对挡住错位。 */
  const reportProgress = useCallback(
    (position: number, force: boolean) => {
      const session = sessionRef.current;
      // 预热不记账：它从未播放过，写进历史等于把没看的条目记成看过。
      if (session.mode !== "play") return;
      const current = session.item;
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
        () =>
          sessionRef.current.token === token &&
          sessionRef.current.mode === "play" &&
          !sessionRef.current.userPaused,
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
        if (sessionRef.current.mode === "play") onProgressRef.current?.(actual * 1_000);
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
      function onMetadata() {
        if (sessionRef.current.itemKey !== expectedItemRef.current) return;
        syncDuration();
        syncIntrinsicSize();
      }
      function onReady() {
        if (sessionRef.current.itemKey !== expectedItemRef.current || media.readyState < 3) return;
        setLoading(false);
        setReady(true);
        if (sessionRef.current.mode === "warm") playerRef.current?.setDashBufferMode("paused");
        syncTime();
        syncDuration();
        syncIntrinsicSize();
      }
      function onPlay() {
        setPaused(false);
        setLoading(false);
      }
      function onWaiting() {
        setReady(false);
        setLoading(true);
      }
      function onPlaying() {
        setReady(true);
        setLoading(false);
      }
      function onPause() {
        setPaused(true);
        // 暂停是「可能马上要走」的最强信号：立刻落盘，不等节流窗口。
        reportProgress(Number.isFinite(media.currentTime) ? media.currentTime : 0, true);
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
        if (sessionRef.current.mode !== "play" || sessionRef.current.userPaused) {
          setPaused(true);
          return;
        }
        const token = sessionRef.current.token;
        setTimeout(() => {
          // 延迟期间可能已经换片、卸载或用户手动暂停：那些情况下不该再起播。
          if (sessionRef.current.token !== token) return;
          if (sessionRef.current.mode !== "play" || sessionRef.current.userPaused) return;
          if (media.paused === false) return;
          media.currentTime = 0;
          void media.play().catch(() => {
            // 自动重播被浏览器策略拦下时留在暂停态，用户点一下即可。
          });
        }, 0);
      }

      media.addEventListener("timeupdate", syncTime);
      media.addEventListener("durationchange", syncDuration);
      media.addEventListener("loadedmetadata", onMetadata);
      media.addEventListener("waiting", onWaiting);
      media.addEventListener("canplay", onReady);
      media.addEventListener("play", onPlay);
      media.addEventListener("playing", onPlaying);
      media.addEventListener("pause", onPause);
      media.addEventListener("ended", onEnded);
      media.addEventListener("volumechange", syncAudio);
      media.addEventListener("resize", syncIntrinsicSize);
      return () => {
        media.removeEventListener("timeupdate", syncTime);
        media.removeEventListener("durationchange", syncDuration);
        media.removeEventListener("loadedmetadata", onMetadata);
        media.removeEventListener("waiting", onWaiting);
        media.removeEventListener("canplay", onReady);
        media.removeEventListener("play", onPlay);
        media.removeEventListener("playing", onPlaying);
        media.removeEventListener("pause", onPause);
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
        const media = boundMediaRef.current ?? videoRef.current;
        reportProgress(media && Number.isFinite(media.currentTime) ? media.currentTime : 0, true);
      }
      sessionRef.current.token = ++attachTokenRef.current;
      sessionRef.current.mode = "warm";
      unbindRef.current?.();
      unbindRef.current = null;
      boundMediaRef.current = null;
      attachedUrlRef.current = null;
      const player = playerRef.current;
      playerRef.current = null;
      try {
        player?.destroy();
      } catch {
        // 协议插件可能已经释放了它的 MediaSource。
      }
    },
    [reportProgress, videoRef],
  );

  // 完整卸载：先作废异步初始化/重播/自动播放，再销毁引擎，最后释放代理。
  // 代理释放延后一轮微任务，让 StrictMode 的 effect 重建可重新接管同一份结果。
  const mountEpochRef = useRef(0);
  useEffect(() => {
    const epoch = ++mountEpochRef.current;
    return () => {
      teardown(true);
      const held = heldRef.current;
      queueMicrotask(() => {
        // 生命周期代号，不是 DOM ref；必须读取最新值判断 StrictMode 是否已重建。
        // oxlint-disable-next-line react-hooks/exhaustive-deps
        if (mountEpochRef.current !== epoch) return;
        heldRef.current = null;
        if (held) void videoStopPlay(held.playInfo.session_ids).catch(() => undefined);
      });
    };
  }, [teardown]);

  // 条目变了就停止旧媒体；新取流到达前不能让旧条目继续出声或上报。
  useEffect(() => {
    if (sessionRef.current.itemKey === itemKey) return;
    reportProgress(videoRef.current?.currentTime ?? 0, true);
    sessionRef.current.token = ++attachTokenRef.current;
    sessionRef.current.mode = "warm";
    videoRef.current?.pause();
  }, [itemKey, videoRef, reportProgress]);

  // 槽位被清空（只有一条内容、流缩短）：拆播放器、停会话，不留三个本机监听器。
  useEffect(() => {
    if (item) return;
    teardown(true);
    const held = heldRef.current;
    heldRef.current = null;
    roleRef.current = null;
    if (held) void videoStopPlay(held.playInfo.session_ids);
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
    // 媒体闸门（见 `mediaAllowed`）：取流已经先跑完并缓存在 query 里，等活动槽位
    // 出画后这里立刻附着 —— 省掉的是取流那一段，媒体仍不会去抢带宽。
    if (!mediaAllowed) return;
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
      item,
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
    setReady(false);
    setError(null);
    setPaused(true);
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
      playerRef.current.setDashBufferMode(mode === "play" ? "active" : "warm");
      switchVideoJsDashSource(playerRef.current, playUrl);
      return;
    }

    boundMediaRef.current = media;
    unbindRef.current = bindListeners(media);
    let cancelled = false;
    void loadVideoJsModules("dash")
      .then((modules) => {
        if (cancelled || sessionRef.current.token !== token || playerRef.current) return;
        const player = createVideoJsPlayer(modules, {
          video: media,
          url: playUrl,
          kind: "dash",
          isLive: false,
          dash: videoJsDashBufferSettings(sessionRef.current.mode === "play" ? "active" : "warm"),
        });
        playerRef.current = player;
        player.on("error", (cause) => {
          if (
            playerRef.current !== player ||
            sessionRef.current.itemKey !== expectedItemRef.current
          )
            return;
          setReady(false);
          setError(videoJsPlayerErrorMessage(cause, "视频播放失败"));
          setLoading(false);
        });
        if (sessionRef.current.mode === "play") requestAutoplay(player, media, token);
      })
      .catch((cause) => {
        if (cancelled || sessionRef.current.token !== token) return;
        setError(videoJsPlayerErrorMessage(cause, "无法初始化视频播放器"));
        setLoading(false);
      });
    return () => {
      cancelled = true;
      // 初始化尚未完成时的依赖切换必须允许下一轮重新 attach。
      if (!playerRef.current && sessionRef.current.token === token) attachedUrlRef.current = null;
    };
    /*
     * `mode` 与 `requestAutoplay` 刻意不在依赖里。
     *
     * `mode` 有自己那条 effect（见上）：把它放进这里会在角色变化时重新附着，把已经
     * 缓冲好的内容推回加载态。`requestAutoplay` 是 `useCallback([])` 的稳定引用，
     * 加进去既不会改变行为也不会更正确。
     */
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [
    bindListeners,
    cid,
    item,
    itemKey,
    mediaAllowed,
    playInfo,
    playUrl,
    reportProgress,
    teardown,
    videoRef,
  ]);

  /**
   * 角色变化（预热 ↔ 活动）：只更新会话上下文，不动媒体。
   *
   * 历史上报与弹幕推进都按 `mode` 门控，因此提升的那一刻必须让监听闭包看到新角色
   * —— 但**不能**重新附着，那会把已经缓冲好的内容推回加载态。
   */
  useEffect(() => {
    if (sessionRef.current.itemKey === itemKey) sessionRef.current.mode = mode;
    sessionRef.current.onProgress = onProgressRef.current;
  }, [mode, itemKey]);

  // 已附着的邻居也受门控，而不是只挡首次 attach。停止新分片调度，保留已有缓冲。
  useEffect(() => {
    const currentSource = sessionRef.current.itemKey === itemKey;
    playerRef.current?.setDashBufferMode(
      !currentSource || !mediaAllowed
        ? "paused"
        : mode === "play"
          ? "active"
          : ready
            ? "paused"
            : "warm",
    );
  }, [itemKey, mediaAllowed, mode, ready]);

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
   * 媒体元素立即更新位置，独立 Video.js store 更新进度条，不驱动整页渲染。
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

  const getCurrentTime = useCallback(() => {
    if (sessionRef.current.itemKey !== itemKey) return 0;
    const time = videoRef.current?.currentTime ?? 0;
    return Number.isFinite(time) ? Math.max(0, time) : 0;
  }, [itemKey, videoRef]);

  const retry = useCallback(() => {
    adoptedRef.current = null;
    fellBackRef.current = itemKey;
    setError(null);
    setRevision((value) => value + 1);
  }, [itemKey]);

  // 换片重置错误态：新条目不该继承上一条的失败面板。
  const [settledKey, setSettledKey] = useState(itemKey);
  if (settledKey !== itemKey) {
    setSettledKey(itemKey);
    setError(null);
    setLoading(true);
    setReady(false);
    setDuration(0);
    // 画幅也要清：留着上一条的比例会让新条目先按错误的框画一帧。
    setIntrinsicSize(null);
  }

  return {
    // 取流本身也算加载，避免就绪前闪现暂停指示。
    loading: loading || (mediaAllowed && playInfoQuery.isFetching),
    paused,
    error: error ?? (playInfoQuery.error ? "取流失败，请重试" : null),
    getCurrentTime,
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
