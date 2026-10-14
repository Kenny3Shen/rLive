import { expect, test } from "bun:test";
import { bilibiliAppAuthPresentation } from "../src/features/settings/SettingsPage";

const profile = { mid: "123456789012345678", expires_at: 1_900_000_000 };

test.each([
  ["valid", true, true],
  ["valid", false, false],
  ["none", false, false],
  ["expired", true, false],
  ["unknown", true, false],
] as const)("授权仅在有凭据且明确有效时生效：%s/%s", (status, has_token, active) => {
  expect(bilibiliAppAuthPresentation({ ...profile, status, has_token }).active).toBe(active);
});

test("读取/网络失败保留凭据但不冒充有效，未知状态不冒充失效", () => {
  const valid = { ...profile, status: "valid" as const, has_token: true };
  expect(bilibiliAppAuthPresentation(undefined).active).toBe(false);
  expect(bilibiliAppAuthPresentation(valid, true)).toMatchObject({
    hasToken: true,
    active: false,
    label: "读取中",
  });
  expect(bilibiliAppAuthPresentation(valid, false, true)).toMatchObject({
    hasToken: true,
    active: false,
    label: "状态待确认",
  });
  expect(bilibiliAppAuthPresentation({ ...valid, status: "expired" })).toMatchObject({
    label: "已失效",
    showUnverifiedHint: false,
  });
  expect(bilibiliAppAuthPresentation({ ...valid, status: "unknown" })).toMatchObject({
    label: "已授权，未验证",
    showUnverifiedHint: true,
  });
});
