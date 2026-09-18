# rLive Agent 规范

## 通用

- 沟通、交付和新增文档使用中文；标识符、命令、路径、库名、协议字段保留英文。
- 仅编辑 `/home/shenss/python/rLive`；`/mnt/d/dev/rLive` 只作 Windows 镜像。
- 代码修改后运行最聚焦的检查（如`bun run check` 、`bun test`、`cargo test`、`cargo check`等）。
- 检查通过后、交付前运行 `bash scripts/sync-to-windows.sh`，只读任务不需同步。
- 交付时说明检查、同步结果及已知限制。

## 提交

- 标题使用 `type(scope): 中文摘要`；`scope` 写功能域，不写文件名。一次提交只含一个主题，表述简洁明确。
- 非平凡提交须在空行后说明背景或根因、行为变化、关键实现，多项内容使用列表，正文使用真实换行。
- 仅发布 tag 时按 SemVer 同步更新版本号 `package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.lock`；详见 `docs/zh/发布流程.md`。

## 架构

- 技术栈：Tauri 2、Rust、React 19、TypeScript 7、Vite 8、Tailwind CSS 4、shadcn-style/Base UI、Video.js、Sherpa-onnx
- `src/` 为前端，`src-tauri/` 为后端；`src/app/` 管路由与 Shell，`src/features/` 管业务，`src/components/ui/` 管通用 UI，`src/shared/` 管跨功能代码。
- 后端命令、站点、弹幕、数据库、IPTV、ASR 分别位于 `src-tauri/src/commands/`、`sites/`、`danmaku/`、`db/`、`iptv/`、`asr.rs`。
- 服务端/IPC 缓存用 TanStack Query；设置和轻量状态用 Zustand。
- 动效仅用 Web Animations API 和 CSS，封装于 `src/shared/motion/`。
- 前后端复用现有 Tauri commands/events；优先复用现有组件、hooks、stores 和边界，不在前端复制 Rust 业务逻辑或建立平行实现。

## 调试

先在桌面复现，只有触摸/手势、WebView 版本相关的行为才上 Android。桌面优先走 Windows 主窗口（CDP 可接入、能用 playwright 自动断言）。

1. **Windows 主窗口（首选，CDP）**：`bash scripts/sync-to-windows.sh` → 停掉所有 rLive 实例（共享 WebView2 数据目录 `%LOCALAPPDATA%\com.shenss.rlive\EBWebView`，先起的实例决定浏览器参数）→ 带 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9223 --remote-allow-origins=*"` 在镜像目录起 `bun run tauri dev` → `curl -s http://127.0.0.1:9223/json/version` 就绪后 `playwright-cli attach --cdp=http://127.0.0.1:9223`。只在主窗口页面上调试，CDP 新建的标签页没有 Tauri IPC。
2. **Linux/WSL（WebKitGTK，无 CDP）**：`bun run tauri dev` 后在页面右键直接开 WebKit 检查器（元素、网络、控制台、媒体缓冲）；需从别的机器看时给进程设 `WEBKIT_INSPECTOR_SERVER=127.0.0.1:9223` 再用 WebKit 浏览器连 `http://127.0.0.1:9223`。playwright 无法接入。
3. **Android（真机或模拟器）**：装 ABI 匹配的 debug 包（真机 `aarch64`，x86_64 模拟器 `x86_64`；release 包没有 devtools socket）→ `adb forward tcp:9222 localabstract:webview_devtools_remote_$PID`（`$PID` 由 `adb shell pidof com.shenss.rlive` 取）→ `playwright-cli attach --cdp=http://localhost:9222`，用 `/json/version` 的 `Android-Package` 核对没连到别的应用。

通用约束：

- 桌面 CDP 会话没有 `hasTouch`，`page.touchscreen.*` 会失败；要触摸语义就合成 `pointerType: "touch"` 的 PointerEvent（`tests/browser/harness.js` 的 `touchTap`）。
- 手势用 `adb shell input tap/swipe` 注入，坐标按 `物理坐标 = CSS 坐标 × devicePixelRatio` 换算；排查触摸前先注入 touch/click/contextmenu/cancel 事件探针；长按类问题只能真机手动按住。
- 生产 React 只有 minified 错误码，组件栈必须用 dev 构建（`bun run tauri dev` / `android dev`），`vite build --mode development` 不产出 dev React。
- 视频画面走硬件层，CDP 截图拍不到，视觉证据用 `adb exec-out screencap -p > /tmp/x.png`。
- Windows dev 会话的 vite 占 1420 且与 WSL 共享 loopback，与 WSL 的 `bun run dev` / `tauri android dev` 互斥。
- 模拟器用 Windows emulator（`D:\dev\android-sdk`，AVD `rlive_win`）；带窗口可从 WSL 启动，headless 必须用 PowerShell `Start-Process`，否则随 WSL 会话被回收。多设备/多模拟器时显式传 `-s`。

完整步骤、探针代码与排错清单：`docs/zh/开发指南.md`「桌面端实机调试」、`docs/zh/Android开发-Windows.md`「调试」。

## 播放与功能边界

- 直播和 IPTV 使用 Video.js（HLS/DASH）与 `mpegts.js`；支持原生播放时直接使用 `<video>`；请求头和同源处理统一走 Rust `stream_proxy`。Video.js React 文档：https://videojs.org/docs/framework/react/llms.txt
- 支持 Bilibili、Huya、Douyu、Douyin、Twitch；能力以现有实现为准，不伪造不可靠能力；Twitch 使用 HLS 和匿名 IRC，公开浏览接口仅保证首屏。

## UI 与文档

- UI 以中文为主。
- 文档入口为 `README.md`、`docs/README.md`，中文详档位于 `docs/zh/`。功能、配置、运行方式或架构变化须同步更新文档。
