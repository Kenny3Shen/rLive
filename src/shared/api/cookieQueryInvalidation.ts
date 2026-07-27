import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type { SiteId } from "@/shared/types/live";

// Every browser-facing query that can change with an authenticated platform
// session keeps the site id in its second key slot. Keep credentials out of
// query keys: a successful Cookie mutation merely marks the affected cache
// entries stale, so active views refresh and future views fetch anew.
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

export function isCookieDependentSiteQuery(queryKey: QueryKey, siteId: SiteId): boolean {
  const [scope, querySiteId] = queryKey;
  return (
    typeof scope === "string" && querySiteId === siteId && COOKIE_DEPENDENT_QUERY_SCOPES.has(scope)
  );
}

/**
 * Refresh browser and playback metadata after an account Cookie changes.
 * `invalidateQueries` immediately marks inactive entries stale and refetches
 * active ones, without ever putting Cookie values into the query cache.
 */
export function invalidateCookieDependentSiteQueries(
  queryClient: QueryClient,
  siteId: SiteId,
): Promise<void> {
  return queryClient.invalidateQueries({
    predicate: (query) => isCookieDependentSiteQuery(query.queryKey, siteId),
  });
}
