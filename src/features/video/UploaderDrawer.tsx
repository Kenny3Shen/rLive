import { useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";
import { CalendarClock, Loader2, TrendingUp, X } from "lucide-react";
import { BROWSING_LIST_QUERY_OPTIONS } from "@/shared/api/browsingQueryPolicy";
import { ErrorState } from "@/shared/components/ErrorState";
import { useInfiniteScroll } from "@/shared/hooks/useInfiniteScroll";
import { Button } from "@/components/ui/button";
import { Drawer, DrawerClose, DrawerContent, DrawerTitle } from "@/components/ui/drawer";
import { videoUploaderVideos, type VideoUploaderOrder } from "./videoApi";
import { VideoCard } from "./VideoCard";
import { playlistItemFromVideoItem, dedupeVideoItems } from "./playlistStore";

// 行式卡片（缩略图在左）比网格卡宽，列宽下限随之放大到 22rem。
const GRID_CLASS =
  "grid grid-cols-[repeat(auto-fill,minmax(min(100%,22rem),1fr))] gap-x-3 gap-y-1";

/** 排序标签：按钮显示当前排序，aria 宣告点击后的目标排序。 */
const ORDER_LABELS: Record<VideoUploaderOrder, string> = {
  pubdate: "最新发布",
  click: "最多播放",
};

type UploaderDrawerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mid: string;
  uploaderName: string;
};

/**
 * UP 主投稿视频抽屉，从右侧滑出，展示指定 UP 主的视频列表。
 */
export function UploaderDrawer({ open, onOpenChange, mid, uploaderName }: UploaderDrawerProps) {
  const [order, setOrder] = useState<VideoUploaderOrder>("pubdate");
  const nextOrder: VideoUploaderOrder = order === "pubdate" ? "click" : "pubdate";
  const listQuery = useInfiniteQuery({
    queryKey: ["video", "uploader", mid, order],
    queryFn: ({ pageParam }) => videoUploaderVideos(mid, pageParam, order),
    initialPageParam: 1,
    getNextPageParam: (lastPage, _allPages, lastPageParam) =>
      lastPage.has_more ? lastPageParam + 1 : undefined,
    enabled: open && mid.length > 0,
    ...BROWSING_LIST_QUERY_OPTIONS,
  });

  const {
    data,
    error,
    fetchNextPage,
    hasNextPage,
    isFetching,
    isFetchingNextPage,
    isFetchNextPageError,
    refetch,
  } = listQuery;

  const { loadMore, loadMoreRef, supportsIntersectionObserver } = useInfiniteScroll({
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
  });

  const allItems = dedupeVideoItems(data?.pages.flatMap((page) => page.items) ?? []);
  // 点击时刻的列表快照即播放列表（投稿列表连播）。
  const playlistItems = allItems.map(playlistItemFromVideoItem);
  const isEmpty = !isFetching && allItems.length === 0;

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent side="right" className="w-[min(48rem,90vw)] overflow-hidden">
        <div className="flex h-full flex-col">
          {/* 标题栏 */}
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border pb-3">
            <DrawerTitle className="min-w-0 break-words">{uploaderName} 的投稿</DrawerTitle>
            <div className="flex shrink-0 items-center gap-1">
              {/* 排序切换：与亮暗模式切换同款点按翻转，不走弹出菜单。 */}
              <Button
                variant="outline"
                size="sm"
                aria-label={`切换为${ORDER_LABELS[nextOrder]}排序`}
                aria-pressed={order === "click"}
                onClick={() => setOrder(nextOrder)}
              >
                {order === "pubdate" ? (
                  <CalendarClock data-icon="inline-start" aria-hidden />
                ) : (
                  <TrendingUp data-icon="inline-start" aria-hidden />
                )}
                {ORDER_LABELS[order]}
              </Button>
              <DrawerClose
                render={
                  <Button variant="ghost" size="icon-sm" aria-label="关闭">
                    <X />
                  </Button>
                }
              />
            </div>
          </div>

          {/* 视频列表 */}
          <div className="min-h-0 flex-1 overflow-y-auto pt-4">
            {error ? (
              <ErrorState error={error} onRetry={() => refetch()} />
            ) : isEmpty ? (
              <p className="py-12 text-center text-sm text-muted-foreground">暂无投稿视频</p>
            ) : allItems.length > 0 ? (
              <>
                <div className={GRID_CLASS}>
                  {allItems.map((item) => (
                    <VideoCard
                      key={`${item.bvid}:${item.cid ?? ""}`}
                      item={item}
                      playlist={playlistItems}
                      orientation="row"
                      showAuthor={false}
                    />
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
