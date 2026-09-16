import type { HlsEngineConfig, HlsJsAdapter } from "@videojs/hlsjs-video";
import type { DashAdapter } from "@videojs/dash-video";
import type Mpegts from "mpegts.js";
import { playbackProtocol } from "@/lib/playUrl";
import type { PlayUrl } from "@/shared/types/live";

/** Video.js 官方 HLS/DASH 适配器；FLV/裸 TS 使用 mpegts.js，其他容器用原生媒体。 */
export type VideoJsPlaybackKind = "flv" | "hls" | "mpegts" | "native" | "dash";
export type VideoJsLivePlaybackKind = Exclude<VideoJsPlaybackKind, "dash">;

export function webPlaybackKind(
  source: Pick<PlayUrl, "url" | "protocol">,
): VideoJsLivePlaybackKind {
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

export type VideoJsHlsOptions = NonNullable<HlsEngineConfig["hlsJs"]>;
export type VideoJsMpegtsOptions = {
  mediaDataSource?: Partial<Mpegts.MediaDataSource>;
  mpegtsConfig?: Mpegts.Config;
};
export type VideoJsPlayerModules = {
  HlsJsAdapter?: typeof HlsJsAdapter;
  DashAdapter?: typeof DashAdapter;
  mpegts?: typeof Mpegts;
};
export type VideoJsPlayerInstance = VideoJsPlayer;
export type VideoJsHlsCore = {
  /** HLS 适配器可能选择浏览器原生 HLS；只有 MSE 路径才有 hls.js 恢复能力。 */
  isMse: () => boolean;
  startLoad: (position?: number) => void;
  recoverMediaError: () => void;
  programDateMs: () => number | null;
};
export type VideoJsMpegtsCore = {
  on: (event: "loading_complete", handler: () => void) => void;
  seek: (seconds: number) => boolean;
  /**
   * 这一路流能否随机访问。
   *
   * FLV 的 seek 靠 `onMetaData` 里的 `keyframes` 索引换算字节偏移；没有索引时
   * mpegts.js 会先 flush MediaSource、再在 `isSeekable()` 处早退，缓冲被清空且
   * 没有任何补偿——回放就此卡死。调用方必须在 seek 之前问过这里。
   *
   * `null` 表示 mediaInfo 尚未到达（无从判断），与「确认没有索引」区分开。
   */
  isSeekable: () => boolean | null;
};
type PlayerOptions = {
  video: HTMLVideoElement;
  url: string;
  kind: VideoJsPlaybackKind;
  isLive?: boolean;
  hls?: VideoJsHlsOptions;
  flv?: VideoJsMpegtsOptions;
  mpegts?: VideoJsMpegtsOptions;
};
type PlayerEvent = keyof HTMLMediaElementEventMap | "loading_complete";
type EventHandler = (event: unknown) => void;

/** import 自带模块缓存；原生媒体不加载任何流媒体内核。 */
export async function loadVideoJsModules(kind: VideoJsPlaybackKind): Promise<VideoJsPlayerModules> {
  if (kind === "hls") {
    const { HlsJsAdapter } = await import("@videojs/hlsjs-video");
    return { HlsJsAdapter };
  }
  if (kind === "dash") {
    const { DashAdapter } = await import("@videojs/dash-video");
    return { DashAdapter };
  }
  if (kind === "flv" || kind === "mpegts") {
    const { default: mpegts } = await import("mpegts.js");
    return { mpegts };
  }
  return {};
}

export const VIDEO_JS_PLAYBACK_SWITCH_TIMEOUT_MS = 12_000;

/** 只管理传输所有权，不接管 React DOM、控制层或浏览器媒体状态。 */
class VideoJsPlayer {
  readonly media: HTMLVideoElement;
  private hls: HlsJsAdapter | null = null;
  private dash: DashAdapter | null = null;
  private mpegts: Mpegts.Player | null = null;
  private readonly events = new EventTarget();
  private readonly listeners = new Set<() => void>();
  private destroyed = false;
  private playRequested = false;
  private pendingSwitch: AbortController | null = null;

  constructor(
    private readonly modules: VideoJsPlayerModules,
    private readonly options: PlayerOptions,
  ) {
    this.media = options.video;
    try {
      if (options.kind === "hls") {
        if (!modules.HlsJsAdapter) throw new Error("Video.js HLS 适配器尚未加载");
        const adapter = (this.hls = new modules.HlsJsAdapter());
        adapter.attach(this.media);
        adapter.preload = "auto";
        adapter.streamType = options.isLive === false ? "on-demand" : "live";
        this.listenForMediaErrors(adapter);
        // source setter 原生调度 load；再手动 load 会重复请求并打断首次播放。
        adapter.source = {
          src: options.url,
          type: "application/vnd.apple.mpegurl",
          engine: { hlsJs: options.hls },
        };
      } else if (options.kind === "dash") {
        if (!modules.DashAdapter) throw new Error("Video.js DASH 适配器尚未加载");
        const adapter = (this.dash = new modules.DashAdapter());
        adapter.attach(this.media);
        this.listenForMediaErrors(adapter);
        // DASH 协议错误不一定产生 HTMLMediaElement.error，使用公开 engine 事件。
        const onError = (event: { error: unknown }) => this.reportError(event.error);
        adapter.engine.on("error", onError);
        this.listeners.add(() => adapter.engine.off("error", onError));
        adapter.source = { src: options.url };
      } else {
        this.listenForMediaErrors(this.media);
        if (options.kind === "flv" || options.kind === "mpegts") {
          this.createMpegts(options.url);
        } else {
          this.media.src = options.url;
          this.media.load();
        }
      }
    } catch (error) {
      this.destroy();
      throw error;
    }
  }

  private listenForMediaErrors(target: EventTarget): void {
    const onError = (event: Event) => {
      const error: unknown =
        event instanceof ErrorEvent ? (event.error ?? this.media.error) : this.media.error;
      // Video.js HLS 的 MediaError.data 是完整 hls.js ErrorData，保留 fatal/type/response。
      if (error && typeof error === "object" && "data" in error && error.data) {
        this.reportError(error.data);
      } else {
        this.reportError(error ?? event);
      }
    };
    target.addEventListener("error", onError);
    this.listeners.add(() => target.removeEventListener("error", onError));
  }
  getHlsCore(): VideoJsHlsCore | null {
    if (!this.hls) return null;
    // HlsJsAdapter 异步选择 MSE 或浏览器原生 HLS；每次调用读取当前 engine，
    // 因此原生回退不会被误当成可以 recoverMediaError 的 hls.js 会话。
    return {
      isMse: () => this.hls?.engine != null,
      startLoad: (position) => this.hls?.engine?.startLoad(position),
      recoverMediaError: () => this.hls?.engine?.recoverMediaError(),
      programDateMs: () => {
        const time = this.hls?.engine?.playingDate?.getTime();
        return time !== undefined && Number.isFinite(time) ? time : null;
      },
    };
  }

  private reportError(error: unknown): void {
    if (!this.destroyed) this.events.dispatchEvent(new CustomEvent("error", { detail: error }));
  }

  private createMpegts(url: string): void {
    const library = this.modules.mpegts;
    if (!library) throw new Error("mpegts.js 尚未加载");
    if (!library.isSupported()) throw new Error("当前环境不支持 MSE 直播播放");
    const kind = this.options.kind;
    const settings = (kind === "flv" ? this.options.flv : this.options.mpegts) ?? {};
    const core = (this.mpegts = library.createPlayer(
      {
        ...settings.mediaDataSource,
        type: kind,
        isLive: this.options.isLive ?? true,
        url,
      },
      settings.mpegtsConfig,
    ));
    core.on(
      library.Events.ERROR,
      (type: string, detail: string, info: { msg?: string } | undefined) => {
        if (this.mpegts === core) this.reportError({ type, detail, message: info?.msg || detail });
      },
    );
    core.on(library.Events.LOADING_COMPLETE, () => {
      if (!this.destroyed && this.mpegts === core)
        this.events.dispatchEvent(new Event("loading_complete"));
    });
    core.attachMediaElement(this.media);
    core.load();
  }

  private releaseMpegts(): void {
    const core = this.mpegts;
    this.mpegts = null;
    // destroy() 原生完成 unload/detach；先断开所有权，忽略旧实例的迟到事件。
    core?.destroy();
  }

  on(event: PlayerEvent, handler: EventHandler): () => void {
    if (this.destroyed) return () => {};
    const target = event === "error" || event === "loading_complete" ? this.events : this.media;
    const callback = (value: Event) => handler(value instanceof CustomEvent ? value.detail : value);
    target.addEventListener(event, callback);
    const off = () => {
      target.removeEventListener(event, callback);
      this.listeners.delete(off);
    };
    this.listeners.add(off);
    return off;
  }

  getMpegtsCore(): VideoJsMpegtsCore | null {
    if (!this.mpegts) return null;
    return {
      on: (event, handler) => {
        this.on(event, handler);
      },
      seek: (seconds) => {
        if (!this.mpegts || !Number.isFinite(seconds)) return false;
        this.mpegts.currentTime = Math.max(0, seconds);
        return true;
      },
      isSeekable: () => {
        const info = this.mpegts?.mediaInfo as
          | { mimeType?: string; hasKeyframesIndex?: boolean | null }
          | undefined;
        // mimeType 是 mediaInfo 落定的标志；它还空着时索引缺失只是「还没到」。
        if (!info?.mimeType) return null;
        return info.hasKeyframesIndex === true;
      },
    };
  }

  /**
   * 换源（DASH）：复用已挂载的 dash.js 引擎，只换 MPD。
   *
   * 短视频的双播放器槽位靠它换片 —— 一个槽位先预热下一条，换片时把它提为活动，
   * 另一个槽位再换到新的邻居。若每次都 `destroy` + 新建，那与「复用播放器」
   * 没有区别，预热省下的取流时间会重新花在引擎初始化上。
   *
   * 走 `DashAdapter` 的 `src` setter：它内部调用 dash.js 的 `attachSource`，
   * 而 dash.js 在已挂载时会先 reset 再重新加载 —— 正是我们想要的语义。
   * URL 未变时 setter 判断出 `src` 没变，不会重新 attach。
   */
  switchDashSource(url: string): void {
    if (this.destroyed || !this.dash) return;
    this.options.url = url;
    this.dash.src = url;
  }

  switchSource(
    url: string,
    kind: VideoJsPlaybackKind,
    timeoutMs = VIDEO_JS_PLAYBACK_SWITCH_TIMEOUT_MS,
  ): Promise<void> {
    if (this.destroyed) return Promise.reject(new Error("播放器已销毁"));
    if (kind !== this.options.kind || (kind !== "hls" && kind !== "flv" && kind !== "mpegts")) {
      return Promise.reject(new Error("当前协议不支持软切换"));
    }
    this.pendingSwitch?.abort();
    const controller = (this.pendingSwitch = new AbortController());
    this.playRequested ||= !this.media.paused;
    return new Promise<void>((resolve, reject) => {
      let started = false;
      let settled = false;
      const onLoad = () => {
        started = true;
      };
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        offReady();
        offError();
        this.media.removeEventListener("loadstart", onLoad);
        controller.signal.removeEventListener("abort", onAbort);
        if (this.pendingSwitch === controller) this.pendingSwitch = null;
        if (error !== undefined) reject(error);
        else resolve();
      };
      const onAbort = () => finish(new DOMException("播放源切换已取消", "AbortError"));
      const offReady = this.on("canplay", () => {
        if (!started || this.media.readyState < 3) return;
        if (this.playRequested) {
          void this.media.play().catch((error: unknown) => {
            if (!isInterruptedPlayRequest(error)) this.reportError(error);
          });
        }
        finish();
      });
      const offError = this.on("error", (error) => finish(error));
      this.media.addEventListener("loadstart", onLoad);
      controller.signal.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(
        () => finish(new Error("软切换等待媒体就绪超时")),
        Math.max(0, timeoutMs),
      );
      try {
        if (this.hls) {
          this.hls.src = url;
        } else {
          this.releaseMpegts();
          this.createMpegts(url);
        }
      } catch (error) {
        finish(error);
      }
    });
  }

  play(): Promise<void> {
    this.playRequested = true;
    return this.media.play();
  }

  pause(): void {
    this.playRequested = false;
    this.media.pause();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.pendingSwitch?.abort();
    for (const off of this.listeners) off();
    this.listeners.clear();
    try {
      this.releaseMpegts();
    } finally {
      try {
        if (this.hls) {
          // 只销毁适配器，不再把 source 置空：source=null 会异步排队一次新的
          // load()，在 destroy() 后泄漏一个未挂载的 hls.js 实例。
          this.hls.destroy();
        }
        this.dash?.destroy();
      } finally {
        this.hls = null;
        this.dash = null;
        this.media.pause();
        this.media.removeAttribute("src");
        this.media.load();
      }
    }
  }
}

export function createVideoJsPlayer(
  modules: VideoJsPlayerModules,
  options: PlayerOptions,
): VideoJsPlayerInstance {
  return new VideoJsPlayer(modules, options);
}
export function getVideoJsMpegtsCore(player: VideoJsPlayerInstance): VideoJsMpegtsCore | null {
  return player.getMpegtsCore();
}
export function getVideoJsHlsCore(player: VideoJsPlayerInstance): VideoJsHlsCore | null {
  return player.getHlsCore();
}
export function switchVideoJsDashSource(player: VideoJsPlayerInstance, url: string): void {
  player.switchDashSource(url);
}

export function switchVideoJsPlaybackSource(
  player: VideoJsPlayerInstance,
  url: string,
  kind: VideoJsPlaybackKind,
  timeoutMs = VIDEO_JS_PLAYBACK_SWITCH_TIMEOUT_MS,
): Promise<void> {
  return player.switchSource(url, kind, timeoutMs);
}

export function videoJsPlayerErrorMessage(error: unknown, fallback = "播放失败"): string {
  if (typeof error === "string") return error.trim() || fallback;
  if (!error || typeof error !== "object") return fallback;
  if ("message" in error && typeof error.message === "string" && error.message.trim())
    return error.message;
  if ("error" in error && error.error !== error)
    return videoJsPlayerErrorMessage(error.error, fallback);
  if ("details" in error && typeof error.details === "string") return error.details || fallback;
  return fallback;
}

export function isInterruptedPlayRequest(error: unknown): boolean {
  return !!error && typeof error === "object" && "name" in error && error.name === "AbortError";
}

/** 识别原生解码失败；hls.js mediaError 也包含可恢复的缓冲问题，不能一概当成解码失败。 */
export function isVideoJsDecodeError(error: unknown): boolean {
  if (typeof error === "string") {
    return /chunk_demuxer_error_append_failed|pipeline_error_decode|media_err_decode|decod(?:e|ing|er)/i.test(
      error,
    );
  }
  if (!error || typeof error !== "object") return false;
  if ("code" in error && error.code === 3) return true;
  if ("message" in error && isVideoJsDecodeError(error.message)) return true;
  return "error" in error && error.error !== error && isVideoJsDecodeError(error.error);
}
