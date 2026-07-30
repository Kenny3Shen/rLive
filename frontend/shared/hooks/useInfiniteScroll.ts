import { useCallback, useEffect, useRef } from "react";

type UseInfiniteScrollOptions = {
  hasNextPage: boolean | undefined;
  isFetchingNextPage: boolean;
  isFetchNextPageError: boolean;
  fetchNextPage: () => Promise<unknown>;
  rootMargin?: string;
};

/**
 * Loads the next page shortly before the end-of-list sentinel is visible.
 *
 * A manual control remains available when IntersectionObserver is unavailable
 * (for example, in older embedded WebViews). Errors deliberately pause the
 * observer so a failed request is retried only by an explicit user action.
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

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadMore();
      },
      {
        root: document.querySelector<HTMLElement>("main"),
        rootMargin,
      },
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
