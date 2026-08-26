import { useCallback, useEffect, useRef } from "react";
import { findVerticalScrollParent } from "@/shared/gestures/pullToRefresh";

type UseInfiniteScrollOptions = {
  hasNextPage: boolean | undefined;
  isFetchingNextPage: boolean;
  isFetchNextPageError: boolean;
  fetchNextPage: () => Promise<unknown>;
  rootMargin?: string;
};

/**
 * 在列表末尾哨兵可见前不久加载下一页。
 *
 * IntersectionObserver 不可用时（例如较旧的内嵌 WebView）手动控制仍可用。
 * 错误刻意暂停观察器，
 * 失败的请求只由用户显式操作重试。
 */
export function useInfiniteScroll({
  hasNextPage,
  isFetchingNextPage,
  isFetchNextPageError,
  fetchNextPage,
  rootMargin = "0px 0px 240px 0px",
}: UseInfiniteScrollOptions) {
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const loadMoreInFlightRef = useRef(false);
  const supportsIntersectionObserver = typeof IntersectionObserver !== "undefined";

  const loadMore = useCallback(
    (retry = false) => {
      if (
        loadMoreInFlightRef.current ||
        !hasNextPage ||
        isFetchingNextPage ||
        (!retry && isFetchNextPageError)
      ) {
        return;
      }

      loadMoreInFlightRef.current = true;
      void fetchNextPage().finally(() => {
        loadMoreInFlightRef.current = false;
      });
    },
    [fetchNextPage, hasNextPage, isFetchingNextPage, isFetchNextPageError],
  );

  useEffect(() => {
    const target = loadMoreRef.current;
    if (
      !target ||
      !hasNextPage ||
      isFetchingNextPage ||
      isFetchNextPageError ||
      !supportsIntersectionObserver
    ) {
      return;
    }

    // 对着真正滚动的元素观察。`main` 只负责裁剪 —— Shell 把 `overflow-y-auto`
    // 放在其内部的页面包装层上 —— 而永不滚动的 root 会以哨兵可以永远待在其中的盒子
    // 计算可见性，观察器就会不停要下一页。`null` 回退到视口，
    // 它仍是可滚动的盒子。
    const root = findVerticalScrollParent(target);

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadMore();
      },
      { root, rootMargin },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [
    hasNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
    loadMore,
    rootMargin,
    supportsIntersectionObserver,
  ]);

  return {
    loadMore,
    loadMoreRef,
    supportsIntersectionObserver,
  };
}
