import type { PlaybackProtocol, PlayUrl } from "@/shared/types/live";

type PlaybackSourceLike = Pick<PlayUrl, "url" | "protocol" | "source_id" | "label" | "priority">;

export function playbackProtocol(
  source: string | Pick<PlayUrl, "url" | "protocol">,
): PlaybackProtocol {
  const url = typeof source === "string" ? source : source.url;
  const explicit = typeof source === "string" ? undefined : source.protocol;
  if (explicit && explicit !== "unknown") return explicit;
  if (/\.m3u8(?:[?#]|$)|(?:[/?&=_-])hls(?:[/?&=_-]|$)/i.test(url)) return "hls";
  if (/\.ts(?:[?#]|$)|(?:[?&](?:format|type)=mpegts(?:&|$))/i.test(url)) return "mpeg_ts";
  if (/\.(?:mp4|webm|m4v)(?:[?#]|$)/i.test(url)) return "native";
  return "flv";
}

export function playbackSourceId(source: PlaybackSourceLike, index: number): string {
  return source.source_id?.trim() || `source:${index + 1}`;
}

export function playbackSourcePriority(source: PlaybackSourceLike, index: number): number {
  return typeof source.priority === "number" && Number.isFinite(source.priority)
    ? Math.max(0, source.priority)
    : index;
}

export function playbackProtocolLabel(protocol: PlaybackProtocol): string {
  switch (protocol) {
    case "hls":
      return "HLS";
    case "mpeg_ts":
      return "MPEG-TS";
    case "native":
      return "原生";
    case "unknown":
      return "未知";
    default:
      return "FLV";
  }
}

/** Use stable, human-readable names rather than exposing CDN host names. */
export function lineName(source: string | PlaybackSourceLike, index: number): string {
  const suppliedLabel = typeof source === "string" ? "" : source.label?.trim();
  const displayLabel = suppliedLabel
    ?.replace(/\s*(?:[（(]\s*)?(?:flv|hls)(?:\s*[）)])?\s*$/i, "")
    .trim();
  return displayLabel || `线路${index + 1}`;
}

/** Diagnostic label with transport information for logs and technical views. */
export function lineLabel(source: string | PlaybackSourceLike, index: number): string {
  return `${lineName(source, index)}（${playbackProtocolLabel(playbackProtocol(source))}）`;
}

export function clampIndex(i: number, len: number): number {
  if (len <= 0) return 0;
  return Math.max(0, Math.min(i, len - 1));
}
