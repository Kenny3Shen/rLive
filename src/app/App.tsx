import { lazy, Suspense } from "react";
import { BrowserRouter, Navigate, Route, Routes, useParams } from "react-router-dom";
import { isSiteEnabled, isSiteId } from "@/shared/siteId";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import { Shell } from "./layout/Shell";
import { HomePage } from "../features/home/HomePage";

// Keep the discovery page on the critical path, but defer secondary pages
// (especially the player and its danmaku renderer) until a route needs them.
// This substantially reduces the JS parsed before the first room grid paints.
const CategoryPage = lazy(() =>
  import("../features/category/CategoryPage").then(({ CategoryPage }) => ({
    default: CategoryPage,
  })),
);
const CategoryRoomsPage = lazy(() =>
  import("../features/category/CategoryRoomsPage").then(({ CategoryRoomsPage }) => ({
    default: CategoryRoomsPage,
  })),
);
const SearchPage = lazy(() =>
  import("../features/search/SearchPage").then(({ SearchPage }) => ({ default: SearchPage })),
);
const FollowPage = lazy(() =>
  import("../features/follow/FollowPage").then(({ FollowPage }) => ({ default: FollowPage })),
);
const HistoryPage = lazy(() =>
  import("../features/history/HistoryPage").then(({ HistoryPage }) => ({
    default: HistoryPage,
  })),
);
const SettingsPage = lazy(() =>
  import("../features/settings/SettingsPage").then(({ SettingsPage }) => ({
    default: SettingsPage,
  })),
);
const IptvPage = lazy(() =>
  import("../features/iptv/IptvPage").then(({ IptvPage }) => ({ default: IptvPage })),
);
const IptvPlayerPage = lazy(() =>
  import("../features/iptv/IptvPlayerPage").then(({ IptvPlayerPage }) => ({
    default: IptvPlayerPage,
  })),
);
const RoomPage = lazy(() =>
  import("../features/room/RoomPage").then(({ RoomPage }) => ({ default: RoomPage })),
);

function RouteLoadingFallback() {
  return (
    <div
      className="flex min-h-40 items-center justify-center gap-2 text-sm text-muted-foreground"
      role="status"
    >
      <span className="size-4 animate-spin-soft rounded-full border-2 border-muted-foreground/30 border-t-primary" />
      正在加载…
    </div>
  );
}

/** Prevent stale links from opening a platform the user has opted out of. */
function EnabledRoomRoute() {
  const { siteId } = useParams<{ siteId: string }>();
  const disabledSiteIds = useSettingsStore((state) => state.disabledSiteIds);
  const hydratedFromBackend = useSettingsStore((state) => state.hydratedFromBackend);

  // A persisted opt-out may arrive just after the router mounts. Holding the
  // player route for that short settings load avoids starting a disabled
  // platform's network requests before redirecting back to discovery.
  if (!hydratedFromBackend) return <RouteLoadingFallback />;

  if (isSiteId(siteId) && !isSiteEnabled(siteId, disabledSiteIds)) {
    return <Navigate to="/" replace />;
  }

  return <RoomPage />;
}

export function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={<RouteLoadingFallback />}>
        <Routes>
          <Route element={<Shell />}>
            <Route index element={<HomePage />} />
            <Route path="category" element={<CategoryPage />} />
            <Route path="category/:parentId/:categoryId" element={<CategoryRoomsPage />} />
            <Route path="search" element={<SearchPage />} />
            <Route path="follow" element={<FollowPage />} />
            <Route path="history" element={<HistoryPage />} />
            <Route path="iptv/play" element={<IptvPlayerPage />} />
            <Route path="iptv" element={<IptvPage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="room/:siteId/:roomId" element={<EnabledRoomRoute />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}
