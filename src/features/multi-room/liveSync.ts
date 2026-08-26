/**
 * Multi-view live clock alignment (director grid "直播时钟同步").
 *
 * Two deliberately different levels, because live streams do not all carry a
 * usable wall clock:
 *
 * - `manual`: every feed is held a user-chosen number of seconds behind its own
 *   live edge. No absolute clock is involved, so it works on every site.
 * - `auto`: feeds are pulled onto one shared wall-clock position. HLS gives an
 *   exact clock through `EXT-X-PROGRAM-DATE-TIME`; FLV/MPEG-TS only get an
 *   estimate from the proxy's first-media-byte epoch, which still carries the
 *   CDN edge burst. The estimate is comparable between feeds but not exact,
 *   which is why a per-feed trim always stays available.
 *
 * This module is intentionally pure: the controller samples the players, calls
 * `planLiveSync`, and applies the returned corrections. Frame-accurate sync is
 * explicitly out of scope — corrections stop inside a tolerance band.
 */

export const LIVE_SYNC_MODES = ["off", "manual", "auto"] as const;
export type LiveSyncMode = (typeof LIVE_SYNC_MODES)[number];

/** How a feed's media position is mapped onto wall-clock time. */
export type LiveSyncClockKind =
  /** `EXT-X-PROGRAM-DATE-TIME` from the HLS playlist. */
  | "program-date"
  /** Estimated from the proxy's first media byte epoch (FLV / MPEG-TS). */
  | "stream-anchor"
  /** No usable clock yet; the feed can only be held behind its own live edge. */
  | "none";

/** Seconds a feed is held behind its own live edge before any user offset. */
export const LIVE_SYNC_BASE_HOLD_SECONDS = 1.2;
/** Smallest distance to the live edge a correction may target. */
export const LIVE_SYNC_EDGE_MARGIN_SECONDS = 0.6;
/** Smallest distance to the start of the retained buffer a correction may target. */
export const LIVE_SYNC_BUFFER_MARGIN_SECONDS = 0.4;
/** User offset range, in seconds. Negative pulls a feed ahead of the group. */
export const LIVE_SYNC_OFFSET_MIN_SECONDS = -5;
export const LIVE_SYNC_OFFSET_MAX_SECONDS = 20;
export const LIVE_SYNC_OFFSET_STEP_SECONDS = 0.5;
/** Bounds for the shared target latency in `auto` mode. */
export const LIVE_SYNC_MIN_TARGET_LATENCY_SECONDS = 1;
export const LIVE_SYNC_MAX_TARGET_LATENCY_SECONDS = 40;
/** Errors below this are left alone; sync is not frame accurate by design. */
export const LIVE_SYNC_TOLERANCE_SECONDS = 0.35;
/** Above this the correction jumps instead of trimming the playback rate. */
export const LIVE_SYNC_SEEK_THRESHOLD_SECONDS = 1.5;
/** Rate trim applied to muted secondary feeds while they converge. */
export const LIVE_SYNC_RATE_TRIM = 0.03;
/** How fast the shared target may move towards a smaller latency, per tick. */
export const LIVE_SYNC_TARGET_RELEASE_SECONDS = 0.35;
/** Extra headroom kept above the slowest feed's reachable position. */
export const LIVE_SYNC_TARGET_MARGIN_SECONDS = 0.3;

export type LiveSyncSample = {
  key: string;
  /** The audible feed: it is the reference clock and never gets a rate trim. */
  main: boolean;
  /** Playing with at least one buffered range. */
  ready: boolean;
  mediaTime: number;
  bufferStart: number;
  /** Live edge on this feed's own media timeline. */
  bufferEnd: number;
  clockKind: LiveSyncClockKind;
  /** Epoch (ms) that corresponds to `mediaTime === 0`, when a clock exists. */
  epochAtMediaZeroMs: number | null;
  /** Per-feed user offset in seconds; positive delays this feed. */
  offsetSeconds: number;
  playbackRate: number;
};

export type LiveSyncAction =
  /** Nothing to do: inside tolerance, or no correction is possible. */
  | { kind: "hold"; rate: 1 }
  | { kind: "rate"; rate: number }
  | { kind: "seek"; mediaTime: number; rate: 1 };

export type LiveSyncFeedPlan = {
  key: string;
  action: LiveSyncAction;
  /** Signed seconds this feed is away from its target (positive = too late). */
  errorSeconds: number | null;
  /** Seconds behind the live edge after this plan is applied. */
  holdSeconds: number | null;
  clockKind: LiveSyncClockKind;
  /** The buffer could not reach the target position; the offset was clamped. */
  limited: boolean;
};

export type LiveSyncPlan = {
  /** Shared latency behind wall clock in `auto` mode, else null. */
  targetLatencySeconds: number | null;
  feeds: LiveSyncFeedPlan[];
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function normalizeLiveSyncMode(mode: unknown): LiveSyncMode {
  return LIVE_SYNC_MODES.includes(mode as LiveSyncMode) ? (mode as LiveSyncMode) : "off";
}

export function normalizeLiveSyncOffset(value: unknown): number {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return 0;
  const stepped =
    Math.round(seconds / LIVE_SYNC_OFFSET_STEP_SECONDS) * LIVE_SYNC_OFFSET_STEP_SECONDS;
  return clamp(stepped, LIVE_SYNC_OFFSET_MIN_SECONDS, LIVE_SYNC_OFFSET_MAX_SECONDS);
}

/** Wall-clock epoch (ms) of the frame a feed is currently showing. */
export function liveSyncEpochPositionMs(sample: LiveSyncSample): number | null {
  if (sample.clockKind === "none" || sample.epochAtMediaZeroMs == null) return null;
  return sample.epochAtMediaZeroMs + sample.mediaTime * 1_000;
}

/** Seconds a feed is behind wall clock, from its own clock mapping. */
export function liveSyncLatencySeconds(sample: LiveSyncSample, nowMs: number): number | null {
  const position = liveSyncEpochPositionMs(sample);
  if (position == null) return null;
  return (nowMs - position) / 1_000;
}

/**
 * Smallest latency a feed can actually play at: its live edge, kept a margin
 * away so the correction does not land on an unbuffered position.
 */
function reachableLatencySeconds(sample: LiveSyncSample, nowMs: number): number | null {
  const latency = liveSyncLatencySeconds(sample, nowMs);
  if (latency == null) return null;
  const edgeDistance = Math.max(0, sample.bufferEnd - sample.mediaTime);
  return latency - edgeDistance + LIVE_SYNC_EDGE_MARGIN_SECONDS;
}

/**
 * Shared latency all feeds are pulled to.
 *
 * The main feed sets it, because it is the only audible one and must never be
 * rate-trimmed: the target is the latency main has when it plays
 * `LIVE_SYNC_BASE_HOLD_SECONDS` behind its own live edge. That keeps the group
 * as live as the audible feed can be and, unlike following main's momentary
 * position, cannot drift further back with every rebuffer.
 *
 * A slower secondary feed can still force the group back, since delaying a feed
 * is always possible inside the retained buffer while catching up past a live
 * edge is not.
 */
export function liveSyncTargetLatencySeconds(
  samples: readonly LiveSyncSample[],
  nowMs: number,
  previousTargetSeconds: number | null,
): number | null {
  const ready = samples.filter((sample) => sample.ready);
  if (ready.length === 0) return null;
  const mainCandidate = ready
    .filter((sample) => sample.main)
    .map((sample) => {
      const latency = liveSyncLatencySeconds(sample, nowMs);
      if (latency == null) return null;
      const edgeDistance = Math.max(0, sample.bufferEnd - sample.mediaTime);
      return latency - edgeDistance + LIVE_SYNC_BASE_HOLD_SECONDS;
    })
    .find((latency): latency is number => latency != null);
  const floors = ready
    .map((sample) => {
      const reachable = reachableLatencySeconds(sample, nowMs);
      if (reachable == null) return null;
      // A feed asked to run ahead of the group needs the shared target to sit
      // that much further back before its own offset becomes reachable.
      return reachable - Math.min(0, sample.offsetSeconds) + LIVE_SYNC_TARGET_MARGIN_SECONDS;
    })
    .filter((latency): latency is number => latency != null);
  const candidates = [...(mainCandidate == null ? [] : [mainCandidate]), ...floors];
  if (candidates.length === 0) return null;

  const desired = clamp(
    Math.max(...candidates),
    LIVE_SYNC_MIN_TARGET_LATENCY_SECONDS,
    LIVE_SYNC_MAX_TARGET_LATENCY_SECONDS,
  );
  if (previousTargetSeconds == null || desired >= previousTargetSeconds) return desired;
  // Releasing latency slowly keeps one feed's rebuffer from dragging the whole
  // grid forward and back again.
  return Math.max(desired, previousTargetSeconds - LIVE_SYNC_TARGET_RELEASE_SECONDS);
}

function feedCorrection(
  sample: LiveSyncSample,
  targetMediaTime: number,
): { action: LiveSyncAction; errorSeconds: number; limited: boolean } {
  const lowerBound = sample.bufferStart + LIVE_SYNC_BUFFER_MARGIN_SECONDS;
  const upperBound = sample.bufferEnd - LIVE_SYNC_EDGE_MARGIN_SECONDS;
  const reachable =
    upperBound <= lowerBound
      ? clamp(sample.mediaTime, Math.min(lowerBound, upperBound), Math.max(lowerBound, upperBound))
      : clamp(targetMediaTime, lowerBound, upperBound);
  const limited = Math.abs(reachable - targetMediaTime) > LIVE_SYNC_TOLERANCE_SECONDS;
  // Positive error: the feed shows an older frame than it should.
  const errorSeconds = reachable - sample.mediaTime;

  const magnitude = Math.abs(errorSeconds);
  if (magnitude <= LIVE_SYNC_TOLERANCE_SECONDS) {
    return { action: { kind: "hold", rate: 1 }, errorSeconds, limited };
  }
  if (magnitude >= LIVE_SYNC_SEEK_THRESHOLD_SECONDS) {
    return { action: { kind: "seek", mediaTime: reachable, rate: 1 }, errorSeconds, limited };
  }
  // The audible feed must not have its pitch bent, so it only ever jumps — and
  // only once the error is large enough to be worth a visible cut.
  if (sample.main) return { action: { kind: "hold", rate: 1 }, errorSeconds, limited };
  const rate = errorSeconds > 0 ? 1 + LIVE_SYNC_RATE_TRIM : 1 - LIVE_SYNC_RATE_TRIM;
  return { action: { kind: "rate", rate }, errorSeconds, limited };
}

/**
 * Decide one correction per feed.
 *
 * `manual` holds each feed behind its own live edge; `auto` maps every feed
 * onto `targetLatencySeconds` using its clock, and falls back to the manual
 * rule for feeds that have no clock yet.
 */
export function planLiveSync(input: {
  mode: LiveSyncMode;
  samples: readonly LiveSyncSample[];
  nowMs: number;
  previousTargetSeconds: number | null;
}): LiveSyncPlan {
  const { mode, samples, nowMs, previousTargetSeconds } = input;
  if (mode === "off") {
    return {
      targetLatencySeconds: null,
      feeds: samples.map((sample) => ({
        key: sample.key,
        action: { kind: "hold", rate: 1 },
        errorSeconds: null,
        holdSeconds: null,
        clockKind: sample.clockKind,
        limited: false,
      })),
    };
  }

  const targetLatencySeconds =
    mode === "auto" ? liveSyncTargetLatencySeconds(samples, nowMs, previousTargetSeconds) : null;

  const feeds = samples.map<LiveSyncFeedPlan>((sample) => {
    if (!sample.ready) {
      return {
        key: sample.key,
        action: { kind: "hold", rate: 1 },
        errorSeconds: null,
        holdSeconds: null,
        clockKind: sample.clockKind,
        limited: false,
      };
    }

    const latency = mode === "auto" ? liveSyncLatencySeconds(sample, nowMs) : null;
    const targetMediaTime =
      targetLatencySeconds != null && latency != null
        ? sample.mediaTime + (latency - (targetLatencySeconds + sample.offsetSeconds))
        : // Without a clock, hold the feed behind its own live edge instead.
          sample.bufferEnd - (LIVE_SYNC_BASE_HOLD_SECONDS + Math.max(0, sample.offsetSeconds));
    const { action, errorSeconds, limited } = feedCorrection(sample, targetMediaTime);
    const resolvedMediaTime = action.kind === "seek" ? action.mediaTime : sample.mediaTime;
    return {
      key: sample.key,
      action,
      errorSeconds,
      holdSeconds: Math.max(0, sample.bufferEnd - resolvedMediaTime),
      clockKind: mode === "auto" && latency == null ? "none" : sample.clockKind,
      limited,
    };
  });

  return { targetLatencySeconds, feeds };
}

/**
 * Manual-mode offsets that put every feed on the slowest feed's wall clock.
 *
 * `manual` holds each feed behind its own live edge, so aligning means giving
 * the faster feeds exactly the extra delay their stream is ahead by. Auto mode
 * does this continuously; here it is a one-shot fill of the sliders the user can
 * still trim afterwards. Feeds without a clock keep their current offset.
 */
export function liveSyncManualAlignOffsets(
  samples: readonly LiveSyncSample[],
  nowMs: number,
): Record<string, number> {
  const edgeLatencies = new Map<string, number>();
  for (const sample of samples) {
    if (!sample.ready) continue;
    const latency = liveSyncLatencySeconds(sample, nowMs);
    if (latency == null) continue;
    edgeLatencies.set(sample.key, latency - Math.max(0, sample.bufferEnd - sample.mediaTime));
  }
  if (edgeLatencies.size === 0) return {};
  const slowest = Math.max(...edgeLatencies.values());
  const offsets: Record<string, number> = {};
  for (const [key, edgeLatency] of edgeLatencies) {
    offsets[key] = normalizeLiveSyncOffset(slowest - edgeLatency);
  }
  return offsets;
}
