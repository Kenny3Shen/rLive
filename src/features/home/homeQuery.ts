import type { QueryClient, QueryFunctionContext, InfiniteData } from "@tanstack/react-query";
import { invokeCmd } from "@/shared/api/tauri";
import { BROWSING_LIST_QUERY_OPTIONS } from "@/shared/api/browsingQueryPolicy";
import type { SiteId, RoomListPage } from "@/shared/types/live";
import { nextRecommendPage } from "./pagination";

type RecommendQueryKey = readonly ["recommend", SiteId];

export function homeRecommendationsQueryOptions(siteId: SiteId) {
  return {
    queryKey: ["recommend", siteId] as RecommendQueryKey,
    queryFn: ({ pageParam }: QueryFunctionContext<RecommendQueryKey, number>) =>
      invokeCmd<RoomListPage>("site_get_recommend", {
        siteId,
        page: pageParam,
      }),
    initialPageParam: 1,
    getNextPageParam: nextRecommendPage,
    ...BROWSING_LIST_QUERY_OPTIONS,
  };
}

/** Start a platform feed before the tab click needs it. QueryClient deduplicates in-flight calls. */
export function prefetchHomeRecommendations(queryClient: QueryClient, siteId: SiteId): void {
  void queryClient.prefetchInfiniteQuery(homeRecommendationsQueryOptions(siteId));
}

/**
 * Sites whose recommendation pages are rotating batches rather than stable
 * offsets: refreshing every stored page would pay N sequential round trips to
 * re-derive content that a single fresh batch supersedes anyway. Refreshing
 * such a feed trims the query to its first page, so `refetch` issues exactly
 * one request and the whole grid rotates.
 */
const ROTATING_RECOMMEND_SITES: readonly SiteId[] = ["douyin"];

export function trimRotatingRecommendPages(queryClient: QueryClient, siteId: SiteId): void {
  if (!ROTATING_RECOMMEND_SITES.includes(siteId)) return;
  queryClient.setQueryData<InfiniteData<RoomListPage, number>>(["recommend", siteId], (data) =>
    data
      ? {
          pages: data.pages.slice(0, 1),
          pageParams: data.pageParams.slice(0, 1),
        }
      : data,
  );
}
