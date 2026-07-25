import { useSettingsStore } from "../stores/settingsStore";
import { normalizeSiteId } from "../siteId";
import type { SiteId } from "../types/live";

/** Current site from settings, normalized to a known `SiteId`. */
export function useSiteId(): SiteId {
  const siteId = useSettingsStore((s) => s.siteId);
  return normalizeSiteId(siteId);
}
