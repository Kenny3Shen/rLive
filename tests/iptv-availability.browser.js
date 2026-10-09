// F-03：真实 IPTV 页面的可用性呈现与身份隔离。
// 只桩 IPC（播放列表 + 探测），不访问真实频道。
// playwright-cli -s=rwin run-code --filename=tests/iptv-availability.browser.js
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
        `${signature}\nif (window.__iptvInvoke) return window.__iptvInvoke(cmd, args);`,
      ),
    }),
  );
  try {
    await page.goto(`${page.url().match(/^https?:\/\/[^/]+/)[0]}/iptv`);
    return await page.evaluate(async () => {
      const { until, frames, assert } = await import("/tests/browser/harness.js");

      // 同 URL、不同 Referer：一个允许、一个 403。
      const sharedUrl = "https://cdn.example.test/live.m3u8";
      const channels = [
        {
          id: "allowed",
          name: "允许的频道",
          group: "测试",
          logo: null,
          url: sharedUrl,
          protocol: "hls",
          headers: { Referer: "https://site-a.example" },
        },
        {
          id: "blocked",
          name: "被拒的频道",
          group: "测试",
          logo: null,
          url: sharedUrl,
          protocol: "hls",
          headers: { Referer: "https://site-b.example" },
        },
      ];

      const probeCalls = [];
      window.__iptvInvoke = async (command, args) => {
        if (command === "iptv_load_playlist") return channels;
        if (command === "settings_get") return {};
        if (command === "iptv_check_channels") {
          probeCalls.push(args.checks);
          return args.checks.map((check) => {
            const referer = check.headers.Referer ?? "";
            if (referer === "https://site-b.example") {
              return {
                url: check.url,
                available: false,
                latencyMs: 5,
                httpStatus: 403,
                message: "频道返回 HTTP 403",
              };
            }
            return {
              url: check.url,
              available: true,
              latencyMs: 7,
              httpStatus: 200,
              message: null,
            };
          });
        }
        return null;
      };

      const findButton = (label) =>
        [...document.querySelectorAll("button")].find((button) =>
          (button.getAttribute("aria-label") ?? "").includes(label),
        );

      try {
        await until(() => document.body.textContent.includes("允许的频道"), "播放列表未渲染");

        // 只保留一个检测入口，不再有深探测。
        assert(!findButton("深探测"), "深探测入口应已移除");
        const probe = findButton("检测频道可用性");
        assert(probe, "未找到检测按钮");
        // 首次进入 IPTV 的预热（notify=false）可能先发过一次探测，这里不关心总次数。
        probe.click();
        await until(() => probeCalls.length > 0, "检测未发出 IPC");
        assert(
          probeCalls.flat().every((check) => !("deep" in check)),
          "检测请求不应再携带 deep 字段",
        );
        await until(
          () => document.body.textContent.includes("被拒的频道"),
          "结果未回到页面",
        );
        await frames();

        // 被拒的条目应带不可用语义，允许的条目应带可达语义。
        const allowedCard = [...document.querySelectorAll("li")].find((node) =>
          node.textContent.includes("允许的频道"),
        );
        const blockedCard = [...document.querySelectorAll("li")].find((node) =>
          node.textContent.includes("被拒的频道"),
        );
        assert(allowedCard && blockedCard, "未找到两张卡片");
        assert(
          allowedCard.querySelector('[aria-label*="网络可达"]'),
          "同 URL 的允许条目未标为网络可达",
        );
        assert(
          blockedCard.querySelector('[aria-label*="不可用"]'),
          "同 URL 的被拒条目未标为不可用（状态被串用）",
        );

        return {
          passed: true,
          probeBatches: probeCalls.length,
          sameUrlIsolated: true,
        };
      } finally {
        delete window.__iptvInvoke;
      }
    });
  } finally {
    await page.unroute(pattern);
    await page.reload();
  }
}
