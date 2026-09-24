// F-06：真实诊断摘要抽屉，IPC/保存对话框/剪贴板用桩，不访问账号或 CDN。
// 页面同时挂载真实设置页，因此所有查询都限定在夹具节点或对应抽屉内。
// playwright-cli -s=rwin run-code --filename=tests/diagnostic-summary.browser.js
async (page) => {
  const invokePattern = "**/src/shared/api/tauri.ts*";
  const clipboardPattern = "**/src/shared/clipboard.ts*";
  const dialogPattern = "**/node_modules/.vite/deps/@tauri-apps_plugin-dialog.js*";
  for (const pattern of [invokePattern, clipboardPattern, dialogPattern]) await page.unroute(pattern);
  await page.reload();
  // 模块文本必须从页面内取：Node 侧解析 localhost 会走 ::1 被拒。
  const sources = await page.evaluate(async () => {
    const dialogUrl = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .find((name) => name.includes("@tauri-apps_plugin-dialog.js"));
    return {
      invoke: await (await fetch("/src/shared/api/tauri.ts")).text(),
      clipboard: await (await fetch("/src/shared/clipboard.ts")).text(),
      dialog: dialogUrl ? await (await fetch(dialogUrl)).text() : null,
    };
  });
  const invokeSignature = "async function invokeCmd(cmd, args) {";
  // Vite 会去掉类型标注，注入点必须匹配转译后的形态。
  const clipboardSignature = "export async function copyText(text) {";
  if (!sources.invoke.includes(invokeSignature)) throw new Error("IPC 测试注入点已改变");
  if (!sources.clipboard.includes(clipboardSignature)) throw new Error("剪贴板测试注入点已改变");
  await page.route(invokePattern, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: sources.invoke.replace(
        invokeSignature,
        `${invokeSignature}\nif (window.__diagInvoke) return window.__diagInvoke(cmd, args);`,
      ),
    }),
  );
  await page.route(clipboardPattern, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: sources.clipboard.replace(
        clipboardSignature,
        `${clipboardSignature}\nif (window.__diagCopy) return window.__diagCopy(text);`,
      ),
    }),
  );
  const dialogSignature = 'return await invoke("plugin:dialog|save", { options });';
  if (!sources.dialog?.includes(dialogSignature)) throw new Error("保存对话框测试注入点已改变");
  await page.route(dialogPattern, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: sources.dialog.replace(
        dialogSignature,
        'if (window.__diagSave) return window.__diagSave(options);\n\t' + dialogSignature,
      ),
    }),
  );
  try {
    await page.goto(`${page.url().match(/^https?:\/\/[^/]+/)[0]}/settings`);
    return await page.evaluate(async () => {
      const { setupHarness, dependencyUrl, until, frames, assert } = await import(
        "/tests/browser/harness.js"
      );
      const { QueryClient, QueryClientProvider } = await import(
        dependencyUrl("@tanstack_react-query")
      );
      const { DiagnosticSummaryField } = await import(
        "/src/features/settings/DiagnosticSummaryField.tsx"
      );

      const generatedAt = Date.now();
      const snapshot = {
        generated_at_ms: generatedAt,
        app_version: "1.0.0",
        platform: "windows",
        architecture: "x86_64",
        accounts: [{ site_id: "bilibili", has_cookie: true, verification: "not_checked" }],
        logs: {
          current: {
            exists: true,
            truncated: true,
            omitted_lines: 7,
            entries: [
              {
                at_ms: generatedAt - 5_000,
                level: "WARN",
                component: "stream_proxy",
                codes: ["stream_proxy_accept_failed"],
              },
            ],
          },
          previous: { exists: false, truncated: false, omitted_lines: 0, entries: [] },
        },
        proxy: {
          sessions: 0,
          upstream_requests: 0,
          upstream_failures: 0,
          bytes_forwarded: 0,
          first_response_samples: 0,
          first_response_ms_sum: 0,
          first_response_ms_max: 0,
        },
      };

      let generations = 0;
      let resolveSnapshot = null;
      let failSnapshot = false;
      let savePath = null;
      const exports = [];
      const copies = [];
      window.__diagInvoke = async (command, args) => {
        if (command === "app_diagnostic_snapshot") {
          generations += 1;
          if (failSnapshot) throw new Error("private-error-path-must-not-display");
          return await new Promise((resolve) => {
            resolveSnapshot = resolve;
          });
        }
        if (command === "app_diagnostic_export") {
          exports.push(args);
          return null;
        }
        throw new Error(`未预期的命令: ${command}`);
      };
      window.__diagCopy = async (text) => {
        copies.push(text);
        return true;
      };
      window.__diagSave = async () => savePath;

      const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
      const harness = await setupHarness();
      // 抽屉挂到 document.body 的 portal；按标题锁定夹具自己的那个。
      const drawer = () =>
        [...document.querySelectorAll('[data-slot="drawer-content"]')].find((node) =>
          node.textContent.includes("诊断摘要预览"),
        ) ?? null;
      const button = (label) => {
        const scope = drawer() ?? harness.host;
        return [...scope.querySelectorAll("button")].find(
          (item) => item.textContent.trim() === label,
        );
      };
      const preview = () =>
        drawer()?.querySelector('[aria-label="诊断摘要内容"]')?.textContent ?? "";
      const removeField = (label) => {
        const scope = drawer();
        const target = [...scope.querySelectorAll("button")].find((item) =>
          (item.getAttribute("aria-label") ?? "").includes(label),
        );
        assert(target, `未找到移除按钮：${label}`);
        target.click();
      };
      const hasField = (id) => preview().includes(`"id": "${id}"`);
      try {
        harness.render(
          harness.h(
            QueryClientProvider,
            { client },
            harness.h(DiagnosticSummaryField),
          ),
        );
        await frames();
        assert(generations === 0, "未主动打开就收集了诊断信息");
        const trigger = [...harness.host.querySelectorAll("button")].find(
          (item) => item.textContent.trim() === "生成诊断摘要",
        );
        assert(trigger, "未找到生成诊断摘要入口");
        trigger.click();
        await until(() => resolveSnapshot, "打开后未收集快照");
        await frames();
        assert(
          button("保存摘要").disabled && button("复制摘要").disabled,
          "预览尚未生成就允许导出",
        );
        assert(!preview(), "生成完成前显示了预览内容");
        resolveSnapshot(structuredClone(snapshot));
        await until(() => preview().includes("stream_proxy_accept_failed"), "白名单摘要未显示");
        assert(exports.length === 0 && copies.length === 0, "生成预览时自动导出了内容");
        assert(preview().includes('"available_samples": 0'), "无播放采样未正常退化");
        assert(preview().includes('"platform": "windows"'), "环境信息缺失");

        removeField("日志事件摘要");
        await frames();
        removeField("本机账号保存状态");
        await frames();
        const frozen = preview();
        assert(
          !frozen.includes("stream_proxy_accept_failed") && !frozen.includes("has_cookie"),
          "移除的字段仍在预览中",
        );
        assert(hasField("environment") && hasField("playback"), "未移除的字段被一并删除");

        button("复制摘要").click();
        await until(() => copies.length === 1, "复制未完成");
        assert(copies[0] === frozen, "复制的不是当前预览");
        await until(() => !button("保存摘要").disabled, "复制后操作未解锁");

        button("保存摘要").click();
        await frames();
        await frames();
        assert(exports.length === 0, "取消保存对话框后仍写文件");
        await until(() => !button("保存摘要").disabled, "取消后操作未解锁");

        savePath = "D:\\fixture-only\\rlive-diagnostic.json";
        button("保存摘要").click();
        await until(() => exports.length === 1, "保存未发出 IPC");
        assert(exports[0].text === frozen, "保存重新采样或补回了移除字段");
        assert(exports[0].path === savePath, "保存路径未透传");
        assert(generations === 1, "导出期间重新采集了摘要");
        await until(() => !button("重新生成").disabled, "保存后操作未解锁");

        failSnapshot = true;
        button("重新生成").click();
        await until(() => drawer().textContent.includes("生成失败，请重试"), "收集失败未显示错误");
        assert(
          button("保存摘要").disabled && button("复制摘要").disabled,
          "生成失败后仍可误导出旧预览",
        );
        assert(
          !drawer().textContent.includes("private-error-path-must-not-display"),
          "错误提示泄露原始异常",
        );

        // 关闭期间到达的 IPC 不能重建已关闭的预览。
        failSnapshot = false;
        resolveSnapshot = null;
        button("重新生成").click();
        await until(() => resolveSnapshot, "重试未发出快照请求");
        const generationsBeforeClose = generations;
        drawer().querySelector('[aria-label="关闭诊断摘要"]').click();
        const late = resolveSnapshot;
        await until(() => !drawer(), "关闭后抽屉仍可见");
        late(structuredClone(snapshot));
        await frames();
        await frames();
        assert(!drawer(), "迟到的 IPC 重新打开了已关闭的抽屉");
        const reopened = [...harness.host.querySelectorAll("button")].find(
          (item) => item.textContent.trim() === "生成诊断摘要",
        );
        reopened.click();
        await until(() => generations === generationsBeforeClose + 1, "重新打开未重新采集");
        await frames();
        assert(!preview(), "重新打开时复用了上一次的预览");
        resolveSnapshot(structuredClone(snapshot));
        await until(() => preview().includes("stream_proxy_accept_failed"), "重新生成未显示预览");
        drawer().querySelector('[aria-label="关闭诊断摘要"]').click();
        await until(() => !drawer(), "收尾时抽屉未关闭");

        return {
          passed: true,
          generations,
          copies: copies.length,
          exports: exports.length,
          previewMatchesExport: true,
          removedFieldsStayRemoved: true,
          cancelDidNotWrite: true,
          noAutoExport: true,
        };
      } finally {
        harness.dispose();
        client.clear();
        delete window.__diagInvoke;
        delete window.__diagCopy;
        delete window.__diagSave;
      }
    });
  } finally {
    for (const pattern of [invokePattern, clipboardPattern, dialogPattern]) {
      await page.unroute(pattern);
    }
    await page.reload();
  }
}
