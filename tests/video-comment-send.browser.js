// 独立浏览器行为回归；真实 VideoCommentComposer/CommentsPanel，只有 Tauri IPC 是内存桩。
// 不得 attach 原生窗口。本脚本与夹具都会拒绝原生桥，并阻断所有非 1421 的网络请求。
// 先启动独立 Vite（若已有 1421 服务则复用，不要停止它）：
//   bun run dev -- --host 127.0.0.1 --port 1421
//   playwright-cli -s=video-comment-send open http://127.0.0.1:1421/tests/browser/video-comment-send.html
//   playwright-cli -s=video-comment-send run-code --filename=tests/video-comment-send.browser.js
// eslint-disable-next-line no-unused-expressions -- playwright-cli 按单一函数表达式加载。
async (page) => {
  const origin = "http://127.0.0.1:1421";
  const fixtureUrl = `${origin}/tests/browser/video-comment-send.html`;
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  assert(page.url().startsWith(`${origin}/`), "请在 1421 独立普通浏览器会话运行，不得接入原生窗口");
  const unsafeBridge = await page.evaluate(() =>
    Boolean(window.__TAURI_INTERNALS__) && !window.videoCommentFixture?.mockOnly,
  );
  assert(!unsafeBridge, "禁止在已有原生 Tauri 桥的窗口中执行评论发送夹具");

  const externalRequests = [];
  const errors = [];
  const guard = (route) => {
    const url = route.request().url();
    if (!url.startsWith(`${origin}/`)) {
      externalRequests.push(url);
      return route.abort("blockedbyclient");
    }
    return route.continue();
  };
  const onError = (error) => errors.push(error.message);
  await page.route("**/*", guard);
  page.on("pageerror", onError);
  const results = [];
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(fixtureUrl);
    await page.waitForFunction(() => window.videoCommentFixture?.mockOnly === true);
    await page.getByTestId("comment-list").getByText("现有评论 123", { exact: true }).waitFor();
    const composer = page.getByRole("region", { name: "发送评论", exact: true });
    const input = composer.getByRole("textbox", { name: "评论内容", exact: true });
    const send = () => composer.getByRole("button", { name: "发送评论", exact: true });
    const calls = () => page.evaluate(() => window.videoCommentFixture.sendCalls.length);
    const setOutcome = (outcome) => page.evaluate((next) => window.videoCommentFixture.setOutcome(next), outcome);
    const dismissNotifications = async () => {
      // 通知本身不是此夹具的被测交互；同步点关闭，避免等待动画期间自动消失的竞态。
      await page.locator('button[aria-label="关闭通知"]').evaluateAll((buttons) => {
        for (const button of buttons) button.click();
      });
      await page.waitForFunction(() => !document.querySelector('[role="alertdialog"]'));
    };
    const waitIdle = () => page.waitForFunction(() =>
      document.querySelector('section[aria-label="发送评论"] form')?.getAttribute("aria-busy") === "false",
    );
    const settle = (index, result = "success") => page.evaluate(
      ({ index, result }) => window.videoCommentFixture.settle(index, result), { index, result },
    );

    // 评论与弹幕均为单行起步的紧凑输入组，没有外围分隔横线或独立大按钮。
    const geometry = await page.evaluate(() => {
      const comment = document.querySelector('section[aria-label="发送评论"]');
      const danmaku = document.querySelector('section[aria-label="弹幕输入对照"] > div');
      const measure = (surface) => {
        const group = surface.querySelector('[data-slot="input-group"]');
        const button = group.querySelector('[data-align="inline-end"] button');
        const rect = group.getBoundingClientRect(), b = button.getBoundingClientRect();
        const style = getComputedStyle(surface);
        return { height: rect.height, width: rect.width, button: [b.width, b.height], border: style.borderTopWidth, padding: [style.paddingLeft, style.paddingRight, style.paddingTop, style.paddingBottom] };
      };
      return { comment: measure(comment), danmaku: measure(danmaku), separators: comment.querySelectorAll('[role="separator"]').length };
    });
    assert(Math.abs(geometry.comment.height - geometry.danmaku.height) <= 2, `发送框高度未对齐：${JSON.stringify(geometry)}`);
    assert(geometry.comment.width === geometry.danmaku.width, "发送框宽度未对齐");
    assert(JSON.stringify(geometry.comment.button) === JSON.stringify(geometry.danmaku.button), "发送按钮尺寸未对齐");
    assert(JSON.stringify(geometry.comment.padding) === JSON.stringify(geometry.danmaku.padding), "发送区留白未对齐");
    assert(geometry.comment.border === "0px" && geometry.danmaku.border === "0px" && geometry.separators === 0, "发送区仍存在多余横线");
    results.push("评论与弹幕输入组同宽、同高、同留白，无多余横线：通过");

    // 1. 真正的受控输入和原生 disabled，不调用 IPC。
    assert(await send().isDisabled(), "初始空白必须禁用发送");
    await input.fill(" \n\t　");
    assert(await send().isDisabled(), "纯空白必须禁用发送");
    assert(await calls() === 0, "纯空白不得发起 IPC");
    results.push("空白禁用：通过");

    // 2. 正常点击进入 pending；成功后由真实 Query invalidation 重新读取当前评论。
    await setOutcome("pending");
    const successText = "  成功评论\n第二行 😀  ";
    const initialReads = await page.evaluate(() => window.videoCommentFixture.readCalls.length);
    await input.fill(successText);
    await send().click();
    await page.waitForFunction(() => window.videoCommentFixture.sendCalls.length === 1 && document.querySelector('textarea[name="comment"]')?.disabled);
    assert(await input.isDisabled(), "等待结果时必须禁止编辑，防止成功清空用户后来输入的内容");
    assert(await composer.locator('button[type="submit"]').isDisabled(), "发送中按钮必须禁用");
    assert(await page.evaluate(() => !window.videoCommentFixture.cachedMessages("123").includes("成功评论\n第二行 😀")), "响应未成功前不得乐观插入评论");
    await settle(0);
    await page.waitForFunction((before) =>
      window.videoCommentFixture.readCalls.length > before &&
      window.videoCommentFixture.cachedMessages("123").includes("成功评论\n第二行 😀"), initialReads,
    );
    await waitIdle();
    assert(await input.inputValue() === "", "成功后必须清空草稿");
    assert(await send().isDisabled(), "成功清空后必须重新禁用发送");
    assert(await page.evaluate(() => window.videoCommentFixture.sendCalls[0].message === "成功评论\n第二行 😀"), "发送应只去除两端空白并保留换行、表情");
    assert(await page.evaluate(() => window.videoCommentFixture.client.getQueryState(["video_comments", "999", 3]).isInvalidated === false), "成功不得污染其他稿件缓存");
    await page.getByTestId("comment-list").getByText("成功评论", { exact: false }).waitFor();
    await page.getByText("评论已提交", { exact: true }).first().waitFor();
    await dismissNotifications();
    results.push("点击成功清空、通知且当前 comments cache 重取：通过");

    // 3. 普通失败保留原文；全局 mutation retry=3 也不得让写入自动重发。
    await setOutcome("rejected");
    const rejectedText = "  失败仍保留\n原文  ";
    await input.fill(rejectedText);
    await send().click();
    await composer.getByText("测试拒绝：评论区暂时限制发送", { exact: true }).waitFor();
    await waitIdle();
    assert(await input.inputValue() === rejectedText, "普通失败不得清空或修剪用户的原始草稿");
    assert(await composer.getByRole("link", { name: "去登录", exact: true }).count() === 0, "普通拒绝不得冒充登录失效");
    await page.waitForTimeout(80); // 夹具 retryDelay=0；留出事件循环验证没有后台重发。
    assert(await calls() === 2, "失败不能继承全局重试导致重复写入");
    await dismissNotifications();
    results.push("失败保留原文且不自动重试：通过");

    // 4. 明确失效/未登录都保留原文并给出真实设置路由，不删除 Cookie。
    for (const [outcome, text] of [["expired", "测试登录已失效，请重新登录"], ["missing", "测试未登录，请先登录 B站 Web 账号"]]) {
      await setOutcome(outcome);
      await send().click();
      await composer.getByText(text, { exact: true }).waitFor();
      await waitIdle();
      assert(await input.inputValue() === rejectedText, `${outcome} 不得清空原文`);
      const login = composer.getByRole("link", { name: "去登录", exact: true });
      assert(await login.getAttribute("href") === "/settings?section=account", `${outcome} 必须指向已有设置页账号入口`);
      await dismissNotifications();
    }
    assert(await calls() === 4, "两次显式登录失败只能各发一次请求");
    results.push("登录失效/未登录保留原文与登录入口：通过");

    // 5. 同一个 JS 调用栈连续提交两次，React 来不及禁用按钮时由同步锁兜住。
    await setOutcome("pending");
    await input.fill("同帧双提交只发一次");
    await composer.locator("form").evaluate((form) => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await page.waitForFunction(() => window.videoCommentFixture.sendCalls.length === 5);
    await page.waitForTimeout(80);
    assert(await calls() === 5, "同帧双提交不能产生第二个 IPC");
    assert(await page.evaluate(() => window.videoCommentFixture.pendingCount() === 1), "只能存在一个待完成写入");
    await settle(4);
    await waitIdle();
    assert(await input.inputValue() === "", "提交锁不能阻止成功清空");
    await dismissNotifications();
    results.push("同帧双提交仅一次：通过");

    // 6. 旧 aid 的 pending 仍在途中，切换后的组件可以输入新 draft，旧结果不得清空它。
    await setOutcome("pending");
    await input.fill("旧稿件延迟成功");
    await send().click();
    await page.waitForFunction(() => window.videoCommentFixture.sendCalls.length === 6);
    await page.getByRole("button", { name: "切换稿件", exact: true }).click();
    await page.getByTestId("current-aid").getByText("稿件 456", { exact: true }).waitFor();
    await page.getByTestId("comment-list").getByText("现有评论 456", { exact: true }).waitFor();
    assert(await input.inputValue() === "", "切换 aid 必须隔离旧稿件的输入");
    const nextDraft = "  新稿件独立草稿\n不能被旧结果清空  ";
    await input.fill(nextDraft);
    await settle(5);
    await page.waitForFunction(() => window.videoCommentFixture.client.isMutating() === 0);
    assert(await input.inputValue() === nextDraft, "旧 aid 请求成功不得清空新 aid draft");
    assert(await page.evaluate(() => {
      const fixture = window.videoCommentFixture;
      return fixture.sendCalls[5].aid === "123" &&
        fixture.client.getQueryState(["video_comments", "123", 3]).isInvalidated &&
        !fixture.client.getQueryState(["video_comments", "456", 3]).isInvalidated &&
        !fixture.cachedMessages("456").includes("旧稿件延迟成功");
    }), "旧请求只能使旧 aid 缓存失效，不得写进或失效新 aid 的列表");
    results.push("aid 切换隔离未完成请求和新草稿：通过");

    await dismissNotifications();
    await input.fill("键盘发送");
    await input.press("Shift+Enter");
    assert(await input.inputValue() === "键盘发送\n", "Shift+Enter 应只换行");
    assert(await calls() === 6, "换行不得提交评论");
    await input.press("Enter");
    await page.waitForFunction(() => window.videoCommentFixture.sendCalls.length === 7);
    await settle(6);
    await waitIdle();
    assert(await input.inputValue() === "", "Enter 发送成功后应清空");
    results.push("Enter 发送、Shift+Enter 换行：通过");

    assert(errors.length === 0, `浏览器运行错误：${errors.join("; ")}`);
    assert(externalRequests.length === 0, `夹具尝试了外部请求（已阻断）：${externalRequests.join("; ")}`);
    const state = await page.evaluate(() => ({
      mockOnly: window.videoCommentFixture.mockOnly,
      sends: window.videoCommentFixture.sendCalls.length,
      reads: window.videoCommentFixture.readCalls.length,
      pending: window.videoCommentFixture.pendingCount(),
    }));
    return { results, ...state, externalRequests, pageErrors: errors, realCommentsSent: 0 };
  } finally {
    page.off("pageerror", onError);
    await page.unroute("**/*", guard);
  }
}
