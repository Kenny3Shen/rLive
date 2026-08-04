import type { QueryClient, QueryFunctionContext } from "@tanstack/react-query";
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
