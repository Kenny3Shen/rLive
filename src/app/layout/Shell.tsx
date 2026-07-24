import { useLayoutEffect, useRef } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { SiteSwitcher } from "@/shared/components/SiteSwitcher";
import { HeaderSearch } from "@/shared/components/HeaderSearch";
import { closeCurrentOverlay } from "@/features/room/overlayLifecycle";
import { stopCurrentPlayer } from "@/features/room/playerLifecycle";
import { Sidebar } from "./Sidebar";
import { cn } from "@/lib/utils";

export function Shell() {
  const { pathname } = useLocation();
  const isRoom = pathname.startsWith("/room/");
  const previousIsRoomRef = useRef(isRoom);
  const hasCommittedRef = useRef(false);
  const showSiteSwitcher =
    pathname === "/" || pathname.startsWith("/category") || pathname.startsWith("/search");

  useLayoutEffect(() => {
    const wasRoom = previousIsRoomRef.current;
    previousIsRoomRef.current = isRoom;
    const isInitialCommit = !hasCommittedRef.current;
    hasCommittedRef.current = true;

    // This runs in React's layout phase, after the room subtree is removed
    // but before the destination page can paint. Start native teardown now;
    // it must never hold up navigation waiting for a native command.
    if ((isInitialCommit && !isRoom) || (wasRoom && !isRoom)) {
      // Web player tears down on unmount; still stop legacy mpv/overlay/proxy
      // so a prior session or mid-migration path cannot leave native windows.
      void stopCurrentPlayer().catch(() => {});
      void closeCurrentOverlay().catch(() => {});
      void import("@/shared/api/tauri").then(({ invokeCmd }) => {
        void invokeCmd("player_stop", { epoch: null }).catch(() => {});
        void invokeCmd("overlay_close", { epoch: null }).catch(() => {});
        void invokeCmd("stream_proxy_stop").catch(() => {});
      });
    }
  }, [isRoom]);

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
