import { useEffect } from "react";
import { iptvCheckIdentity, type IptvAvailabilityState } from "./availability";
import { probeIptvAvailability } from "./availabilityProbe";
import { useIptvAvailabilityStore } from "./availabilityStore";
import type { PlaylistSource } from "./playlistSource";
import type { IptvChannel } from "./types";

/** 已有结果（包括陈旧或不可用）不自动重测，只补没有缓存的播放配置。 */
export function getIptvEntryProbeChannels(
  channels: readonly IptvChannel[],
  availability: ReadonlyMap<string, IptvAvailabilityState>,
  active: boolean,
  checking = false,
): IptvChannel[] {
  if (!active || checking) return [];
  return channels.filter((channel) => !availability.has(iptvCheckIdentity(channel)));
}

/** 进入发现页或频道列表更新时补齐缺失缓存，仍保持每次最多 120 个的流量上限。 */
export function useIptvEntryProbe(
  source: PlaylistSource,
  active: boolean,
  channels: readonly IptvChannel[],
): void {
  useEffect(() => {
    const store = useIptvAvailabilityStore.getState();
    const missing = getIptvEntryProbeChannels(
      channels,
      store.cacheBySource.get(source.url) ?? new Map(),
      active,
      store.progress !== null,
    );
    if (missing.length === 0) return;
    void probeIptvAvailability(missing, { sourceUrl: source.url, notify: false }).catch(
      () => undefined,
    );
  }, [active, channels, source.url]);
}
