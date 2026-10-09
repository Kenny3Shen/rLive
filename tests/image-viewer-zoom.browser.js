// VOD 评论图片查看器的缩放回归。触屏：双指捏合、双击放大/复位、放大后单指平移。
// 桌面：滚轮缩放（不许穿透到页面）、触控板捏合（ctrl + wheel）、键盘 + / - / 0、
// 双击、放大后左键拖拽平移。两者都验证「放大期间横向拖动不翻页」与「换图按图复位」。
//
// 夹具挂真实 `ImageViewer`（含真实 base-ui Dialog 与两个手势 hook），只把图片请求
// 换成内联 SVG，因此图片有确定的固有尺寸，几何换算与真实观感一致。
//
// 分三段执行：先挂载并把夹具读数与合成手势助手挂到 window；外层用真实输入跑桌面
// 断言（`page.mouse.dblclick` / `page.mouse.wheel` / `Keyboard` —— 真实命中测试与
// passive 监听器语义是合成事件替代不了的，滚轮尤其如此：React 的 `onWheel` 在根节点上
// passive 代理，只有原生非 passive 监听器才挡得住页面跟着滚）；最后用同一批助手跑
// 触屏手势断言。合成 PointerEvent 不建立浏览器原生指针，`setPointerCapture` 会抛
// NotFoundError；夹具把弹层的捕获方法置空（与 `video-sidebar-track.browser.js` 同一做法）。
//
// 先启动 vite（bun run dev）并打开预览页，再执行：
//   playwright-cli -s=image-zoom open http://127.0.0.1:1425/
//   playwright-cli -s=image-zoom run-code --filename=tests/image-viewer-zoom.browser.js
async (page) => {
  await page.setViewportSize({ width: 420, height: 760 });
  // 从干净页面开始：弹层 portal 到 body，上一次运行留下的实例会与本次堆叠，
  // `querySelector` 取到旧的、`elementFromPoint` 取到新的，真实鼠标断言就会错位。
  await page.reload();
  await page.waitForFunction(() =>
    performance
      .getEntriesByType("resource")
      .some((entry) => new URL(entry.name).pathname.endsWith("/deps/react-dom_client.js")),
  );
  // 图片地址必须是 https 才会被 `normalizeImageUrl` 放行（桌面 WebView 走本机代理，
  // 普通浏览器里退化为直连）。这里就地回一张有固有尺寸的 SVG，不发出真实请求。
  // 竖版 9:16：在 420×760 视口里按 `max-w-[90vw]` 适配成 378×672，
  // 放大 2.5 倍后横纵都超出视口，平移边界在两根轴上都非零。
  await page.route("https://images.rlive.test/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "image/svg+xml",
      body: `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1600"><rect width="900" height="1600" fill="#31415a"/></svg>`,
    }),
  );

  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));

  // ---- 第一段：挂载查看器，导出读数与合成手势助手 ----
  const bootstrap = await page.evaluate(async () => {
    const { setupHarness, assert, frames, settleAnimations } = await import(
      "/tests/browser/harness.js"
    );
    const { ImageViewer } = await import(
      `/src/shared/components/ImageViewer.tsx?image-zoom=${Date.now()}`
    );

    // 不设 z-index：弹层 portal 到 body（z-50），宿主抬层级会盖在它上面，
    // 真实鼠标的点就落不到弹层上了。合成事件不经命中测试，掩盖不了这一点。
    const ui = await setupHarness({ style: "position:fixed;inset:0;background:var(--background)" });
    const { React, h } = ui;

    /** 共享的关闭计数：换实例重挂时仍累加到同一个数上。 */
    const state = { closed: 0 };
    const IMAGES = [
      "https://images.rlive.test/1.png",
      "https://images.rlive.test/2.png",
      "https://images.rlive.test/3.png",
    ];
    function Harness() {
      return h(ImageViewer, {
        images: IMAGES,
        initialIndex: 0,
        onClose: () => {
          state.closed += 1;
        },
      });
    }

    ui.render(h(Harness));
    // 合成事件不建立真实指针，捕获调用会抛 NotFoundError。
    const popup = () => document.querySelector("[data-image-viewer]");
    const track = () => document.querySelector('[data-slot="horizontal-swipe-track"]');
    const image = (index) => document.querySelector(`[data-image-index="${index}"]`);
    popup().setPointerCapture = () => {};
    popup().releasePointerCapture = () => {};

    const counter = () => {
      const badge = [...popup().querySelectorAll("div")].find((node) =>
        /^\d+ \/ \d+$/.test(node.textContent?.trim() ?? ""),
      );
      return badge?.textContent?.trim() ?? null;
    };
    const transformOf = (index) => {
      const computed = getComputedStyle(image(index)).transform;
      if (!computed || computed === "none") return { scale: 1, x: 0, y: 0 };
      const matrix = new DOMMatrixReadOnly(computed);
      return { scale: matrix.a, x: matrix.e, y: matrix.f };
    };
    const trackOffset = () => new DOMMatrixReadOnly(getComputedStyle(track()).transform).m41;
    const boxOf = (index) => image(index).getBoundingClientRect();
    const centerOf = (index) => {
      const box = boxOf(index);
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    };
    /** 图片布局中心：`transform` 的基准点。 */
    const pageCenterOf = (index) => {
      const page = image(index).parentElement.getBoundingClientRect();
      return { x: page.left + page.width / 2, y: page.top + page.height / 2 };
    };
    /** 未变换时位于 `content` 的内容点，在当前变换下落在哪（与生产同一套映射）。 */
    const screenOf = (index, content) => {
      const center = pageCenterOf(index);
      const transform = transformOf(index);
      return {
        x: center.x + transform.scale * (content.x - center.x) + transform.x,
        y: center.y + transform.scale * (content.y - center.y) + transform.y,
      };
    };

    let pointerId = 100;
    const send = (type, x, y, id) =>
      popup().dispatchEvent(
        new PointerEvent(type, {
          pointerId: id,
          pointerType: "touch",
          isPrimary: true,
          clientX: x,
          clientY: y,
          bubbles: true,
          cancelable: true,
        }),
      );

    const tapAt = async (x, y) => {
      const id = (pointerId += 1);
      send("pointerdown", x, y, id);
      await frames();
      send("pointerup", x, y, id);
      await frames();
    };
    const tap = (index = 0) => {
      const point = centerOf(index);
      return tapAt(point.x, point.y);
    };
    const doubleTapAt = async (x, y, index = 0) => {
      await tapAt(x, y);
      await tapAt(x, y);
      await settleAnimations(image(index));
    };
    /** 拖动；每一步都等两帧，让 hook 能锁轴并采样。 */
    const drag = async (from, to) => {
      const id = (pointerId += 1);
      send("pointerdown", from.x, from.y, id);
      await frames();
      const steps = 6;
      for (let step = 1; step <= steps; step += 1) {
        send(
          "pointermove",
          from.x + ((to.x - from.x) * step) / steps,
          from.y + ((to.y - from.y) * step) / steps,
          id,
        );
        await frames();
      }
      send("pointerup", to.x, to.y, id);
      await frames();
    };
    /** 两指围绕中点按 `factor` 张开/靠拢，两条指针各走各的 id。 */
    const pinch = async (first, second, factor) => {
      const idA = (pointerId += 1);
      const idB = (pointerId += 1);
      const mid = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
      const at = (point, scale) => ({
        x: mid.x + (point.x - mid.x) * scale,
        y: mid.y + (point.y - mid.y) * scale,
      });
      send("pointerdown", first.x, first.y, idA);
      await frames();
      send("pointerdown", second.x, second.y, idB);
      await frames();
      const steps = 6;
      for (let step = 1; step <= steps; step += 1) {
        const scale = 1 + (factor - 1) * (step / steps);
        const nextA = at(first, scale);
        const nextB = at(second, scale);
        send("pointermove", nextA.x, nextA.y, idA);
        send("pointermove", nextB.x, nextB.y, idB);
        await frames();
      }
      const lastA = at(first, factor);
      const lastB = at(second, factor);
      send("pointerup", lastA.x, lastA.y, idA);
      send("pointerup", lastB.x, lastB.y, idB);
      await frames();
    };

    // 等图片解码：几何读不到尺寸时缩放层整段不参与，必须先有真实的布局尺寸。
    await new Promise((resolve) => {
      const check = () => (boxOf(0).width > 0 ? resolve() : requestAnimationFrame(check));
      check();
    });
    await frames();
    assert(popup() !== null, "查看器没有挂载");
    assert(counter() === "1 / 3", `初始计数不对：${counter()}`);

    Object.assign(window, {
      imageZoomFixture: {
        React,
        h,
        Harness,
        IMAGES,
        assert,
        frames,
        settleAnimations,
        ui,
        popup,
        image,
        track,
        counter,
        transformOf,
        trackOffset,
        boxOf,
        centerOf,
        screenOf,
        send,
        tapAt,
        tap,
        doubleTapAt,
        drag,
        pinch,
        results: [],
        state,
        closed: () => state.closed,
      },
    });
    return { center: centerOf(0) };
  });

  // ---- 第二段：真实鼠标双击（原生命中测试，合成事件替代不了）----
  // 必须用 `mouse.dblclick`：Playwright 的分开 down/up 只发 clickCount 1，
  // 浏览器不会合成 dblclick（`detail` 恒为 1），双击一路根本到不了组件。
  await page.mouse.dblclick(bootstrap.center.x, bootstrap.center.y);
  await page.waitForTimeout(600);
  const mouseZoomed = await page.evaluate(() => window.imageZoomFixture.transformOf(0));
  if (!(mouseZoomed.scale > 2)) throw new Error(`鼠标双击没有放大：${mouseZoomed.scale}`);
  await page.mouse.dblclick(bootstrap.center.x, bootstrap.center.y);
  await page.waitForTimeout(600);
  const mouseReset = await page.evaluate(() => window.imageZoomFixture.transformOf(0));
  if (Math.abs(mouseReset.scale - 1) > 0.001) {
    throw new Error(`鼠标双击没有复位：${JSON.stringify(mouseReset)}`);
  }

  // ---- 第二段之二：桌面输入（真实滚轮、触控板捏合、键盘、拖拽）----
  //
  // 滚轮必须走 Playwright 的真实输入：React 的 `onWheel` 在根节点上是 passive 代理，
  // 只有原生非 passive 监听器才能 `preventDefault`；而这正是夹具要守的不变量 ——
  // 合成 WheelEvent 也挡不住页面滚动，因此用 `page.mouse.wheel` 验证「滚轮没滚到页面」。
  const desktop = await page.evaluate(() => {
    window.scrollTo(0, 0);
    const image = document.querySelector('[data-image-index="0"]');
    const box = image.getBoundingClientRect();
    return {
      center: { x: box.left + box.width / 2, y: box.top + box.height / 2 },
      scrollY: window.scrollY,
      viewport: { w: window.innerWidth, h: window.innerHeight },
    };
  });

  // 滚轮放大：指针停在图上向上滚。
  await page.mouse.move(desktop.center.x, desktop.center.y);
  await page.mouse.wheel(0, -240);
  await page.waitForTimeout(500);
  const wheelZoomed = await page.evaluate(() => ({
    ...window.imageZoomFixture.transformOf(0),
    scrollY: window.scrollY,
  }));
  if (!(wheelZoomed.scale > 1)) {
    throw new Error(`滚轮向上没有放大：${JSON.stringify(wheelZoomed)}`);
  }
  if (wheelZoomed.scrollY !== desktop.scrollY) {
    throw new Error(`滚轮穿透到页面：scrollY=${wheelZoomed.scrollY}`);
  }

  // 滚轮缩小回去。
  await page.mouse.wheel(0, 240);
  await page.waitForTimeout(500);
  const wheelReset = await page.evaluate(() => window.imageZoomFixture.transformOf(0));
  if (Math.abs(wheelReset.scale - 1) > 0.02) {
    throw new Error(`滚轮反向没有回到适配尺寸：${JSON.stringify(wheelReset)}`);
  }

  // 触控板捏合：浏览器发的是 ctrl + 小 delta 的 wheel。
  await page.evaluate(() => {
    const popup = document.querySelector("[data-image-viewer]");
    window.__pinchWheel = [];
    popup.addEventListener("wheel", (event) => window.__pinchWheel.push(event.deltaY), true);
  });
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -8);
  await page.mouse.wheel(0, -8);
  await page.mouse.wheel(0, -8);
  await page.keyboard.up("Control");
  await page.waitForTimeout(500);
  const pinchWheel = await page.evaluate(() => ({
    ...window.imageZoomFixture.transformOf(0),
    deltas: window.__pinchWheel,
  }));
  if (!(pinchWheel.scale > 1)) {
    throw new Error(`触控板捏合没有放大：${JSON.stringify(pinchWheel)}`);
  }

  // 键盘复位与键盘放大。
  await page.keyboard.press("0");
  await page.waitForTimeout(450);
  const keyReset = await page.evaluate(() => window.imageZoomFixture.transformOf(0));
  if (Math.abs(keyReset.scale - 1) > 0.001) {
    throw new Error(`键盘 0 没有复位：${JSON.stringify(keyReset)}`);
  }
  await page.keyboard.press("+");
  await page.waitForTimeout(450);
  const keyZoomed = await page.evaluate(() => window.imageZoomFixture.transformOf(0));
  if (!(keyZoomed.scale > 1)) {
    throw new Error(`键盘 + 没有放大：${JSON.stringify(keyZoomed)}`);
  }
  await page.keyboard.press("-");
  await page.waitForTimeout(450);
  const keyBack = await page.evaluate(() => window.imageZoomFixture.transformOf(0));
  if (Math.abs(keyBack.scale - 1) > 0.001) {
    throw new Error(`键盘 - 没有缩回：${JSON.stringify(keyBack)}`);
  }

  // 鼠标拖拽平移：放大到平移边界够宽之后左键按住拖动，图片跟手移动、不翻页。
  // 要放得足够大：1.25 倍时图片宽度只比视口宽 52px，横向可平移范围不足 60px，
  // 断言会撞在收口上而不是「拖了 60px」。
  await page.keyboard.press("+");
  await page.keyboard.press("+");
  await page.keyboard.press("+");
  await page.waitForTimeout(450);
  const beforeDrag = await page.evaluate(() => window.imageZoomFixture.transformOf(0));
  await page.mouse.move(desktop.center.x, desktop.center.y);
  await page.mouse.down();
  for (let step = 1; step <= 6; step += 1) {
    await page.mouse.move(desktop.center.x + (60 * step) / 6, desktop.center.y + (36 * step) / 6);
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
  await page.waitForTimeout(500);
  const afterDrag = await page.evaluate(() => ({
    ...window.imageZoomFixture.transformOf(0),
    counter: window.imageZoomFixture.counter(),
  }));
  if (afterDrag.counter !== "1 / 3") {
    throw new Error(`鼠标拖拽翻了页：${afterDrag.counter}`);
  }
  if (Math.abs(afterDrag.x - beforeDrag.x - 60) > 3 || Math.abs(afterDrag.y - beforeDrag.y - 36) > 3) {
    throw new Error(
      `鼠标拖拽没有一比一平移：${JSON.stringify({ beforeDrag, afterDrag })}`,
    );
  }
  // 复位，交回给触屏那一段继续。
  await page.keyboard.press("0");
  await page.waitForTimeout(450);

  const desktopResults = [
    "桌面：滚轮缩放且不穿透到页面",
    "桌面：触控板捏合（ctrl + wheel）缩放",
    "桌面：键盘 + / - / 0 缩放与复位",
    "桌面：放大后鼠标拖拽一比一平移、不翻页",
  ];

  // ---- 第三段：触屏手势断言 ----
  await page.evaluate((next) => {
    window.__desktopResults = next;
  }, desktopResults);
  const result = await page.evaluate(async () => {
    const {
      h,
      Harness,
      assert,
      frames,
      settleAnimations,
      ui,
      popup,
      image,
      counter,
      transformOf,
      trackOffset,
      boxOf,
      centerOf,
      screenOf,
      send,
      tapAt,
      tap,
      doubleTapAt,
      drag,
      pinch,
      closed,
    } = window.imageZoomFixture;
    void send;
    const results = ["鼠标真实双击放大并可复位", ...window.__desktopResults];

    try {
      const fitted = boxOf(0);
      assert(
        fitted.width <= popup().clientWidth && fitted.height <= popup().clientHeight,
        "打开时图片没有按适配尺寸显示",
      );
      results.push("查看器打开：三张图、计数 1 / 3、图片适配显示");

      // 未放大时点图片不关闭查看器（点击落在图上，不是空白）。
      await tap(0);
      assert(closed() === 0, "点图片把查看器关掉了");
      // 让双击窗口过期，避免与下一步合起来被当成一次双击。
      await new Promise((resolve) => window.setTimeout(resolve, 400));

      // 双击放大：手指底下的内容点必须留在原处，倍率取双击倍率。
      const anchor = {
        x: fitted.left + fitted.width * 0.3,
        y: fitted.top + fitted.height * 0.3,
      };
      await doubleTapAt(anchor.x, anchor.y);
      const zoomed = transformOf(0);
      assert(zoomed.scale > 2 && zoomed.scale <= 4, `双击没有放大：${zoomed.scale}`);
      assert(closed() === 0, "双击把查看器关掉了");
      const landed = screenOf(0, anchor);
      assert(
        Math.abs(landed.x - anchor.x) < 1 && Math.abs(landed.y - anchor.y) < 1,
        `双击没有围绕落点放大：落点跑到了 ${JSON.stringify(landed)}`,
      );
      assert(boxOf(0).width > fitted.width, "放大后图片没有变大");
      results.push(`双击放大到 ${zoomed.scale.toFixed(2)} 倍，落点停在原处`);

      // 放大后横向拖动是平移图片，不是翻页。
      const beforePan = transformOf(0);
      const panFrom = { x: fitted.left + 90, y: fitted.top + 120 };
      await drag(panFrom, { x: panFrom.x + 100, y: panFrom.y + 60 });
      await settleAnimations(image(0));
      const afterPan = transformOf(0);
      assert(counter() === "1 / 3", `放大后横向拖动翻了页：${counter()}`);
      assert(afterPan.scale === beforePan.scale, "平移改变了倍率");
      assert(
        Math.abs(afterPan.x - beforePan.x - 100) < 2 &&
          Math.abs(afterPan.y - beforePan.y - 60) < 2,
        `放大后单指没有一比一平移图片：${JSON.stringify({ beforePan, afterPan })}`,
      );
      results.push("放大后横向拖动一比一平移图片，不翻页");

      // 平移范围收口：往同一方向拖到远超边界的距离，图片边缘不会离开视口。
      await drag({ x: 200, y: 400 }, { x: 4200, y: 4200 });
      await settleAnimations(image(0));
      const clampedBox = boxOf(0);
      assert(
        clampedBox.left <= 1 && clampedBox.right >= popup().clientWidth - 1,
        `横向平移越界露白：left=${clampedBox.left} right=${clampedBox.right}`,
      );
      assert(
        clampedBox.top <= 1 && clampedBox.bottom >= popup().clientHeight - 1,
        `纵向平移越界露白：top=${clampedBox.top} bottom=${clampedBox.bottom}`,
      );
      results.push("平移在图片边缘收口，不露出空背景");

      // 双击复位：回到适配尺寸，翻页手势随之恢复。
      const resetTarget = centerOf(0);
      await doubleTapAt(resetTarget.x, resetTarget.y);
      const reset = transformOf(0);
      assert(
        Math.abs(reset.scale - 1) < 0.001 && Math.abs(reset.x) < 0.5 && Math.abs(reset.y) < 0.5,
        `双击没有复位：${JSON.stringify(reset)}`,
      );
      assert(!image(0).style.transform, "复位后仍留着内联变换");
      assert(boxOf(0).width === fitted.width, "复位后图片尺寸没有回到适配尺寸");
      results.push("双击复位到适配尺寸并清掉内联变换");

      // 双指捏合放大：第二根手指落下就必须停用翻页，条带停在当前图。
      const pinchCenter = centerOf(0);
      await pinch(
        { x: pinchCenter.x, y: pinchCenter.y - 80 },
        { x: pinchCenter.x, y: pinchCenter.y + 80 },
        2.5,
      );
      await settleAnimations(image(0));
      const pinched = transformOf(0);
      assert(pinched.scale > 1.8, `双指捏合没有放大：${pinched.scale}`);
      assert(counter() === "1 / 3", `捏合过程中翻了页：${counter()}`);
      assert(Math.abs(trackOffset()) < 1, `捏合后条带没有停回当前图：${trackOffset()}`);
      results.push(`双指捏合放大到 ${pinched.scale.toFixed(2)} 倍，条带保持停靠`);

      // 捏回几乎适配尺寸就松手：残留倍率归位，翻页手势必须恢复。
      const nearlyBox = boxOf(0);
      await pinch(
        { x: nearlyBox.left + nearlyBox.width / 2, y: nearlyBox.top + nearlyBox.height * 0.3 },
        { x: nearlyBox.left + nearlyBox.width / 2, y: nearlyBox.top + nearlyBox.height * 0.7 },
        1 / pinched.scale,
      );
      await settleAnimations(image(0));
      const nearly = transformOf(0);
      assert(
        Math.abs(nearly.scale - 1) < 0.02 && Math.abs(nearly.x) < 0.5 && Math.abs(nearly.y) < 0.5,
        `缩回适配尺寸后没有归位：${JSON.stringify(nearly)}`,
      );
      results.push("缩回适配尺寸后归位，不留看不见的缩放");

      // 手势恢复的可见证据：未放大时横滑又能翻页，且按图复位。
      const switchBox = boxOf(0);
      await drag(
        { x: switchBox.right - 20, y: switchBox.top + switchBox.height / 2 },
        { x: switchBox.left + 20, y: switchBox.top + switchBox.height / 2 },
      );
      await new Promise((resolve) => window.setTimeout(resolve, 600));
      assert(counter() === "2 / 3", `未放大时横滑没有翻页：${counter()}`);
      assert(!image(0).style.transform, "换图后上一张仍留着变换");
      results.push("未放大时横滑恢复翻页，并清掉上一张的变换");

      // 放大第二张，确认按图独立（上一张的复位不会带到它）。
      const secondBox = boxOf(1);
      const secondCenter = {
        x: secondBox.left + secondBox.width / 2,
        y: secondBox.top + secondBox.height / 2,
      };
      await doubleTapAt(secondCenter.x, secondCenter.y, 1);
      assert(transformOf(1).scale > 2, "第二张没有放大，按图复位不成立");
      assert(!image(0).style.transform, "上一张的变换串到了第二张");

      // 放大后点图片与点图外空白都不关闭：退出只走双击复位或关闭按钮。
      const closedBeforeImageTap = closed();
      await tapAt(secondCenter.x, secondCenter.y);
      await new Promise((resolve) => window.setTimeout(resolve, 450));
      assert(closed() === closedBeforeImageTap, "点已放大的图片把查看器关掉了");
      const zoomedBlank = boxOf(1);
      popup().dispatchEvent(
        new MouseEvent("click", {
          clientX: Math.max(4, zoomedBlank.left - 30),
          clientY: Math.max(4, zoomedBlank.top - 30),
          bubbles: true,
          cancelable: true,
        }),
      );
      await new Promise((resolve) => window.setTimeout(resolve, 450));
      assert(closed() === closedBeforeImageTap, "放大态下点图外空白把查看器关掉了");

      // 关闭按钮始终在最上层：放大后仍能关闭。
      const closedBeforeButton = closed();
      popup().querySelector('button[aria-label="关闭图片查看器"]').click();
      await new Promise((resolve) => window.setTimeout(resolve, 450));
      assert(closed() > closedBeforeButton, "点关闭按钮没有关闭查看器");
      results.push("放大后点图片与空白都不关闭、关闭按钮仍可用");

      // 未放大时点图外空白关闭（换一个实例，避免复用已关闭的弹层状态）。
      ui.render(h(Harness, { key: "blank-close" }));
      popup().setPointerCapture = () => {};
      popup().releasePointerCapture = () => {};
      await new Promise((resolve) => {
        const check = () =>
          boxOf(0).width > 0 && !image(0).style.transform ? resolve() : requestAnimationFrame(check);
        check();
      });
      await frames();
      const closedBeforeBlank = closed();
      const blank = boxOf(0);
      popup().dispatchEvent(
        new MouseEvent("click", {
          clientX: blank.left + blank.width / 2,
          clientY: Math.max(4, blank.top - 40),
          bubbles: true,
          cancelable: true,
        }),
      );
      await new Promise((resolve) => window.setTimeout(resolve, 450));
      assert(closed() > closedBeforeBlank, "点图外空白没有关闭查看器");
      results.push("点图外空白关闭查看器");

      return { results };
    } finally {
      delete window.imageZoomFixture;
      ui.dispose();
    }
  });

  if (errors.length > 0) throw new Error(`页面报错：${errors.join(" | ")}`);
  return result;
}
