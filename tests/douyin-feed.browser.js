// 抖音 Cookie 推荐流：仅模拟 IPC 和本地媒体 URL，不读取账号或访问真实推荐。
// 在已连接的 Windows 主窗口运行：
// playwright-cli -s=rwin run-code --filename=tests/douyin-feed.browser.js
// oxlint-disable-next-line no-unused-expressions -- run-code 要求顶层函数表达式。
async (page) => {
  const pattern = "**/src/shared/api/tauri.ts*";
  const mediaPattern = "**/__douyin_feed_fixture.mp4*";
  await page.unroute(pattern);
  await page.reload();
  const source = await page.evaluate(async () => (await fetch("/src/shared/api/tauri.ts")).text());
  const signature = "async function invokeCmd(cmd, args) {";
  if (!source.includes(signature)) throw new Error("IPC 测试注入点已改变");

  try {
    await page.route(pattern, (route) => route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: source.replace(signature, `${signature}\nif (window.__douyinFeedInvoke) return window.__douyinFeedInvoke(cmd, args);`),
    }));
    // 不验证解码；404 只触发本地媒体错误，仍可检查原生媒体及代理所有权。
    await page.route(mediaPattern, (route) => route.fulfill({ status: 404, body: "推荐媒体生命周期夹具" }));
    await page.goto(`${page.url().match(/^https?:\/\/[^/]+/)[0]}/settings`);
    return await page.evaluate(async () => {
      const { setupHarness, dependencyUrl, until, frames, assert } = await import("/tests/browser/harness.js");
      const { QueryClient, QueryClientProvider } = await import(dependencyUrl("@tanstack_react-query"));
      const { MemoryRouter, Routes, Route, Link } = await import(dependencyUrl("react-router-dom"));
      const { DouyinVideoPage } = await import("/src/features/shorts/DouyinVideoPage.tsx");
      const client = new QueryClient();
      // 按显式用户操作核对批次数，避免开发态 StrictMode 重挂载干扰脚本队列。
      const harness = await setupHarness({ strict: false });
      const original = window.__TAURI_INTERNALS__.invoke;
      const previousHook = window.__douyinFeedInvoke;
      const feedCalls = [];
      const resolveCalls = [];
      const issued = [];
      const stopped = [];
      const mockErrors = [];
      const covered = [];
      const items = Object.fromEntries([
        ["manual", "7520000000000000000", "单作品夹具"],
        ["a", "7520000000000000001", "首批作品甲"],
        ["b", "7520000000000000002", "首批作品乙"],
        ["c", "7520000000000000003", "追加作品丙"],
        ["d", "7520000000000000004", "刷新作品丁"],
        ["e", "7520000000000000005", "刷新作品戊"],
        ["f", "7520000000000000006", "重试追加作品己"],
        ["g", "7520000000000000007", "重开新轮作品"],
        ["h", "7520000000000000008", "刷新新轮作品"],
        ["lateClose", "7520000000000000009", "关闭前迟到作品"],
        ["lateRefresh", "7520000000000000010", "刷新前迟到作品"],
      ].map(([key, id, title]) => [key, {
        id, title, author: "测试作者", cover: "", width: 1080, height: 1920,
        duration: 10, share_url: `https://www.douyin.com/video/${id}`,
      }]));
      const batch = (keys, has_more = true) => ({ items: keys.map((key) => items[key]), has_more });
      const deferred = () => {
        let resolve;
        const promise = new Promise((done) => { resolve = done; });
        return { promise, resolve };
      };
      const lateClose = deferred();
      const lateRefresh = deferred();
      const loginMessage = "测试：推荐流需要登录 Cookie，请前往设置登录";
      const refreshMessage = "测试：请先完成访问验证再刷新推荐";
      const appendMessage = "测试：追加推荐暂时失败，请显式重试";
      const fail = (code, message) => () => { throw { code, message, site: "douyin", retryable: true }; };
      const steps = [
        ["首次开启未登录", fail("douyin_login_required", loginMessage)],
        ["关闭重开首批", () => batch(["a", "b"])],
        ["追加重复及新作品", () => batch(["b", "c", "c"])],
        ["全重复批次", () => batch(["a", "b", "c"])],
        ["刷新失败", fail("douyin_browser_verification", refreshMessage)],
        ["刷新恢复", () => batch(["d", "e"])],
        ["追加失败", fail("douyin_feed_fixture_error", appendMessage)],
        ["显式重试追加", () => batch(["e", "f"])],
        ["关闭前在途批次", () => lateClose.promise],
        ["重开新轮", () => batch(["g"], false)],
        ["刷新前在途批次", () => lateRefresh.promise],
        ["刷新新轮", () => batch(["h"], false)],
      ];
      const checkMock = (condition, message) => {
        if (!condition) mockErrors.push(message);
        assert(condition, message);
      };
      window.__douyinFeedInvoke = async (command, args) => {
        if (command === "douyin_video_feed") {
          checkMock(args?.consent === true && Object.keys(args).length === 1, "推荐 IPC 必须只传 consent:true");
          const step = steps[feedCalls.length];
          feedCalls.push(step?.[0] ?? "非预期后台请求");
          checkMock(!!step, "产生了非预期推荐请求，禁止透传真实推荐");
          return step[1]();
        }
        if (command === "douyin_video_resolve") {
          resolveCalls.push({ ...args });
          const item = Object.values(items).find((candidate) => candidate.id === args?.input);
          checkMock(typeof args?.input === "string" && !!item, "作品 ID 必须保持字符串且属于本地夹具");
          checkMock(args.requireLogin === (item.id !== items.manual.id), "推荐取流必须 requireLogin:true，单作品不强制登录");
          const session_id = crypto.randomUUID();
          issued.push({ session_id, input: item.id });
          return { session_id, play_url: `${location.origin}/__douyin_feed_fixture.mp4?session=${session_id}`, item };
        }
        if (command === "douyin_video_stop") {
          checkMock(issued.some((entry) => entry.session_id === args?.sessionId), "释放了不属于本夹具的代理");
          stopped.push(args.sessionId);
          return;
        }
        // 仅接管上述三个命令；保留主窗口其他功能的原始 IPC。
        return original(command, args);
      };

      const recommendation = () => harness.host.querySelector('[data-slot="douyin-recommendation"]');
      const button = (name, root = harness.host) => [...root.querySelectorAll("button")]
        .find((element) => element.textContent.trim() === name);
      const click = async (name, root = harness.host) => {
        const target = button(name, root);
        assert(target && !target.disabled, `按钮不可用：${name}`);
        target.click();
        await frames();
      };
      const toggle = async (enabled) => {
        const control = harness.host.querySelector('[data-slot="switch"][aria-describedby="douyin-feed-help"]');
        assert(control, "推荐开关缺失，不能误用隐藏 input");
        assert(control.getAttribute("aria-checked") !== String(enabled), "开关前置状态不正确");
        control.click();
        await until(() => control.getAttribute("aria-checked") === String(enabled), "推荐开关未更新");
        await frames();
        assert(!!recommendation() === enabled, "开关未挂载或卸载推荐组件");
        if (!enabled) assert(!harness.host.querySelector("video"), "关闭推荐后仍残留媒体");
      };
      const counts = async (feed, resolve = resolveCalls.length) => {
        await frames();
        assert(!mockErrors.length, mockErrors.join("；"));
        assert(feedCalls.length === feed, `推荐应只按需拉取 ${feed} 批，实际 ${feedCalls.length} 批：${feedCalls.join("、")}`);
        assert(resolveCalls.length === resolve, `应只为当前作品取流 ${resolve} 次，实际 ${resolveCalls.length} 次`);
      };
      const playing = async (key, position) => {
        const item = items[key];
        await until(() => {
          const video = harness.host.querySelector("video");
          return video?.getAttribute("aria-label") === item.title && video.src.includes("/__douyin_feed_fixture.mp4?");
        }, `未播放预期作品：${item.title}`);
        if (position) await until(() => recommendation()?.textContent.includes(`${position} 条已加载`), `推荐计数错误：${position}`);
        const media = harness.host.querySelector("video");
        assert(media.controls && media.loop && media.playsInline, "未复用原生视频控件");
        return { media, sessionId: new URL(media.src).searchParams.get("session") };
      };
      const released = async ({ media, sessionId }) => {
        await until(() => stopped.includes(sessionId), "关闭、换片或刷新后未释放旧代理");
        assert(!media.isConnected && !media.hasAttribute("src"), "旧媒体未卸载或仍持有代理地址");
      };
      // 媒体 URL 故意返回 404，因此重试必须锁定推荐错误，不能点到媒体错误。
      const feedError = (message) => [...(recommendation()?.querySelectorAll('[role="alert"]') ?? [])]
        .find((element) => element.textContent.includes("推荐加载失败") && element.textContent.includes(message));
      const expectError = async (message) => {
        await until(() => !!feedError(message), `推荐错误没有显示：${message}`);
        assert(button("重试", feedError(message)), "推荐错误缺少显式重试入口");
      };
      const assertLateIgnored = async (pending, oldKey, currentKey, feedCount) => {
        const before = resolveCalls.length;
        const current = await playing(currentKey, "1 / 1");
        pending.resolve(batch([oldKey], false));
        await pending.promise;
        await frames();
        await counts(feedCount, before);
        assert(harness.host.querySelector("video") === current.media, "旧轮迟到结果替换了新轮媒体");
        assert(!harness.host.textContent.includes(items[oldKey].title), "旧轮迟到作品污染了新轮 UI");
        assert(!resolveCalls.some((call) => call.input === items[oldKey].id), "迟到元数据触发了不应有的取流");
        const cachedPages = client.getQueriesData({ queryKey: ["douyin_video_feed"] })
          .flatMap(([, data]) => data?.pages ?? []);
        assert(!cachedPages.some((entry) => entry.items.some((item) => item.id === items[oldKey].id)), "已取消的旧轮结果重新进入查询缓存");
      };

      try {
        harness.render(harness.h(QueryClientProvider, { client },
          harness.h(MemoryRouter, { initialEntries: ["/shorts/douyin"] },
            harness.h(Routes, null,
              harness.h(Route, { path: "/shorts/douyin", element: harness.h(DouyinVideoPage) }),
              harness.h(Route, { path: "/shorts", element: harness.h(Link, { to: "/shorts/douyin" }, "重新进入抖音") }),
            ),
          ),
        ));
        await frames();
        assert(harness.host.querySelector('[data-slot="switch"]').getAttribute("aria-checked") === "false", "初次进入推荐不是默认关闭");
        assert(!recommendation(), "默认关闭仍挂载了推荐组件");
        await counts(0, 0);

        // 必须用明确的表单 ID，Switch 同时会生成隐藏 input。
        const input = harness.host.querySelector("#douyin-video-input");
        assert(input, "默认关闭时没有单作品表单");
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, items.manual.id);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        await frames();
        harness.host.querySelector("form").requestSubmit();
        const manual = await playing("manual");
        await counts(0, 1);
        covered.push("默认关闭不请求推荐，单作品表单与登录取流参数隔离");

        await toggle(true);
        await expectError(loginMessage);
        assert(feedError(loginMessage).textContent.includes("douyin_login_required"), "未登录错误码未显示");
        assert(!harness.host.querySelector("#douyin-video-input"), "推荐模式仍保留单作品输入框");
        await released(manual);
        await counts(1, 1);
        await toggle(false);
        await counts(1, 1);
        await toggle(true);
        const first = await playing("a", "1 / 2");
        assert(!feedError(loginMessage), "关闭重开未清理旧错误");
        assert(button("上一条").disabled && !button("下一条").disabled, "首条导航边界错误");
        await counts(2, 2);
        covered.push("未登录结构化错误可见，关闭重开后恢复首批两条");

        await click("下一条");
        const second = await playing("b", "2 / 2");
        await released(first);
        assert(button("下一条").disabled, "到达尾条仍允许越界");
        await counts(2, 3);
        await click("上一条");
        const back = await playing("a", "1 / 2");
        await released(second);
        assert(back.sessionId !== first.sessionId, "返回同一作品复用了已释放代理");
        await counts(2, 4);
        covered.push("首批只为当前作品取流，下一条/上一条使用独立代理并释放旧媒体");

        await click("加载更多推荐");
        const afterAppend = await playing("a", "1 / 3");
        assert(afterAppend.media === back.media, "追加元数据重建了当前播放器");
        await counts(3, 4);
        await click("下一条");
        const duplicate = await playing("b", "2 / 3");
        await released(back);
        await click("下一条");
        const third = await playing("c", "3 / 3");
        await released(duplicate);
        await counts(3, 6);
        await click("加载更多推荐");
        await until(() => recommendation().textContent.includes("本轮暂无更多新作品"), "全重复批次未停止继续加载");
        assert(!button("加载更多推荐"), "全重复批次仍暴露加载更多入口");
        assert(button("下一条").disabled, "去重后尾条边界错误");
        await playing("c", "3 / 3");
        await counts(4, 6);
        covered.push("追加跨批及批内去重，全重复批次停止加载且不预取媒体");

        await click("刷新推荐");
        await expectError(refreshMessage);
        await released(third);
        assert(!harness.host.querySelector("video"), "刷新失败仍保留上一轮媒体");
        await counts(5, 6);
        await click("重试", feedError(refreshMessage));
        const refreshed = await playing("d", "1 / 2");
        assert(!feedError(refreshMessage), "刷新恢复后仍显示上一轮错误");
        await counts(6, 7);
        covered.push("刷新清理上一轮，首批错误通过显式重试恢复");

        await click("加载更多推荐");
        await expectError(appendMessage);
        const afterError = await playing("d", "1 / 2");
        assert(afterError.media === refreshed.media, "追加错误丢失了已加载作品或当前媒体");
        await counts(7, 7);
        await click("重试", feedError(appendMessage));
        const afterRetry = await playing("d", "1 / 3");
        assert(afterRetry.media === refreshed.media && !feedError(appendMessage), "追加重试没有保留已有批次或清除错误");
        await counts(8, 7);
        covered.push("追加错误可见且不自动重试，显式重试只追加失败批次");

        await toggle(false);
        await released(refreshed);
        await until(() => issued.every((entry) => stopped.includes(entry.session_id)), "关闭推荐后代理未全部释放");
        await counts(8, 7);
        covered.push("关闭推荐卸载媒体并释放全部当前代理");

        // 两种取消边界都在新一轮完成后才返回旧请求，不能靠返回顺序侥幸通过。
        await toggle(true);
        await until(() => feedCalls.length === 9, "关闭竞争场景未发起在途推荐");
        assert(!harness.host.querySelector("video"), "在途推荐提前开始取流");
        await toggle(false);
        await toggle(true);
        const reopened = await playing("g", "1 / 1");
        await counts(10, 8);
        await assertLateIgnored(lateClose, "lateClose", "g", 10);
        await click("刷新推荐");
        await until(() => feedCalls.length === 11, "刷新竞争场景未发起在途推荐");
        await released(reopened);
        await click("刷新推荐");
        const finalMedia = await playing("h", "1 / 1");
        await counts(12, 9);
        await assertLateIgnored(lateRefresh, "lateRefresh", "h", 12);
        covered.push("关闭重开与刷新两种旧轮迟到结果均不污染新轮、缓存或取流");

        // 真正卸载路由页面，而非仅隐藏容器；QueryClient 保持不变以检查缓存串轮。
        harness.host.querySelector('a[href="/shorts"]').click();
        await until(() => !harness.host.querySelector('[data-slot="douyin-video-page"]'), "离开路由未卸载作品页");
        await released(finalMedia);
        harness.host.querySelector('a[href="/shorts/douyin"]').click();
        await until(() => !!harness.host.querySelector("#douyin-cookie-feed"), "重新进入作品页失败");
        assert(harness.host.querySelector('[data-slot="switch"]').getAttribute("aria-checked") === "false", "离开后重进未恢复默认关闭");
        assert(!recommendation() && !!harness.host.querySelector("#douyin-video-input"), "重进后没有恢复单作品模式");
        await counts(12, 9);
        await until(() => issued.every((entry) => stopped.includes(entry.session_id)), "离开页面后代理未全部释放");
        assert(new Set(issued.map((entry) => entry.session_id)).size === issued.length, "不同取流复用了同一代理 UUID");
        assert(new Set(stopped).size === stopped.length, "同一代理重复释放");
        covered.push("离开/重进默认关闭且不复用旧推荐，代理只释放一次");
        return { passed: true, message: "抖音推荐流夹具通过", covered, feedCalls: feedCalls.length, resolved: issued.length, stopped: stopped.length };
      } finally {
        harness.dispose();
        lateClose.resolve(batch(["lateClose"], false));
        lateRefresh.resolve(batch(["lateRefresh"], false));
        client.clear();
        // 保持模拟停止命令到所有卸载微任务完成，绝不把夹具代理传给真实后端。
        await frames();
        if (previousHook === undefined) delete window.__douyinFeedInvoke;
        else window.__douyinFeedInvoke = previousHook;
      }
    });
  } finally {
    await page.unroute(pattern);
    await page.unroute(mediaPattern);
    await page.reload();
  }
}
