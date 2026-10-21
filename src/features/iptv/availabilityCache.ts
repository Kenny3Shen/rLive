import { browserStorage, type StorageLike } from "@/shared/browserStorage";
import type { IptvAvailabilityState } from "./availability";

export const IPTV_AVAILABILITY_CACHE_KEY = "rlive:iptv-availability:v1";
export type IptvAvailabilityCache = ReadonlyMap<string, ReadonlyMap<string, IptvAvailabilityState>>;

function isCachedState(value: unknown): value is IptvAvailabilityState {
  if (!value || typeof value !== "object") return false;
  const state = value as Record<string, unknown>;
  return (
    (state.status === "available" || state.status === "unavailable") &&
    (state.latencyMs === null ||
      (typeof state.latencyMs === "number" &&
        Number.isFinite(state.latencyMs) &&
        state.latencyMs >= 0)) &&
    (state.httpStatus === null ||
      (typeof state.httpStatus === "number" && Number.isInteger(state.httpStatus))) &&
    (state.message === null || typeof state.message === "string") &&
    typeof state.checkedAt === "number" &&
    Number.isFinite(state.checkedAt) &&
    state.checkedAt >= 0
  );
}

/** 本机缓存不是实时事实；过期结果仍复用，只有用户检测或实际播放反馈才修正。 */
export function readIptvAvailabilityCache(
  storage: StorageLike | null = browserStorage(),
): IptvAvailabilityCache {
  const cache = new Map<string, ReadonlyMap<string, IptvAvailabilityState>>();
  try {
    const raw: unknown = JSON.parse(storage?.getItem(IPTV_AVAILABILITY_CACHE_KEY) ?? "null");
    if (!Array.isArray(raw)) return cache;
    for (const source of raw) {
      if (!Array.isArray(source) || typeof source[0] !== "string" || !Array.isArray(source[1]))
        continue;
      const entries = new Map<string, IptvAvailabilityState>();
      for (const entry of source[1]) {
        if (Array.isArray(entry) && typeof entry[0] === "string" && isCachedState(entry[1])) {
          entries.set(entry[0], entry[1]);
        }
      }
      cache.set(source[0], entries);
    }
  } catch {
    // 损坏或不可访问的存储视作无缓存，不影响浏览与播放。
  }
  return cache;
}

export function writeIptvAvailabilityCache(
  cache: IptvAvailabilityCache,
  storage: StorageLike | null = browserStorage(),
): void {
  try {
    storage?.setItem(
      IPTV_AVAILABILITY_CACHE_KEY,
      JSON.stringify(
        [...cache].map(([sourceUrl, entries]) => [
          sourceUrl,
          [...entries].filter(([, state]) => state.status !== "checking"),
        ]),
      ),
    );
  } catch {
    // 隐私限制或配额不足时降级为会话缓存。
  }
}
