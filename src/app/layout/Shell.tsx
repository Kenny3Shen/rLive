import { Outlet, useLocation } from "react-router-dom";
import { SiteSwitcher } from "@/shared/components/SiteSwitcher";
import { HeaderSearch } from "@/shared/components/HeaderSearch";
import { Sidebar } from "./Sidebar";
import { cn } from "@/lib/utils";

export function Shell() {
  const { pathname } = useLocation();
  const isRoom = pathname.startsWith("/room/");
  const showSiteSwitcher =
    pathname === "/" ||
    pathname.startsWith("/category") ||
    pathname.startsWith("/search");

  return (
    <div className="flex h-full min-h-0">
      {!isRoom && <Sidebar />}
      <div className="flex min-w-0 flex-1 flex-col">
        {!isRoom && (
          <header className="relative flex h-14 shrink-0 items-center border-b border-border-subtle px-4">
            {/* Center: platform tabs (home / category / search) */}
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              {showSiteSwitcher && (
                <div className="pointer-events-auto">
                  <SiteSwitcher />
                </div>
              )}
            </div>
            {/* Right: search */}
            <div className="relative z-10 ml-auto flex items-center">
              <HeaderSearch />
            </div>
          </header>
        )}
        <main
          className={cn(
            "min-w-0 flex-1",
            isRoom ? "overflow-hidden p-0" : "overflow-auto p-4 md:p-5",
          )}
        >
          <Outlet />
        </main>
      </div>
    </div>
  );
}
