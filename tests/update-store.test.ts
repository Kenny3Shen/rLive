import { describe, expect, test } from "bun:test";
import { compareVersionStrings, parseVersion } from "../src/shared/update/updateStore";

describe("update version comparison", () => {
  test("accepts v-prefixed stable versions and build metadata", () => {
    expect(parseVersion("v3.3.0")).toMatchObject({
      major: 3,
      minor: 3,
      patch: 0,
      prerelease: [],
    });
    expect(parseVersion("3.3.0+20260831")).toMatchObject({
      major: 3,
      minor: 3,
      patch: 0,
      prerelease: [],
    });
  });

  test("orders patch, minor, and major releases", () => {
    expect(compareVersionStrings("3.3.1", "3.3.0")).toBe(1);
    expect(compareVersionStrings("3.4.0", "3.3.9")).toBe(1);
    expect(compareVersionStrings("4.0.0", "3.9.9")).toBe(1);
    expect(compareVersionStrings("3.3.0", "v3.3.0")).toBe(0);
    expect(compareVersionStrings("3.2.9", "3.3.0")).toBe(-1);
  });

  test("orders prereleases according to SemVer precedence", () => {
    expect(compareVersionStrings("3.3.0", "3.3.0-rc.1")).toBe(1);
    expect(compareVersionStrings("3.3.0-rc.2", "3.3.0-rc.10")).toBe(-1);
    expect(compareVersionStrings("3.3.0-alpha.1", "3.3.0-alpha.beta")).toBe(-1);
    expect(compareVersionStrings("3.3.0-alpha", "3.3.0-alpha.1")).toBe(-1);
  });

  test("rejects malformed versions and numeric identifiers with leading zeroes", () => {
    expect(parseVersion("3.3")).toBeNull();
    expect(parseVersion("3.3.0foo")).toBeNull();
    expect(parseVersion("3.03.0")).toBeNull();
    expect(parseVersion("3.3.0-rc.01")).toBeNull();
    expect(compareVersionStrings("not-a-version", "3.3.0")).toBeNull();
  });
});
