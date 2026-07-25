import { describe, expect, test } from "bun:test";
import { resolveStartupSiteId } from "../src/shared/siteId";

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
});
