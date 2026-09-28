// 抖音官网登录窗口的前端生命周期回归：只桩 IPC，不接触真实账号。
// playwright-cli -s=dyqr run-code --filename=tests/douyin-browser-login.browser.js
async (page) => {
  const pattern = "**/src/shared/api/tauri.ts*";
  await page.unroute(pattern);
  await page.reload();
  const source = await page.evaluate(async () => (await fetch("/src/shared/api/tauri.ts")).text());
  const signature = "async function invokeCmd(cmd, args) {";
  if (!source.includes(signature)) throw new Error("IPC 测试注入点已改变");
  await page.route(pattern, (route) => route.fulfill({
    status: 200,
    contentType: "application/javascript",
    body: source.replace(signature, `${signature}\nif (window.__douyinBrowserInvoke) return window.__douyinBrowserInvoke(cmd, args);`),
  }));
  try {
    await page.goto(`${page.url().match(/^https?:\/\/[^/]+/)[0]}/settings`);
    return await page.evaluate(async () => {
      const { setupHarness, dependencyUrl, until, frames, assert } = await import("/tests/browser/harness.js");
      const { QueryClient, QueryClientProvider } = await import(dependencyUrl("@tanstack_react-query"));
      const { AccountCard } = await import("/src/features/settings/SettingsPage.tsx");
      const client = new QueryClient();
      const harness = await setupHarness();
      const cancelled = [];
      const polls = [];
      const forbiddenWrites = [];
      let starts = 0;
      let profiles = 0;
      let resolveLateStart;
      let resolveOldPoll;
      let completeCurrent = false;
      const session = (index) => ({mode: "browser", qr_code_url: "", qr_key: String(index).padStart(32, "0")});
      window.__douyinBrowserInvoke = async (cmd, args) => {
        if (cmd === "account_get_profile") {
          profiles++;
          return {username: "测试账号", has_cookie: true, status: "valid"};
        }
        if (cmd === "account_qr_login_start") {
          starts++;
          if (starts === 1) return await new Promise(resolve => { resolveLateStart = resolve; });
          return session(starts);
        }
        if (cmd === "account_qr_login_cancel") {
          cancelled.push(args.qrKey);
          return null;
        }
        if (cmd === "account_qr_login_poll") {
          polls.push(args.qrKey);
          if (args.qrKey === session(2).qr_key) return await new Promise(resolve => { resolveOldPoll = resolve; });
          return {status: completeCurrent ? "success" : "pending", message: completeCurrent ? "登录成功" : "请在官方窗口完成登录"};
        }
        if (cmd === "account_clear_cookie" || cmd === "account_set_cookie") {
          forbiddenWrites.push(cmd);
          throw new Error("官网登录等待/取消不应修改原 Cookie");
        }
        throw new Error(`未预期的命令: ${cmd}`);
      };
      const dialog = () => document.querySelector('[role="dialog"]');
      const button = (root, text) => [...root.querySelectorAll("button")].find(b => b.textContent.trim() === text);
      const open = () => button(harness.host, "扫码登录").click();
      try {
        harness.render(harness.h(QueryClientProvider, {client}, harness.h(AccountCard, {
          siteId: "douyin", title: "抖音", placeholder: "Cookie", qrLogin: true,
        })));
        await until(() => harness.host.textContent.includes("已登录"), "初始账号未加载");
        open();
        await until(() => starts === 1 && !!dialog(), "未启动官方窗口流程");
        assert(dialog().textContent.includes("官网扫码登录"), "缺少官网登录标题");
        assert(!dialog().querySelector('svg[role="img"], img[alt*="二维码"]'), "错误渲染了空二维码");
        button(dialog(), "取消").click();
        await until(() => !dialog(), "取消后弹窗未关闭");
        resolveLateStart(session(1));
        await until(() => cancelled.includes(session(1).qr_key), "迟到的建窗结果未被取消");
        assert(polls.length === 0, "已取消的迟到会话仍被轮询");

        open();
        await until(() => !!resolveOldPoll && starts === 2, "第二次登录未开始轮询");
        const beforeProfileRefresh = profiles;
        button(dialog(), "重新打开登录窗口").click();
        await until(() => starts === 3 && polls.includes(session(3).qr_key), "重新打开未创建新会话");
        assert(cancelled.includes(session(2).qr_key), "重新打开没有取消旧会话");
        resolveOldPoll({status: "success", message: "旧会话迟到成功"});
        await frames();
        assert(profiles === beforeProfileRefresh, "旧会话结果触发了账号保存后刷新");
        assert(!!dialog(), "旧会话结果关闭了新弹窗");

        completeCurrent = true;
        await until(() => !dialog() && profiles > beforeProfileRefresh, "新会话成功后未刷新账号并关闭弹窗", 8000);
        assert(!cancelled.includes(session(3).qr_key), "已成功的会话被重复取消");
        completeCurrent = false;
        open();
        await until(() => starts === 4 && polls.includes(session(4).qr_key), "卸载用会话未启动");
        harness.dispose();
        await until(() => cancelled.includes(session(4).qr_key), "离开设置未取消官网登录窗口");
        assert(forbiddenWrites.length === 0, "取消或等待流程触发凭据写入");
        return {passed: true, starts, lateStartCancelled: true, stalePollIgnored: true, unmountCancelled: true, originalCookieUntouched: true};
      } finally {
        harness.dispose();
        client.clear();
        delete window.__douyinBrowserInvoke;
      }
    });
  } finally {
    await page.unroute(pattern);
    await page.reload();
  }
}
