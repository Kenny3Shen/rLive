# 弹幕 P0 生产 A/B 夹具

独立 HTML 自建 `#root`、生产 React 和 `QueryClientProvider`；没有播放器/视频，不依赖主应用页面。页面及 API 的 `production` 必须为 `true`。

## 构建与运行

```bash
bun tests/browser/danmaku-bench-build.ts
bun tests/browser/danmaku-bench-build.ts --preview --port=1433 --host=127.0.0.1
playwright-cli -s=p0 open 'http://127.0.0.1:1433/tests/browser/danmaku-bench.html?scene=panel-pinned&cpu=1'
playwright-cli -s=p0 --raw run-code --filename=tests/danmaku-p0-performance.browser.js > .playwright-cli/danmaku-bench-result.json
```

输出仅在 `.playwright-cli/`：`danmaku-bench-baseline/`、`danmaku-bench-dist/`、构建元数据及手动保存的结果。每次源代码变化后重新 build；preview 不会自动 build。也可 `bunx vite preview --outDir .playwright-cli/danmaku-bench-dist --port 1433 --strictPort`。

构建从 `git show 30e723d5:…`（或 `--baseline=<commit>` 指定的提交）生成基线 `DanmakuPanel`、`LiveDanmaku`、`danmakuAdapter`、`listWindow`，仅这四个文件彼此指向基线。其余依赖（React/store/eventBus/loader/renderer/filter/UI 等）均共享当前代码，不 checkout、不改 `src`。基线 ignored 目录通过 CSS `@source` 显式纳入 Tailwind。构建 JSON 记录完整基线 commit、当前 HEAD、四个当前文件 SHA256 与构建时间。

### Windows WebView2 原生主窗口

先 CDP attach **主窗口**，保留原生 Tauri IPC。主窗口 Playwright `page.route` 可将同源 `/tests/browser/danmaku-bench.html` 和 `/assets/**` 映射到 `.playwright-cli/danmaku-bench-dist` 内对应文件，再 `page.goto` 同源夹具 URL。路由需覆盖动态 renderer chunk 与字体资源；完成后解除本轮路由并回到原页面。

### Android 原生主窗口

当前 Android dev WebView 的 `http://tauri.localhost` 资源由原生侧转发到 `http://localhost:1420`，
**CDP 的 `page.route` 不会拦截这条原生代理链路**。保留同源页面，通过 ADB 把 dev 端口临时转到生产 preview：

```bash
# 先记录原映射，结束时恢复（本轮原值为 tcp:1420 -> tcp:1421）
adb -s emulator-5554 reverse --list
adb -s emulator-5554 reverse tcp:1420 tcp:1433
playwright-cli -s=android goto 'http://tauri.localhost/tests/browser/danmaku-bench.html?scene=mobile25,mobile200&cpu=1'
playwright-cli -s=android --raw run-code --filename=tests/danmaku-p0-performance.browser.js > .playwright-cli/danmaku-android-result.json
# 清理夹具、恢复原映射，再导航回应用；不要关闭主窗口标签
adb -s emulator-5554 reverse tcp:1420 tcp:1421
```

需先启动上面的 preview；已有 APK 必须是可 CDP 调试且会转发 dev 资源的版本，不需要为本夹具重打 APK。

检测到原生 `__TAURI_INTERNALS__.invoke` 时，夹具只走真正的事件插件，不修改该对象；没有原生对象的普通 Chromium 才使用 `mockIPC(handler, { shouldMockEvents: true })`。事件权限失败会在就绪探针阶段报错，不会静默测空页面。主窗口夹具不要和真实直播同时工作；完成后 `dispose()` 并导航回原应用。

## 场景（URL 参数）

| `scene` | 组件 / CSS 几何 | rate | 默认 CPU | 最短预热 |
| --- | --- | --- | --- | --- |
| `panel-pinned`（默认） | 面板 340×480，钉底 | 150/s | 1x | 3s |
| `panel-up` | 面板 340×480，上滚 | 150/s | 1x | 3s |
| `high-density` | 仅层 1920×1080 | 200/s | 4x | 22s |
| `mobile25` | 层 412×240 + 面板 340×480 | 25/s | 1x | 6s |
| `mobile200` | 层 412×240 + 面板 340×480 | 200/s | 1x | 6s |
| `idle` | 无被测组件，无事件 | 0 | 1x | 3s |

手机场景是**按手机尺寸构造的测试布局**：层从左上角开始，面板位于 `top:240px; right:0`，总高度 720px；面板不覆盖层，避免遮挡导致合成工作不同。`both` 模式一律将面板放到 `top:height`。1920×1080 高密度层可能大于主窗口可见区域，结果同时记录舞台尺寸和实际 viewport，不把 CSS 尺寸冒充物理屏幕尺寸。runner 不改变设备 viewport/UA/核数/内存。

- `scene=panel-pinned,panel-up`：显式选择少数场景。
- `variants=baseline,current`（默认）；可反向 `current,baseline` 复核顺序/热机影响。
- `cpu=1`、`cpu=4` 或 `cpu=1,4`。Android 默认 1x 使用真实设备能力。
- `sample=9000`（默认，runner 最低 8000ms）；`warmup` 可增加但不能低于表中下限。
- `rate`、`width`、`height`、`panelWidth`、`panelHeight` 可覆写，实际参数完整进入结果。
- `willChange=node`（默认）/`none`/`group`：合成层策略对照，只对 `layer`/`both` 场景有意义。

### `willChange` 策略对照

节点内联带 `will-change:transform`，普通声明无法覆盖，夹具改用 `!important` 样式表，不改生产代码。
必须用 `:has()`（`div:has(> [data-rlive-danmaku-id])`）而不是逐个改元素：采样期间持续新建节点，
一次性改 DOM 只能覆盖当时已存在的那些。

| 取值 | 效果 |
| --- | --- |
| `node` | 现状：动画包装节点提升为合成层 |
| `none` | 包装节点与组都不提升 |
| `group` | 把提升移到 `[data-danmaku-group]` 组容器 |

`prepare` 阶段会核对 `getComputedStyle` 的实际值（`metrics().effectiveWillChange`），覆盖没命中就报错，
避免所有策略退化成同一个 `node` 却得到「看起来合理但完全无效」的结论。该字段同时记录原生引擎
自己写的 `translateZ(0)`（`nativeStageTransform`），避免把「去掉 will-change」误读成「完全没有合成层」。

合成层证据用 CDP `LayerTree.enable` + `LayerTree.layerTreeDidChange` + `compositingReasons` 读取；
注意 **headless 会话没有 GPU**，`getAnimations()` 返回 0、层数不代表真实合成，层结论必须来自
WebView2 或 Android 真实目标。

钉底预填量按实际列表能力决定：未虚拟化版本（无 `data-count`，如默认基线 `30e723d5`）预填 300 条，虚拟化版本预填 1200 条；`--baseline=<commit>` 选到已虚拟化提交时两版同为 1200。上滚场景先解除钉底，再以最多 32 条/批等待 React 实际提交，直到两版均达到 1200；最后两版都重新滚到满窗口中点。不会一次把 1200 条塞进 pending 队列。预填后启动连续事件，再预热，测量期间不停流；手机预热 6s 使预填洪峰离开 412px 舞台。

## 手动 API

```js
const b = window.__danmakuP0Bench;
await b.start({
  variant: 'current', mode: 'both', rate: 25,
  width: 412, height: 240, panelWidth: 340, panelHeight: 480,
  scrolledUp: false,
});
try {
  await new Promise(resolve => setTimeout(resolve, 6000));
  const result = await b.sample(9000);
  console.log(result);
} finally {
  await b.dispose();
}
```

`prepare(options)` 只挂载、确认 bus readiness、预填；之后 `start()` 才开始持续注入。`start(options)` 自动完成两步。`stop()` 仅停注入，组件和设置隔离仍保留；**必须 `dispose()` 才完全恢复**。`metrics()` 可查询瞬时状态，`lastSample` 保留最近结果。不要并发调用场景切换/采样。

每 50ms 一批，用累加器生成 `rate/20` 条（25/s 为 1、1、1、2），短文本轮换且带唯一序号。层设置固定 font12、area1、merge0、speed100、stroke0、opacity0.8，取消屏蔽词/用户。通过 `persist.setOptions` 临时替换无副作用 storage，再 `setState`；`dispose`/准备失败的 `finally` 用仍隔离的 storage 还原原状态，最后恢复 storage。不会调用设置 setter、后端写入、收藏/发送/屏蔽按钮；整个组件宿主 `inert` 禁止手动误操作。

## 指标与边界

- FPS = 帧数 / **真实采样 duration**；帧间隔 median/p95/max、`>25ms` jank 数及比例。
- `PerformanceObserver` longtask 的 supported/count/maxMs/totalMs。
- 实际 sent、共享 bus received、batch 数、实际 received/s；定时器被阻塞时不补追 tick，避免制造假流量。
- `panelScrollEvents`：采样期间面板 viewport 收到的 scroll 事件数（只计数、不读几何）；钉底稳态应接近 0。
- 渲染器第一次 `emit` 暂包装捕获实例，立即恢复 prototype。每秒读 `size`；rAF 只记时间，**不会每帧查 DOM**。DOM 行数/data-count/在屏节点数/几何只在 sample 头尾读取。
- 基线没有 `data-count`，`panelDataCount:null`，`panelCount` 从实际行数推断；当前版同时报告窗口容量与实际 DOM 行数。
- CDP `Script/RecalcStyle/Layout/Task` 为累计秒数差转换的 ms/s，分母是 CDP **Timestamp 真差**。Task 包含子项，不能相加。
- `valid:false` 表示页面离开前台、注入失败或本应有流量却没收到事件；系统减少动态效果会在 layer prepare 阶段直接报错。
- `effectiveWillChange` 只在 layer/both 场景且已有节点上屏时非空；它是核对覆盖是否生效的依据。
- runner 的 `finally` 解除 CPU 节流、dispose 并 detach CDP。仍应保存设备温度/电源/浏览器版本及重复轮次，不能把一次结果等同于稳定硬件结论。
