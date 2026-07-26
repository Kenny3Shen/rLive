import type { PlaylistSource } from "./playlistSource";

type IptvHomePathOptions = {
  source?: PlaylistSource;
  group?: string | null;
  query?: string | null;
};

type IptvPlayerPathOptions = {
  source: PlaylistSource;
  channelUrl: string;
  group?: string | null;
  query?: string | null;
};

function withValue(params: URLSearchParams, key: string, value: string | null | undefined) {
  const trimmed = value?.trim();
  if (trimmed) params.set(key, trimmed);
}

function withSource(params: URLSearchParams, source: PlaylistSource | undefined) {
  if (!source) return;
  params.set("source", source.id);
  // A custom address can contain a subscriber token. It is intentionally read
  // from device-local settings instead of being written into history or links.
}

/** Keep discovery selections in the URL so Back returns to the same list. */
export function iptvHomePath({ source, group, query }: IptvHomePathOptions = {}): string {
  const params = new URLSearchParams();
  withSource(params, source);
  if (group && group !== "all") withValue(params, "group", group);
  withValue(params, "q", query);
  const search = params.toString();
  return search ? `/iptv?${search}` : "/iptv";
}

/** A player route identifies both the playlist and its channel for reload-safe playback. */
export function iptvPlayerPath({
  source,
  channelUrl,
  group,
  query,
}: IptvPlayerPathOptions): string {
  const params = new URLSearchParams({ channel: channelUrl });
  withSource(params, source);
  if (group && group !== "all") withValue(params, "group", group);
  withValue(params, "q", query);
  return `/iptv/play?${params.toString()}`;
}

/** Only honour in-app IPTV discovery return paths from navigation state. */
export function iptvReturnPathFromState(state: unknown): string | null {
  if (!state || typeof state !== "object" || !("returnTo" in state)) return null;
  const value = state.returnTo;
  if (typeof value !== "string") return null;
  const pathname = value.split(/[?#]/, 1)[0];
  return pathname === "/iptv" ? value : null;
}
