import type { PlaylistSource } from "./playlistSource";

type IptvHomePathOptions = {
  source?: PlaylistSource;
  group?: string | null;
  query?: string | null;
};

type IptvPlayerPathOptions = {
  source: PlaylistSource;
  channelUrl: string;
  favoriteSourceId?: string;
  group?: string | null;
  query?: string | null;
};

type DirectPlayerPathOptions = {
  directUrl: string;
};

function withValue(params: URLSearchParams, key: string, value: string | null | undefined) {
  const trimmed = value?.trim();
  if (trimmed) params.set(key, trimmed);
}

function withSource(params: URLSearchParams, source: PlaylistSource | undefined) {
  if (!source) return;
  params.set("source", source.id);
  // 自定义地址可能包含订阅 token。它刻意从设备本地设置读取，
  // 而不写入历史或链接。
}

/** 把发现页的选择保存在 URL 中，Back 即可回到同一列表。 */
export function iptvHomePath({ source, group, query }: IptvHomePathOptions = {}): string {
  const params = new URLSearchParams();
  withSource(params, source);
  if (group && group !== "all") withValue(params, "group", group);
  withValue(params, "q", query);
  const search = params.toString();
  return search ? `/iptv?${search}` : "/iptv";
}

/** 播放路由同时标识播放列表及其频道，实现可安全重载的播放。 */
export function iptvPlayerPath({
  source,
  channelUrl,
  favoriteSourceId,
  group,
  query,
}: IptvPlayerPathOptions): string {
  const params = new URLSearchParams({ channel: channelUrl });
  withSource(params, source);
  withValue(params, "favoriteSource", favoriteSourceId);
  if (group && group !== "all") withValue(params, "group", group);
  withValue(params, "q", query);
  return `/iptv/play?${params.toString()}`;
}

/** 在共享沉浸播放器中打开用户提供的媒体地址。 */
export function directPlayerPath({ directUrl }: DirectPlayerPathOptions): string {
  const params = new URLSearchParams();
  withValue(params, "direct", directUrl);
  return `/iptv/play?${params.toString()}`;
}

/** 仅接受受支持的本地入口页作为播放器返回目标。 */
export function iptvReturnPathFromState(state: unknown): string | null {
  if (!state || typeof state !== "object" || !("returnTo" in state)) return null;
  const value = state.returnTo;
  if (typeof value !== "string") return null;
  const pathname = value.split(/[?#]/, 1)[0];
  return pathname === "/iptv" || pathname === "/follow" || pathname === "/settings" ? value : null;
}
