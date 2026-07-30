/** Mirrors the Rust IPTV channel record returned from an M3U playlist. */
export type IptvChannel = {
  id: string;
  name: string;
  group: string;
  logo: string | null;
  url: string;
  headers: Record<string, string>;
};
