// 真实 VideoPlayerPage + Video.js + 浏览器 TextTrack；仅 IPC 与媒体适配器使用夹具。
// 在独立浏览器打开 Vite origin 后执行：
// playwright-cli -s=vod-chapters run-code --filename=tests/video-chapters.browser.js
async (page) => {
  const originalUrl = page.url();
  const origin = await page.evaluate(() => location.origin);
  const enginePattern = /\/@videojs_dash-video\.js/;
  const engine = `
    export class DashAdapter extends EventTarget {
      handlers = new Map(); destroyed = false;
      engine = {
        on: (name, fn) => { const list = this.handlers.get(name) || new Set(); list.add(fn); this.handlers.set(name, list); },
        off: (name, fn) => this.handlers.get(name)?.delete(fn),
      };
      attach(media) {
        this.media = media;
        let time = 0, paused = true, ready = 0;
        Object.defineProperties(media, {
          currentTime: { configurable: true, get: () => time, set: value => {
            time = value; media.dispatchEvent(new Event('seeking')); media.dispatchEvent(new Event('timeupdate')); media.dispatchEvent(new Event('seeked'));
          } },
          duration: { configurable: true, get: () => 600 },
          paused: { configurable: true, get: () => paused },
          ended: { configurable: true, get: () => false },
          readyState: { configurable: true, get: () => ready },
          buffered: { configurable: true, get: () => ({ length: 1, start: () => 0, end: () => 450 }) },
        });
        media.play = async () => {
          paused = false; media.dispatchEvent(new Event('play'));
          await Promise.resolve();
          if (!this.destroyed && ready >= 2) media.dispatchEvent(new Event('playing'));
        };
        media.pause = () => { if (!paused) { paused = true; media.dispatchEvent(new Event('pause')); } };
        media.load = () => {};
        this.ready = () => { ready = 4; };
        (window.vodChapterEngines ||= []).push(this);
      }
      set source(value) {
        if (!value) return;
        queueMicrotask(() => {
          if (this.destroyed) return;
          this.ready();
          this.media.dispatchEvent(new Event('loadedmetadata'));
          this.media.dispatchEvent(new Event('durationchange'));
          this.media.dispatchEvent(new Event('loadeddata'));
          this.media.dispatchEvent(new Event('canplay'));
          this.media.dispatchEvent(new Event('progress'));
        });
      }
      destroy() { this.destroyed = true; this.handlers.clear(); }
    }
  `;
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const errors = [];
  const onError = (error) => errors.push(error.message);
  page.on("pageerror", onError);
  await page.route(enginePattern, (route) => route.fulfill({ body: engine, contentType: "application/javascript" }));
  const slider = page.locator(".media-time-slider");
  const segments = slider.locator('[class~="group/chapter"]');
  const chapterTrack = page.locator('video track[kind="chapters"]');
  try {
    await page.goto(`${origin}/tests/browser/video-session-lifecycle.html`);
    await page.waitForFunction(() => window.vodSessionFixture?.metadataCalls.length > 0);
    await segments.first().waitFor();
    assert(await segments.count() === 1, "无章节时应为连续进度条");
    assert(await chapterTrack.count() === 0, "无章节不应创建空轨道");
    // 记录 blob 的回收，且不替换浏览器真正的轨道加载/解析逻辑。
    await page.evaluate(async () => {
      window.chapterRevokedUrls = [];
      const revoke = URL.revokeObjectURL.bind(URL);
      URL.revokeObjectURL = (url) => { window.chapterRevokedUrls.push(url); revoke(url); };
      const f = window.vodSessionFixture;
      f.metadata[1] = {
        subtitles: [{ lan: "zh-CN", lan_doc: "测试 CC", url: "https://example.invalid/cc.json" }],
        chapters: [
          { start_time: 0, end_time: 120, title: "开场" },
          { start_time: 180, end_time: 300, title: "演示" },
          { start_time: 300, end_time: 900, title: "总结" },
        ],
      };
      await f.client.invalidateQueries({ queryKey: ["video_player_meta"] });
    });
    await page.waitForFunction(() => document.querySelector('video track[kind="chapters"]')?.track.cues?.length === 3);
    await page.waitForFunction(() => document.querySelectorAll('.media-time-slider [class~="group/chapter"]').length === 4);
    assert(await chapterTrack.evaluate((el) => el.track.mode) === "hidden", "章节轨必须加载且不覆盖字幕");
    const originalTrackUrl = await chapterTrack.getAttribute("src");
    await page.getByRole("button", { name: "开启字幕", exact: true }).click();
    await page.getByRole("button", { name: "测试 CC", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('video track[kind="subtitles"]')?.track.mode === "showing");
    assert(await chapterTrack.evaluate((el) => el.track.mode) === "hidden", "开启 CC 不得禁用章节轨");
    const geometry = await segments.evaluateAll((els) => els.map((el) => ({
      start: parseFloat(el.style.getPropertyValue("--media-slider-chapter-start")),
      end: parseFloat(el.style.getPropertyValue("--media-slider-chapter-end")),
      clip: getComputedStyle(el.firstElementChild).clipPath,
    })));
    const expectedRanges = [[0, 20], [20, 30], [30, 50], [50, 100]];
    assert(geometry.every(({start, end}, i) => Math.abs(start - expectedRanges[i][0]) < 0.001 && Math.abs(end - expectedRanges[i][1]) < 0.001), `分段比例或时长裁剪错误：${JSON.stringify(geometry)}`);
    assert(geometry.every(({clip}) => clip !== "none"), "章节轨道没有真正裁剪，可能全条重叠");
    const box = await slider.boundingBox();
    assert(box, "找不到进度条");
    const xAt = (ratio) => box.x + box.width * ratio;
    const y = box.y + box.height / 2;
    // 边界中心命中不到任何可见轨道，证明不是只画了分隔标记。
    assert(await page.evaluate(({ x, y }) => !document.elementsFromPoint(x, y).some((el) =>
      el.parentElement?.classList.contains("group/chapter")
    ), { x: xAt(0.5), y }), "章节边界缺少可见间隙");
    await page.mouse.move(xAt(0.4), y);
    await slider.getByText("演示", { exact: true }).waitFor({ state: "visible" });
    await page.mouse.click(xAt(0.55), y);
    await page.waitForFunction(() => Math.abs(document.querySelector('video').currentTime - 330) < 3);
    await page.mouse.move(xAt(0.25), y);
    assert(await slider.getByText("演示", { exact: true }).count() === 0, "未覆盖区间不应沿用上一章标题");
    await page.mouse.move(1, 1);
    await slider.focus();
    await slider.press("Home");
    await page.waitForFunction(() => document.querySelector('video').currentTime === 0);
    await slider.getByText("开场", { exact: true }).waitFor({ state: "visible" });
    assert(await slider.getByText("开场", { exact: true }).getAttribute("aria-live") === "polite", "键盘章节变化应可被读屏通知");

    // 刷新与仅音频开关触发取流换代；章节继续可用，且不会重复请求相同元数据。
    const metadataCalls = await page.evaluate(() => window.vodSessionFixture.metadataCalls.length);
    await page.getByRole("button", { name: "刷新播放", exact: true }).click();
    await page.waitForFunction((old) => {
      const el = document.querySelector('video track[kind="chapters"]');
      return el && el.src !== old && el.track.cues?.length === 3;
    }, originalTrackUrl);
    assert(await page.evaluate((url) => window.chapterRevokedUrls.includes(url), originalTrackUrl), "刷新未释放旧章节 blob");
    const refreshedUrl = await chapterTrack.getAttribute("src");
    await page.getByRole("button", { name: "仅播声音", exact: true }).click();
    await page.waitForFunction((old) => {
      const el = document.querySelector('video track[kind="chapters"]');
      return el && el.src !== old && el.track.cues?.length === 3;
    }, refreshedUrl);
    assert(await page.evaluate(() => window.vodSessionFixture.metadataCalls.length) === metadataCalls, "换画质/播放模式不应重复请求字幕章节元数据");
    assert(await chapterTrack.count() === 1, "换源后章节轨重复");

    // 元数据迟到前先切至无章节的 P，旧响应不得污染当前分 P。
    await page.evaluate(() => {
      const f = window.vodSessionFixture;
      f.metadata[2] = new Promise((resolve) => { window.resolveLateChapterMeta = resolve; });
      void f.router.navigate("/video/play?bvid=BVsession&cid=2&aid=1");
    });
    await page.waitForFunction(() => window.vodSessionFixture.metadataCalls.includes(2));
    assert(await chapterTrack.count() === 0, "切 P 后旧章节没有立刻移除");
    await page.evaluate(() => window.vodSessionFixture.router.navigate("/video/play?bvid=BVsession&cid=3&aid=1"));
    await page.waitForFunction(() => window.vodSessionFixture.metadataCalls.includes(3));
    await page.evaluate(() => window.resolveLateChapterMeta({ subtitles: [], chapters: [{ start_time: 0, end_time: 600, title: "迟到章节" }] }));
    await page.waitForTimeout(150);
    assert(await chapterTrack.count() === 0 && await segments.count() === 1, "迟到响应污染无章节分 P");
    await page.evaluate(() => {
      const f = window.vodSessionFixture;
      f.metadata[4] = new Error("测试元数据失败");
      return f.router.navigate("/video/play?bvid=BVsession&cid=4&aid=1");
    });
    await page.waitForFunction(() => window.vodSessionFixture.client.getQueryState(["video_player_meta", 4, "BVsession", ""])?.status === "error");
    assert(await chapterTrack.count() === 0 && await segments.count() === 1, "元数据失败应保持普通进度条");

    await page.evaluate(() => window.vodSessionFixture.router.navigate("/video/play?bvid=BVsession&cid=1&aid=1"));
    await page.waitForFunction(() => document.querySelector('video track[kind="chapters"]')?.track.cues?.length === 3);
    const lastUrl = await chapterTrack.getAttribute("src");
    await page.evaluate(() => window.vodSessionFixture.router.navigate("/away"));
    await page.getByText("已离开", { exact: true }).waitFor();
    assert(await page.evaluate((url) => window.chapterRevokedUrls.includes(url), lastUrl), "卸载未释放章节 blob");
    assert(errors.length === 0, `页面异常：${errors.join("; ")}`);
    return { passed: ["无章节连续轨道", "分段比例/时长裁剪/可见间隙", "悬停标题与点击/键盘 seek", "CC 字幕与章节共存", "刷新和仅音频换源重挂", "切 P 清理与迟到响应隔离", "元数据失败降级", "卸载回收 blob", "StrictMode 无异常"] };
  } finally {
    page.off("pageerror", onError);
    await page.goto(originalUrl);
    await page.unroute(enginePattern);
  }
}
