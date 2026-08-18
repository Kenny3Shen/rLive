import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SITE_ID,
  enabledSiteIds,
  isSiteEnabled,
  LIVE_SITE_IDS,
  normalizeDisabledSiteIds,
  resolveEnabledSiteId,
  updateDisabledSiteIds,
} from "../src/shared/siteId";

describe("startup platform selection", () => {
  test("keeps every platform enabled when visibility preferences are absent", () => {
    expect(normalizeDisabledSiteIds(undefined)).toEqual([]);
    expect(enabledSiteIds(undefined)).toEqual(LIVE_SITE_IDS);
  });

  test("falls back when the selected platform has been disabled", () => {
    expect(resolveEnabledSiteId("douyin", ["douyin"])).toBe(DEFAULT_SITE_ID);
    expect(isSiteEnabled("douyin", ["douyin"])).toBe(false);
  });

  test("rejects unknown and removed platform ids", () => {
    for (const siteId of ["unknown", "kuaishou"]) {
      expect(resolveEnabledSiteId(siteId, [])).toBe(DEFAULT_SITE_ID);
      expect(isSiteEnabled(siteId, [])).toBe(false);
    }
  });

  test("never allows every platform to be switched off", () => {
    const allDisabled = normalizeDisabledSiteIds(LIVE_SITE_IDS);
    const expected = LIVE_SITE_IDS.filter((siteId) => siteId !== DEFAULT_SITE_ID);

    expect(allDisabled).toEqual(expected);
    expect(enabledSiteIds(allDisabled)).toEqual([DEFAULT_SITE_ID]);
    expect(updateDisabledSiteIds(expected, DEFAULT_SITE_ID, false)).toEqual(expected);
  });
});
