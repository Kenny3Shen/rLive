import { describe, expect, test } from "bun:test";
import { TAURI_UNAVAILABLE_ERROR_CODE, invokeCmd } from "../src/shared/api/tauri";
describe("settings platform presentation", () => {
  test("reports a readable error outside the Tauri runtime", async () => {
    await expect(invokeCmd("settings_get")).rejects.toMatchObject({
      code: TAURI_UNAVAILABLE_ERROR_CODE,
      message: "当前页面未连接 rLive 客户端，请在 rLive 客户端中使用此功能。",
      retryable: false,
    });
  });
});
