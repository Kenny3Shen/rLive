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

/** Build the source options shared by the IPTV discovery and follow pages. */
export function playlistSourcesForSettings(customUrl: string | null | undefined): PlaylistSource[] {
  const customSource = playlistSourceFromRoute("custom", customUrl);
  return customSource.id === "custom" ? [...builtInSources, customSource] : [...builtInSources];
}

/**
 * Keep favorites from different custom playlists separate without persisting
 * the private M3U address itself as a source identifier. This hash is only a
 * deterministic local namespace; channel URLs remain the actual identities.
 */
export function iptvFavoriteSourceId(source: PlaylistSource): string {
  if (source.id !== "custom") return source.id;
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.url.length; index += 1) {
    hash ^= source.url.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `custom:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function iptvFavoriteSourceIdFromRoute(value: string | null): string | null {
  const sourceId = value?.trim();
  return sourceId && sourceId.length <= 64 ? sourceId : null;
}

export function playlistSourceForFavorite(
  sourceId: string,
  customUrl: string | null | undefined,
): PlaylistSource {
  const builtIn = builtInSources.find((source) => source.id === sourceId);
  if (builtIn) return builtIn;

  const configuredCustom = playlistSourceFromRoute("custom", customUrl);
  if (configuredCustom.id === "custom" && iptvFavoriteSourceId(configuredCustom) === sourceId) {
    return configuredCustom;
  }

  return {
    id: "custom",
    label: sourceId.startsWith("custom:") ? "自定义列表" : "其他频道源",
    description: "已关注频道快照",
    url: "",
  };
}

export function iptvFavoriteSourceLabel(sourceId: string): string {
  return (
    builtInSources.find((source) => source.id === sourceId)?.label ??
    (sourceId.startsWith("custom:") ? "自定义列表" : "其他频道源")
  );
}

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
