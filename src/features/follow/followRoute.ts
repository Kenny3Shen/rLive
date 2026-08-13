import { isSiteEnabled } from "@/shared/siteId";
import type { SiteId } from "@/shared/types/live";

export type FollowPlatformFilter = SiteId | "all";
export type FollowView = "live" | "iptv";

export const FOLLOW_PLATFORM_PARAM = "platform";
export const FOLLOW_VIEW_PARAM = "view";

export function followViewFromSearch(value: string | null): FollowView {
  return value === "iptv" ? "iptv" : "live";
}

export function withFollowView(searchParams: URLSearchParams, view: FollowView): URLSearchParams {
  const next = new URLSearchParams(searchParams);
  if (view === "live") next.delete(FOLLOW_VIEW_PARAM);
  else next.set(FOLLOW_VIEW_PARAM, view);
  return next;
}

/**
 * Keeps the follow-page platform selection valid when a URL is opened or
 * edited outside the app. Unknown and disabled values deliberately fall back
 * to the all-platform view instead of producing an impossible filter.
 */
export function followPlatformFromSearch(
  value: string | null,
  disabledSiteIds: unknown = [],
): FollowPlatformFilter {
  return isSiteEnabled(value, disabledSiteIds) ? value : "all";
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

/**
 * Converts a verified live-session start timestamp into compact Chinese copy
 * for the follow list. Unknown, invalid, and future values deliberately
 * render nothing rather than implying a duration the platform did not supply.
 */
export function formatFollowLiveDuration(
  liveStartedAt: number | null | undefined,
  now = Date.now(),
): string | null {
  if (
    liveStartedAt == null ||
    !Number.isFinite(liveStartedAt) ||
    liveStartedAt <= 0 ||
    liveStartedAt > now
  ) {
    return null;
  }

  const minutes = Math.floor((now - liveStartedAt) / 60_000);
  if (minutes < 1) return "刚刚开播";
  if (minutes < 60) return `${minutes} 分钟`;

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) {
    return remainingMinutes > 0 ? `${hours} 小时 ${remainingMinutes} 分钟` : `${hours} 小时`;
  }

  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours > 0 ? `${days} 天 ${remainingHours} 小时` : `${days} 天`;
}
