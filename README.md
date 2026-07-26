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
| 亮 / 暗 UI + shadcn/ui（侧栏单一按钮轮换；中文主界面） | 完成 Done |
| **哔哩哔哩** 分类 / 推荐 / 搜索 / 播放 / 弹幕 | 完成 Done；正式支持单条普通弹幕发送（需本机授权与 Cookie） |
| **虎牙** 列表 / 房间 / 播放 / 弹幕 | 完成 Done |
| **斗鱼** 列表 / 房间 / 播放 / 弹幕 | 完成 Done |
| **抖音** 分类 / 推荐首屏 / 房间 / 播放 | 完成 Done（SSR 列表仅可靠支持首屏；搜索需完整登录 Cookie） |
| **抖音** 实时弹幕 | 完成 Done（需用户配置签名服务；支持聊天 / 礼物 / 点赞 / 进场等常用事件） |
| **快手** 分类 / 推荐 / 游戏分区搜索 / 房间 / 播放 | 完成 Done（搜索仅匹配游戏分区；实时弹幕暂不支持） |
| Web 播放（mpegts.js + 本地 `stream_proxy`；底部透明控制条自动隐藏） | 完成 Done |
| 房间右栏（主播信息 + 弹幕 / SC / 关注 / 设置）+ 飘屏 Canvas 弹幕 | 完成 Done |
| 房间内弹幕设置（区域 / 行数 / 透明度 / 字号 / 字重 / 速度 / 重复 / 礼物过滤 / 屏蔽词） | 完成 Done |
| 醒目留言 SC 面板（哔哩哔哩） | 完成 Done（紧凑卡片、金额/时长、金额档位昵称标签色） |
| 关注 / 标签 / 开播刷新 / 房间内直接切换 | 完成 Done |
| 观看历史 | 完成 Done |
| 设置：侧栏亮 / 暗模式切换、代理、Cookie、抖音签名服务、清晰度偏好、配置导入导出 | 完成 Done |

**不在当前范围：** 电视端、多开房间、录制/下载、礼物/支付、批量/定时/自动发送、官方登录写流程。

---

## 文档索引 / Documentation

| 文档 | 说明 |
|------|------|
| [docs/README.md](docs/README.md) | 文档目录（中 / 英） |
| [docs/zh/用户指南.md](docs/zh/用户指南.md) | 中文用户指南（优先） |
| [docs/zh/架构说明.md](docs/zh/架构说明.md) | 中文架构说明 |
| [docs/zh/B站发送弹幕调研.md](docs/zh/B站发送弹幕调研.md) | B 站发送弹幕可行性与安全前置 |
| [docs/zh/播放器性能调研.md](docs/zh/播放器性能调研.md) | mpegts.js / Rust 播放性能路线 |
| [docs/en/user-guide.md](docs/en/user-guide.md) | English user guide |
| [docs/en/architecture.md](docs/en/architecture.md) | English architecture |
| [docs/en/bilibili-danmaku-send-research.md](docs/en/bilibili-danmaku-send-research.md) | Bilibili send-chat research |
| [docs/en/player-performance-research.md](docs/en/player-performance-research.md) | Player performance research |

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

1. 首次启动默认打开哔哩哔哩；可在顶部切换站点（哔哩哔哩 / 斗鱼 / 虎牙 / 抖音 / 快手）。
2. 从首页推荐、分类或搜索进入直播间；房间顶栏左侧的返回图标会回到来源页面，直接打开房间链接时则回到首页。
3. **哔哩哔哩弹幕**：设置 → 账号 → 粘贴 Cookie → 进入房间后右侧列表与飘屏生效。普通聊天支持按原顺序显示平台图片表情，只加载校验过的 B 站 CDN 图片；意外断线会轮换网关、刷新短时 token 后自动重连。若需发送，显式开启「B 站发送弹幕」，并保存含 `SESSDATA` / `bili_jct` 的 Cookie；发送框位于播放器功能栏中间，点击发送或按 Enter 会直接提交。
4. **弹幕设置**：右侧标签依次为「弹幕 / SC / 关注 / 设置」；在「设置」中调整显示区域、行数、不透明度、字号、字重、速度、相同内容合并、礼物过滤和屏蔽词。滑块与屏蔽词输入都会即时生效，屏蔽词会自动保存。
5. **主播信息 / SC / 关注**：右栏顶部显示主播头像、用户名、所属平台和当前热度；「SC」查看哔哩哔哩醒目留言，使用无整卡边框/着色或左侧竖条的紧凑卡片，不同金额档位通过发送者昵称标签背景色区分；「关注」可直接切换到任一已关注房间，无需先退出当前房间。关注页顶部可按「全部平台」或单个平台筛选；关注状态按钮仅有「全部 / 直播中 / 未开播」，右下角浮动按钮刷新开播状态。
6. **播放器控制**：控制条以透明方式叠放在视频底部，播放期间闲置后自动隐藏，移动、点击或键盘操作可再次显示；打开音量、清晰度或线路选项时会保持显示。焦点位于画面时，`Space` / `K` 播放或暂停，`M` 静音，`F` 全屏。刷新位于暂停左侧；音量按钮展开竖向滑杆；清晰度和线路仅显示当前选择项；右栏、飘屏与全屏均为图标开关。
7. **外观**：侧栏「设置」上方只有一个太阳 / 月亮按钮；每次点击会在亮色与暗色模式之间轮换。
8. **抖音 / 快手**：抖音可匿名浏览首屏分类/推荐并播放；若要搜索，请在设置中保存完整网页 Cookie。要接收抖音弹幕，另需在「设置 → 账号」配置自建/信任的签名服务完整地址（Cookie 仅交给 HTTPS 或本机回环服务）。快手支持公开推荐、分类、游戏分区、房间与播放；搜索只匹配游戏分区名称，实时弹幕暂不支持。

English: switch site in the header, open a room, and paste a Bilibili cookie under **Settings → Account** for danmaku. Normal Bilibili chat preserves validated CDN image emotes inline; an unexpected disconnect rotates gateways, refreshes the short-lived token, and reconnects. The supported one-message sender remains off until explicitly enabled on this device, needs `SESSDATA` + `bili_jct`, appears in the centre of the player control bar, and submits directly on Enter or click. The room-side tabs are **Danmaku / SC / Follows / Settings**; danmaku settings apply live, shield words auto-save, and gift notices can be hidden. The sidebar header shows the host avatar, name, platform, and current heat. **SC** uses a compact neutral card without a full-card border, colour treatment, or left stripe; its sender-label background indicates the amount tier. **Follows** switches directly to a followed room. The Follows page exposes only **All / Live / Offline** status filters. A single sun / moon button above **Settings** alternates between light and dark mode. The transparent bottom player controls hide after playback is idle and reappear on pointer, click, or keyboard activity; quality and line selectors show only the active choice. Search supports user, room-ID, and title fields; category results open on their own page. Douyin supports first-page browse, playback, and signed WebSocket chat; search needs a logged-in browser cookie, while chat additionally needs a user-operated signing endpoint. Kuaishou supports public recommendations, categories, game-category search, rooms, and playback; it has no real-time danmaku yet.

---

## 架构一览 / Architecture (short)

| 层 | 技术 |
|----|------|
| UI | React + Tailwind v4 + shadcn/ui，中文主界面 |
| 业务壳 | 首页 / 关注 / 分类 / 历史 / 设置 / 房间页 |
| 播放 | 前端 `mpegts.js`；Rust `stream_proxy` 同源代理拉流 |
| 站点 | Rust `LiveSite`：bilibili / huya / douyu / douyin / kuaishou（ready；快手无实时弹幕） |
| 弹幕 | Rust WebSocket → Tauri 事件 `danmaku` → 批处理列表 + 按需 Canvas + SC / 设置 / 关注侧栏 |
| 存储 | SQLite：关注、历史、设置、本机 Cookie |

详见 [docs/zh/架构说明.md](docs/zh/架构说明.md) / [docs/en/architecture.md](docs/en/architecture.md)。

---

## 合规 / Compliance

以列表、播放地址与接收弹幕为主；可选用户粘贴 Cookie。B 站正式支持仅允许用户主动发起的单条普通文本发送。
**不做**官方登录写操作、支付、送礼、批量/自动/定时发送、录制。

仅供学习与个人使用；请遵守各平台服务条款与当地法律。

## License

见仓库 `LICENSE`（若有）。Simple Live 仅作学习参考，不代表其资源许可可直接复用。
