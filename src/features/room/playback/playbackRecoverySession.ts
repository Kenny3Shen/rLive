import { clampIndex } from "@/lib/playUrl";
import type { LivePlayQuality, LiveRoomDetail, PlayUrl, SiteId } from "@/shared/types/live";
import type { PlayerEvent, QualityLevel } from "@/shared/types/player";
import { isVideoJsDecodeError } from "../player/videoJsPlayer";
import { nextFailoverAction } from "./failover";
import {
  playbackLinePreferenceRoomKey,
  readPlaybackLinePreference,
  rememberPlaybackLine,
  resolvePlaybackLineIndex,
  type PlaybackLinePreference,
} from "./linePreference";
import { pickDefaultQualityIndex } from "./quality";
import { canRenewPlaybackInPlace } from "./sourceIdentity";
import { nextRankedLineIndex } from "./sourceSelection";
import { errorText } from "@/shared/components/errorPresentation";

const MAX_PLAYBACK_METADATA_RENEWALS = 3;
const STABLE_PLAYBACK_RESET_MS = 30_000;
const DUPLICATE_FAILURE_WINDOW_MS = 750;
const TWITCH_COMMERCIAL_RETRY_DELAY_MS = 8_000;

type PlaybackFailureMarker = {
  epoch: number;
  generation: number;
  lineIndex: number;
  at: number;
};

export type PlaybackRecoverySnapshot = {
  qualities: LivePlayQuality[];
  qualityIndex: number;
  lines: PlayUrl[];
  lineIndex: number;
  playUrl: PlayUrl | null;
  loading: boolean;
  error: unknown;
  loadError: string | null;
  reloadToken: number;
  /**
   * 「同一来源需要重新打开传输」的递增信号，例如签名过期后重新取到同一地址。
   *
   * 与 `reloadToken` 的区别只在播放器如何处理：播放器优先在现有媒体元素与
   * 适配器上原地重连，只有原地重连失败才完整重建。语义 key 变化本身已经能
   * 触发软切换，这个信号只服务于 key 没变的续期。
   */
  renewToken: number;
};

export type PlaybackRecoveryMetadataInput = {
  siteId: SiteId;
  roomId: string | undefined;
  detail: LiveRoomDetail;
};

export type PlaybackRecoveryLinesInput = PlaybackRecoveryMetadataInput & {
  quality: LivePlayQuality;
};

export type PlaybackRecoveryMetadataAdapter = {
  fetchQualities(input: PlaybackRecoveryMetadataInput): Promise<LivePlayQuality[]>;
  fetchLines(input: PlaybackRecoveryLinesInput): Promise<PlayUrl[]>;
  cacheQualities(input: PlaybackRecoveryMetadataInput, qualities: LivePlayQuality[]): void;
  cacheLines(input: PlaybackRecoveryLinesInput, lines: PlayUrl[]): void;
};

export type PlaybackRecoveryClockAdapter = {
  now(): number;
  setTimer(callback: () => void, delayMs: number): unknown;
  clearTimer(handle: unknown): void;
};

export type PlaybackRecoveryPreferenceAdapter = {
  read(roomKey: string | null): PlaybackLinePreference | null;
  remember(roomKey: string | null, line: PlayUrl | undefined, index: number): void;
};

export type PlaybackRecoverySessionConfig = {
  siteId: SiteId | undefined;
  roomId: string | undefined;
  detail: LiveRoomDetail | undefined;
  refreshDetail?: () => Promise<LiveRoomDetail | undefined>;
  qualityLevel: QualityLevel;
  enabled: boolean;
};

export type PlaybackRecoverySessionAdapters = {
  metadata: PlaybackRecoveryMetadataAdapter;
  clock?: PlaybackRecoveryClockAdapter;
  preferences?: PlaybackRecoveryPreferenceAdapter;
};

export type PlaybackRecoverySession = {
  getSnapshot(): PlaybackRecoverySnapshot;
  subscribe(listener: () => void): () => void;
  updateConfig(config: PlaybackRecoverySessionConfig): void;
  setLoadError(message: string | null): void;
  selectQuality(index: number): void;
  selectLine(index: number): void;
  refresh(): void;
  acceptTransportFact(event: PlayerEvent): void;
  dispose(): void;
};

const DEFAULT_CLOCK: PlaybackRecoveryClockAdapter = {
  now: () => Date.now(),
  setTimer: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimer: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const DEFAULT_PREFERENCES: PlaybackRecoveryPreferenceAdapter = {
  read: (roomKey) => readPlaybackLinePreference(roomKey),
  remember: (roomKey, line, index) => rememberPlaybackLine(roomKey, line, index),
};

const EMPTY_SNAPSHOT: PlaybackRecoverySnapshot = {
  qualities: [],
  qualityIndex: 0,
  lines: [],
  lineIndex: 0,
  playUrl: null,
  loading: false,
  error: undefined,
  loadError: null,
  reloadToken: 0,
  renewToken: 0,
};

export function playbackWasStable(
  startedAt: number | null,
  failedAt: number,
  thresholdMs = STABLE_PLAYBACK_RESET_MS,
): boolean {
  return startedAt != null && failedAt >= startedAt && failedAt - startedAt >= thresholdMs;
}

export function isDuplicatePlaybackFailure(
  previous: PlaybackFailureMarker | null,
  event: Pick<PlayerEvent, "epoch" | "generation">,
  lineIndex: number,
  now: number,
  windowMs = DUPLICATE_FAILURE_WINDOW_MS,
): boolean {
  if (!previous) return false;
  const elapsed = now - previous.at;
  return (
    previous.epoch === event.epoch &&
    previous.generation === event.generation &&
    previous.lineIndex === lineIndex &&
    elapsed >= 0 &&
    elapsed < windowMs
  );
}

/** FLV 插件在报告失败前已在内部重试其网络请求。 */
export function playerRebuildRetryLimit(siteId: SiteId | undefined): number {
  return siteId === "douyu" || siteId === "huya" ? 1 : 2;
}

export function matchingQualityIndex(
  qualities: Pick<LivePlayQuality, "quality">[],
  preferredQuality: string | undefined,
  fallbackIndex: number,
): number {
  const matchingIndex = qualities.findIndex((quality) => quality.quality === preferredQuality);
  return matchingIndex >= 0 ? matchingIndex : clampIndex(fallbackIndex, qualities.length);
}

/** 当前档之后的下一个视频清晰度（跳过 Twitch 的 audio only 档）；没有更低档时为 `null`。 */
export function nextLowerVideoQualityIndex(
  qualities: Pick<LivePlayQuality, "quality">[],
  currentIndex: number,
): number | null {
  for (let index = Math.max(0, currentIndex) + 1; index < qualities.length; index += 1) {
    if (!/audio[ _-]?only/i.test(qualities[index]?.quality ?? "")) return index;
  }
  return null;
}

class PlaybackRecoverySessionImpl implements PlaybackRecoverySession {
  private snapshot: PlaybackRecoverySnapshot = EMPTY_SNAPSHOT;
  private config: PlaybackRecoverySessionConfig;
  private readonly metadata: PlaybackRecoveryMetadataAdapter;
  private readonly clock: PlaybackRecoveryClockAdapter;
  private readonly preferences: PlaybackRecoveryPreferenceAdapter;
  private readonly listeners = new Set<() => void>();
  private intentGeneration = 0;
  private started = false;
  private disposed = false;
  private retryCount = 0;
  private metadataRenewalCount = 0;
  private failoverTimer: unknown = null;
  private rankedLineIndices: number[] = [];
  private readonly exhaustedLineIndices = new Set<number>();
  private playingStartedAt: number | null = null;
  private lastFailure: PlaybackFailureMarker | null = null;
  private metadataRenewalInFlight = false;
  /**
   * 当前清晰度是否由用户手动选定。默认档（按「画质偏好」挑出来的）在线路与续签
   * 预算都耗尽时会自动降一档；用户亲手选的档位则照旧报错，不替用户改选择。
   */
  private qualityPinnedByUser = false;

  constructor(config: PlaybackRecoverySessionConfig, adapters: PlaybackRecoverySessionAdapters) {
    this.config = config;
    this.metadata = adapters.metadata;
    this.clock = adapters.clock ?? DEFAULT_CLOCK;
    this.preferences = adapters.preferences ?? DEFAULT_PREFERENCES;
    this.startIfReady();
  }

  readonly getSnapshot = (): PlaybackRecoverySnapshot => this.snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  updateConfig(config: PlaybackRecoverySessionConfig): void {
    if (this.disposed) return;
    this.config = config;
    this.startIfReady();
  }

  setLoadError(message: string | null): void {
    if (this.snapshot.loadError === message) return;
    this.publish({ loadError: message });
  }

  selectQuality(index: number): void {
    const qualityIndex = clampIndex(index, this.snapshot.qualities.length);
    const quality = this.snapshot.qualities[qualityIndex];
    const generation = this.beginUserIntent();
    this.qualityPinnedByUser = true;
    this.publish({
      qualityIndex,
      lines: [],
      lineIndex: 0,
      playUrl: null,
      loading: Boolean(quality),
      error: undefined,
      loadError: null,
    });
    if (quality) void this.loadLines(generation, quality, false);
  }

  selectLine(index: number): void {
    const generation = this.beginUserIntent();
    if (!this.isCurrent(generation)) return;
    const lineIndex = clampIndex(index, this.snapshot.lines.length);
    const playUrl = this.snapshot.lines[lineIndex] ?? null;
    this.publish({ lineIndex, playUrl, loadError: null });
    this.preferences.remember(this.linePreferenceRoomKey(), playUrl ?? undefined, lineIndex);
  }

  refresh(): void {
    const generation = this.beginUserIntent();
    this.metadataRenewalInFlight = true;
    this.publish({ loading: true, error: undefined, loadError: null });
    void this.refreshMetadata(generation, "播放地址刷新失败，请重试", "rebuild");
  }

  acceptTransportFact(event: PlayerEvent): void {
    if (this.disposed) return;
    if (event.kind === "playing") {
      if (this.playingStartedAt == null) this.playingStartedAt = this.clock.now();
      // 每次重连都会报告 playing；没有待清的错误时不再换快照，免得白提交一帧。
      if (this.snapshot.loadError !== null) this.publish({ loadError: null });
      return;
    }
    if (event.kind !== "error" && event.kind !== "eof") return;
    if (this.metadataRenewalInFlight) return;

    const failureAt = this.clock.now();
    const activeLineIndex = this.snapshot.lineIndex;
    if (isDuplicatePlaybackFailure(this.lastFailure, event, activeLineIndex, failureAt)) return;
    this.clearFailoverTimer();

    // 稳定播放后的第一次失败会清空预算，标记必须写在清空之后：它既记录这次失败，
    // 也要压掉紧随其后的同一条连接的重复事件，否则刚清零的重试预算会被重复事件白烧。
    if (playbackWasStable(this.playingStartedAt, failureAt)) this.resetRecoveryBudget();
    this.playingStartedAt = null;
    this.lastFailure = {
      epoch: event.epoch,
      generation: event.generation,
      lineIndex: activeLineIndex,
      at: failureAt,
    };

    const message = event.message?.trim() ?? "";
    const isDecodeError = event.decodeError === true || isVideoJsDecodeError(message);
    if (event.kind === "error" && this.config.siteId === "twitch" && isDecodeError) {
      if (this.stepDownQuality()) return;
      this.publish({ loadError: "当前 Twitch 清晰度无法解码，请手动选择较低画质" });
      return;
    }

    if (this.shouldRenewPlaybackMetadata(event)) {
      this.renewPlaybackMetadata(event);
      return;
    }

    this.applyFailover(message);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.invalidatePendingWork();
    this.listeners.clear();
  }

  private startIfReady(): void {
    if (
      this.started ||
      this.disposed ||
      !this.config.enabled ||
      !this.config.siteId ||
      !this.config.detail
    ) {
      return;
    }
    this.started = true;
    this.qualityPinnedByUser = false;
    const generation = this.invalidatePendingWork();
    this.resetRecoveryBudget();
    this.publish({ ...EMPTY_SNAPSHOT, loading: true });
    void this.loadInitialMetadata(generation);
  }

  private async loadInitialMetadata(generation: number): Promise<void> {
    const input = this.metadataInput();
    if (!input) return;
    try {
      const qualities = await this.metadata.fetchQualities(input);
      if (!this.isCurrent(generation)) return;
      this.metadata.cacheQualities(input, qualities);
      if (qualities.length === 0) {
        this.publish({ qualities, loading: false, error: undefined });
        return;
      }
      const qualityIndex = pickDefaultQualityIndex(qualities.length, this.config.qualityLevel);
      const quality = qualities[qualityIndex];
      this.publish({ qualities, qualityIndex, loading: true, error: undefined, loadError: null });
      await this.loadLines(generation, quality, true);
    } catch (error) {
      if (!this.isCurrent(generation)) return;
      this.publish({ loading: false, error });
    }
  }

  private async loadLines(
    generation: number,
    quality: LivePlayQuality,
    restorePreference: boolean,
  ): Promise<void> {
    const input = this.metadataInput();
    if (!input) return;
    const linesInput: PlaybackRecoveryLinesInput = { ...input, quality };
    try {
      const lines = await this.metadata.fetchLines(linesInput);
      if (!this.isCurrent(generation)) return;
      this.metadata.cacheLines(linesInput, lines);
      this.rankedLineIndices = lines.map((_, index) => index);
      this.exhaustedLineIndices.clear();
      const lineIndex = restorePreference
        ? resolvePlaybackLineIndex(lines, this.preferences.read(this.linePreferenceRoomKey()))
        : 0;
      const playUrl = lines[lineIndex] ?? null;
      this.publish({
        lines,
        lineIndex,
        playUrl,
        loading: false,
        error: playUrl ? undefined : this.noPlayUrlError(),
      });
    } catch (error) {
      if (!this.isCurrent(generation)) return;
      this.publish({ lines: [], lineIndex: 0, playUrl: null, loading: false, error });
    }
  }

  private async refreshMetadata(
    generation: number,
    fallbackMessage: string,
    mode: "rebuild" | "renew",
  ): Promise<void> {
    const currentInput = this.metadataInput();
    if (!currentInput) {
      this.finishMetadataFailure(generation, new Error("缺少播放元数据"), fallbackMessage);
      return;
    }
    const preferredQuality = this.snapshot.qualities[this.snapshot.qualityIndex]?.quality;
    const preferredSourceId = this.snapshot.playUrl?.source_id;
    const activePlayUrl = this.snapshot.playUrl;
    const fallbackLineIndex = this.snapshot.lineIndex;
    try {
      const refreshedDetail = (await this.config.refreshDetail?.()) ?? currentInput.detail;
      if (!this.isCurrent(generation)) return;
      const input = { ...currentInput, detail: refreshedDetail };
      const qualities = await this.metadata.fetchQualities(input);
      if (!this.isCurrent(generation)) return;
      if (qualities.length === 0) throw new Error("平台未返回可用清晰度");
      const qualityIndex = matchingQualityIndex(
        qualities,
        preferredQuality,
        this.snapshot.qualityIndex,
      );
      const quality = qualities[qualityIndex];
      const linesInput: PlaybackRecoveryLinesInput = { ...input, quality };
      const lines = await this.metadata.fetchLines(linesInput);
      if (!this.isCurrent(generation)) return;
      if (lines.length === 0) throw new Error("平台未返回可用播放地址");

      const matchingLineIndex = preferredSourceId
        ? lines.findIndex((line) => line.source_id === preferredSourceId)
        : -1;
      const lineIndex =
        matchingLineIndex >= 0 ? matchingLineIndex : clampIndex(fallbackLineIndex, lines.length);
      this.rankedLineIndices = lines.map((_, index) => index);
      this.exhaustedLineIndices.clear();
      this.metadata.cacheQualities(input, qualities);
      this.metadata.cacheLines(linesInput, lines);
      this.metadataRenewalInFlight = false;
      // 成功交接新元数据即意味着下一段传输要重新打开连接。旧传输的失败标记
      // 只描述上一段连接：同一 generation 下新连接常在 750 ms 内就早断，若沿用
      // 旧标记会被当成重复事件合并掉，播放器停在「无恢复」状态。预算
      // （`metadataRenewalCount`）属于本轮恢复尝试，不在这里重置。
      this.lastFailure = null;
      const nextPlayUrl = lines[lineIndex] ?? null;
      // 自动续期不拆媒体元素：同协议时由播放器原地重连；协议变化或原地连接
      // 不可用时，播放器再自行升级为完整重建。手动刷新语义要求一次全新的
      // MSE 会话，因此始终递增 `reloadToken`。
      const renewInPlace = mode === "renew" && canRenewPlaybackInPlace(activePlayUrl, nextPlayUrl);
      this.publish({
        qualities,
        qualityIndex,
        lines,
        lineIndex,
        playUrl: nextPlayUrl,
        loading: false,
        error: undefined,
        loadError: null,
        ...(renewInPlace
          ? { renewToken: this.snapshot.renewToken + 1 }
          : { reloadToken: this.snapshot.reloadToken + 1 }),
      });
    } catch (error) {
      this.finishMetadataFailure(generation, error, fallbackMessage);
    }
  }

  private renewPlaybackMetadata(event: PlayerEvent): void {
    if (this.metadataRenewalCount >= MAX_PLAYBACK_METADATA_RENEWALS) {
      if (this.stepDownDefaultQuality()) return;
      this.publish({ loadError: "播放地址多次更新失败，请点击刷新后重试" });
      return;
    }
    const renewalAttempt = ++this.metadataRenewalCount;
    const requestedDelay =
      this.config.siteId === "twitch" && event.commercialBreak
        ? TWITCH_COMMERCIAL_RETRY_DELAY_MS
        : 0;
    const delayMs = Math.max(requestedDelay, (renewalAttempt - 1) * 1_000);
    const generation = this.invalidatePendingWork();
    this.metadataRenewalInFlight = true;
    const renew = () => {
      this.failoverTimer = null;
      void this.refreshMetadata(generation, "播放地址更新失败，请点击刷新后重试", "renew");
    };
    if (delayMs > 0) this.failoverTimer = this.clock.setTimer(renew, delayMs);
    else renew();
  }

  /**
   * 传输事实能否靠重新取播放地址续上。
   *
   * FLV 的 `eof` 既包含正常结束，也包含 mpegts 的早断流（上游提前关闭且内部
   * 重连失败）：两者都只是「这条连接不再有数据」，因此尝试重新取一次播放地址。
   * 取回的地址通常带新签名，但平台也可能原样返回或取不到地址，重新取元数据
   * 本身并不保证恢复；失败由续签预算与 `loadError` 兜底。MPEG-TS 与 HLS 维持
   * 原有错误语义，不做这类续签。
   */
  private shouldRenewPlaybackMetadata(event: PlayerEvent): boolean {
    if (event.recoveryExhausted) return true;
    if (event.kind === "eof" && event.protocol === "flv") return true;
    if (this.config.siteId !== "twitch" || event.protocol !== "hls") return false;
    return event.httpStatus === 401 || event.httpStatus === 403 || event.commercialBreak === true;
  }

  private applyFailover(message: string): void {
    const maxRetries = playerRebuildRetryLimit(this.config.siteId);
    let rankedReplacement: number | null | undefined;
    if (this.retryCount >= maxRetries) {
      this.exhaustedLineIndices.add(this.snapshot.lineIndex);
      rankedReplacement = nextRankedLineIndex({
        currentIndex: this.snapshot.lineIndex,
        rankedIndices: this.rankedLineIndices,
        exhaustedIndices: this.exhaustedLineIndices,
      });
    }
    const action = nextFailoverAction({
      retryCount: this.retryCount,
      lineIndex: this.snapshot.lineIndex,
      lineCount: this.snapshot.lines.length,
      maxRetries,
      nextLineIndex: rankedReplacement,
    });
    if (action.type === "fail") {
      if (this.stepDownDefaultQuality()) return;
      this.publish({ loadError: message || action.message });
      return;
    }

    const generation = this.intentGeneration;
    const apply = () => {
      this.failoverTimer = null;
      if (!this.isCurrent(generation)) return;
      this.retryCount = action.retryCount;
      this.playingStartedAt = null;
      if (action.type === "next_line") {
        this.publish({
          lineIndex: action.lineIndex,
          playUrl: this.snapshot.lines[action.lineIndex] ?? null,
        });
      } else {
        // 同一线路原地重试：地址没变，但传输已经失效，必须重新打开连接。
        // 播放器优先保留媒体元素与适配器；做不到时才自行完整重建。
        this.publish({ renewToken: this.snapshot.renewToken + 1 });
      }
    };
    if (action.delayMs > 0) this.failoverTimer = this.clock.setTimer(apply, action.delayMs);
    else apply();
  }

  /**
   * 换到下一个更低的视频清晰度并重新取线路，换档后恢复预算从零开始。
   * 已是最低档时返回 `false`，由调用方发布终止错误。
   */
  private stepDownQuality(): boolean {
    const fallbackQualityIndex = nextLowerVideoQualityIndex(
      this.snapshot.qualities,
      this.snapshot.qualityIndex,
    );
    if (fallbackQualityIndex == null) return false;
    const quality = this.snapshot.qualities[fallbackQualityIndex];
    const generation = this.invalidatePendingWork();
    this.resetRecoveryBudget();
    this.metadataRenewalInFlight = false;
    this.publish({
      qualityIndex: fallbackQualityIndex,
      lines: [],
      lineIndex: 0,
      playUrl: null,
      loading: true,
      error: undefined,
      loadError: null,
    });
    if (quality) void this.loadLines(generation, quality, false);
    return true;
  }

  /**
   * 默认档的线路与续签预算都耗尽时自动降一档。
   *
   * 平台会把匿名不可取的高档也列进清晰度表：虎牙赛事房的 4K 档六条线路实测全部
   * 403，或 302 到只发一小段数据就断开的占位流，而同房间的「超清」各线路正常出流。
   * 只在同一档里换线路和续签永远恢复不了，用户只会看到「播放地址多次更新失败」。
   * 用户手动选的档位不改，照旧报错。
   */
  private stepDownDefaultQuality(): boolean {
    if (this.qualityPinnedByUser) return false;
    return this.stepDownQuality();
  }

  private beginUserIntent(): number {
    const generation = this.invalidatePendingWork();
    this.resetRecoveryBudget();
    this.metadataRenewalInFlight = false;
    this.lastFailure = null;
    return generation;
  }

  private invalidatePendingWork(): number {
    this.clearFailoverTimer();
    this.intentGeneration += 1;
    return this.intentGeneration;
  }

  private resetRecoveryBudget(): void {
    this.retryCount = 0;
    this.metadataRenewalCount = 0;
    this.exhaustedLineIndices.clear();
    this.playingStartedAt = null;
    this.lastFailure = null;
  }

  private clearFailoverTimer(): void {
    if (this.failoverTimer == null) return;
    this.clock.clearTimer(this.failoverTimer);
    this.failoverTimer = null;
  }

  private finishMetadataFailure(generation: number, error: unknown, fallbackMessage: string): void {
    if (!this.isCurrent(generation)) return;
    this.metadataRenewalInFlight = false;
    this.publish({
      loading: false,
      loadError: errorText(error, fallbackMessage),
    });
  }

  private metadataInput(): PlaybackRecoveryMetadataInput | null {
    const { siteId, roomId, detail } = this.config;
    return siteId && detail ? { siteId, roomId, detail } : null;
  }

  private linePreferenceRoomKey(): string | null {
    return playbackLinePreferenceRoomKey(
      this.config.siteId,
      this.config.detail?.room_id ?? this.config.roomId,
    );
  }

  private noPlayUrlError(): unknown {
    return {
      code: "no_play_url",
      message: "当前清晰度没有可用播放地址",
      site: this.config.siteId ?? null,
      retryable: true,
    };
  }

  private isCurrent(generation: number): boolean {
    return !this.disposed && generation === this.intentGeneration;
  }

  private publish(next: Partial<PlaybackRecoverySnapshot>): void {
    if (this.disposed) return;
    this.snapshot = { ...this.snapshot, ...next };
    this.listeners.forEach((listener) => listener());
  }
}

export function createPlaybackRecoverySession(
  config: PlaybackRecoverySessionConfig,
  adapters: PlaybackRecoverySessionAdapters,
): PlaybackRecoverySession {
  return new PlaybackRecoverySessionImpl(config, adapters);
}
