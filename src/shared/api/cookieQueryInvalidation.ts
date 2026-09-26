import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type { SiteId } from "@/shared/types/live";

// 每个可能随已认证平台会话变化的浏览器侧查询都把站点 id 放在第二个 key 槽位。
// 凭据不进入 query key：成功的 Cookie 变更只是把受影响的缓存条目标记为过期，
// 活动视图随之刷新、后续视图重新抓取。
const COOKIE_DEPENDENT_QUERY_SCOPES = new Set([
  "recommend",
  "categories",
  "category_rooms",
  "search_room",
  "search",
  "room_detail",
  "play_qualities",
  "play_urls",
]);

/**
 * VOD 列表里只有推荐接口受账号影响：Web API 推荐需要 Cookie 才是个性化流，
 * App API 则只认设备轴（`buvid`，见 `docs/zh/短视频调研-B站与抖音.md`）。
 * 站点 id 不在 key 的第二槽位（那里是页签），因此单独判断。
 */
const COOKIE_DEPENDENT_VIDEO_LIST_TABS = new Set(["recommend"]);

export function isCookieDependentSiteQuery(queryKey: QueryKey, siteId: SiteId): boolean {
  const [scope, querySiteId] = queryKey;
  if (scope === "video_list" && siteId === "bilibili") {
    return COOKIE_DEPENDENT_VIDEO_LIST_TABS.has(String(queryKey[1]));
  }
  return (
    typeof scope === "string" && querySiteId === siteId && COOKIE_DEPENDENT_QUERY_SCOPES.has(scope)
  );
}

/**
 * 账号 Cookie 变化后刷新浏览器与播放元数据。`invalidateQueries` 立即把非活动
 * 条目标记为过期并重新抓取活动条目，
 * 同时绝不把 Cookie 值放进查询缓存。
 */
export function invalidateCookieDependentSiteQueries(
  queryClient: QueryClient,
  siteId: SiteId,
): Promise<void> {
  return queryClient.invalidateQueries({
    predicate: (query) => isCookieDependentSiteQuery(query.queryKey, siteId),
  });
}
