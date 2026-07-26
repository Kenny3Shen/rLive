export type PlayerUiMode = "windowed" | "fullscreen";

/** MSE / web player media lifecycle (failover hooks). */
export type PlayerEventKind = "playing" | "paused" | "idle" | "eof" | "error";

export type PlayerEvent = {
  epoch: number;
  generation: number;
  kind: PlayerEventKind;
  message?: string | null;
  /** Ask the controller to obtain a fresh, short-lived playback URL. */
  refreshPlayUrl?: boolean;
  /** Optional delay before refreshing a source that is temporarily unavailable. */
  retryAfterMs?: number;
};

/** Preferred starting clarity when a room opens (Simple Live qualityLevel). */
export type QualityLevel = "high" | "mid" | "low";
