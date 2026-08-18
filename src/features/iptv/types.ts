import type { PlaybackProtocol } from "@/shared/types/live";

/** Mirrors the Rust IPTV channel record returned from an M3U playlist. */
export type IptvChannel = {
  id: string;
  name: string;
  group: string;
  logo: string | null;
  url: string;
  /** Explicit native parser result; `unknown` means the source metadata is opaque. */
  protocol: PlaybackProtocol;
  headers: Record<string, string>;
};
