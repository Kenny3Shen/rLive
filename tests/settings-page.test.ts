import { describe, expect, test } from "bun:test";
import {
  settingsCategoryValuesForClient,
  settingsOverviewGroupedKeys,
  settingsOverviewKeysForClient,
  settingsPageMotion,
} from "../src/features/settings/SettingsPage";
import { TAURI_UNAVAILABLE_ERROR_CODE, invokeCmd } from "../src/shared/api/tauri";

describe("settings platform presentation", () => {
  test("keeps the appearance section available on every client", () => {
    expect(settingsCategoryValuesForClient(true)).toContain("appearance");
    expect(settingsCategoryValuesForClient(false)).toContain("appearance");
    expect(settingsPageMotion("appearance", true)).toEqual({
      category: "appearance",
      key: "settings:appearance",
      direction: 1,
    });
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

  test("lists the history route entry in the overview on every client", () => {
    // 历史仍是独立路由（有自己的时间线与头部控件），概览只提供入口而非二级面板。
    expect(settingsOverviewKeysForClient(true)).toContain("history");
    expect(settingsOverviewKeysForClient(false)).toContain("history");
    expect(settingsPageMotion("history")).toEqual({
      category: null,
      key: "settings:overview",
      direction: -1,
    });
  });

  test("keeps every category panel reachable from the overview", () => {
    for (const mobileClient of [true, false]) {
      const keys = settingsOverviewKeysForClient(mobileClient);
      for (const category of settingsCategoryValuesForClient(mobileClient)) {
        expect(keys).toContain(category);
      }
    }
    expect(settingsOverviewKeysForClient(true)).not.toContain("recording");
  });

  test("files every overview entry into exactly one group", () => {
    // 分组的 values 是字符串，写错的 key 只会让条目从概览里消失而不报错。
    const grouped = settingsOverviewGroupedKeys();
    expect([...grouped].sort()).toEqual([...settingsOverviewKeysForClient(false)].sort());
    expect(new Set(grouped).size).toBe(grouped.length);
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
