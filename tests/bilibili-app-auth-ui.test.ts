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
describe("Bilibili TV 账号状态", () => {
  test("未取得状态或未保存凭据时都不算生效", () => {
    expect(bilibiliAppAuthPresentation(undefined).active).toBe(false);
    expect(
      bilibiliAppAuthPresentation({ ...validProfile, has_token: false, status: "none" }),
    ).toMatchObject({ hasToken: false, active: false, label: "未授权", tone: "outline" });
    expect(bilibiliAppAuthPresentation({ ...validProfile, has_token: false }).active).toBe(false);
  });

  test("只有明确有效且已保存的凭据算生效", () => {
    expect(bilibiliAppAuthPresentation(validProfile)).toMatchObject({
      hasToken: true,
      active: true,
      label: "已授权",
      tone: "secondary",
    });
    for (const status of ["none", "expired", "unknown"] as const) {
      const result = bilibiliAppAuthPresentation({ ...validProfile, status });
      expect(result.hasToken).toBe(true);
      expect(result.active).toBe(false);
      expect(result.label).not.toBe("已授权");
    }
  });

  test("刷新中或网络失败不冒充生效，也不丢失已有凭据状态", () => {
    expect(bilibiliAppAuthPresentation(validProfile, true)).toMatchObject({
      hasToken: true,
      active: false,
      label: "读取中",
    });
    expect(bilibiliAppAuthPresentation(validProfile, false, true)).toMatchObject({
      hasToken: true,
      active: false,
      label: "状态待确认",
    });
  });

  /**
   * 状态标签与 tone 必须与平台账号行（`accountPresentation`）同一套词。
   *
   * 这两行现在并排在「平台账号」分区里，用户会横向对比它们。如果一边说
   * 「已登录」、另一边说「已启用个性化」，用户就得先学会两套词汇才能判断
   * 「我到底登录了没有」。
   */
  test("状态词与 tone 对齐平台账号行，而不是自造一套", () => {
    expect(bilibiliAppAuthPresentation(validProfile).label).toBe("已登录".replace("登录", "授权"));
    expect(bilibiliAppAuthPresentation(validProfile).tone).toBe("secondary");
    expect(bilibiliAppAuthPresentation({ ...validProfile, status: "expired" })).toMatchObject({
      label: "已失效",
      tone: "destructive",
    });
    // unknown 与 expired 必须分开：前者凭据可能仍有效，不能引导重扫。
    expect(bilibiliAppAuthPresentation({ ...validProfile, status: "unknown" })).toMatchObject({
      label: "已授权，未验证",
      tone: "outline",
      showUnverifiedHint: true,
    });
    expect(bilibiliAppAuthPresentation({ ...validProfile, status: "expired" }).showUnverifiedHint).toBe(
      false,
    );
  });

  test("无授权时展示扫码与刷新入口，且不存在个性化开关", () => {
    const html = renderProfile({ status: "none", has_token: false, mid: null, expires_at: null });
    expect(html).toContain("未授权");
    expect(html).toContain("扫码授权");
    expect(html).toContain("刷新状态");
    expect(html).not.toContain("启用个性化推荐");
    expect(html).not.toContain('role="switch"');
    // 未授权时没有可移除的凭据，破坏性入口不应出现。
    expect(html).not.toContain("移除授权");
  });

  test("有效账号展示平台图标、UID、到期与重新扫码入口", () => {
    const html = renderProfile(validProfile);
    expect(html).toContain("Bilibili TV 账号");
    expect(html).toContain(validProfile.mid);
    expect(html).toContain(new Date(validProfile.expires_at * 1_000).toLocaleDateString("zh-CN"));
    expect(html).toContain("已授权");
    expect(html).toContain("重新扫码");
    expect(html).toContain("移除授权");
    expect(html).not.toContain('role="switch"');
  });

  test("已失效或未知授权仍显示账号信息及重新扫码入口", () => {
    for (const status of ["expired", "unknown"] as const) {
      const html = renderProfile({ ...validProfile, status });
      expect(html).toContain(status === "expired" ? "已失效" : "已授权，未验证");
      expect(html).toContain(validProfile.mid);
      expect(html).toContain("重新扫码");
      expect(html).not.toContain(">已授权<");
    }
  });

  test("状态刷新失败展示 FieldError，保留 UID 且不宣称生效", () => {
    const html = renderProfile(validProfile, new Error("网络暂不可用"));
    expect(html).toContain("网络暂不可用");
    expect(html).toContain('data-slot="field-error"');
    expect(html).toContain(validProfile.mid);
    expect(html).toContain("状态待确认");
    expect(html).not.toContain(">已授权<");
  });

  /**
   * 行内不再放常驻说明文案，与平台账号行保持同一密度。
   *
   * 影响范围、自动续期、存储位置、双账号错位这些事实都归文档（用户指南与
   * B站视频功能-设计），设置行只回答「这个账号是谁、什么状态、能做什么」——
   * 与哔哩哔哩/斗鱼/虎牙/抖音各行一致。只有状态相关的提示（未能验证、错误、
   * 操作结果）才出现在行内。
   */
  test("不放常驻说明文案，只保留状态相关提示", () => {
    const html = renderProfile(validProfile);
    // 有效状态下除了 UID/到期与按钮，没有任何解释性段落。
    const descriptions = html.match(/data-slot="field-description"/g) ?? [];
    expect(descriptions).toHaveLength(0);
    for (const removed of [
      "使用 B 站 App 扫码",
      "直播首页只带此凭据",
      "App 推荐",
      "不随配置导出",
      "到期前自动续期",
      "两账号不同时会不一致",
    ]) {
      expect(html).not.toContain(removed);
    }
  });

  test("未知状态仍给出可执行的下一步提示", () => {
    // 唯一保留在行内的文案是「没能确认」这类需要用户动作的提示。
    const html = renderProfile({ ...validProfile, status: "unknown" });
    expect(html).toContain("未能向哔哩哔哩确认状态");
    expect(html).toContain("刷新状态");
  });

  test("双账号错位写进文档而不是设置行", () => {
    // 设置行删掉文案不等于丢掉这个事实：用户会踩到的坑必须在文档里。
    const design = readFileSync(
      new URL("../docs/zh/B站视频功能-设计.md", import.meta.url),
      "utf8",
    );
    const guide = readFileSync(new URL("../docs/zh/用户指南.md", import.meta.url), "utf8");
    expect(design).toContain("双账号错位");
    expect(guide).toContain("直播首页推荐");
    expect(guide).toContain("Web Cookie");
  });
});

// 与现有源码契约测试保持一致：约束 IPC 路由与隔离边界，避免无 DOM 的 Bun
// 测试伪造成功扫码。真实扫码和延迟响应仍需主窗口集成验证。
describe("Bilibili TV 授权接线边界", () => {
  test("二维码放进对话框，与平台账号行一致；取消按钮在对话框内", () => {
    // 两行并排时，一个弹窗、一个内联展开会让「扫码」看起来是两件事。
    expect(appFieldSource).toMatch(/<Dialog\s+open=\{qrOpen\}/);
    expect(appFieldSource).toMatch(/<DialogContent>[\s\S]*<QrLogin/);
    expect(appFieldSource).not.toContain("取消扫码");
  });

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

  test("并入「平台账号」分区且排在 Web 账号前，不调用 Cookie 更新", () => {
    // 放在同一个分区的最前面：两行都答「我在 B 站的账号是什么」，分开会让
    // 用户以为 TV 授权与平台账号无关。
    expect(source).toMatch(
      /<Section title="平台账号">\s*<BilibiliAppAuthField \/>\s*<AccountCard\s+siteId="bilibili"/,
    );
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
    expect(clearSource).toContain('notify.success("已移除 Bilibili TV 授权")');
    expect(clearSource).toContain("refreshAppQueries()");
    // 清凭据不再联动设置；设置项已删除，回读设置会变成无意义的额外 IPC。
    expect(clearSource).not.toContain("loadFromBackend()");
  });

  /**
   * 两个响应式按钮行（移动 / 桌面）共用同一个弹窗状态，弹窗必须只挂载一次。
   *
   * 弹窗走 portal，`sm:hidden` 拦不住它：把 `<ConfirmDialog>` 塞进两个分支会让
   * 移动行与桌面行的实例同时存在，屏幕阅读器与 Tab 会看到两个同标题对话框
   * （真机实测：点一次「移除授权」出现 2 个 `role=alertdialog`）。这条约束
   * 同样适用于 `AccountCard` 的退出确认，两者共用这段源码检查。
   */
  test("确认弹窗只挂载一个，两个响应式行都只放触发按钮", () => {
    const field = source.slice(
      source.indexOf("export function BilibiliAppAuthField"),
      source.indexOf("export function AccountCard"),
    );
    expect(field.match(/<ConfirmDialog/g)).toHaveLength(1);
    // 两行各一个触发按钮（注释里也提到这个名字，所以匹配完整调用而非裸标识符）。
    expect(field.match(/onClick=\{\(\) => setLogoutOpen\(true\)\}/g)).toHaveLength(2);
    // 触发按钮不能嵌在弹窗里（那是被删除的旧写法）。
    expect(field).not.toContain("trigger={");

    const card = source.slice(
      source.indexOf("export function AccountCard"),
      source.indexOf("function PlaybackSettingsResetField"),
    );
    expect(card.match(/<ConfirmDialog/g)).toHaveLength(1);
    expect(card).not.toContain("trigger={");

    // 失败时弹窗不关（`AlertDialogAction` 不会自动关闭），错误必须在弹窗内可见，
    // 否则用户只看到弹窗没反应，而错误被弹窗挡在后面的行里。
    expect(field).toContain("error={logoutOpen ? actionError : null}");
  });

  test("恢复默认设置不再处理已删除的个性化开关", () => {
    expect(source).not.toContain("setBilibiliAppPersonalization");
    expect(source).not.toContain("bilibili_app_personalization");
    for (const word of ["Bilibili TV", "App", "story", "个性化", "授权", "移除"]) {
      expect(settingsCategorySearchText.account).toContain(word);
    }
  });
});
