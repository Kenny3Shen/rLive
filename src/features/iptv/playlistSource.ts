export type PlaylistSource = {
  id: string;
  label: string;
  description: string;
  url: string;
};

// IPTV-org 通过每日工作流把其审核过的公开链接目录发布到 GitHub Pages。
// 这些官方范围低于原生 4000 频道的安全上限；
// 13k+ 的全球索引在这里会被静默截断。
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

/**
 * 为设备本地的 IPTV 状态提供紧凑且确定的身份标识。原始 URL 可能包含私有主机名
 * 或带签名的 query 参数，因此调用方只在收藏和录制旁存储这个不透明指纹。
 */
export function iptvUrlFingerprint(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** 构建发现页与关注页共享的来源选项。 */
export function playlistSourcesForSettings(customUrl: string | null | undefined): PlaylistSource[] {
  const customSource = playlistSourceFromRoute("custom", customUrl);
  return customSource.id === "custom" ? [...builtInSources, customSource] : [...builtInSources];
}

/**
 * 让不同自定义播放列表的收藏相互隔离，同时不把私有 M3U 地址本身作为来源标识
 * 持久化。这个哈希只是一个确定性的本地命名空间；
 * 频道 URL 才是真正的身份。
 */
export function iptvFavoriteSourceId(source: PlaylistSource): string {
  if (source.id !== "custom") return source.id;
  return `custom:${iptvUrlFingerprint(source.url)}`;
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

/** 把紧凑的导航引用解析为安全的播放列表来源。 */
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
