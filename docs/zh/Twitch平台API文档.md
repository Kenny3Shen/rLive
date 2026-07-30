# Twitch 平台 API 文档

更新时间：2026-07-27。本页说明 rLive 对 Twitch 网页浏览、HLS 播放与匿名 IRC 弹幕的接入范围。

## 能力总览

| 能力 | 状态 | rLive 行为 |
| --- | --- | --- |
| 分类、推荐、搜索 | 已支持（首屏） | 使用公开网页上下文和 GraphQL 查询；为避免重复结果，不提供浏览翻页。 |
| 房间详情 | 已支持 | 通过主播 login 解析直播标题、游戏、观众数、封面与开播状态。 |
| HLS 播放与清晰度 | 已支持 | 取得短时播放访问令牌并解析 HLS master playlist；切换清晰度会重新获取。 |
| 实时弹幕接收 | 已支持 | 匿名 IRC WebSocket 接收普通频道聊天。 |
| 账号与登录 | 未接入 | 当前没有 Twitch Cookie/OAuth 登录或账户操作。 |
| 弹幕发送 | 未支持 | 匿名 IRC 仅用于接收；不发送聊天。 |

## rLive 接入接口

Twitch 实现统一的分类、推荐、分区房间、搜索、详情、清晰度和播放 URL 接口。适配器先从公开网页初始化所需的浏览上下文，再调用网页使用的 GraphQL 查询。公开接口只能可靠得到首屏，因此 `page > 1` 明确返回空页，不试图绕过完整性检查或合成分页。

播放时，适配器按频道 login 获取短时 HLS 播放许可，并立即解析 master playlist。短时 URL 不保存到前端缓存；在真正播放或切换清晰度时重新获取，以避免过期 token 被复用。

## 弹幕与边界

`danmaku_connect` 使用匿名 IRC WebSocket 加入当前频道并接收聊天。匿名身份没有账号写入权限，因此 rLive 不提供 Twitch 弹幕发送、订阅、礼物、支付或频道管理功能。

上游可用性、地区、频道状态和网页接口可能变化。

- 站点与播放：`src-tauri/src/sites/twitch.rs`
- 匿名 IRC 弹幕：`src-tauri/src/danmaku/twitch.rs`
