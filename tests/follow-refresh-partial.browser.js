// F-02：真实 FollowPage 在部分探测失败时的呈现与定向重试。
// 只桩 IPC，不访问真实站点；重点是「7 成功 + 3 失败」不被当成整页失败，
// 且重试只打那 3 个房间。
// playwright-cli -s=rwin run-code --filename=tests/follow-refresh-partial.browser.js
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
        `${signature}\nif (window.__followInvoke) return window.__followInvoke(cmd, args);`,
      ),
    }),
  );
  try {
    await page.goto(`${page.url().match(/^https?:\/\/[^/]+/)[0]}/follow`);
    return await page.evaluate(async () => {
      const { until, frames, assert } = await import("/tests/browser/harness.js");

      const follows = [];
      for (let index = 0; index < 10; index += 1) {
        follows.push({
          site_id: "bilibili",
          room_id: `${index}`,
          user_name: `主播${index}`,
          face: "",
          tag_ids: [],
          auto_record: false,
          // 失败的那三个保留上一轮结论：不冒充未开播。
          live_status: index < 7 ? true : null,
          live_started_at: null,
          updated_at: 1,
        });
      }
      const failedRooms = new Set(["7", "8", "9"]);
      const refreshCalls = [];
      const retriedRooms = [];

      const refreshResult = (rooms) => ({
        follows,
        summary: {
          total: rooms.length,
          refreshed: rooms.filter((room) => !failedRooms.has(room)).length,
          refreshed_keys: rooms
            .filter((room) => !failedRooms.has(room))
            .map((room) => `bilibili:${room}`),
          failures: rooms
            .filter((room) => failedRooms.has(room))
            .map((room) => ({
              site_id: "bilibili",
              room_id: room,
              user_name: `主播${room}`,
              code: "bilibili_http_error",
              retryable: true,
            })),
          checked_at: 1_700_000_000_000,
        },
      });

      window.__followInvoke = async (command, args) => {
        if (command === "follow_list") return follows;
        if (command === "follow_refresh") {
          refreshCalls.push("all");
          return refreshResult(follows.map((user) => user.room_id));
        }
        if (command === "follow_refresh_selected") {
          const rooms = args.targets.map((target) => target.room_id);
          retriedRooms.push(...rooms);
          // 重试后这三个仍失败，验证 UI 不会假装成功。
          return refreshResult(rooms);
        }
        if (command === "tag_list") return [];
        if (command === "settings_get") return {};
        return null;
      };

      try {
        await until(() => document.body.textContent.includes("主播0"), "关注列表未渲染");
        // 手动触发一次整表刷新。
        const refreshButton = [...document.querySelectorAll("button")].find((button) =>
          (button.getAttribute("aria-label") ?? "").includes("刷新直播关注"),
        );
        assert(refreshButton, "未找到刷新按钮");
        refreshButton.click();
        await until(() => refreshCalls.length > 0, "刷新未发出 IPC");
        await until(
          () => document.body.textContent.includes("未能确认状态"),
          "部分失败提示未出现",
        );
        await frames();

        const banner = [...document.querySelectorAll('[role="status"]')].find((node) =>
          node.textContent.includes("未能确认状态"),
        );
        assert(banner, "未找到部分失败提示条");
        assert(banner.textContent.includes("3"), "提示条未报告失败条数");
        // 10 条关注仍全部在列表里，而不是被截成 7 条。
        for (const room of ["0", "7", "8", "9"]) {
          assert(
            document.body.textContent.includes(`主播${room}`),
            `关注 ${room} 从列表消失，部分失败被当成整页失败`,
          );
        }

        const retryButton = [...banner.querySelectorAll("button")].find((button) =>
          button.textContent.includes("重试"),
        );
        assert(retryButton, "未找到重试入口");
        retryButton.click();
        await until(() => retriedRooms.length > 0, "定向重试未发出 IPC");
        await frames();

        return {
          passed: true,
          refreshCalls: refreshCalls.length,
          retriedRooms: [...retriedRooms].sort(),
          listSize: 10,
          // 三个未确认项在页面上仍是「状态未知」，不是「未开播」。
          unconfirmedStillUnknown: ["7", "8", "9"].every((room) =>
            document.body.textContent.includes(`主播${room}`),
          ),
        };
      } finally {
        delete window.__followInvoke;
      }
    });
  } finally {
    await page.unroute(pattern);
    await page.reload();
  }
}
