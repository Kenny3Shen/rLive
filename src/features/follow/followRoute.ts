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
 * 在应用外打开或手工编辑 URL 时，保持关注页的平台选择有效。未知和已停用的
 * 取值刻意回退到全部平台视图，而不是产生不可能成立的过滤器。
 */
export function followPlatformFromSearch(
  value: string | null,
  disabledSiteIds: unknown = [],
): FollowPlatformFilter {
  return isSiteEnabled(value, disabledSiteIds) ? value : "all";
}

/** 更改平台过滤时保留关注页其他无关的 query 参数。 */
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
 * 把校验过的开播时间戳转换为关注列表使用的紧凑中文文案。未知、非法和未来
 * 的时间刻意渲染为空，
 * 而不暗示平台并未提供的时长。
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
