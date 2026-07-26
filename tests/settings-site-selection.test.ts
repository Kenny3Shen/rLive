import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SITE_ID,
  enabledSiteIds,
  isSiteEnabled,
  LIVE_SITE_IDS,
  normalizeDisabledSiteIds,
  resolveEnabledSiteId,
  resolveStartupSiteId,
  updateDisabledSiteIds,
} from "../src/shared/siteId";

describe("startup platform selection", () => {
  test("opens Bilibili for a first run with no local or backend setting", () => {
    expect(resolveStartupSiteId(undefined, false, undefined)).toBe("bilibili");
  });

  test("keeps a valid local platform choice when the backend has never saved settings", () => {
    expect(resolveStartupSiteId("bilibili", false, "douyu")).toBe("douyu");
  });

  test("uses an existing backend setting instead of overwriting it from local cache", () => {
    expect(resolveStartupSiteId("huya", true, "douyu")).toBe("huya");
  });

  test("falls back to Bilibili for malformed platform values", () => {
    expect(resolveStartupSiteId("unknown", true, "douyu")).toBe("bilibili");
    expect(resolveStartupSiteId("douyu", false, "unknown")).toBe("bilibili");
  });

  test("keeps every platform enabled when legacy settings omit visibility preferences", () => {
    expect(normalizeDisabledSiteIds(undefined)).toEqual([]);
    expect(enabledSiteIds(undefined)).toEqual(LIVE_SITE_IDS);
  });

  test("falls back when the selected platform has been disabled", () => {
    expect(resolveEnabledSiteId("kuaishou", ["kuaishou"])).toBe(DEFAULT_SITE_ID);
    expect(resolveStartupSiteId("kuaishou", true, "douyu", ["kuaishou"])).toBe(DEFAULT_SITE_ID);
    expect(isSiteEnabled("kuaishou", ["kuaishou"])).toBe(false);
  });

  test("never allows every platform to be switched off", () => {
    const allDisabled = normalizeDisabledSiteIds(LIVE_SITE_IDS);
    const expected = LIVE_SITE_IDS.filter((siteId) => siteId !== DEFAULT_SITE_ID);

    expect(allDisabled).toEqual(expected);
    expect(enabledSiteIds(allDisabled)).toEqual([DEFAULT_SITE_ID]);
    expect(updateDisabledSiteIds(expected, DEFAULT_SITE_ID, false)).toEqual(expected);
  });
});
