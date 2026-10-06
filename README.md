<p align="center">
  <img src="public/rlive.svg" width="112" height="112" alt="rLive 图标">
</p>

<h1 align="center">rLive</h1>

<p align="center">
  一个客户端，连接多平台直播、视频与弹幕。<br>
  支持桌面录制、IPTV 与设备端语音字幕。
</p>

<p align="center">
  <a href="https://github.com/Kenny3Shen/rLive/releases">下载安装</a> ·
  <a href="docs/zh/用户指南.md">使用指南</a> ·
  <a href="docs/zh/开发指南.md">开发指南</a> ·
  <a href="docs/README.md">文档中心</a> ·
  <a href="https://github.com/Kenny3Shen/rLive/issues">问题反馈</a>
</p>

<p align="center">
  <a href="https://github.com/Kenny3Shen/rLive/actions/workflows/ci.yml"><img src="https://github.com/Kenny3Shen/rLive/actions/workflows/ci.yml/badge.svg?branch=master" alt="持续集成状态"></a>
  <img src="https://img.shields.io/badge/Tauri-2-24C8DB?style=flat-square&logo=tauri&logoColor=white" alt="Tauri 2">
  <img src="https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=111827" alt="React 19">
  <img src="https://img.shields.io/badge/Rust-backend-000000?style=flat-square&logo=rust&logoColor=white" alt="Rust 后端">
</p>

rLive 是基于 Tauri 2、React 与 Rust 的跨平台直播客户端，整合 **哔哩哔哩、虎牙、斗鱼、抖音和 Twitch**，并提供 B 站视频、短视频和 IPTV 入口。关注、观看历史与播放偏好统一管理，日常观看无需在多个客户端之间切换。

**快速导航：** [功能亮点](#功能亮点) · [下载与安装](#下载与安装) · [快速上手](#快速上手) · [平台能力](#平台能力) · [源码运行](#从源码运行) · [技术概览](#技术概览) · [文档](#文档) · [数据与使用边界](#数据与使用边界)

## 功能亮点

### 直播、视频，一站观看

- **多平台直播**：浏览推荐、分类与搜索，管理关注和观看历史，切换清晰度与线路。
- **B 站视频**：推荐、热门、番剧、影视与筛选搜索；支持分集连播、断点续播、字幕、弹幕、评论及评论时间戳跳转。
- **沉浸式短视频**：B 站 story 与抖音推荐流，支持滑动换片、点按暂停、长按倍速和进度拖动；抖音需登录 Cookie。
- **IPTV 与投屏**：浏览公开频道或添加自有 M3U，检测可用性、收藏分组；支持向同一局域网的 DLNA 设备投屏，播放兼容性取决于接收设备。

### 弹幕、录制与本地字幕

- **实时弹幕**：列表与画面弹幕、B 站醒目留言（SC），支持屏蔽、礼物过滤与重复合并；部分平台可授权发送。
- **桌面多画面**：2 / 4 / 6 路布局，支持拖拽换位、独立音量与直播时钟同步。
- **桌面录制与回放**：支持后台录制、按主播自动录制、按时长分割、崩溃恢复与 ASS 弹幕导出；仅重新封装，不转码，默认并发 4 路、最多 6 路。
- **设备端语音字幕**：直播与 B 站视频可通过 sherpa-onnx 实时识别音频，无需上传音频；Windows 支持 CPU / CUDA，Linux 与 macOS 使用 CPU。

## 下载与安装

前往 **[GitHub Releases](https://github.com/Kenny3Shen/rLive/releases)** 选择对应系统的安装包。实际产物、版本变化与已知问题以 Release 说明为准。

| 客户端 | 安装包 | 能力与状态 |
| --- | --- | --- |
| Windows x64 | `.exe` / `.msi` | 支持多画面、录制与本地字幕；本地 release 构建已验证 |
| Linux x86_64 | `.deb` / `.rpm` / `.AppImage` | 支持多画面、录制与 CPU 字幕；本地 release 构建已验证 |
| macOS arm64 / x64 | `.dmg` | 已配置构建与 FFmpeg 打包；桌面功能仍缺少真机验证 |
| Android arm64-v8a | `.apk` | Android 7.0（API 24）及以上；不支持多画面、本地语音字幕与录制 |

> [!IMPORTANT]
> Windows 安装包未做 Authenticode 签名，可能触发 SmartScreen 提示；macOS 未做 Apple 签名与公证，首次启动可能需要在「系统设置 → 隐私与安全性」允许打开。安装与数据目录说明见[用户指南](docs/zh/用户指南.md)。

首次启用本地语音字幕需下载模型；Windows 还需下载 ASR 运行库。CUDA 依赖与配置见[本地语音字幕](docs/zh/本地语音字幕.md)。

## 快速上手

1. **选择内容**：首页切换直播平台，从推荐、分类或搜索进入房间；「视频」浏览 B 站视频，「短视频」选择 B 站或抖音，「IPTV」浏览频道。
2. **调整播放**：在播放器中切换清晰度、线路、字幕与弹幕；直播间右侧栏可管理关注和显示设置。
3. **按需登录**：需要账号能力时，前往「设置 → 账号」扫码登录或保存 Cookie。弹幕发送需单独启用并授权。
4. **开始录制**：桌面端从直播间标题栏开始录制，或在关注页右键主播开启后台录制；完成后在「录制」页管理与回放。

更多操作：[播放列表](docs/zh/播放列表使用指南.md) · [录制与回放](docs/zh/录制与回放.md) · [IPTV 与投屏](docs/zh/IPTV与投屏.md) · [本地语音字幕](docs/zh/本地语音字幕.md)

## 平台能力

以下为**直播能力**；B 站视频与短视频的登录条件、交互及限制见[用户指南](docs/zh/用户指南.md)。

| 直播平台 | 浏览与搜索 | 播放 | 实时弹幕 |
| --- | --- | --- | --- |
| 哔哩哔哩 | 推荐、分类、搜索，含未开播主播 | 支持 | 接收；登录并授权后可发送 |
| 虎牙 | 列表、房间、搜索，含未开播主播 | 支持 | 接收；登录并授权后可发送 |
| 斗鱼 | 列表、房间、搜索，含未开播主播 | 支持 | 接收；登录并授权后可发送 |
| 抖音 | 推荐、分类；搜索需登录 Cookie，仅返回在播房间 | 支持 | 仅接收 |
| Twitch | 直播、两级分类、搜索，含未开播频道 | HLS | 匿名 IRC 接收，不支持发送 |

- **弹幕发送默认关闭**：仅哔哩哔哩、虎牙、斗鱼提供直播弹幕发送入口，且只把平台真实回显视为发送成功。
- **Twitch 浏览存在边界**：公开接口仅保证首屏；已有语言分片等分页策略不代表完整目录或稳定深分页，详见 [Twitch 接入说明](docs/zh/Twitch平台API文档.md)。
- **上游能力可能变化**：接口、登录验证、地区策略与内容权限均由平台决定；遇到限制时，以官方客户端和网页的实际状态为准。

## 从源码运行

先准备 **Rust、Bun 与 [Tauri 2 前置环境](https://v2.tauri.app/start/prerequisites/)**。桌面构建还需要 clang / libclang 和 FFmpeg 开发库、链接库及运行库；Windows 侧脚本使用 **PowerShell 7（`pwsh`）**。具体安装与环境变量见[开发指南](docs/zh/开发指南.md)。

```bash
git clone https://github.com/Kenny3Shen/rLive.git
cd rLive
bun install
bun run tauri dev
```

`bun run dev` 只启动前端页面；直播请求、本机代理、数据库和字幕依赖 Rust 后端，完整功能必须通过 Tauri 启动。

常用检查：

```bash
bun run check    # 前端 lint 与 TypeScript 类型检查
bun test tests/  # 前端单元测试
bun run build    # 前端生产构建
```

桌面打包、FFmpeg 配置与实机调试见[开发指南](docs/zh/开发指南.md)；Android 环境与 APK 构建见 [Android 开发与构建](docs/zh/Android开发-Windows.md)。

## 技术概览

- **前端**：React 19、TypeScript、Vite、Tailwind CSS；TanStack Query 管理服务端 / IPC 缓存，Zustand 管理设置与轻量状态。
- **后端**：Tauri 2 + Rust，统一平台接口、媒体代理、弹幕协议、SQLite 存储、录制与语音识别。
- **播放**：Video.js、mpegts.js 与原生 `<video>` 按媒体能力适配，请求头与同源访问统一由 Rust `stream_proxy` 处理。

<details>
<summary>查看系统架构与核心数据流</summary>

<p align="center">
  <img src="docs/assets/architecture.svg" width="100%" alt="rLive 架构图：React 界面通过 Tauri 调用 Rust 后端，由媒体代理连接平台播放源，弹幕、录制、本地字幕与 SQLite 提供配套能力">
</p>

- **播放**：平台媒体 CDN → `stream_proxy` → 本机地址 → 播放器；代理处理 HLS 清单改写与 B 站 DASH 音视频轨回环，IPTV 复用同一路径。
- **录制**：平台 CDN → 进程内 FFmpeg → 本地录制目录，只重新封装，不依赖前端播放。
- **弹幕**：Rust 协议适配器解析并批处理，通过 Tauri Events 推送至界面；录制任务复用消息写入弹幕轨。
- **字幕**：播放器音频 → Web Audio 16 kHz PCM → 本机 sherpa-onnx；B 站 CC 字幕则经 Rust 获取并转为 WebVTT。
- **存储**：设置、账号、关注与历史等保存在 `rlive.db`；录制媒体、`metadata.json` 与 `danmaku.jsonl` 存放在独立录制目录。

模块职责、会话生命周期与完整数据流见[架构说明](docs/zh/架构说明.md)。

</details>

## 文档

| 你想做什么 | 阅读入口 |
| --- | --- |
| 安装使用、了解功能与常见问题 | [用户指南](docs/zh/用户指南.md) |
| 从源码运行、检查与构建 | [开发指南](docs/zh/开发指南.md) |
| 理解模块分层与核心数据流 | [架构说明](docs/zh/架构说明.md) |
| 查找播放器、平台接入与专题说明 | [文档中心](docs/README.md) |
| 准备版本发布与核验安装包 | [发布流程](docs/zh/发布流程.md) |

反馈问题请提交 [GitHub Issue](https://github.com/Kenny3Shen/rLive/issues)，附上应用版本、系统、涉及的平台与复现步骤；日志和截图请先移除 Cookie、令牌及私有媒体地址。

## 数据与使用边界

### 数据留存与网络请求

- **本地保存**：关注、历史、Cookie、录制与 ASR 模型默认保存在设备上；语音识别在本机完成，音频不上传至识别服务。数据库含账号凭据，请勿分享原始 `rlive.db`。
- **可选翻译**：字幕翻译默认关闭，开启后仅将已定稿字幕文本发送给 Google 翻译。
- **导出与同步**：Cookie、弹幕发送授权、ASR 本机配置及私有 M3U 地址不进入配置导出包或局域网同步。
- **平台访问**：浏览、播放与登录仍需联网，Cookie 等凭据用于相应平台鉴权；本地存储不代表在线内容可以离线观看。

### 内容与支持范围

rLive 不提供、托管或销售直播内容，也不绕过平台付费、授权或访问控制。请遵守所在地法律与平台服务条款，仅配置、播放和录制你有权使用的媒体内容。

**不在支持范围内**：电视端客户端、iOS、点播下载、平台内容离线下载、礼物与支付、批量发送及自动回复。桌面录制是本地功能，不等同于平台内容下载服务；DLNA 投屏也不代表提供电视端应用。
