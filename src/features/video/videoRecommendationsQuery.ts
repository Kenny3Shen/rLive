import {
  hashKey,
  type InfiniteData,
  type QueryCacheNotifyEvent,
  type QueryClient,
} from "@tanstack/react-query";
import type { VideoRecommendApi } from "@/shared/types/live";
import type { VideoListPage } from "@/shared/types/video";
import { nextRecommendPage } from "./videoFeed";
import { videoGetRecommend } from "./videoApi";

/** 推荐首页最多保留 20 分钟；翻页不会延长首屏的年龄。 */
export const VIDEO_RECOMMENDATION_FRESHNESS_MS = 20 * 60_000;

export type RecommendationFeedPage = { kind: "ugc"; fetchedAt: number } & VideoListPage;
export type RecommendationFeedData = InfiniteData<RecommendationFeedPage, number>;
export type RecommendationPageFetcher = (page: number) => Promise<VideoListPage>;

export function videoRecommendationQueryKey(
  api: VideoRecommendApi,
  appAuthRevision: number,
) {
  return [
    "video_list",
    "recommend",
    "",
    api,
    api === "app" ? appAuthRevision : 0,
  ] as const;
}

/** 只有当前来源与授权版本的推荐首页失效，才唤醒活动页面做首页刷新。 */
export function isVideoRecommendationInvalidationEvent(
  event: QueryCacheNotifyEvent,
  api: VideoRecommendApi,
  appAuthRevision: number,
): boolean {
  return (
    event.type === "updated" &&
    event.action.type === "invalidate" &&
    event.query.queryHash === hashKey(videoRecommendationQueryKey(api, appAuthRevision))
  );
}

export function recommendationPageFetchedAt(
  page: { fetchedAt?: number } | undefined,
  dataUpdatedAt: number,
): number {
  return page?.fetchedAt && page.fetchedAt > 0 ? page.fetchedAt : dataUpdatedAt;
}

/** 没有首页时由普通无限查询负责冷启动；只有已有首页才判断本地过期。 */
export function recommendationNeedsRefresh(
  data: InfiniteData<{ fetchedAt?: number }, unknown> | undefined,
  dataUpdatedAt: number,
  now = Date.now(),
): boolean {
  const firstPage = data?.pages[0];
  if (!firstPage) return false;
  const fetchedAt = recommendationPageFetchedAt(firstPage, dataUpdatedAt);
  return fetchedAt > 0 && now - fetchedAt >= VIDEO_RECOMMENDATION_FRESHNESS_MS;
}

export function shouldRefreshRecommendationOnActivation({
  enabled,
  pageVisible,
  documentVisible,
  data,
  dataUpdatedAt,
  invalidated = false,
  now = Date.now(),
}: {
  enabled: boolean;
  pageVisible: boolean;
  documentVisible: boolean;
  data: InfiniteData<{ fetchedAt?: number }, unknown> | undefined;
  dataUpdatedAt: number;
  invalidated?: boolean;
  now?: number;
}): boolean {
  return (
    enabled &&
    pageVisible &&
    documentVisible &&
    (invalidated || recommendationNeedsRefresh(data, dataUpdatedAt, now))
  );
}

export function videoRecommendationQueryOptions(
  api: VideoRecommendApi,
  appAuthRevision: number,
  fetchPage: RecommendationPageFetcher = videoGetRecommend,
  now: () => number = Date.now,
) {
  const queryKey = videoRecommendationQueryKey(api, appAuthRevision);
  return {
    queryKey,
    initialPageParam: 1,
    queryFn: async ({
      pageParam,
      signal,
    }: {
      pageParam: number;
      signal: AbortSignal;
    }): Promise<RecommendationFeedPage> => {
      const page = await fetchPage(pageParam);
      // IPC 本身不可取消；取消后丢弃迟到结果，避免旧补货覆盖新授权或新首页。
      signal.throwIfAborted();
      return {
        kind: "ugc",
        ...page,
        fetchedAt: now(),
      };
    },
    getNextPageParam: (
      _lastPage: RecommendationFeedPage,
      allPages: RecommendationFeedPage[],
    ) => nextRecommendPage(allPages),
    staleTime: VIDEO_RECOMMENDATION_FRESHNESS_MS,
    gcTime: 60 * 60_000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  } as const;
}

/** 同一 QueryClient、同一账号与来源只共享一个首页刷新。 */
const refreshes = new WeakMap<QueryClient, Map<string, Promise<RecommendationFeedData>>>();

export function refreshRecommendationFirstPage(
  queryClient: QueryClient,
  api: VideoRecommendApi,
  appAuthRevision: number,
  fetchPage: RecommendationPageFetcher = videoGetRecommend,
): Promise<RecommendationFeedData> {
  const queryKey = videoRecommendationQueryKey(api, appAuthRevision);
  const hash = JSON.stringify(queryKey);
  let clientRefreshes = refreshes.get(queryClient);
  if (!clientRefreshes) {
    clientRefreshes = new Map();
    refreshes.set(queryClient, clientRefreshes);
  }
  const existing = clientRefreshes.get(hash);
  if (existing) return existing;

  const refresh = (async () => {
    // 先停掉正在补货的第二页；它完成得更晚也不能覆盖新的首页。
    await queryClient.cancelQueries({ queryKey });
    const options = videoRecommendationQueryOptions(api, appAuthRevision, fetchPage);
    return queryClient.infiniteQuery({
      ...options,
      // 显式刷新忽略 TTL，只从第一页重建列表；成功前旧列表仍由 Query 保留。
      pages: 1,
      staleTime: 0,
    });
  })().finally(() => {
    if (clientRefreshes?.get(hash) === refresh) clientRefreshes.delete(hash);
  });

  clientRefreshes.set(hash, refresh);
  return refresh;
}
