export type PlayerUiMode = "windowed" | "fullscreen";

/** MSE / Web 播放器的媒体生命周期（故障切换钩子）。 */
export type PlayerEventKind = "playing" | "paused" | "idle" | "eof" | "error";
export type PlayerTransportProtocol = "flv" | "hls" | "mpegts" | "native";

export type PlayerEvent = {
  epoch: number;
  generation: number;
  kind: PlayerEventKind;
  message?: string | null;
  protocol?: PlayerTransportProtocol;
  /** 加载媒体元数据或分片时观察到的 HTTP 状态码。 */
  httpStatus?: number | null;
  /** 传输层已耗尽其协议专属的就地恢复手段。 */
  recoveryExhausted?: boolean;
  /** Twitch 返回了其临时的广告插播响应。 */
  commercialBreak?: boolean;
  /** 浏览器因所选渲染档无法解码而拒绝了媒体。 */
  decodeError?: boolean;
};

/** 打开房间时偏好的起始清晰度。 */
export type QualityLevel = "high" | "mid" | "low";

export type StreamProxyTelemetry = {
  started_at_ms: number;
  upstream_requests: number;
  upstream_failures: number;
  bytes_forwarded: number;
  first_response_ms: number | null;
  latest_response_ms: number | null;
  /**
   * 代理为本会话转发的第一个媒体字节的纪元。
   *
   * 用作不带节目时钟容器（FLV / MPEG-TS）的挂钟锚点。它包含 CDN 边缘突发，
   * 因此是可在多条流之间比较的估计值，而不是精确采集时刻。
   */
  first_media_at_ms: number | null;
};
