// 抖音实验入口：只模拟 IPC，不访问真实作品或账号。
// playwright-cli -s=rwin run-code --filename=tests/douyin-video.browser.js
async (page) => {
  const pattern = "**/src/shared/api/tauri.ts*";
  await page.unroute(pattern);
  await page.reload();
  const source = await page.evaluate(async () => (await fetch("/src/shared/api/tauri.ts")).text());
  const signature = "async function invokeCmd(cmd, args) {";
  if (!source.includes(signature)) throw new Error("IPC 测试注入点已改变");
  await page.route(pattern, (route) => route.fulfill({ status: 200, contentType: "application/javascript", body: source.replace(signature, `${signature}\nif (window.__douyinInvoke) return window.__douyinInvoke(cmd, args);`) }));
  await page.route("**/__douyin_fixture.mp4*", (route) => route.fulfill({ status: 404, body: "媒体生命周期夹具" }));
  try {
    await page.goto(`${page.url().match(/^https?:\/\/[^/]+/)[0]}/settings`);
    return await page.evaluate(async () => {
      const { setupHarness, dependencyUrl, until, frames, assert } = await import("/tests/browser/harness.js");
      const { QueryClient, QueryClientProvider } = await import(dependencyUrl("@tanstack_react-query"));
      const { MemoryRouter } = await import(dependencyUrl("react-router-dom"));
      const { DouyinVideoPage } = await import("/src/features/shorts/DouyinVideoPage.tsx");
      const client = new QueryClient();
      const harness = await setupHarness();
      const stopped = [];
      const issued = [];
      const late = [];
      let phase = "error";
      let attempt = 0;
      const original = window.__TAURI_INTERNALS__.invoke;
      const result = () => {
        const session_id = `douyin-video-test-${issued.length}`;
        issued.push(session_id);
        return { session_id, play_url: `${location.origin}/__douyin_fixture.mp4?id=${session_id}`, item: { id: "7520000000000000001", title: "测试公开作品", author: "测试作者", cover: "", width: 1080, height: 1920, duration: 10, share_url: "https://www.douyin.com/video/7520000000000000001" } };
      };
      window.__douyinInvoke = async (command, args) => {
        if (command === "douyin_video_resolve") {
          assert(args.input === "7520000000000000001", "作品 ID 被转成数字或丢失精度");
          attempt++;
          if (phase === "error") throw { code: "douyin_browser_verification", message: "测试：请先完成访问验证" };
          if (phase === "late") return new Promise((resolve) => { late.push(() => resolve(result())); });
          return result();
        }
        if (command === "douyin_video_stop") { stopped.push(args.sessionId); return; }
        return original(command, args);
      };
      try {
        harness.render(harness.h(QueryClientProvider, { client }, harness.h(MemoryRouter, null, harness.h(DouyinVideoPage))));
        assert(harness.host.textContent.includes("实验性"), "实验标识缺失");
        const input = harness.host.querySelector("#douyin-video-input");
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "7520000000000000001");
        input.dispatchEvent(new Event("input", { bubbles: true }));
        await frames();
        harness.host.querySelector("form").requestSubmit();
        await until(() => harness.host.textContent.includes("请先完成访问验证"), "上游结构化错误未显示");
        phase = "ready";
        harness.host.querySelector('[role="alert"] button').click();
        await until(() => !!harness.host.querySelector("video"), "重试未打开原生媒体");
        const media = harness.host.querySelector("video");
        assert(media.controls && media.loop && media.playsInline, "原生媒体能力未配置");
        assert(media.src.includes("/__douyin_fixture.mp4"), "未使用后端代理地址");
        const beforeReplace = issued.length;
        harness.host.querySelector("form").requestSubmit();
        await until(() => issued.length > beforeReplace && stopped.includes(issued[beforeReplace - 1]), "替换作品未释放旧代理");
        phase = "late";
        harness.host.querySelector("form").requestSubmit();
        await until(() => late.length > 0, "没有在途解析");
        harness.dispose();
        late.forEach((resolve) => resolve());
        await until(() => issued.every((id) => stopped.includes(id)), "退出后的迟到解析未释放");
        assert(new Set(stopped).size === stopped.length, "同一代理重复释放");
        return { passed: true, errorsVisible: true, retries: attempt, issued: issued.length, stopped: stopped.length };
      } finally {
        harness.dispose();
        client.clear();
        delete window.__douyinInvoke;
      }
    });
  } finally {
    await page.unroute(pattern);
    await page.unroute("**/__douyin_fixture.mp4*");
    await page.reload();
  }
}
