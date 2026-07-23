import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { Shell } from "./layout/Shell";
import { HomePage } from "../features/home/HomePage";
import { CategoryPage } from "../features/category/CategoryPage";
import { SearchPage } from "../features/search/SearchPage";
import { FollowPage } from "../features/follow/FollowPage";
import { HistoryPage } from "../features/history/HistoryPage";
import { SettingsPage } from "../features/settings/SettingsPage";
import { RoomPage } from "../features/room/RoomPage";

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Shell />}>
          <Route index element={<HomePage />} />
          <Route path="category" element={<CategoryPage />} />
          <Route path="search" element={<SearchPage />} />
          <Route path="follow" element={<FollowPage />} />
          <Route path="history" element={<HistoryPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="room/:siteId/:roomId" element={<RoomPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
