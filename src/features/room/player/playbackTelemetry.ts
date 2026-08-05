import type { PlaybackTelemetrySnapshot, StreamProxyTelemetry } from "@/shared/types/player";

type TelemetryVideo = Pick<
  HTMLVideoElement,
  "buffered" | "currentTime" | "seekable" | "videoHeight" | "videoWidth"
> & {
  getVideoPlaybackQuality?: () => {
    totalVideoFrames: number;
    droppedVideoFrames: number;
  };
};

export type PlaybackTelemetrySession = {
  sessionId: string;
  startedAtEpochMs: number;
  startedAtMonotonicMs: number;
  siteId: string | null;
  sourceId: string;
  protocol: string;
  quality: string | null;
  switchMode: "hard" | "soft";
  firstPlayingAtMs: number | null;
  bufferingStartedAtMs: number | null;
  waitingCount: number;
  stalledCount: number;
  rebufferMs: number;
  longTaskCount: number;
  longTaskMs: number;
};

const MAX_TELEMETRY_SNAPSHOTS = 120;
const snapshots: PlaybackTelemetrySnapshot[] = [];

function finiteNonNegative(value: number): number | null {
  return Number.isFinite(value) ? Math.max(0, value) : null;
}

function timeRangeTail(range: TimeRanges, currentTime: number): number | null {
  if (range.length <= 0) return null;
  try {
    return finiteNonNegative(range.end(range.length - 1) - currentTime);
  } catch {
    return null;
  }
}

export function createPlaybackTelemetrySession(input: {
  sessionId: string;
  startedAtEpochMs?: number;
  startedAtMonotonicMs?: number;
  siteId?: string | null;
  sourceId: string;
  protocol: string;
  quality?: string | null;
  switchMode: "hard" | "soft";
}): PlaybackTelemetrySession {
  return {
    sessionId: input.sessionId,
    startedAtEpochMs: input.startedAtEpochMs ?? Date.now(),
    startedAtMonotonicMs: input.startedAtMonotonicMs ?? performance.now(),
    siteId: input.siteId ?? null,
    sourceId: input.sourceId,
    protocol: input.protocol,
    quality: input.quality?.trim() || null,
    switchMode: input.switchMode,
    firstPlayingAtMs: null,
    bufferingStartedAtMs: null,
    waitingCount: 0,
    stalledCount: 0,
    rebufferMs: 0,
    longTaskCount: 0,
    longTaskMs: 0,
  };
}

export function markTelemetryPlaying(session: PlaybackTelemetrySession, nowMs: number): void {
  session.firstPlayingAtMs ??= nowMs;
  if (session.bufferingStartedAtMs != null) {
    session.rebufferMs += Math.max(0, nowMs - session.bufferingStartedAtMs);
    session.bufferingStartedAtMs = null;
  }
}

export function markTelemetryWaiting(session: PlaybackTelemetrySession, nowMs: number): void {
  session.waitingCount += 1;
  session.bufferingStartedAtMs ??= nowMs;
}

export function markTelemetryStalled(session: PlaybackTelemetrySession, nowMs: number): void {
  session.stalledCount += 1;
  session.bufferingStartedAtMs ??= nowMs;
}

export function markTelemetryLongTask(session: PlaybackTelemetrySession, durationMs: number): void {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return;
  session.longTaskCount += 1;
  session.longTaskMs += durationMs;
}

export function samplePlaybackTelemetry(input: {
  session: PlaybackTelemetrySession;
  video: TelemetryVideo;
  proxy: StreamProxyTelemetry | null;
  nowEpochMs?: number;
  nowMonotonicMs?: number;
}): PlaybackTelemetrySnapshot {
  const { session, video } = input;
  const nowMonotonicMs = input.nowMonotonicMs ?? performance.now();
  const quality = video.getVideoPlaybackQuality?.();
  const seekableTail = timeRangeTail(video.seekable, video.currentTime);
  const snapshot: PlaybackTelemetrySnapshot = {
    session_id: session.sessionId,
    sampled_at_ms: input.nowEpochMs ?? Date.now(),
    site_id: session.siteId,
    source_id: session.sourceId,
    protocol: session.protocol,
    quality: session.quality,
    switch_mode: session.switchMode,
    startup_ms:
      session.firstPlayingAtMs == null
        ? null
        : Math.max(0, session.firstPlayingAtMs - session.startedAtMonotonicMs),
    playing_ms:
      session.firstPlayingAtMs == null ? 0 : Math.max(0, nowMonotonicMs - session.firstPlayingAtMs),
    waiting_count: session.waitingCount,
    stalled_count: session.stalledCount,
    rebuffer_ms:
      session.rebufferMs +
      (session.bufferingStartedAtMs == null
        ? 0
        : Math.max(0, nowMonotonicMs - session.bufferingStartedAtMs)),
    buffered_seconds: timeRangeTail(video.buffered, video.currentTime),
    live_latency_seconds: seekableTail,
    total_video_frames: quality ? finiteNonNegative(quality.totalVideoFrames) : null,
    dropped_video_frames: quality ? finiteNonNegative(quality.droppedVideoFrames) : null,
    video_width: Math.max(0, video.videoWidth),
    video_height: Math.max(0, video.videoHeight),
    long_task_count: session.longTaskCount,
    long_task_ms: Math.max(0, Math.round(session.longTaskMs)),
    proxy: input.proxy,
  };
  snapshots.push(snapshot);
  if (snapshots.length > MAX_TELEMETRY_SNAPSHOTS) snapshots.shift();
  return snapshot;
}

/** Read-only diagnostic access for local developer tooling and future UI. */
export function playbackTelemetrySnapshots(): readonly PlaybackTelemetrySnapshot[] {
  return snapshots;
}

export function clearPlaybackTelemetrySnapshots(): void {
  snapshots.length = 0;
}
