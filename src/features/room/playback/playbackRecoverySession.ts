import { clampIndex } from "@/lib/playUrl";
import type { LivePlayQuality, LiveRoomDetail, PlayUrl, SiteId } from "@/shared/types/live";
import type { PlayerEvent, QualityLevel } from "@/shared/types/player";
import { isXgPlayerDecodeError } from "../player/xgPlayer";
import { nextFailoverAction } from "./failover";
import {
  playbackLinePreferenceRoomKey,
  readPlaybackLinePreference,
  rememberPlaybackLine,
  resolvePlaybackLineIndex,
  type PlaybackLinePreference,
} from "./linePreference";
import { pickDefaultQualityIndex } from "./quality";
import { nextRankedLineIndex } from "./sourceSelection";

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
};

function playbackErrorMessage(error: unknown, fallback: string): string {
  if (!error || typeof error !== "object" || !("message" in error)) return fallback;
  const message = String(error.message ?? "").trim();
  return message || fallback;
}

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

/** 浏览器解码失败后返回下一个 Twitch 视频渲染档。 */
export function nextTwitchDecodeQualityIndex(
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
    this.publish({ loadError: message });
  }

  selectQuality(index: number): void {
    const qualityIndex = clampIndex(index, this.snapshot.qualities.length);
    const quality = this.snapshot.qualities[qualityIndex];
    const generation = this.beginUserIntent();
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
    void this.refreshMetadata(generation, "播放地址刷新失败，请重试");
  }

  acceptTransportFact(event: PlayerEvent): void {
    if (this.disposed) return;
    if (event.kind === "playing") {
      if (this.playingStartedAt == null) this.playingStartedAt = this.clock.now();
      this.publish({ loadError: null });
      return;
    }
    if (event.kind !== "error" && event.kind !== "eof") return;
    if (this.metadataRenewalInFlight) return;

    const failureAt = this.clock.now();
    const activeLineIndex = this.snapshot.lineIndex;
    if (isDuplicatePlaybackFailure(this.lastFailure, event, activeLineIndex, failureAt)) return;
    this.lastFailure = {
      epoch: event.epoch,
      generation: event.generation,
      lineIndex: activeLineIndex,
      at: failureAt,
    };
    this.clearFailoverTimer();

    if (playbackWasStable(this.playingStartedAt, failureAt)) this.resetRecoveryBudget();
    this.playingStartedAt = null;

    const message = event.message?.trim() ?? "";
    const isDecodeError = event.decodeError === true || isXgPlayerDecodeError(message);
    if (event.kind === "error" && this.config.siteId === "twitch" && isDecodeError) {
      const fallbackQualityIndex = nextTwitchDecodeQualityIndex(
        this.snapshot.qualities,
        this.snapshot.qualityIndex,
      );
      if (fallbackQualityIndex != null) {
        const quality = this.snapshot.qualities[fallbackQualityIndex];
        const generation = this.invalidatePendingWork();
        this.resetRecoveryBudget();
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
        return;
      }
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

  private async refreshMetadata(generation: number, fallbackMessage: string): Promise<void> {
    const currentInput = this.metadataInput();
    if (!currentInput) {
      this.finishMetadataFailure(generation, new Error("缺少播放元数据"), fallbackMessage);
      return;
    }
    const preferredQuality = this.snapshot.qualities[this.snapshot.qualityIndex]?.quality;
    const preferredSourceId = this.snapshot.playUrl?.source_id;
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
      this.publish({
        qualities,
        qualityIndex,
        lines,
        lineIndex,
        playUrl: lines[lineIndex] ?? null,
        loading: false,
        error: undefined,
        loadError: null,
        reloadToken: this.snapshot.reloadToken + 1,
      });
    } catch (error) {
      this.finishMetadataFailure(generation, error, fallbackMessage);
    }
  }

  private renewPlaybackMetadata(event: PlayerEvent): void {
    if (this.metadataRenewalCount >= MAX_PLAYBACK_METADATA_RENEWALS) {
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
      void this.refreshMetadata(generation, "播放地址更新失败，请点击刷新后重试");
    };
    if (delayMs > 0) this.failoverTimer = this.clock.setTimer(renew, delayMs);
    else renew();
  }

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
        this.publish({ reloadToken: this.snapshot.reloadToken + 1 });
      }
    };
    if (action.delayMs > 0) this.failoverTimer = this.clock.setTimer(apply, action.delayMs);
    else apply();
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
      loadError: playbackErrorMessage(error, fallbackMessage),
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
