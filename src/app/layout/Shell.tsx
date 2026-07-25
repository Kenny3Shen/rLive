import { useLayoutEffect, useRef } from "react";
import { Outlet, useLocation, useSearchParams } from "react-router-dom";
import { SiteSwitcher } from "@/shared/components/SiteSwitcher";
import { HeaderSearch } from "@/shared/components/HeaderSearch";
import { invokeCmd } from "@/shared/api/tauri";
import {
  FOLLOW_PLATFORM_PARAM,
  followPlatformFromSearch,
  withFollowPlatform,
} from "@/features/follow/followRoute";
import { Sidebar } from "./Sidebar";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import { cn, SITE_ACCENT } from "@/lib/utils";

export function Shell() {
  const { pathname } = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const isRoom = pathname.startsWith("/room/");
  const isFollow = pathname === "/follow";
  const selectedSiteId = useSettingsStore((state) => state.siteId);
  const previousIsRoomRef = useRef(isRoom);
  const hasCommittedRef = useRef(false);
  const showSiteSwitcher =
    pathname === "/" ||
    pathname.startsWith("/category") ||
    pathname.startsWith("/search") ||
    isFollow;
  const followPlatform = followPlatformFromSearch(searchParams.get(FOLLOW_PLATFORM_PARAM));
  const platformForMotion = isFollow ? followPlatform : selectedSiteId;
  const pageMotionKey = isRoom ? pathname : `${pathname}:${platformForMotion}`;
  const platformAccent = SITE_ACCENT[platformForMotion] ?? "#6c8cff";

  useLayoutEffect(() => {
    const wasRoom = previousIsRoomRef.current;
    previousIsRoomRef.current = isRoom;
    const isInitialCommit = !hasCommittedRef.current;
    hasCommittedRef.current = true;

    // Stop the localhost media proxy when leaving a room (belt-and-suspenders
    // for unmount races). Web player destroy also calls this.
    if ((isInitialCommit && !isRoom) || (wasRoom && !isRoom)) {
      void invokeCmd("stream_proxy_stop").catch(() => {});
    }
  }, [isRoom]);

  return (
    <div className="flex h-full min-h-0">
      {!isRoom && <Sidebar />}
      <div className="flex min-w-0 flex-1 flex-col">
        {!isRoom && (
          <header className="relative flex h-14 shrink-0 items-center border-b border-border-subtle px-4">
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              {showSiteSwitcher && (
                <div className="pointer-events-auto">
                  {isFollow ? (
                    <SiteSwitcher
                      value={followPlatform}
                      includeAll
                      filterMode
                      onValueChange={(platform) =>
                        setSearchParams((current) => withFollowPlatform(current, platform))
                      }
                    />
                  ) : (
                    <SiteSwitcher />
                  )}
                </div>
              )}
            </div>
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
          <div
            key={pageMotionKey}
            className={cn(
              "relative min-h-full",
              !isRoom && "motion-safe:animate-platform-page-enter motion-reduce:animate-none",
            )}
          >
            {!isRoom && (
              <div
                aria-hidden
                className="pointer-events-none absolute inset-x-0 top-0 h-24 opacity-70"
                style={{
                  background: `linear-gradient(112deg, ${platformAccent}1f, ${platformAccent}08 30%, transparent 68%)`,
                }}
              />
            )}
            <div className="relative min-h-full">
              <Outlet />
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
