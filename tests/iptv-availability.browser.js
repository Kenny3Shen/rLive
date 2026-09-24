// F-03：真实 IPTV 页面的分级可用性呈现与身份隔离。
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
        {
          id: "fragment-403",
          name: "清单可用分片被拒",
          group: "测试",
          logo: null,
          url: "https://cdn.example.test/frag.m3u8",
          protocol: "hls",
          headers: {},
        },
        {
          id: "verified",
          name: "深探测已验证",
          group: "测试",
          logo: null,
          url: "https://cdn.example.test/verified.m3u8",
          protocol: "hls",
          headers: {},
        },
      ];

      const deepFlags = [];
      const probeCalls = [];
      window.__iptvInvoke = async (command, args) => {
        if (command === "iptv_load_playlist") return channels;
        if (command === "settings_get") return {};
        if (command === "iptv_check_channels") {
          probeCalls.push(args.checks.map((check) => check.headers.Referer ?? check.url));
          return args.checks.map((check) => {
            deepFlags.push(Boolean(check.deep));
            const referer = check.headers.Referer ?? "";
            const deep = Boolean(check.deep);
            if (referer === "https://site-b.example") {
              return {
                url: check.url,
                available: false,
                latencyMs: 5,
                httpStatus: 403,
                message: "频道返回 HTTP 403",
                level: null,
                mediaMessage: null,
              };
            }
            if (check.url.includes("frag.m3u8")) {
              // 清单有效，但深探测发现首个分片 403：只能是「网络可达」。
              return {
                url: check.url,
                available: true,
                latencyMs: 9,
                httpStatus: 200,
                message: null,
                level: "reachable",
                mediaMessage: deep ? "首个媒体资源返回 HTTP 403" : null,
              };
            }
            if (check.url.includes("verified.m3u8")) {
              return {
                url: check.url,
                available: true,
                latencyMs: 11,
                httpStatus: 200,
                message: null,
                level: deep ? "media_verified" : "reachable",
                mediaMessage: null,
              };
            }
            return {
              url: check.url,
              available: true,
              latencyMs: 7,
              httpStatus: 200,
              message: null,
              level: "reachable",
              mediaMessage: null,
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

        // 浅探测：同 URL 的两个条目必须得到不同结论。
        const shallow = findButton("检测频道可用性");
        assert(shallow, "未找到浅探测按钮");
        // 应用启动预热（延迟 700ms、notify=false）也可能发过一次浅探测；
        // 这里关心的是「浅探测从不请求 deep」，而不是总次数。
        shallow.click();
        await until(() => probeCalls.length > 0, "浅探测未发出 IPC");
        assert(deepFlags.every((deep) => deep === false), "浅探测不应请求深探测");
        const shallowProbes = probeCalls.length;
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

        // 深探测：清单可用但分片 403 的条目仍不能显示为媒体验证。
        const deepButton = findButton("深探测媒体可用性");
        assert(deepButton, "未找到深探测按钮");
        // 只统计这次深探测点击之后发出的请求。
        const probeCallsBefore = probeCalls.length;
        const deepFlagsBefore = deepFlags.length;
        deepButton.click();
        await until(() => deepFlags.length > deepFlagsBefore, "深探测未发出 IPC");
        const deepProbeCalls = probeCalls.slice(probeCallsBefore);
        await frames();

        const fragCard = [...document.querySelectorAll("li")].find((node) =>
          node.textContent.includes("清单可用分片被拒"),
        );
        assert(fragCard, "未找到分片被拒的卡片");
        assert(
          fragCard.querySelector('[aria-label*="网络可达"]'),
          "分片 403 的条目被显示成媒体已验证",
        );
        assert(
          !fragCard.querySelector('[aria-label*="媒体已验证"]'),
          "分片 403 的条目错误地显示为媒体已验证",
        );
        assert(
          fragCard.querySelector('[title*="403"]'),
          "深探测的媒体失败原因未展示",
        );

        const verifiedCard = [...document.querySelectorAll("li")].find((node) =>
          node.textContent.includes("深探测已验证"),
        );
        assert(verifiedCard, "未找到已验证卡片");
        assert(
          verifiedCard.querySelector('[aria-label*="媒体已验证"]'),
          "深探测成功的条目未标为媒体已验证",
        );

        return {
          passed: true,
          shallowProbeCalls: shallowProbes,
          // 深探测点击之后发出的批次，每批 4 条且全部 deep=true。
          deepProbeBatches: deepProbeCalls.length,
          deepProbes: deepFlags.slice(deepFlagsBefore).filter(Boolean).length,
          shallowProbeRanges: probeCalls[0]?.length ?? 0,
          sameUrlIsolated: true,
          fragment403NotVerified: true,
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
