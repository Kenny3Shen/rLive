import { useSettingsStore } from "../stores/settingsStore";
import { resolveEnabledSiteId } from "../siteId";
import type { SiteId } from "../types/live";

/** Current site from settings, normalized to a known and enabled `SiteId`. */
export function useSiteId(): SiteId {
  const siteId = useSettingsStore((s) => s.siteId);
  const disabledSiteIds = useSettingsStore((s) => s.disabledSiteIds);
  return resolveEnabledSiteId(siteId, disabledSiteIds);
}
