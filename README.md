# rLive

**rLive** 是一款桌面端直播聚合客户端，基于 **Tauri 2 + React + TypeScript + Rust**。  
灵感来自 [Simple Live](https://github.com/June6699/dart_simple_live) / [xiaoyaocz/dart_simple_live](https://github.com/xiaoyaocz/dart_simple_live)，为独立重写，**非**官方客户端。

> 简简单单的看直播。

**English:** rLive is a desktop live-stream aggregator (Tauri 2 + React + Rust), inspired by Simple Live — an independent rewrite, not an official client. *Watch live streams simply.*

---

## 功能现状 / Feature status

| 功能 Feature | 状态 Status |
|--------------|-------------|
| 桌面壳 (Linux / Windows) | 完成 Done |
| 深色 UI + shadcn/ui（中文主界面） | 完成 Done |
| **哔哩哔哩** 分类 / 推荐 / 搜索 / 播放 / 弹幕 | 完成 Done |
| **虎牙** 列表 / 房间 / 播放 / 弹幕 | 完成 Done |
| **斗鱼** 列表 / 房间 / 播放 / 弹幕 | 完成 Done |
| **抖音** 分类 / 推荐首屏 / 房间 / 播放 | 完成 Done（SSR 列表仅可靠支持首屏；搜索需完整登录 Cookie） |
| **抖音** 实时弹幕 | 暂不支持 Not yet supported |
| **快手** | 占位 Stub |
| Web 播放（mpegts.js + 本地 `stream_proxy`） | 完成 Done |
| 右侧消息列表 + 飘屏 Canvas 弹幕 | 完成 Done |
| 房间内弹幕设置（区域 / 行数 / 透明度 / 字号 / 字重 / 速度 / 重复过滤 / 屏蔽词） | 完成 Done |
| 醒目留言 SC 面板（哔哩哔哩） | 完成 Done（金额、时长、卡片色） |
| 关注 / 标签 / 开播刷新 / 房间内直接切换 | 完成 Done |
| 观看历史 | 完成 Done |
| 设置：主题、代理、Cookie、清晰度偏好、配置导入导出 | 完成 Done |

**不在当前范围：** 电视端、多开房间、录制/下载、发送弹幕或礼物、官方登录写流程。

---

## 文档索引 / Documentation

| 文档 | 说明 |
|------|------|
| [docs/README.md](docs/README.md) | 文档目录（中 / 英） |
| [docs/zh/用户指南.md](docs/zh/用户指南.md) | 中文用户指南（优先） |
| [docs/zh/架构说明.md](docs/zh/架构说明.md) | 中文架构说明 |
| [docs/en/user-guide.md](docs/en/user-guide.md) | English user guide |
| [docs/en/architecture.md](docs/en/architecture.md) | English architecture |

界面文案以**中文**为主；代码注释与提交说明可用中英。

---

## 环境要求 / Requirements

- [Rust](https://www.rust-lang.org/) stable  
- [bun](https://bun.sh/)  
- [Tauri 2 平台依赖](https://v2.tauri.app/start/prerequisites/)  

**无需 mpv**：当前播放路径为 **Web MSE**（`mpegts.js` + Rust 本地代理），不依赖外置播放器。

### Windows 推荐目录

| 组件 | 路径 |
|------|------|
| 项目镜像 | `D:\dev\rLive` |
| Rust | `D:\dev\rust\{cargo,rustup}` |
| VS Build Tools | `D:\VS\BuildTools` |
| 临时目录 | `D:\Temp\build` |

---

## 开发 / Develop

```bash
bun install
bun run tauri dev
```

仅前端：

```bash
bun run dev
```

构建与测试：

```bash
bun run build
bun run test:unit
cd src-tauri && cargo test --lib
bun run tauri build
```

### Windows 交付（WSL → `D:\dev\rLive`）

日常在 WSL 开发，在 Windows 上出可执行文件：

```bash
# WSL 仓库根目录：同步 + 构建
./scripts/build-windows-from-wsl.sh
```

成功产物：

```text
D:\dev\rLive\src-tauri\target\release\rlive.exe
```

规则见 `AGENTS.md`、`.grok/rules/windows-delivery.md`。

---

## 快速使用 / Quick start

1. 启动应用，顶部切换站点（哔哩哔哩 / 虎牙 / 斗鱼 / 抖音…）。
2. 从首页推荐、分类或搜索进入直播间。
3. **哔哩哔哩弹幕**：设置 → 粘贴 Cookie → 进入房间后右侧列表与飘屏生效。
4. **弹幕设置**：进入房间后，在右侧「弹幕设置」标签调整显示区域、行数、不透明度、字号、字重、速度、重复过滤和屏蔽词；拖动滑块即时预览。
5. **SC / 关注**：右侧「SC」查看哔哩哔哩醒目留言；「关注」可直接切换到任一已关注房间，无需先退出当前房间。
6. **抖音**：可匿名浏览首屏分类/推荐并播放；若要搜索，请在设置中保存完整网页 Cookie。

English: switch site in the header, open a room, paste a Bilibili cookie for danmaku, then tune live danmaku under the room-side **弹幕设置** tab. The **SC** and **关注** tabs show Super Chats and let you switch directly to a followed room. Douyin supports first-page browse and playback; search needs a logged-in browser cookie.

---

## 架构一览 / Architecture (short)

| 层 | 技术 |
|----|------|
| UI | React + Tailwind v4 + shadcn/ui，中文主界面 |
| 业务壳 | 首页 / 关注 / 分类 / 历史 / 设置 / 房间页 |
| 播放 | 前端 `mpegts.js`；Rust `stream_proxy` 同源代理拉流 |
| 站点 | Rust `LiveSite`：bilibili / huya / douyu / douyin（ready）；kuaishou（stub） |
| 弹幕 | Rust WebSocket → Tauri 事件 `danmaku` → 批处理列表 + 按需 Canvas + SC / 设置 / 关注侧栏 |
| 存储 | SQLite：关注、历史、设置、本机 Cookie |

详见 [docs/zh/架构说明.md](docs/zh/架构说明.md) / [docs/en/architecture.md](docs/en/architecture.md)。

---

## 合规 / Compliance

只读聚合：列表、播放地址、接收弹幕；可选用户粘贴 Cookie。  
**不做**官方登录写操作、支付、送礼、发弹幕、录制。  

仅供学习与个人使用；请遵守各平台服务条款与当地法律。

## License

见仓库 `LICENSE`（若有）。Simple Live 仅作学习参考，不代表其资源许可可直接复用。
