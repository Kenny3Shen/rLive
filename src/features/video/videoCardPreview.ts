import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent, RefObject } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ROOM_CARD_PREVIEW_DELAY_MS,
  ROOM_CARD_PREVIEW_START_TIMEOUT_MS,
  createPreviewSurface,
  isRoomCardPreviewPointer,
  supportsRoomCardPreview,
  type PreviewSurface,
  type RoomCardPreviewPhase,
} from "@/features/room/player/roomCardPreview";
import { requestPlayerAutoplay } from "@/features/room/player/autoplay";
import { createSerialTaskQueue } from "@/features/room/player/serialTaskQueue";
import {
  createXgPlayer,
  loadXgPlayerModules,
  type XgPlayerInstance,
} from "@/features/room/player/xgPlayer";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import type { VideoPlayInfo, VideoSessionIds } from "@/shared/types/video";
import { videoGetArchive, videoGetPlayInfo, videoStopPlay } from "./videoApi";

/**
 * 视频卡片的悬停预览：与直播卡（`roomCardPreview.ts`）同一套交互语义 ——
 * 停留 600ms 后在封面上播静音画面，全局同时只允许一个预览，创建与销毁共用
 * 一条串行队列。差异只在内核：VOD 走 DASH（后端合成 MPD），直播走 FLV/HLS。
 *
 * 复用直播侧导出的判定（桌面细指针、减少动态效果、移动端一票否决）与
 * `.room-card-preview` 表面样式；设置项也共用同一个「卡片悬停预览」开关
 * —— 它们是同一个产品决策，不是两个。
 */

/**
 * VOD 预览刻意取最低档（`qn=16`）：卡片只有几百像素宽，带宽与解码预算
 * 比清晰度重要。请求的档位不存在时后端会回落到唯一可用流。
 */
const VIDEO_PREVIEW_QN = 16;

/**
 * 与直播不同，VOD 内容有头有尾：悬停再久也只需要看一小段来决定要不要点
 * 进去，15 秒后自动收，避免把一条长视频整个拉完。
 */
const VIDEO_CARD_PREVIEW_MAX_DURATION_MS = 15_000;

export type VideoCardPreviewHandle = { stop: () => void };

type VideoCardPreviewRequest = {
  /** 预览表面的挂载点：封面容器内已定位、pointer-events:none 的空节点。 */
  mount: HTMLElement;
  onPhase: (phase: RoomCardPreviewPhase) => void;
  fetchPlayInfo: () => Promise<VideoPlayInfo>;
};

const previewLifecycleQueue = createSerialTaskQueue();
let activeSession: VideoCardPreviewHandle | null = null;

export function stopVideoCardPreview(): void {
  activeSession?.stop();
}

export function startVideoCardPreview(request: VideoCardPreviewRequest): VideoCardPreviewHandle {
  stopVideoCardPreview();

  let stopped = false;
  let player: XgPlayerInstance | null = null;
  let surface: PreviewSurface | null = null;
  let sessions: VideoSessionIds | null = null;
  let startTimer: number | null = null;
  let durationTimer: number | null = null;

  function clearTimers() {
    for (const timer of [startTimer, durationTimer]) {
      if (timer !== null) window.clearTimeout(timer);
    }
    startTimer = null;
    durationTimer = null;
  }

  async function release() {
    clearTimers();
    const releasedPlayer = player;
    const releasedSurface = surface;
    const releasedSessions = sessions;
    player = null;
    surface = null;
    sessions = null;
    try {
      releasedPlayer?.pause();
      releasedPlayer?.destroy();
    } catch {
      // 协议插件可能已经释放了自己的 MediaSource；拆除不该因此中断。
    }
    releasedSurface?.root.remove();
    // 会话 id 是确定性的 `video-<bvid>-<cid>-<role>`。点进卡片时卸载先于播放页
    // 的取流完成（本机 stop ≪ 上游 playurl+sidx），因此这里停掉的一定还是
    // 预览自己的会话，而不是播放页刚接管的同名会话。
    if (releasedSessions) await videoStopPlay(releasedSessions);
  }

  const session: VideoCardPreviewHandle = {
    stop: () => {
      if (stopped) return;
      stopped = true;
      if (activeSession === session) activeSession = null;
      request.onPhase("idle");
      void previewLifecycleQueue.enqueue(release);
    },
  };
  activeSession = session;

  void previewLifecycleQueue.enqueue(async () => {
    // 任何提前返回都由 `session.stop()` 排入的 release 负责回收资源。
    if (stopped) return;
    try {
      request.onPhase("loading");

      const playInfo = await request.fetchPlayInfo();
      if (stopped) return;
      sessions = playInfo.session_ids;

      const modules = await loadXgPlayerModules("dash");
      if (stopped) return;

      const mounted = createPreviewSurface();
      surface = mounted;
      request.mount.append(mounted.root);

      const instance = createXgPlayer(modules, {
        root: mounted.root,
        video: mounted.video,
        // 与播放页同一条约束：必须喂 HTTP 的 mpd_url，blob 会被插件的 XHR 拼
        // `?` 后 404。
        url: playInfo.mpd_url,
        kind: "dash",
        // VOD 必须显式关直播模式，否则内核按不确定时长处理。
        isLive: false,
        // 预览只播前几秒不 seek，但分片选择走同一条链路：喂真实时间轴，
        // 让插件按分片级精度取片（见 `applyXgDashSegmentTimeline`）。
        dashSegmentTimeline: {
          video: playInfo.video_segment_times,
          audio: playInfo.audio_segment_times,
        },
      });
      player = instance;
      // 卡片要铺满而不是留黑边；预览永远静音。
      mounted.video.style.objectFit = "cover";
      mounted.video.muted = true;

      mounted.video.addEventListener("playing", () => {
        if (stopped || surface !== mounted) return;
        if (startTimer !== null) {
          window.clearTimeout(startTimer);
          startTimer = null;
        }
        mounted.root.dataset.previewPhase = "playing";
        request.onPhase("playing");
        // 出画后才开始计预览时长：加载慢不该吃掉观看窗口。
        if (durationTimer === null) {
          durationTimer = window.setTimeout(() => {
            durationTimer = null;
            session.stop();
          }, VIDEO_CARD_PREVIEW_MAX_DURATION_MS);
        }
      });
      instance.on("error", () => session.stop());

      // 与直播预览同款：静音起播 + 吸收 xgplayer attach 时的首个 AbortError；
      // 恢复钩子永远返回 false —— 绝不能把声音放出来。
      requestPlayerAutoplay(
        instance,
        mounted.video,
        () => !stopped && surface === mounted,
        () => false,
      );
      startTimer = window.setTimeout(() => {
        startTimer = null;
        session.stop();
      }, ROOM_CARD_PREVIEW_START_TIMEOUT_MS);
    } catch {
      if (stopped) return;
      // 预览是纯增益能力：失败静默回落到封面，绝不打扰浏览。
      stopped = true;
      if (activeSession === session) activeSession = null;
      request.onPhase("idle");
      await release();
    }
  });

  return session;
}

export type VideoCardPreview = {
  /** 挂载点须位于封面容器内、渐变遮罩之下，并且自身不接收指针事件。 */
  mountRef: RefObject<HTMLDivElement | null>;
  phase: RoomCardPreviewPhase;
  onPointerEnter: (event: PointerEvent<HTMLElement>) => void;
  stop: () => void;
};

export function useVideoCardPreview(target: {
  bvid: string;
  cid: number | null;
}): VideoCardPreview {
  const { bvid, cid } = target;
  const queryClient = useQueryClient();
  const enabled = useSettingsStore((state) => state.roomCardPreviewEnabled);
  // 指针能力与无障碍偏好在一次会话内不变，每张卡片只探测一次。
  const supported = useMemo(() => supportsRoomCardPreview(), []);
  const [phase, setPhase] = useState<RoomCardPreviewPhase>("idle");
  const mountRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<VideoCardPreviewHandle | null>(null);
  const dwellTimerRef = useRef<number | null>(null);

  const stop = useCallback(() => {
    if (dwellTimerRef.current !== null) {
      window.clearTimeout(dwellTimerRef.current);
      dwellTimerRef.current = null;
    }
    handleRef.current?.stop();
    handleRef.current = null;
    setPhase("idle");
  }, []);

  const onPointerEnter = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      if (!enabled || !supported) return;
      // 没有 bvid 的脏条目（后端已过滤，防御）才放弃。搜索与 UP 主列表的条目
      // 没有 cid：与播放页同一条链路 —— 先经稿件详情补齐 P1 的 cid 再取预览流，
      // archive 走 react-query 缓存，与右侧栏/播放页共享同一次请求。
      if (!bvid) return;
      if (!isRoomCardPreviewPointer(event.pointerType)) return;
      stop();
      dwellTimerRef.current = window.setTimeout(() => {
        dwellTimerRef.current = null;
        const mount = mountRef.current;
        if (!mount) return;
        handleRef.current = startVideoCardPreview({
          mount,
          onPhase: setPhase,
          fetchPlayInfo: async () => {
            const resolvedCid =
              cid && cid > 0
                ? cid
                : (
                    await queryClient.fetchQuery({
                      queryKey: ["video_archive", bvid],
                      queryFn: () => videoGetArchive(bvid),
                      staleTime: 5 * 60_000,
                    })
                  ).cid;
            return videoGetPlayInfo({ bvid, cid: resolvedCid, qn: VIDEO_PREVIEW_QN });
          },
        });
      }, ROOM_CARD_PREVIEW_DELAY_MS);
    },
    [bvid, cid, enabled, queryClient, stop, supported],
  );

  useEffect(() => () => stop(), [stop]);

  return { mountRef, phase, onPointerEnter, stop };
}
