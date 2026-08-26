import { memo, useMemo } from "react";
import { keepPreviousData, useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { ErrorState } from "@/shared/components/ErrorState";
import { PullToRefresh } from "@/shared/components/PullToRefresh";
import { RefreshFab } from "@/shared/components/RefreshFab";
import { RoomCard } from "@/shared/components/RoomCard";
import { useInfiniteScroll } from "@/shared/hooks/useInfiniteScroll";
import { useSiteId } from "@/shared/hooks/useSiteQuery";
import type { LiveRoomItem } from "@/shared/types/live";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { SITE_LABELS } from "@/lib/utils";
import { homeRecommendationsQueryOptions, trimRotatingRecommendPages } from "./homeQuery";
import { mergeRoomPages } from "./pagination";

type RoomGridProps = {
  rooms: readonly LiveRoomItem[];
};

const RoomGrid = memo(function RoomGrid({ rooms }: RoomGridProps) {
  return (
    <div className="grid grid-cols-2 gap-x-3 gap-y-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
      {rooms.map((room) => (
        <div key={`${room.site_id}:${room.room_id}`}>
          <RoomCard room={room} />
        </div>
      ))}
    </div>
  );
});

export function HomePage() {
  const siteId = useSiteId();
  const queryClient = useQueryClient();

  const query = useInfiniteQuery({
    ...homeRecommendationsQueryOptions(siteId),
    // 在从未访问过的平台拉取首页时保持当前网格可见。避免页签切换期间用空白表面
    // 替换可用内容；查询缓存仍按 ["recommend", siteId] 分别存储各平台。
    placeholderData: keepPreviousData,
  });
  const { fetchNextPage, isFetchingNextPage, isFetchNextPageError } = query;

  const pages = query.data?.pages;
  const rooms = useMemo(() => mergeRoomPages(pages), [pages]);
  const hasNextPage = query.isPlaceholderData ? false : query.hasNextPage;

  const { loadMore, loadMoreRef, supportsIntersectionObserver } = useInfiniteScroll({
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
  });

  const refreshing = query.isRefetching && !query.isFetchingNextPage;

  const refresh = () => {
    // 轮换型信息流（如抖音）只需要一批新数据；先裁剪可以把对所有已存页面的串行
    // 重新抓取变成单次请求。
    trimRotatingRecommendPages(queryClient, siteId);
    void query.refetch();
  };

  return (
    <PullToRefresh onRefresh={refresh} refreshing={refreshing} className="mx-auto max-w-[1600px]">
      <RefreshFab
        onRefresh={refresh}
        pending={refreshing || query.isLoading}
        label="刷新推荐直播"
      />
      <div className="flex flex-col gap-4">
        {query.isLoading && (
          <div className="grid grid-cols-2 gap-x-3 gap-y-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} className="flex flex-col gap-2">
                <Skeleton className="aspect-video w-full rounded-xl" />
                <Skeleton className="h-3.5 w-4/5" />
                <Skeleton className="h-3 w-1/2" />
              </div>
            ))}
          </div>
        )}

        {query.isError && rooms.length === 0 && (
          <ErrorState
            error={query.error}
            title="推荐直播加载失败"
            onRetry={() => void query.refetch()}
          />
        )}

        {!query.isLoading && !query.isError && rooms.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-2 py-24 text-muted-foreground">
            <p className="text-sm">暂无 {SITE_LABELS[siteId] ?? siteId} 推荐直播</p>
          </div>
        )}

        {rooms.length > 0 && <RoomGrid rooms={rooms} />}

        {hasNextPage && (
          <div ref={loadMoreRef} className="flex min-h-11 items-center justify-center pt-3 pb-2">
            {query.isFetchingNextPage && (
              <span
                className="flex items-center gap-2 text-sm text-muted-foreground"
                role="status"
                aria-live="polite"
              >
                <Loader2 className="animate-spin-soft" data-icon="inline-start" />
                加载中…
              </span>
            )}
            {query.isFetchNextPageError && (
              <Button variant="secondary" onClick={() => loadMore(true)}>
                重试加载
              </Button>
            )}
            {!supportsIntersectionObserver &&
              !query.isFetchingNextPage &&
              !query.isFetchNextPageError && (
                <Button variant="secondary" onClick={() => loadMore()}>
                  加载更多
                </Button>
              )}
          </div>
        )}
      </div>
    </PullToRefresh>
  );
}
