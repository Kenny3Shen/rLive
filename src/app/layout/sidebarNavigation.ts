export const SIDEBAR_NAVIGATION_STATE = {
  rliveNavigationSource: "sidebar",
} as const;

const SIDEBAR_DESTINATIONS = [
  "/",
  "/follow",
  "/category",
  "/iptv",
  "/multi-room",
  "/recordings",
  "/history",
  "/settings",
];

type NavigationType = "POP" | "PUSH" | "REPLACE";

export function isSidebarNavigation(navigationType: NavigationType, state: unknown): boolean {
  if (navigationType !== "PUSH" || typeof state !== "object" || state === null) return false;

  return "rliveNavigationSource" in state && state.rliveNavigationSource === "sidebar";
}

function sidebarDestinationIndex(pathname: string): number {
  return SIDEBAR_DESTINATIONS.findIndex((destination) =>
    destination === "/"
      ? pathname === destination
      : pathname === destination || pathname.startsWith(`${destination}/`),
  );
}

/** 把侧栏自上而下的视觉顺序映射到对应的页面平移方向。 */
export function sidebarNavigationDirection(fromPathname: string, toPathname: string): 1 | -1 {
  const fromIndex = sidebarDestinationIndex(fromPathname);
  const toIndex = sidebarDestinationIndex(toPathname);

  return fromIndex >= 0 && toIndex >= 0 && toIndex < fromIndex ? -1 : 1;
}

/** 绝不让平台面板从一个底部导航目的地带入另一个。 */
export function routeScopedPreviousGroup(
  previousPathname: string,
  previousGroup: string,
  pathname: string,
  currentGroup: string,
): string {
  return previousPathname === pathname ? previousGroup : currentGroup;
}
