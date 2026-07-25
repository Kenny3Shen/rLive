# B 站发送弹幕调研

更新时间：2026-07-25。本文记录可行性调研，不代表 rLive 已提供发送弹幕功能。

## 结论

技术上可行，但它是依赖登录 Cookie 的非公开写接口。当前 rLive 的产品边界是只读聚合（列表、播放和接收弹幕），**没有实现、也不会自动发送弹幕或礼物**。若以后决定开放，必须先完成下文的安全前置与交互约束。

## 已确认的接口形态

参考 `bilibili-api-python` 17.4.2 的直播实现，单条直播弹幕使用：

```text
POST https://api.live.bilibili.com/msg/send
```

请求需要真实直播间号和已登录的 Cookie：

- 必需：`SESSDATA`、`bili_jct`；`bili_jct` 同时作为 `csrf` 与 `csrf_token`。
- 建议保留：`buvid3`、`buvid4`、`DedeUserID`，以保持网页登录态的一致性。
- 基础表单：`roomid`、`msg`、`mode=1`、`bubble=0`、`rnd`（Unix 秒）、`color=16777215`、`fontsize=25`、`csrf`、`csrf_token`。
- 位置模式：滚动 `mode=1`、底部 `mode=4`、顶部 `mode=5`；颜色、字号等样式可能受账号或房间权限限制。

现有 `LiveRoomDetail.room_id` 已保存真实房间号，后端也已有 B 站 Cookie、共享 HTTP 客户端和统一错误模型，因此无需为每条消息重新查询房间详情。

## 如果未来实施

第一版应严格限定为 B 站、单条、用户明确点击的普通滚动白色文本；不要暴露批量、循环、定时、自动回复、样式权限或自动重试。

1. 新建 B 站专用发送方法和 Tauri command；前端只能传已加载详情中的真实房间号和文本。
2. 后端校验空白、控制字符、保守长度、`SESSDATA`、`bili_jct`；按账号与房间设置短冷却。
3. 前端发送期间锁定按钮，防止双击；平台的 10030 / 10031 等限流错误应提示“发送过快”。
4. 超时或断网时不能自动重试，因为服务器可能已经收到消息；应提示“发送状态未知，请到直播间确认”。
5. 不做乐观插入；等待 WebSocket 回显，避免本地消息与回显重复。
6. Cookie、CSRF 和请求参数不得进入前端日志、错误文本或 command 响应。

测试应使用 mock HTTP 和可控账号/房间的手动单条验证，不要对公共直播间进行自动化发送。

## 安全前置

发布构建当前无条件启用本机 `tauri-plugin-mcp-bridge`，而现有 command 中也包含读取 Cookie 的接口。若新增写 command，本机能够访问该桥的进程可能绕过 UI 的确认步骤调用该 command。

在开放任何写能力前，应先将该 bridge 限制在 debug 构建，或移出发布版，并审视 Cookie 读取 command 的暴露范围和日志行为。完成这项前置前，不应把发送弹幕接入发布版。

## 参考

- `bilibili-api-python` v17.4.2：直播 `LiveRoom.send_danmaku` 及其 API 定义。
- rLive：B 站真实房间号解析、Cookie 存储与 `LiveRoomDetail.room_id` 数据流。
