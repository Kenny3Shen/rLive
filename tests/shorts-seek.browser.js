// 短视频进度条（Video.js TimeSlider 细变体）的浏览器回归：
//   playwright-cli -s=shorts-seek open http://127.0.0.1:1420/ && \
//   playwright-cli -s=shorts-seek run-code --filename=tests/shorts-seek.browser.js
//
// 断言五件事：
//   1. `data-slot="shorts-seek"` 仍在 20px 命中层上，视觉轨道 3px 且只占它的底边；
//   2. 拖动期间只改 CSS 变量、不逐帧 seek，释放才提交一次；
//   3. 键盘左右键走 5s 步长；
//   4. 悬停预览有缩略图，且按 B 站单格 160×90 原尺寸显示；
//   5. 第一次交互会 `onArmed`（页面据此才去取快照）。
async (page) => {
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };

  const origin = page.url().replace(/\/[^/]*$/, "");
  await page.goto(`${origin}/tests/browser/shorts-seek.html`);
  await page.waitForFunction(() => !!window.__shortsSeek, null, { timeout: 15000 });
  await page.evaluate(() => window.__shortsSeek.mount());

  const geometry = await page.evaluate(() => window.__shortsSeek.geometry());
  console.log("geometry:", JSON.stringify(geometry));
  assert(geometry.hit, "命中层必须存在");
  assert(
    Math.round(geometry.hit.height) === 20,
    `命中层应为 20px，实测 ${geometry.hit.height}`,
  );
  assert(
    Math.round(geometry.track.height) === 3,
    `视觉轨道应为 3px，实测 ${geometry.track.height}`,
  );
  assert(
    Math.abs(geometry.track.y + geometry.track.height - (geometry.hit.y + geometry.hit.height)) < 1,
    "视觉轨道应贴在命中层底边（替掉原来的 border-t）",
  );
  assert(
    Math.abs(geometry.hit.x - geometry.host.x) < 1 &&
      Math.abs(geometry.hit.width - geometry.host.width) < 1,
    "命中层应通栏（横向铺满底栏）",
  );
  assert(geometry.thumbRole === "slider", `可聚焦的 Thumb 应是 role=slider，实测 ${geometry.thumbRole}`);
  assert(geometry.thumbTabIndex === "0", "可 seek 时 Thumb 应可聚焦");
  assert(
    geometry.thumb && geometry.thumb.width > 0 && geometry.thumb.height > 0,
    "Thumb 应渲染出来（键盘与拖动共用它）",
  );

  const drag = await page.evaluate(() => window.__shortsSeek.drag(0.75));
  console.log("drag:", JSON.stringify(drag));
  assert(drag.during.seekingBeforeRelease === 0, "拖动期间不得逐帧 seek（DASH 取流会崩）");
  assert(drag.during.pointer !== "" && drag.during.pointer !== "0.000%", "拖动中应跟随指针位置");
  assert(drag.commits === 1, `释放应只提交一次 seek，实测 ${drag.commits}`);
  assert(
    drag.last != null && Math.abs(drag.last - 93 * 0.75) < 2,
    `提交的秒数应对应 75% 位置，实测 ${drag.last}`,
  );

  const armedAfterDrag = await page.evaluate(() => window.__shortsSeek.armed());
  assert(armedAfterDrag >= 1, "拖动应触发 onArmed（页面据此取快照）");

  const hover = await page.evaluate(() => window.__shortsSeek.hover(0.5));
  console.log("hover:", JSON.stringify(hover));
  assert(hover.pointing, "悬停应进入 data-pointing（原语默认显示预览）");
  assert(hover.thumbnailsPresent >= 1, "悬停预览应有缩略图");
  assert(
    hover.thumbnail && Math.abs(hover.thumbnail.width - 160) <= 1,
    `缩略图宽应为 160（B 站单格），实测 ${JSON.stringify(hover.thumbnail)}`,
  );
  assert(
    hover.thumbnail && Math.abs(hover.thumbnail.height - 90) <= 1,
    `缩略图高应为 90（B 站单格），实测 ${JSON.stringify(hover.thumbnail)}`,
  );

  // 预览气泡两端都不得探出轨道。
  const hoverEdge = await page.evaluate(() => window.__shortsSeek.hover(1));
  assert(
    hoverEdge.preview && hoverEdge.preview.x + hoverEdge.preview.width <= hoverEdge.track.x + hoverEdge.track.width + 1,
    `预览气泡应夹在轨道内，实测 ${JSON.stringify(hoverEdge.preview)}`,
  );

  const before = await page.evaluate(() => window.__shortsSeek.seekCount());
  const right = await page.evaluate(() => window.__shortsSeek.key("ArrowRight"));
  console.log("key:", JSON.stringify(right));
  assert(right.count > before, "右方向键应发起 seek");
  assert(
    Math.abs(right.last - (drag.last + 5)) < 1.5,
    `右方向键应前进 5s（原语 step），实测 ${right.last}`,
  );

  await page.screenshot({ path: ".playwright-cli/shorts-seek.png" });
  return "shorts seek ok";
}
