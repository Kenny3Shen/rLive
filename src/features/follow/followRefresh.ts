import { useEffect } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { invokeCmd } from "@/shared/api/tauri";
import type { FollowUser } from "@/shared/types/live";

export const FOLLOW_LIST_QUERY_KEY = ["follows"] as const;
const FOLLOW_REFRESH_QUERY_KEY = ["follows", "refresh"] as const;
export const FOLLOW_STATUS_REFRESH_INTERVAL_MS = 60_000;

let lastFollowRefreshAt = 0;

/**
 * Delay before the next automatic status refresh.
 *
 * Entering the follow page remounts its hook, and re-entering it right after
 * leaving a room used to fire another remote refresh immediately. Resuming the
 * existing cadence instead keeps a revisit free while still never letting live
 * state age past one interval.
 */
export function followStatusRefreshDelay(
  lastRefreshAt: number,
  now: number,
  intervalMs: number = FOLLOW_STATUS_REFRESH_INTERVAL_MS,
): number {
  const elapsed = now - lastRefreshAt;
  if (!Number.isFinite(elapsed) || elapsed < 0) return 0;
  return Math.max(0, Math.min(intervalMs, intervalMs - elapsed));
}

/**
 * Refresh live-state data once and keep every follow-list consumer on the
 * same cache entry. `fetchQuery` coalesces concurrent automatic and manual
 * refreshes through the dedicated in-flight query key.
 */
export async function refreshFollows(queryClient: QueryClient): Promise<FollowUser[]> {
  const follows = await queryClient.fetchQuery({
    queryKey: FOLLOW_REFRESH_QUERY_KEY,
    queryFn: () => invokeCmd<FollowUser[]>("follow_refresh"),
    // A refresh must always contact the backend; the query key exists only to
    // deduplicate overlapping requests rather than cache a previous result.
    staleTime: 0,
  });
  lastFollowRefreshAt = Date.now();
  queryClient.setQueryData(FOLLOW_LIST_QUERY_KEY, follows);
  return follows;
}

/**
 * Keep followed streamers current while a follow-list view is open. Keeping
 * this scoped to its consumer avoids doing remote status work during the
 * application's initial render, and resuming the previous cadence keeps a
 * revisit — after returning from a room, or a platform filter change — from
 * repeating work the cache already holds.
 */
export function useFollowStatusRefresh(enabled = true) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!enabled) return;
    let interval: number | undefined;
    const refresh = () => {
      // Automatic refresh errors should not replace a usable cached follow
      // list with an error screen. The next scheduled refresh will retry.
      void refreshFollows(queryClient).catch(() => {});
    };

    const timeout = window.setTimeout(
      () => {
        refresh();
        interval = window.setInterval(refresh, FOLLOW_STATUS_REFRESH_INTERVAL_MS);
      },
      followStatusRefreshDelay(lastFollowRefreshAt, Date.now()),
    );

    return () => {
      window.clearTimeout(timeout);
      if (interval != null) window.clearInterval(interval);
    };
  }, [enabled, queryClient]);
}
