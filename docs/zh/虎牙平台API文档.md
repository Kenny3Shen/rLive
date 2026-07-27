# 虎牙平台 API 文档

更新时间：2026-07-27。本页说明 rLive 对虎牙的浏览、播放、账号与弹幕适配范围；它不是虎牙开放平台或合作 SDK 的官方开发文档。

## 能力总览

| 能力 | 状态 | rLive 行为 |
| --- | --- | --- |
| 分类、推荐、分区房间、搜索 | 已支持 | 解析虎牙网页与公开配置数据，按上游分页结果展示。 |
| 房间详情 | 已支持 | 解析主播、封面、热度、直播状态、公告和播放元数据。 |
| 播放与清晰度 | 已支持 | 处理虎牙线路、码率和防盗链参数，优先交给本机代理和网页播放器。 |
| 实时弹幕接收 | 已支持 | 使用 TARS/WebSocket 房间流量解析普通消息和常见事件。 |
| 账号 | 已支持 | 支持手动保存本机 Cookie；当前没有内置扫码登录。 |
| 单条普通弹幕发送 | 已支持 | 需要本机发送开关、账号 Cookie 和房间元数据。 |

## rLive 接入接口

虎牙实现统一站点接口：`get_categories`、`get_recommend_rooms`、`get_category_rooms`、`search_rooms`、`get_room_detail`、`get_play_qualities` 与 `get_play_urls`。播放适配器会从房间数据提取多条线路与码率，并在使用时处理防盗链参数；播放地址不应被当作长期稳定的外部 API。

`danmaku_connect` 负责接收房间消息。`huya_danmaku_send_status` 和 `huya_danmaku_send` 只服务于 rLive 内、由用户明确触发的单条发送；发送前会再次解析房间元数据，以取得网关所需的内部房间参数。

## 账号与发送边界

在「设置 → 账号 → 虎牙」中手动保存本机 Cookie。发送路径至少要求数字账号标识（`yyuid` 或 `udb_uid`）及登录凭据（`udb_n` 或 `udb_cred`），同时需要默认关闭的 `danmaku_send_enabled` 开关、有效房间、非空单行文本和按房间 3 秒本机冷却。

该功能只允许用户每次主动发送一条普通文字。它不支持批量、循环、定时、自动回复、礼物、支付或未知结果自动重试。写入返回不会在 UI 里生成假消息；仅当正常房间连接收到平台真实回显时，消息才会进入列表和飘屏。

## 2026-07-27 发送诊断与验证

在已获授权的个人直播间完成了受控发送验证。首次问题并非 Cookie 已失效：信令已完成登录校验，并返回 `liveui.sendMessage` 的 WUP 回包；rLive 却把回包误报为“响应格式异常”。

排查和修复如下：

- 站点工厂此前没有把用户保存的虎牙 Cookie 交给房间解析器，导致发送前重新解析房间时始终使用匿名上下文。现仅在 `m.huya.com` 与 `www.huya.com` 的房间页请求中携带该 Cookie，不会重放给列表、搜索或 CDN 主机。
- 离线个人房间的页面可能没有 `lChannelId` / `lSubChannelId`。旧路径把公开短房间号当作信令频道号；现在使用桌面页的 `TT_PROFILE_INFO.lp`、`TT_ROOM_DATA` 中的非零频道字段和 `privateHost` / `yyid` 回退，公开短号永不进入 TARS 频道字段。
- 发送链路与当前网页播放器对齐：使用当前 H5 信令 UA、`WSConnectParaInfo.sCookie`、`WSVerifyCookieReq` 和单条 `liveui.sendMessage` WUP 请求。Cookie 值和原始帧均不记录。
- `tRsp` 的内容本身还包着 TARS tag 0 的 `SendMessageRsp` 结构；旧解析器直接把外层结构当作 `iStatus`，因此即使平台已确认也会失败。现在先解开外层结构，再读取状态和安全提示文本。

修复后的受控测试已收到平台成功状态。平台确认仍不等于 UI 展示确认：rLive 依旧只在正常收弹幕连接出现真实回显时新增列表和飘屏，未知状态也不会自动重发。

## 限制与安全

虎牙网页协议、线路和登录条件可能随时变更。手动 Cookie 仅保存在当前设备，不记录、不导出也不上传。此本机功能不表示虎牙向 rLive 授予公开应用写入范围；用户应自行确认账号、房间资格和平台条款。

- 站点与播放：`src-tauri/src/sites/huya/`
- 弹幕与 TARS 编解码：`src-tauri/src/danmaku/huya.rs`、`src-tauri/src/danmaku/tars.rs`
- command、授权与本机冷却：`src-tauri/src/commands/danmaku.rs`
