import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  BilibiliAppAuthField,
  bilibiliAppAuthPresentation,
  settingsCategorySearchText,
} from "../src/features/settings/SettingsPage";

const source = readFileSync(
  new URL("../src/features/settings/SettingsPage.tsx", import.meta.url),
  "utf8",
);
const appFieldSource = source.slice(
  source.indexOf("export function BilibiliAppAuthField"),
  source.indexOf("export function AccountCard"),
);
const validProfile = {
  status: "valid" as const,
  has_token: true,
  mid: "123456789012345678",
  expires_at: 1_900_000_000,
};

type Profile = NonNullable<Parameters<typeof bilibiliAppAuthPresentation>[0]>;

function renderProfile(profile: Profile, error?: Error) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { staleTime: Infinity, retry: false, retryOnMount: false, refetchOnMount: false },
    },
  });
  const queryKey = ["bilibili_app_profile"];
  queryClient.setQueryData(queryKey, profile);
  if (error) {
    queryClient.getQueryCache().find({ queryKey })!.setState({ status: "error", error });
  }
  try {
    return renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(BilibiliAppAuthField),
      ),
    );
  } finally {
    queryClient.clear();
  }
}

/**
 * 「授权即启用」是这次改动的核心契约：没有单独开关，凭据就是唯一事实来源。
 *
 * 这里的 `active` 决定 UI 是否宣称个性化正在生效。它必须同时要求「有凭据」与
 * 「校验通过」——只看 `has_token` 会让过期凭据被显示成可用，而只看状态会在
 * 网络失败时把未知当成有效。
 */
describe("B站 App 授权状态", () => {
  test("未取得状态或未保存凭据时都不算生效", () => {
    expect(bilibiliAppAuthPresentation(undefined).active).toBe(false);
    expect(
      bilibiliAppAuthPresentation({ ...validProfile, has_token: false, status: "none" }),
    ).toEqual({ hasToken: false, active: false, label: "未授权" });
    expect(bilibiliAppAuthPresentation({ ...validProfile, has_token: false }).active).toBe(false);
  });

  test("只有明确有效且已保存的凭据算生效", () => {
    expect(bilibiliAppAuthPresentation(validProfile)).toEqual({
      hasToken: true,
      active: true,
      label: "已启用个性化",
    });
    for (const status of ["none", "expired", "unknown"] as const) {
      const result = bilibiliAppAuthPresentation({ ...validProfile, status });
      expect(result.hasToken).toBe(true);
      expect(result.active).toBe(false);
      expect(result.label).not.toBe("已启用个性化");
    }
  });

  test("刷新中或网络失败不冒充生效，也不丢失已有凭据状态", () => {
    expect(bilibiliAppAuthPresentation(validProfile, true)).toEqual({
      hasToken: true,
      active: false,
      label: "正在读取…",
    });
    expect(bilibiliAppAuthPresentation(validProfile, false, true)).toEqual({
      hasToken: true,
      active: false,
      label: "状态待确认",
    });
  });

  test("无授权时展示扫码与刷新入口，且不存在个性化开关", () => {
    const html = renderProfile({ status: "none", has_token: false, mid: null, expires_at: null });
    expect(html).toContain("未授权");
    expect(html).toContain("扫码授权");
    expect(html).toContain("刷新状态");
    expect(html).not.toContain("启用 App 个性化推荐");
    expect(html).not.toContain('role="switch"');
  });

  test("有效账号展示独立 UID、日期，并声明个性化已启用", () => {
    const html = renderProfile(validProfile);
    expect(html).toContain("独立 TV 账号");
    expect(html).toContain(validProfile.mid);
    expect(html).toContain(new Date(validProfile.expires_at * 1_000).toLocaleDateString("zh-CN"));
    expect(html).toContain("已启用个性化");
    expect(html).toContain("重新扫码");
    expect(html).not.toContain('role="switch"');
  });

  test("已失效或未知授权仍显示账号信息及重新扫码入口", () => {
    for (const status of ["expired", "unknown"] as const) {
      const html = renderProfile({ ...validProfile, status });
      expect(html).toContain(status === "expired" ? "已失效" : "状态待确认");
      expect(html).toContain(validProfile.mid);
      expect(html).toContain("重新扫码");
      expect(html).not.toContain("已启用个性化");
    }
  });

  test("状态刷新失败展示 FieldError，保留 UID 且不宣称生效", () => {
    const html = renderProfile(validProfile, new Error("网络暂不可用"));
    expect(html).toContain("网络暂不可用");
    expect(html).toContain('data-slot="field-error"');
    expect(html).toContain(validProfile.mid);
    expect(html).toContain("状态待确认");
    expect(html).not.toContain("已启用个性化");
  });

  test("明确告知影响范围、存储和到期限制", () => {
    const html = renderProfile(validProfile);
    for (const text of [
      "App 推荐与 story",
      "不影响 Web 推荐",
      "不会替换 Web Cookie",
      "授权后立即用于",
      "SQLite",
      "未额外加密",
      "不随配置导出或同步",
      "180 天",
      "自动用刷新令牌续期",
      "无需重新扫码",
      "不会静默降级为匿名流",
      "移除 App 授权",
    ]) {
      expect(html).toContain(text);
    }
  });
});

// 与现有源码契约测试保持一致：约束 IPC 路由与隔离边界，避免无 DOM 的 Bun
// 测试伪造成功扫码。真实扫码和延迟响应仍需主窗口集成验证。
describe("B站 App 授权接线边界", () => {
  test("复用二维码组件，Web 默认值不变，start/poll 都携带 loginKind", () => {
    const qrSource = source.slice(
      source.indexOf("function QrLogin"),
      source.indexOf("export function BilibiliAppAuthField"),
    );
    expect(qrSource).toContain('loginKind = "web"');
    expect(qrSource).toContain('loginKind?: "web" | "bilibili_app"');
    expect(qrSource).toMatch(/"account_qr_login_start",\s*\{\s*siteId,\s*loginKind,/);
    expect(qrSource).toMatch(/"account_qr_login_poll",\s*\{\s*siteId,\s*loginKind,/);
    expect(qrSource).toContain("epoch !== epochRef.current");
    expect(appFieldSource).toMatch(
      /<QrLogin\s+siteId="bilibili"\s+siteName="哔哩哔哩"\s+loginKind="bilibili_app"/,
    );
  });

  test("独立 Section 不混入 Web AccountCard，也不调用 Cookie 更新", () => {
    expect(source).toMatch(/<Section title="B站 App 个性化推荐">\s*<BilibiliAppAuthField \/>/);
    for (const forbidden of [
      "account_set_cookie",
      "account_clear_cookie",
      "applySavedCookie",
      "markDanmakuCookieChanged",
      "invalidateCookieDependentSiteQueries",
    ]) {
      expect(appFieldSource).not.toContain(forbidden);
    }
    expect(appFieldSource).toContain("invalidateBilibiliAppQueries(queryClient)");
    expect(appFieldSource.match(/bumpRevision\(\)/g)).toHaveLength(2);
  });

  test("扫码成功即生效，不再需要写个性化开关", () => {
    // 旧的严格开关提交路径整体删除：授权变更后只刷新凭据与推荐缓存。
    expect(appFieldSource).not.toContain("setBilibiliAppPersonalization");
    expect(appFieldSource).not.toContain("account_bilibili_app_set_enabled");
    expect(appFieldSource).not.toContain("switchError");
    expect(appFieldSource).toContain("个性化推荐已按新账号生效");
  });

  test("清除前卸载扫码，成功后刷新凭据与推荐缓存", () => {
    const clearSource = appFieldSource.slice(
      appFieldSource.indexOf("async function clearAuthorization"),
    );
    expect(clearSource.indexOf("flushSync(")).toBeLessThan(
      clearSource.indexOf('"account_bilibili_app_clear"'),
    );
    expect(clearSource.indexOf("setQrOpen(false)")).toBeLessThan(
      clearSource.indexOf('"account_bilibili_app_clear"'),
    );
    expect(clearSource).toContain('notify.success("已移除 App 授权")');
    expect(clearSource).toContain("refreshAppQueries()");
    // 清凭据不再联动设置；设置项已删除，回读设置会变成无意义的额外 IPC。
    expect(clearSource).not.toContain("loadFromBackend()");
  });

  test("恢复默认设置不再处理已删除的个性化开关", () => {
    expect(source).not.toContain("setBilibiliAppPersonalization");
    expect(source).not.toContain("bilibili_app_personalization");
    for (const word of ["TV", "App", "story", "个性化", "授权"]) {
      expect(settingsCategorySearchText.account).toContain(word);
    }
  });
});
