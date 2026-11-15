# GPUI Kit 迁移调研

本文评估把 rLive 的部分界面迁移到 GPUI Kit 的可行性、边界和验证顺序，不是迁移完成记录。调研基线为 `feat/gpui-migration` 分支的 `da82d0c979a7`，查阅日期为 2026-11-15。`npx skills add longbridge/gpui-kit` 安装的是编码与设计指南，不是运行时库；实际依赖仍是 `gpui-kit` crate。

## 1. 状态与结论

当前不建议整体重写 rLive，但也不把阶段化混合迁移视为已确认架构决策；宿主和媒体方案尚未确定。以下是调研建议，先以 Windows IPTV 作为独立验证面：

- 近期生产路径保持 Tauri 2、React、Video.js 和现有 Rust commands/events，即路线 C。
- 若启动架构验证，先评估 GPUI 原生发现页加 WebView 媒体岛，即路线 A；它最有机会复用现有播放器和 Rust 业务边界。
- 路线 B 不是路线 A 的失败备选；若原生媒体目标明确，可独立启动 GPUI Fast 原生合成加原生媒体 PoC。libmpv 仍只是候选 spike，不能写成已选路线。
- 不把 GPUI WebAssembly 作为过渡方案。上游仍定位为组件展示用途；2026-11-15 已撤销的 IPTV iframe/WASM 实验见[GPUI实验.md](GPUI实验.md)。
- Windows IPTV PoC 的对应验收未通过前，不宣称迁移完成，也不把其他页面纳入同批进度。

当前应用没有 GPUI 运行时入口。撤销实验后的现有 IPTV 回归为 7 个测试文件共 40 项通过，包含 favorites；此前前端 43 项加 Rust 4 项属于已撤销实验的历史验收。版本口径为 GPUI Kit `0.9.1`、`gpui-pre 0.3.12`、GPUI Fast `0.1.14`。

## 2. 现有 Tauri/React 边界

GPUI Kit 提供原生窗口、视图树、组件、焦点和 AccessKit，但不会自动接管 Tauri 的路由、WebView、commands、events、权限或播放器生命周期。

| 边界 | 事实与迁移影响 |
| --- | --- |
| 路由与 Shell | `src/app/App.tsx:98` 注册 React Router；`src/app/layout/Shell.tsx:611`、`src/app/layout/Shell.tsx:826`、`src/app/layout/Shell.tsx:845` 维护滚动恢复、面板保活和邻居放行。原生壳需重做 history、深链、返回、手势和滚动。 |
| 查询缓存 | `src/main.tsx:55` 设置全局 Query 默认值；`src/shared/api/browsingQueryPolicy.ts:16` 对昂贵列表使用长新鲜窗口。原生页面需另建缓存、失效和跨页共享。 |
| 设置与窗口 | `src/shared/stores/settingsStore.ts:1061` 串行写设置；`src/app/layout/AppTitleBar.tsx:21` 使用 Tauri window API。设置只能有一个所有者，标题栏和窗口生命周期需重验。 |
| IPC 权限 | `src-tauri/src/lib.rs:329` 定义 `main_window_only`，`:333` 校验窗口 label；`src/features/asr/captionWindow.ts:118` 另建受限字幕窗口。GPUI 窗口或 WebView 岛不能默认继承 `main` 权限，桥接必须校验 sender、命令和载荷。 |
| Web 专有能力 | `src-tauri/src/account/douyin_qr.rs:138` 依赖官方登录 WebView；`src-tauri/src/sites/acfun/content.rs:444`、`src-tauri/src/sites/acfun/content.rs:1099` 产出结构化文章。原生 UI 不能直接替代浏览器流程或完整排版语义。 |
| IPTV 发现 | `src/features/iptv/IptvController.tsx:32` 拥有来源、查询、搜索、分组、可用性和播放入口；`src/features/iptv/IptvPage.tsx:80` 只渲染发现页。原生页需保持 URL 恢复、缓存隔离和 openChannel 行为。 |
| IPTV 播放 | `src/features/iptv/IptvPlayerPage.tsx:123`、`src/features/iptv/IptvPlayer.tsx:132` 复用 Web 播放器会话，实际流经 Rust `stream_proxy`。Video.js 与 mpegts.js 不能直接进入 GPUI 画布。 |

结论是：Rust 解析、代理和探测能力可复用；窗口、路由、状态、权限和 Web 媒体生命周期不能靠替换 UI 层解决。

### 2.1 媒体和 Rust 复用证据

- `src/features/room/player/videoJsPlayer.ts:117` 的播放器参数直接持有 `HTMLVideoElement`，Video.js 和 mpegts.js 依赖浏览器媒体元素；GPUI 画布不能直接复用。
- `src-tauri/Cargo.toml:82` 只为 FFmpeg 开启 `format` feature，用于格式处理和 remux，不是完整解码与播放引擎。
- `src/features/asr/audio.ts:352` 用 `createMediaElementSource` 建立 WebAudio PCM 采集；原生 ASR 需要另接解码或音频输出路径。
- `src/features/room/danmaku/danmakuRenderer.ts:133` 的渲染器绑定 `HTMLElement` 和 `HTMLMediaElement`，弹幕仍是 DOM 渲染。
- IPTV 加载与探测、db、DLNA 等 Rust 逻辑可提取为共享 services，保留 Tauri 薄壳；`AppHandle`、`State`、events 和 async runtime 绑定需要适配，不能原样搬入 GPUI 或 Wry。
- 默认后端 `gpui-pre 0.3.12` 的 `surface()` 和 `paint_surface()` 仅在 Apple 平台接受 `CVPixelBuffer`，没有等价的 Windows/Linux 通用视频帧入口；不能把这一接口等同于 CPU 帧上传。
- `gpui-fast 0.1.14` 另有动态纹理路径：macOS 有明确的 CPU BGRA8 上传实现，Linux 有 WGPU 同 context 的 GPU-written 路径；Windows 的对应支持和外部解码器直接接入尚未核验，不代表已经支持三端统一 GPU 纹理导入。
- GPUI Fast 的外部表面合成接口承载原生 view、visual 或 subsurface，不是视频解码器，也不等同于任意媒体帧或 GPU 纹理导入。

## 3. 三条迁移路线

### 路线 A：GPUI 原生壳加 WebView 媒体岛

用 GPUI 构建窗口、导航和 IPTV 发现页，把播放器、扫码登录、ASR 字幕窗口等强 Web 页面作为 Wry WebView 岛嵌入。

- 优点：可逐步迁移；播放器继续使用 Video.js、mpegts.js 和 `stream_proxy`；Rust 站点与 IPTV 服务有机会提取为 UI 无关层。
- 代价：同窗口存在两套输入、焦点、层级和生命周期；`gpui-webview` 仍是实验集成，Windows WebView2 子视图会遮挡 GPUI 弹层，部分裁剪和滚动边界也会暴露。
- 代价：Tauri IPC 不会自动转给 Wry 页面；GPUI 与 Tauri 的事件循环、窗口所有权和打包没有官方现成方案。
- 结论：作为第一条 Windows IPTV 技术验证路线，但必须先做隔离原型，不直接改造生产入口。

### 路线 B：GPUI 原生合成加原生媒体

启用 `gpui-fast` 承载原生视频表面，让发现页和播放器都尽量脱离 WebView。

- 优点：若媒体表面集成成功，输入、层级和性能可更接近一体化原生应用；GPUI Fast 提供保留模式、滚动层和跨平台合成。
- 代价：GPUI 不提供完整视频引擎，原生合成不等于解决解复用、解码、音视频同步、字幕、HLS、请求头和代理生命周期。
- 代价：libmpv、FFmpeg、编解码模块和平台库的许可证与分发方式必须逐项审查；Windows 集成、硬解、全屏和错误恢复都需独立 spike。
- 结论：若原生媒体目标明确，可独立做纯原生 PoC，不依赖路线 A 是否失败；两条路线分别验收，不能把混合 PoC 结果当作纯原生迁移结论。

### 路线 C：保留生产路径，仅做原生非媒体原型

保持 Tauri/React 为唯一生产实现，用独立 GPUI 程序验证组件、中文排版、主题、键盘、缩放和 AccessKit。

- 优点：不改变发布、调试、权限和播放路径，风险最低。
- 代价：不能证明 Tauri/GPUI 共存、WebView 媒体岛、IPC 权限和正式数据边界。
- 结论：当前生产策略和低成本设计验证，不构成 IPTV 迁移。

## 4. 平台能力边界

| 平台 | 官方能力和判断 |
| --- | --- |
| Windows | GPUI 桌面主目标；`gpui-webview` 使用 WebView2 原生子视图并标为实验。首选验证平台，必须实测遮挡、裁剪、焦点、缩放、全屏、打包和调试。 |
| macOS | 支持桌面和 WKWebView；`gpui-fast` 可让延迟 overlay 位于页面上方。本仓库无本轮原生验证，不能套用 Windows 结论。 |
| Linux | WebView 仅支持 X11/XWayland，Wayland 无法嵌入；官方页面间对成熟度描述不完全一致。必须按实验能力实测，并评估 Wayland 回归。 |
| Android | 主要目标仍是桌面；官方只在 iOS/Android 的 AI chat 区域验证部分组件，完整应用布局和独立 activity/surface 宿主仍需单独验证。移动兼容包以 `gpui-pre 0.3.4` 为基线，与 Kit `0.3.12` 有类型不兼容风险。 |
| WebAssembly | 上游主要供组件展示；单画布、窗口、输入、字体、可访问性和启动成本都需逐项验证。旧实验已撤销，不作为生产或过渡路线。 |

## 5. Windows IPTV PoC 验收闸门

路线 A 和 B 分别验收，不要求同一原型满足两条路线。混合 PoC 可保留 WebView 播放器，但不能称为纯原生播放；纯原生 PoC 必须无 WebView 并显示真实视频帧。两者都要验证顶部和底部控制栏与视频画面的叠放。

### 5.1 共同发现页

- 内置和自定义 M3U、来源切换、搜索、分组、可用性筛选、清除和更新源与现有语义一致。
- 大列表可滚动、分页或虚拟化；方向键、Enter、Space、Tab、Shift-Tab 完成二维选择。
- URL、返回栈、刷新恢复、滚动位置、空列表、无效 M3U、探测超时和部分失败都有正确行为。

### 5.2 路线 A：混合播放

- 选择真实 Windows 公共源；播放器、控制栏和弹幕可以继续位于 WebView，但原生壳必须正确承载、缩放和关闭。
- 验证播放、暂停、音量、静音、重连、线路切换、窗口缩放、全屏，以及顶部和底部控制栏与视频叠放、焦点转移。
- HLS、FLV、裸 MPEG-TS、请求头、Referer、User-Agent、代理和 `stream_proxy` 按现有 Web 路径验证，并明确记录仍为 WebView 的区域；不能称纯原生播放。

### 5.3 路线 B：纯原生播放

- 选择真实 Windows 公共源后进入不含 WebView 的原生播放路径，看到真实视频帧，不能以占位层、外部系统播放器或 WebView 代替。
- 验证播放、暂停、音量、静音、重连、线路切换、窗口缩放、全屏、多显示器移动，以及顶部和底部控制栏与视频叠放。
- 原生路径单独验证 HLS、FLV、裸 MPEG-TS、请求头、Referer、User-Agent、代理和 `stream_proxy`；任何协议不支持都意味着路线 B 未闭环。

### 5.4 生命周期和资源

- 停止、返回、切换频道或来源、关闭窗口后，播放器、代理端口、连接、定时器、task、重连预算和子视图全部释放。
- 连续打开关闭不出现端口、线程或内存持续增长，也不残留后台播放。
- 代理失败、404、分片超时、清单错误和提前关窗不会触发迟到的旧会话回调。

### 5.5 功能边界

- 录制、DLNA 投屏、ASR 音频和字幕窗口逐项决定保留 WebView 岛或单独迁移，并完成真实功能测试。
- WebView 区域必须定义页面职责、IPC 命令、sender 校验、导航、下载和权限，不能继承 `main` 的全部能力。
- IPTV 关注、自定义源、可用性缓存、代理和播放记录不得在原生与 Web 两侧双写。

### 5.6 性能、可靠性和可访问性

- 与同日同版本 Tauri/React 对比冷启动、发现页首帧、播放首帧、内存、CPU、GPU 和安装包体积。
- 验证 16 到 20 CSS px 根字号或等价缩放、中文、emoji、明暗主题、紧凑模式、不同宽度和高 DPI。
- 对原生路径用真实键盘和 Windows Narrator 检查角色、名称、状态、焦点、输入法和错误提示；检查签名、更新、日志、崩溃恢复和许可证。

## 6. 风险矩阵

| 风险 | 缓解方向 |
| --- | --- |
| GPUI 与 Tauri 双运行时 | 先用独立最小窗口 spike 验证事件循环、关闭顺序和打包，未通过不接生产入口。 |
| WebView 子视图层级 | 弹层移出 WebView 边界或独立窗口；Windows 实测遮挡、裁剪和焦点。 |
| 状态双写 | IPTV 来源、筛选、可用性和设置保持单一所有者，原生页只持视图状态。 |
| IPC 权限扩大 | 按窗口、sender、命令和载荷白名单校验，不复用全量 `main` 权限。 |
| 原生媒体缺口 | 路线 A 保留 Web 播放器；路线 B 另做媒体与许可证 spike。 |
| 平台回归 | Linux 限定 X11/XWayland；Android 不纳入首轮；macOS 单独验证。 |
| 可访问性和排版 | 使用 Kit 语义组件，逐平台验收 Narrator、IME、CJK 和 emoji。 |
| 上游实验状态 | 固定版本和 commit，升级前重跑原生边界测试。 |

## 7. 建议顺序

1. 路线 C 做纯原生非媒体原型，只验证中文排版、主题、列表密度、键盘和 AccessKit。
2. 路线 A 做 Windows 独立 IPTV 窗口，证明 GPUI 窗口、Wry WebView2 岛、窄 IPC、关闭和调试链路。
3. 原生媒体目标明确时独立启动路线 B 的纯原生 PoC，不必等待路线 A 失败。
4. 共用发现页接现有 Rust IPTV 服务；两条路线分别记录播放、叠放、资源和性能结果，不把混合 PoC 的通过当作纯原生迁移完成。

## 8. 尚未验证

- 没有实现 GPUI 原生窗口、Rust IPC 业务迁移或原生视频播放器。
- 没有 Windows 原生路径的启动、内存、CPU/GPU、长列表或播放首帧数据。
- 没有 macOS、Linux、Android 或 WebAssembly 的原生集成验收。
- Windows WebView2 实验已验证方向键、Enter、Space、Tab、Shift-Tab；原生路径、其他平台、屏幕阅读器、输入法和中文排版未验收。
- 没有对 libmpv、FFmpeg 或编解码器分发方案作出选择；旧实验也不证明公共 IPTV 频道持续可播。

## 9. 官方资料

查阅日期均为 2026-11-15：

- [GPUI Kit](https://gpui-kit.com)与[仓库](https://github.com/longbridge/gpui-kit)：组件、主题、测试及 `0.9.1`/`0.3.12` 版本依据。
- [WebView 文档](https://gpui-kit.com/docs/webview)：Windows WebView2 子视图、overlay 和裁剪限制，Linux 仅 X11，Wayland 不支持。
- [Native Extensions](https://gpui-kit.com/docs/native-extension)：原生子视图、焦点、生命周期和平台适配边界。
- [Mobile](https://gpui-kit.com/docs/mobile)：桌面优先、有限组件验证和 `gpui-pre` 版本风险。
- [WebAssembly](https://gpui-kit.com/docs/webassembly)：展示定位、单画布、字体、输入和可访问性限制。
- [GPUI Fast 0.1.14](https://crates.io/crates/gpui-fast/0.1.14)、[源码仓库](https://github.com/longbridge/gpui-fast)与 [Accessibility](https://gpui-kit.com/docs/accessibility)：合成路径及 AccessKit 实机验收要求。
