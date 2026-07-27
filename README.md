# rLive

**rLive** 是一款桌面端直播聚合客户端，基于 **Tauri 2 + React + TypeScript + Rust**。  
灵感来自 [Simple Live](https://github.com/June6699/dart_simple_live) / [xiaoyaocz/dart_simple_live](https://github.com/xiaoyaocz/dart_simple_live)，为独立重写，**非**官方客户端。

> 简简单单地看直播。

英文版请见 [README.en.md](README.en.md)。

---

## 功能现状

| 功能 | 状态 |
|------|------|
| 桌面壳（Linux / Windows） | 已完成 |
| 亮 / 暗色界面与 shadcn/ui（侧栏单一按钮切换；中文主界面） | 已完成 |
| **哔哩哔哩** 分类 / 推荐 / 搜索 / 播放 / 弹幕 | 已完成；支持单条普通弹幕发送（需本机授权与 Cookie） |
| **虎牙** 列表 / 房间 / 播放 / 弹幕 | 已完成；手动保存本机 Cookie 后支持用户每次主动操作发送一条普通文字弹幕 |
| **斗鱼** 列表 / 房间 / 播放 / 弹幕 | 已完成；扫码或手动保存本机 Cookie 后支持用户每次主动操作发送一条普通文字弹幕 |
| **抖音** 分类 / 推荐首屏 / 房间 / 播放 | 已完成；SSR 列表仅可靠支持首屏，搜索需完整登录 Cookie（可扫码或手动保存） |
| **抖音** 实时弹幕 | 已完成；固定使用本机 `127.0.0.1:18080/sign`，支持聊天 / 礼物 / 点赞 / 进场等常用事件 |
| **快手** 分类 / 推荐 / 游戏分区搜索 / 房间 / 播放 | 已完成；搜索仅匹配游戏分区，实时弹幕暂不支持 |
| **Twitch** 直播列表 / 分类 / 搜索 / 房间 / HLS 播放 / 匿名 IRC 弹幕 | 已完成；公开接口仅可靠支持首屏浏览，无翻页 |
| 网页播放（`mpegts.js` + 本地 `stream_proxy`；底部透明控制条自动隐藏） | 已完成 |
| 房间右栏（主播信息 + 弹幕 / SC / 关注 / 设置）与 Canvas 飘屏弹幕 | 已完成 |
| 弹幕选择操作 | 已完成；点击普通弹幕可复制内容，或在支持发送的平台将相同内容作为「+1」单条发送 |
| 房间内弹幕设置（区域 / 行数 / 透明度 / 字号 / 字重 / 速度 / 重复 / 礼物过滤 / 屏蔽词） | 已完成 |
| 醒目留言 SC 面板（哔哩哔哩） | 已完成；展示头像身份区、金额与完整正文 |
| 关注 / 标签 / 开播刷新 / 房间内直接切换 | 已完成 |
| 观看历史 | 已完成 |
| IPTV：频道发现首页 / 独立播放页 / 公开及设备私有 M3U 源 / HLS、MPEG-TS、FLV 播放 | 已完成；请自行确认频道授权与地区可用性 |
| 设置：侧栏亮 / 暗模式切换、代理、Cookie（B 站 / 抖音 / 斗鱼扫码或手动输入；虎牙手动输入）、IPTV M3U、清晰度偏好、配置导入导出 | 已完成 |

**当前不在范围内：** 电视端、多开房间、录制 / 下载、礼物 / 支付、批量 / 定时 / 自动发送。

---

## 文档

| 文档 | 说明 |
|------|------|
| [README.en.md](README.en.md) | English README |
| [docs/README.md](docs/README.md) | 文档目录（中 / 英） |
| [docs/zh/用户指南.md](docs/zh/用户指南.md) | 中文用户指南（优先） |
| [docs/zh/架构说明.md](docs/zh/架构说明.md) | 中文架构说明 |
| [docs/zh/B站平台API文档.md](docs/zh/B站平台API文档.md) | 哔哩哔哩平台接入、播放与弹幕 |
| [docs/zh/斗鱼平台API文档.md](docs/zh/斗鱼平台API文档.md) | 斗鱼平台接入、发送修复与验证 |
| [docs/zh/虎牙平台API文档.md](docs/zh/虎牙平台API文档.md) | 虎牙平台接入、播放与弹幕 |
| [docs/zh/抖音平台API文档.md](docs/zh/抖音平台API文档.md) | 抖音平台接入、本机签名与边界 |
| [docs/zh/快手平台API文档.md](docs/zh/快手平台API文档.md) | 快手平台接入与当前范围 |
| [docs/zh/Twitch平台API文档.md](docs/zh/Twitch平台API文档.md) | Twitch 平台接入、HLS 与 IRC |
| [docs/zh/播放器性能调研.md](docs/zh/播放器性能调研.md) | mpegts.js / Rust 播放性能路线 |
| [docs/en/user-guide.md](docs/en/user-guide.md) | English user guide |
| [docs/en/architecture.md](docs/en/architecture.md) | English architecture |
| [docs/en/bilibili-platform-api.md](docs/en/bilibili-platform-api.md) | Bilibili platform API |
| [docs/en/douyu-platform-api.md](docs/en/douyu-platform-api.md) | Douyu platform API |
| [docs/en/huya-platform-api.md](docs/en/huya-platform-api.md) | Huya platform API |
| [docs/en/douyin-platform-api.md](docs/en/douyin-platform-api.md) | Douyin platform API |
| [docs/en/kuaishou-platform-api.md](docs/en/kuaishou-platform-api.md) | Kuaishou platform API |
| [docs/en/twitch-platform-api.md](docs/en/twitch-platform-api.md) | Twitch platform API |
| [docs/en/player-performance-research.md](docs/en/player-performance-research.md) | Player performance research |

界面文案以**中文**为主；代码注释与提交说明可使用中英文。

---

## 环境要求

- [Rust](https://www.rust-lang.org/) stable
- [bun](https://bun.sh/)
- [Tauri 2 平台依赖](https://v2.tauri.app/start/prerequisites/)

**无需 mpv**：当前播放路径为网页 MSE（`mpegts.js` + Rust 本地代理），不依赖外置播放器。

### Windows 推荐目录

| 组件 | 路径 |
|------|------|
| 项目镜像 | `D:\dev\rLive` |
| Rust | `D:\dev\rust\{cargo,rustup}` |
| VS Build Tools | `D:\VS\BuildTools` |
| 临时目录 | `D:\Temp\build` |

---

## 开发

```bash
bun install
bun run tauri dev
```

仅启动前端：

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

日常在 WSL 开发，在 Windows 上生成可执行文件：

```bash
# 在 WSL 仓库根目录执行：同步 + 构建
./scripts/build-windows-from-wsl.sh
```

成功产物：

```text
D:\dev\rLive\src-tauri\target\release\rlive.exe
```

规则见 [AGENTS.md](AGENTS.md) 与 `.grok/rules/windows-delivery.md`。

---

## 快速使用

1. 首次启动默认打开哔哩哔哩；可在顶部切换站点（哔哩哔哩 / 斗鱼 / 虎牙 / 抖音 / 快手 / Twitch）。
2. 从首页推荐、分类或搜索进入直播间；房间顶栏左侧的返回图标会回到来源页面，直接打开房间链接时则回到首页。
3. **哔哩哔哩弹幕**：设置 → 账号 → 选择「扫码登录」或「手动输入」保存 Cookie → 进入房间后右侧列表与飘屏生效。普通聊天会按原顺序显示平台图片表情，只加载校验过的 B 站 CDN 图片；意外断线会轮换网关、刷新短时 token 后自动重连。若需发送，显式开启「B 站发送弹幕」，并保存含 `SESSDATA` / `bili_jct` 的 Cookie；发送框位于播放器功能栏中间，点击发送或按 Enter 会直接提交。**斗鱼**可扫码或手动保存本机 Cookie，需含 `acf_username`、`acf_stk`、`acf_ltkid` 才会启用单条发送框；**虎牙**当前需手动保存含数字账号 ID（`yyuid` 或 `udb_uid`）及登录凭据（`udb_n` 或 `udb_cred`）的本机 Cookie。后二者均为用户主动操作的本机 Cookie 功能，不代表平台已提供公开写入 API；请只在有权发言的房间验证，并遵守平台条款。
4. **弹幕设置与操作**：右侧标签依次为「弹幕 / SC / 关注 / 设置」；在「设置」中调整显示区域、行数、不透明度、字号、字重、速度、相同内容合并、礼物过滤和屏蔽词。滑块与屏蔽词输入都会即时生效，屏蔽词会自动保存。点击一条普通弹幕可选择图标「复制」或「+1」；复制会写入剪贴板，「+1」会在已配置发送条件的 B 站、斗鱼或虎牙房间发送完全相同的一条文本，不会附加“+1”。
5. **主播信息 / SC / 关注**：右栏顶部显示主播头像、用户名、所属平台和当前热度；「SC」仅展示哔哩哔哩醒目留言，发送者头像与名称位于浅色身份区，金额保持醒目，安全校验的金额档位颜色显示在下方完整正文带中；头像缺失或加载失败时显示名称首字母，其他平台会明确提示尚未接入 SC。「关注」可直接切换到任一已关注房间，无需先退出当前房间。关注页顶部可按「全部平台」或单个平台筛选；关注状态按钮仅有「全部 / 直播中 / 未开播」，右下角浮动按钮刷新开播状态。
6. **播放器控制**：控制条以透明方式叠放在视频底部，播放期间闲置后自动隐藏，移动、点击或键盘操作可再次显示；打开音量、清晰度或线路选项时会保持显示。焦点位于画面时，`Space` / `K` 播放或暂停，`M` 静音，`F` 全屏。刷新位于暂停左侧；音量按钮展开竖向滑杆；清晰度和线路仅显示当前选择项；右栏、飘屏与全屏均为图标开关。
7. **外观**：侧栏「设置」上方只有一个太阳 / 月亮按钮；每次点击会在亮色与暗色模式之间轮换。
8. **抖音 / 快手 / Twitch**：抖音可匿名浏览首屏分类 / 推荐并播放；若要搜索，请在「设置 → 账号」选择扫码登录或保存完整网页 Cookie。抖音弹幕固定调用本机 `http://127.0.0.1:18080/sign`，请在进房前启动兼容的本机签名服务；请求不会使用全局代理或跳转到远程地址。快手支持公开推荐、分类、游戏分区、房间与播放；搜索只匹配游戏分区名称，实时弹幕暂不支持。Twitch 支持直播列表、分类、搜索、房间、HLS 播放与匿名 IRC 弹幕；受公开接口限制，浏览结果仅可靠支持首屏，不提供翻页。
9. **IPTV**：从侧栏进入「IPTV」后首先到达频道发现首页，不会自动打开或播放任何流。可加载 IPTV-org 官方日更的中文、中国大陆、东亚或综合公开频道分表；如需自定义源，请先在「设置 → 网络」保存有权使用的 HTTP(S) M3U 地址，首页只会显示已配置的「自定义源」。频道名 / 分类支持多关键词搜索、热门分类快捷筛选和按需展开列表。点击频道才会进入独立的沉浸式播放页（`/iptv/play`）并走 HLS、MPEG-TS 或 FLV 播放路径；使用返回会回到保留当前来源、分类和搜索条件的频道列表。自定义地址只保存在当前设备，不写入路由或历史，也不会随配置导入导出；频道可用性和地区授权以来源为准。

---

## 架构一览

| 层 | 技术 |
|----|------|
| 界面 | React + Tailwind v4 + shadcn/ui，中文主界面 |
| 业务壳 | 首页 / 关注 / 分类 / 历史 / IPTV 频道首页 / IPTV 播放页 / 设置 / 房间页 |
| 播放 | 直播前端 `mpegts.js`；IPTV `hls.js` / `mpegts.js`；Rust `stream_proxy` 同源代理拉流 |
| 站点 | Rust `LiveSite`：bilibili / huya / douyu / douyin / kuaishou / twitch（快手无实时弹幕，Twitch 仅可靠支持首屏浏览） |
| 弹幕 | Rust WebSocket → Tauri 事件 → 批处理列表 + 按需 Canvas + SC / 设置 / 关注侧栏 |
| 存储 | SQLite：关注、历史、设置、本机 Cookie |

详见 [中文架构说明](docs/zh/架构说明.md) 和 [English architecture](docs/en/architecture.md)。

---

## 合规

以列表、播放地址与接收弹幕为主；B 站、抖音、斗鱼支持用户主动扫码或手动保存本机 Cookie，虎牙支持手动输入本机 Cookie；B 站、斗鱼和虎牙仅支持用户每次主动操作发送一条普通文本。斗鱼/虎牙本机 Cookie 发送不代表已获得公开平台 API 授权或一定送达，请在有权发言的房间完成真实服务验证，并遵守现行平台条款。

**不做**支付、送礼、批量 / 自动 / 定时发送或录制。

仅供学习与个人使用；请遵守各平台服务条款与当地法律。

## 许可证

见仓库 `LICENSE`（若有）。Simple Live 仅作学习参考，不代表其资源许可可直接复用。
