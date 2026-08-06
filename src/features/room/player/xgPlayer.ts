import type { IPlayerOptions } from "xgplayer";

export type XgPlaybackKind = "flv" | "hls" | "mpegts" | "native";

export type XgPlayerInstance = {
  media: HTMLMediaElement;
  play: () => Promise<void> | null;
  pause: () => void;
  switchURL?: (
    url: string | object,
    options?: { seamless?: boolean; startTime?: number; bitrate?: number },
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
  replay: (isPlayEmit?: boolean) => Promise<void>;
};

let coreModulePromise: Promise<typeof import("xgplayer")> | null = null;
let flvModulePromise: Promise<typeof import("xgplayer-flv")> | null = null;
let hlsModulePromise: Promise<typeof import("xgplayer-hls")> | null = null;
let mpegtsModulePromise: Promise<typeof import("xgplayer-mpegts.js")> | null = null;

function loadCoreModule(): Promise<typeof import("xgplayer")> {
  if (!coreModulePromise) coreModulePromise = import("xgplayer");
  return coreModulePromise;
}

/** Lazy-load only the protocol plugin required by the selected live source. */
export async function loadXgPlayerModules(kind: XgPlaybackKind): Promise<XgPlayerModules> {
  const corePromise = loadCoreModule();
  if (kind === "flv") {
    if (!flvModulePromise) flvModulePromise = import("xgplayer-flv");
    const [core, { default: plugin }] = await Promise.all([corePromise, flvModulePromise]);
    return {
      Player: core.SimplePlayer as unknown as XgPlayerConstructor,
      plugin: plugin as unknown as XgStreamingPlugin,
    };
  }
  if (kind === "hls") {
    if (!hlsModulePromise) hlsModulePromise = import("xgplayer-hls");
    const [core, { default: plugin }] = await Promise.all([corePromise, hlsModulePromise]);
    return {
      Player: core.SimplePlayer as unknown as XgPlayerConstructor,
      plugin: plugin as unknown as XgStreamingPlugin,
    };
  }
  if (kind === "mpegts") {
    if (!mpegtsModulePromise) mpegtsModulePromise = import("xgplayer-mpegts.js");
    const [core, { default: plugin }] = await Promise.all([corePromise, mpegtsModulePromise]);
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
  const nativeHlsSupported = Boolean(video.canPlayType("application/vnd.apple.mpegurl"));

  if ((kind === "flv" || kind === "mpegts") && !pluginSupported) {
    throw new Error("当前环境不支持 MSE 直播播放");
  }
  if (kind === "hls" && !pluginSupported && !nativeHlsSupported) {
    throw new Error("当前环境不支持 HLS 直播播放");
  }

  const plugins = modules.plugin && pluginSupported ? [modules.plugin] : [];
  const playerOptions: IPlayerOptions = {
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

  if (kind === "flv") playerOptions.flv = flv ?? {};
  if (kind === "hls") playerOptions.hls = hls ?? {};
  if (kind === "mpegts") playerOptions.MpegtsPlugin = mpegts ?? {};

  return new modules.Player(playerOptions);
}

export function getXgHlsCore(player: XgPlayerInstance): XgHlsCore | null {
  const plugin = player.getPlugin("hls") as {
    core?: XgHlsCore | null;
    hls?: XgHlsCore | null;
  } | null;
  return plugin?.core ?? plugin?.hls ?? null;
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
 * Chromium reports HLS/MSE decoder failures through several layers: the
 * native media error uses code 3, while xgplayer-hls may surface code 5103 or
 * only preserve the browser's pipeline message. Keep the check structural so
 * Twitch can lower an incompatible rendition without treating a network
 * failure as a codec problem.
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
  ].some((message) =>
    typeof message === "string" &&
    /chunk_demuxer_error_append_failed|pipeline_error_decode|media_err_decode|decod(?:e|ing|er)/i.test(
      message,
    ),
  );
}
