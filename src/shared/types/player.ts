export type PlayerUiMode = "windowed" | "fullscreen";

/** MSE / web player media lifecycle (failover hooks). */
export type PlayerEventKind = "playing" | "paused" | "idle" | "eof" | "error";

export type PlayerEvent = {
  epoch: number;
  generation: number;
  kind: PlayerEventKind;
  message?: string | null;
};

/** Preferred starting clarity when a room opens (Simple Live qualityLevel). */
export type QualityLevel = "high" | "mid" | "low";
