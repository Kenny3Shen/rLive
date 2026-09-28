// 抖音共享滑动流：真实 React/Query/原生解码，只模拟 IPC，媒体拼自本地 DASH 夹具。
// playwright-cli -s=rwin --raw run-code --filename=tests/douyin-feed.browser.js
// oxlint-disable-next-line no-unused-expressions -- run-code 要求顶层函数表达式。
async (page) => {
  const origin = page.url().match(/^https?:\/\/[^/]+/)[0];
  const pattern = "**/src/shared/api/tauri.ts*";
  await page.unroute(pattern);
  await page.goto(`${origin}/settings`);
  const source = await page.evaluate(async () => (await fetch("/src/shared/api/tauri.ts")).text());
  const signature = "async function invokeCmd(cmd, args) {";
  if (!source.includes(signature)) throw new Error("IPC 测试注入点已改变");
  await page.route(pattern, (route) => route.fulfill({ status: 200, contentType: "application/javascript", body: source.replace(signature, `${signature}\nif (window.__douyinFeedInvoke) return window.__douyinFeedInvoke(cmd, args);`) }));
  try {
    await page.goto(`${origin}/settings`);
    return await page.evaluate(async () => {
      const { setupHarness, dependencyUrl, until, frames, assert } = await import("/tests/browser/harness.js");
      const { QueryClient, QueryClientProvider } = await import(dependencyUrl("@tanstack_react-query"));
      const { MemoryRouter, Routes, Route, Link } = await import(dependencyUrl("react-router-dom"));
      const { DouyinVideoPage } = await import("/src/features/shorts/DouyinVideoPage.tsx");
      const chunks = ["init-0.m4s", ...Array.from({ length: 5 }, (_, i) => `chunk-0-${String(i + 1).padStart(5, "0")}.m4s`)];
      const blob = new Blob(await Promise.all(chunks.map(async (name) => {
        const response = await fetch(`/tests/assets/shorts-dash/${name}`);
        assert(response.ok, `本地媒体夹具缺失：${name}`);
        return response.arrayBuffer();
      })), { type: "video/mp4" });
      const harness = await setupHarness({ strict: false, style: "position:fixed;inset:0;z-index:9999;background:var(--background);" });
      const client = new QueryClient();
      const original = window.__TAURI_INTERNALS__.invoke;
      const previous = window.__douyinFeedInvoke;
      const hiddenDescriptor = Object.getOwnPropertyDescriptor(document, "hidden");
      const connectionDescriptor = Object.getOwnPropertyDescriptor(navigator, "connection");
      const connection = Object.assign(new EventTarget(), { saveData: false, effectiveType: "4g" });
      Object.defineProperty(navigator, "connection", { configurable: true, value: connection });
      const feedCalls = [];
      const resolves = [];
      const issued = [];
      const stopped = [];
      const errors = [];
      const covered = [];
      const item = (key) => ({ id: String(7520000000000000000n + BigInt(key.charCodeAt(0))), title: `夹具${key}`, author: "测试作者", cover: "", width: 160, height: 90, duration: 10 });
      const items = Object.fromEntries("abcdefghijklmnx".split("").map(key => [key, item(key)]));
      const batch = (keys, has_more = true) => ({ items: [...keys].map(key => items[key]), has_more });
      const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
      const lateRefresh = deferred();
      const lateExit = deferred();
      const lateMedia = deferred();
      let waitingMedia = false;
      const steps = [
        () => { throw { code: "douyin_login_required", message: "夹具：请先登录抖音" }; },
        () => batch("abcdef"),
        () => batch("ffggh"),
        () => { throw { code: "douyin_fixture", message: "夹具：追加失败" }; },
        () => batch("hij"),
        () => batch("abcdefghij"),
        () => lateRefresh.promise,
        () => batch("k", false),
        () => batch("lm", false),
        () => batch("", false),
        () => lateExit.promise,
        () => batch("n", false),
      ];
      const check = (condition, message) => { if (!condition) errors.push(message); assert(condition, message); };
      const playback = (id) => {
        const entry = Object.values(items).find(value => value.id === id);
        const result = { item: entry, session_id: crypto.randomUUID(), play_url: URL.createObjectURL(blob) };
        issued.push(result);
        return result;
      };
      window.__douyinFeedInvoke = async (command, args) => {
        if (command === "douyin_video_feed") {
          check(Object.keys(args ?? {}).length === 0, "推荐请求不接受调用方参数");
          const step = steps[feedCalls.length];
          feedCalls.push(feedCalls.length + 1);
          check(!!step, "出现非预期推荐请求，禁止透传实网");
          return step();
        }
        if (command === "douyin_video_resolve") {
          check(Object.values(items).some(value => value.id === args.input), "取流身份不是字符串夹具 ID");
          check(args.requireLogin === (args.input !== items.x.id), "推荐取流必须登录，作品链接不能强制登录");
          resolves.push({ ...args });
          if (args.input === items.k.id) { waitingMedia = true; return lateMedia.promise; }
          return playback(args.input);
        }
        if (command === "douyin_video_stop") {
          check(issued.some(info => info.session_id === args.sessionId), "释放了不属于测试的代理");
          stopped.push(args.sessionId);
          return;
        }
        if (command.startsWith("video_")) { check(false, `抖音不应调用 B 站命令：${command}`); }
        return original(command, args);
      };
      const root = harness.host;
      const viewport = () => root.querySelector('[data-slot="shorts-viewport"]');
      const activeVideo = () => root.querySelector('[data-slot="shorts-panel"]:not([inert]) video');
      const byText = (selector, text, scope = root) => [...scope.querySelectorAll(selector)].find(el => el.textContent.trim() === text);
      const click = async (text, scope = root) => { const el = byText("button, a", text, scope); assert(el && !el.disabled, `找不到操作：${text}`); el.click(); await frames(); };
      const menu = async () => {
        root.querySelector('button[aria-label="更多操作"]').click();
        await until(() => [...document.querySelectorAll("button")].some(el => el.textContent.trim() === "刷新推荐"), "菜单未展开");
      };
      const refresh = async () => { await menu(); await click("刷新推荐", document); };
      const toLink = async () => {
        root.querySelector('a[href="/shorts/douyin?tab=link"]').click();
        await until(() => !!root.querySelector("#douyin-video-input"), "未进入作品链接");
        assert(!viewport(), "离开推荐仍挂载滑动舞台");
      };
      const toFeed = async () => {
        byText('[role="tab"]', "推荐").click();
        await until(() => !!viewport(), "未进入推荐舞台");
      };
      const counts = async (n) => { await frames(); assert(!errors.length, errors.join("；")); assert(feedCalls.length === n, `预期${n}批，实际${feedCalls.length}`); };
      const playing = async (key) => {
        await until(() => viewport()?.dataset.currentId === items[key].id && activeVideo()?.readyState >= 3 && !activeVideo()?.paused && activeVideo()?.currentTime > 0, `未正常播放${key}`, 15000);
        assert(root.querySelectorAll("video").length <= 3, "超过三槽媒体上限");
        return activeVideo();
      };
      const settled = async () => { await until(() => !root.querySelector('[data-slot="shorts-track"]')?.getAnimations().some(a => a.playState === "running"), "换片动画未收尾"); };
      const nextKey = async () => {
        document.activeElement?.blur();
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
        await settled();
      };
      const allReleased = async () => {
        await until(() => issued.every(info => stopped.includes(info.session_id)), "离开后有未释放代理");
        assert(new Set(stopped).size === stopped.length, "代理重复释放");
      };
      try {
        harness.render(harness.h(QueryClientProvider, { client }, harness.h(MemoryRouter, { initialEntries: ["/shorts/douyin"] },
          harness.h(Routes, null,
            harness.h(Route, { path: "/shorts/douyin", element: harness.h(DouyinVideoPage) }),
            harness.h(Route, { path: "/", element: harness.h(Link, { to: "/shorts/douyin" }, "进入抖音") }),
          ),
        )));
        await until(() => root.textContent.includes("夹具：请先登录抖音"), "登录错误未显示");
        assert(!/实验|灰度/.test(root.textContent), "仍显示实验标识");
        assert(root.querySelector('a[href="/settings?section=account"]'), "没有账号设置入口");
        await counts(1);
        await toLink();
        const input = root.querySelector("#douyin-video-input");
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, items.x.id);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        await frames();
        root.querySelector("form").requestSubmit();
        await until(() => !!root.querySelector("video"), "作品链接播放失败");
        await counts(1);
        await toFeed();
        const first = await playing("a");
        await until(() => root.querySelector('[data-slot="shorts-panel"][inert] video')?.readyState >= 3, "下一条未预热", 15000);
        const warmed = root.querySelector('[data-slot="shorts-panel"][inert] video');
        assert(warmed.paused && warmed.currentTime === 0, "预热条目不应播放");
        assert(resolves.filter(call => call.input === items.b.id).length === 1, "预热重复取流");
        assert(root.querySelector('[data-slot="shorts-seek"]'), "未接入共享进度条");
        await counts(2);
        // 共享长按倍速与循环链路，不用伪造媒体状态。
        const frame = first.closest('[data-slot="shorts-frame"]');
        frame.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 70, pointerType: "mouse", isPrimary: true, bubbles: true, buttons: 1 }));
        await until(() => first.playbackRate === 3, "长按未进入三倍速");
        window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 70, pointerType: "mouse", bubbles: true }));
        await until(() => first.playbackRate === 1, "释放长按未恢复速度");
        first.currentTime = 9.8;
        await until(() => first.currentTime < 1 && !first.paused, "播完没有自动循环", 5000);
        covered.push("默认登录错误与作品链接隔离；原生解码、长按倍速、自动循环；下一条预热但不播放");

        viewport().dispatchEvent(new WheelEvent("wheel", { deltaY: 120, bubbles: true, cancelable: true }));
        const second = await playing("b");
        await settled();
        assert(second === warmed, "提升预热条目重建了媒体元素");
        assert(first.paused, "上一条未停止出声");
        assert(resolves.filter(call => call.input === items.b.id).length === 1, "预热命中后重复取流");
        document.activeElement?.blur();
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
        await until(() => feedCalls.length === 3, "临近末尾未请求补货");
        await frames();
        const animations = root.querySelector('[data-slot="shorts-track"]').getAnimations();
        if (animations.some(animation => animation.playState === "running")) {
          assert(root.textContent.includes("3 / 6 条已加载"), "收尾动画期间提交了补货，舞台坐标可能跳动");
        }
        await settled();
        await playing("c");
        await until(() => root.textContent.includes("3 / 8 条已加载"), "临近末尾未自动补货/去重");
        await counts(3);
        covered.push("滚轮与方向键换片；预热提升同元素不重取流，自动补货跨批去重");

        // 桌面 CDP 没有 hasTouch：合成 pointerType=touch 验证同一条手势管线。
        const view = viewport();
        const rect = view.getBoundingClientRect();
        const event = (type, y) => view.dispatchEvent(new PointerEvent(type, { pointerId: 71, pointerType: "touch", isPrimary: true, clientX: rect.x + rect.width / 2, clientY: y, bubbles: true, cancelable: true, buttons: type === "pointerup" ? 0 : 1 }));
        event("pointerdown", rect.y + rect.height * 0.8);
        event("pointermove", rect.y + rect.height * 0.2);
        event("pointerup", rect.y + rect.height * 0.15);
        await playing("d");
        await settled();
        await nextKey();
        await playing("e");
        await until(() => root.textContent.includes("夹具：追加失败"), "自动追加错误未显示");
        await counts(4);
        const current = activeVideo();
        await click("重试", [...root.querySelectorAll('[role="alert"]')].find(el => el.textContent.includes("追加推荐失败")));
        await until(() => root.textContent.includes("5 / 10 条已加载"), "重试未追加条目");
        assert(activeVideo() === current, "追加重试重建当前媒体");
        await counts(5);
        for (const key of "fgh") { await nextKey(); await playing(key); }
        await until(() => !client.getQueryCache().findAll({ queryKey: ["douyin_video_feed"] })[0].state.data.pages.at(-1).items.length || feedCalls.length === 6, "未停止重复批次");
        await counts(6);
        covered.push("触摸上滑共用手势；追加失败不自动重试；显式恢复不换播放器；重复批次停止");

        // 失去前台时不再附着新的邻居；返回前台后恢复预热，已有缓冲不清空。
        Object.defineProperty(document, "hidden", { configurable: true, value: true });
        document.dispatchEvent(new Event("visibilitychange"));
        await nextKey();
        await playing("i");
        await until(() => resolves.some(call => call.input === items.j.id), "邻居控制面未取流");
        const last = issued.find(info => info.item.id === items.j.id);
        assert(last && ![...root.querySelectorAll("video")].some(v => v.getAttribute("src") === last.play_url), "后台仍附着新预热媒体");
        connection.saveData = true;
        connection.dispatchEvent(new Event("change"));
        Object.defineProperty(document, "hidden", { configurable: true, value: false });
        document.dispatchEvent(new Event("visibilitychange"));
        await frames();
        assert(![...root.querySelectorAll("video")].some(v => v.getAttribute("src") === last.play_url), "省流模式仍附着预热媒体");
        connection.saveData = false;
        connection.dispatchEvent(new Event("change"));
        await until(() => [...root.querySelectorAll("video")].some(v => v.src === last.play_url && v.readyState >= 3), "回前台关闭省流后未恢复预热", 15000);
        covered.push("前后台与省流变更预热门控；控制面先取流，只有下一条在放行后附着媒体");

        await refresh();
        await counts(7);
        await refresh();
        await until(() => waitingMedia, "新轮未开始取流");
        lateRefresh.resolve(batch("x", false));
        await frames();
        assert(viewport().dataset.currentId === items.k.id, "迟到刷新污染新轮");
        await toLink();
        lateMedia.resolve(playback(items.k.id));
        await allReleased();
        await toFeed();
        await playing("l");
        await counts(9);
        await refresh();
        await until(() => root.textContent.includes("暂无可播放推荐"), "空结果未显示");
        await counts(10);
        await refresh();
        await counts(11);
        await toLink();
        await toFeed();
        await playing("n");
        lateExit.resolve(batch("x", false));
        await frames();
        assert(viewport().dataset.currentId === items.n.id, "离页迟到元数据污染新轮");
        await counts(12);
        await toLink();
        await allReleased();
        assert(!errors.length, errors.join("；"));
        covered.push("刷新/离页迟到元数据取消、迟到媒体释放、空态可恢复；无B站IPC，全部代理仅释放一次");
        return { passed: true, covered, feedCalls: feedCalls.length, resolved: issued.length, stopped: stopped.length };
      } finally {
        harness.dispose();
        client.clear();
        lateRefresh.resolve(batch("", false));
        lateExit.resolve(batch("", false));
        if (waitingMedia && !issued.some(info => info.item.id === items.k.id)) lateMedia.resolve(playback(items.k.id));
        await frames();
        issued.forEach(info => URL.revokeObjectURL(info.play_url));
        if (hiddenDescriptor) Object.defineProperty(document, "hidden", hiddenDescriptor);
        else delete document.hidden;
        document.dispatchEvent(new Event("visibilitychange"));
        if (connectionDescriptor) Object.defineProperty(navigator, "connection", connectionDescriptor);
        else delete navigator.connection;
        if (previous === undefined) delete window.__douyinFeedInvoke;
        else window.__douyinFeedInvoke = previous;
      }
    });
  } finally {
    await page.unroute(pattern);
    await page.reload();
  }
}
