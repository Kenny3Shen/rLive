// 弹幕 P1 时间轴微基准（单版本，走 dev server 源码）。
//
// `remove(id)` 与 `setComments`/`appendComments` 的收益是时间轴操作的延迟尖峰
// （文档实测：6 万条下移除 20 条 63.3ms、12 万条下 setComments 75.2ms），
// 不是稳态 FPS，所以不能用 danmaku-bench 的帧率场景代替。本夹具只驱动真实
// `DanmakuRenderer`，用伪媒体元素提供媒体语义，不播放视频、不依赖主应用路由。
//
// 与文档数字做对照请用单构建 A/B（`tests/danmaku-timeline-ab.browser.js`），
// 本脚本用于 Windows / Android 主窗口上验证同一实现的实际延迟。
//
// 用法：
//   playwright-cli -s=rwin run-code --filename=tests/danmaku-timeline-performance.browser.js
//   playwright-cli -s=android run-code --filename=tests/danmaku-timeline-performance.browser.js
//
// 可选参数：在页面内先设 `window.__danmakuTimelineBenchConfig`，例如
//   { scale: 120000, removes: 20, segments: 8, segmentSize: 6000, repeat: 3 }
async (page) => {
  return page.evaluate(async () => {
    // 带时间戳导入，确保读到最新源码而不必刷新用户正在使用的页面。这里只导入一个
    // 模块，不存在 `?t=` 把同一模块分裂成两份的问题（那会让 eventBus 的围栏判定失效）。
    const [{ DanmakuRenderer }, { runTimelineBench }] = await Promise.all([
      import(`/src/features/room/danmaku/danmakuRenderer.ts?t=${Date.now()}`),
      import(`/tests/browser/danmaku-timeline-bench.ts?t=${Date.now()}`),
    ]);
    return runTimelineBench(DanmakuRenderer, window.__danmakuTimelineBenchConfig ?? {});
  });
}
