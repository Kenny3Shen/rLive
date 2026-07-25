import type { SiteId } from "@/shared/types/live";

export type FollowPlatformFilter = SiteId | "all";

export const FOLLOW_PLATFORM_PARAM = "platform";

const FOLLOW_SITE_IDS = new Set<SiteId>(["bilibili", "douyu", "huya", "douyin", "kuaishou"]);

/**
 * Keeps the follow-page platform selection valid when a URL is opened or
 * edited outside the app. Unknown values deliberately fall back to the
 * all-platform view instead of producing an empty, impossible filter.
 */
export function followPlatformFromSearch(value: string | null): FollowPlatformFilter {
  return value !== null && FOLLOW_SITE_IDS.has(value as SiteId) ? (value as SiteId) : "all";
}

/** Preserve unrelated follow-page query parameters while changing its platform filter. */
export function withFollowPlatform(
  searchParams: URLSearchParams,
  platform: FollowPlatformFilter,
): URLSearchParams {
  const next = new URLSearchParams(searchParams);
  if (platform === "all") {
    next.delete(FOLLOW_PLATFORM_PARAM);
  } else {
    next.set(FOLLOW_PLATFORM_PARAM, platform);
  }
  return next;
}
