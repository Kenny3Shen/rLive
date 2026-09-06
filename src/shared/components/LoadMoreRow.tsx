import type { UseInfiniteQueryResult } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { InfiniteScrollController } from "@/shared/hooks/useInfiniteScroll";
import { cn } from "@/lib/utils";

/**
 * 无限滚动列表的收尾哨兵行：`useInfiniteScroll` 的观察目标，同时按游标查询
 * 的状态画转圈 / 重试按钮，在不支持 IntersectionObserver 的 WebView 里换成
 * 手动「加载更多」，到底后显示收尾文案（`endLabel` 缺省则留空）。
 */
export function LoadMoreRow({
  scroll,
  query,
  loadingLabel,
  retryLabel,
  loadMoreLabel,
  endLabel,
  className,
}: {
  /** `useInfiniteScroll` 的返回值：哨兵 ref、loadMore 与 IO 支持位。 */
  scroll: InfiniteScrollController;
  /** 游标分页查询；只读三个翻页状态位。 */
  query: Pick<
    UseInfiniteQueryResult<unknown>,
    "isFetchingNextPage" | "isFetchNextPageError" | "hasNextPage"
  >;
  /** 拉取中转圈的 aria-label。 */
  loadingLabel: string;
  retryLabel: string;
  loadMoreLabel: string;
  /** 到底文案；不提供则该行保持空白。 */
  endLabel?: string;
  /** 行高等布局差异由调用方给出（如 `min-h-14`）。 */
  className?: string;
}) {
  return (
    <div ref={scroll.loadMoreRef} className={cn("flex items-center justify-center", className)}>
      {query.isFetchingNextPage ? (
        <Spinner aria-label={loadingLabel} />
      ) : query.isFetchNextPageError ? (
        <Button variant="ghost" size="sm" onClick={() => scroll.loadMore(true)}>
          {retryLabel}
        </Button>
      ) : query.hasNextPage ? (
        !scroll.supportsIntersectionObserver && (
          <Button variant="ghost" size="sm" onClick={() => scroll.loadMore()}>
            {loadMoreLabel}
          </Button>
        )
      ) : (
        endLabel && <span className="text-xs text-muted-foreground">{endLabel}</span>
      )}
    </div>
  );
}
