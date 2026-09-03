import { useInfiniteQuery } from "@tanstack/react-query";
import { X, Loader2 } from "lucide-react";
import { BROWSING_LIST_QUERY_OPTIONS } from "@/shared/api/browsingQueryPolicy";
import { ErrorState } from "@/shared/components/ErrorState";
import { useInfiniteScroll } from "@/shared/hooks/useInfiniteScroll";
import { Button } from "@/components/ui/button";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerTitle,
} from "@/components/ui/drawer";
import { videoUploaderVideos } from "./videoApi";
import { VideoCard } from "./VideoCard";

const GRID_CLASS =
  "grid grid-cols-2 gap-x-3 gap-y-4 sm:grid-cols-3 md:grid-cols-4";

type UploaderDrawerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mid: string;
  uploaderName: string;
};

/**
 * UP 主投稿视频抽屉，从右侧滑出，展示指定 UP 主的视频列表。
 */
export function UploaderDrawer({
  open,
  onOpenChange,
  mid,
  uploaderName,
}: UploaderDrawerProps) {
  const listQuery = useInfiniteQuery({
    queryKey: ["video", "uploader", mid],
    queryFn: ({ pageParam }) => videoUploaderVideos(mid, pageParam),
    initialPageParam: 1,
    getNextPageParam: (lastPage, _allPages, lastPageParam) =>
      lastPage.has_more ? lastPageParam + 1 : undefined,
    enabled: open && mid.length > 0,
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

  const allItems = data?.pages.flatMap((page) => page.items) ?? [];
  const isEmpty = !isFetching && allItems.length === 0;

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent side="right" className="w-[min(48rem,90vw)]">
        <div className="flex h-full flex-col">
          {/* 标题栏 */}
          <div className="flex shrink-0 items-center justify-between border-b border-border pb-3">
            <DrawerTitle>{uploaderName} 的投稿</DrawerTitle>
            <DrawerClose
              render={
                <Button variant="ghost" size="icon-sm" aria-label="关闭">
                  <X className="size-4" />
                </Button>
              }
            />
          </div>

          {/* 视频列表 */}
          <div className="min-h-0 flex-1 overflow-y-auto pt-4">
            {error ? (
              <ErrorState
                error={error}
                onRetry={() => refetch()}
              />
            ) : isEmpty ? (
              <p className="py-12 text-center text-sm text-muted-foreground">
                暂无投稿视频
              </p>
            ) : allItems.length > 0 ? (
              <>
                <div className={GRID_CLASS}>
                  {allItems.map((item) => (
                    <VideoCard key={`${item.bvid}:${item.cid ?? ""}`} item={item} />
                  ))}
                </div>
                {hasNextPage && (
                  <div ref={loadMoreRef} className="flex justify-center py-6">
                    {isFetchingNextPage && <Loader2 className="size-6 animate-spin" />}
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
            ) : (
              <div className="flex justify-center py-12">
                <Loader2 className="size-8 animate-spin" />
              </div>
            )}
          </div>
        </div>
      </DrawerContent>
    </Drawer>
  );
}
