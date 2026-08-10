# rLive Agent 工作规范

## 沟通语言

- 与用户沟通、进度更新、交付说明和新增项目文档统一使用中文。
- 代码标识符、命令、路径、第三方库名称和协议字段保留其原始英文写法。

## 工作区与 Windows 同步

- 唯一源码工作区是 WSL/Linux 下的 `/home/shenss/python/rLive`；所有修改都必须先在此目录完成。
- Windows 下的 `D:\dev\rLive`（WSL 路径 `/mnt/d/dev/rLive`）是同步镜像，不得直接作为源码目录编辑。
- 每完成一轮文件修改并完成必要验证后，交付前自动执行 `bash scripts/sync-to-windows.sh`，无需等待用户再次确认。
- 代码、UI、配置、依赖、脚本和文档修改都需要同步；仅进行只读检查、分析或答疑时不需要同步。
- 同步失败时必须调查可处理的问题；若因 `/mnt/d` 未挂载、权限或 Windows 环境不可用而无法同步，应在交付中明确报告，不能静默跳过。
- 自动同步不等于自动构建。除非用户明确要求，否则不要运行 Windows/Tauri 构建，也不要执行 Windows 端发布流程。

## 修改后验证

- 根据改动风险运行最聚焦、最有效的现有检查，例如 `bun run check`、`bun test tests/`、`bun run build`、Rust 测试或本地运行验证。
- 检查发现由本次改动引入的问题时，应定位并修复，然后重新运行相关检查，直到通过或确认存在外部阻塞。
- 纯文档或规划修改不要求运行时测试，但应检查内容、命令和路径是否与仓库现状一致。
- 交付前说明已执行的检查、Windows 同步结果，以及任何已知限制或外部阻塞。

## 提交说明规范

- 提交标题使用 `type(scope): 中文摘要` 的 Conventional Commit 形式；常用 `type` 包括 `feat`、`fix`、`refactor`、`perf`、`test`、`docs`、`build`、`chore`。`scope` 应准确指向功能域，例如 `player`、`mobile`、`history`，不要用文件名充当范围。
- 标题直接描述用户可感知的结果或明确的工程目的，不写句号，不使用“更新代码”“修复问题”“若干调整”等模糊表述；一次提交只表达一个可审查的主题。
- 除纯拼写、格式或单行无行为变更外，非平凡提交必须在标题后空一行并提供正文。正文先说明背景、错误现象或根因，再说明本次行为变化和关键实现，不得只有一行标题。
- 正文按改动实际情况覆盖：实现边界与没有改变的能力、状态/协议/数据库兼容与迁移方式、性能或安全取舍、测试与人工验证结果、文档更新。不能验证的部分必须明确写出原因。
- 正文优先用短段落说明因果，再用项目符号列出多项具体改动；不要堆砌文件名、逐行复述 diff，或把 issue 标题原样重复成正文。
- 提交前对照暂存区检查标题和正文是否准确涵盖全部改动。可参考提交 `8eadf9b17292c115c0b5516ae0e5247674d3a51f` 的结构：标题概括结果，正文解释根因，项目符号交代跨模块实现、回归测试和文档记录。

## 当前项目架构

- 技术栈：Tauri 2、Rust、React 19、TypeScript、Vite 8、Tailwind CSS 4、shadcn-style/Base UI。
- 前端状态：TanStack Query 管理异步服务端/IPC 数据缓存；Zustand 管理设置和轻量客户端状态。
- 前端动画：GSAP 动画封装位于 `src/shared/motion/`；应尊重减少动态效果设置，并优先使用 transform/opacity，避免布局抖动。
- 标准目录结构为 `src/`（React/Vite）与 `src-tauri/`（Tauri/Rust）；禁止使用旧的 `frontend/`、`backend/` 路径。
- `src/app/`：应用路由、Shell、路由懒加载与预加载。
- `src/features/`：home、follow、category、history、search、iptv、room、settings、asr 等业务功能。
- `src/components/ui/`：通用 UI 基础组件；`src/shared/`：API、hooks、stores、motion、types 和跨功能组件。
- `src-tauri/src/commands/`：Tauri 命令边界；`sites/`：站点实现；`danmaku/`：弹幕协议；`db/`：SQLite；`iptv/`：M3U 与可用性；`asr.rs`：本地语音字幕。
- 前后端通过 Tauri commands/events 交互。不要绕过既有命令层在前端直接复制 Rust 业务逻辑。

## 播放与功能边界

- 桌面直播统一使用 Web 播放链：`xgplayer` + FLV/HLS/MPEG-TS 协议插件；所有直播和 IPTV 播放均通过 Rust `stream_proxy` 注入请求头和处理同源访问；不是 mpv，也不是旧的 `mpegts.js` 直连架构。
- 已支持 Bilibili、Huya、Douyu、Douyin、Twitch 的浏览与播放；各站点搜索、翻页、Cookie 和弹幕能力以现有实现边界为准，不伪造平台不可靠的能力。
- 抖音支持 SSR 首屏浏览、房间/播放、登录 Cookie 搜索和本地签名实时弹幕；当前不提供弹幕发送。
- Twitch 使用 HLS 播放和匿名 IRC 弹幕，公开浏览接口仅可靠支持首屏。
- 弹幕包括列表、Canvas、SC 叠加层及透明度、字号、速度、区域、行数、过滤和屏蔽设置。
- 本地字幕使用 Web Audio 采集、16 kHz PCM IPC 与 Rust CrispASR CPU 会话；模型和音频数据保持设备本地。
- IPTV 的 `/iptv` 是频道发现页，`/iptv/play` 是独立播放页；进入发现页不得自动创建播放器或播放频道。

## UI 与文档

- 用户界面以中文为主，保持现有 Simple Live 风格和响应式桌面/移动布局。
- 优先复用仓库已有组件、hooks、stores 和功能边界，不新增平行实现。
- 用户文档入口为 `README.md` 和 `docs/README.md`，详细中文文档位于 `docs/zh/`。
- 功能、配置、运行方式或架构发生变化时，应同步更新相关中文文档。
