import { Outlet } from "react-router-dom";
import { Sidebar } from "./Sidebar";

export function Shell() {
  return (
    <div className="flex h-full min-h-0">
      <Sidebar />
      <main className="min-w-0 flex-1 overflow-auto p-4">
        <Outlet />
      </main>
    </div>
  );
}
