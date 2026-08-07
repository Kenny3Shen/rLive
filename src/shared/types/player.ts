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
  /** The browser rejected the media because the selected rendition is not decodable. */
  decodeError?: boolean;
};

/** Preferred starting clarity when a room opens (Simple Live qualityLevel). */
export type QualityLevel = "high" | "mid" | "low";

export type StreamProxyTelemetry = {
  started_at_ms: number;
  upstream_requests: number;
  upstream_failures: number;
  bytes_forwarded: number;
  first_response_ms: number | null;
  latest_response_ms: number | null;
};

export type PlaybackTelemetrySnapshot = {
  session_id: string;
  sampled_at_ms: number;
  site_id: string | null;
  source_id: string;
  protocol: string;
  quality: string | null;
  switch_mode: "hard" | "soft";
  startup_ms: number | null;
  playing_ms: number;
  waiting_count: number;
  stalled_count: number;
  rebuffer_ms: number;
  buffered_seconds: number | null;
  live_latency_seconds: number | null;
  total_video_frames: number | null;
  dropped_video_frames: number | null;
  video_width: number;
  video_height: number;
  long_task_count: number;
  long_task_ms: number;
  proxy: StreamProxyTelemetry | null;
};
