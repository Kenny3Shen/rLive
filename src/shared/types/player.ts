export type PlayerUiMode = "windowed" | "fullscreen";
/** Native embed strategy reported by Rust. */
export type EmbedMode = "in_process" | "child" | "geometry" | "window";

export type PlayerStatus = {
  running: boolean;
  mpv_path: string;
  paused: boolean;
  volume: number;
  embed_mode: EmbedMode;
  mode: PlayerUiMode;
  /** Engine id: `libmpv` (Windows default), `fake` (tests), etc. */
  engine?: string;
};

/** Simple Live–style media lifecycle events from the native engine. */
export type PlayerEventKind =
  | "playing"
  | "paused"
  | "idle"
  | "eof"
  | "error";

export type PlayerEvent = {
  /** Player lifecycle epoch that owned the media when the event was emitted. */
  epoch: number;
  /** Media open generation bound at activate time. */
  generation: number;
  kind: PlayerEventKind;
  message?: string | null;
};

/** Preferred starting clearity when a room opens (Simple Live qualityLevel). */
export type QualityLevel = "high" | "mid" | "low";
