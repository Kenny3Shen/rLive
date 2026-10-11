// 设置行高契约：行高由标题文字决定，控件不许把整行撑高。
//
// 三处设置表面共用同一套规则（见 `styles.css` 的 `--settings-row-height`）：
//
//   设置页（`.settings-section`）    56px，上下各 12px
//   侧栏设置页签（`.settings-panel`） 44px，上下各 8px
//   设置导航页（`.settings-category-row`）64px，分割线用伪元素
//
// 从前同一个列表里会混出三种行高：滑杆行 44px、「管理」按钮行 52px（侧栏页签里是
// 44px 与 68px）。原因是按钮、分段选项与输入框自带 28–32px 高度，粗指针下还有
// `min-h-11`（44px）的触摸下限。现在控件保留自己的视觉高度并在行内居中，触摸热区
// 改由透明 `::after` 向上下撑开。
//
// 断言的是渲染后的几何而不是类名字符串：改回按控件高度撑行、或让分割线重新占布局
// 高度（`divide-y`），这里都会失败。
//
// 只桩 IPC，不访问真实站点。用法：
//   playwright-cli -s=rowheight run-code --filename=tests/settings-row-height.browser.js
// oxlint-disable-next-line no-unused-expressions -- run-code 要求顶层函数表达式。
async (page) => {
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const cdp = await page.context().newCDPSession(page);
  const origin = await page.evaluate(() => location.origin);
  const desktopUa = await page.evaluate(() => navigator.userAgent);
  const passed = [];

  /** 设置页里的单行设置条：横向与响应式都按 56px 契约走。 */
  const readSectionRows = () =>
    [...document.querySelectorAll('[data-slot="settings-section"] [data-slot="field"]')].map((row) => {
      const box = row.getBoundingClientRect();
      const label = row.querySelector('[data-slot="field-label"]');
      const labelBox = label?.getBoundingClientRect();
      const controls = [...row.children].filter(
        (child) => !child.matches('[data-slot="field-content"]'),
      );
      const after = getComputedStyle(row, '::after');
      return {
        title: (label?.textContent ?? '').trim(),
        orientation: row.getAttribute('data-orientation'),
        height: box.height,
        hasContent: Boolean(row.querySelector('[data-slot="field-content"]')),
        topGap: labelBox ? labelBox.top - box.top : null,
        bottomGap: labelBox ? box.bottom - labelBox.bottom : null,
        // 控件自身的视觉高度：判断它有没有被拉满整行。
        controlHeights: controls.map((child) => child.getBoundingClientRect().height),
        dividerHeight: after.height,
      };
    });

  /** 侧栏设置页签里的单行设置条：44px，与表单触摸目标下限同高。 */
  const readPanelRows = () =>
    [...document.querySelectorAll('[data-room-side-tab-panel="settings"] [data-slot="field"]')].map(
      (row) => {
        const box = row.getBoundingClientRect();
        const label = row.querySelector('[data-slot="field-label"]');
        const labelBox = label?.getBoundingClientRect();
        const controls = [...row.children].filter(
          (child) => !child.matches('[data-slot="field-content"]'),
        );
        return {
          title: (label?.textContent ?? '').trim(),
          height: box.height,
          topGap: labelBox ? labelBox.top - box.top : null,
          bottomGap: labelBox ? box.bottom - labelBox.bottom : null,
          controlHeights: controls.map((child) => child.getBoundingClientRect().height),
        };
      },
    );

  const clickSettingsTab = async () => {
    await page.evaluate(() => {
      const tab = [...document.querySelectorAll('[role="tab"]')].find(
        (candidate) => candidate.textContent.trim() === "设置",
      );
      tab?.click();
    });
    await page.waitForTimeout(700);
  };

  try {
    // ── 1. 设置页：桌面与触摸两种指针下都是 56px、上下各 12px ──────────────
    const sectionExpectations = [
      // 外观配置：「亮暗模式」是分段选项（28px），「动态背景效果」是开关（18.4px）。
      { section: "appearance", titles: ["亮暗模式", "动态背景效果"] },
      // 播放与弹幕：滑杆行、「管理」按钮行、下拉（ToggleGroup）行混在同一列表里。
      { section: "playback", titles: ["优先清晰度", "弹幕字号", "屏蔽词", "恢复默认设置"] },
      // 账号与权限：标题行带徽标与账号名，右侧是 28px 按钮组。
      { section: "account", titles: ["哔哩哔哩"] },
    ];

    const assertSectionRows = (rows, scope) => {
      for (const row of rows) {
        // 竖排行（代理地址、保存位置、局域网同步）内容本身多行，不受本契约约束。
        if (row.orientation === "vertical") continue;
        assert(
          Math.abs(row.height - 56) < 0.6,
          `${scope}「${row.title}」行高 ${row.height}px，不是 56px`,
        );
        // 带 `field-content` 的行允许顶部对齐（标题下方会堆说明与报错）；
        // 只有标题与控件的行必须垂直居中，标题上下留白相等。
        if (!row.hasContent) {
          assert(
            Math.abs(row.topGap - row.bottomGap) < 1.2,
            `${scope}「${row.title}」标题上下留白不等（${row.topGap} / ${row.bottomGap}）`,
          );
        }
        assert(
          row.topGap >= 0 && row.bottomGap >= 0,
          `${scope}「${row.title}」内容溢出了设置条（${row.topGap} / ${row.bottomGap}）`,
        );
        // 控件自己不许被拉伸到整行高：最高 32px（按钮/输入组）。
        for (const height of row.controlHeights) {
          assert(
            height <= 34,
            `${scope}「${row.title}」的控件被撑到 ${height}px，超过了 32px 的视觉高度`,
          );
        }
      }
    };

    for (const expectation of sectionExpectations) {
      await page.goto(`${origin}/settings?section=${expectation.section}`);
      await page.waitForTimeout(800);
      const rows = await page.evaluate(readSectionRows);
      const picked = expectation.titles
        .map((title) => rows.find((row) => row.title.includes(title)))
        .filter(Boolean);
      assert(
        picked.length === expectation.titles.length,
        `${expectation.section} 缺少设置条：期望 ${expectation.titles.join("、")}，实到 ${picked.map((row) => row.title).join("、")}`,
      );
      assertSectionRows(picked, `设置页 ${expectation.section} `);
    }
    passed.push("设置页各行在桌面指针下都是 56px");

    // 分割线必须不占布局高度：`divide-y` 的真边框会让除末行外的每个条目高 1px。
    await page.goto(`${origin}/settings?section=playback`);
    await page.waitForTimeout(700);
    const dividerRows = await page.evaluate(readSectionRows);
    assert(dividerRows.length > 2, "播放与弹幕分类的设置条太少，测不出分割线");
    assert(
      dividerRows.some((row) => row.dividerHeight === "1px"),
      "设置条之间没有画出分割线",
    );
    const dividerHeights = new Set(dividerRows.map((row) => Math.round(row.height)));
    assert(dividerHeights.size === 1, `分割线让行高出现多档：${[...dividerHeights].join("/")}`);
    passed.push("分割线用伪元素，不占布局高度");

    // ── 2. 设置导航页：条目等高，分割线同样不占高度 ────────────────────────
    await page.goto(`${origin}/settings`);
    await page.waitForTimeout(800);
    const navGroups = await page.evaluate(() =>
      [...document.querySelectorAll(".settings-category-list")].map((card) =>
        [...card.querySelectorAll(".settings-category-row")].map((wrapper) => {
          const button = wrapper.querySelector("button");
          const box = wrapper.getBoundingClientRect();
          return {
            height: box.height,
            buttonHeight: button.getBoundingClientRect().height,
            borderTop: parseFloat(getComputedStyle(wrapper).borderTopWidth),
            dividerHeight: getComputedStyle(wrapper, "::after").height,
          };
        }),
      ),
    );
    const navRows = navGroups.flat();
    assert(navRows.length > 4, `设置导航条目只有 ${navRows.length} 条`);
    const navHeights = new Set(navRows.map((row) => Math.round(row.height)));
    assert(navHeights.size === 1, `设置导航条目高出现多档：${[...navHeights].join("/")}`);
    assert(
      navRows.every((row) => row.borderTop === 0),
      "设置导航条目仍用真边框画分割线（会占 1px 布局高度）",
    );
    // 分割线按分组画：每组除末条外各一条。
    for (const group of navGroups) {
      const dividers = group.filter((row) => row.dividerHeight === "1px").length;
      assert(
        dividers === group.length - 1,
        `设置导航分组里分割线 ${dividers} 条，应为 ${group.length - 1} 条`,
      );
    }
    passed.push("设置导航条目等高且分割线不占高度");

    // 悬停时按钮横向平移，分割线留在原地（这是分割线挂在静态包裹上的原因）。
    // 用显式鼠标坐标而不是 `locator.hover()`：后者会把元素滚进视口，页面滚动会污染
    // 前后的横坐标对比。
    const readNavX = () =>
      page.evaluate(() => {
        const wrapper = document.querySelector(".settings-category-row");
        const button = wrapper.querySelector("button");
        return {
          wrapper: wrapper.getBoundingClientRect().x,
          button: button.getBoundingClientRect().x,
          transform: getComputedStyle(button).transform,
        };
      });
    await page.mouse.move(24, 700);
    await page.waitForTimeout(300);
    const restX = await readNavX();
    const hoverTarget = await page.evaluate(() => {
      const box = document.querySelector(".settings-category-button").getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    });
    await page.mouse.move(hoverTarget.x, hoverTarget.y);
    await page.waitForTimeout(400);
    const hoverX = await readNavX();
    assert(
      Math.abs(hoverX.wrapper - restX.wrapper) < 0.5,
      "悬停时分割线所在的包裹层跟着平移了",
    );
    assert(hoverX.button > restX.button, "设置导航按钮悬停时没有相对包裹层平移");
    await page.mouse.move(24, 700);
    await page.waitForTimeout(300);
    passed.push("悬停平移只作用于按钮，分割线不动");

    // ── 3. 侧栏设置页签：滑杆行与「管理」按钮行同为 44px ───────────────────
    await page.goto(`${origin}/room/bilibili/13308358`);
    await page.waitForTimeout(3000);
    await clickSettingsTab();
    const desktopPanel = await page.evaluate(readPanelRows);
    assert(desktopPanel.length > 4, `侧栏设置页签只有 ${desktopPanel.length} 条设置`);
    for (const row of desktopPanel) {
      assert(
        Math.abs(row.height - 44) < 0.6,
        `侧栏设置页签「${row.title}」行高 ${row.height}px，不是 44px`,
      );
      assert(
        Math.abs(row.topGap - row.bottomGap) < 1.2,
        `侧栏设置页签「${row.title}」标题上下留白不等（${row.topGap} / ${row.bottomGap}）`,
      );
      for (const height of row.controlHeights) {
        assert(
          height <= 30,
          `侧栏设置页签「${row.title}」的控件被撑到 ${height}px，超过了 28px 的视觉高度`,
        );
      }
    }
    passed.push("侧栏设置页签各行在桌面指针下都是 44px");

    // ── 4. 触摸端：控件保留视觉高度，热区补到整行 ─────────────────────────
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    await page.goto(`${origin}/settings?section=appearance`);
    await page.waitForTimeout(900);
    const touchCoarse = await page.evaluate(() => matchMedia("(pointer: coarse)").matches);
    assert(touchCoarse, "触摸模拟没有生效，量到的仍是细指针");
    assertSectionRows(await page.evaluate(readSectionRows), "触摸端设置页 ");

    await page.goto(`${origin}/room/bilibili/13308358`);
    await page.waitForTimeout(3000);
    await clickSettingsTab();
    // 把「屏蔽词」行滚进视口中间再量命中区。
    await page.evaluate(() => {
      const rows = [
        ...document.querySelectorAll('[data-room-side-tab-panel="settings"] [data-slot="field"]'),
      ];
      const row = rows.find((candidate) =>
        (candidate.querySelector('[data-slot="field-label"]')?.textContent ?? "").includes("屏蔽词"),
      );
      row?.scrollIntoView({ block: "center" });
    });
    await page.waitForTimeout(500);
    const touchHit = await page.evaluate(() => {
      const rows = [
        ...document.querySelectorAll('[data-room-side-tab-panel="settings"] [data-slot="field"]'),
      ];
      const row = rows.find((candidate) =>
        (candidate.querySelector('[data-slot="field-label"]')?.textContent ?? "").includes("屏蔽词"),
      );
      if (!row) return null;
      const button = row.querySelector("button");
      const buttonBox = button.getBoundingClientRect();
      const rowBox = row.getBoundingClientRect();
      const centerX = buttonBox.left + buttonBox.width / 2;
      // 按钮可见框上方/下方 6px：落在透明 `::after` 补出的热区里，应仍命中按钮本身。
      const probe = (y) => {
        const hit = document.elementFromPoint(centerX, y);
        return hit === button || button.contains(hit);
      };
      return {
        rowHeight: rowBox.height,
        buttonHeight: buttonBox.height,
        hitAbove: probe(buttonBox.top - 6),
        hitBelow: probe(buttonBox.bottom + 6),
      };
    });
    assert(touchHit, "侧栏设置页签里没有「屏蔽词」行");
    assert(
      Math.abs(touchHit.rowHeight - 44) < 0.6,
      `触摸端侧栏「屏蔽词」行高 ${touchHit.rowHeight}px，不是 44px`,
    );
    assert(touchHit.buttonHeight <= 30, `触摸端「管理」按钮视觉高度 ${touchHit.buttonHeight}px`);
    assert(touchHit.hitAbove, "「管理」按钮上方 6px 没有命中按钮（触摸热区没补上）");
    assert(touchHit.hitBelow, "「管理」按钮下方 6px 没有命中按钮（触摸热区没补上）");
    passed.push("触摸端保留 28px 视觉高度并把热区补到整行");

    return { passed };
  } finally {
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    }).catch(() => {});
    await cdp.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
    await cdp.send("Network.setUserAgentOverride", { userAgent: desktopUa }).catch(() => {});
    await cdp.detach();
  }
}
