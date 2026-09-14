// 真实鼠标驱动控制栏悬停菜单的「悬停展开后点触发器不收回」契约。
// 先启动 vite（bun run dev），再执行：
//   playwright-cli -s=hover-menu open http://127.0.0.1:1420/tests/browser/player-hover-menu.html
//   playwright-cli -s=hover-menu run-code --filename=tests/player-hover-menu.browser.js
async (page) => {
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const wait = (ms) => page.waitForTimeout(ms);
  const expanded = (label) =>
    page.evaluate((l) => {
      const t = document.querySelector(`[aria-label="${l}"]`);
      return t ? t.getAttribute("aria-expanded") : null;
    }, label);
  const center = async (label) => {
    const box = await page.locator(`[aria-label="${label}"]`).boundingBox();
    assert(box, `找不到触发器 ${label}`);
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  const away = async () => {
    await page.mouse.move(900, 80);
    await wait(350);
  };
  const hoverThenClick = async (label) => {
    const p = await center(label);
    await away();
    await page.mouse.move(p.x, p.y);
    await wait(450);
    assert((await expanded(label)) === "true", `${label} 悬停后应展开`);
    await page.mouse.click(p.x, p.y);
    await wait(350);
    assert((await expanded(label)) === "true", `${label} 点触发器后应保持展开`);
    return p;
  };

  await page.locator('[aria-label="播放设置"]').waitFor();
  const passed = [];

  const settings = await hoverThenClick("播放设置");
  passed.push("播放设置：悬停展开后点触发器不收回");
  await away();
  assert((await expanded("播放设置")) === "false", "播放设置移开指针后应收起");
  passed.push("播放设置：移开指针收起");

  await page.mouse.move(settings.x, settings.y);
  await wait(450);
  assert((await expanded("播放设置")) === "true", "播放设置再次悬停应展开");
  await page.keyboard.press("Escape");
  await wait(350);
  assert((await expanded("播放设置")) === "false", "播放设置 Esc 应收起");
  passed.push("播放设置：Esc 收起");

  await away();
  await page.mouse.click(settings.x, settings.y);
  await wait(350);
  assert((await expanded("播放设置")) === "true", "播放设置直接点击应打开");
  await away();
  passed.push("播放设置：未悬停时直接点击仍能打开");

  await hoverThenClick("开启字幕");
  passed.push("字幕：悬停展开后点触发器不收回");
  await away();
  assert((await expanded("开启字幕")) === "false", "字幕移开指针后应收起");
  passed.push("字幕：移开指针收起");

  await hoverThenClick("VOD 字幕");
  passed.push("VOD 字幕 Popover：悬停展开后点触发器不收回");
  await away();
  assert((await expanded("VOD 字幕")) === "false", "VOD 字幕移开指针后应收起");
  passed.push("VOD 字幕 Popover：移开指针收起");

  return passed;
};
