import { useSettingsStore } from "../stores/settingsStore";
import type { SiteId } from "../types/live";

const SITE_IDS: SiteId[] = ["bilibili", "huya", "douyu", "douyin", "kuaishou"];

function isSiteId(v: string): v is SiteId {
  return (SITE_IDS as string[]).includes(v);
}

/** Current site from settings, normalized to a known `SiteId`. */
export function useSiteId(): SiteId {
  const siteId = useSettingsStore((s) => s.siteId);
  return isSiteId(siteId) ? siteId : "bilibili";
}
