import { create } from "zustand";
import type { IptvAvailabilityState } from "./availability";

/**
 * 可看性结果在一次会话内的路由切换后仍然存活。IPTV 发现页负责实际探测
 * （它需要当前播放列表），但逐 URL 状态、进度和上次运行时间戳存放在这里，
 * 使离开 /iptv 再返回不会丢弃已完成的检测运行。
 *
 * 缓存刻意不持久化：流状态很快过期，
 * 绝不能跨应用重启被当成持久事实。
 */
export type IptvAvailabilityProgress = {
  completed: number;
  total: number;
};

type AvailabilityEntry = { url: string; state: IptvAvailabilityState };

type IptvAvailabilityStoreState = {
  /** 最近访问来源的 流 URL → 可看性状态 映射。 */
  byUrl: ReadonlyMap<string, IptvAvailabilityState>;
  progress: IptvAvailabilityProgress | null;
  /** 该来源最近一次成功运行完成的 Unix 毫秒时间。 */
  lastCheckedAt: number | null;
  /** 缓存的 byUrl/lastCheckedAt 所描述的来源 URL；不匹配则强制重置。 */
  sourceUrl: string | null;
  setAvailability: (url: string, state: IptvAvailabilityState) => void;
  setManyAvailability: (entries: readonly AvailabilityEntry[]) => void;
  setProgress: (progress: IptvAvailabilityProgress | null) => void;
  /** 记录给定来源的一次已完成运行；加守卫防止过期的调用方拨动时钟。 */
  markChecked: (sourceUrl: string, at?: number) => void;
  /** 失败的运行之后撤销"检测中"标记，恢复先前状态或丢弃未知 URL。 */
  revertChecking: (
    urls: readonly string[],
    previous: ReadonlyMap<string, IptvAvailabilityState>,
  ) => void;
  /** 一旦另一个来源成为活动来源，就重置缓存结果。 */
  resetForSource: (sourceUrl: string) => void;
  /** 用户显式刷新当前来源时丢弃其结果。 */
  clearForSource: (sourceUrl: string) => void;
};

export const useIptvAvailabilityStore = create<IptvAvailabilityStoreState>((set) => ({
  byUrl: new Map(),
  progress: null,
  lastCheckedAt: null,
  sourceUrl: null,
  setAvailability: (url, state) =>
    set((current) => {
      const next = new Map(current.byUrl);
      next.set(url, state);
      return { byUrl: next };
    }),
  setManyAvailability: (entries) =>
    set((current) => {
      const next = new Map(current.byUrl);
      for (const entry of entries) {
        next.set(entry.url, entry.state);
      }
      return { byUrl: next };
    }),
  setProgress: (progress) => set({ progress }),
  markChecked: (sourceUrl, at = Date.now()) =>
    set((current) => (current.sourceUrl === sourceUrl ? { lastCheckedAt: at } : current)),
  revertChecking: (urls, previous) =>
    set((current) => {
      const next = new Map(current.byUrl);
      for (const url of urls) {
        if (next.get(url)?.status !== "checking") continue;
        const restored = previous.get(url);
        if (restored) next.set(url, restored);
        else next.delete(url);
      }
      return { byUrl: next, progress: null };
    }),
  resetForSource: (sourceUrl) =>
    set((current) =>
      current.sourceUrl === sourceUrl
        ? current
        : { byUrl: new Map(), progress: null, lastCheckedAt: null, sourceUrl },
    ),
  clearForSource: (sourceUrl) =>
    set({ byUrl: new Map(), progress: null, lastCheckedAt: null, sourceUrl }),
}));
