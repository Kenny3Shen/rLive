import { create } from "zustand";
import { iptvCheckIdentity, type IptvAvailabilityState } from "./availability";
import {
  readIptvAvailabilityCache,
  writeIptvAvailabilityCache,
  type IptvAvailabilityCache,
} from "./availabilityCache";
import type { IptvChannel } from "./types";

export type IptvAvailabilityProgress = {
  completed: number;
  total: number;
};

type AvailabilityEntry = { identity: string; state: IptvAvailabilityState };

type IptvAvailabilityStoreState = {
  /** 来源 URL → 完整播放配置身份 → 已完成结果；跨来源和应用重启复用。 */
  cacheBySource: IptvAvailabilityCache;
  /** 当前发现页来源的状态，包含不持久化的「检测中」。 */
  byIdentity: ReadonlyMap<string, IptvAvailabilityState>;
  progress: IptvAvailabilityProgress | null;
  lastCheckedAt: number | null;
  sourceUrl: string | null;
  setManyAvailability: (
    entries: readonly AvailabilityEntry[],
    sourceUrl: string,
    /** 批次只能替换它自己留下的标记，不能盖掉较新的播放反馈。 */
    expected?: IptvAvailabilityState,
  ) => void;
  setProgress: (progress: IptvAvailabilityProgress | null) => void;
  markChecked: (sourceUrl: string, at?: number) => void;
  revertChecking: (
    identities: readonly string[],
    previous: ReadonlyMap<string, IptvAvailabilityState>,
  ) => void;
  resetForSource: (sourceUrl: string) => void;
  /** 暂时连接、缓冲或暂停不修改结果；重连耗尽才记失败，恢复播放则修正。 */
  recordPlaybackStatus: (
    sourceUrl: string,
    channel: IptvChannel,
    status: string,
    error: string | null,
    at?: number,
  ) => void;
};

function cacheWithEntries(
  cache: IptvAvailabilityCache,
  sourceUrl: string,
  entries: ReadonlyMap<string, IptvAvailabilityState>,
): IptvAvailabilityCache {
  const next = new Map(cache);
  const completed = new Map(cache.get(sourceUrl));
  for (const [identity, state] of entries) {
    if (state.status !== "checking") completed.set(identity, state);
  }
  next.set(sourceUrl, completed);
  writeIptvAvailabilityCache(next);
  return next;
}

export const useIptvAvailabilityStore = create<IptvAvailabilityStoreState>((set) => ({
  cacheBySource: readIptvAvailabilityCache(),
  byIdentity: new Map(),
  progress: null,
  lastCheckedAt: null,
  sourceUrl: null,
  setManyAvailability: (entries, sourceUrl, expected) =>
    set((current) => {
      if (current.sourceUrl !== sourceUrl) return current;
      const next = new Map(current.byIdentity);
      const completed = new Map<string, IptvAvailabilityState>();
      for (const entry of entries) {
        if (expected && next.get(entry.identity) !== expected) continue;
        next.set(entry.identity, entry.state);
        if (entry.state.status !== "checking") completed.set(entry.identity, entry.state);
      }
      return {
        byIdentity: next,
        cacheBySource:
          completed.size > 0
            ? cacheWithEntries(current.cacheBySource, sourceUrl, completed)
            : current.cacheBySource,
      };
    }),
  setProgress: (progress) => set({ progress }),
  markChecked: (sourceUrl, at = Date.now()) =>
    set((current) => (current.sourceUrl === sourceUrl ? { lastCheckedAt: at } : current)),
  revertChecking: (identities, previous) =>
    set((current) => {
      const next = new Map(current.byIdentity);
      for (const identity of identities) {
        if (next.get(identity)?.status !== "checking") continue;
        const restored = previous.get(identity);
        if (restored) next.set(identity, restored);
        else next.delete(identity);
      }
      return { byIdentity: next, progress: null };
    }),
  resetForSource: (sourceUrl) =>
    set((current) =>
      current.sourceUrl === sourceUrl
        ? current
        : {
            byIdentity: current.cacheBySource.get(sourceUrl) ?? new Map(),
            progress: null,
            lastCheckedAt: null,
            sourceUrl,
          },
    ),
  recordPlaybackStatus: (sourceUrl, channel, status, error, at = Date.now()) =>
    set((current) => {
      if (status !== "error" && status !== "playing") return current;
      const identity = iptvCheckIdentity(channel);
      const previous = current.cacheBySource.get(sourceUrl)?.get(identity);
      if (
        status === "playing" &&
        previous?.status === "available" &&
        (current.sourceUrl !== sourceUrl || current.byIdentity.get(identity)?.status !== "checking")
      )
        return current;
      const state: IptvAvailabilityState = {
        status: status === "playing" ? "available" : "unavailable",
        latencyMs: null,
        httpStatus: null,
        message:
          status === "playing" ? "已实际播放" : error?.trim() || "频道播放失败，自动重连已耗尽",
        checkedAt: at,
      };
      const entries = new Map([[identity, state]]);
      return {
        cacheBySource: cacheWithEntries(current.cacheBySource, sourceUrl, entries),
        byIdentity:
          current.sourceUrl === sourceUrl
            ? new Map([...current.byIdentity, ...entries])
            : current.byIdentity,
      };
    }),
}));
