import { memo } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Loader2, Search } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { BROWSING_LIST_QUERY_OPTIONS } from "@/shared/api/browsingQueryPolicy";
import { ErrorState } from "@/shared/components/ErrorState";
import { useInfiniteScroll } from "@/shared/hooks/useInfiniteScroll";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import type { VideoItem } from "@/shared/types/video";
import { videoSearch } from "./videoApi";
import { VideoCard } from "./VideoCard";
import { playlistItemFromVideoItem, dedupeVideoItems, type PlaylistItem } from "./playlistStore";
import { VIDEO_SEARCH_QUERY_PARAM } from "./videoRoute";

const GRID_CLASS =
  "grid grid-cols-2 gap-x-3 gap-y-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6";

const VideoGrid = memo(function VideoGrid({
  items,
  playlist,
}: {
  items: readonly VideoItem[];
  playlist: readonly PlaylistItem[];
}) {
  return (
    <div className={GRID_CLASS}>
      {items.map((item) => (
        <VideoCard key={`${item.bvid}:${item.cid ?? ""}`} item={item} playlist={playlist} />
      ))}
    </div>
  );
});

/**
 * `/video/search` 搜索结果页。
 *
 * 查询条住在 Shell 头部（`VideoSearchBar`），关键词由 URL `?q=` 携带；
 * 这一页只负责结果网格与无限滚动，滚动交给 Shell 的页面滚动容器。
 */
export function VideoSearchPage() {
  const [searchParams] = useSearchParams();
  const keyword = (searchParams.get(VIDEO_SEARCH_QUERY_PARAM) ?? "").trim();

  const listQuery = useInfiniteQuery({
    queryKey: ["video", "search", keyword],
    queryFn: ({ pageParam }) => videoSearch(keyword, pageParam),
    initialPageParam: 1,
    getNextPageParam: (lastPage, _allPages, lastPageParam) =>
      lastPage.has_more ? lastPageParam + 1 : undefined,
    enabled: keyword.length > 0,
    ...BROWSING_LIST_QUERY_OPTIONS,
  });

  const { data, error, fetchNextPage, hasNextPage, isFetching, isFetchingNextPage, isFetchNextPageError, refetch } =
    listQuery;

  const { loadMore, loadMoreRef, supportsIntersectionObserver } = useInfiniteScroll({
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
  });

  const allItems = dedupeVideoItems(data?.pages.flatMap((page) => page.items) ?? []);
  // 点击时刻的列表快照即播放列表（搜索结果连播）。allItems 每次渲染都是新数组，
  // 顺带计算不额外记忆化，量级最多几十条。
  const playlistItems = allItems.map(playlistItemFromVideoItem);
  const isEmpty = !isFetching && keyword && allItems.length === 0;

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-4 pb-6">
      <h1 className="sr-only">视频搜索{keyword ? `：${keyword}` : ""}</h1>

      {error ? (
        <ErrorState error={error} title="搜索失败" onRetry={() => refetch()} />
      ) : isEmpty ? (
        <Empty className="min-h-56 py-10">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Search aria-hidden />
            </EmptyMedia>
            <EmptyTitle>未找到相关视频</EmptyTitle>
            <EmptyDescription>试试其他关键词</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : allItems.length > 0 ? (
        <>
          <VideoGrid items={allItems} playlist={playlistItems} />
          {hasNextPage && (
            <div ref={loadMoreRef} className="flex min-h-11 items-center justify-center pt-3 pb-2">
              {isFetchingNextPage && (
                <span
                  className="flex items-center gap-2 text-sm text-muted-foreground"
                  role="status"
                  aria-live="polite"
                >
                  <Loader2 className="animate-spin-soft" data-icon="inline-start" />
                  加载中…
                </span>
              )}
            </div>
          )}
          {!supportsIntersectionObserver && hasNextPage && (
            <div className="flex justify-center py-4">
              <Button onClick={() => loadMore()} disabled={isFetchingNextPage}>
                {isFetchingNextPage ? "加载中..." : "加载更多"}
              </Button>
            </div>
          )}
        </>
      ) : keyword ? (
        <div className="flex justify-center py-12">
          <Loader2 className="size-8 animate-spin" />
        </div>
      ) : (
        <Empty className="min-h-56 py-10">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Search aria-hidden />
            </EmptyMedia>
            <EmptyTitle>搜索 B 站视频</EmptyTitle>
            <EmptyDescription>在上方输入关键词开始搜索</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </div>
  );
}
