import { invokeCmd } from "@/shared/api/tauri";
import { isMobileClient } from "@/shared/clientPlatform";
import { prefersReducedMotion } from "@/shared/motion/preference";
import type { LivePlayQuality, LiveRoomDetail, PlayUrl } from "@/shared/types/live";
import { pickDefaultQualityIndex } from "../playback/quality";
import { rankPlaybackSourceIndices } from "../playback/sourceSelection";
import { requestPlayerAutoplay } from "./autoplay";
import { createSerialTaskQueue } from "./serialTaskQueue";
import {
  createXgPlayer,
  loadXgPlayerModules,
  webPlaybackKind,
  type XgPlayerInstance,
} from "./xgPlayer";

/** 悬停多久才开始取流。足够让鼠标扫过整行卡片而不触发任何一次预览。 */
export const ROOM_CARD_PREVIEW_DELAY_MS = 600;

/** 首帧最迟到达时间。超时即释放,避免死线路一直占着本机代理与带宽。 */
export const ROOM_CARD_PREVIEW_START_TIMEOUT_MS = 12_000;

/** 每个预览会话独占一个本机代理监听器;前缀避免和房间播放器的会话号相撞。 */
const PREVIEW_SESSION_PREFIX = "room-card-preview";

export type RoomCardPreviewPhase = "idle" | "loading" | "playing";

export type RoomCardPreviewRequest = {
  /** 预览表面的挂载点:封面容器内一个已定位、pointer-events:none 的空节点。 */
  mount: HTMLElement;
  onPhase: (phase: RoomCardPreviewPhase) => void;
  fetchDetail: () => Promise<LiveRoomDetail>;
  fetchQualities: (detail: LiveRoomDetail) => Promise<LivePlayQuality[]>;
  fetchLines: (detail: LiveRoomDetail, quality: LivePlayQuality) => Promise<PlayUrl[]>;
};

export type RoomCardPreviewHandle = { stop: () => void };

/**
 * 预览只在真正存在悬停语义的桌面指针上开启。触摸客户端的 hover 是点击的副产物,
 * 而请求减少动态效果的用户不应被自动播放的画面打扰。
 */
export function supportsRoomCardPreview(
  input: { mobile?: boolean; finePointer?: boolean; reducedMotion?: boolean } = {},
): boolean {
  const mobile = input.mobile ?? isMobileClient();
  const finePointer =
    input.finePointer ??
    (typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(hover: hover) and (pointer: fine)").matches);
  const reducedMotion = input.reducedMotion ?? prefersReducedMotion();
  return !mobile && finePointer && !reducedMotion;
}

/** 只有鼠标表达"停在这里就是想看";触摸与笔的 hover 事件是误触。 */
export function isRoomCardPreviewPointer(pointerType?: string): boolean {
  return !pointerType || pointerType === "mouse";
}

/**
 * 预览刻意取最低画质:卡片只有几百像素宽,浏览页可能同时驻留上百张卡片,
 * 带宽与解码预算比清晰度重要。
 */
export function pickRoomCardPreviewQuality(
  qualities: readonly LivePlayQuality[],
): LivePlayQuality | null {
  if (qualities.length === 0) return null;
  return qualities[pickDefaultQualityIndex(qualities.length, "low")] ?? null;
}

/** 预览直接取适配器优先级最高的一条,失败就放弃。 */
export function pickRoomCardPreviewSource(lines: readonly PlayUrl[]): PlayUrl | null {
  const index = rankPlaybackSourceIndices(lines)[0];
  return index === undefined ? null : (lines[index] ?? null);
}

/** 预览缓冲窗口比房间播放器窄一个量级:只求快速出画并尽早丢弃已播片段。 */
export function roomCardPreviewMpegtsOptions(type: "flv" | "mpegts"): Record<string, unknown> {
  return {
    mediaDataSource: { type, isLive: true, hasAudio: false, hasVideo: true },
    mpegtsConfig: {
      enableWorker: false,
      enableStashBuffer: false,
      stashInitialSize: 128,
      liveBufferLatencyChasing: true,
      liveBufferLatencyMaxLatency: 4,
      liveBufferLatencyMinRemain: 0.5,
      autoCleanupSourceBuffer: true,
      autoCleanupMaxBackwardDuration: 6,
      autoCleanupMinBackwardDuration: 3,
    },
  };
}

/** `capLevelToPlayerSize` 让 hls.js 把渲染档钉在够铺满卡片的最低档上。 */
export function roomCardPreviewHlsOptions(): Record<string, unknown> {
  return {
    lowLatencyMode: false,
    backBufferLength: 6,
    maxBufferLength: 10,
    capLevelToPlayerSize: true,
    startLevel: 0,
    manifestLoadingMaxRetry: 1,
    levelLoadingMaxRetry: 1,
    fragLoadingMaxRetry: 1,
  };
}

type PreviewSurface = { root: HTMLDivElement; video: HTMLVideoElement };

function createPreviewSurface(): PreviewSurface {
  const root = document.createElement("div");
  root.className = "room-card-preview";
  root.dataset.previewPhase = "loading";
  const video = document.createElement("video");
  video.muted = true;
  video.defaultMuted = true;
  video.playsInline = true;
  video.autoplay = false;
  video.controls = false;
  video.preload = "auto";
  video.disablePictureInPicture = true;
  root.append(video);
  return { root, video };
}

/**
 * 全局只允许一个预览存活。卡片网格一行就有五六张,鼠标横穿会连续触发进入事件;
 * 并且创建与销毁共用一条串行队列,新预览绝不会与上一个的拆除交错。
 */
const previewLifecycleQueue = createSerialTaskQueue();
let activeSession: RoomCardPreviewHandle | null = null;
let previewSessionSerial = 0;

export function stopRoomCardPreview(): void {
  activeSession?.stop();
}

export function startRoomCardPreview(request: RoomCardPreviewRequest): RoomCardPreviewHandle {
  stopRoomCardPreview();

  previewSessionSerial += 1;
  const serial = previewSessionSerial;
  const sessionId = `${PREVIEW_SESSION_PREFIX}:${serial}`;
  let stopped = false;
  let player: XgPlayerInstance | null = null;
  let surface: PreviewSurface | null = null;
  let proxyStarted = false;
  let startTimer: number | null = null;

  function clearStartTimer() {
    if (startTimer === null) return;
    window.clearTimeout(startTimer);
    startTimer = null;
  }

  async function release() {
    clearStartTimer();
    const releasedPlayer = player;
    const releasedSurface = surface;
    player = null;
    surface = null;
    try {
      releasedPlayer?.pause();
      releasedPlayer?.destroy();
    } catch {
      // 协议插件可能已经释放了自己的 MediaSource;拆除不该因此中断。
    }
    releasedSurface?.root.remove();
    if (proxyStarted) {
      proxyStarted = false;
      try {
        await invokeCmd("stream_proxy_stop", { sessionId });
      } catch {
        // 会话可能已被后端回收;预览没有需要上报的失败。
      }
    }
  }

  const session: RoomCardPreviewHandle = {
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

      const detail = await request.fetchDetail();
      if (stopped) return;
      if (!detail.status) {
        session.stop();
        return;
      }

      const qualities = await request.fetchQualities(detail);
      if (stopped) return;
      const quality = pickRoomCardPreviewQuality(qualities);
      if (!quality) {
        session.stop();
        return;
      }

      const lines = await request.fetchLines(detail, quality);
      if (stopped) return;
      const source = pickRoomCardPreviewSource(lines);
      if (!source) {
        session.stop();
        return;
      }

      const kind = webPlaybackKind(source);
      const modules = await loadXgPlayerModules(kind);
      if (stopped) return;

      const localUrl = await invokeCmd<string>("stream_proxy_start", {
        url: source.url,
        headers: source.headers,
        sessionId,
        hls: kind === "hls",
        twitchAdRecovery: source.twitch_ad_recovery,
      });
      proxyStarted = true;
      if (stopped) return;

      // 缓存穿透:浏览器绝不能复用上一个预览监听器的 keep-alive 连接。
      const playUrl = `${localUrl}${localUrl.includes("?") ? "&" : "?"}t=${Date.now()}_${serial}`;
      const mounted = createPreviewSurface();
      surface = mounted;
      request.mount.append(mounted.root);

      const instance = createXgPlayer(modules, {
        root: mounted.root,
        video: mounted.video,
        url: playUrl,
        kind,
        isLive: kind !== "native",
        flv: roomCardPreviewMpegtsOptions("flv"),
        mpegts: roomCardPreviewMpegtsOptions("mpegts"),
        hls: { hlsOpts: roomCardPreviewHlsOptions() },
      });
      player = instance;
      // xgplayer 的 videoFillMode 会写成 contain;卡片要铺满而不是留黑边。
      mounted.video.style.objectFit = "cover";
      mounted.video.muted = true;

      mounted.video.addEventListener("playing", () => {
        if (stopped || surface !== mounted) return;
        clearStartTimer();
        mounted.root.dataset.previewPhase = "playing";
        request.onPhase("playing");
      });
      instance.on("error", () => session.stop());

      // xgplayer 在 `videoInit` 下 attach 媒体元素时会 load 一次，打断首个 `play()`
      // 并抛 `AbortError`。房间播放器一直靠这个 helper 的重试吸收它，预览同样必须
      // 重试，否则 `<video>` 永远停在 paused、`playing` 不触发、卡片只剩加载动画。
      requestPlayerAutoplay(
        instance,
        mounted.video,
        () => !stopped && surface === mounted,
        // 预览始终静音：绝不能因为静音重试成功就把声音放出来。
        () => false,
      );
      startTimer = window.setTimeout(() => {
        startTimer = null;
        session.stop();
      }, ROOM_CARD_PREVIEW_START_TIMEOUT_MS);
    } catch {
      if (stopped) return;
      // 预览是纯增益能力:失败静默回落到封面,绝不打扰浏览。
      stopped = true;
      if (activeSession === session) activeSession = null;
      request.onPhase("idle");
      await release();
    }
  });

  return session;
}
