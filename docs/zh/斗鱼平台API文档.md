# 斗鱼平台 API 文档

面向要修改斗鱼适配器的开发者，说明浏览、播放签名、账号与实时弹幕的接入方式，以及发送结果如何判定。
当前状态：浏览、播放、弹幕接收、扫码/Cookie 登录、普通弹幕发送与会话级自动发送均已支持，发送已在测试直播间完成端到端验证。

## 能力总览

| 能力 | 状态 | rLive 行为 |
| --- | --- | --- |
| 分类、推荐、分区房间、搜索 | 已支持 | 使用网页/H5 读取接口；推荐、分区与搜索按上游分页结果展示。 |
| 房间详情 | 已支持 | 解析房间、主播、热度、公告、开播状态与开播时间。 |
| 播放与清晰度 | 已支持 | 使用 `getEncryption` 加密描述符 + 本地 MD5 链签名的 `getH5PlayV1` 获取线路和清晰度。 |
| 实时弹幕接收 | 已支持 | 连接斗鱼弹幕网关，过滤高频进场噪声并展示普通消息与礼物事件。 |
| 账号 | 已支持 | 可扫码登录或手动保存完整 Cookie；只保存在当前设备。 |
| 普通弹幕发送与会话级自动发送 | 已验证 | 已在测试直播间完成发送；每个片段仍按平台确认和真实回显处理。 |

## rLive 接入接口

读取能力通过统一适配器接口提供：`get_categories`、`get_recommend_rooms`、`get_category_rooms`、`search_rooms`、`get_room_detail`、`get_play_qualities` 与 `get_play_urls`。

实时能力由 `danmaku_connect`（接收房间事件）和 `douyu_danmaku_send_status` / `douyu_danmaku_send`（当前账号发送一个文本片段）提供；手动发送与会话级自动发送复用后两者。接收链路与发送链路是不同网关职责，两者都遵守应用代理设置。

## 分区寻址

斗鱼的目录接口按层级分开寻址，两级不能混用：

| 目标 | 地址 |
| --- | --- |
| 二级分区（`cate2Id`） | `m.douyu.com/hgapi/live/cate/newRecList?cate2={id}`，被拒时回落 `www.douyu.com/gapi/rkc/directory/mixList/2_{id}/{page}` |
| 一级聚合（`cate1Id`） | `www.douyu.com/gapi/rkc/directory/mixList/1_{cate1Id}/{page}` |

前端为每个父分区合成的「全部X」入口形如 `{ id: "0", parent_id: cate1Id }`，这个哨兵值必须走一级地址：`mixList/2_0` 返回 `rl: []` 与 `pgcnt: 0`，移动端接口也不接受一级聚合（传 `cate1` 或 `cate2=0` 一律回 `error: 1`），因此聚合请求直接用 Web 端 `1_{cate1Id}`、不尝试移动端。二级分区维持原有的移动端优先、Web 回落顺序。

## 上游数据与播放

播放签名由 `sites/douyu/sign.rs` 以纯 Rust 计算，不依赖 JS 运行时：

1. 从 `wgapi/livenc/liveweb/websec/getEncryption` 拉取短时效加密描述符（进程内缓存并单飞刷新）。
2. `auth` 由描述符的 `key` / `rand_str` / `enc_time` 迭代 MD5 链得到，每次播放请求都用当前时间戳重新计算。
3. 签名只在内存中短暂使用；播放请求发往 `lapi/live/getH5PlayV1`。旧 `getH5Play` 端点已被上游下线（HTTP 403）。

## 账号与弹幕发送

发送前需要开启默认关闭的本机 `danmaku_send_enabled`，并保存完整的当前账号 Cookie；缺失必要 Cookie 时直接拒绝，不随机生成设备 ID，也不把普通 JWT 当作弹幕 JWT。发送只接受数字房间号、非空单行文本和按房间 3 秒本机冷却。

当前发送状态机（socket 可写不等于平台接收，必须走完加密协商）：

```text
loginreq → loginres → getEncryption → livreq → livres → lsigreq → chatmessage → chatres / error
```

实现要点：使用当前网页形态的登录字段、稳定设备身份和弹幕会话 JWT；按服务端下发的加密配置完成 `livreq` / `lsigreq` 协商，并限制不可信响应的迭代次数、长度和字符集；WSS 与 HTTP 发现共享代理策略，支持安全的 HTTP CONNECT 隧道。

会话级自动发送入口在房间标题栏右侧、移动端「更多房间操作」和全屏「更多操作」，默认关闭且不持久化，需共用授权、当前 Cookie/可发送状态和文本校验都有效才可开启。开启时立即发送首段，把换行和连续空白压缩为一个空格，再按 grapheme 拆成每段最多 20 个用户可见字符且不超过斗鱼 UTF-16 上限的有序片段，末段后从首段循环。请求不重叠，后续发送起始至少相隔当前会话设置的发送间隔。

### 结果语义

每次发送必须区分三个阶段，不能以本地提交当作成功：

| 阶段 | 含义 |
| --- | --- |
| 本地提交 | 应用已把请求交给发送连接，不代表平台接收。 |
| `chatres(res=0)` | 斗鱼网关已确认接收。 |
| 房间真实回显 | 正常收弹幕连接收到该消息，才会显示在 rLive 列表与飘屏中。 |

`error` 或非零 `res` 是明确拒绝；写后超时、关闭或读失败属于「已提交但未确认」，不会自动重试。前端不会根据 command 返回值合成消息；遇到未知结果不要连续重复点击发送，应以直播间真实状态为准。

## 已知限制

- 编辑文本、切换房间、离开页面、关闭应用或任意发送失败都会停用自动发送；失败或未知写入不自动重试。
- 单个 grapheme 无法容纳在平台上限内时显示校验错误。
- 不提供批量发送、自动回复、礼物、支付或自动重试。
- 已验证结果覆盖当前网页流程与测试环境；Cookie、房间条件和上游版本变化仍可能影响结果。
- 斗鱼 Cookie 只保存在本机 SQLite；签名、Cookie、JWT、消息正文和原始回包不写入日志，不导出、不上传。

## 代码位置

- 站点与播放：`src-tauri/src/sites/douyu/`（签名 `sign.rs`）
- 弹幕接收与发送状态机：`src-tauri/src/danmu_rs/douyu.rs`
- 扫码登录：`src-tauri/src/account/douyu_qr.rs`
- command、授权与本机冷却：`src-tauri/src/commands/danmaku.rs`
