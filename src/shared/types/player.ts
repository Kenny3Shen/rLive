export type PlayerUiMode = "windowed" | "fullscreen";

/** MSE / web player media lifecycle (failover hooks). */
export type PlayerEventKind = "playing" | "paused" | "idle" | "eof" | "error";
export type PlayerTransportProtocol = "flv" | "hls" | "mpegts" | "native";

export type PlayerEvent = {
  epoch: number;
  generation: number;
  kind: PlayerEventKind;
  message?: string | null;
  protocol?: PlayerTransportProtocol;
  /** HTTP status observed while loading media metadata or segments. */
  httpStatus?: number | null;
  /** The transport has exhausted its protocol-specific in-place recovery. */
  recoveryExhausted?: boolean;
  /** Twitch returned its temporary commercial-break response. */
  commercialBreak?: boolean;
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
  /**
   * Epoch of the first media byte the proxy forwarded for this session.
   *
   * Used as the wall-clock anchor for containers without a program clock
   * (FLV / MPEG-TS). It includes the CDN edge burst, so it is an estimate that
   * is comparable across feeds rather than an exact capture time.
   */
  first_media_at_ms: number | null;
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
