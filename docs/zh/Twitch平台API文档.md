# Twitch 平台 API 文档

更新时间：2026-08-13。本页说明 rLive 对 Twitch 网页浏览、HLS 播放与匿名 IRC 弹幕的接入范围。

## 能力总览

| 能力 | 状态 | rLive 行为 |
| --- | --- | --- |
| 分类、推荐、搜索 | 桌面端尽力分页；移动端首屏 | 首屏使用公开网页上下文；后续页在隐藏 WebView 中运行官方完整性挑战，并使用网页 persisted operations。 |
| 房间详情 | 已支持 | 通过主播 login 解析直播标题、游戏、观众数、封面与开播状态。 |
| HLS 播放与清晰度 | 已支持 | 取得短时播放访问令牌并解析 HLS master playlist；切换清晰度会重新获取。 |
| 广告占位规避 | 尽力支持 | 检测服务端插播后依次尝试备用播放器类型；实测 Twitch 按 `playerType` 区别插播，`popout` 可在保留完整清晰度的前提下避开，`autoplay` 干净但上限 `360p`。 |
| 实时弹幕接收 | 已支持 | 匿名 IRC WebSocket 接收普通频道聊天。 |
| 账号与登录 | 未接入 | 当前没有 Twitch Cookie/OAuth 登录或账户操作。 |
| 弹幕发送 | 未支持 | 匿名 IRC 仅用于接收；不发送聊天。 |

## rLive 接入接口

Twitch 实现统一的分类、推荐、分区房间、搜索、详情、清晰度和播放 URL 接口。房间、播放和首屏请求先从公开网页初始化 `Client-ID`，并使用进程内随机 `X-Device-Id`。推荐、分类和搜索对齐 Twitch 当前网页的 persisted operations，从 `pageInfo.hasNextPage` 与最后一个 edge cursor 判断下一页；搜索按官方 `CHANNEL` target cursor 请求。页码并非 Twitch 协议字段，因此 rLive 在进程内按推荐、分类 slug 和搜索词维护 30 分钟的页码到 cursor 映射，只允许从首屏开始连续加载。刷新首屏会重置该列表的旧游标；游标缺失、重复、过期或跨进程直接请求后续页时返回可重试的刷新提示，不合成页码或重复结果。

### 浏览器完整性分页

Twitch 的 cursor 请求除了短时 `Client-Integrity` 令牌，还会校验产生令牌的浏览器会话。把令牌、Cookie 和请求头复制到 `reqwest` 或 `curl` 不能稳定通过；账号 Cookie 也不会免除挑战。桌面端首次请求第 2 页时，`twitch_integrity.rs` 创建隐藏、incognito、不进入任务栏且继承应用代理的 Twitch WebView，加载官方 `/directory/all` 页面并滚动触发 Twitch 自己的 JavaScript 挑战。取得上下文后，受保护的 persisted GraphQL 请求仍在同一个 WebView 中执行。

Rust 只向 WebView 发送 operation payload，并接收 GraphQL JSON；`Client-Integrity`、挑战相关 Cookie 和浏览器身份不离开 WebView，不写日志或磁盘。WebView 通过 `twitch_integrity.rs` 自有的仅回环（`127.0.0.1`）HTTP 端点单次 POST 回传就绪与响应消息；每条消息绑定随机会话 ID 和请求 ID，会话 ID 与当前活动会话不符即丢弃。该端点独立于用户可选启用的 web_bridge 服务，只接受桥接消息，不暴露任何应用命令。令牌到期、代理变化或完整性失败时销毁 WebView；单次请求会重建上下文并重试一次，仍失败则返回可重试错误。该实现没有复刻 Twitch 挑战算法，没有引入第三方绕过，也不需要 Twitch 账号、Cookie 或 OAuth app secret。

这是一项尽力能力，不是稳定的官方 API 契约。2026-08-13 的外网验证确认三个首屏 persisted operations 均返回真实数据和可继续 cursor；同日 Linux headless Chromium 的 `/fp` 指纹请求返回 `429`，连官方页面自己的后续页也可能得到 `IntegrityCheckFailed`，因此未在该环境证明第 2 页成功。Windows WebView2 的实际通过率仍取决于 Twitch 风控、网络、地区与网页版本。Android 和 iOS 不创建第二 WebView，首屏即设置 `has_more = false`。

播放时，适配器按频道 login 获取短时 HLS 播放许可，并立即解析 master playlist。短时 URL 不保存到前端缓存；在真正播放或切换清晰度时重新获取，以避免过期 token 被复用。GraphQL 请求附带 `X-Device-Id`：Twitch 网页客户端始终发送该头，缺失会被识别为未知客户端，而这是决定令牌是否被服务端插播广告的信号之一。该值是每个进程随机生成的 32 位小写字母数字，不落盘、不来自机器标识，也不关联账号。

### 广告占位规避

Twitch 的广告插播由服务端在签发播放令牌时决定，令牌申请所用的 `playerType` 是决定因素之一，而且**不同 `playerType` 的结果并不相同**。对 `kaicenat` 连续采样 6 次（每次间隔 15–20 秒），各档位判定完全稳定：

| `playerType` | 是否被插播 | 清晰度阶梯 |
|---|---|---|
| `site`（主令牌） | 否 | 7 档，最高 `1080p60 (source)` |
| `popout` | 否 | 7 档，最高 `1080p60 (source)` |
| `autoplay`（android） | 否 | 3 档，上限 `360p` |
| `embed` | 是 | 7 档 |
| `picture-by-picture` | 是 | 3 档，上限 `360p` |

因此主令牌保持网页默认的 `site/web`（`TWITCH_PRIMARY_PLAYER_TYPE`）：它同时具备「无插播」和「完整清晰度阶梯」两个条件。

需要如实说明测量的边界：上表中 `embed` 与 `picture-by-picture` 携带的广告，其 `X-TV-TWITCH-AD-ROLL-TYPE` 为 `PREROLL`，即随新播放会话签发的前置广告，而不是主播触发的中途广告时段（`commercial break`）。所以该表证明的是「Twitch 按 `playerType` 区别对待」，并不等于证明某个档位能扛过真实的中途广告。同一时刻 `popout` 与 `embed` 拿到的是同一个创意 ID（`Amazon|2488883100494`）却结论相反，这一点是明确的。

命中广告时，本机 `stream_proxy` 会检查 child playlist。除 `stitched` 标记和 `Commercial break in progress` 文本外，还判断 `#EXT-X-DATERANGE` 中的 `X-TV-TWITCH-STREAM-SOURCE`（广告时为 `"Amazon|..."`，正常直播为 `"live"`）——广告分片可能不带任何文本提示，这个属性是更可靠的信号。命中后代理按上表的实测排序依次申请备用令牌：`popout/web`（干净且保留完整清晰度）、`autoplay/android`（干净但降到 `360p`，用清晰度换无广告画面）、`embed/web` 与 `picture-by-picture/web`（实测携带广告，仅作为前两档也被插播时的兜底，因为 Twitch 的按档位判定不保证长期固定）。申请时优先保留当前清晰度，备用档位不提供该清晰度时选择最接近的变体。找到无广告标记的播放列表后，代理在原 localhost 播放地址内完成替换，前端不需要注入 userscript 或连接第三方中转服务。

参考实现 `vaft` 的备用顺序注释为 `embed`/`popout` = Source、`autoplay` = 360p，与本次测到的清晰度阶梯一致。Twitch 的插播判定会随时间变化，因此上述结论只反映测量当时的状态；可运行 `cargo test --lib -- --ignored --nocapture live_kaicenat` 重新测量，测试会打印每个档位的判定、清晰度阶梯，以及不干净时的 `roll_type` 与 `stream_source` 证据。

若所有备用播放列表仍含广告，代理会把广告分片标记为 HLS `#EXT-X-GAP` 并停止低延迟预取，等待正常直播分片恢复。此时不会播放广告占位内容，但画面可能短暂停顿。策略参考 MIT 许可的 [TwitchAdSolutions `vaft`](https://github.com/pixeltris/TwitchAdSolutions/tree/f8f86706daf90daa534b26bce5b2f01238667d5f/vaft) 与 [ttv-lol-pro](https://github.com/younesaassila/ttv-lol-pro)；`vaft` 仓库已经归档，Twitch 也可能随时改变令牌、完整性检查或播放列表格式，因此此能力不保证持续有效。rLive 只改变自己申请令牌的方式，不代理第三方中转服务器，也不绕过订阅或付费内容的访问控制。

## 弹幕与边界

`danmaku_connect` 使用匿名 IRC WebSocket 加入当前频道并接收聊天。匿名身份没有账号写入权限，因此 rLive 不提供 Twitch 弹幕发送、订阅、礼物、支付或频道管理功能。

上游可用性、广告投放、地区、频道状态和网页接口可能变化。请勿同时叠加多个 Twitch 专用广告处理方案，以免不同播放列表改写互相冲突。

- 站点与播放：`src-tauri/src/sites/twitch.rs`
- 浏览器完整性分页：`src-tauri/src/twitch_integrity.rs`
- 匿名 IRC 弹幕：`src-tauri/src/danmu_rs/twitch.rs`
