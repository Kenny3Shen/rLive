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

/** 在页签点击需要之前启动平台信息流。QueryClient 会合并在途调用。 */
export function prefetchHomeRecommendations(queryClient: QueryClient, siteId: SiteId): void {
  void queryClient.prefetchInfiniteQuery(homeRecommendationsQueryOptions(siteId));
}

/**
 * 推荐页是轮换批次而非稳定偏移的站点：逐页刷新要用 N 次串行往返才能重新推导
 * 出本来就会被单批新数据取代的内容。刷新这类信息流时先把 query 裁剪到第一页，
 * 使 `refetch` 恰好发出一次请求，整个网格随之轮换。
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
