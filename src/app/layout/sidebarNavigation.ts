import type { ComponentType } from "react";
import { Clapperboard, Heart, History, Home, PanelsTopLeft, Settings, Tv, Videotape } from "lucide-react";

export const SIDEBAR_NAVIGATION_STATE = {
  rliveNavigationSource: "sidebar",
} as const;

export type SidebarNavItem = {
  to: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  end?: boolean;
  className?: string;
  /** 桌面级客户端专属入口。移动客户端在任何视口宽度下都不渲染它：
   *  手机与平板横屏的视口宽度普遍超过 md 断点，
   *  仅靠 `max-md:hidden` 这类视口门控会让它们漏进移动端底部导航。 */
  desktopOnly?: boolean;
  /** 桌面竖栏中归入底部分组（亮暗切换之后）的入口。数组顺序仍须与
   *  SIDEBAR_DESTINATIONS 方向条带一致：移动端底栏里它们保持行内顺序，
   *  桌面竖栏里它们被 `mt-auto` 推到底部聚类。 */
  footer?: boolean;
};

export const SIDEBAR_NAV_ITEMS: SidebarNavItem[] = [
  // 分类浏览已合并进首页的 sticky 分类条，不再占一个导航目的地。
  { to: "/", label: "首页", icon: Home, end: true },
  { to: "/follow", label: "关注", icon: Heart },
  // B 站视频（VOD）。它不是直播平台中的一个，因此是自己的目的地而不是
  // 首页平台条上的一项 —— 首页那条条带完全不动。
  { to: "/video", label: "视频", icon: Clapperboard },
  { to: "/iptv", label: "IPTV", icon: Tv },
  {
    to: "/multi-room",
    label: "多画面",
    icon: PanelsTopLeft,
    className: "max-md:hidden",
    desktopOnly: true,
  },
  {
    to: "/recordings",
    label: "录制",
    icon: Videotape,
    className: "max-md:hidden",
    desktopOnly: true,
  },
  // 历史已收进「设置 → 观看记录」，移动端不再占一个底栏目的地；
  // 桌面端保留这个快捷入口，点击直达 `/history`。
  {
    to: "/history",
    label: "历史",
    icon: History,
    className: "max-md:hidden",
    desktopOnly: true,
    footer: true,
  },
  { to: "/settings", label: "设置", icon: Settings, footer: true },
];

/** 按客户端平台解析可见的侧栏导航入口。 */
export function sidebarNavItemsFor(mobileClient: boolean): SidebarNavItem[] {
  return mobileClient ? SIDEBAR_NAV_ITEMS.filter((item) => !item.desktopOnly) : SIDEBAR_NAV_ITEMS;
}

/**
 * 方向条带。顺序必须与 `SIDEBAR_NAV_ITEMS` 的视觉顺序一致：它决定换页平移的方向，
 * 漏一项就会让那个目的地的进出方向错。
 */
const SIDEBAR_DESTINATIONS = [
  "/",
  "/follow",
  "/video",
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
