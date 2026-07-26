import type { SiteId } from "./types/live";

export const DEFAULT_SITE_ID: SiteId = "bilibili";

/**
 * Stable display and fallback order for the platforms bundled with the app.
 *
 * Keep this list alongside the `SiteId` union. Platform visibility is stored
 * as a disabled list so a newly shipped platform is enabled by default for
 * existing settings records.
 */
export const LIVE_SITE_IDS = [
  "bilibili",
  "douyu",
  "huya",
  "douyin",
  "kuaishou",
  "twitch",
] as const satisfies readonly SiteId[];

const SITE_IDS = new Set<SiteId>(LIVE_SITE_IDS);

export function isSiteId(value: unknown): value is SiteId {
  return typeof value === "string" && SITE_IDS.has(value as SiteId);
}

export function normalizeSiteId(value: unknown): SiteId {
  return isSiteId(value) ? value : DEFAULT_SITE_ID;
}

/**
 * Sanitizes the persisted opt-out list. Old settings do not have this field,
 * so an absent or malformed value deliberately means every platform is on.
 *
 * The final active platform is kept enabled as a local safety net. Rust
 * applies the same rule before it persists a settings object.
 */
export function normalizeDisabledSiteIds(value: unknown): SiteId[] {
  if (!Array.isArray(value)) return [];

  const requested = new Set(value.filter(isSiteId));
  const disabled = LIVE_SITE_IDS.filter((siteId) => requested.has(siteId));

  if (disabled.length < LIVE_SITE_IDS.length) return disabled;
  return disabled.filter((siteId) => siteId !== DEFAULT_SITE_ID);
}

/** Lists the platforms that remain visible after applying persisted opt-outs. */
export function enabledSiteIds(disabledSiteIds: unknown): SiteId[] {
  const disabled = new Set(normalizeDisabledSiteIds(disabledSiteIds));
  return LIVE_SITE_IDS.filter((siteId) => !disabled.has(siteId));
}

/** Whether a known platform is currently enabled. */
export function isSiteEnabled(siteId: unknown, disabledSiteIds: unknown): siteId is SiteId {
  return isSiteId(siteId) && enabledSiteIds(disabledSiteIds).includes(siteId);
}

/**
 * Resolves a requested platform to an enabled one. The stable first enabled
 * platform is used for stale links and legacy settings that name an opt-out.
 */
export function resolveEnabledSiteId(value: unknown, disabledSiteIds: unknown): SiteId {
  const enabled = enabledSiteIds(disabledSiteIds);
  const requested = normalizeSiteId(value);
  return enabled.includes(requested) ? requested : enabled[0]!;
}

/**
 * Applies one platform toggle while preserving the invariant that at least
 * one platform stays enabled.
 */
export function updateDisabledSiteIds(
  disabledSiteIds: unknown,
  siteId: SiteId,
  enabled: boolean,
): SiteId[] {
  const current = normalizeDisabledSiteIds(disabledSiteIds);
  const disabled = new Set(current);

  if (enabled) {
    disabled.delete(siteId);
  } else if (enabledSiteIds(current).length > 1) {
    disabled.add(siteId);
  }

  return normalizeDisabledSiteIds([...disabled]);
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
  disabledSiteIds: unknown = [],
): SiteId {
  return resolveEnabledSiteId(
    hasSavedBackendSettings ? backendSiteId : localSiteId,
    disabledSiteIds,
  );
}
