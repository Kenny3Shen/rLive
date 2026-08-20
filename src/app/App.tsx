import { lazy } from "react";
import {
  createBrowserRouter,
  createRoutesFromElements,
  Navigate,
  Outlet,
  Route,
  RouterProvider,
  useParams,
} from "react-router-dom";
import { isSiteEnabled, isSiteId } from "@/shared/siteId";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import { ErrorState } from "@/shared/components/ErrorState";
import { Shell } from "./layout/Shell";
import { AndroidBackNavigator } from "./androidBackNavigation";
import { RouteModulePreloader } from "./RouteModulePreloader";
import {
  loadCategoryPage,
  loadCategoryRoomsPage,
  loadFollowPage,
  loadHistoryPage,
  loadIptvPage,
  loadIptvPlayerPage,
  loadMultiRoomPage,
  loadRecordingsPage,
  loadRecordingPlaybackPage,
  loadRoomPage,
  loadSearchPage,
  loadSettingsPage,
} from "./routeModules";
import { HomePage } from "../features/home/HomePage";
import { IptvStartupWarmup } from "../features/iptv/IptvStartupWarmup";
import { useFollowAutoRecording } from "../features/recording/followRecording";
import { RecordingExitGuard } from "../features/recording/RecordingExitGuard";

// Keep the discovery page on the critical path, but defer secondary pages
// (especially the player and its danmaku renderer) until a route needs them.
// This substantially reduces the JS parsed before the first room grid paints.
const CategoryPage = lazy(loadCategoryPage);
const CategoryRoomsPage = lazy(loadCategoryRoomsPage);
const SearchPage = lazy(loadSearchPage);
const FollowPage = lazy(loadFollowPage);
const HistoryPage = lazy(loadHistoryPage);
const RecordingsPage = lazy(loadRecordingsPage);
const RecordingPlaybackPage = lazy(loadRecordingPlaybackPage);
const SettingsPage = lazy(loadSettingsPage);
const IptvPage = lazy(loadIptvPage);
const IptvPlayerPage = lazy(loadIptvPlayerPage);
const MultiRoomPage = lazy(loadMultiRoomPage);
const RoomPage = lazy(loadRoomPage);

/** Prevent stale links from opening a platform the user has opted out of. */
function EnabledRoomRoute() {
  const { siteId } = useParams<{ siteId: string }>();
  const disabledSiteIds = useSettingsStore((state) => state.disabledSiteIds);

  // Zustand restores this small preference from localStorage before the first
  // render. Let a deep link begin loading with that persisted value instead of
  // serially waiting for settings_get; applyFromBackend will rerender this
  // guard and redirect if the authoritative backend value disagrees.

  if (isSiteId(siteId) && !isSiteEnabled(siteId, disabledSiteIds)) {
    return <Navigate to="/" replace />;
  }

  return <RoomPage />;
}

function AppRuntime() {
  useFollowAutoRecording();

  return (
    <>
      <AndroidBackNavigator />
      <IptvStartupWarmup />
      <RouteModulePreloader />
      <RecordingExitGuard />
      <Outlet />
    </>
  );
}

const router = createBrowserRouter(
  createRoutesFromElements(
    <Route element={<AppRuntime />}>
      <Route element={<Shell />}>
        <Route index element={<HomePage />} />
        <Route path="category" element={<CategoryPage />} />
        <Route path="category/:parentId/:categoryId" element={<CategoryRoomsPage />} />
        <Route path="search" element={<SearchPage />} />
        <Route path="follow" element={<FollowPage />} />
        <Route path="history" element={<HistoryPage />} />
        <Route path="recordings" element={<RecordingsPage />} />
        <Route path="recordings/play/:recordingId" element={<RecordingPlaybackPage />} />
        <Route path="iptv/play" element={<IptvPlayerPage />} />
        <Route path="iptv" element={<IptvPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="multi-room" element={<MultiRoomPage />} />
        <Route path="room/:siteId/:roomId" element={<EnabledRoomRoute />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Route>,
  ),
);

export function App() {
  const settingsLoadError = useSettingsStore((state) => state.settingsLoadError);
  const loadFromBackend = useSettingsStore((state) => state.loadFromBackend);

  if (settingsLoadError) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background px-4 py-8">
        <ErrorState
          error={settingsLoadError}
          title="无法读取当前设置"
          onRetry={() => void loadFromBackend().catch(() => {})}
          className="w-full max-w-xl"
        />
      </main>
    );
  }

  return <RouterProvider router={router} />;
}
