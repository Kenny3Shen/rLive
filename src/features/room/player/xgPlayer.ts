import type { IPlayerOptions } from "xgplayer";
import { playbackProtocol } from "@/lib/playUrl";
import type { PlayUrl } from "@/shared/types/live";

/**
 * `dash` 只用于 B 站视频（VOD），直播不走它：DASH 需要一份完整的分片清单，
 * 直播流没有。见 `features/video/`。
 */
export type XgPlaybackKind = "flv" | "hls" | "mpegts" | "native" | "dash";

/**
 * 直播/IPTV 侧能产出的内核，即 `XgPlaybackKind` 去掉 `dash`。
 *
 * 这两条链路的结果会流进 `PlayUrl.protocol` 与播放遥测的 `PlayerTransportProtocol`，
 * 那两个类型镜像后端且不含 DASH。用一个收窄的别名声明「这里永不为 dash」，
 * 比把 `dash` 灌进那些类型再到处兜底更贴事实。
 */
export type XgLivePlaybackKind = Exclude<XgPlaybackKind, "dash">;

/** 把站点声明的传输协议映射到本封装惰性加载的 xgplayer 内核。 */
export function webPlaybackKind(
  source: Pick<PlayUrl, "url" | "protocol">,
): XgLivePlaybackKind {
  switch (playbackProtocol(source)) {
    case "hls":
      return "hls";
    case "mpeg_ts":
      return "mpegts";
    case "native":
      return "native";
    default:
      return "flv";
  }
}

export type XgPlayerInstance = {
  media: HTMLMediaElement;
  play: () => Promise<void> | null;
  pause: () => void;
  switchURL?: (
    url: string | object,
    options?: { seamless?: boolean; currentTime?: number; bitrate?: number },
  ) => Promise<unknown> | null | void;
  destroy: () => void;
  on: (event: string, handler: (...args: unknown[]) => void) => void;
  getPlugin: (condition: string | Function) => unknown;
};

type XgPlayerConstructor = new (options: IPlayerOptions) => XgPlayerInstance;

type XgStreamingPlugin = {
  isSupported?: (...args: unknown[]) => boolean;
};

export type XgPlayerModules = {
  Player: XgPlayerConstructor;
  plugin?: XgStreamingPlugin;
};

export type XgHlsCore = {
  startLoad: (startPosition?: number) => void;
  /**
   * 位于 `media.currentTime` 处那一帧的挂钟时间，取自播放列表的
   * `EXT-X-PROGRAM-DATE-TIME`。清单不带节目时钟时为 null。
   */
  programDateMs: () => number | null;
};

export type XgMpegtsCore = {
  on: (event: string, handler: (...args: unknown[]) => void) => void;
  off?: (event: string, handler: (...args: unknown[]) => void) => void;
  currentTime?: number;
  /** 协议内核挂载时直接使用 mpegts.js 的 seek 路径。 */
  seek?: (seconds: number) => boolean;
};

let coreModulePromise: Promise<typeof import("xgplayer")> | null = null;
let hlsModulePromise: Promise<typeof import("xgplayer-hls.js")> | null = null;
let mpegtsModulePromise: Promise<typeof import("xgplayer-mpegts.js")> | null = null;
let dashModulePromise: Promise<typeof import("xgplayer-dash")> | null = null;

function loadCoreModule(): Promise<typeof import("xgplayer")> {
  if (!coreModulePromise) coreModulePromise = import("xgplayer");
  return coreModulePromise;
}

/** 按所选直播源惰性加载所需的唯一协议插件。 */
export async function loadXgPlayerModules(kind: XgPlaybackKind): Promise<XgPlayerModules> {
  const corePromise = loadCoreModule();
  if (kind === "hls") {
    if (!hlsModulePromise) hlsModulePromise = import("xgplayer-hls.js");
    const [core, { default: plugin }] = await Promise.all([corePromise, hlsModulePromise]);
    return {
      Player: core.SimplePlayer as unknown as XgPlayerConstructor,
      plugin: plugin as unknown as XgStreamingPlugin,
    };
  }
  if (kind === "flv" || kind === "mpegts") {
    if (!mpegtsModulePromise) mpegtsModulePromise = import("xgplayer-mpegts.js");
    const [core, { default: plugin }] = await Promise.all([corePromise, mpegtsModulePromise]);
    return {
      Player: core.SimplePlayer as unknown as XgPlayerConstructor,
      plugin: plugin as unknown as XgStreamingPlugin,
    };
  }
  if (kind === "dash") {
    if (!dashModulePromise) dashModulePromise = import("xgplayer-dash");
    const [core, { default: plugin }] = await Promise.all([corePromise, dashModulePromise]);
    return {
      Player: core.SimplePlayer as unknown as XgPlayerConstructor,
      plugin: plugin as unknown as XgStreamingPlugin,
    };
  }
  const core = await corePromise;
  return { Player: core.SimplePlayer as unknown as XgPlayerConstructor };
}

export function createXgPlayer(
  modules: XgPlayerModules,
  options: {
    root: HTMLElement;
    video: HTMLVideoElement;
    url: string;
    kind: XgPlaybackKind;
    isLive?: boolean;
    flv?: Record<string, unknown>;
    hls?: Record<string, unknown>;
    mpegts?: Record<string, unknown>;
  },
): XgPlayerInstance {
  const { root, video, url, kind, isLive = true, flv, hls, mpegts } = options;
  const pluginSupported = modules.plugin?.isSupported?.() ?? true;

  if ((kind === "flv" || kind === "mpegts") && !pluginSupported) {
    throw new Error("当前环境不支持 MSE 直播播放");
  }
  if (kind === "hls" && !pluginSupported) {
    throw new Error("当前环境不支持 HLS 直播播放");
  }
  // DashPlugin 没有 `isSupported`，上面的 `?? true` 因此恒真。DASH 完全靠 MSE
  // 喂数据，缺它会在插件深处才失败，这里提前给出可读的原因。
  if (kind === "dash" && typeof window !== "undefined" && !("MediaSource" in window)) {
    throw new Error("当前环境不支持 MSE，无法播放 DASH 视频");
  }

  const plugins = modules.plugin && pluginSupported ? [modules.plugin] : [];
  const playerOptions: IPlayerOptions & { hlsJsPlugin?: Record<string, unknown> } = {
    el: root,
    mediaEl: video,
    url,
    plugins,
    autoplay: false,
    videoInit: true,
    isLive,
    width: "100%",
    height: "100%",
    playsinline: true,
    controls: false,
    keyShortcut: false,
    closeVideoClick: true,
    closeVideoDblclick: true,
    closePlayerBlur: true,
    remainMediaAfterDestroy: true,
    lang: "zh-cn",
    videoFillMode: "contain",
  };

  if (kind === "flv") playerOptions.MpegtsPlugin = flv ?? {};
  if (kind === "hls") playerOptions.hlsJsPlugin = hls ?? {};
  if (kind === "mpegts") playerOptions.MpegtsPlugin = mpegts ?? {};

  return new modules.Player(playerOptions);
}

export function getXgMpegtsCore(player: XgPlayerInstance): XgMpegtsCore | null {
  const plugin = player.getPlugin("MpegtsPlugin") as {
    mpegts?: XgMpegtsCore | null;
  } | null;
  if (!plugin) return null;

  // 插件在每次 URL 变化时销毁并重建其 mpegts.js 实例。即使调用本助手时第一个
  // 内核已经存在，也要把订阅挂在当前实例上。
  return {
    seek: (seconds) => {
      const core = plugin.mpegts ?? null;
      if (!core || !Number.isFinite(seconds)) return false;
      core.currentTime = Math.max(0, seconds);
      return true;
    },
    on: (event, handler) => {
      let attachedCore: XgMpegtsCore | null = null;
      const attach = () => {
        const core = plugin.mpegts ?? null;
        if (!core || core === attachedCore) return;
        attachedCore?.off?.(event, handler);
        core.on(event, handler);
        attachedCore = core;
      };
      attach();
      void Promise.resolve().then(attach);
      player.on("ready", attach);
      player.on("urlchange", attach);
    },
  };
}

export function xgPlaybackSwitchOptions(kind: XgPlaybackKind): { seamless: boolean } {
  // xgplayer-mpegts.js 在 URL_CHANGE 时重建自己的 transmuxer/MSE 状态。保留外层
  // 播放器与媒体元素，但不要求跨相互独立的 FLV CDN 保持时间戳无缝。
  return { seamless: kind !== "flv" };
}

export const XG_PLAYBACK_SWITCH_TIMEOUT_MS = 12_000;

export async function switchXgPlaybackSource(
  player: XgPlayerInstance,
  url: string,
  kind: XgPlaybackKind,
  timeoutMs = XG_PLAYBACK_SWITCH_TIMEOUT_MS,
): Promise<void> {
  if (typeof player.switchURL !== "function") {
    throw new Error("当前播放器不支持软切换");
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve(player.switchURL(url, xgPlaybackSwitchOptions(kind))),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("软切换等待媒体就绪超时")),
          Math.max(0, timeoutMs),
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export function getXgHlsCore(player: XgPlayerInstance): XgHlsCore | null {
  const plugin = player.getPlugin("HlsJsPlugin") as {
    hls?: { startLoad: (startPosition?: number) => void; playingDate?: Date | null } | null;
  } | null;
  if (!plugin) return null;

  // xgplayer 从 Player.start() 启动协议插件，且插件在 URL 变化时替换 hls.js 实例。
  // 始终经由插件读取，使恢复调用与时钟读取对两者都保持有效。
  return {
    startLoad: (startPosition?: number) => {
      plugin.hls?.startLoad(startPosition);
    },
    programDateMs: () => {
      const date = plugin.hls?.playingDate ?? null;
      const epoch = date instanceof Date ? date.getTime() : Number.NaN;
      return Number.isFinite(epoch) ? epoch : null;
    },
  };
}

export function xgPlayerErrorMessage(error: unknown, fallback = "播放失败"): string {
  if (!error || typeof error !== "object") return String(error || fallback);
  const value = error as {
    errorMessage?: unknown;
    message?: unknown;
    mediaError?: { message?: unknown };
    originError?: { message?: unknown };
  };
  const message =
    value.errorMessage ?? value.message ?? value.mediaError?.message ?? value.originError?.message;
  return typeof message === "string" && message.trim() ? message : fallback;
}

/**
 * Chromium 经多层上报 HLS/MSE 解码失败：原生媒体错误用 code 3，而 xgplayer 协议
 * 插件可能给出 code 5103 或只保留浏览器的 pipeline message。检查保持结构化，
 * 使 Twitch 能降级不兼容的渲染档，
 * 而不把网络失败当成编解码问题。
 */
export function isXgPlayerDecodeError(error: unknown): boolean {
  if (typeof error === "string") {
    return /chunk_demuxer_error_append_failed|pipeline_error_decode|media_err_decode|decod(?:e|ing|er)/i.test(
      error,
    );
  }
  if (!error || typeof error !== "object") return false;

  const value = error as {
    errorCode?: unknown;
    errorType?: unknown;
    errorMessage?: unknown;
    message?: unknown;
    mediaError?: { code?: unknown; message?: unknown } | null;
    originError?: { message?: unknown } | null;
  };
  const code = Number(value.errorCode);
  const mediaCode = Number(value.mediaError?.code);
  if (code === 5103 || mediaCode === 3) return true;

  const type = typeof value.errorType === "string" ? value.errorType.toLowerCase() : "";
  if (type === "decoder" || type === "decode") return true;

  return [
    value.errorMessage,
    value.message,
    value.mediaError?.message,
    value.originError?.message,
  ].some(
    (message) =>
      typeof message === "string" &&
      /chunk_demuxer_error_append_failed|pipeline_error_decode|media_err_decode|decod(?:e|ing|er)/i.test(
        message,
      ),
  );
}
