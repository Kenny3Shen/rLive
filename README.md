<p align="center">
  <img src="public/rlive.svg" width="112" height="112" alt="rLive Logo">
</p>

<h1 align="center">rLive</h1>

<p align="center">
  一个客户端，看遍哔哩哔哩、虎牙、斗鱼、抖音与 Twitch 直播。
</p>

<p align="center">
  <a href="docs/zh/用户指南.md">使用指南</a> ·
  <a href="docs/README.md">项目文档</a> ·
  <a href="https://github.com/Kenny3Shen/rLive/issues">问题反馈</a>
</p>

<p align="center">
  <a href="https://github.com/Kenny3Shen/rLive/actions/workflows/ci.yml"><img src="https://github.com/Kenny3Shen/rLive/actions/workflows/ci.yml/badge.svg?branch=master" alt="CI"></a>
  <img src="https://img.shields.io/badge/Tauri-2-24C8DB?style=flat-square&logo=tauri&logoColor=white" alt="Tauri 2">
  <img src="https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=111827" alt="React 19">
  <img src="https://img.shields.io/badge/Rust-backend-000000?style=flat-square&logo=rust&logoColor=white" alt="Rust backend">
</p>

rLive 是面向桌面端与 Android 的跨平台直播客户端。它把不同平台的直播发现、播放、弹幕、关注和观看记录放进同一套界面，并提供桌面多画面、本地实时字幕、直播流录制、IPTV 与局域网配置同步等能力。

> [!IMPORTANT]
> 项目仍在持续开发。正式版本可从 [GitHub Releases](https://github.com/Kenny3Shen/rLive/releases) 下载；直播能力依赖各平台公开接口，可能随平台策略或地区限制发生变化。

## 为什么使用 rLive

| 场景       | 能力               | 你可以做什么                                                                             |
| ---------- | ------------------ | ---------------------------------------------------------------------------------------- |
| 多平台聚合 | 统一浏览与搜索     | 在一个客户端切换哔哩哔哩、虎牙、斗鱼、抖音和 Twitch，不必反复打开网页                    |
| 专注观看   | 统一播放器         | 按房间记忆线路，自动处理播放故障与换线，并提供清晰度、音量、全屏、画中画和仅播声音等控制 |
| 实时互动   | 列表与画面弹幕     | 同时查看弹幕列表和画面飘屏，过滤礼物信息、屏蔽关键词、合并重复内容，并显示 B 站 SC       |
| 桌面效率   | 4 / 6 路多画面     | 4 路可选左主右副或 2×2 均分，支持拖拽移动/交换画面并独立控制每路音量                      |
| 本地字幕   | 中英实时语音识别   | 通过 sherpa-onnx 在设备本地生成字幕，支持标点、热词、匿名说话人区分和可选双语翻译        |
| 自有内容   | IPTV 与直链播放    | 浏览公开频道、接入自有 M3U 源或播放有权使用的媒体直链，并管理频道关注与分组              |
| 桌面录制   | 直播流与弹幕轨实时保存 | 从直播间或 IPTV 标题栏开始录制，直播可选同步弹幕轨，支持自定义本地目录并在“录制”库随时回放 |

## 直播平台

| 直播平台 | 浏览与搜索                          | 播放        | 实时弹幕                  |
| -------- | ----------------------------------- | ----------- | ------------------------- |
| 哔哩哔哩 | 推荐、分类、搜索                    | 支持        | 接收；登录并授权后可发送  |
| 虎牙     | 列表、房间、搜索                    | 支持        | 接收；登录并授权后可发送  |
| 斗鱼     | 列表、房间、搜索                    | 支持        | 接收；登录并授权后可发送  |
| 抖音     | 推荐、分类分页；搜索需要登录 Cookie | 支持        | 接收，不支持发送          |
| Twitch   | 直播、分类、搜索分页                | 支持（HLS） | 匿名 IRC 接收，不支持发送 |

弹幕发送默认关闭，仅支持哔哩哔哩、虎牙和斗鱼。启用前需要在本机完成登录并明确授权；详细条件见[用户指南的弹幕章节](docs/zh/用户指南.md#5-弹幕)。

## 核心体验

### 一处管理所有直播

- 在首页、分类和搜索之间浏览多个直播平台。
- 用自定义分组整理直播关注与 IPTV 频道关注。
- 通过统一时间线查找观看历史和已发送弹幕。
- 在直播间侧栏直接切换已关注主播，不必退回列表。

### 为直播设计的播放器

- 统一播放 HLS、MPEG-TS 与 FLV，并通过本机 `stream_proxy` 注入必要请求头。
- 记住每个房间的清晰度和线路选择；播放失败时自动重试或切换可用来源。
- 桌面端支持键盘操作、画中画、仅播声音，以及可选 4 / 6 路布局的多画面。
- 移动端支持画面左侧调亮度、右侧调音量，适配 Android 系统媒体音量与全屏方向。

### 弹幕不只是一条列表

- 弹幕列表与画面飘屏可独立控制；B 站醒目留言开关位于「消息过滤」。
- 可调整普通飘屏的显示区域、不透明度、字号和字重；实时画面使用两个全尺寸 danmu.js 弹幕层，显示区域只限制滚动弹幕，B 站 SC 与自己发送的弹幕固定在整个播放器底部。SC 与普通飘屏共用不透明度，普通飘屏统一使用 15 秒穿屏时长。
- 支持屏蔽词、礼物信息过滤和相同内容合并，降低高流量房间的阅读压力。
- 哔哩哔哩、虎牙和斗鱼支持手动单条发送及当前房间会话内的自动发送；两项能力共用严格的本机授权、Cookie 和冷却校验。

### 字幕和数据留在设备上

- 桌面端使用 streaming Zipformer 在本地识别中英文直播音频。
- VAD、自动标点、本地热词和匿名说话人区分均可独立配置。
- 关注、历史、设置和 Cookie 使用本机 SQLite 或设备存储保存。
- 配置可导入导出，也可通过 5 分钟有效的一次性会话在同一局域网内合并同步。

### 把正在看的直播留下来

- 桌面端直播间和 IPTV 播放页的顶部标题栏提供实时录制入口，最多同时录制 4 路；开始前可选择是否保存可开关的同步弹幕轨，并可按次开启「离开页面后继续录制」。
- 后台继续默认关闭；录制中离开播放器时会询问留在页面、继续录制并离开，或停止保存后离开。选择继续后任务由 Rust 后台持有，录制库可查看增长中的时长与体积。
- FLV、MPEG-TS、原生媒体直接保存；HLS 保存为包含清单、分片、密钥和初始化片段的本地回放包，不依赖外部 `ffmpeg`。
- 录制库可选择新的本地保存目录或恢复默认目录；切换后只影响新任务，历史目录仍会被读取。媒体、目录设置与弹幕轨都不会上传或进入配置同步。

> [!NOTE]
> 语音识别始终在本机完成。字幕翻译默认关闭；开启后，已定稿的字幕文本会发送至 Google 翻译。Cookie、弹幕发送授权、ASR 本机配置和私有 M3U 地址不会进入配置包或局域网同步。

## 客户端支持

| 客户端            | 直播与 IPTV | 多画面 | 本地语音字幕          | 说明                                                                |
| ----------------- | ----------- | ------ | --------------------- | ------------------------------------------------------------------- |
| Windows           | 支持        | 支持   | CPU / CUDA           | 提供 NSIS / MSI 安装包和便携 ZIP                                    |
| Linux（x86_64）   | 支持        | 支持   | CPU / CUDA（待测试） | 提供`.deb` 安装包和便携 ZIP                                       |
| macOS （待测试）  | 支持        | 支持   | CPU                   | 提供 Apple Silicon 和 Intel DMG；未做签名与公证，首次打开需手动允许 |
| Android arm64-v8a | 支持        | 不支持 | 不支持                | 提供 arm64-v8a APK （Android API 24及以上）                         |

电视端、iOS、下载、礼物与支付、批量发送及自动回复不在当前支持范围内；录制仅在桌面端提供。

Windows 安装包与便携 ZIP 都不内置约 `212 MiB` 的 ASR Runtime。首次启用本地字幕时会连同所选模型下载运行库并校验完整性。

## 从源码运行

### 环境要求

- [Rust](https://www.rust-lang.org/tools/install)
- [Bun](https://bun.sh/)
- [Tauri 2](https://v2.tauri.app/start/prerequisites/)

### 启动客户端

```bash
git clone https://github.com/Kenny3Shen/rLive.git
cd rLive
bun install
bun run tauri dev
```

- 仅调试 React 界面时可以运行 `bun run dev`
- 直播请求、本机代理、数据库和字幕等能力依赖 Tauri IPC，完整功能请使用 `bun run tauri dev`

### 构建与检查

```bash
bun run check
bun test tests/
bun run build
bun run tauri build
```

Windows 推荐在 WSL 中维护源码。首次使用前复制 `scripts/windows-sync.conf.example` 为 `scripts/windows-sync.conf`，在 `WINDOWS_SYNC_PATH` 中填写 Windows 项目目录，然后运行 `./scripts/build-windows-from-wsl.sh` 同步并构建。Android SDK、NDK、真机运行和签名配置见 [Android 开发文档](docs/zh/Android开发-Windows.md)。

Linux x86_64 构建默认包含 CUDA-capable 的 sherpa-onnx shared runtime。使用 CUDA 字幕需要兼容的 NVIDIA 驱动、CUDA 11.x 和 x86-64 cuDNN 8.x；运行时检测不到 GPU 或依赖时会自动回退 CPU。Linux CUDA 路径尚未完成完整硬件和发行版测试，发布前请在目标发行版和 NVIDIA / 非 NVIDIA 设备上自行验证。构建 CPU-only 版本可设置 `SHERPA_ONNX_GPU=0`。

## 第一次使用

1. 从顶部切换直播平台，在推荐、分类或搜索中找到直播间。
2. 进入房间后直接播放；在控制栏中选择清晰度和线路，右栏管理弹幕、关注与显示设置。
3. 需要平台登录能力时，前往“设置 → 账号”，使用扫码登录或手动保存 Cookie。
4. 从侧栏进入“关注”“历史”“录制”“多画面”或“IPTV”，继续管理自己的观看空间。

更完整的播放器操作、弹幕设置、账号要求、IPTV、自定义直链、局域网同步和常见问题，请阅读[用户指南](docs/zh/用户指南.md)。

## 文档

| 文档                                       | 内容                                                   |
| ------------------------------------------ | ------------------------------------------------------ |
| [用户指南](docs/zh/用户指南.md)             | 安装、观看、录制、弹幕、关注、历史、IPTV、同步与常见问题 |
| [本地语音字幕](docs/zh/本地语音字幕.md)     | 模型下载、识别设置、说话人区分、翻译与 CPU / CUDA 要求 |
| [播放器技术文档](docs/zh/播放器技术文档.md) | 播放协议、智能选线、代理、遥测与移动端控制             |
| [架构说明](docs/zh/架构说明.md)             | 前后端分层、核心数据流、存储与平台模块                 |
| [平台接入文档](docs/README.md)              | 各直播平台 API、弹幕协议及其他开发文档索引             |
| [发布流程](docs/zh/发布流程.md)             | 版本、Android 签名产物与 GitHub draft Release 流程     |

## 技术栈

```text
React 19 + TypeScript + Vite 8 + Tailwind CSS 4
                         │
                         Tauri 2 IPC
                         │
       Rust sites / danmu_rs / stream proxy / SQLite
                         │
       xgplayer + HLS / MPEG-TS / FLV + sherpa-onnx
```

- `src/`：React 前端、页面、播放器、录制、弹幕与跨功能共享代码。
- `src-tauri/`：Tauri / Rust 命令、站点接入、弹幕连接、流代理、数据库和本地 ASR。
- `tests/`：前端单元测试。
- `docs/`：用户指南、架构说明和平台接入文档。

## 使用边界

rLive 不提供、托管或销售任何直播内容，也不绕过平台的付费、授权或访问控制。请遵守所在地法律、直播平台服务条款，并只为 IPTV、直链播放和本地录制配置你有权使用的媒体地址。

第三方平台可能调整接口、登录验证和地区策略。当匿名浏览、搜索、播放或弹幕能力受限时，应以平台官方客户端和网页的实际状态为准。
