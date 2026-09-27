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
import { readFileSync } from "node:fs";

import {
  BILIBILI_APP_AUTH_REQUIRED,
  BILIBILI_APP_AUTH_SETTINGS_PATH,
  BILIBILI_APP_AUTH_UNAVAILABLE,
  isBilibiliAppAuthRequired,
} from "../src/shared/api/bilibiliAppProfile";

const actionSource = readFileSync(
  new URL("../src/shared/components/BilibiliAppAuthAction.tsx", import.meta.url),
  "utf8",
);
const startupSource = readFileSync(
  new URL("../src/features/settings/BilibiliAppAuthStartupCheck.tsx", import.meta.url),
  "utf8",
);
const errorStateSource = readFileSync(
  new URL("../src/shared/components/ErrorState.tsx", import.meta.url),
  "utf8",
);

describe("APP 授权失效的错误码判定", () => {
  test("只有 auth_required 被当作需要重新授权", () => {
    expect(isBilibiliAppAuthRequired({ code: BILIBILI_APP_AUTH_REQUIRED })).toBe(true);
    expect(isBilibiliAppAuthRequired({ code: BILIBILI_APP_AUTH_UNAVAILABLE })).toBe(false);
  });

  test("网络类失败不得冒充凭据失效", () => {
    // 把网络失败当失效，用户会被引导去重新扫码，而凭据其实还能用。
    for (const error of [
      { code: "bilibili_app_auth_unavailable" },
      { code: "bilibili_app_feed_device" },
      { code: "invoke_failed" },
      { code: "tauri_unavailable" },
      new Error("network down"),
      null,
      undefined,
      "bilibili_app_auth_required",
    ]) {
      expect(isBilibiliAppAuthRequired(error)).toBe(false);
    }
  });

  test("恢复入口指向设置页账号分区", () => {
    expect(BILIBILI_APP_AUTH_SETTINGS_PATH).toBe("/settings?section=account");
  });
});

describe("推荐失败的恢复入口", () => {
  test("只在凭据失效时渲染，网络失败不渲染", () => {
    // 判定来自共享模块，组件本身不比较错误码字符串。
    expect(actionSource).toContain("isBilibiliAppAuthRequired(error)");
    expect(actionSource).toMatch(/if \(!isBilibiliAppAuthRequired\(error\)\) return null;/);
    expect(actionSource).not.toContain('=== "bilibili_app_auth_required"');
  });

  test("用设置页路由而不是新开一套授权界面", () => {
    expect(actionSource).toContain("BILIBILI_APP_AUTH_SETTINGS_PATH");
    expect(actionSource).toMatch(/<Link\s+to=\{BILIBILI_APP_AUTH_SETTINGS_PATH\}/);
    expect(actionSource).toContain("去重新授权");
  });

  test("两条推荐流都接上入口，且重试按钮仍保留", () => {
    const videoPage = readFileSync(
      new URL("../src/features/video/VideoPage.tsx", import.meta.url),
      "utf8",
    );
    const shortsPage = readFileSync(
      new URL("../src/features/shorts/ShortsPage.tsx", import.meta.url),
      "utf8",
    );
    expect(videoPage).toMatch(/action=\{<BilibiliAppAuthAction error=\{listQuery\.error\} \/>\}/);
    expect(shortsPage).toMatch(/action=\{<BilibiliAppAuthAction error=\{feedQuery\.error\} \/>\}/);
    // 失效判定万一有误，重试是成本更低的恢复路径，不能被入口替换掉。
    expect(errorStateSource).toMatch(/\{onRetry && \(/);
    expect(errorStateSource).toMatch(/\{action\}/);
  });
});

describe("启动期失效检查", () => {
  test("只在服务端明确拒绝时提示，unknown 保持沉默", () => {
    expect(startupSource).toContain('profile.status !== "expired"');
    expect(startupSource).toContain("!profile.has_token");
    // 网络失败不能让启动期误报。
    expect(startupSource).toContain("catch(() =>");
  });

  test("不自动清除凭据", () => {
    // 清理必须是用户的显式动作：校验失败也可能只是网络问题。
    expect(startupSource).not.toContain("account_bilibili_app_clear");
    expect(startupSource).not.toContain("bilibili_app::clear");
  });

  test("每个授权版本只提示一次，重扫后重新检查", () => {
    expect(startupSource).toContain("checkedRevisionRef.current === authRevision");
    expect(startupSource).toContain("checkedRevisionRef.current = authRevision");
    expect(startupSource).toContain("bilibiliAppAuthRevision");
  });

  test("提示给出可执行的下一步", () => {
    expect(startupSource).toContain("Bilibili TV 授权已失效");
    expect(startupSource).toContain("设置 → 账号");
  });

  test("失效后丢弃旧账号的列表缓存", () => {
    expect(startupSource).toContain("invalidateBilibiliAppQueries(queryClient)");
  });

  test("延迟执行且不阻塞首屏", () => {
    expect(startupSource).toContain("STARTUP_CHECK_DELAY_MS");
    expect(startupSource).toMatch(/window\.setTimeout/);
    expect(startupSource).toContain("hydratedFromBackend");
  });
});
