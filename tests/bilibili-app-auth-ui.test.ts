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

function switchMarkup(html: string) {
  const control = html.match(/<(?:button|span)\b[^>]*role="switch"[^>]*>/)?.[0];
  expect(control).toBeDefined();
  return control!;
}

describe("B站 App 授权状态", () => {
  test("未取得状态或未保存凭据时不能开启", () => {
    expect(bilibiliAppAuthPresentation(undefined).canEnable).toBe(false);
    expect(
      bilibiliAppAuthPresentation({ ...validProfile, has_token: false, status: "none" }),
    ).toEqual({ hasToken: false, canEnable: false, label: "未授权" });
    expect(bilibiliAppAuthPresentation({ ...validProfile, has_token: false }).canEnable).toBe(
      false,
    );
  });

  test("只有明确有效且已保存的凭据允许开启", () => {
    expect(bilibiliAppAuthPresentation(validProfile)).toEqual({
      hasToken: true,
      canEnable: true,
      label: "授权有效",
    });
    for (const status of ["none", "expired", "unknown"] as const) {
      const result = bilibiliAppAuthPresentation({ ...validProfile, status });
      expect(result.hasToken).toBe(true);
      expect(result.canEnable).toBe(false);
      expect(result.label).not.toBe("授权有效");
    }
  });

  test("刷新中或网络失败不冒充有效，也不丢失已有凭据状态", () => {
    expect(bilibiliAppAuthPresentation(validProfile, true)).toEqual({
      hasToken: true,
      canEnable: false,
      label: "正在读取…",
    });
    expect(bilibiliAppAuthPresentation(validProfile, false, true)).toEqual({
      hasToken: true,
      canEnable: false,
      label: "状态待确认",
    });
  });

  test("默认关且无授权时禁用开启，保留扫码与刷新入口", () => {
    const html = renderProfile({ status: "none", has_token: false, mid: null, expires_at: null });
    expect(switchMarkup(html)).toContain('aria-checked="false"');
    expect(switchMarkup(html)).toContain('aria-disabled="true"');
    expect(html).toContain("未授权");
    expect(html).toContain("扫码授权");
    expect(html).toContain("刷新状态");
  });

  test("有效账号展示独立 UID、日期，但不会自动开启", () => {
    const html = renderProfile(validProfile);
    expect(html).toContain("独立 TV 账号");
    expect(html).toContain(validProfile.mid);
    expect(html).toContain(new Date(validProfile.expires_at * 1_000).toLocaleDateString("zh-CN"));
    expect(html).toContain("授权有效");
    expect(html).toContain("重新扫码");
    expect(switchMarkup(html)).toContain('aria-checked="false"');
    // 类名里的 `data-disabled:` 变体不是禁用标记，只看真实属性。
    expect(switchMarkup(html)).not.toContain('data-disabled=""');
    expect(switchMarkup(html)).not.toContain('aria-disabled="true"');
  });

  test("已失效或未知授权仍显示账号信息及重新扫码入口", () => {
    for (const status of ["expired", "unknown"] as const) {
      const html = renderProfile({ ...validProfile, status });
      expect(html).toContain(status === "expired" ? "已失效" : "状态待确认");
      expect(html).toContain(validProfile.mid);
      expect(html).toContain("重新扫码");
      expect(switchMarkup(html)).toContain('aria-disabled="true"');
    }
  });

  test("状态刷新失败展示 FieldError，保留 UID 并阻止使用旧有效状态开启", () => {
    const html = renderProfile(validProfile, new Error("网络暂不可用"));
    expect(html).toContain("网络暂不可用");
    expect(html).toContain('data-slot="field-error"');
    expect(html).toContain(validProfile.mid);
    expect(html).toContain("状态待确认");
    expect(switchMarkup(html)).toContain('aria-disabled="true"');
  });

  test("明确告知影响范围、存储和到期限制", () => {
    const html = renderProfile(validProfile);
    for (const text of [
      "App 推荐与 story",
      "不影响 Web 推荐",
      "不会替换 Web Cookie",
      "扫码成功不会自动开启",
      "SQLite",
      "未额外加密",
      "不随配置导出或同步",
      "180 天",
      "尚未实现 token 刷新协议",
      "不会静默降级为匿名推荐",
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

  test("已开启时不因凭据状态阻止关闭，持久化异常显示 FieldError", () => {
    expect(appFieldSource).toContain("pending || clearing || (!enabled && !auth.canEnable)");
    expect(appFieldSource).toContain("if (next && !auth.canEnable)");
    expect(appFieldSource).toContain("await setEnabled(next)");
    expect(appFieldSource).toContain("个性化设置保存失败");
    expect(appFieldSource).toContain('<FieldError id="bilibili-app-personalization-error">');
    expect(appFieldSource).toContain("aria-invalid={switchError ? true : undefined}");
  });

  test("清除前卸载扫码，成功后回读设置", () => {
    const clearSource = appFieldSource.slice(
      appFieldSource.indexOf("async function clearAuthorization"),
    );
    expect(clearSource.indexOf("flushSync(")).toBeLessThan(
      clearSource.indexOf('"account_bilibili_app_clear"'),
    );
    expect(clearSource.indexOf("setQrOpen(false)")).toBeLessThan(
      clearSource.indexOf('"account_bilibili_app_clear"'),
    );
    expect(clearSource).toContain("loadFromBackend()");
    expect(clearSource).toContain('notify.success("已移除 App 授权")');
  });

  test("重置包含关闭个性化，搜索能定位到授权入口", () => {
    expect(source).toContain("await store.setBilibiliAppPersonalization(false)");
    expect(source).toContain("bilibiliAppPersonalization: false");
    expect(source).toContain("bilibili_app_personalization: false");
    for (const word of ["TV", "App", "story", "个性化", "授权"]) {
      expect(settingsCategorySearchText.account).toContain(word);
    }
  });
});
