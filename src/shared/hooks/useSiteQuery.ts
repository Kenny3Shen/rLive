import { createContext, createElement, useContext, type ReactNode } from "react";
import { useSettingsStore } from "../stores/settingsStore";
import { resolveEnabledSiteId } from "../siteId";
import type { SiteId } from "../types/live";

export type PlatformScopeValue = SiteId | "all";

const PlatformScopeContext = createContext<PlatformScopeValue | null>(null);

export function PlatformScope({
  value,
  children,
}: {
  value: PlatformScopeValue;
  children: ReactNode;
}) {
  return createElement(PlatformScopeContext.Provider, { value }, children);
}

/** 页面被保活时返回过渡捕获的平台。 */
export function usePlatformScope(): PlatformScopeValue | null {
  return useContext(PlatformScopeContext);
}

/** 来自设置的当前站点，归一化为已知且启用的 `SiteId`。 */
export function useSiteId(): SiteId {
  const siteId = useSettingsStore((s) => s.siteId);
  const disabledSiteIds = useSettingsStore((s) => s.disabledSiteIds);
  const scopedPlatform = usePlatformScope();
  return resolveEnabledSiteId(scopedPlatform ?? siteId, disabledSiteIds);
}
