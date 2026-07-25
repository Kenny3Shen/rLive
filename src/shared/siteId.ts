import type { SiteId } from "./types/live";

export const DEFAULT_SITE_ID: SiteId = "bilibili";

const SITE_IDS = new Set<SiteId>(["bilibili", "douyu", "huya", "douyin", "kuaishou"]);

export function isSiteId(value: unknown): value is SiteId {
  return typeof value === "string" && SITE_IDS.has(value as SiteId);
}

export function normalizeSiteId(value: unknown): SiteId {
  return isSiteId(value) ? value : DEFAULT_SITE_ID;
}

/**
 * Picks the homepage platform after Tauri settings finish loading.
 *
 * A saved backend setting is authoritative. When the backend has no settings
 * row yet, preserve a valid platform restored from Zustand/localStorage so an
 * existing user's selection is not reset to the first-run default.
 */
export function resolveStartupSiteId(
  backendSiteId: unknown,
  hasSavedBackendSettings: boolean,
  localSiteId: unknown,
): SiteId {
  return normalizeSiteId(hasSavedBackendSettings ? backendSiteId : localSiteId);
}
