/**
 * Shared cache policy for discovery lists (recommendations, category trees and
 * category room pages).
 *
 * Those are the most expensive browsing requests in the app and they change
 * slowly. Shell remounts a page whenever the route or the platform changes, so
 * with a bounded stale window nearly every visit — coming back from a room,
 * flipping between platforms — paid for a fresh round of IPC.
 *
 * Marking the data permanently fresh makes every later visit free. Freshness
 * stays entirely under explicit control:
 * - the floating refresh button and the Android pull-to-refresh gesture call
 *   `refetch()` directly, which ignores `staleTime`;
 * - `invalidateQueries` (Cookie changes, profile import) also ignores
 *   `staleTime`, so a mount after an invalidation still refetches.
 *
 * `gcTime` is stretched past a typical viewing session so watching a stream for
 * a while does not silently drop the list the user came from.
 */
export const BROWSING_LIST_QUERY_OPTIONS = {
  staleTime: Number.POSITIVE_INFINITY,
  gcTime: 60 * 60_000,
} as const;
