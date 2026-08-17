import { describe, expect, test } from "bun:test";
import {
  settingsCategoryValuesForClient,
  settingsPageMotion,
  showExplicitThemeSettings,
} from "../src/features/settings/SettingsPage";
import { TAURI_UNAVAILABLE_ERROR_CODE, invokeCmd } from "../src/shared/api/tauri";

describe("settings platform presentation", () => {
  test("removes the explicit theme setting from mobile only", () => {
    expect(showExplicitThemeSettings(true)).toBe(false);
    expect(showExplicitThemeSettings(false)).toBe(true);
  });

  test("moves forward into a section and backward to the overview", () => {
    expect(settingsPageMotion(null)).toEqual({
      category: null,
      key: "settings:overview",
      direction: -1,
    });
    expect(settingsPageMotion("playback")).toEqual({
      category: "playback",
      key: "settings:playback",
      direction: 1,
    });
    expect(settingsPageMotion("recording")).toEqual({
      category: "recording",
      key: "settings:recording",
      direction: 1,
    });
  });

  test("keeps desktop-only recording settings out of the mobile page", () => {
    expect(settingsCategoryValuesForClient(false)).toContain("recording");
    expect(settingsCategoryValuesForClient(true)).not.toContain("recording");
    expect(settingsPageMotion("recording", true)).toEqual({
      category: null,
      key: "settings:overview",
      direction: -1,
    });
  });

  test("treats an unknown section as the overview", () => {
    expect(settingsPageMotion("unknown")).toEqual({
      category: null,
      key: "settings:overview",
      direction: -1,
    });
  });

  test("reports a readable error outside the Tauri runtime", async () => {
    await expect(invokeCmd("settings_get")).rejects.toMatchObject({
      code: TAURI_UNAVAILABLE_ERROR_CODE,
      message: "当前页面未连接 rLive 客户端，请在 rLive 客户端中使用此功能。",
      retryable: false,
    });
  });
});
