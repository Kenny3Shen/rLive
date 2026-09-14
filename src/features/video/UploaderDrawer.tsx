import { useInfiniteQuery } from "@tanstack/react-query";
import { useState, type ComponentProps } from "react";
import { CalendarClock, TrendingUp, VideoOff, X } from "lucide-react";
import { BROWSING_LIST_QUERY_OPTIONS } from "@/shared/api/browsingQueryPolicy";
import { ErrorState } from "@/shared/components/ErrorState";
import { useInfiniteScroll } from "@/shared/hooks/useInfiniteScroll";
import { Button } from "@/components/ui/button";
import { Drawer, DrawerClose, DrawerContent, DrawerTitle } from "@/components/ui/drawer";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { videoUploaderVideos, type VideoUploaderOrder } from "./videoApi";
import { VideoCard } from "./VideoCard";
import { playlistItemFromVideoItem, dedupeVideoItems } from "./playlistStore";

// 行式卡片（缩略图在左）比网格卡宽，列宽下限随之放大到 22rem。
const GRID_CLASS = "grid grid-cols-[repeat(auto-fill,minmax(min(100%,22rem),1fr))] gap-x-3 gap-y-1";

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
  /** 自定义挂载容器，沿 DrawerContent 的 container 类型（如播放页侧栏作用域）。 */
  container?: ComponentProps<typeof DrawerContent>["container"];
};

/**
 * UP 主投稿视频抽屉，从右侧滑出，展示指定 UP 主的视频列表。
 */
export function UploaderDrawer({
  open,
  onOpenChange,
  mid,
  uploaderName,
  container,
}: UploaderDrawerProps) {
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
  const playlistUploader = { mid, name: uploaderName };
  const isEmpty = !isFetching && allItems.length === 0;

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent
        side="right"
        container={container}
        className="w-[min(48rem,90vw)] overflow-hidden"
      >
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
              <Empty className="min-h-56 py-10">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <VideoOff aria-hidden />
                  </EmptyMedia>
                  <EmptyTitle>暂无投稿视频</EmptyTitle>
                  <EmptyDescription>这位 UP 主还没有公开投稿。</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : allItems.length > 0 ? (
              <>
                <div className={GRID_CLASS}>
                  {allItems.map((item) => (
                    <VideoCard
                      key={`${item.bvid}:${item.cid ?? ""}`}
                      item={item}
                      playlist={playlistItems}
                      playlistUploader={playlistUploader}
                      onNavigate={() => onOpenChange(false)}
                      orientation="row"
                      showAuthor={false}
                    />
                  ))}
                </div>
                {hasNextPage && (
                  <div ref={loadMoreRef} className="flex justify-center py-6">
                    {isFetchingNextPage && <Spinner className="size-6" />}
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
                <Spinner className="size-8" />
              </div>
            )}
          </div>
        </div>
      </DrawerContent>
    </Drawer>
  );
}
