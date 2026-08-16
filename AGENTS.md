
# rLive Agent 工作规范

## 通用规则

- 用户沟通、进度更新、交付说明和新增文档使用中文；代码标识符、命令、路径、库名和协议字段保留英文。
- 唯一源码工作区是 `/home/shenss/python/rLive`。`/mnt/d/dev/rLive` 仅作为 Windows 同步镜像，不得直接编辑。
- 每轮修改完成并通过必要检查后，交付前执行 `bash scripts/sync-to-windows.sh`；只读检查、分析或答疑无需同步。同步不等于构建，除非用户明确要求，不运行 Windows/Tauri 构建或 Windows 发布流程。
- 按改动风险运行最聚焦的检查，如 `bun run check`、`bun test tests/`、`bun run build`、Rust 测试或本地运行验证。纯文档修改只需核对内容、命令和路径，并在交付时说明检查、同步结果和已知限制。

## 提交规范

- 提交标题使用 `type(scope): 中文摘要` 的 Conventional Commit 格式；`scope` 指向功能域，不使用文件名。一次提交只表达一个主题，标题直接描述结果，不写句号或模糊表述。
- 非平凡提交在标题后空一行，用正文说明背景/根因、行为变化、关键实现和验证结果；多项改动使用项目符号。提交前检查暂存区内容与说明是否一致。
- 提交正文使用真实换行，避免将 `\n` 写成字面量。
- 提交代码时需要更新版本号，遵循语义化版本规范（SemVer）。

## 项目结构与实现边界

- 技术栈为 Tauri 2、Rust、React 19、TypeScript、Vite 8、Tailwind CSS 4 和 shadcn-style/Base UI。
- 前端使用 TanStack Query 管理服务端/IPC 缓存，Zustand 管理设置和轻量状态；GSAP 封装在 `src/shared/motion/`，动画需尊重减少动态效果设置，并优先使用 `transform`/`opacity`。
- `src/` 是 React/Vite 前端，`src-tauri/` 是 Tauri/Rust 后端；`src/app/` 管理路由与 Shell，`src/features/` 管理业务，`src/components/ui/` 提供通用 UI，`src/shared/` 提供跨功能代码。后端命令、站点、弹幕、数据库、IPTV 和 ASR 分别位于 `src-tauri/src/commands/`、`sites/`、`danmaku/`、`db/`、`iptv/` 和 `asr.rs`。
- 前后端通过既有 Tauri commands/events 交互。优先复用已有组件、hooks、stores 和功能边界，不在前端复制 Rust 业务逻辑或新增平行实现。

## 播放与功能边界

- 直播和 IPTV 使用 `xgplayer` 配合 FLV/HLS/MPEG-TS 插件，并统一通过 Rust `stream_proxy` 注入请求头和处理同源访问。
- 已支持 Bilibili、Huya、Douyu、Douyin、Twitch 的浏览与播放；搜索、翻页、Cookie 和弹幕能力以现有实现为准，不伪造平台不可靠的能力。抖音支持推荐/分类分页、首屏 SSR 回退、房间/播放、登录 Cookie 搜索和本地签名实时弹幕，但不提供弹幕发送；Twitch 使用 HLS 和匿名 IRC 弹幕，公开浏览接口可靠支持首屏。
- 弹幕支持列表、Canvas、SC 叠加层及透明度、字号、速度、区域、行数、过滤和屏蔽设置。本地字幕使用 Web Audio、16 kHz PCM IPC 与 Rust sherpa-onnx Zipformer 会话，模型和音频保持本地。
- `/iptv` 是频道发现页，`/iptv/play` 是独立播放页；进入发现页不得自动创建播放器或播放频道。

## UI 与文档

- UI 以中文为主，保持 Simple Live 风格及桌面/移动响应式布局。
- 用户文档入口为 `README.md`、`docs/README.md`，详细中文文档位于 `docs/zh/`。功能、配置、运行方式或架构变化时同步更新相关文档。
