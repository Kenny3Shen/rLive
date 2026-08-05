import type { PlaybackProtocol } from "@/shared/types/live";

/** Mirrors the Rust IPTV channel record returned from an M3U playlist. */
export type IptvChannel = {
  id: string;
  name: string;
  group: string;
  logo: string | null;
  url: string;
  /** Explicit native parser result; optional for cached data from older builds. */
  protocol?: PlaybackProtocol;
  headers: Record<string, string>;
};
