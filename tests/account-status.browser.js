// F-01：真实 AccountCard 在 unknown / expired / valid 下的行为。
// 只桩 IPC，不访问真实账号；重点验证「只有明确失效才清除 Cookie」。
// playwright-cli -s=rwin run-code --filename=tests/account-status.browser.js
async (page) => {
  const pattern = "**/src/shared/api/tauri.ts*";
  await page.unroute(pattern);
  await page.reload();
  const source = await page.evaluate(async () => (await fetch("/src/shared/api/tauri.ts")).text());
  const signature = "async function invokeCmd(cmd, args) {";
  if (!source.includes(signature)) throw new Error("IPC 测试注入点已改变");
  await page.route(pattern, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: source.replace(
        signature,
        `${signature}\nif (window.__accountInvoke) return window.__accountInvoke(cmd, args);`,
      ),
    }),
  );
  try {
    await page.goto(`${page.url().match(/^https?:\/\/[^/]+/)[0]}/settings`);
    return await page.evaluate(async () => {
      const { setupHarness, dependencyUrl, until, frames, assert } = await import(
        "/tests/browser/harness.js"
      );
      const { QueryClient, QueryClientProvider } = await import(dependencyUrl("@tanstack_react-query"));
      const { AccountCard } = await import("/src/features/settings/SettingsPage.tsx");

      const cleared = [];
      const statusBySite = {
        bilibili: "unknown",
        douyu: "expired",
        huya: "valid",
      };
      const profileFor = (siteId) => {
        const status = statusBySite[siteId] ?? "none";
        return {
          username: status === "valid" ? "测试账号" : null,
          has_cookie: status !== "none",
          status,
        };
      };
      window.__accountInvoke = async (command, args) => {
        if (command === "account_get_profile") return profileFor(args.siteId);
        if (command === "account_clear_cookie") {
          cleared.push(args.siteId);
          statusBySite[args.siteId] = "none";
          return null;
        }
        if (command === "account_get_cookie") return "SESSDATA=fixture";
        throw new Error(`未预期的命令: ${command}`);
      };

      const client = new QueryClient();
      // 每种状态用独立 harness：dispose 会卸载 root，同一个 root 不能重复 render。
      const renderCard = async (siteId) => {
        const harness = await setupHarness();
        harness.render(
          harness.h(
            QueryClientProvider,
            { client },
            harness.h(AccountCard, { siteId, title: siteId, placeholder: "粘贴 Cookie" }),
          ),
        );
        return harness;
      };
      const harnesses = [];
      try {
        // unknown：必须显示「已保存，未验证」，且绝不能调用清除。
        const unknown = await renderCard("bilibili");
        harnesses.push(unknown);
        await until(
          () => unknown.host.textContent.includes("已保存，未验证"),
          "unknown 未显示为已保存未验证",
        );
        assert(!unknown.host.textContent.includes("已登录"), "unknown 被升级成已登录的确定事实");
        await frames();
        assert(cleared.length === 0, "unknown 状态下清除了凭据");

        // valid：平台已确认会话，显示已登录且不清除。
        const valid = await renderCard("huya");
        harnesses.push(valid);
        await until(() => valid.host.textContent.includes("已登录"), "valid 未显示为已登录");
        await frames();
        assert(cleared.length === 0, "valid 状态下清除了凭据");

        // expired：明确失效才允许自动清理，且应留下提示。
        const expired = await renderCard("douyu");
        harnesses.push(expired);
        await until(() => cleared.includes("douyu"), "明确失效未触发清理");
        await until(
          () => expired.host.textContent.includes("自动退出登录"),
          "清理后未留下重新登录提示",
        );
        return {
          passed: true,
          cleared,
          unknownKeptCookie: !cleared.includes("bilibili"),
          validKeptCookie: !cleared.includes("huya"),
        };
      } finally {
        harnesses.forEach((harness) => harness.dispose());
        client.clear();
        delete window.__accountInvoke;
      }
    });
  } finally {
    await page.unroute(pattern);
    await page.reload();
  }
}
