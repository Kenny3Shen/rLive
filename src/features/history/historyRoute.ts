import { enabledSiteIds, isSiteEnabled, isSiteId } from "@/shared/siteId";
import type { SiteId } from "@/shared/types/live";

export const HISTORY_PLATFORM_PARAM = "platform";

export type HistoryPlatformFilter = "all" | SiteId;

export function historyPlatformFromSearch(
  value: string | null | undefined,
  disabledSiteIds?: unknown,
): HistoryPlatformFilter {
  if (!value || value === "all") return "all";
  if (!isSiteId(value)) return "all";
  return disabledSiteIds === undefined || isSiteEnabled(value, disabledSiteIds) ? value : "all";
}

export function historyPlatformOptions(disabledSiteIds: unknown): HistoryPlatformFilter[] {
  return ["all", ...enabledSiteIds(disabledSiteIds)];
}

export function withHistoryPlatform(
  current: URLSearchParams,
  platform: HistoryPlatformFilter,
): URLSearchParams {
  const next = new URLSearchParams(current);
  if (platform === "all") next.delete(HISTORY_PLATFORM_PARAM);
  else next.set(HISTORY_PLATFORM_PARAM, platform);
  return next;
}
