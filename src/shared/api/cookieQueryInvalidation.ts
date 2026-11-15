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
 * App API 不按 Web Cookie 个性化；设备 buvid 与独立 TV 授权的边界见
 * `docs/zh/B站视频功能设计.md`「推荐源与画幅适配」。
 * 站点 id 不在 key 的第二槽位（那里是页签），因此单独判断。
 */
const COOKIE_DEPENDENT_VIDEO_LIST_TABS = new Set(["recommend"]);

export function isVideoRecommendationQuery(queryKey: QueryKey): boolean {
  return queryKey[0] === "video_list" && COOKIE_DEPENDENT_VIDEO_LIST_TABS.has(String(queryKey[1]));
}

export function isCookieDependentSiteQuery(queryKey: QueryKey, siteId: SiteId): boolean {
  const [scope, querySiteId] = queryKey;
  if (scope === "video_list" && siteId === "bilibili") {
    return isVideoRecommendationQuery(queryKey);
  }
  return (
    typeof scope === "string" && querySiteId === siteId && COOKIE_DEPENDENT_QUERY_SCOPES.has(scope)
  );
}

/**
 * 账号 Cookie 变化后刷新浏览器与播放元数据。普通查询会立即把非活动条目标记为
 * 过期并重新抓取活动条目；VOD 推荐只标记失效，由活动推荐页从首页刷新，避免
 * infinite query 按已加载页数重取。Cookie 值绝不进入查询缓存。
 */
export function invalidateCookieDependentSiteQueries(
  queryClient: QueryClient,
  siteId: SiteId,
): Promise<void> {
  const affected = (queryKey: QueryKey) => isCookieDependentSiteQuery(queryKey, siteId);
  return Promise.all([
    // 推荐必须保留旧列表、先去取首页；默认无限查询失效会按已加载页数串行重取。
    queryClient.invalidateQueries({
      predicate: (query) =>
        affected(query.queryKey) && isVideoRecommendationQuery(query.queryKey),
      refetchType: "none",
    }),
    queryClient.invalidateQueries({
      predicate: (query) =>
        affected(query.queryKey) && !isVideoRecommendationQuery(query.queryKey),
    }),
  ]).then(() => undefined);
}
