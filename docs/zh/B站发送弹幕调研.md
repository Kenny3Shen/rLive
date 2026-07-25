# B 站发送弹幕调研

更新时间：2026-07-25。本文记录 rLive 的灰度实现边界与安全约束。

## 结论

技术上可行，但它是依赖登录 Cookie 的非公开写接口。rLive 现在提供**默认关闭的灰度功能**：仅 B 站、仅单条、仅普通滚动文本，并要求用户逐条二次确认。它不是自动化能力，不支持礼物、批量、循环、定时、自动回复、样式权限或自动重试。

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

## 当前灰度实现

1. 设置中有独立 opt-in，默认关闭；发送框还会检查保存的 Cookie 是否同时含 `SESSDATA` 和 `bili_jct`。未满足时严格禁用。
2. 前端只能在 B 站房间显示输入框；点击或 Enter 后弹出二次确认，发送中按钮锁定。
3. 后端再次校验 opt-in、真实数字房间号、空白/控制字符、80 字符上限和 Cookie，不信任前端状态。
4. 每个房间使用 3 秒进程内冷却；服务端 10030 / 10031 / 10039 统一提示“发送过快”。
5. 超时或网络故障不重试，提示“发送状态未知，请到直播间确认”；不乐观插入，正常 WebSocket 回显才进入列表。
6. Cookie、CSRF、发送内容和上游原始错误都不写日志或返回到 UI。Cookie 只留在本机 SQLite。

测试使用纯函数 Cookie/文本校验、发送冷却单测与可控账号的手动单条验证；不要对公共直播间实施自动化发送。

## 安全前置

`tauri-plugin-mcp-bridge` 现在只在 debug 构建装载；发布构建不暴露该本机自动化桥，因此不能绕过 UI 的二次确认直接调用写 command。后端仍独立执行 opt-in、Cookie、文本、房间号和冷却校验，前端禁用只是一层 UX 防护。

## 参考

- `bilibili-api-python` v17.4.2：直播 `LiveRoom.send_danmaku` 及其 API 定义。
- rLive：B 站真实房间号解析、Cookie 存储与 `LiveRoomDetail.room_id` 数据流。
