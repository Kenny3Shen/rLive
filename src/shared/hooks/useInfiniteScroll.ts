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

    // Observe against the element that actually scrolls. `main` only clips —
    // Shell puts `overflow-y-auto` on the page wrapper inside it — and a root
    // that never scrolls computes visibility against a box the sentinel can sit
    // permanently inside, so the observer keeps asking for the next page.
    // `null` falls back to the viewport, which is still a scrolling box.
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
