// F-01：账号状态可信度与非破坏性恢复。
//
// 验收要求覆盖：Unknown/临时错误不清 Cookie，明确未登录才删除；
// 「已登录但无可展示名字」不能被当成失效。这些断言直接约束会删除用户凭据的路径。
import { describe, expect, test } from "bun:test";

import {
  type AccountStatus,
  accountPresentation,
} from "../src/features/settings/accountPresentation";

describe("账号状态呈现", () => {
  test("未登录与读取中有各自的状态，且都不会触发清理", () => {
    const none = accountPresentation("none", false, false);
    expect(none.label).toBe("未登录");
    expect(none.tone).toBe("outline");
    expect(none.autoClearCookie).toBe(false);

    const loading = accountPresentation("valid", true, true);
    expect(loading.label).toBe("读取中");
    expect(loading.autoClearCookie).toBe(false);
  });

  test("只有平台明确拒绝才允许自动清理凭据", () => {
    const expired = accountPresentation("expired", true, false);
    expect(expired.label).toBe("已失效");
    expect(expired.tone).toBe("destructive");
    expect(expired.autoClearCookie).toBe(true);
  });

  test("unknown 显示为「已保存，未验证」且绝不清理凭据", () => {
    // 网络失败、风控、平台不支持验证都会走到这里。删掉 Cookie 会丢掉
    // 用户可能仍然可用的凭据，因此这里必须是 false。
    const unknown = accountPresentation("unknown", true, false);
    expect(unknown.label).toBe("已保存，未验证");
    expect(unknown.tone).not.toBe("destructive");
    expect(unknown.showUnverifiedHint).toBe(true);
    expect(unknown.autoClearCookie).toBe(false);
  });

  test("valid 但没有可展示名字仍是已登录", () => {
    // 后端现在只在 isLogin=true 时给 Valid；uname 缺失只是没有名字。
    const valid = accountPresentation("valid", true, false);
    expect(valid.label).toBe("已登录");
    expect(valid.tone).toBe("secondary");
    expect(valid.autoClearCookie).toBe(false);
    expect(valid.showUnverifiedHint).toBe(false);
  });

  test("没有 Cookie 时任何状态都不会触发清理", () => {
    const statuses: AccountStatus[] = ["none", "valid", "expired", "unknown"];
    for (const status of statuses) {
      expect(accountPresentation(status, false, false).autoClearCookie).toBe(false);
    }
  });

  test("整个状态空间里，允许自动清理的只有 expired + 有 Cookie", () => {
    const statuses: AccountStatus[] = ["none", "valid", "expired", "unknown"];
    for (const status of statuses) {
      for (const hasCookie of [false, true]) {
        for (const loading of [false, true]) {
          const result = accountPresentation(status, hasCookie, loading);
          const shouldClear = !loading && status === "expired" && hasCookie;
          expect(result.autoClearCookie).toBe(shouldClear);
          // 破坏性语气也只能留给这一种情况。
          if (result.tone === "destructive") {
            expect(shouldClear).toBe(true);
          }
        }
      }
    }
  });
});
