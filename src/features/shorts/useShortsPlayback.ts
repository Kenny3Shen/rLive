import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { requestPlayerAutoplay } from "@/features/room/player/autoplay";
import {
  createVideoJsPlayer,
  loadVideoJsModules,
  videoJsPlayerErrorMessage,
  type VideoJsPlayerInstance,
} from "@/features/room/player/videoJsPlayer";
import { videoGetPlayInfo, videoStopPlay } from "@/features/video/videoApi";
import { VIDEO_HISTORY_QUERY_KEY, videoHistoryAdd } from "@/features/video/videoHistory";
import { isWatchProgressWorthKeeping, shouldReportWatchProgress } from "@/shared/watchProgress";
import type { VideoItem, VideoSessionIds } from "@/shared/types/video";
import { shortsItemKey, type ShortsIntrinsicSize } from "./shortsFeed";

/**
 * 竖屏舞台的起播链路。
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
 */

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
  /** 点按切换播放/暂停。 */
  togglePlay: () => void;
  toggleMuted: () => void;
  /** 重试当前条目（重新取流并重建播放器）。 */
  retry: () => void;
};

type UseShortsPlaybackOptions = {
  /** 当前条目；null 表示流还没就绪（此时不取流、不建播放器）。 */
  item: VideoItem | null;
  videoRef: RefObject<HTMLVideoElement | null>;
  /** 页面可见且这一条是活动条目。false 时不起播（滑动过程中的相邻条目）。 */
  active: boolean;
  /** 播放位置推进的回调：弹幕分段按它加载。 */
  onProgress?: ((positionMs: number) => void) | undefined;
};

export function useShortsPlayback({
  item,
  videoRef,
  active,
  onProgress,
}: UseShortsPlaybackOptions): ShortsPlaybackState {
  const queryClient = useQueryClient();
  const [loading, setLoading] = useState(true);
  const [waiting, setWaiting] = useState(false);
  const [paused, setPaused] = useState(true);
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
  /** 用户显式暂停过：自动起播与循环重播都不该把它拉回播放。 */
  const userPausedRef = useRef(false);
  const playerRef = useRef<VideoJsPlayerInstance | null>(null);
  const mutedRef = useRef(false);
  const [revision, setRevision] = useState(0);

  const cid = item?.cid ?? 0;
  const bvid = item?.bvid ?? "";
  const itemKey = item ? shortsItemKey(item) : "";

  const playInfoQuery = useQuery({
    // revision 进 key：重试就是换一份取流（旧会话已停，MPD 不可复用）。
    queryKey: ["shorts_play_info", bvid, cid, revision],
    enabled: active && cid > 0 && bvid !== "",
    queryFn: () => videoGetPlayInfo({ bvid, cid, ep_id: null, qn: null, audio_only: false }),
    // 与代理会话同生命周期：绝不能缓存（见本文件头注）。
    gcTime: 0,
    retry: false,
  });
  const playInfo = playInfoQuery.data;

  /**
   * 代理会话的拆除。
   *
   * 两条路径都必须走到：换片（itemKey 变）与卸载。会话链必须 A→B 连续，因此用
   * 原始 query 数据而不是任何会在过渡期变成 undefined 的派生值。
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
  // 滑走或页面离开时也要停：query 被 disable 后不会再有新的 session 来替换旧的。
  useEffect(() => {
    if (active) return;
    const sessions = sessionsRef.current;
    sessionsRef.current = null;
    previousSessionsRef.current = null;
    if (sessions) void videoStopPlay(sessions);
  }, [active]);

  /** 这一条上次写盘的时刻；null = 还没写过。换片时由播放器 effect 重置。 */
  const reportedAtRef = useRef<number | null>(null);
  const itemRef = useRef(item);
  useLayoutEffect(() => {
    if (item) itemRef.current = item;
  }, [item]);

  const onProgressRef = useRef(onProgress);
  useLayoutEffect(() => {
    onProgressRef.current = onProgress;
  }, [onProgress]);

  const playUrl = playInfo?.mpd_url;

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !playUrl || !active) return;
    // 固定本轮的媒体元素：下面所有事件处理器都闭包它，而不是每次重读
    // `videoRef.current`——后者在拆除路径上可能已置空。
    const media = video;
    let cancelled = false;
    // 这一轮播放器对应的条目。上报前比对，避免换片过渡期把进度记到别人身上。
    const reportedCid = cid;
    reportedAtRef.current = null;

    // oxlint-disable-next-line react/set-state-in-effect
    setLoading(true);
    setWaiting(false);
    setError(null);
    setPaused(true);
    setCurrentTime(0);
    setDuration(playInfo?.duration ?? 0);
    userPausedRef.current = false;

    function totalDuration() {
      const fromInfo = playInfo?.duration ?? 0;
      if (fromInfo > 0) return fromInfo;
      return Number.isFinite(media.duration) && media.duration > 0 ? media.duration : 0;
    }

    /**
     * 把进度写进本地观看历史。
     *
     * 身份经 ref 读取而不是闭包捕获，并用 `reportedCid` 比对挡住错位：换片后
     * ref 已指向新条目，旧实例清理路径上的最后一次 flush 因此被丢弃。
     * 失败只吞掉 —— 历史是本地记账，不该让它的故障打断播放。
     */
    function reportProgress(position: number, force: boolean) {
      const current = itemRef.current;
      if (!current || (current.cid ?? 0) !== reportedCid) return;
      const now = Date.now();
      if (force) {
        if (!isWatchProgressWorthKeeping(position)) return;
      } else if (!shouldReportWatchProgress(position, reportedAtRef.current, now)) {
        return;
      }
      reportedAtRef.current = now;
      const total = totalDuration();
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
        duration: total > 0 ? total : 0,
        watched_at: now,
      })
        .then(() => queryClient.invalidateQueries({ queryKey: VIDEO_HISTORY_QUERY_KEY }))
        .catch(() => undefined);
    }

    function syncTime() {
      if (cancelled) return;
      const actual = Number.isFinite(media.currentTime) ? Math.max(0, media.currentTime) : 0;
      setCurrentTime(actual);
      onProgressRef.current?.(actual * 1_000);
      reportProgress(actual, false);
    }
    function syncDuration() {
      if (cancelled) return;
      // 后端从 sidx 累加出的时长更早可用也更精确，只有它缺失才退回媒体元数据。
      if ((playInfo?.duration ?? 0) > 0) return;
      if (Number.isFinite(media.duration) && media.duration > 0) setDuration(media.duration);
    }
    /** 画幅：`loadedmetadata` 时首次可得，`resize` 在换轨/旋转后再报。 */
    function syncIntrinsicSize() {
      if (cancelled) return;
      const width = media.videoWidth;
      const height = media.videoHeight;
      if (!(width > 0) || !(height > 0)) return;
      setIntrinsicSize((current) =>
        current?.width === width && current.height === height ? current : { width, height },
      );
    }
    function onReady() {
      if (cancelled) return;
      setLoading(false);
      setWaiting(false);
      syncTime();
      syncDuration();
      syncIntrinsicSize();
    }
    function onPlay() {
      if (cancelled) return;
      setPaused(false);
      setWaiting(false);
      setLoading(false);
    }
    function onPlaying() {
      if (cancelled) return;
      setWaiting(false);
      setLoading(false);
    }
    function onPause() {
      if (cancelled) return;
      setPaused(true);
      // 暂停是「可能马上要走」的最强信号：立刻落盘，不等节流窗口。
      reportProgress(Number.isFinite(media.currentTime) ? media.currentTime : 0, true);
    }
    function onWaiting() {
      if (cancelled) return;
      if (!media.ended) setWaiting(true);
    }
    function onSeeked() {
      if (cancelled) return;
      setWaiting(false);
    }
    function syncAudio() {
      if (cancelled) return;
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
     */
    function onEnded() {
      if (cancelled) return;
      const total = totalDuration();
      // 播完记满进度：历史卡的进度条画到底，也让「已看完」判定成立。
      reportProgress(total > 0 ? total : media.currentTime, true);
      if (userPausedRef.current) {
        setPaused(true);
        return;
      }
      media.currentTime = 0;
      void media.play().catch(() => {
        // 自动重播被浏览器策略拦下时留在暂停态，用户点一下即可。
      });
    }

    media.muted = mutedRef.current;
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

    void loadVideoJsModules("dash")
      .then((modules) => {
        if (cancelled) return;
        const player = createVideoJsPlayer(modules, {
          video: media,
          url: playUrl,
          kind: "dash",
          isLive: false,
        });
        playerRef.current = player;
        player.on("error", (cause) => {
          if (cancelled) return;
          setError(videoJsPlayerErrorMessage(cause, "视频播放失败"));
          setLoading(false);
          setWaiting(false);
        });
        // 与直播/播放页同源：先试带声音，被自动播放策略拒绝时降级静音起播再
        // 立刻尝试恢复声音；用户手动静音过则保持静音。
        requestPlayerAutoplay(
          player,
          media,
          () => !cancelled && playerRef.current === player && !userPausedRef.current,
          () => {
            if (mutedRef.current) return false;
            setMuted(false);
            return true;
          },
        );
      })
      .catch((cause) => {
        if (cancelled) return;
        setError(videoJsPlayerErrorMessage(cause, "无法初始化视频播放器"));
        setLoading(false);
      });

    return () => {
      // 销毁前记下最后一次进度：媒体元素此刻还能读 currentTime。
      // 放在 `cancelled = true` 之前，让它与其它 flush 走同一条 reportProgress。
      reportProgress(Number.isFinite(media.currentTime) ? media.currentTime : 0, true);
      cancelled = true;
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
      const player = playerRef.current;
      playerRef.current = null;
      try {
        player?.pause();
        player?.destroy();
      } catch {
        // 协议插件可能已经释放了它的 MediaSource。
      }
    };
  }, [active, cid, playInfo?.duration, playUrl, queryClient, videoRef]);

  // 滑走的条目立刻停声：媒体元素被下一条复用之前不该还在播。
  useEffect(() => {
    if (active) return;
    const media = videoRef.current;
    if (media && !media.paused) media.pause();
  }, [active, videoRef]);

  const togglePlay = useCallback(() => {
    const media = videoRef.current;
    if (!media) return;
    if (media.paused) {
      userPausedRef.current = false;
      void media.play().catch(() => {
        // 起播被拦下时保持暂停，界面上的暂停图标仍然诚实。
      });
    } else {
      userPausedRef.current = true;
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
    setCurrentTime(0);
    setDuration(0);
    // 画幅也要清：留着上一条的比例会让新条目先按错误的框画一帧。
    setIntrinsicSize(null);
  }

  return {
    // 取流本身也算加载：封面要一直盖到播放器真的出画为止。
    loading: loading || playInfoQuery.isFetching,
    waiting,
    paused,
    error: error ?? (playInfoQuery.error ? "取流失败，请重试" : null),
    currentTime,
    duration,
    muted,
    intrinsicSize,
    togglePlay,
    toggleMuted,
    retry,
  };
}
