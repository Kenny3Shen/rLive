# 弹幕 P1 时间轴微基准夹具

P1 的两项收益是**时间轴操作的延迟尖峰**，不是稳态 FPS：

- `DanmakuRenderer.remove(id)`：文档基线为 6 万条下移除 20 条 63.3 ms（原始实现在每个分组做两次全量 `filter`）。
- `setComments` 全量重建：文档基线为 12 万条 75.2 ms，而 VOD 分段加载的语义是追加。

所以本夹具只驱动真实 `DanmakuRenderer`，用伪媒体元素提供媒体语义，不播放视频、不依赖主应用路由。
稳态帧率仍用 P0 夹具（见 [danmaku-bench.md](danmaku-bench.md)）。

## 两个入口

| 入口 | 用途 |
| --- | --- |
| `tests/danmaku-timeline-performance.browser.js` | 单版本，走 dev server 源码，用于 Windows/Android 主窗口实测 |
| `tests/danmaku-timeline-ab.browser.js` | 单构建 A/B，基线与当前实现在同一页面内前后对照 |

两者共用 `tests/browser/danmaku-timeline-bench.ts` 的采样主体，避免两条路径的口径分叉。
A/B 的基线通过 `tests/browser/danmaku-timeline-ab-build.ts` 从 `git show <baseline>:src/...` 取出，
以别名编进同一 bundle（默认基线 `f2c05886`，即 P1 落地前的最后一次提交）。

## 构建与运行

```bash
# 单版本（dev server 源码）
playwright-cli -s=rwin --raw run-code --filename=tests/danmaku-timeline-performance.browser.js

# 单构建 A/B
bun tests/browser/danmaku-timeline-ab-build.ts
bun tests/browser/danmaku-timeline-ab-build.ts --preview --port=1437
playwright-cli -s=p1 open 'http://127.0.0.1:1437/'
playwright-cli -s=p1 --raw run-code --filename=tests/danmaku-timeline-ab.browser.js
```

产物只在 `.playwright-cli/danmaku-timeline-ab-dist/`（ignored）。**源码变化后必须重新 build**，
preview 不会自动 build；`danmaku-timeline-ab-build.json` 记录基线 commit 与两侧源码 SHA256，
跑之前先核对 `currentSourceSHA256` 与 `sha256sum src/features/room/danmaku/danmakuRenderer.ts` 一致。

URL 参数：`?scale=120000&removes=20&segments=8&segmentSize=6000&repeat=3&order=baseline,current`。
`order` 可反转以复核顺序与热机影响。

### Android

Android 的 `http://tauri.localhost` 由原生侧转发，**CDP 的 `page.route` 拦不到这条链路**，
但 dev server 的静态路径可以直接访问，所以把 preview 端口经 ADB 暴露给设备后，
用同一个 A/B runner 即可（页面来源换成同源路径）：

```bash
adb -s emulator-5554 reverse --list                       # 先记录原映射
adb -s emulator-5554 reverse tcp:1420 tcp:1437            # 指向 A/B preview
playwright-cli -s=android goto 'http://tauri.localhost/'
playwright-cli -s=android --raw run-code --filename=tests/danmaku-timeline-ab.browser.js
adb -s emulator-5554 reverse tcp:1420 tcp:1421            # 恢复原映射
```

模拟器 4 核 / 2GB 上跑 12 万条会显著挤压 WebView 内存；若只关心 remove/append 的相对收益，
可在页面内把 `scale` 降到 6 万。

## 采样口径与已知噪声

- `setComments` 按规模点（10k/30k/60k/120k）**各用新渲染器并取 best-of-2**。复用同一实例会把
  上一点的巨型数组留给下一次调用，在低内存设备上表现为纯 GC 噪声（实测 Android 模拟器上同一
  规模点会在 44～200 ms 间跳动，甚至出现 30k 慢于 60k）。
- 分段加载（8×6000）与压实同样取 best-of-2。压实测量是连续移除 4 000 条并记录**单次最慢一步**：
  墓碑方案把 O(时间轴) 的代价从每次 `remove` 移到阈值触发的 `compact()`，这一步就是那次尖峰。
- `removeAt60k` 是 6 万条上移除 20 条、3 轮取中位数，与文档口径一致。
- `cursorIntegrity` 断言追加后过去的不补投、未来的仍按时间入场；它是正确性护栏，不参与性能对照。
- 不同夹具/环境（含桌面 Chromium、WebView2、Android 模拟器）的数字**不能相减**；
  基线没有 `appendComments`，A/B 中它的等价操作是重新 `setComments` 全量 N 条。

## 计时下限

`performance.now()` 的精度在部分环境不足以分辨亚毫秒。`remove` 命中 O(1) 路径后会得到 0 或 0.1 ms，
summary 用 0.05 ms 做下限并给出 `speedupIsLowerBound` 标记，避免把「测不出来」写成「无限快」。
