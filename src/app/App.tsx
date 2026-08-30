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
import { UpdateChecker } from "../features/update/UpdatePrompt";

// 让发现页保持在关键路径上，把次要页面（尤其是播放器及其弹幕渲染器）
// 推迟到路由真正需要时再加载。
// 这能显著减少首屏房间网格绘制前需要解析的 JS 量。
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

/** 防止过期链接打开用户已选择隐藏的平台。 */
function EnabledRoomRoute() {
  const { siteId } = useParams<{ siteId: string }>();
  const disabledSiteIds = useSettingsStore((state) => state.disabledSiteIds);

  // Zustand 会在首次渲染之前从 localStorage 恢复这个轻量偏好。让深链接直接以
  // 该持久化值开始加载，而不是串行等待 settings_get；
  // 若后端的权威取值不一致，applyFromBackend 会重新渲染这道守卫并重定向。

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
      <UpdateChecker />
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
        {/* 录制 id 跨越两级路径（`platform_room/user_time`），
            因此路由为每级携带一个段。单个 `:recordingId`
            会收到半解码的参数，永远匹配不到库条目。 */}
        <Route path="recordings/play/:roomDir/:sessionDir" element={<RecordingPlaybackPage />} />
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
