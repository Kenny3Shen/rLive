import { Outlet } from "react-router-dom";
import { SiteSwitcher } from "../../shared/components/SiteSwitcher";
import { Sidebar } from "./Sidebar";

export function Shell() {
  return (
    <div className="flex h-full min-h-0">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center border-b border-zinc-200 px-4 py-2 dark:border-zinc-800">
          <SiteSwitcher />
        </header>
        <main className="min-w-0 flex-1 overflow-auto p-4">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
