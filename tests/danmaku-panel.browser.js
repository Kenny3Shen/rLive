// DanmakuPanel 浏览器回归：真实组件、QueryClientProvider、真实 eventBus，只有原生 IPC 使用桩。
// 普通浏览器完整验证（推荐；不会收藏、发送或屏蔽真实用户）：
//   bunx vite --port 1430 --strictPort --host 127.0.0.1
//   playwright-cli -s=danmaku-panel open http://127.0.0.1:1430/
//   playwright-cli -s=danmaku-panel run-code --filename=tests/danmaku-panel.browser.js
// 仅限普通浏览器的 Vite 页面；Tauri 主窗口一律中止，不能执行任何写操作。
// Windows 主窗口可安全注入测试事件验证几何，但不要在主窗口执行此写操作夹具。
// 1500 条消息按可冲刷的小批次投递：不能一次灌入 1500 条来测试历史容量，
// 那样测到的是独立的待提交队列背压丢弃策略，而不是已提交的 1200 行窗口。
async (page) => {
  await page.waitForFunction(() =>
    performance
      .getEntriesByType("resource")
      .some((entry) => new URL(entry.name).pathname.endsWith("/deps/react-dom_client.js")),
  );
  const result = await page.evaluate(async () => {
    const { assert, frames, until, dependencyUrl, setupHarness } =
      await import("/tests/browser/harness.js");
    const LIST = '[data-slot="danmaku-list"]';
    const ROW = "[data-danmaku-id]";
    const VIEWPORT = '[data-slot="scroll-area-viewport"]';
    const MENU = '[data-slot="popover-content"]';
    const LIMIT = 1200;
    const passed = [];
    const rowsOf = (list) => [...list.querySelectorAll(ROW)];
    const assertNoOverlap = (rows) => {
      const boxes = rows.map((row) => row.getBoundingClientRect()).sort((a, b) => a.top - b.top);
      assert(boxes.length > 1, "至少需要两行来验证几何关系");
      for (let index = 1; index < boxes.length; index++) {
        assert(
          boxes[index].top >= boxes[index - 1].bottom - 1,
          `弹幕行重叠：第 ${index} 行 bottom=${boxes[index - 1].bottom}，下一行 top=${boxes[index].top}`,
        );
      }
    };
    const assertWindow = (list) => {
      const count = Number(list.dataset.count);
      assert(list.hasAttribute("data-count") && Number.isInteger(count), "列表缺少有效 data-count");
      assert(count >= 0 && count <= LIMIT, `历史数据未保持 ${LIMIT} 上限：${count}`);
      assert(rowsOf(list).length < 100, `实际弹幕 DOM 未窗口化：${rowsOf(list).length}`);
      return { count, mounted: rowsOf(list).length };
    };

    // 必须在任何写入全局、设置 store 或导入业务模块之前拦截真实 Tauri 环境。
    assert(
      !window.isTauri && !window.__TAURI_INTERNALS__,
      "本夹具仅允许普通浏览器 mock 环境；检测到 Tauri，为避免真实收藏/发送/屏蔽已中止",
    );

    // 复用已加载源码 URL（包括 HMR 查询参数），避免第二份 eventBus 或 Zustand store。
    const sourceUrl = (path) =>
      [...performance.getEntriesByType("resource")]
        .reverse()
        .find((entry) => new URL(entry.name).pathname === path)?.name ?? path;
    const { QueryClient, QueryClientProvider } = await import(
      dependencyUrl("@tanstack_react-query")
    );
    const { DanmakuPanel } = await import(sourceUrl("/src/features/room/DanmakuPanel.tsx"));
    const { setExpectedDanmakuConnectionEpoch, clearExpectedDanmakuConnectionEpoch } = await import(
      sourceUrl("/src/features/room/danmaku/eventBus.ts")
    );
    const { useSettingsStore } = await import(sourceUrl("/src/shared/stores/settingsStore.ts"));
    const settings = useSettingsStore.getState();
    const storageKey = useSettingsStore.persist.getOptions().name;
    const oldStorage = localStorage.getItem(storageKey);
    const savedGlobals = ["isTauri", "__TAURI_INTERNALS__", "__TAURI_EVENT_PLUGIN_INTERNALS__"].map(
      (key) => [key, Object.getOwnPropertyDescriptor(window, key)],
    );
    const oldClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const callbacks = new Map();
    const listeners = new Map();
    const calls = [];
    const deferredFavorites = [];
    let deferFavorite = false;
    let clipboard = "";
    let nextCallback = 1;
    let nextListener = 1;
    let serial = 0;
    let peakMounted = 0;
    let harness;
    let observer;
    const epoch = 710023;
    const props = {
      active: true,
      visible: true,
      siteId: "bilibili",
      roomId: "789",
      roomTitle: "弹幕侧栏回归",
      roomUserName: "夹具主播",
    };
    const ipcStub = {
      transformCallback: (callback) => {
        const id = nextCallback++;
        callbacks.set(id, callback);
        return id;
      },
      unregisterCallback: (id) => callbacks.delete(id),
      invoke: async (command, args) => {
        calls.push({ command, args });
        if (command === "plugin:event|listen") {
          const id = nextListener++;
          listeners.set(id, { event: args.event, handler: callbacks.get(args.handler) });
          return id;
        }
        if (command === "plugin:event|unlisten") {
          listeners.delete(args.eventId);
          return;
        }
        if (command === "bilibili_danmaku_send_status")
          return {
            cookie_ready: true,
            available: true,
            message: "可发送",
          };
        if (command === "danmaku_favorite_list") return [];
        if (command === "danmaku_favorite_add") {
          if (deferFavorite) await new Promise((resolve) => deferredFavorites.push(resolve));
          return;
        }
        if (command === "bilibili_danmaku_send" || command === "settings_set") return;
        // 未知命令拒绝，不允许回退真实后端。
        throw new Error(`弹幕夹具未实现 IPC：${command}`);
      },
    };
    try {
      Object.defineProperty(window, "isTauri", { configurable: true, writable: true, value: true });
      Object.defineProperty(window, "__TAURI_INTERNALS__", {
        configurable: true,
        writable: true,
        value: ipcStub,
      });
      Object.defineProperty(window, "__TAURI_EVENT_PLUGIN_INTERNALS__", {
        configurable: true,
        writable: true,
        value: { unregisterListener: (_event, id) => listeners.delete(id) },
      });
      assert(window.__TAURI_INTERNALS__ === ipcStub, "IPC 桩未生效，禁止继续执行写操作");
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (text) => {
            clipboard = text;
          },
        },
      });
      useSettingsStore.setState({
        danmakuShieldWords: [],
        danmakuBlockedUsers: [],
        danmakuFilterGifts: false,
      });
      harness = await setupHarness({
        style:
          "position:fixed;left:24px;top:24px;width:360px;height:480px;z-index:40;background:var(--background);color:var(--foreground)",
      });
      harness.host.dataset.danmakuPanelTest = "";
      const { h } = harness;
      const render = (patch = {}) => {
        Object.assign(props, patch);
        harness.render(h(QueryClientProvider, { client }, h(DanmakuPanel, props)));
      };
      const list = () => harness.query(LIST);
      const viewport = () => harness.query(VIEWPORT);
      const rows = () => rowsOf(list());
      const count = () => Number(list()?.dataset.count);
      const rowFor = (text) => rows().find((row) => row.textContent.includes(text));
      const checkWindow = () => {
        const metrics = assertWindow(list());
        peakMounted = Math.max(peakMounted, metrics.mounted);
      };
      const ready = () =>
        until(
          () => [...listeners.values()].some((item) => item.event === "danmaku-batch"),
          "真实 eventBus 没有订阅 danmaku-batch",
        );
      const event = (content, user = "夹具观众") => ({
        kind: "chat",
        user,
        content,
        color: null,
        ts: Date.now(),
      });
      const emit = (events, connectionEpoch = epoch) => {
        const handlers = [...listeners.entries()].filter(
          ([, item]) => item.event === "danmaku-batch",
        );
        assert(handlers.length === 1, `eventBus 原生监听器应为单例，实际 ${handlers.length}`);
        for (const [id, { handler }] of handlers)
          handler({
            event: "danmaku-batch",
            id,
            payload: { connection_epoch: connectionEpoch, events },
          });
      };
      const reset = async () => {
        render({ active: false, visible: true });
        await until(() => count() === 0 && rows().length === 0, "active=false 未清空列表");
        serial = 0;
        render({ active: true });
        await ready();
        await frames();
      };
      const atBottom = () => {
        const view = viewport();
        return Math.abs(view.scrollHeight - view.clientHeight - view.scrollTop) <= 2;
      };
      const appendPinned = async (amount) => {
        for (let done = 0; done < amount;) {
          const size = Math.min(24, amount - done);
          const batch = Array.from({ length: size }, () =>
            event(`消息-${String(++serial).padStart(5, "0")}`),
          );
          emit(batch);
          const tail = batch.at(-1).content;
          await until(
            () => count() === Math.min(serial, LIMIT) && rowFor(tail) && atBottom(),
            `底部跟随或批次提交失败：${tail}，预期 ${Math.min(serial, LIMIT)} 条`,
          );
          await frames();
          checkWindow();
          done += size;
        }
      };
      const backToBottom = async (tail) => {
        const button = harness.query('button[aria-label="滚动到底部"]');
        assert(button, "上滚后缺少回到底部按钮");
        button.click();
        await until(() => atBottom() && (!tail || rowFor(tail)), "点击回底未显示最新消息");
        await until(
          () => !harness.query('button[aria-label="滚动到底部"]'),
          "回底后按钮/未读状态未消失",
        );
        checkWindow();
      };
      const readAnchor = async () => {
        const view = viewport();
        view.scrollTop = (view.scrollHeight - view.clientHeight) / 2;
        view.dispatchEvent(new Event("scroll"));
        await until(
          () => harness.query('button[aria-label="滚动到底部"]'),
          "上滚后仍处于自动跟随模式",
        );
        await frames();
        const top = view.getBoundingClientRect().top;
        const row = rows().find((item) => {
          const box = item.getBoundingClientRect();
          return box.top >= top && box.bottom <= top + view.clientHeight;
        });
        assert(row, "没有找到视口内完整的阅读锚点");
        const wrapper = row.closest("[data-index]");
        assert(wrapper, "虚拟行缺少 data-index，无法确认满容量裁剪已实际提交");
        return {
          id: row.dataset.danmakuId,
          top: row.getBoundingClientRect().top - top,
          index: Number(wrapper.dataset.index),
        };
      };
      const anchorRow = (anchor) => rows().find((row) => row.dataset.danmakuId === anchor.id);
      const assertAnchor = (anchor, label) => {
        const row = anchorRow(anchor);
        assert(row, `${label}：阅读中的消息被卸载或裁掉`);
        const top = row.getBoundingClientRect().top - viewport().getBoundingClientRect().top;
        assert(Math.abs(top - anchor.top) <= 2, `${label}：锚点漂移 ${top - anchor.top}px`);
        assert(!atBottom(), `${label}：用户被强制拉回底部`);
      };
      setExpectedDanmakuConnectionEpoch(epoch);
      render();
      await ready();
      await frames(); // 等 StrictMode 的首轮异步 listen/unlisten 完整交接。
      await until(
        () => list() && viewport()?.clientHeight > 0,
        "面板缺少列表标记或滚动 viewport 没有高度",
      );
      emit([event("过期连接消息")], epoch - 1);
      emit([event("当前连接消息")]);
      await until(
        () => count() === 1 && rowFor("当前连接消息"),
        "matching connection_epoch 的消息未送达",
      );
      assert(!rowFor("过期连接消息"), "过期 connection_epoch 穿透 eventBus");
      passed.push("真实 eventBus 仅接受匹配 connection_epoch 的批次");

      await reset();
      await appendPinned(240);
      const appendAnchor = await readAnchor();
      emit(Array.from({ length: 24 }, () => event(`消息-${String(++serial).padStart(5, "0")}`)));
      await until(() => count() === 264, "上滚期间没有继续收集消息");
      await frames();
      assertAnchor(appendAnchor, "普通追加");
      await backToBottom("消息-00264");
      passed.push("底部跟随、上滚追加不移动阅读锚点、回底恢复跟随");

      await appendPinned(1500 - serial);
      assert(count() === LIMIT, `1500 事件后应恰好保留 ${LIMIT} 条，实际 ${count()}`);
      checkWindow();
      const trimAnchor = await readAnchor();
      emit(Array.from({ length: 24 }, () => event(`消息-${String(++serial).padStart(5, "0")}`)));
      // 满容量时 data-count 不变，用原锚点的虚拟索引前移确认裁剪已提交，避免仅等两帧的假阳性。
      await until(
        () =>
          Number(anchorRow(trimAnchor)?.closest("[data-index]")?.dataset.index) ===
          trimAnchor.index - 24,
        "达到 1200 后没有裁掉最旧 24 行，或阅读锚点丢失",
      );
      await frames();
      assert(count() === LIMIT, "阅读期间追加突破 1200 上限");
      assertAnchor(trimAnchor, "满容量裁剪");
      checkWindow();
      await backToBottom("消息-01524");
      passed.push("1500 事件后数据有界 1200、DOM <100；满容量裁剪不移动阅读锚点");

      // 阅读最旧段且整段被淘汰：应回到保留窗口的开头，而不是跳过另一批消息。
      viewport().scrollTop = 150;
      viewport().dispatchEvent(new Event("scroll"));
      await frames();
      const oldFirstId = Math.min(...rows().map((row) => Number(row.dataset.danmakuId)));
      emit(Array.from({ length: 24 }, () => event(`消息-${String(++serial).padStart(5, "0")}`)));
      await until(
        () => !rows().some((row) => Number(row.dataset.danmakuId) === oldFirstId),
        "最旧数据没有淘汰",
      );
      await frames();
      assert(viewport().scrollTop < 2, "阅读锚点被淘汰后没有退到保留窗口开头");
      passed.push("阅读锚点被淘汰时退到窗口开头");

      await reset();
      const longText = "长文本换行测量，不能覆盖相邻弹幕。".repeat(20);
      emit([event("短文本之前"), event(longText), event("短文本之后")]);
      await until(() => count() === 3 && rows().length === 3, "长文本样本未提交");
      await frames();
      await until(
        () =>
          rowFor(longText)?.getBoundingClientRect().height >
          rowFor("短文本之前")?.getBoundingClientRect().height * 2,
        "长文本没有换行或高度未测量",
      );
      assertNoOverlap(rows());
      checkWindow();
      passed.push("长文本动态测量后相邻行不重叠");

      await reset();
      await appendPinned(24);
      render({ visible: false });
      await frames();
      const beforeHidden = list().innerHTML;
      const beforeCount = count();
      let mutations = 0;
      observer = new MutationObserver((records) => {
        mutations += records.length;
      });
      observer.observe(list(), {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
      });
      // 每帧持续投递，总跨度覆盖正常 flush 节奏，不使用固定秒级 sleep。
      for (let index = 0; index < 12; index++) {
        emit([event(`隐藏消息-${index}`)]);
        await frames();
      }
      assert(
        count() === beforeCount && list().innerHTML === beforeHidden && mutations === 0,
        `visible=false 仍重绘列表：count=${count()}，DOM mutations=${mutations}`,
      );
      observer.disconnect();
      observer = null;
      render({ visible: true });
      await until(
        () => count() === beforeCount + 12 && rowFor("隐藏消息-11") && atBottom(),
        "恢复可见后没有冲刷隐藏期间的消息并回到底部",
      );
      passed.push("隐藏期间持续收集且列表零 DOM 变更，显示后补齐消息");

      await reset();
      const messageA = "菜单甲的纯文本";
      const messageB = "菜单乙的纯文本";
      emit([event(`  ${messageA}  `, "用户甲"), event(messageB, "用户乙")]);
      await until(() => count() === 2 && rowFor(messageA) && rowFor(messageB), "菜单样本未提交");
      const menus = () => [...document.querySelectorAll(MENU)];
      const menu = () => menus()[0];
      const menuButton = (text) =>
        [...(menu()?.querySelectorAll("button") ?? [])].find(
          (button) => button.textContent.trim() === text,
        );
      const status = () => menu()?.querySelector('[role="status"]')?.textContent ?? "";
      const clickRow = async (text, user) => {
        const row = rowFor(text);
        assert(
          row &&
            !row.matches('[data-slot="popover-trigger"]') &&
            !row.querySelector("button, [data-slot=popover-trigger]"),
          "原生行 button 不应创建逐行 PopoverTrigger 或嵌套 button 子树",
        );
        assert(
          [...row.childNodes].some(
            (node) => node.nodeType === Node.TEXT_NODE && node.textContent.includes(text),
          ),
          "样本不是行内纯文本，无法覆盖委托点击目标",
        );
        const box = row.getBoundingClientRect();
        row.dispatchEvent(
          new MouseEvent("click", {
            bubbles: true,
            cancelable: true,
            clientX: box.left + box.width / 2,
            clientY: box.top + box.height / 2,
          }),
        );
        await until(
          () =>
            menus().length === 1 && menuButton("屏蔽")?.getAttribute("aria-label")?.includes(user),
          `点击纯文本行没有打开唯一菜单或目标错误：${user}`,
        );
        assert(menu().querySelectorAll("button").length === 4, "菜单应只有复制/收藏/+1/屏蔽四项");
      };
      await clickRow(messageA, "用户甲");
      menuButton("复制").dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
      await until(() => menus().length === 0, "Escape 没有关闭菜单");
      await frames();
      assert(document.activeElement === rowFor(messageA), "Escape 后焦点未归还原生行按钮");
      await clickRow(messageA, "用户甲");
      harness.host.style.width = "300px";
      await until(() => menus().length === 0, "面板缩放后菜单仍锚在旧坐标");
      await clickRow(messageA, "用户甲");
      menuButton("复制").click();
      await until(
        () => clipboard === messageA && status().includes("已复制"),
        "复制未使用去除首尾空白的当前消息",
      );
      menuButton("收藏").click();
      await until(() => status().includes("已收藏"), "收藏未完成");
      assert(
        calls.some(
          ({ command, args }) =>
            command === "danmaku_favorite_add" &&
            args.siteId === "bilibili" &&
            args.content === messageA,
        ),
        "收藏 IPC 参数错误",
      );
      assert(
        client
          .getQueryData(["danmaku-favorites", "bilibili"])
          ?.some((item) => item.content === messageA),
        "收藏没有更新 QueryClient 缓存",
      );
      await until(() => !menuButton("+1")?.disabled, "+1 预检未就绪");
      menuButton("+1").click();
      await until(() => status().includes("已发送"), "+1 未完成");
      const send = calls.find(({ command }) => command === "bilibili_danmaku_send");
      assert(
        send?.args.roomId === props.roomId &&
          send.args.message === messageA &&
          send.args.roomTitle === props.roomTitle &&
          send.args.roomUserName === props.roomUserName,
        "+1 没有发送当前消息和房间身份",
      );
      assert(
        !calls.some(({ command }) => command === "video_danmaku_send"),
        "侧栏直播弹幕误走视频发送接口",
      );

      // 先验证完成状态不串目标，再验证未完成旧目标请求返回时不污染新目标。
      await clickRow(messageB, "用户乙");
      assert(status() === "", "切换目标后残留旧目标的操作状态");
      await clickRow(messageA, "用户甲");
      deferFavorite = true;
      menuButton("收藏").click();
      await until(() => deferredFavorites.length === 1, "未捕获延迟收藏请求");
      await clickRow(messageB, "用户乙");
      assert(
        !menuButton("收藏").disabled && status() === "",
        "切换目标后继承旧目标 pending/结果状态",
      );
      deferredFavorites.shift()();
      deferFavorite = false;
      await frames();
      assert(status() === "", "旧目标收藏完成后把结果写到了新目标菜单");
      menuButton("复制").click();
      await until(() => clipboard === messageB, "切换目标后的复制仍使用旧消息");
      menuButton("屏蔽").click();
      await until(
        () => count() === 1 && !rowFor(messageB) && menus().length === 0,
        "屏蔽没有立即隐藏用户消息并关闭菜单",
      );
      assert(
        useSettingsStore.getState().danmakuBlockedUsers.includes("用户乙") &&
          !useSettingsStore.getState().danmakuBlockedUsers.includes("用户甲"),
        "屏蔽串到了旧目标",
      );
      emit([event("被屏蔽后的消息", "用户乙"), event("未屏蔽用户继续出现", "用户甲")]);
      await until(() => count() === 2 && rowFor("未屏蔽用户继续出现"), "未屏蔽用户也被过滤");
      assert(!rowFor("被屏蔽后的消息"), "被屏蔽用户后续消息仍出现");
      passed.push("纯文本委托点击唯一菜单；复制/收藏/+1/屏蔽正确，目标状态和异步结果不串行");

      // 停用必须同时清空已提交列表、隐藏待提交队列和当前菜单。
      await clickRow(messageA, "用户甲");
      render({ visible: false });
      emit([event("停用前仍在队列中的消息")]);
      render({ active: false });
      await until(
        () => count() === 0 && rows().length === 0 && menus().length === 0,
        "active=false 未清空列表或关闭菜单",
      );
      render({ active: true, visible: true });
      await ready();
      await frames();
      emit([event("重新激活后的消息")]);
      await until(() => count() === 1 && rowFor("重新激活后的消息"), "重新激活后旧待提交队列复活");
      passed.push("active=false 清空列表、菜单和待提交队列，重新激活不回填旧数据");
      render({ roomId: "790" });
      assert(count() === 0 && menus().length === 0, "active保持true换房时没有清空旧房间");
      await ready();
      await frames();
      emit([event("新房间消息")]);
      await until(() => count() === 1 && rowFor("新房间消息"), "换房后订阅没有恢复");
      passed.push("房间身份变化清空旧数据、菜单和队列");
      return {
        mode: "普通浏览器完整 mock",
        passed,
        peakMounted,
        favoriteWrites: calls.filter(({ command }) => command === "danmaku_favorite_add").length,
        sendWrites: calls.filter(({ command }) => command === "bilibili_danmaku_send").length,
      };
    } finally {
      observer?.disconnect();
      for (const resolve of deferredFavorites) resolve();
      harness?.dispose();
      client.clear();
      clearExpectedDanmakuConnectionEpoch(epoch);
      useSettingsStore.setState(settings, true);
      if (oldStorage === null) localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, oldStorage);
      // 让 effect 清理和已开始的 mock Promise 先完成，恢复后不留下后台写操作。
      await frames();
      for (const [key, descriptor] of savedGlobals) {
        if (descriptor) Object.defineProperty(window, key, descriptor);
        else delete window[key];
      }
      if (oldClipboard) Object.defineProperty(navigator, "clipboard", oldClipboard);
      else delete navigator.clipboard;
    }
  });
  return result;
}
