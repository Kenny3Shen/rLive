// Windows 主窗口运行：playwright-cli -s=rwin run-code --filename=tests/proxy-settings.browser.js
// 使用真实分段控件、store 和持久化队列；只桩 settings IPC，不改本机真实代理。
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
        `${signature}\nif (window.__proxyInvoke && (cmd === "settings_get" || cmd === "settings_set")) return window.__proxyInvoke(cmd, args);`,
      ),
    }),
  );
  try {
    await page.goto(`${page.url().match(/^https?:\/\/[^/]+/)[0]}/settings`);
    return await page.evaluate(async () => {
      const { setupHarness, dependencyUrl, until, frames, assert } =
        await import("/tests/browser/harness.js");
      const { QueryClient, QueryClientProvider } = await import(
        dependencyUrl("@tanstack_react-query")
      );
      const { ProxySettingsFields } =
        await import("/src/features/settings/ProxySettingsFields.tsx");
      const settingsStoreUrl = performance.getEntriesByType("resource")
        .find((entry) => new URL(entry.name).pathname === "/src/shared/stores/settingsStore.ts")?.name;
      if (!settingsStoreUrl) throw new Error("页面尚未加载设置 store");
      // Vite HMR 会为依赖加 ?t=；必须复用组件依赖的同一个 store，而非另建未带参数的实例。
      const { useSettingsStore } = await import(settingsStoreUrl);
      const { FieldGroup } = await import("/src/components/ui/field.tsx");
      const previous = useSettingsStore.getState();
      const writes = [];
      let fail = false;
      let release = null;
      let hold = false;
      window.__proxyInvoke = async (command, args) => {
        if (command === "settings_get") return { proxy_status: "系统代理 http://127.0.0.1:7890/" };
        if (hold)
          await new Promise((resolve) => {
            release = resolve;
          });
        if (fail) throw { code: "fixture_write_failure", message: "fixture" };
        writes.push(args.settings);
        return null;
      };
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const harness = await setupHarness({
        style:
          "position:fixed;inset:0 auto auto 0;width:360px;background:var(--background);padding:16px;z-index:9999;",
      });
      const button = (label) =>
        [...harness.host.querySelectorAll("button")].find((b) => b.textContent === label);
      const idle = () => button("自动").getAttribute("aria-disabled") !== "true";
      const choose = async (label) => {
        button(label).click();
        await frames();
        await until(idle, "保存未结束");
        await frames();
      };
      const fill = (value) => {
        const input = harness.query("#proxy");
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      };
      // 与相邻设置行一致：模式行是「标题说明在左、分段控件在右」的单行，
      // 且反馈文字留在触发它的那一行，不能串行到另一条设置上。
      const rows = () => [...harness.host.querySelectorAll("[data-slot=field]")];
      const modeRow = () => rows().find((row) => row.textContent.includes("代理模式"));
      const feedbackRow = (text) => rows().find((row) => row.textContent.includes(text));
      try {
        useSettingsStore.setState({ proxyMode: "auto", proxy: null, hydratedFromBackend: true });
        harness.render(
          harness.h(
            QueryClientProvider,
            { client },
            harness.h(FieldGroup, null, harness.h(ProxySettingsFields)),
          ),
        );
        await frames();
        assert(button("自动").getAttribute("aria-pressed") === "true", `默认未选中自动：${JSON.stringify({ mode: useSettingsStore.getState().proxyMode, buttons: [...harness.host.querySelectorAll('[data-slot="toggle-group-item"]')].map(b => [b.textContent, b.getAttribute("aria-pressed")]) })}`);
        assert(!harness.query("#proxy"), "自动模式不应展示地址框");
        await until(
          () => harness.host.textContent.includes("系统代理 http://127.0.0.1:7890/"),
          "未展示后端解析的系统代理",
        );
        await choose("自动");
        assert(button("自动").getAttribute("aria-pressed") === "true", "点击选中项清空了模式");
        assert(writes.length === 0, "点击选中项不应写设置");

        await choose("自定义");
        assert(harness.host.textContent.includes("尚未配置代理地址"), "空自定义地址缺少直连提示");
        const mode = modeRow();
        assert(mode.getAttribute("data-orientation") === "horizontal", "模式行不是单行布局");
        const control = mode.querySelector("[data-slot=toggle-group]");
        assert(control && mode.lastElementChild === control, "分段控件不在行的控件列");
        {
          // 控件要居中于整行：本行比只有标题的行高（标题下还有状态说明），
          // Field 默认的「有内容就顶部对齐」会把分段控件顶到标题那一条线上。
          const rowBox = mode.getBoundingClientRect();
          const controlBox = control.getBoundingClientRect();
          const offset = controlBox.y + controlBox.height / 2 - (rowBox.y + rowBox.height / 2);
          assert(Math.abs(offset) <= 1, `分段控件未在行内垂直居中：偏移 ${offset}px`);
        }
        fill("socks5://127.0.0.1:1080");
        await frames();
        button("保存").click();
        await frames();
        assert(
          harness.query("#proxy").getAttribute("aria-invalid") === "true",
          "非法协议未标记输入错误",
        );
        assert(writes.length === 1, "非法代理被写入");
        fill(" 127.0.0.1:7890 ");
        await frames();
        button("保存").click();
        await until(() => writes.length === 2 && idle(), "合法地址未保存");
        assert(writes[1].proxy_mode === "custom", "地址保存丢失模式");
        assert(writes[1].proxy === "http://127.0.0.1:7890/", "地址未规范化");
        // 成功保存不留任何确认文案：当前路由状态已由说明行表达，只留失败提示。
        assert(
          !/已保存|保存成功|正在保存/.test(harness.host.textContent),
          `保存成功不应产生确认文案：${harness.host.textContent}`,
        );

        await choose("关闭");
        assert(!harness.query("#proxy"), "关闭模式仍展示地址框");
        assert(
          useSettingsStore.getState().proxy === "http://127.0.0.1:7890/",
          "关闭删除了自定义地址",
        );
        assert(harness.host.textContent.includes("直连（不使用代理）"), "关闭未展示直连");
        await choose("自动");
        await choose("自定义");
        assert(harness.query("#proxy").value === "http://127.0.0.1:7890/", "模式往返丢失地址");
        fill("127.0.0.1:8888");
        await frames();
        await choose("关闭");
        await choose("自定义");
        assert(harness.query("#proxy").value === "127.0.0.1:8888", "隐藏输入框丢失未保存草稿");

        hold = true;
        button("关闭").click();
        await until(() => release !== null, "未进入待保存状态");
        assert(!idle() && button("自定义").getAttribute("aria-disabled") === "true", "保存期间没有阻止交错写入");
        hold = false;
        release();
        await until(idle, "保存后控件未恢复");
        fail = true;
        await choose("自动");
        assert(harness.host.textContent.includes("代理设置保存失败"), "实际失败仍展示成功");
        assert(
          feedbackRow("代理设置保存失败") === modeRow(),
          "模式保存失败的提示不在模式行",
        );
        assert(useSettingsStore.getState().proxyMode === "off", "保存失败未恢复旧模式");
        fail = false;
        await choose("自定义");
        assert(useSettingsStore.getState().proxyMode === "custom", "失败后写入队列不可恢复");
        assert(harness.host.scrollWidth <= harness.host.clientWidth, "360px 布局横向溢出");
        return {
          passed: true,
          writes: writes.length,
          modes: ["auto", "off", "custom"],
          retainedAddress: true,
          failureRollback: true,
          narrowLayout: true,
        };
      } finally {
        release?.();
        harness.dispose();
        client.clear();
        useSettingsStore.setState(previous, true);
        delete window.__proxyInvoke;
      }
    });
  } finally {
    await page.unroute(pattern);
    await page.reload();
  }
}
