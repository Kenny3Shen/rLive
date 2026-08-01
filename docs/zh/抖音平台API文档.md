# 抖音平台 API 文档

更新时间：2026-08-01。本页说明 rLive 对抖音直播网页数据、播放和实时弹幕的接入边界。

## 能力总览

| 能力 | 状态 | rLive 行为 |
| --- | --- | --- |
| 分类、推荐 | 已支持 | 本地计算 `a_bogus` 验签，调用与网页端相同的分区接口，推荐与分区均可分页「加载更多」。 |
| 搜索 | 已支持 | 需要完整登录 Cookie；仅在上游成功返回时展示结果。 |
| 房间详情与播放 | 已支持 | 解析网页和回流接口，提供上游实际下发的清晰度与播放地址。 |
| 账号 | 已支持 | 可扫码登录或手动保存 Cookie；匿名浏览会建立短时网页会话。 |
| 实时弹幕接收 | 已支持 | 本地计算短时 MSSDK 签名，直连官方 WSS，接收聊天、礼物、点赞、进场等事件。 |
| 弹幕发送 | 已支持 | `douyin_danmaku_send_status` / `douyin_danmaku_send`；手动与会话级自动发送共用。 |

## rLive 接入接口

抖音同样提供统一的列表、搜索、房间、清晰度和播放接口。

推荐与分区列表都来自网页端的分页接口 `GET https://live.douyin.com/webcast/web/partition/detail/room/v2/`，每页 `count=15`，`offset` 按页递增。该接口要求浏览器验签参数 `a_bogus`；rLive 在本机用纯 Rust 实现（SM3 + RC4，见下文）计算，不依赖 JS 运行时或外部签名服务，因此「加载更多」对推荐页和分区页都真实可用。

- 推荐（主页）：抖音网页端的热门推荐并非真实分区，而是以合成分区 `partition=720&partition_type=1` 从同一接口读取，rLive 沿用该约定。首页首屏若验签请求失败，会回退到 `hot_live` 的 SSR 首屏，保证至少有内容可看。
- 分区：分类树把分区标识保存为 `id,type`（例如 `1010032,1`），请求时拆成 `partition` 与 `partition_type` 两个参数；两者都必须为数字，避免向已验签的查询串注入额外参数。分类页中「全部 X」条目的 id 为 `0`，它不是真实分区，会回退到父分区。
- 翻页终止：该接口不下发 `has_more`，因此只有在「返回满页」且「上游 `offset` 确实前进」时才认为还有下一页，避免无限滚动反复拉取同一批房间。

短房间号会先解析 SSR 房间页中的内部房间号，再使用公开 reflow 接口取得播放数据；该请求不携带 `.douyin.com` Cookie 或 `msToken`，避免向其他域重放登录态，也避免受浏览器验签保护的网页进房接口返回 `code=101`。播放地址为短时网页数据，刷新房间或播放失败后应重新获取。

## 列表验签（a_bogus）

列表接口的 `a_bogus` 由请求自身的查询串、UA 和一段固定的浏览器环境指纹推导：

1. 按最终发送顺序拼出查询串（`msToken` 为每次请求随机生成的 107 位字符串，不持久化、不作为身份标识复用）。
2. 对查询串与 UA 分别做 SM3 / RC4 变换，组装二进制状态数组并计算校验位。
3. RC4 加密后用抖音自有字母表做 Base64 变体编码，得到 `a_bogus`。
4. 签名覆盖的是字面查询串，因此参数只在本地编码一次，签名结果追加到同一字符串后发送，不再交给 HTTP 客户端二次拼装。

实现见 `src-tauri/src/sites/douyin/a_bogus.rs`，其中 SM3 与 RC4 均带标准测试向量。

## 本地签名与实时弹幕

抖音实时弹幕连接地址受短时签名保护。rLive 在本机完成：

1. 从房间详情取得内部 `room_id`（以及可选的 `web_rid`）。
2. 生成匿名 12 位 `user_unique_id`。
3. 用固定 webcast 客户端参数计算 MD5 stub，再通过嵌入的 `webmssdk` 脚本（Boa）得到 `signature`。
4. 将签名附到 `wss://webcast3-ws-web-lq.douyin.com/webcast/im/push/v2/` 查询串。
5. 携带本次网页会话 Cookie、`Origin` 与 UA 直连 WebSocket；帧层处理 gzip / protobuf、心跳与 ACK。

完整登录 Cookie 或匿名 `ttwid` 会话都能提高连接可用性。Cookie、短时 WSS URL 和签名结果不会写入日志、前端缓存或配置导出。

签名在本机完成，不依赖外部签名服务。

## 弹幕发送

`danmaku_connect` 负责接收房间消息。`douyin_danmaku_send_status` 与 `douyin_danmaku_send` 是 rLive 内发送一条普通文本的接口；手动发送与房间内会话级自动发送均复用。

发送前需要：

1. 设置中开启默认关闭的本机 `danmaku_send_enabled`。
2. 本机已保存抖音登录 Cookie（扫码或手动）。
3. 有效数字房间号；命令会先解析房间详情，优先使用内部 `room_id`。
4. 非空单行文本，最多 50 个 UTF-16 单元。
5. 按房间 3 秒本机冷却。

实现路径：本地生成 `user_unique_id` 与 MSSDK `signature`，再 `POST https://live.douyin.com/webcast/room/chat/`（表单字段 + Cookie + Origin/Referer）。Cookie 写请求禁止跟随重定向，也不自动重试；成功写入后才记入本机发送历史。

## 限制与安全

Cookie、短时签名 URL 和上游原始响应均不写入日志或前端缓存。二维码、搜索等网页接口可能返回浏览器访问验证页；应用会使用用户显式配置的 HTTP(S) 代理，但不会自动完成访问验证。访问验证、Cookie 时效、地区和平台风控仍可能导致列表、搜索、房间、播放或弹幕失败；应用会保留已验证的结果，而不是重复或伪造数据。

`a_bogus` 与 `msToken` 均为短时请求参数，不写入数据库或配置导出。列表验签依赖抖音网页端的算法与参数约定，上游调整后可能需要同步更新。

- 站点与播放：`src-tauri/src/sites/douyin/mod.rs`
- 列表验签：`src-tauri/src/sites/douyin/a_bogus.rs`
- 弹幕连接、帧解析与发送：`src-tauri/src/danmaku/douyin.rs`
- 本地签名：`src-tauri/src/danmaku/douyin_sign.rs`
- MSSDK 脚本：`src-tauri/assets/douyin_webmssdk.js`
