export type PlaylistSource = {
  id: string;
  label: string;
  description: string;
  url: string;
};

// IPTV-org publishes its verified public-link catalogue to GitHub Pages on a
// daily workflow. These official scopes stay below the native 4,000-channel
// safety ceiling; the 13k+ global index would be silently truncated here.
export const builtInSources: readonly PlaylistSource[] = [
  {
    id: "chinese",
    label: "中文频道",
    description: "中文语言频道",
    url: "https://iptv-org.github.io/iptv/languages/zho.m3u",
  },
  {
    id: "mainland",
    label: "中国大陆",
    description: "中国大陆公开频道",
    url: "https://iptv-org.github.io/iptv/countries/cn.m3u",
  },
  {
    id: "east-asia",
    label: "东亚频道",
    description: "东亚地区公开频道",
    url: "https://iptv-org.github.io/iptv/regions/eas.m3u",
  },
  {
    id: "general",
    label: "综合频道",
    description: "全球综合类频道",
    url: "https://iptv-org.github.io/iptv/categories/general.m3u",
  },
];

export const DEFAULT_PLAYLIST_SOURCE = builtInSources[0];

export function isHttpUrl(value: string | null | undefined): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** Resolve a compact navigation reference into a safe playlist source. */
export function playlistSourceFromRoute(
  sourceId: string | null | undefined,
  customUrl: string | null | undefined,
): PlaylistSource {
  const builtIn = builtInSources.find((source) => source.id === sourceId);
  if (builtIn) return builtIn;
  if (sourceId === "custom" && isHttpUrl(customUrl)) {
    return {
      id: "custom",
      label: "自定义列表",
      description: "自定义 M3U 地址",
      url: customUrl.trim(),
    };
  }
  return DEFAULT_PLAYLIST_SOURCE;
}
