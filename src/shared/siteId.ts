import type { SiteId } from "./types/live";

export const DEFAULT_SITE_ID: SiteId = "bilibili";

/**
 * 随应用打包平台的稳定展示与兜底顺序。
 *
 * 保持这份列表与 `SiteId` union 并列。平台可见性存储为停用列表，
 * 使新分发的平台默认启用。
 */
export const LIVE_SITE_IDS = [
  "bilibili",
  "douyu",
  "huya",
  "douyin",
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
 * 净化持久化的停用列表。缺失或畸形意味着所有平台启用。
 *
 * 最后一个平台保持启用作为本地安全网。Rust 在持久化设置对象前执行相同规则。
 */
export function normalizeDisabledSiteIds(value: unknown): SiteId[] {
  if (!Array.isArray(value)) return [];

  const requested = new Set(value.filter(isSiteId));
  const disabled = LIVE_SITE_IDS.filter((siteId) => requested.has(siteId));

  if (disabled.length < LIVE_SITE_IDS.length) return disabled;
  return disabled.filter((siteId) => siteId !== DEFAULT_SITE_ID);
}

/** 列出应用持久化停用后仍然可见的平台。 */
export function enabledSiteIds(disabledSiteIds: unknown): SiteId[] {
  const disabled = new Set(normalizeDisabledSiteIds(disabledSiteIds));
  return LIVE_SITE_IDS.filter((siteId) => !disabled.has(siteId));
}

/** 已知平台当前是否启用。 */
export function isSiteEnabled(siteId: unknown, disabledSiteIds: unknown): siteId is SiteId {
  return isSiteId(siteId) && enabledSiteIds(disabledSiteIds).includes(siteId);
}

/**
 * 把请求的平台解析为已启用的平台。过期的链接与点名已停用平台的设置
 * 使用稳定的第一个已启用平台。
 */
export function resolveEnabledSiteId(value: unknown, disabledSiteIds: unknown): SiteId {
  const enabled = enabledSiteIds(disabledSiteIds);
  const requested = normalizeSiteId(value);
  return enabled.includes(requested) ? requested : enabled[0]!;
}

/** 切换单个平台开关，同时保持至少一个平台启用的不变量。 */
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
