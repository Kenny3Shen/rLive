# 抖音平台 API 文档

更新时间：2026-07-31。本页说明 rLive 对抖音直播网页数据、播放和实时弹幕的接入边界。

## 能力总览

| 能力 | 状态 | rLive 行为 |
| --- | --- | --- |
| 分类、推荐 | 已支持 | 匿名 SSR 数据可靠支持首屏；后续浏览器验签分页不显示为“加载更多”。 |
| 搜索 | 已支持 | 需要完整登录 Cookie；仅在上游成功返回时展示结果。 |
| 房间详情与播放 | 已支持 | 解析网页和回流接口，提供上游实际下发的清晰度与播放地址。 |
| 账号 | 已支持 | 可扫码登录或手动保存 Cookie；匿名浏览会建立短时网页会话。 |
| 实时弹幕接收 | 已支持 | 本地计算短时 MSSDK 签名，直连官方 WSS，接收聊天、礼物、点赞、进场等事件。 |
| 弹幕发送 | 已支持 | `douyin_danmaku_send_status` / `douyin_danmaku_send`；手动与会话级自动发送共用。 |

## rLive 接入接口

抖音同样提供统一的列表、搜索、房间、清晰度和播放接口。匿名推荐和分类的 SSR 页面目前只可靠提供首屏，因此 rLive 不伪造偏移翻页，也不会用保存的 Cookie 调用依赖浏览器验签与 cursor 的后续分页接口；界面不会显示不可用的「加载更多」。

短房间号会先解析 SSR 房间页中的内部房间号，再使用公开 reflow 接口取得播放数据；该请求不携带 `.douyin.com` Cookie 或 `msToken`，避免向其他域重放登录态，也避免受浏览器验签保护的网页进房接口返回 `code=101`。播放地址为短时网页数据，刷新房间或播放失败后应重新获取。

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

Cookie、短时签名 URL 和上游原始响应均不写入日志或前端缓存。二维码、搜索等网页接口可能返回浏览器访问验证页；应用会使用用户显式配置的 HTTP(S) 代理，但不会自动完成访问验证。访问验证、Cookie 时效、地区和平台风控仍可能导致列表、搜索、房间、播放或弹幕失败；应用会保留已验证的首屏结果，而不是重复或伪造数据。

- 站点与播放：`src-tauri/src/sites/douyin.rs`
- 弹幕连接、帧解析与发送：`src-tauri/src/danmaku/douyin.rs`
- 本地签名：`src-tauri/src/danmaku/douyin_sign.rs`
- MSSDK 脚本：`src-tauri/assets/douyin_webmssdk.js`
