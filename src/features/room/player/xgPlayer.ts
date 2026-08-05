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
