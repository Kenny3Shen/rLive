import { useEffect } from "react";
import { probeIptvAvailability } from "./availabilityProbe";
import type { PlaylistSource } from "./playlistSource";
import type { IptvChannel } from "./types";

/**
 * 会话内已经预热过的来源。
 *
 * 预热原本挂在应用启动上（延迟 700ms）：不看 IPTV 的用户也会为默认来源取一次
 * 播放列表并浅探测最多 120 个频道。现在改为**首次进入 IPTV 时**执行，每个应用
 * 会话对每个来源只跑一次；离开再返回不重复。用户主动「更新」来源只清空既有
 * 检测结果，不会自动重跑预热。
 */
const entryProbedSourceUrls = new Set<string>();

export function shouldRunIptvEntryProbe(
  probedSourceUrls: ReadonlySet<string>,
  sourceUrl: string,
  active: boolean,
  channelCount: number,
): boolean {
  return active && channelCount > 0 && !probedSourceUrls.has(sourceUrl);
}

/** 仅测试使用：清空会话级预热记忆。 */
export function resetIptvEntryProbeMemory(): void {
  entryProbedSourceUrls.clear();
}

/**
 * 首次进入 IPTV 发现页时，为当前来源做一次静默的浅探测预热。
 *
 * 只探测当前来源：切换来源是用户显式动作，不在这里替他产生额外流量；
 * 预热失败也不提示，来源暂时不可用时页面本身仍可手动重试。
 */
export function useIptvEntryProbe(
  source: PlaylistSource,
  active: boolean,
  channels: readonly IptvChannel[],
): void {
  useEffect(() => {
    if (!shouldRunIptvEntryProbe(entryProbedSourceUrls, source.url, active, channels.length)) {
      return;
    }
    // 先记账再发起，确保重新渲染或重复挂载不会叠加第二次探测。
    entryProbedSourceUrls.add(source.url);
    void probeIptvAvailability(channels, { sourceUrl: source.url, notify: false }).catch(
      () => undefined,
    );
  }, [active, channels, source.url]);
}
