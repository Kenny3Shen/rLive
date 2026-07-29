import { useEffect } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { invokeCmd } from "@/shared/api/tauri";
import type { FollowUser } from "@/shared/types/live";

export const FOLLOW_LIST_QUERY_KEY = ["follows"] as const;
const FOLLOW_REFRESH_QUERY_KEY = ["follows", "refresh"] as const;
export const FOLLOW_STATUS_REFRESH_INTERVAL_MS = 60_000;

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
  queryClient.setQueryData(FOLLOW_LIST_QUERY_KEY, follows);
  return follows;
}

/**
 * Keep followed streamers current for the lifetime of the application. The
 * request begins on launch, rather than waiting until the follow page is
 * visited, then repeats on a fixed one-minute cadence.
 */
export function useFollowStatusRefresh() {
  const queryClient = useQueryClient();

  useEffect(() => {
    const refresh = () => {
      // Automatic refresh errors should not replace a usable cached follow
      // list with an error screen. The next scheduled refresh will retry.
      void refreshFollows(queryClient).catch(() => {});
    };

    refresh();
    const interval = window.setInterval(refresh, FOLLOW_STATUS_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [queryClient]);
}
