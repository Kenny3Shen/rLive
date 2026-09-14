# rLive Agent 规范

## 通用

- 沟通、交付和新增文档使用中文；思考、标识符、命令、路径、库名、协议字段保留英文。
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

## Android 调试

- 先用模拟器复现；触摸/手势问题必须用真机验证。完整流程见 `docs/zh/Android开发-Windows.md`「调试」。
- 远程调试必须使用 ABI 匹配的 debug APK：真机 `aarch64`，x86_64 模拟器 `x86_64`；分别检查 APK 的 `lib/` 与设备 `primaryCpuAbi`。release APK 不支持 WebView CDP。
- CDP：先将 `webview_devtools_remote_<pid>` 转发到 `tcp:9222`，再用 `playwright-cli attach --cdp=http://localhost:9222`；真机须授权 USB 调试并保持亮屏。
- 手势坐标按 `物理坐标 = CSS 坐标 × devicePixelRatio` 换算；排查触摸前注入 touch/click/contextmenu/cancel 事件探针。
- 使用 Windows emulator（`D:\dev\android-sdk`，AVD `rlive_win`）；带窗口可从 WSL 启动，headless 必须用 PowerShell `Start-Process`。多设备时显式传 `-s`；VS Code 设置 `"emulator.emulatorPathWSL": "/mnt/d/dev/android-sdk/emulator"`。

## 播放与功能边界

- 直播和 IPTV 使用 Video.js（HLS/DASH）与 `mpegts.js`；支持原生播放时直接使用 `<video>`；请求头和同源处理统一走 Rust `stream_proxy`。Video.js React 文档：https://videojs.org/docs/framework/react/llms.txt
- 支持 Bilibili、Huya、Douyu、Douyin、Twitch；能力以现有实现为准，不伪造不可靠能力；Twitch 使用 HLS 和匿名 IRC，公开浏览接口仅保证首屏。

## UI 与文档

- UI 以中文为主。
- 文档入口为 `README.md`、`docs/README.md`，中文详档位于 `docs/zh/`。功能、配置、运行方式或架构变化须同步更新文档。
