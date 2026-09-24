import { create } from "zustand";
import type { IptvAvailabilityState } from "./availability";

/**
 * 可看性结果在一次会话内的路由切换后仍然存活。IPTV 发现页负责实际探测
 * （它需要当前播放列表），但逐条目状态、进度和上次运行时间戳存放在这里，
 * 使离开 /iptv 再返回不会丢弃已完成的检测运行。
 *
 * 键是**完整播放配置身份**（URL + 实际发送的 Referer/UA），不是裸 URL：
 * 同一 URL 配不同请求头在 IPTV 列表里很常见，按 URL 存会让一个条目的结论
 * 冒名顶替另一个条目。
 *
 * 缓存刻意不持久化：流状态很快过期，
 * 绝不能跨应用重启被当成持久事实。
 */
export type IptvAvailabilityProgress = {
  completed: number;
  total: number;
};

type AvailabilityEntry = { identity: string; state: IptvAvailabilityState };

type IptvAvailabilityStoreState = {
  /** 播放配置身份 → 可看性状态 映射。 */
  byIdentity: ReadonlyMap<string, IptvAvailabilityState>;
  progress: IptvAvailabilityProgress | null;
  /** 该来源最近一次成功运行完成的 Unix 毫秒时间。 */
  lastCheckedAt: number | null;
  /** 缓存的 byIdentity/lastCheckedAt 所描述的来源 URL；不匹配则强制重置。 */
  sourceUrl: string | null;
  setManyAvailability: (entries: readonly AvailabilityEntry[]) => void;
  setProgress: (progress: IptvAvailabilityProgress | null) => void;
  /** 记录给定来源的一次已完成运行；加守卫防止过期的调用方拨动时钟。 */
  markChecked: (sourceUrl: string, at?: number) => void;
  /** 失败的运行之后撤销"检测中"标记，恢复先前状态或丢弃未知身份。 */
  revertChecking: (
    identities: readonly string[],
    previous: ReadonlyMap<string, IptvAvailabilityState>,
  ) => void;
  /** 一旦另一个来源成为活动来源，就重置缓存结果。 */
  resetForSource: (sourceUrl: string) => void;
  /** 用户显式刷新当前来源时丢弃其结果。 */
  clearForSource: (sourceUrl: string) => void;
};

export const useIptvAvailabilityStore = create<IptvAvailabilityStoreState>((set) => ({
  byIdentity: new Map(),
  progress: null,
  lastCheckedAt: null,
  sourceUrl: null,
  setManyAvailability: (entries) =>
    set((current) => {
      const next = new Map(current.byIdentity);
      for (const entry of entries) {
        next.set(entry.identity, entry.state);
      }
      return { byIdentity: next };
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
        : { byIdentity: new Map(), progress: null, lastCheckedAt: null, sourceUrl },
    ),
  clearForSource: (sourceUrl) =>
    set({ byIdentity: new Map(), progress: null, lastCheckedAt: null, sourceUrl }),
}));
