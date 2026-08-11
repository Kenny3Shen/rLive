# 虎牙平台 API 文档

更新时间：2026-07-27。本页说明 rLive 对虎牙的浏览、播放、账号与弹幕适配范围。

## 能力总览

| 能力 | 状态 | rLive 行为 |
| --- | --- | --- |
| 分类、推荐、分区房间、搜索 | 已支持 | 解析虎牙网页与公开配置数据，按上游分页结果展示。 |
| 房间详情 | 已支持 | 解析主播、封面、热度、直播状态、公告和播放元数据。 |
| 播放与清晰度 | 已支持 | 处理虎牙线路、码率和防盗链参数，优先交给本机代理和网页播放器。 |
| 实时弹幕接收 | 已支持 | 使用 TARS/WebSocket 房间流量解析普通消息和常见事件。 |
| 账号 | 已支持 | 支持扫码登录与手动保存本机 Cookie。 |
| 普通弹幕发送与会话级自动发送 | 已支持 | 均需要本机发送开关、账号 Cookie 和房间元数据；自动发送只属于当前会话。 |

## rLive 接入接口

虎牙实现统一站点接口：`get_categories`、`get_recommend_rooms`、`get_category_rooms`、`search_rooms`、`get_room_detail`、`get_play_qualities` 与 `get_play_urls`。播放适配器会从房间数据提取多条线路与码率，并在使用时处理防盗链参数；播放地址不应被当作长期稳定的外部 API。

`danmaku_connect` 负责接收房间消息。`huya_danmaku_send_status` 和 `huya_danmaku_send` 是 rLive 内发送一个普通文本片段的接口，手动发送和房间内会话级自动发送均复用；发送前会再次解析房间元数据，以取得网关所需的内部房间参数。

## 账号与发送边界

在「设置 → 账号 → 虎牙」中可扫码登录或手动保存本机 Cookie。扫码走公开 UDB 流程（`udblgn.huya.com/qrLgn/getQrId` → `getQrImg` → `tryQrLogin`），确认后把会话 Cookie 只写入本机；发送路径至少要求数字账号标识（`yyuid` 或 `udb_uid`）及登录凭据（`udb_n`、`udb_cred` 或扫码产生的 `udb_biztoken`），同时需要默认关闭的 `danmaku_send_enabled` 开关、有效房间、非空单行文本和按房间 3 秒本机冷却。

手动发送每次提交一条普通文字。B 站、斗鱼和虎牙房间右侧「设置」还提供默认关闭、不持久化的会话级「自动发送弹幕」；只有共用本机授权、当前 Cookie/可发送状态和文本校验均有效时才可开启。开启时立即发送首段，将换行与连续空白压缩为一个空格，再按 grapheme 拆成每段最多 20 个用户可见字符且不超过虎牙 UTF-16 上限的片段；按顺序发送，末段后从首段继续。请求不重叠，后续发送起始至少相隔当前会话设置的发送间隔；编辑文本、切换房间、离开页面、关闭应用或任意发送失败都会停用，失败不会自动重试。单个 grapheme 无法容纳在平台上限内时会显示校验错误。rLive 不提供批量发送、自动回复、礼物、支付或未知结果自动重试。写入返回不会在 UI 里生成假消息；仅当正常房间连接收到平台真实回显时，消息才会进入列表和飘屏。

## 2026-07-27 发送诊断与验证

在测试直播间完成了受控发送验证。首次问题并非 Cookie 已失效：信令已完成登录校验，并返回 `liveui.sendMessage` 的 WUP 回包；rLive 却把回包误报为“响应格式异常”。

排查和修复如下：

- 站点工厂此前没有把用户保存的虎牙 Cookie 交给房间解析器，导致发送前重新解析房间时始终使用匿名上下文。现仅在 `m.huya.com` 与 `www.huya.com` 的房间页请求中携带该 Cookie，不会重放给列表、搜索或 CDN 主机。
- 离线个人房间的页面可能没有 `lChannelId` / `lSubChannelId`。旧路径把公开短房间号当作信令频道号；现在使用桌面页的 `TT_PROFILE_INFO.lp`、`TT_ROOM_DATA` 中的非零频道字段和 `privateHost` / `yyid` 回退，公开短号永不进入 TARS 频道字段。
- 发送链路与当前网页播放器对齐：使用当前 H5 信令 UA、`WSConnectParaInfo.sCookie`、`WSVerifyCookieReq` 和单条 `liveui.sendMessage` WUP 请求。Cookie 值和原始帧均不记录。
- `tRsp` 的内容本身还包着 TARS tag 0 的 `SendMessageRsp` 结构；旧解析器直接把外层结构当作 `iStatus`，因此即使平台已确认也会失败。现在先解开外层结构，再读取状态和安全提示文本。

修复后的受控测试已收到平台成功状态。平台确认仍不等于 UI 展示确认：rLive 依旧只在正常收弹幕连接出现真实回显时新增列表和飘屏，未知状态也不会自动重发。

## 运行约束与代码位置

虎牙网页协议、线路和登录条件可能随时变更。手动 Cookie 仅保存在当前设备，不记录、不导出也不上传。

- 站点与播放：`src-tauri/src/sites/huya/`
- 扫码登录：`src-tauri/src/account/huya_qr.rs`
- 弹幕与 TARS 编解码：`src-tauri/src/danmu_rs/huya.rs`、`src-tauri/src/danmu_rs/tars.rs`
- command、授权与本机冷却：`src-tauri/src/commands/danmaku.rs`
