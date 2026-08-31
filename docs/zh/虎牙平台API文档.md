# 虎牙平台 API 文档

面向要修改虎牙适配器的开发者，说明浏览、播放、账号与弹幕的接入范围，以及发送所需的房间与凭据字段。
当前状态：浏览、播放、弹幕接收、扫码/Cookie 登录、普通弹幕发送与会话级自动发送均已支持，发送已在测试直播间完成受控验证。

## 能力总览

| 能力 | 状态 | rLive 行为 |
| --- | --- | --- |
| 分类、推荐、分区房间、搜索 | 已支持 | 分类走两级目录接口，其余解析虎牙网页与公开配置数据，按上游分页结果展示。 |
| 房间详情 | 已支持 | 解析主播、封面、热度、直播状态、公告和播放元数据。 |
| 播放与清晰度 | 已支持 | 处理虎牙线路、码率和防盗链参数，优先交给本机代理和网页播放器。 |
| 实时弹幕接收 | 已支持 | 使用 TARS/WebSocket 房间流量解析普通消息和常见事件。 |
| 账号 | 已支持 | 支持扫码登录与手动保存本机 Cookie。 |
| 普通弹幕发送与会话级自动发送 | 已支持 | 均需要本机发送开关、账号 Cookie 和房间元数据；自动发送只属于当前会话。 |

## rLive 接入接口

虎牙实现统一站点接口：`get_categories`、`get_recommend_rooms`、`get_category_rooms`、`search_rooms`、`get_room_detail`、`get_play_qualities` 与 `get_play_urls`。

`danmaku_connect` 负责接收房间消息。`huya_danmaku_send_status` 和 `huya_danmaku_send` 是发送一个普通文本片段的接口，手动发送和会话级自动发送均复用；发送前会再次解析房间元数据，以取得网关所需的内部房间参数。

## 分类目录

分类首选 `https://www.huya.com/cache.php?m=Game&do=getGameList`，它一次返回完整两级结构，不需要解析 `/g` 页的 SSR HTML，也不需要再逐个抓 `/g_ol`、`/g_pc`、`/g_yl`、`/g_sy` 四个筛选页。响应为 gzip 传输（`reqwest` 自动解压），顶层字段：

- `gameList`：全部游戏平铺，约 350 余项，**只有这里带 `imgUrl`**（形如 `https://huyaimg.msstatic.com/cdnimage/game/1-L.jpg`）。
- `bussTypeGameList`：以 `bussType` 为 key 的四个二级分组，条目字段与 `gameList` 同构但**不含 `imgUrl`**。
- `status`、`total`、`bussType`：状态与计数字段，解析时不依赖。

条目关键字段是 `gid`（JSON number，不是字符串）、`gameFullName`、`bussType` 和 `isHide`。`gameType` 有 0/3/4/6 几种取值，与分组无关，忽略。`isHide` 实测全为 0，仍然过滤非 0 项以防上游后续隐藏分区。

### 四个聚合 gid 常量

每个分组的聚合入口自身也混在该组数组里，且与普通子分区字段完全同构（同为 gid ≥ 100000 的六位数），没有任何字段能区分它。例如 `bussTypeGameList["1"]` 里的「网游竞技」和同组的「暴雪专区」(100043)、「棋牌休闲」(100301) 看起来一模一样。因此必须用站点级常量把聚合项提取成父分区，否则父分区的 children 里会出现一个同名子项。这四个 gid 由 `/g` 页的筛选条和左侧栏导航硬编码：

| bussType | 聚合 gid | 父分区名 |
| --- | --- | --- |
| 1 | 100023 | 网游竞技 |
| 2 | 100002 | 单机热游 |
| 8 | 100022 | 娱乐 |
| 3 | 100004 | 手游休闲 |

表的行顺序即 `/g` 页筛选条的排布顺序（网游 / 单机 / 娱乐 / 手游），输出父分区按此顺序，不按 bussType 数值排序。

### 解析约定

- 先用 `gameList` 建一张 `gid` → `imgUrl` 映射，再回填给子分类的 `pic`。不按 gid 拼 `{gid}-MS.jpg`：拼接地址对新分类可能 404，上游给出的 `-L.jpg` 才是实际存在的资源。
- 子分类过滤掉聚合项本身、`isHide != 0`、空 `gameFullName` 和空/零 `gid`；children 为空的父分区跳过。
- 聚合 gid 可以直接拉房间列表：`?m=LiveList&do=getLiveListByPage&gameId=100023&tagAll=0&page=1` 返回跨子分区混排的房间，因此父分区入口是真实可用的浏览目标。前端为每个父分区合成的「全部X」磁贴形如 `{ id: "0", parent_id: 父分区 id }`，`get_category_rooms` 遇到 `id == "0"` 时改用 `parent_id` 作为 `gameId`，与斗鱼、抖音、Twitch 的既有跨平台约定一致。

### bussLive 回落

新接口请求失败或解析不出任何父分区时，回落到旧的单层实现 `https://live.cdn.huya.com/liveconfig/game/bussLive`，把全部游戏塞进一个合成的「热门分类」父分区。二级结构会退化，但分类浏览不会因为上游接口变动而整体空掉。

## 上游数据与播放

播放适配器从房间数据提取多条线路与码率，并在使用时处理防盗链参数；播放地址不应被当作长期稳定的外部 API。

房间解析的关键约定：

- 用户保存的虎牙 Cookie 只在 `m.huya.com` 与 `www.huya.com` 的房间页请求中携带，不会重放给列表、搜索或 CDN 主机。
- 信令频道号取自桌面页的 `TT_PROFILE_INFO.lp`、`TT_ROOM_DATA` 中的非零频道字段，并以 `privateHost` / `yyid` 回退；公开短房间号永不进入 TARS 频道字段（离线个人房间可能没有 `lChannelId` / `lSubChannelId`）。
- 发送链路与当前网页播放器对齐：当前 H5 信令 UA、`WSConnectParaInfo.sCookie`、`WSVerifyCookieReq` 和单条 `liveui.sendMessage` WUP 请求。`tRsp` 内容还包着 TARS tag 0 的 `SendMessageRsp` 结构，需先解开外层结构再读取状态和安全提示文本。

## 账号与弹幕发送

在「设置 → 账号 → 虎牙」中可扫码登录或手动保存本机 Cookie。扫码走公开 UDB 流程（`udblgn.huya.com/qrLgn/getQrId` → `getQrImg` → `tryQrLogin`），确认后把会话 Cookie 只写入本机。

发送前必须同时满足：

1. 默认关闭的 `danmaku_send_enabled` 开关已开启。
2. 数字账号标识（`yyuid` 或 `udb_uid`）及登录凭据（`udb_n`、`udb_cred` 或扫码产生的 `udb_biztoken`）齐备。
3. 有效房间、非空单行文本，并满足按房间 3 秒本机冷却。

会话级自动发送入口在房间标题栏右侧、移动端「更多房间操作」和全屏「更多操作」，默认关闭且不持久化，需共用本机授权、当前 Cookie/可发送状态和文本校验都有效才可开启。开启时立即发送首段，把换行与连续空白压缩为一个空格，再按 grapheme 拆成每段最多 20 个用户可见字符且不超过虎牙 UTF-16 上限的片段，顺序发送、末段后回到首段循环。请求不重叠，后续发送起始至少相隔当前会话设置的发送间隔。

结果语义：平台确认不等于 UI 展示确认。写入返回不会在 UI 里生成假消息，只有正常收弹幕连接收到平台真实回显时消息才进入列表和飘屏；未知状态不会自动重发。

## 已知限制

- 编辑文本、切换房间、离开页面、关闭应用或任意发送失败都会停用自动发送；失败不自动重试。
- 单个 grapheme 无法容纳在平台上限内时显示校验错误。
- 不提供批量发送、自动回复、礼物、支付或未知结果自动重试。
- 虎牙网页协议、线路和登录条件可能随时变更。
- 手动 Cookie 仅保存在当前设备，Cookie 值和原始帧均不记录、不导出也不上传。

## 代码位置

- 站点与播放：`src-tauri/src/sites/huya/`
- 扫码登录：`src-tauri/src/account/huya_qr.rs`
- 弹幕与 TARS 编解码：`src-tauri/src/danmu_rs/huya.rs`、`src-tauri/src/danmu_rs/tars.rs`
- command、授权与本机冷却：`src-tauri/src/commands/danmaku.rs`
