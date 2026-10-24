import type { HlsEngineConfig, HlsJsAdapter } from "@videojs/hlsjs-video";
import type { DashAdapter, DashEngineConfig } from "@videojs/dash-video";
import type Mpegts from "mpegts.js";
import { playbackProtocol } from "@/lib/playUrl";
import type { PlayUrl } from "@/shared/types/live";
import { waitForContinuousBuffer } from "./liveStartupBuffer";

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

export type VideoJsDashOptions = NonNullable<DashEngineConfig["dashJs"]>;
export type VideoJsDashBufferMode = "active" | "warm" | "paused";

/** 预热预算是缓冲目标，不裁切上游完整分片；paused 禁止新增调度。 */
export function videoJsDashBufferSettings(mode: VideoJsDashBufferMode): VideoJsDashOptions {
  const target = mode === "active" ? 18 : 2;
  return {
    streaming: {
      scheduling: { scheduleWhilePaused: mode !== "paused" },
      buffer: {
        bufferTimeDefault: target,
        bufferTimeAtTopQuality: mode === "active" ? 30 : target,
        bufferTimeAtTopQualityLongForm: mode === "active" ? 60 : target,
        bufferToKeep: mode === "active" ? 10 : 2,
      },
    },
  };
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
/**
 * mpegts.js 在直播网络层判定「上游提前结束且内部重连也失败」时的错误事实。
 *
 * 只认枚举值：`ErrorTypes.NETWORK_ERROR`（`"NetworkError"`）配
 * `ErrorDetails.NETWORK_UNRECOVERABLE_EARLY_EOF`（`"UnrecoverableEarlyEof"`）。
 * 直播下 io-controller 会先把 LoaderErrors 的 `EarlyEof` 归一成这个值再上报，
 * 因此不需要再接受前者。不按 message 里的英文文案猜，避免把普通网络异常
 * 误当成可续签的断流。
 */
export function isMpegtsEarlyEof(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { type, detail } = error as { type?: unknown; detail?: unknown };
  return type === "NetworkError" && detail === "UnrecoverableEarlyEof";
}

export type VideoJsTransportFailure = {
  /** `eof` 表示传输事实是上游断流，应走签名刷新预算而不是一次性失败。 */
  kind: "eof" | "error";
  message: string;
  decodeError: boolean;
};

/**
 * 把 mpegts 引擎错误映射成播放层传输事实。
 *
 * 只有 FLV 的早断流算 `eof`：它和正常结束一样可以通过重新取播放地址续上。
 * MPEG-TS 与 HLS 保持原有错误语义。解码失败单独标记，供恢复会话选择硬媒体
 * 重建而不是在同一媒体上重连。
 */
export function classifyTransportFailure(
  error: unknown,
  kind: VideoJsPlaybackKind,
): VideoJsTransportFailure {
  const message = videoJsPlayerErrorMessage(error);
  if (kind === "flv" && isMpegtsEarlyEof(error)) {
    return { kind: "eof", message, decodeError: false };
  }
  return { kind: "error", message, decodeError: isVideoJsDecodeError(error) };
}
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
  /** DASH 在首次调度前定位；使用 MPD 时间锚点，不等待 metadata 后再 seek。 */
  startTime?: number;
  hls?: VideoJsHlsOptions;
  dash?: VideoJsDashOptions;
  flv?: VideoJsMpegtsOptions;
  mpegts?: VideoJsMpegtsOptions;
};
type SwitchSourceOptions = {
  autoPlay?: boolean;
  /** 自动起播前等待连续可播缓冲；取消时拒绝，由调用方走既有恢复路径。 */
  minBufferedAheadSeconds?: number;
  canAutoPlay?: () => boolean;
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
  /** 已断开所有权、等待微任务销毁的失败传输。 */
  private retiringMpegts: Promise<void> | null = null;
  /** 仍待销毁的失败传输；`destroy()` 会同步清掉它们。 */
  private readonly retiringCores = new Set<Mpegts.Player>();
  /** 当前是否正运行在 mpegts 自己的事件栈里（此时不能同步销毁实例）。 */
  private mpegtsDispatching = false;
  private readonly events = new EventTarget();
  private readonly listeners = new Set<() => void>();
  private destroyed = false;
  /**
   * 当前媒体元素的首个错误。
   *
   * 媒体元素一旦报错，同一个元素就不能再承载新的传输：浏览器不会在 `load()`
   * 之外清除 `error`，而断开旧传输时调用 `load()` 又恰好会清掉它。把首个事实
   * 留在适配器上，后续的原地重连请求才能稳定地被拒绝并升级成硬重建。
   */
  private mediaElementFailure: unknown = null;
  private playRequested = false;
  private pendingSwitch: AbortController | null = null;
  private endedAt: number | null = null;
  /**
   * 本传输首个解码失败事实。
   *
   * 媒体元素上的 `MediaError` 会被随后的一次 `load()`（例如失败传输在
   * detach 时自己调用）清成 `null`，但同媒体上的软重连改变不了解码器的决定。
   * 因此这里留一份事实，供 `switchSource` 判断该走硬媒体重建。
   */
  private firstDecodeFailure: unknown = null;

  constructor(
    private readonly modules: VideoJsPlayerModules,
    private readonly options: PlayerOptions,
  ) {
    this.media = options.video;
    try {
      const onEnded = () => this.reportEnded();
      const onPlay = () => {
        this.endedAt = null;
      };
      const onSeeking = () => {
        // dash.js 补发结束时也会 seek 到终点；只有离开该位置才算取消结束。
        if (this.media.currentTime !== this.endedAt) this.endedAt = null;
      };
      this.media.addEventListener("ended", onEnded);
      this.media.addEventListener("play", onPlay);
      this.media.addEventListener("seeking", onSeeking);
      this.listeners.add(() => {
        this.media.removeEventListener("ended", onEnded);
        this.media.removeEventListener("play", onPlay);
        this.media.removeEventListener("seeking", onSeeking);
      });
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
        // dash.js 的终点兜底只触发 playbackEnded 并暂停，不保证原生 ended。
        // 多 Period 的中间结束交给引擎续播，只上报整部内容的结束。
        const onDashEnded = (event: { isLast: boolean }) => {
          if (event.isLast) this.reportEnded();
        };
        adapter.engine.on("playbackEnded", onDashEnded);
        this.listeners.add(() => adapter.engine.off("playbackEnded", onDashEnded));
        // dash.js 按 DASH MPD anchor（#t=秒）选择第一片，片段不发送到代理。
        // 等 loadedmetadata 再写 currentTime 会先取开头分片，再 abort 并重取 init。
        let src = options.url;
        const startTime = options.startTime;
        if (startTime !== undefined && Number.isFinite(startTime) && startTime > 0) {
          const hash = src.indexOf("#");
          const anchor = new URLSearchParams(hash < 0 ? "" : src.slice(hash + 1));
          anchor.set("t", String(startTime));
          src = `${hash < 0 ? src : src.slice(0, hash)}#${anchor}`;
        }
        adapter.source = { src, engine: { dashJs: options.dash } };
      } else {
        this.listenForMediaErrors(this.media, true);
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

  private listenForMediaErrors(target: EventTarget, mediaElement = false): void {
    const onError = (event: Event) => {
      const error: unknown =
        event instanceof ErrorEvent ? (event.error ?? this.media.error) : this.media.error;
      const reported = error ?? event;
      if (mediaElement) {
        // 媒体元素上的首个错误就是这一轮传输的最终事实；后续重复的 error 只会
        // 覆盖首错，不能再上报一次。
        if (this.mediaElementFailure !== null) return;
        this.mediaElementFailure = reported;
      }
      if (mediaElement && this.firstDecodeFailure === null && isVideoJsDecodeError(reported)) {
        this.firstDecodeFailure = reported;
        // 解码失败后旧传输再 append 只会继续报同一类错误。先断开所有权，把销毁
        // 排到微任务：这里仍在媒体事件栈里，不能同步拆掉正在处理事件的传输。
        const core = this.mpegts;
        if (core) {
          this.mpegts = null;
          this.retireMpegts(core);
        }
      }
      // Video.js HLS 的 MediaError.data 是完整 hls.js ErrorData，保留 fatal/type/response。
      if (error && typeof error === "object" && "data" in error && error.data) {
        this.reportError(error.data);
      } else {
        this.reportError(reported);
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

  /** 原生媒体与 DASH 引擎共用的结束状态，重播或离开终点后清除。 */
  get ended(): boolean {
    return this.endedAt !== null;
  }

  private reportEnded(): void {
    if (this.destroyed || this.ended) return;
    this.endedAt = this.media.currentTime;
    this.events.dispatchEvent(new Event("ended"));
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
      (type: string, detail: string, info: { msg?: string; code?: number } | undefined) => {
        // 旧实例在交出所有权后的迟到事件不能覆盖新传输或首个错误事实。
        if (this.mpegts !== core) return;
        // 先断开所有权，再排微任务销毁：这条回调正运行在 mpegts 自己的事件栈里，
        // 同步 destroy 会重入其卸载流程。
        this.mpegts = null;
        this.retireMpegts(core);
        this.mpegtsDispatching = true;
        try {
          // `info.code` 是 Loader / MSE 的错误码（如 HTTP 状态或 -1），不是
          // `MediaError.code`。放到顶层会被当成 HTMLMediaError 或 dash.js 错误码
          // 误分类，因此只保留在引擎专用字段里。
          this.reportError({
            type,
            detail,
            ...(typeof info?.code === "number" ? { engineCode: info.code } : {}),
            message: info?.msg || detail,
          });
        } finally {
          this.mpegtsDispatching = false;
        }
      },
    );
    core.on(library.Events.LOADING_COMPLETE, () => {
      if (this.destroyed || this.mpegts !== core) return;
      this.mpegtsDispatching = true;
      try {
        this.events.dispatchEvent(new Event("loading_complete"));
      } finally {
        this.mpegtsDispatching = false;
      }
    });
    core.attachMediaElement(this.media);
    core.load();
  }

  /**
   * 失败传输的销毁排队到微任务，并与更早的退休任务串行。
   *
   * `destroy()` 会 detach 媒体并调用 `load()`；如果它在新传输附着之后才执行，
   * 会把新 MSE 一并清掉，因此换源前要等这里释放完。
   */
  private retireMpegts(core: Mpegts.Player): void {
    this.retiringCores.add(core);
    const retirement: Promise<void> = (this.retiringMpegts ?? Promise.resolve())
      .then(() => {
        // `destroy()` 可能已经同步清掉这个实例。
        if (!this.retiringCores.delete(core)) return;
        try {
          core.destroy();
        } catch {
          /* 失败路径可能已经释放了内部状态。 */
        }
      })
      .then(() => {
        if (this.retiringMpegts === retirement) this.retiringMpegts = null;
      });
    this.retiringMpegts = retirement;
  }

  /**
   * 在 `destroy()` 里立即回收待销毁的失败传输。
   *
   * 正常路径把它们排到微任务；但调用方可能在 `destroy()` 之后立刻用同一个
   * `<video>` 构造新播放器，此时旧实例的 detach 会清掉新附着的 MSE。这里在
   * 安全时同步销毁，事件栈内则只能继续排队（那种情况下调用方也不该同步复用）。
   */
  private flushRetiringMpegts(): void {
    if (this.mpegtsDispatching) return;
    for (const core of this.retiringCores) {
      try {
        core.destroy();
      } catch {
        /* 失败路径可能已经释放了内部状态。 */
      }
    }
    this.retiringCores.clear();
  }

  private releaseMpegts(): void {
    const core = this.mpegts;
    this.mpegts = null;
    // destroy() 原生完成 unload/detach；先断开所有权，忽略旧实例的迟到事件。
    core?.destroy();
  }

  on(event: PlayerEvent, handler: EventHandler): () => void {
    if (this.destroyed) return () => {};
    const target =
      event === "error" || event === "loading_complete" || event === "ended"
        ? this.events
        : this.media;
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
   * 短视频的播放器槽位靠它换片 —— 一个槽位先是预热邻居，换片时被提为活动，
   * 另一个槽位再换到新的邻居。若每次都 `destroy` + 新建，那与「复用播放器」
   * 没有区别，预热省下的取流时间会重新花在引擎初始化上。
   *
   * 走 `DashAdapter` 的 `src` setter：它内部调用 dash.js 的 `attachSource`，
   * 而 dash.js 在已挂载时会先 reset 再重新加载 —— 正是我们想要的语义。
   * URL 未变时 setter 判断出 `src` 没变，不会重新 attach。
   */
  /** 上一次应用的预热闸门；`null` 表示这台播放器还没有被闸门控制过。 */
  private dashBufferMode: VideoJsDashBufferMode | null = null;

  /**
   * 只改公开 DASH 配置，不换源、不清掉已预热的媒体缓冲。
   *
   * **解除 `paused` 闸门时必须显式重启调度**（见下）。
   */
  setDashBufferMode(mode: VideoJsDashBufferMode): void {
    if (this.destroyed || !this.dash || this.dashBufferMode === mode) return;
    const resumed = this.dashBufferMode === "paused" && mode !== "paused";
    this.dashBufferMode = mode;
    this.dash.source = {
      ...this.dash.source,
      engine: { dashJs: videoJsDashBufferSettings(mode) },
    };
    // `scheduleWhilePaused: false` 不只是「暂停时不新增调度」：dash.js 在
    // `ScheduleController._schedule` 里据此清掉调度定时器并直接返回，而把该设置
    // 改回 true 只是改一个值 —— 那条定时器不会被重建。于是槽位在预热到 canplay
    // 后被 `paused` 闸停的分片调度再也不会恢复：媒体元素照常 `play()`、照常播完
    // 已缓冲的 2 秒，然后停在 `waiting` 上等一个永远不会发出的第二分片请求。
    //
    // dash.js 只在 `PLAYBACK_STARTED` 且 `scheduleWhilePaused` 为**假**时重启调度
    // （`_onPlaybackStarted`），这条路径恰好不在短视频的序列里：回升到 `active` 的
    // 那一刻媒体还在暂停中，`play()` 又必然在闸门解除之后，因此只能显式补一次。
    if (resumed) this.restartDashScheduling();
  }

  /**
   * 重新启动活跃流的逐轨调度定时器。
   *
   * 只在 `paused` → 非 `paused` 的那一次转换调用：dash.js 的
   * `startScheduleTimer` 会取消并重建自己的定时器，重复调用等于让 `_schedule`
   * 在分片请求在途时再跑一轮（`lastSegment` 已推进，会多取下一片）。
   *
   * 不改变清晰度，也不清掉已缓冲内容：dash.js 会跳过已完成的缓冲
   * （`getIsBufferingCompleted`），并只按当前缓冲水位决定是否取下一片。
   */
  private restartDashScheduling(): void {
    try {
      // `getStreamProcessors()` 是公开 API，但数组在流初始化过程中可能带空洞
      // （dash.js 自己遍历时也用 `for (… && streamProcessors[i]; …)`）：逐个跳过
      // 空位，别让一个未就绪的轨道挡住其余轨道的调度。
      const processors = this.dash?.engine.getActiveStream()?.getStreamProcessors() ?? [];
      for (const processor of processors) {
        processor?.getScheduleController()?.startScheduleTimer(0);
      }
    } catch {
      // 引擎尚未完成清单加载（`getActiveStream` 抛错或为空）时无调度可恢复：首次
      // 调度由 dash.js 自己在流初始化时启动，不需要这里介入。
    }
  }

  switchDashSource(url: string): void {
    if (this.destroyed || !this.dash || this.options.url === url) return;
    this.endedAt = null;
    this.dashBufferMode = null;
    this.options.url = url;
    // dash.js 的 `attachSource` 会同步重置旧流的播放控制器（含调度定时器），
    // 再为新清单重新初始化并自行启动调度；闸门状态因此必须一并作废，否则
    // `warm → paused → 换源` 这条路上一次转换会被误判成「解除闸门」。
    this.dash.src = url;
  }

  /**
   * 共用短视频缓冲门控：DASH 保留精确预算及调度恢复，原生只改 preload 提示。
   *
   * 原生 preload 由浏览器自行解释，不保证精确预热 2 秒或立即停止网络；切角色时
   * 绝不清 src 或调用 load，否则已经预热的缓冲会丢失。
   */
  setShortsBufferMode(mode: VideoJsDashBufferMode): void {
    if (this.destroyed) return;
    if (this.dash) {
      this.setDashBufferMode(mode);
    } else if (this.options.kind === "native") {
      this.media.preload = mode === "paused" ? "none" : "auto";
    }
  }

  /** 原生点播槽位换源：保留媒体与监听；同 URL 是空操作，不丢预热缓冲。 */
  switchNativeSource(url: string): void {
    if (this.destroyed || this.options.kind !== "native" || this.options.url === url) return;
    this.endedAt = null;
    this.options.url = url;
    // 新的 load() 会清掉媒体错误；首错事实也只属于上一段媒体，随之作废，
    // 否则同一个元素上的下一次真实失败会被静默吞掉。
    this.mediaElementFailure = null;
    this.firstDecodeFailure = null;
    this.media.src = url;
    this.media.load();
  }

  switchSource(
    url: string,
    kind: VideoJsPlaybackKind,
    timeoutMs = VIDEO_JS_PLAYBACK_SWITCH_TIMEOUT_MS,
    options: SwitchSourceOptions = {},
  ): Promise<void> {
    if (this.destroyed) return Promise.reject(new Error("播放器已销毁"));
    if (kind !== this.options.kind || (kind !== "hls" && kind !== "flv" && kind !== "mpegts")) {
      return Promise.reject(new Error("当前协议不支持软切换"));
    }
    // 媒体元素已经报过错（解码失败等）时，同一个元素上的原地重连只会把新传输
    // 挂回一个失效的 MSE。直接拒绝，让调用方走既有的硬回退新建元素与传输。
    // 首个解码事实优先于当前 `media.error`：失败传输 detach 时的 `load()` 可能
    // 已经把它清成 null，但解码器对同一媒体的决定没有改变。
    // HLS 的可恢复 `mediaError` 走 hls.js 自己的 `recoverMediaError()`，不经过
    // 这里；但元素确实已进入错误态时，续期也只能靠硬重建。
    const failedMedia = this.media.error ?? this.firstDecodeFailure ?? this.mediaElementFailure;
    if (failedMedia) return Promise.reject(failedMedia);
    this.pendingSwitch?.abort();
    this.endedAt = null;
    const controller = (this.pendingSwitch = new AbortController());
    const bufferAbort = new AbortController();
    // 续期重连只在原本正在播放时才自动起播：用户暂停着的画面不该被一次后台
    // 重连拉起来。普通换源保持既有语义（沿用当前播放意图）。
    const resumePlayback = options.autoPlay ?? true;
    const shouldAutoPlay = resumePlayback && (this.playRequested || !this.media.paused);
    const shouldPrimeStartupBuffer = shouldAutoPlay && (options.minBufferedAheadSeconds ?? 0) > 0;
    this.playRequested ||= resumePlayback && !this.media.paused;
    return new Promise<void>((resolve, reject) => {
      let started = false;
      let settled = false;
      let waitingForBuffer = false;
      let offReady = () => {};
      const onLoad = () => {
        started = true;
      };
      const onUserPlayWhileBuffering = () => {
        // 起播门闩期间应用不会调用 play；此时出现 play 只可能是用户手动起播。
        // 立即结束等待，避免门闩随后再调用一次 play 打断用户意图。
        if (waitingForBuffer) {
          finish();
        }
      };
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        offReady();
        offError();
        this.media.removeEventListener("loadstart", onLoad);
        this.media.removeEventListener("play", onUserPlayWhileBuffering);
        controller.signal.removeEventListener("abort", onAbort);
        bufferAbort.abort();
        if (this.pendingSwitch === controller) this.pendingSwitch = null;
        if (error !== undefined) reject(error);
        else resolve();
      };
      const onAbort = () => finish(new DOMException("播放源切换已取消", "AbortError"));
      const offError = this.on("error", (error) => finish(error));
      // 已有可播数据时不会再等一次 canplay；缓冲门闩必须立即开始。
      const maybeStartBuffering = () => {
        if (!started || this.media.readyState < 3 || waitingForBuffer) return;
        const minBufferedAheadSeconds = options.minBufferedAheadSeconds ?? 0;
        const startPlayback = (requirePaused = false) => {
          // `autoPlay: false` 是续期对用户暂停意图的显式覆盖，
          // 不能被此前残留的 `playRequested` 重新拉起。
          if (
            shouldAutoPlay &&
            (options.canAutoPlay?.() ?? true) &&
            (!requirePaused || this.media.paused)
          ) {
            void this.media.play().catch((error: unknown) => {
              if (!isInterruptedPlayRequest(error)) this.reportError(error);
            });
          }
          finish();
        };
        // HLS、其他平台或用户原本暂停时不改变既有同步 canplay 语义；
        // 只有确实要积累 Bilibili FLV 起播余量时才进入异步等待。
        if (!shouldPrimeStartupBuffer) {
          startPlayback();
          return;
        }
        waitingForBuffer = true;
        void waitForContinuousBuffer(
          this.media,
          minBufferedAheadSeconds,
          () =>
            !settled &&
            !this.destroyed &&
            this.pendingSwitch === controller &&
            shouldAutoPlay &&
            this.playRequested &&
            (options.canAutoPlay?.() ?? true),
          bufferAbort.signal,
        ).then((result) => {
          if (settled) return;
          if (result === "ready") {
            startPlayback(true);
            return;
          }
          if (result === "stopped") {
            // 用户暂停或手动起播已经表达了新的播放意图，不把它升级成硬重建。
            finish();
            return;
          }
          if (result === "cancelled") {
            finish(new DOMException("播放源切换已取消", "AbortError"));
            return;
          }
          finish(new Error(result === "ended" ? "软切换期间媒体已结束" : "软切换期间媒体发生错误"));
        });
      };
      offReady = this.on("canplay", maybeStartBuffering);
      this.media.addEventListener("loadstart", onLoad);
      this.media.addEventListener("play", onUserPlayWhileBuffering);
      controller.signal.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(
        () => finish(new Error("软切换等待媒体就绪超时")),
        Math.max(0, timeoutMs),
      );
      const startTransport = () => {
        if (this.hls) {
          this.hls.src = url;
        } else {
          this.releaseMpegts();
          this.createMpegts(url);
        }
      };
      try {
        // 失败的旧传输可能还排在微任务里销毁。等它 detach 完再附着新 MSE，
        // 否则它的 `load()` 会把刚挂上的新 MediaSource 一并清掉。
        const retiring = this.retiringMpegts;
        if (retiring) {
          void retiring.then(() => {
            // 等待期间可能被取消、被销毁，或已被下一次换源取代。
            if (settled || this.destroyed || this.pendingSwitch !== controller) return;
            try {
              startTransport();
            } catch (error) {
              finish(error);
            }
          });
        } else {
          startTransport();
        }
      } catch (error) {
        finish(error);
      }
      // 普通协议仍只由 canplay 结算；已有 MSE 缓冲的 Bilibili FLV 才需要
      // 立即检查门闩，否则会改变 HLS / MPEG-TS 原有的异步完成时机。
      if (shouldPrimeStartupBuffer) maybeStartBuffering();
    });
  }

  play(): Promise<void> {
    this.playRequested = true;
    return this.media.play();
  }

  /** 只登记待自动起播意图，不提前调用媒体播放；用户 pause() 会清除它。 */
  prepareAutoplay(): void {
    this.playRequested = true;
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
      this.flushRetiringMpegts();
    } finally {
      try {
        if (this.hls) {
          // 只销毁适配器，不再把 source 置空：source=null 会异步排队一次新的
          // load()，在 destroy() 后泄漏一个未挂载的 hls.js 实例。
          this.hls.destroy();
        }
        if (this.dash) {
          // DashAdapter 10.0.1 的 destroy 先 attachView(null)，dash.js 随后 reset
          // 已找不到原媒体，无法移除 PlaybackController 的 DOM 监听。复用 video
          // 时旧监听会读取已清空的 streamInfo.id。先在媒体仍绑定时同步清源，
          // 让引擎停止在途分片并解绑，再交给适配器完成销毁（HLS 不走此路径）。
          try {
            this.dash.source = null;
          } finally {
            this.dash.destroy();
          }
        }
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
  options: SwitchSourceOptions = {},
): Promise<void> {
  return player.switchSource(url, kind, timeoutMs, options);
}

export function prepareVideoJsAutoplay(player: VideoJsPlayerInstance): void {
  player.prepareAutoplay();
}

/**
 * 引擎错误载荷来自外部对象，结构不保证是树。三个解析函数统一按节点预算 + seen
 * 遍历，挡住自环、多对象环和超深链，避免递归不收敛。
 */
const VIDEO_JS_ERROR_MAX_NODES = 16;

type VideoJsErrorWalk = {
  readonly seen: Set<object>;
  remaining: number;
};

function videoJsErrorWalk(): VideoJsErrorWalk {
  return { seen: new Set(), remaining: VIDEO_JS_ERROR_MAX_NODES };
}

function videoJsErrorMessageWithin(
  error: unknown,
  fallback: string,
  walk: VideoJsErrorWalk,
): string {
  if (typeof error === "string") return error.trim() || fallback;
  if (!error || typeof error !== "object") return fallback;
  if (walk.remaining <= 0 || walk.seen.has(error)) return fallback;
  walk.remaining -= 1;
  walk.seen.add(error);
  if ("message" in error && typeof error.message === "string" && error.message.trim())
    return error.message;
  if ("error" in error && error.error !== error)
    return videoJsErrorMessageWithin(error.error, fallback, walk);
  if ("details" in error && typeof error.details === "string") return error.details || fallback;
  return fallback;
}

export function videoJsPlayerErrorMessage(error: unknown, fallback = "播放失败"): string {
  return videoJsErrorMessageWithin(error, fallback, videoJsErrorWalk());
}

export function isInterruptedPlayRequest(error: unknown): boolean {
  return !!error && typeof error === "object" && "name" in error && error.name === "AbortError";
}

/**
 * dash.js 在重试预算耗尽后上报的下载/解析类错误码。
 *
 * `downloadErrorToRequestTypeMap`（dash.js `DashHandler`）里 25/26/27/28 分别是
 * manifest / sidx / 内容分片 / init 段。分片与 sidx 的失败只影响当前这一段：
 * dash.js 上报后仍会继续调度（必要时换档），因此不能把播放层直接判死；manifest
 * 与 init 段失败则没有可播内容，仍按致命处理。其余可恢复项是时间同步、空请求、
 * 缓冲移除/数据更新与字幕解析。
 */
const RECOVERABLE_DASH_ERROR_CODES: ReadonlySet<number> = new Set([
  15, // SEGMENT_BASE_LOADER：sidx 段时间轴读取失败
  16, // TIME_SYNC_FAILED：时钟同步失败不影响媒体本身
  17, // FRAGMENT_LOADER_LOADING_FAILURE：单次分片请求失败
  18, // FRAGMENT_LOADER_NULL_REQUEST：请求被并发 seek/换档作废
  21, // REMOVE：从 SourceBuffer 移除数据失败
  22, // DATA_UPDATE_FAILED
  26, // DOWNLOAD_ERROR_ID_SIDX
  27, // DOWNLOAD_ERROR_ID_CONTENT
  33, // TIMED_TEXT_ERROR_ID_PARSE：只影响字幕轨
]);

/**
 * 引擎错误是否意味着「当前媒体已经不能继续」。
 *
 * 播放页与短视频都把引擎 `error` 事件转成用户可见的失败卡片。dash.js 的分片下载
 * 错误在内部重试耗尽后仍会上报，但它随后会继续调度、换档，画面可能一直没有中断；
 * 把这类事件当作致命错误，就会出现「正在播放却弹出无法获取视频」的错位。这里只
 * 负责任务分类，不代替现有的卡顿恢复看门狗 —— 真正停住的播放仍会由 `waiting`
 * 判定升级成可见错误。
 *
 * 结构识别而不是匹配错误文案：dash.js 的 `DashJSError` 有数值 `code`，hls.js 的
 * `ErrorData` 有布尔 `fatal`，原生 `MediaError` 的 `code` 是 1~4（全部致命）。
 */
export type VideoJsPlaybackErrorSeverity = "fatal" | "recoverable";

export function videoJsPlaybackErrorSeverity(error: unknown): VideoJsPlaybackErrorSeverity {
  return videoJsPlaybackErrorSeverityWithin(error, videoJsErrorWalk());
}

function videoJsPlaybackErrorSeverityWithin(
  error: unknown,
  walk: VideoJsErrorWalk,
): VideoJsPlaybackErrorSeverity {
  if (!error || typeof error !== "object") return "fatal";
  if (walk.remaining <= 0 || walk.seen.has(error)) return "fatal";
  walk.remaining -= 1;
  walk.seen.add(error);
  const candidate = error as {
    code?: unknown;
    fatal?: unknown;
    error?: unknown;
  };
  if (typeof candidate.fatal === "boolean") return candidate.fatal ? "fatal" : "recoverable";
  if (typeof candidate.code === "number") {
    return RECOVERABLE_DASH_ERROR_CODES.has(candidate.code) ? "recoverable" : "fatal";
  }
  if (candidate.error) {
    return videoJsPlaybackErrorSeverityWithin(candidate.error, walk);
  }
  return "fatal";
}

/**
 * 可恢复错误的一句话说明。
 *
 * 只给用户「发生了什么、播放器正在做什么」，不铺原始 code 与堆栈 —— 那些在错误卡
 * 的技术详情里才有位置。区分分片与字幕两类，是因为字幕失败不该暗示画面有问题。
 */
export function videoJsRecoverableErrorMessage(error: unknown): string {
  const code =
    error && typeof error === "object" && typeof (error as { code?: unknown }).code === "number"
      ? (error as { code: number }).code
      : null;
  if (code === 33) return "字幕轨加载失败，画面不受影响。";
  return "部分分片加载失败，播放器正在自动重试。若画面长时间不动，可点重试。";
}

/** 识别原生解码失败；hls.js mediaError 也包含可恢复的缓冲问题，不能一概当成解码失败。 */
export function isVideoJsDecodeError(error: unknown): boolean {
  return videoJsDecodeErrorWithin(error, videoJsErrorWalk());
}

function videoJsDecodeErrorWithin(error: unknown, walk: VideoJsErrorWalk): boolean {
  if (typeof error === "string") {
    return /chunk_demuxer_error_append_failed|pipeline_error_decode|media_err_decode|decod(?:e|ing|er)/i.test(
      error,
    );
  }
  if (!error || typeof error !== "object") return false;
  if (walk.remaining <= 0 || walk.seen.has(error)) return false;
  walk.remaining -= 1;
  walk.seen.add(error);
  if ("code" in error && error.code === 3) return true;
  if ("message" in error && videoJsDecodeErrorWithin(error.message, walk)) return true;
  return "error" in error && videoJsDecodeErrorWithin(error.error, walk);
}
