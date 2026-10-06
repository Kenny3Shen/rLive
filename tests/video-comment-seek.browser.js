// Windows 主窗口：playwright-cli -s=vod-comments run-code --filename=tests/video-comment-seek.browser.js
// 真实 VOD 页面接线 + 可控 DASH 桩；不联网、不写入用户历史，最后恢复原页面。
async (page) => {
  const originalUrl = page.url();
  const origin = await page.evaluate(() => location.origin);
  const enginePattern = /\/@videojs_dash-video\.js/;
  const apiPattern = "**/src/shared/api/tauri.ts*";
  const emotePattern = "**/*comment-emote*";
  await page.route(emotePattern, (route) => route.fulfill({
    contentType: "image/svg+xml",
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><circle cx="10" cy="10" r="8" fill="orange"/></svg>',
  }));
  // Windows 主窗口的 IPC 属性为只读；沿现有夹具方式只拦截命令薄包装。
  const apiSource = await page.evaluate(async () => (await fetch("/src/shared/api/tauri.ts")).text());
  const signature = "async function invokeCmd(cmd, args) {";
  if (!apiSource.includes(signature)) throw new Error("IPC 测试注入点已改变");
  await page.route(apiPattern, (route) => route.fulfill({
    contentType: "application/javascript",
    body: apiSource.replace(signature, `${signature}\nif (window.commentSeekInvoke) return window.commentSeekInvoke(cmd, args);`),
  }));
  const engine = `
    export class DashAdapter extends EventTarget {
      engine = { on() {}, off() {} };
      attach(media) {
        this.media = media;
        let time = 0, paused = true;
        this.seeks = [];
        Object.defineProperties(media, {
          currentTime: { configurable: true, get: () => time, set: value => {
            time = value; this.seeks.push(value);
            media.dispatchEvent(new Event('seeking'));
            media.dispatchEvent(new Event('timeupdate'));
            media.dispatchEvent(new Event('seeked'));
          } },
          duration: { configurable: true, get: () => 10 },
          paused: { configurable: true, get: () => paused },
          ended: { configurable: true, get: () => false },
          readyState: { configurable: true, get: () => 4 },
        });
        media.play = async () => {
          paused = false; media.dispatchEvent(new Event('play'));
          media.dispatchEvent(new Event('playing'));
        };
        media.pause = () => { paused = true; media.dispatchEvent(new Event('pause')); };
        media.load = () => {};
        window.commentSeekEngine = this;
      }
      set source(value) {
        if (!value) return;
        queueMicrotask(() => {
          this.media.dispatchEvent(new Event('loadedmetadata'));
          this.media.dispatchEvent(new Event('canplay'));
        });
      }
      destroy() {}
    }
  `;
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const passed = [];
  const errors = [];
  const onError = (error) => errors.push(error.message);
  page.on("pageerror", onError);
  await page.route(enginePattern, (route) =>
    route.fulfill({ body: engine, contentType: "application/javascript" }),
  );
  try {
    await page.goto(`${origin}/tests/browser/video-comment-seek.html`);
    await page.waitForFunction(
      () => window.commentSeekEngine && !window.commentSeekEngine.media.paused,
    );
    await page.getByRole("tab", { name: "评论", exact: true }).click();
    const jump = (time) => page.getByRole("button", { name: `跳转到 ${time}`, exact: true });
    const readTime = () => page.evaluate(() => window.commentSeekEngine.media.currentTime);
    const replyGroup = page.getByRole("group", { name: "楼主 的评论的回复" });
    await jump("00:03").click();
    assert((await readTime()) === 3, "主评论应通过 VOD seekTo 跳到 3 秒");
    assert((await replyGroup.count()) === 0, "空降不应打开评论详情");
    assert(
      await page.evaluate(() => !window.commentSeekEngine.media.paused),
      "跳转不能暂停正在播放的视频",
    );
    await jump("00:04").click();
    assert((await readTime()) === 4, "楼中楼预览应跳到 4 秒");
    assert((await replyGroup.count()) === 0, "点击预览时间戳不能打开详情");
    passed.push("主评论、回复预览均接通 VOD 跳转，且不打开详情/暂停播放");

    await jump("00:00").click();
    assert((await readTime()) === 0, "零秒可跳回开头");
    await jump("1:02:03").click();
    assert((await readTime()) === 9.75, "超过时长应复用 seekTo 的片尾 0.25 秒保护");
    assert((await jump("1:99").count()) === 0, "非法时间不应生成按钮");
    assert((await jump("01:23").count()) === 0, "URL 内时间不可拆成空降按钮");
    const external = page.getByRole("link", { name: "https://example.com/01:23", exact: true });
    assert((await external.getAttribute("href")) === "https://example.com/01:23", "外链应原样保留");
    assert((await page.locator('img[src*="comment-emote"]').count()) === 1, "表情仍应显示为内联图片");
    assert(
      (await page.locator("button button, button a").count()) === 0,
      "富文本控件不能嵌套在详情按钮中",
    );
    passed.push("零秒、超长时间、非法格式、外链与无嵌套交互控件边界通过");

    // 点正文的普通文字（不是覆盖按钮的定位器）仍会展开详情。
    const bodyBox = await page
      .getByRole("button", { name: "查看 楼主 的评论详情", exact: true })
      .boundingBox();
    assert(bodyBox, "主评论正文必须可见");
    await page.mouse.click(bodyBox.x + 10, bodyBox.y + 5);
    await replyGroup.waitFor();
    await page.evaluate(() => window.commentSeekEngine.media.pause());
    await jump("00:05").focus();
    await page.keyboard.press("Enter");
    assert((await readTime()) === 5, "完整回复支持键盘 Enter 空降");
    assert((await replyGroup.count()) === 1, "空降不应收起展开的回复");
    assert(
      await page.evaluate(() => window.commentSeekEngine.media.paused),
      "暂停中空降应保持暂停",
    );
    await page.evaluate(() => {
      window.commentSeekEngine.media.currentTime = 1;
    });
    await page.keyboard.press("Space");
    assert((await readTime()) === 5, "完整回复支持键盘 Space 空降");
    await page.getByRole("button", { name: "查看 楼主 的评论详情", exact: true }).click();
    assert((await replyGroup.count()) === 0, "普通正文入口仍可收起回复");
    await page.getByRole("button", { name: "查看 回复作者 的回复详情", exact: true }).click({ position: { x: 5, y: 5 } });
    await replyGroup.waitFor();
    passed.push("正文/预览仍可展开收起；完整回复支持 Enter/Space，保留暂停状态");

    await page.evaluate(() => window.commentSeekFixture.renderWithoutSeek());
    await page.getByRole("button", { name: "评论排序：最热，点击切换" }).waitFor();
    // 排序按钮在旧播放页也存在，不能据此认定 React 已提交独立的无 seek 面板。
    await page.waitForFunction(() => !document.querySelector("video"));
    assert(
      (await page.getByRole("button", { name: /^跳转到 / }).count()) === 0,
      "无 seek 接口不能显示空降控件",
    );
    passed.push("未提供 onSeek 的复用场景保持原样");

    await page.evaluate(() => {
      window.mobileCommentSeeks = [];
      window.addEventListener("fixture-seek", (event) =>
        window.mobileCommentSeeks.push(event.detail),
      );
      window.commentSeekFixture.renderMobileComments();
    });
    await page.getByRole("button", { name: "查看 楼主 的评论详情", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "评论详情", exact: true });
    await dialog.waitFor();
    await dialog.getByRole("button", { name: "跳转到 00:05", exact: true }).click();
    assert(
      (await page.evaluate(() => window.mobileCommentSeeks)).join() === "5",
      "移动端详情应传出秒级位置",
    );
    assert(await dialog.isVisible(), "空降不能关闭移动端详情");
    passed.push("移动端形态的详情回复继承空降回调且不会误关闭");
    assert(errors.length === 0, `浏览器出现运行时错误：${errors.join("；")}`);
    return { passed };
  } catch (error) {
    const state = await page.evaluate(() => ({
      text: document.body.innerText.slice(0, 1600),
      engine: Boolean(window.commentSeekEngine),
      fixture: Boolean(window.commentSeekFixture),
      paused: window.commentSeekEngine?.media.paused,
    }));
    throw new Error(`${error.message}\n${JSON.stringify(state)}\n${errors.join("\n")}`);
  } finally {
    page.off("pageerror", onError);
    await page.unroute(enginePattern);
    await page.unroute(apiPattern);
    await page.unroute(emotePattern);
    await page.goto(originalUrl);
  }
}
