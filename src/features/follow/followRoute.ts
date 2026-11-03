import { isSiteEnabled } from "@/shared/siteId";
import type { SiteId } from "@/shared/types/live";

export type FollowPlatformFilter = SiteId | "all";
export type FollowView = "live" | "video" | "iptv" | "recordings" | "downloads";

export const FOLLOW_PLATFORM_PARAM = "platform";
export const FOLLOW_VIEW_PARAM = "view";

/** 头部页签与横滑轨道共用同一顺序，避免手势方向和视觉顺序不一致。 */
export const FOLLOW_VIEWS = ["live", "video", "iptv", "recordings", "downloads"] as const;

export function followViewsFor(recordingAvailable: boolean): readonly FollowView[] {
  return recordingAvailable ? FOLLOW_VIEWS : FOLLOW_VIEWS.filter((view) => view !== "recordings");
}

export function isFollowView(value: unknown): value is FollowView {
  return typeof value === "string" && (FOLLOW_VIEWS as readonly string[]).includes(value);
}

/**
 * 非法值回落直播，桌面专属录制在移动端也回落直播，避免深链接打开一个
 * 本平台无法使用的空面板。
 */
export function followViewFromSearch(value: string | null, recordingAvailable = true): FollowView {
  if (value === "recordings" && !recordingAvailable) return "live";
  return isFollowView(value) ? value : "live";
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
 *
 * 实现已移到 `@/shared/liveDuration`：播放器控制栏的秒级时钟要用同一份校验与
 * 同一档中文阈值。这里保留导出名，关注页与房间侧栏无需改动。
 */
export { formatLiveDurationText as formatFollowLiveDuration } from "@/shared/liveDuration";
