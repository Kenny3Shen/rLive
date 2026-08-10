import { describe, expect, test } from "bun:test";
import { showExplicitThemeSettings } from "../src/features/settings/SettingsPage";

describe("settings platform presentation", () => {
  test("removes the explicit theme setting from mobile only", () => {
    expect(showExplicitThemeSettings(true)).toBe(false);
    expect(showExplicitThemeSettings(false)).toBe(true);
  });
});
