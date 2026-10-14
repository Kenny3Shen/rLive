// TV 扫码授权的失效检测：错误码分类、设置页呈现与启动期提示。
//
// 背景（实测）：上游 feed 对无效令牌返回 `code=0`，静默降级为匿名流，因此
// 推荐页永远不会因凭据失效而报错。失效只能在 `oauth2/info` 校验路径识别，
// 并以 `bilibili_app_auth_required` 返回。这里固定三件事：
//
// 1. `auth_required`（确定失效）与 `auth_unavailable`（无法确认）不能混为一谈；
//    前者必须给用户重新扫码的入口，后者只应重试。
// 2. 启动期检查只在「凭据存在且服务端明确拒绝」时提示，不自动清除凭据。
// 3. `unknown` 状态不冒充失效 —— 网络抖动把用户骗去重新扫码是净损失。
import { describe, expect, test } from "bun:test";
import {
  BILIBILI_APP_AUTH_REQUIRED,
  BILIBILI_APP_AUTH_UNAVAILABLE,
  isBilibiliAppAuthRequired,
} from "../src/shared/api/bilibiliAppProfile";
describe("APP 授权失效的错误码判定", () => {
  test("只有 auth_required 被当作需要重新授权", () => {
    expect(
      isBilibiliAppAuthRequired({
        code: BILIBILI_APP_AUTH_REQUIRED,
      }),
    ).toBe(true);
    expect(
      isBilibiliAppAuthRequired({
        code: BILIBILI_APP_AUTH_UNAVAILABLE,
      }),
    ).toBe(false);
  });
  test("网络类失败不得冒充凭据失效", () => {
    // 把网络失败当失效，用户会被引导去重新扫码，而凭据其实还能用。
    for (const error of [
      {
        code: "bilibili_app_auth_unavailable",
      },
      {
        code: "bilibili_app_feed_device",
      },
      {
        code: "invoke_failed",
      },
      {
        code: "tauri_unavailable",
      },
      new Error("network down"),
      null,
      undefined,
      "bilibili_app_auth_required",
    ]) {
      expect(isBilibiliAppAuthRequired(error)).toBe(false);
    }
  });
});
