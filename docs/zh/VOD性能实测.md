# Windows Debug VOD 加载与续播性能实测

首轮测试日期：2026-09-24。基线：`dc88f704`，rLive `5.2.0`。前半部分记录首轮只读瓶颈测量；后续实施和优化前后对照见本文末尾「第二轮：优化实现与实测对照」。

## 结论

本轮秒级等待主要发生在媒体分片传输阶段。续播另有可重复的额外工作：先请求开头分片，等 `loadedmetadata` 才设置历史位置，随后取消开头请求、重新请求音视频 init，再下载目标分片。SQLite 历史查询与本地代理启动都只有毫秒级开销。

**应用配置了网络代理**。因此本文的“上游传输”包括已配置代理和 CDN，不能仅凭本轮数据归咎于 CDN，也没有进行关闭代理后的对照。前端主线程存在 Debug React 渲染长任务，但不足以解释最慢样本中的数秒等待。

## 环境与口径

| 项目 | 实测条件 |
| --- | --- |
| Windows | Windows 11，`10.0.26200` |
| CPU | Intel Core i5-13600KF，20 个逻辑处理器 |
| 客户端 | `D:\dev\rLive\src-tauri\target\debug\rlive.exe`，`cargo run --no-default-features` |
| 前端 | Vite dev、React dev、真实 Tauri 主窗口 |
| WebView2 | Chromium / Edge `153.0.0.0`，CDP `127.0.0.1:9223` |
| 视频 | `BV1cSec6tEux`，`cid=42166259485`，时长 `1631.263` 秒 |
| 清晰度 | 页面自动选到 `qn=120`、超清 4K，`avc1.640034` |
| 入口 | 首轮推荐卡片；正式对照从视频历史卡片进入，URL 带 cid |
| 缓存 | 页面未传 `media_cache`，后端按 false 处理；没有清空系统／网络缓存 |
| 采集 | 真实 IPC、CDP 请求与 Range、原生媒体事件、`requestVideoFrameCallback`、Long Task、CPU profile、Rust 代理遥测 |

正式对照使用同一稿件的 0 秒与 600 秒历史位置，各 3 次；准备阶段通过现有 `video_history_add` 写入目标位置，之后真实点击历史卡片。未替换后端返回值、媒体内容或播放器引擎。进页前销毁旧播放器及其代理，Query／模块／连接等进程状态保持热状态；“从头播放”不等于应用冷启动。

`zero1` 未启用 CPU Profiler，其余五轮启用。采样本身和 Debug 校验有开销，数字不能外推为 release 性能；样本量也不足以计算有代表性的 P95。

测试开始时 Windows 镜像与工作区前后端源码按内容一致。正式采样完成后，工作区出现了并行的弹幕组件改动，当时尚未同步到镜像；本文结论不代表这些改动之后的性能。

## 加载与续播结果

首帧计时从实际卡片 click 开始，到媒体元素的首次 `requestVideoFrameCallback` 回调。续播样本同时检查了首帧的媒体时间，落在 600 秒附近；并记录 `seeked` / `playing`，避免把 0 秒画面误算成续播完成。

| 场景 / 样本 | 播放信息 IPC¹ | 点击→metadata | 点击→目标首帧 | 点击→playing |
| --- | ---: | ---: | ---: | ---: |
| 从头 `zero1` | 456.0 ms | 1226.8 ms | 3433.3 ms | 3330.9 ms |
| 从头 `zero2` | 469.8 ms | 1319.3 ms | 4165.8 ms | 4165.5 ms |
| 从头 `zero3` | 371.0 ms | 998.2 ms | 5036.7 ms | 5036.1 ms |
| 600 秒续播 `deep1` | 576.9 ms | 1522.6 ms | 11668.4 ms | 11835.6 ms |
| 600 秒续播 `deep2` | 499.6 ms | 1401.5 ms | 3380.0 ms | 3505.6 ms |
| 600 秒续播 `deep3` | 351.3 ms | 1138.7 ms | 3990.5 ms | 4144.4 ms |

¹ 此处为页面 `fetch` 到响应头返回的观测值，包含主线程调度；不是 Rust CPU 执行时间。CDP 同时保留实际请求完成耗时。

- 从头首帧中位数 **4.166 秒**，范围 **3.433–5.037 秒**。
- 600 秒续播首帧中位数 **3.991 秒**，范围 **3.380–11.668 秒**。
- 两组下载的分片大小不同，且上游速度变化明显；不能用两个中位数声称续播比从头快，或据此量化优化收益。
- 探索阶段另观察到首次进入首帧 **10.56 秒**、约 84 秒位置续播首帧 **16.64 秒**，作为慢例保留，未混入固定位置的三次样本。

## 瓶颈一：媒体分片传输主导慢例

| 样本 | 首个需要的视频媒体分片 | 完整下载耗时 | 响应头耗时² |
| --- | ---: | ---: | ---: |
| `zero1` | 约 8.36 MB | 2105.7 ms | 76.7 ms |
| `zero2` | 约 8.36 MB | 3090.2 ms | 105.2 ms |
| `zero3` | 约 8.36 MB | 4072.7 ms | 54.1 ms |
| `deep1` | 约 5.63 MB | **8656.2 ms** | 92.8 ms |
| `deep2` | 同一约 5.63 MB 分片 | 667.8 ms | 43.6 ms |
| `deep3` | 同一约 5.63 MB 分片 | 1227.2 ms | 56.7 ms |

² CDP `receiveHeadersStart`，针对本机 Rust 代理的 HTTP 请求；包含代理等待上游响应头的时间。表中大小按 CDP 完成请求字节数取近似值，包含少量协议头。

`deep1` 在 1.523 秒就发起续播 seek，首帧却到 11.668 秒才出现。目标 Range 为 `bytes=574946390-580573273`。同一 Range 在三轮中分别耗时 8.66、0.67、1.23 秒，且慢例的响应头并不慢，主要差异在响应体传输阶段。

该轮 CPU profile 共约 12.45 秒，`(idle)` 样本约 9.60 秒。Rust 代理遥测没有记录上游请求失败。两者共同说明这轮的主要等待不是前端持续计算，也不是报错重试；但没有采集代理服务端或 CDN 端数据，无法进一步区分远端限速、网络吞吐和代理路径的影响。

当前 MPD 只含一条已选视频 Representation；本轮以 4K 固定轨播放，不能假定播放器会自行降清晰度。后续应做同稿件 1080P、4K 及不同代理路径的交错对照。

## 瓶颈二：续播晚 seek 造成取消请求及重复 init

三轮 600 秒续播均出现相同顺序：

1. 请求视频 init：`bytes=0-927`；同时请求音频 init。
2. 开始请求 0 秒视频分片：`bytes=4928-8367928`，以及开头音频分片。
3. `loadedmetadata` 触发，页面立即设置 `currentTime=600`。
4. 已发出的开头音视频分片被取消，CDP 记录 `net::ERR_ABORTED`。
5. 再次请求相同的音视频 init，然后才请求 600 秒附近的目标分片。

`deep1 / deep2 / deep3` 第二次视频 init 完整请求分别为 **376.1 / 178.2 / 478.1 ms**。还有被取消请求已经传输的部分字节与调度开销；不能把开头 Range 声明的整个 8.36 MB 都记为浪费，因为请求没有完成。

代码证据：

- `src/features/video/VideoPlayerPage.tsx` 的播放器 effect 在 `onReady` 中应用 `pendingInitialSeek`，事件来自 `loadedmetadata` / `canplay`。
- `src/features/room/player/videoJsPlayer.ts` 建立 DASH source 时未传初始续播位置。
- `src/features/video/VideoPlayerPage.tsx` 的 `videoGetPlayInfo` 请求不传 `media_cache`。
- `src-tauri/src/commands/video.rs` 仅在显式启用媒体缓存时使用 `selection.*.init_bytes` 预填缓存。因此普通 VOD 在后端取 sidx 时已经取过 init，播放器阶段仍再次走上游。

建议优先验证：在 DASH 第一次调度前通过公开能力设置起播目标，消除“从 0 调度后再 seek”；随后复用已取得的 init 字节。现有磁盘缓存只覆盖前 10 秒，**直接开启它并不会缓存 600 秒目标分片**，不可将它视作深位置续播的完整解法。

这些是已测到的额外工作与待验证的优化方向；本轮没有实施或测量其收益。

## 前端：Debug 渲染长任务与响应排队

正式样本在首帧前有约 **259–432 ms** 的累计 Long Task，单个典型任务约 **50–179 ms**。这些任务与网络请求重叠，不能直接与网络耗时相加。

`deep1` CPU profile 中按业务组件调用栈聚合的采样时间约为：

| 组件 | 累计采样时间³ |
| --- | ---: |
| `VideoCard.tsx` | 100 ms |
| `CommentsPanel.tsx` | 88 ms |
| `VideoDanmakuList.tsx` | 81 ms |
| `VideoPlayerPage.tsx` | 48 ms |

³ 调用栈内采样累计，包含子调用；不是 React commit 次数或单次 render 的精确持续时间，不宜相加当作总 CPU。

基线侧栏把页签内容常驻。弹幕列表对已加载条目全量 `map`；即使弹幕页签不活动，仍付出 React 元素创建／更新成本。`content-visibility:auto` 主要减少布局绘制，不会省掉这部分 React 工作。Debug React 的 `jsxDEV`、属性校验也是显著热点。首次 mount 还观测到重复的弹幕请求，符合开发态 effect 重放行为；本轮未做 release 对照，不能把重复次数直接归给生产版本。

有代表性的误判是历史查询：页面观察到 `video_history_find` 花 **83–168 ms**，CDP 中对应 POST 请求却只有 **1.95–2.94 ms**。请求已经返回，但响应处理要等待渲染任务结束。优化时应同时查看网络完成时间与 JS 回调时间。

建议把非活动页签的数据读取／渲染与首帧路径分开，并在弹幕条目较多时降低不必要的 React 更新；这部分收益需用相同 Debug 基线及 release 另测。测试结束后出现的并行弹幕组件改动不包含在这里的评估中。

## 后端：本地开销与网络阶段分开看

在退出播放器、无媒体下载时，对真实 IPC 各测 10 次：

| 操作 | 中位数 | 范围 |
| --- | ---: | ---: |
| `video_history_find` | **1.20 ms** | 1.10–2.30 ms |
| `stream_proxy_start` | **1.65 ms** | 1.40–3.50 ms |

代理基准使用不发起上游请求的占位媒体 URL，只测真实 bind／客户端构建／IPC；每次随后调用 `stream_proxy_stop` 释放测试会话。未通过占位媒体模拟播放性能。

正式六轮 `video_get_play_info` 页面观测值为 **351–577 ms**，中位数约 **463 ms**；探索阶段出现过约 **1.16 秒与 1.83 秒**。这条 command 包含 playurl、双轨 init/sidx、代理建立和 MPD 合成。双轨 sidx 和双轨代理在基线已经并发，重新并发化不是本轮的新优化点。

已有 `stream_proxy_telemetry` 可以报告上游请求数、失败数、转发字节和响应头耗时；其 `first_response_ms` / `latest_response_ms` **不是完整分片下载耗时**。本轮结合这些指标和 CDP 已定位主要等待阶段，因此未接入 CrabNebula DevTools。未新增 Rust span，也未采集 Rust CPU profile，不能进一步给 playurl、sidx、签名、MPD 分配精确占比。

## 可复跑采样

脚本：[`tests/vod-performance.browser.js`](../../tests/vod-performance.browser.js)。必须连接真实主窗口，具体启动见[开发指南](开发指南.md#桌面端实机调试)。

1. 在应用中播放目标视频并定位到待测位置，暂停并返回视频历史，确认历史已保存。
2. 为卡片可访问名称设置一个唯一匹配的正则表达式，再运行脚本：

```bash
playwright-cli -s=rwin attach --cdp=http://127.0.0.1:9223
playwright-cli -s=rwin eval 'window.__vodPerformanceConfig = {cardName:"^27:11 选哪个？iPhone",timeoutMs:45000}'
playwright-cli -s=rwin --raw run-code --filename=tests/vod-performance.browser.js > .playwright-cli/vod-result.json
playwright-cli -s=rwin --raw eval 'window.__vodPerformanceProfile' > .playwright-cli/vod.cpuprofile
```

脚本真实点击卡片，返回媒体事件、IPC 观测、CDP Range 时间线、后端代理遥测和 CPU 热点。结果保存在 `window.__vodPerformanceResult`；CPU profile 可导入 Chromium DevTools。请求 URL 去除 query，结果不保存 Cookie、认证头或带签名的上游媒体 URL。

正常完成后暂停视频，`finally` 中恢复 `fetch` / `currentTime`，移除事件探针并断开此次 CDP 会话。`timeout:true` 表示超时，不能把该轮记为成功首帧。脚本不清空缓存、不改写历史、不修改清晰度；正常观看产生的历史上报仍会发生。

本次本地原始证据保存在未跟踪的 `.playwright-cli/`：

- `vod-perf-initial.json`、`vod-perf-all.json`：探索阶段时间线。
- `vod-zero{1,2,3}.json`、`vod-deep{1,2,3}.json`：正式网络、媒体与遥测样本。
- 相应 `.cpuprofile`：CPU 原始采样，`zero1` 除外。
- `vod-local-bench.json`：本地 IPC 基准的 10 次原始值。
- `vod-fixture-validation.json`、`vod-fixture-resume-validation.json`：最终脚本验证。

最终脚本分别完成从头与 600 秒续播验证，均取得真实播放信息、网络和代理遥测，未超时、未出现该次采样的 `pageerror`。续播验证首帧媒体时间为 `599.999375` 秒；结束后确认播放器暂停、探针已移除、原生 `currentTime` setter 已恢复。

## 覆盖范围

本轮只覆盖一个 UGC 长视频、带 cid 的卡片入口、默认选到的 4K、Windows Debug 与当前已配置代理。尚未覆盖无 cid 的跨分 P 入口、PGC、应用进程冷启动、1080P、release、Android、不同代理及无代理网络。这些场景有不同的串行依赖和媒体大小，不能套用本轮的绝对时间。

## 第二轮：优化实现与实测对照

同日根据首轮瓶颈实施两项优化。当前工作区基线已包含并行提交 `be80bb22`（点播弹幕跟随修复），本轮没有把该提交的收益算作自己的优化。新旧播放页的交错对照使用同一套公共组件和同一个优化后端，单独隔离本轮前端续播变化。

### 实际改动

1. **DASH 首次调度直接使用续播目标。** `videoJsPlayer.ts` 增加可选 `startTime`，通过 dash.js 原生支持的 MPD anchor `#t=秒` 传入；锚点不发送到本机代理。`VideoPlayerPage.tsx` 在创建 source 之前确定历史／同集快照的位置，DASH 的 metadata 回调不再补一次原生 seek。播放／暂停意图仍保留；原生仅音频继续在 metadata 就绪后定位。
2. **init 字节随代理会话复用。** `video_get_play_info` 将已经取得的音视频 init 传给 `StreamProxyStartOptions.initialization`。仅 `GET /live`、非 HLS、单个精确覆盖整个 init 且没有 `If-Range` 的请求命中本机 206；其他请求照常回源。字节使用 `Arc<[u8]>`，随会话停止释放，与磁盘缓存开关无关，不缓存整段视频或带签名的播放地址。

首次调度阶段不再请求 0 秒媒体分片。真实采样中的 `set-currentTime` 事件仍可能来自 dash.js 自身的初始定位；判断是否消除了二次 seek 应看 Range 时间线，而不能要求原生 setter 从此完全不被调用。

### 确定的请求与阶段收益

| 指标 | 优化前 | 优化后 | 差距 |
| --- | ---: | ---: | --- |
| 600 秒续播：开头视频分片误请求 | 每次 1 个，随后取消 | 0 个 | 消除无效请求 |
| 600 秒续播：每轨 init 请求数 | 2 次 | 1 次 | 减少 50% |
| 视频 init 完整请求中位数⁴ | 133.35 ms | 2.20 ms | 约减少 **98.4%** |
| 取流返回→目标视频分片开始⁵ | 538.85 ms | 393.60 ms | 减少 **145.25 ms / 27.0%** |

⁴ 完整基线续播组 5 轮、10 次 init；优化组 5 轮、5 次 init。范围分别为 89.4–387.4 ms、1.9–6.8 ms。新路径不触达上游，206 正文与预取字节一致由本地 HTTP 回归及实机解码共同验证。两组网络本来不同，百分比描述观测结果；明确的机制收益是省掉 init 的上游请求。

⁵ 在同一个优化后端上对旧／新前端交错各测 4 次。通过 Playwright 仅替换旧播放页的 Vite 编译模块，公共组件、后端、真实 IPC、媒体、代理设置保持相同。两侧均重新加载页面、启用相同路由拦截及 CPU Profiler。该指标截至目标请求开始，排除了目标分片下载速度的巨大波动。

### 端到端对照：从头播放小幅改善，续播总耗时尚不能证明稳定提速

本轮重新采集优化前基线，没有拿首轮 10–16 秒的慢例当作改善幅度。以下均为真实 Windows Debug 主窗口、同一条 4K 视频和现有代理设置：

| 场景 | 优化前首帧 | 优化后首帧 | 解释 |
| --- | --- | --- | --- |
| 从头播放，各 3 次 | 中位 **1.966 s**；1.773–2.112 s | 中位 **1.838 s**；1.722–2.015 s | 约减少 **128 ms / 6.5%**；两组首媒体分片传输分别 0.824–0.954 s、0.903–0.920 s，条件较接近 |
| 600 秒续播，完整前后各 5 次 | 中位 **3.100 s**；2.961–4.255 s | 中位 **7.781 s**；7.645–8.256 s | 这一批总耗时反而更长，不能宣称整体提速；同一目标分片传输从 0.623–0.837 s 变成 4.596–5.619 s，播放信息获取也变慢 |
| 同后端交错旧／新前端，各 4 次 | 中位 **6.720 s**；4.119–9.140 s | 中位 **3.787 s**；3.343–8.874 s | 只用于辅助观察；两侧分片与取流耗时仍不同，不能把 43.6% 的表面差额都算作前端优化 |

完整优化续播组包含后端重启后的第一轮，没有删除较慢样本。优化版随后追加观察到一轮首帧 4.400 秒，以及一轮 **40 秒未出首帧**：该轮目标 Range 在约 20 秒被播放器取消后重试，未产生前端异常，但首帧仍超时。下一轮被外层命令截止中断，没有完整结果，不计入成功样本。这些失败说明上游传输仍是剩余瓶颈，不能因为本地 init 变快就宣布续播问题全部解决。

当前结论是：**已消除确定的重复请求，缩短本机 init 与目标分片调度阶段；从头播放在本批近似传输条件下有小幅收益；续播端到端改善仍需稳定网络下进一步验证。** 本轮未修改用户的代理配置，也未实施未经验证的 CDN 切换策略。

### 数据与检查

可审阅的脱敏阶段数据见 [`性能数据/VOD优化对比-2026-09-24.json`](性能数据/VOD优化对比-2026-09-24.json)，包含 26 个样本及失败标记。完整本地时间线保存在 `.playwright-cli/` 的 `before-*`、`after-*`、`ab-old-*`、`ab-new-*` 文件中。用于探索的 Range 改写没有形成有效旧后端对照，相关 `full-old/full-new` 文件未用于定量结论。

- `bun run check`：通过，无 lint 警告。
- `bun test tests/`：**627 通过，0 失败**，含 DASH 初始锚点、无效位置、原生音频及既有播放生命周期回归。
- `cargo check --manifest-path src-tauri/Cargo.toml --lib`：通过。
- Rust 代理测试：**39 通过，5 忽略**；VOD command 测试：**6 通过**。新增真实本地 HTTP 回归覆盖 init 字节一致、关闭磁盘缓存仍命中、非精确／条件 Range 回源、会话隔离和停止后内存释放。
- 浏览器桩回归：跨分 P 续播、无二次原生 seek、自动下一集及自动播放／循环播放／取消切集均通过。这些验证业务语义，不作为真实播放性能数据。
- Windows 实机：新 source 首帧落在 `599.999375` 秒，优化样本无开头分片误请求；暂停后刷新、切到 1080P、切为原生仅音频，均在新 source 的 metadata 就绪后保持 600 秒与暂停状态。
- Windows Debug 已重新编译并加载新后端；源码和文档通过 `scripts/sync-to-windows.sh` 同步。

