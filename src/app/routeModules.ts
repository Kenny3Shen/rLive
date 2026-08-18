import type { ComponentType } from "react";

export type LazyRouteModule = { default: ComponentType };
export type RouteModuleLoader = () => Promise<LazyRouteModule>;

/** Share one import promise between React.lazy, intent preloading, and idle preloading. */
export function createCachedRouteLoader(load: RouteModuleLoader): RouteModuleLoader {
  let cached: Promise<LazyRouteModule> | undefined;

  return () => {
    cached ??= load().catch((error: unknown) => {
      cached = undefined;
      throw error;
    });
    return cached;
  };
}

export const loadCategoryPage = createCachedRouteLoader(() =>
  import("../features/category/CategoryPage").then(({ CategoryPage }) => ({
    default: CategoryPage,
  })),
);

export const loadCategoryRoomsPage = createCachedRouteLoader(() =>
  import("../features/category/CategoryRoomsPage").then(({ CategoryRoomsPage }) => ({
    default: CategoryRoomsPage,
  })),
);

export const loadSearchPage = createCachedRouteLoader(() =>
  import("../features/search/SearchPage").then(({ SearchPage }) => ({ default: SearchPage })),
);

export const loadFollowPage = createCachedRouteLoader(() =>
  import("../features/follow/FollowPage").then(({ FollowPage }) => ({ default: FollowPage })),
);

export const loadHistoryPage = createCachedRouteLoader(() =>
  import("../features/history/HistoryPage").then(({ HistoryPage }) => ({
    default: HistoryPage,
  })),
);

export const loadRecordingsPage = createCachedRouteLoader(() =>
  import("../features/recording/RecordingsPage").then(({ RecordingsPage }) => ({
    default: RecordingsPage,
  })),
);

export const loadRecordingPlaybackPage = createCachedRouteLoader(() =>
  import("../features/recording/RecordingPlaybackPage").then(({ RecordingPlaybackPage }) => ({
    default: RecordingPlaybackPage,
  })),
);

export const loadSettingsPage = createCachedRouteLoader(() =>
  import("../features/settings/SettingsPage").then(({ SettingsPage }) => ({
    default: SettingsPage,
  })),
);

export const loadIptvPage = createCachedRouteLoader(() =>
  import("../features/iptv/IptvPage").then(({ IptvPage }) => ({ default: IptvPage })),
);

export const loadIptvPlayerPage = createCachedRouteLoader(() =>
  import("../features/iptv/IptvPlayerPage").then(({ IptvPlayerPage }) => ({
    default: IptvPlayerPage,
  })),
);

export const loadRoomPage = createCachedRouteLoader(() =>
  import("../features/room/RoomPage").then(({ RoomPage }) => ({ default: RoomPage })),
);

export const loadMultiRoomPage = createCachedRouteLoader(() =>
  import("../features/multi-room/MultiRoomPage").then(({ MultiRoomPage }) => ({
    default: MultiRoomPage,
  })),
);

/** Keep expensive player code last so small, common destinations become ready first. */
export const IDLE_ROUTE_MODULE_LOADERS: readonly RouteModuleLoader[] = [
  loadCategoryPage,
  loadCategoryRoomsPage,
  loadIptvPage,
  loadSearchPage,
  loadFollowPage,
  loadHistoryPage,
  loadRecordingsPage,
  loadIptvPlayerPage,
  loadSettingsPage,
  loadMultiRoomPage,
  loadRoomPage,
];

function pathnameFromTarget(target: string): string | null {
  try {
    return new URL(target, "https://rlive.local").pathname;
  } catch {
    return null;
  }
}

export function routeModuleLoaderForPath(target: string): RouteModuleLoader | null {
  const pathname = pathnameFromTarget(target);
  if (!pathname || pathname === "/") return null;

  if (pathname === "/category") return loadCategoryPage;
  if (pathname.startsWith("/category/")) return loadCategoryRoomsPage;
  if (pathname === "/search") return loadSearchPage;
  if (pathname === "/follow") return loadFollowPage;
  if (pathname === "/history") return loadHistoryPage;
  if (pathname.startsWith("/recordings/play/")) return loadRecordingPlaybackPage;
  if (pathname === "/recordings") return loadRecordingsPage;
  if (pathname === "/iptv/play") return loadIptvPlayerPage;
  if (pathname === "/iptv") return loadIptvPage;
  if (pathname === "/settings") return loadSettingsPage;
  if (pathname === "/multi-room") return loadMultiRoomPage;
  if (pathname.startsWith("/room/")) return loadRoomPage;

  return null;
}

/** Intent preloading is best-effort; navigation still owns visible error handling. */
export function preloadRouteModule(target: string): void {
  const loader = routeModuleLoaderForPath(target);
  if (loader) void loader().catch(() => undefined);
}
