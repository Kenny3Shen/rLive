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

/** Returns the platform captured by a transition, when a page is being kept alive. */
export function usePlatformScope(): PlatformScopeValue | null {
  return useContext(PlatformScopeContext);
}

/** Current site from settings, normalized to a known and enabled `SiteId`. */
export function useSiteId(): SiteId {
  const siteId = useSettingsStore((s) => s.siteId);
  const disabledSiteIds = useSettingsStore((s) => s.disabledSiteIds);
  const scopedPlatform = usePlatformScope();
  return resolveEnabledSiteId(scopedPlatform ?? siteId, disabledSiteIds);
}
