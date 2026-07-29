import { useEffect } from "react";
import { Outlet, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { SiteSwitcher } from "@/shared/components/SiteSwitcher";
import { HeaderSearch } from "@/shared/components/HeaderSearch";
import { categoryHomePathAfterSiteChange } from "@/features/category/categoryRoute";
import {
  FOLLOW_PLATFORM_PARAM,
  followPlatformFromSearch,
  withFollowPlatform,
} from "@/features/follow/followRoute";
import { Sidebar } from "./Sidebar";
import { AppTitleBar } from "./AppTitleBar";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import { cn } from "@/lib/utils";

export function Shell() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const isRoom = pathname.startsWith("/room/");
  const isIptvPlayer = pathname === "/iptv/play";
  const isImmersivePlayer = isRoom || isIptvPlayer;
  const isFollow = pathname === "/follow";
  const selectedSiteId = useSettingsStore((state) => state.siteId);
  const disabledSiteIds = useSettingsStore((state) => state.disabledSiteIds);
  const showSiteSwitcher =
    pathname === "/" ||
    pathname.startsWith("/category") ||
    pathname.startsWith("/search") ||
    isFollow;
  const rawFollowPlatform = followPlatformFromSearch(searchParams.get(FOLLOW_PLATFORM_PARAM));
  const followPlatform = followPlatformFromSearch(
    searchParams.get(FOLLOW_PLATFORM_PARAM),
    disabledSiteIds,
  );
  const platformForMotion = isFollow ? followPlatform : selectedSiteId;
  const pageMotionKey = isImmersivePlayer ? pathname : `${pathname}:${platformForMotion}`;
  const categoryHomePath = categoryHomePathAfterSiteChange(pathname);
  // Player routes use h-full throughout their fixed player layout.
  // `min-h-full` does not create a definite percentage-height containing
  // block, which lets a growing danmaku list reflow the whole room on narrow
  // viewports. Keep normal pages content-sized, but give player routes a fixed
  // height chain all the way down to the Outlet.
  const outletHeightClass = isImmersivePlayer ? "h-full min-h-0" : "min-h-full";

  // A manually opened URL may name a platform that has since been disabled.
  // Keep the page usable on its first render, then remove that stale filter
  // from the address bar without adding a history entry.
  useEffect(() => {
    if (!isFollow || rawFollowPlatform === followPlatform) return;
    setSearchParams((current) => withFollowPlatform(current, followPlatform), { replace: true });
  }, [followPlatform, isFollow, rawFollowPlatform, setSearchParams]);

  return (
    <div className="app-shell flex h-full min-h-0 flex-col bg-background max-md:pt-[env(safe-area-inset-top)]">
      <AppTitleBar />
      <div className="flex min-h-0 min-w-0 flex-1">
        {!isImmersivePlayer && <Sidebar />}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {!isImmersivePlayer && (
            <header
              data-slot="app-header"
              className={cn(
                "relative flex h-14 shrink-0 items-center border-b border-border-subtle px-4 max-md:h-12 max-md:gap-2 max-md:px-3",
                !showSiteSwitcher && "max-md:hidden",
              )}
            >
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center max-md:relative max-md:inset-auto max-md:min-w-0 max-md:flex-1 max-md:justify-start max-md:overflow-hidden">
                {showSiteSwitcher && (
                  <div className="pointer-events-auto max-md:min-w-max">
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
                      <SiteSwitcher
                        onValueChange={(nextSiteId) => {
                          if (nextSiteId !== selectedSiteId && categoryHomePath) {
                            navigate(categoryHomePath, { replace: true });
                          }
                        }}
                      />
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
            data-slot="app-content"
            className={cn(
              "min-h-0 min-w-0 flex-1",
              isImmersivePlayer
                ? "overflow-hidden p-0"
                : "overflow-auto p-4 pb-[calc(4.75rem+env(safe-area-inset-bottom))] md:p-5 md:pb-5",
            )}
          >
            <div
              key={pageMotionKey}
              className={cn(
                "relative",
                outletHeightClass,
                !isImmersivePlayer &&
                  "motion-safe:animate-platform-page-enter motion-reduce:animate-none",
              )}
            >
              <div className={cn("relative", outletHeightClass)}>
                <Outlet />
              </div>
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}
