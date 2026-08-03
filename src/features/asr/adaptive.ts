export const ASR_MIN_SEGMENT_SECONDS = 1;
export const ASR_DEFAULT_SEGMENT_SECONDS = 6;
export const ASR_MAX_SEGMENT_SECONDS = 8;

const SEGMENT_STEP_SECONDS = 1;
const FAST_RTF = 0.55;
const SLOW_RTF = 0.95;
const FAST_STREAK_REQUIRED = 3;
const SLOW_STREAK_REQUIRED = 2;

export type AsrWindowObservation = {
  audioSeconds: number;
  processingMs: number;
  queueWaitMs: number;
  dropped: boolean;
};

export type AsrWindowDecision = {
  segmentSeconds: number;
  rtf: number | null;
  changed: boolean;
};

function clampSegmentSeconds(seconds: number): number {
  if (!Number.isFinite(seconds)) return ASR_DEFAULT_SEGMENT_SECONDS;
  return Math.min(ASR_MAX_SEGMENT_SECONDS, Math.max(ASR_MIN_SEGMENT_SECONDS, seconds));
}

/**
 * Keeps the decode interval short when the model has headroom, but increases
 * the window before the single-session queue starts dropping live audio.
 * Hysteresis is intentional: one noisy timing sample must not make the
 * capture cadence oscillate between adjacent window sizes.
 */
export class AdaptiveAsrWindow {
  private currentSeconds: number;
  private fastStreak = 0;
  private slowStreak = 0;

  constructor(initialSeconds = ASR_DEFAULT_SEGMENT_SECONDS) {
    this.currentSeconds = clampSegmentSeconds(initialSeconds);
  }

  get segmentSeconds(): number {
    return this.currentSeconds;
  }

  reset(initialSeconds = ASR_DEFAULT_SEGMENT_SECONDS): void {
    this.currentSeconds = clampSegmentSeconds(initialSeconds);
    this.fastStreak = 0;
    this.slowStreak = 0;
  }

  observe(observation: AsrWindowObservation): AsrWindowDecision {
    const audioSeconds = observation.audioSeconds;
    const processingMs = observation.processingMs;
    const rtf =
      Number.isFinite(audioSeconds) && audioSeconds > 0 && Number.isFinite(processingMs)
        ? Math.max(0, processingMs) / (audioSeconds * 1_000)
        : null;
    const overloaded =
      observation.dropped ||
      !Number.isFinite(observation.queueWaitMs) ||
      observation.queueWaitMs > Math.max(500, audioSeconds * 500) ||
      (rtf !== null && rtf >= SLOW_RTF);
    const hasHeadroom =
      !overloaded &&
      Number.isFinite(observation.queueWaitMs) &&
      observation.queueWaitMs <= 250 &&
      rtf !== null &&
      rtf <= FAST_RTF;

    if (overloaded) {
      this.slowStreak += 1;
      this.fastStreak = 0;
    } else if (hasHeadroom) {
      this.fastStreak += 1;
      this.slowStreak = 0;
    } else {
      this.fastStreak = 0;
      this.slowStreak = 0;
    }

    let changed = false;
    if (this.slowStreak >= SLOW_STREAK_REQUIRED && this.currentSeconds < ASR_MAX_SEGMENT_SECONDS) {
      this.currentSeconds = clampSegmentSeconds(this.currentSeconds + SEGMENT_STEP_SECONDS);
      this.slowStreak = 0;
      this.fastStreak = 0;
      changed = true;
    } else if (this.fastStreak >= FAST_STREAK_REQUIRED && this.currentSeconds > ASR_MIN_SEGMENT_SECONDS) {
      this.currentSeconds = clampSegmentSeconds(this.currentSeconds - SEGMENT_STEP_SECONDS);
      this.fastStreak = 0;
      this.slowStreak = 0;
      changed = true;
    }

    return { segmentSeconds: this.currentSeconds, rtf, changed };
  }
}
