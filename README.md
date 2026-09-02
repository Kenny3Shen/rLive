<p align="center">
  <img src="public/rlive.svg" width="112" height="112" alt="rLive Logo">
</p>

<h1 align="center">rLive</h1>

<p align="center">
  把多平台直播、弹幕、录制与本地字幕放进一个客户端。
</p>

<p align="center">
  <a href="docs/zh/用户指南.md">使用指南</a> ·
  <a href="docs/zh/开发指南.md">开发指南</a> ·
  <a href="docs/README.md">项目文档</a> ·
  <a href="https://github.com/Kenny3Shen/rLive/releases">已发布版本</a> ·
  <a href="https://github.com/Kenny3Shen/rLive/issues">问题反馈</a>
</p>

<p align="center">
  <a href="https://github.com/Kenny3Shen/rLive/actions/workflows/ci.yml"><img src="https://github.com/Kenny3Shen/rLive/actions/workflows/ci.yml/badge.svg?branch=master" alt="CI"></a>
  <img src="https://img.shields.io/badge/Tauri-2-24C8DB?style=flat-square&logo=tauri&logoColor=white" alt="Tauri 2">
  <img src="https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=111827" alt="React 19">
  <img src="https://img.shields.io/badge/Rust-backend-000000?style=flat-square&logo=rust&logoColor=white" alt="Rust backend">
</p>

rLive 是基于 Tauri 的跨平台直播客户端。Rust 后端统一平台接口、播放源、弹幕协议和本机数据能力，React 前端提供一致的浏览、观看与管理体验。

## 功能

| 能力 | 说明 |
| ---- | ---- |
| 五站统一入口 | 哔哩哔哩、虎牙、斗鱼、抖音、Twitch 的浏览、分类与搜索，统一管理关注和观看历史 |
| 直播专用播放器 | 经 Rust 本机代理播放 HLS、FLV、MPEG-TS，记忆清晰度与线路，协议错误和上游 EOF 时有界恢复 |
| 桌面录制 | 并发路数可设（默认 4，最多 6），只重新封装不转码，支持后台录制、按主播自动录制、按时长分割、崩溃恢复和弹幕轨导出 ASS |
| 实时弹幕 | 列表、画面弹幕和 B 站 SC，支持屏蔽、礼物过滤与重复合并 |
| 多画面与 IPTV | 桌面 2 / 4 / 6 路布局、拖拽换位、独立音量、直播时钟同步；IPTV 支持公开频道与自有 M3U |
| 本地字幕 | sherpa-onnx 设备端流式语音识别，模型与音频不出本机 |

## 平台能力

| 直播平台 | 浏览与搜索 | 播放 | 实时弹幕 |
| -------- | ---------- | ---- | -------- |
| 哔哩哔哩 | 推荐、分类、搜索（含未开播主播） | 支持 | 接收；登录并授权后可发送 |
| 虎牙 | 列表、房间、搜索（含未开播主播） | 支持 | 接收；登录并授权后可发送 |
| 斗鱼 | 列表、房间、搜索（含未开播主播） | 支持 | 接收；登录并授权后可发送 |
| 抖音 | 推荐、分类分页；搜索需登录 Cookie，只有在播房间 | 支持 | 接收，不支持发送 |
| Twitch | 直播、两级分类、搜索分页（含未开播频道） | HLS | 匿名 IRC 接收，不支持发送 |

搜索结果里在播房间始终排在未开播之前，未开播的卡片带「未开播」角标且不显示热度。弹幕发送默认关闭，仅哔哩哔哩、虎牙、斗鱼提供入口，且只把平台真实回显视为发送成功。账号条件见[用户指南](docs/zh/用户指南.md)。

## 客户端支持

| 客户端 | 直播与 IPTV | 多画面 | 本地字幕 | 直播录制 | 状态 |
| ------ | ----------- | ------ | -------- | -------- | ---- |
| Windows x64 | 支持 | 支持 | CPU / CUDA | 支持 | 本地 release 构建已验证 |
| Linux x86_64 | 支持 | 支持 | CPU | 支持 | 本地 release 构建已验证 |
| macOS arm64 / x64 | 代码支持 | 代码支持 | CPU | 代码支持 | 未验证：缺真机、FFmpeg 打包、签名与公证 |
| Android arm64-v8a | 支持 | 不支持 | 不支持 | 不支持 | API 24 及以上 |

电视端、iOS、点播下载、平台内容离线下载、礼物与支付、批量发送及自动回复不在支持范围内。桌面录制是本地功能，不等同于平台内容下载服务。

## 快速开始

安装包以 [GitHub Releases](https://github.com/Kenny3Shen/rLive/releases) 为准，使用前请一并阅读对应 Release 说明。

1. 顶部选择直播平台，从推荐、分类或搜索进入房间。
2. 播放器中选择清晰度和线路；右侧栏管理弹幕、关注与显示设置。
3. 需要账号能力时，前往「设置 → 账号」扫码登录或保存 Cookie。
4. 桌面端从直播间标题栏开始录制，或在关注页右键主播开启后台录制。

完整操作、录制格式、IPTV、局域网同步和常见问题见[用户指南](docs/zh/用户指南.md)。

## 从源码运行

```bash
git clone https://github.com/Kenny3Shen/rLive.git
cd rLive
bun install
bun run tauri dev
```

需要 Rust、Bun 和 Tauri 2 前置环境；桌面构建还需要 clang/libclang 与 FFmpeg 开发库。环境要求、检查命令、Windows release 构建、FFmpeg 配置和 Android 调试见[开发指南](docs/zh/开发指南.md)。

## 系统架构

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/architecture-dark.png">
    <img src="docs/assets/architecture-light.png" width="100%" alt="rLive 高层运行时架构：WebView 播放页经 Tauri 命令层与 stream_proxy 回环取流，ASR、录制、IPTV、弹幕与 SQLite 作为旁路能力挂在命令层，站点 API、CDN 与弹幕服务器位于不可信网络">
  </picture>
</p>

- **播放**：平台 CDN → Rust `stream_proxy` → localhost URL → `xgplayer`。代理负责请求头、跨域访问与 HLS 清单改写。
- **录制**：平台 CDN → 进程内 `ffmpeg-next` / libavformat → 本地录制目录。只重新封装，不参与前端播放。
- **弹幕**：Rust 侧协议适配器解析并批处理，经 Tauri Events 推送到列表与画面；录制任务从同一批消息写入 `danmaku.jsonl`。
- **字幕**：播放器音频经 Web Audio 转 16 kHz PCM，由 `asr_transcribe` 送入本机 sherpa-onnx 会话。
- **IPTV**：`iptv_load_playlist` 解析 M3U 并探测可用性，播放仍复用 `stream_proxy` 回环。

设置、账号、关注和历史保存在 `rlive.db`；录制媒体、`metadata.json` 与 `danmaku.jsonl` 位于独立录制目录。矢量图见 [architecture.svg](docs/assets/architecture.svg)，模块职责与生命周期见[架构说明](docs/zh/架构说明.md)。

## 文档

| 文档 | 内容 |
| ---- | ---- |
| [用户指南](docs/zh/用户指南.md) | 安装、观看、弹幕、关注、历史、同步与常见问题 |
| [开发指南](docs/zh/开发指南.md) | 环境、检查、构建、应用图标、FFmpeg 配置与 Android 调试 |
| [架构说明](docs/zh/架构说明.md) | 前后端分层、核心数据流、存储与平台模块 |
| [项目文档索引](docs/README.md) | 播放器、录制、IPTV、字幕、平台接入与发布流程 |

## 数据与使用边界

rLive 不提供、托管或销售任何直播内容，也不绕过平台的付费、授权或访问控制。请遵守所在地法律与平台服务条款，只为 IPTV、直链播放和本地录制配置你有权使用的媒体地址。

关注、历史、Cookie、录制和 ASR 模型默认留在设备上。语音识别始终在本机完成；字幕翻译默认关闭，开启后仅将已定稿字幕文本发送给 Google 翻译。Cookie、弹幕发送授权、ASR 本机配置和私有 M3U 地址不会进入配置导出包或局域网同步。

第三方平台可能随时调整接口、登录验证和地区策略。匿名浏览、搜索、播放或弹幕能力受限时，以平台官方客户端和网页的实际状态为准。
