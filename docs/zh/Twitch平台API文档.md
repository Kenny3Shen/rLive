# Twitch 平台 API 文档

面向要修改 Twitch 适配器的开发者，说明网页浏览、语言分片分页、HLS 播放与广告规避、桌面录制和匿名 IRC 弹幕的接入方式。
当前状态：浏览、分页、HLS 播放与录制、匿名弹幕接收已支持；没有账号登录，也不提供弹幕发送。

## 能力总览

| 能力 | 状态 | rLive 行为 |
| --- | --- | --- |
| 分类、推荐、搜索 | 已支持分页（桌面与移动一致） | 分类为「游戏类型标签 → 分区」两级；推荐和分区按语言分片翻页，搜索使用官方 offset cursor，均只需公开网页 `Client-ID`。搜索同时覆盖在播与未开播频道。 |
| 房间详情 | 已支持 | 通过主播 login 解析直播标题、游戏、观众数、封面与开播状态。 |
| HLS 播放与清晰度 | 已支持 | 取得短时播放访问令牌并解析 HLS master playlist；切换清晰度会重新获取，长时间录制在清单异常时也会刷新目标清晰度或最接近档位的 URL。 |
| 广告占位规避 | 尽力支持 | 检测服务端插播后依次尝试备用播放器类型；`popout` 可在保留完整清晰度的前提下避开，`autoplay` 干净但上限 `360p`。 |
| 实时弹幕接收 | 已支持 | 匿名 IRC WebSocket 接收普通频道聊天，并把 `emotes` 标签与 7TV 表情展开为图片片段。 |
| 账号与登录 | 未接入 | 当前没有 Twitch Cookie/OAuth 登录或账户操作。 |
| 弹幕发送 | 未支持 | 匿名 IRC 仅用于接收；不发送聊天。 |

## rLive 接入接口

Twitch 实现统一的分类、推荐、分区房间、搜索、详情、清晰度和播放 URL 接口。房间、播放和列表请求先从公开网页初始化 `Client-ID`，并使用进程内随机 `X-Device-Id`。分类树、推荐和分区房间使用自有命名的 GraphQL 查询（不依赖会轮换的 persisted query hash），搜索按官方 `CHANNEL` target 的 offset cursor 请求。

`X-Device-Id` 是每个进程随机生成的 32 位小写字母数字，不落盘、不来自机器标识、不关联账号。Twitch 网页客户端始终发送该头，缺失会被识别为未知客户端，而这是决定令牌是否被服务端插播广告的信号之一。

## 上游数据与播放

### 分类树（游戏类型标签 → 分区）

Twitch 没有官方的「父分区」概念，但目录页的游戏类型标签（FPS、RPG、IRL……）能当作一级分类，`games(tags:)` 按标签筛出该类型下的分区：

- 一级分类：`searchCategoryTags(userQuery: "", limit: 100)`，实测返回 41 个标签，全部 `scope: CATEGORY`。标签的 `id` 是 UUID，`games(tags:)` **只认 UUID**，传 `"FPS"` 这样的名字返回空数组。`isLanguageTag` 为真的标签会与语言分片翻页轴重叠，直接丢弃。
- 二级分区：`games(first: 30, tags: [<tagId>])`，子分区 id 沿用 `slug`（`game(slug:)` 与语言分片翻页都用它），`parent_id` 存标签 UUID。
- 为什么每标签只取 30：`games(first:)` 服务端上限 100，取满时 41 个标签共 2800 余项、约 500 KiB，是另外三个平台整棵树（B站 454 项 / 斗鱼 502 项 / 虎牙 356 项，40–65 KiB）的近十倍。取 30 落在 1000 项上下、约 176 KiB，覆盖 638 个去重游戏，仍远多于过去单层的 30 个热门游戏。
- 标签筛选确实生效：伪造 UUID 返回 0 条，各标签的分区集合互不相同（FPS 首项是 `escape-from-tarkov`/`valorant`，Visual Novel 是 `umamusume-pretty-derby`，Pinball 只有 2 个分区）。

### 「全部X」聚合视图

分类页给每个父分区合成一个 id 为 `0` 的「全部X」磁贴。虎牙的父分区聚合 gid 能直接拉房间，Twitch 没有等价物——**`streams` 的两种标签入参都是空转**：顶层 `tags:` 与 `options.tags` 都能通过 schema 校验，但传 FPS 标签、传全 `f` 的伪造 UUID、和完全不传，返回的频道列表一模一样，结果里混着 Just Chatting 和 IRL。标签只在 `games(tags:)`（分区目录）上真正生效。

因此聚合视图换一条分片轴：先取标签下的分区，再按每页 3 个分区并发拉 `game(slug:).streams`，按 login 去重。翻页仍是纯算术（第 N 页对应分区 `3(N-1)..3N`），不需要游标，也不需要跨请求状态；分区已按热度排序，前几页仍是该类型下最热的内容。每标签 30 个分区即 10 页可翻深度，与语言分片的 9 页同量级。聚合视图不再叠加语言筛选——分片轴已经是分区，再收窄一层只会让每个分区都只剩一个语言切片。

### 语言分片分页

Twitch 拒绝所有没有浏览器完整性上下文的 Relay 游标：只要请求带 `after:`，服务端就返回 `IntegrityCheckFailed`，复制 `Client-Integrity` 令牌、Cookie 和请求头也不能稳定通过，账号 Cookie 同样不免除挑战。因此 rLive 不翻游标，而是沿 `broadcasterLanguages` 分片翻页——该参数只需公开 `Client-ID`。

游标失效在 2026-09-01 复测过一轮，覆盖三个连接与多种绕行姿势，结论一致：

| 尝试 | 结果 |
| --- | --- |
| `games` / `streams` / `game.streams` 带 `after:` | 均 `IntegrityCheckFailed`，无游标时同一请求正常 |
| persisted query（`BrowsePage_AllDirectories`）带 `cursor` | 第 1 页正常 30 条，第 2 页 `IntegrityCheckFailed` |
| 批量数组请求体、`Referer`/`Origin`、`Client-Session-Id`/`Client-Version` | 均无效 |
| 从 `POST https://gql.twitch.tv/integrity` 取到的真实 `Client-Integrity` 令牌 | 仍 `IntegrityCheckFailed` |

游标本身不是加密黑盒（`BrowsePage_AllDirectories` 的游标解出来是 `{"s":30,"d":false,"t":true}`，就是个偏移），拦截发生在完整性校验而非游标解析，所以伪造游标也没有意义。


- 为什么必须分片：`streams(first:)` 被服务端硬性限制为 30，不带筛选时永远只能看到最热门的 30 个频道。2026-08-14 实测全站推荐用 27 个语言分片可取得 735 个不重复直播间，不分片只有 30 个。
- 分片列表：空串（不限语言，即原首屏）加 26 个 Twitch 目录自身提供的语言代码，按受众规模排序，使前几页仍是最热内容。
- 页码映射：每页取固定的 3 个连续分片，第 N 页对应分片 `3(N-1)..3N`，纯算术、无跨请求状态，任意页都可直接请求，没有游标缓存与「必须从首屏连续加载」的限制。
- 去重：分片之间会重叠，后端按 login 去重、前端再按 `site_id + room_id` 去重，因此三个 30 条分片实际约落在 70–80 个不重复直播间。
- 空页不代表结束：冷门分区会夹杂空分片（实测 `factorio` 有 20 个语言返回空），`has_more` 只在分片列表本身走完时才为 `false`。
- 取舍：不需要隐藏 WebView、完整性令牌、账号、Cookie 或 OAuth app secret，桌面与 Android / iOS 行为一致；代价是排序变成「分片内按观众数降序」的分段拼接，而非全站统一降序。

### 搜索结果里的未开播频道

`searchFor` 的 `CHANNEL` target 本身就同时返回在播和未开播频道，区别只在 `stream` 字段：开播时是对象，未开播时为 `null`。适配器据此填 `live_status`，不再丢弃未开播频道。未开播条目没有直播标题和预览图，封面退回 `profileImageURL`，标题留空。

未开播频道的热度留 0，不拿关注数一类的字段代替：那和在播频道的 `viewersCount` 不是同一个量纲，混在同一栏里只会误导排序。

### 播放与录制的短时 URL

适配器按频道 login 获取短时 HLS 播放许可并立即解析 master playlist。短时 URL 不保存到前端缓存，在真正播放或切换清晰度时重新获取，避免过期 token 被复用。

桌面 HLS 录制同样不把短时 child playlist URL 视为永久地址。录制器保留频道 login、清晰度 selector 和目标分辨率等恢复上下文；清单读取失败、token 过期、返回非 HLS 的临时广告文本或单次出现 `#EXT-X-ENDLIST` 时，按退避重新申请目标清晰度（必要时最接近档位）的 URL，成功后继续轮询。只有主播放档位明确返回 `twitch_not_live` 才确认正常下播；广告或临时响应期间保持录制清单为 `EVENT`，等待正常直播清单恢复。

### 广告占位规避

广告插播由服务端在签发播放令牌时决定，令牌申请所用的 `playerType` 是决定因素之一，且不同 `playerType` 结果不同。对 `kaicenat` 连续采样 6 次（间隔 15–20 秒），各档位判定完全稳定：

| `playerType` | 是否被插播 | 清晰度阶梯 |
| --- | --- | --- |
| `site`（主令牌） | 否 | 7 档，最高 `1080p60 (source)` |
| `popout` | 否 | 7 档，最高 `1080p60 (source)` |
| `autoplay`（android） | 否 | 3 档，上限 `360p` |
| `embed` | 是 | 7 档 |
| `picture-by-picture` | 是 | 3 档，上限 `360p` |

因此主令牌保持网页默认的 `site/web`（`TWITCH_PRIMARY_PLAYER_TYPE`）：它同时具备「无插播」和「完整清晰度阶梯」。

测量边界要如实说明：上表中 `embed` 与 `picture-by-picture` 携带的广告 `X-TV-TWITCH-AD-ROLL-TYPE` 为 `PREROLL`，即随新播放会话签发的前置广告，不是主播触发的中途广告时段。该表证明「Twitch 按 `playerType` 区别对待」（同一时刻 `popout` 与 `embed` 拿到同一创意 ID `Amazon|2488883100494` 却结论相反），不等于证明某档位能扛过真实中途广告。

命中广告时的处理：

1. 本机 `stream_proxy` 检查 child playlist。除 `stitched` 标记和 `Commercial break in progress` 文本外，还判断 `#EXT-X-DATERANGE` 中的 `X-TV-TWITCH-STREAM-SOURCE`（广告为 `"Amazon|..."`，正常直播为 `"live"`）——广告分片可能不带任何文本提示，该属性是更可靠的信号。
2. 按实测排序依次申请备用令牌：`popout/web`（干净且保留完整清晰度）、`autoplay/android`（干净但降到 `360p`）、`embed/web` 与 `picture-by-picture/web`（实测带广告，仅作前两档也被插播时的兜底）。申请时优先保留当前清晰度，备用档位缺该清晰度时选最接近的变体。
3. 找到无广告标记的播放列表后，代理在原 localhost 播放地址内完成替换，前端不需要注入 userscript 或连接第三方中转服务。
4. 若所有备用播放列表仍含广告，代理把广告分片标记为 HLS `#EXT-X-GAP` 并停止低延迟预取，等待正常分片恢复；此时不播放广告占位内容，但画面可能短暂停顿。
5. 录制归档解析 `#EXT-X-DISCONTINUITY-SEQUENCE`，把 GAP 或已滚出窗口的不连续边界传递到下一段实际保存的媒体；重签名后以 `PROGRAM-DATE-TIME`/媒体序号去重，避免同一直播窗口被追加两次。

判定会随时间变化，可运行 `cargo test --lib -- --ignored --nocapture live_kaicenat` 重新测量；测试会打印每个档位的判定、清晰度阶梯，以及不干净时的 `roll_type` 与 `stream_source` 证据。策略参考 MIT 许可的 [TwitchAdSolutions `vaft`](https://github.com/pixeltris/TwitchAdSolutions/tree/f8f86706daf90daa534b26bce5b2f01238667d5f/vaft) 与 [ttv-lol-pro](https://github.com/younesaassila/ttv-lol-pro)，其备用顺序注释（`embed`/`popout` = Source、`autoplay` = 360p）与本次测到的清晰度阶梯一致。

## 账号与弹幕边界

`danmaku_connect` 使用匿名 IRC WebSocket 加入当前频道并接收聊天。匿名身份没有账号写入权限，因此 rLive 不提供 Twitch 弹幕发送、订阅、礼物、支付或频道管理功能。

官方图片表情不需额外请求：IRC `emotes` 标签已携带 `<emote_id>:<start>-<end>` 位置（按 code point 计数），解析器据此把消息拆为有序的文本/图片 `DanmakuContentSpan`，图片指向 `https://static-cdn.jtvnw.net/emoticons/v2/<id>/default/dark/2.0`。位置越界、重叠或 id 含非法字符时整条丢弃片段并回退纯文本（`/me` 动作消息的 `\x01ACTION` 包裹会让下标错位，属于该回退路径）。前端复用与 B 站表情相同的渲染与本机图片代理缓存路径。官方表情按内联小表情渲染（与文字同行、单条车道）；7TV 命中的片段带 `large` 标记，飘屏按大表情占两条车道并放大。

### 7TV 第三方表情

7TV 表情不进 IRC 标签，只以普通单词出现在消息文本里，因此需要先拉取表情表再按名匹配：

- 全局集 `GET https://7tv.io/v3/emote-sets/global`（实测 45 个）；频道集 `GET https://7tv.io/v3/users/twitch/<broadcaster_id>` 取 `emote_set`。`broadcaster_id` 来自房间详情 `raw.broadcaster_id`，不需额外的 Twitch 请求。两个请求无鉴权、并发发出，共用与 Twitch 请求相同的代理设置。
- 每个弹幕会话只取一次，重连时复用；任一请求失败或超时只会让对应表情退回文本，不影响聊天连接。多数频道没有 7TV 账号，频道集返回 404 属于正常情况。
- 图片取 `data.host.url` 拼 `2x.webp`（64px，与官方 2.0 档对齐；WebP 是三种可选格式里动图体积最小的一档），缺该档时回退 `1x.webp`。只接受落在 `https://cdn.7tv.app/emote/` 下的 URL：它直接进 img 标签，不能让响应里的任意主机名穿透。
- 名字以表情集里的顶层 `name`（主播可改的别名）为准而非 `data.name`，因为聊天里出现的是别名；频道集后收以覆盖同名全局条目。匹配限定为完整的空白分隔词，避免 `Kappa` 从 `Kappapride` 里被切出。上限 2048 个表情。
- 官方表情与 7TV 叠加而非二选一：先按官方标签的精确下标分段，再在剩下的文本片段上做 7TV 名字匹配。

BTTV 与 FrankerFaceZ 未接入；它们需要另两套接口和缓存，而 7TV 已覆盖大部分实际出现的第三方表情。

## 已知限制

- 上游可用性、广告投放、地区、频道状态和网页接口可能变化；分片能力取决于 Twitch 的公开网页接口。
- 分类树与聚合视图的深度受服务端 `first` 上限（分区目录 100、房间列表 30）和游标不可用共同限制：每个标签最多看到 30 个分区，聚合视图最多翻 10 页。不用游标换取更深的分页。
- 一级分类名沿用 Twitch 自己的英文标签名（`FPS`、`Just Chatting` 之类），上游没有中文标签数据，rLive 不自行翻译以免与平台显示不一致。
- `vaft` 仓库已归档，Twitch 也可能随时改变令牌、完整性检查或播放列表格式，因此广告规避不保证持续有效。
- rLive 只改变自己申请令牌的方式，不代理第三方中转服务器，也不绕过订阅或付费内容的访问控制。
- 请勿同时叠加多个 Twitch 专用广告处理方案，以免不同播放列表改写互相冲突。
- 7TV 是 Twitch 之外的第三方服务，接口改版或不可用时第三方表情退回文本显示。表情表在会话开始时取一次，主播会话中途新增表情需重新进房才会生效。

## 代码位置

- 站点、语言分片分页与播放：`src-tauri/src/sites/twitch.rs`
- 匿名 IRC 弹幕：`src-tauri/src/danmu_rs/twitch.rs`

## 参考

- [twitch-graphql-api](https://deepwiki.com/mauricew/twitch-graphql-api)
- [TwitchAdSolutions](https://github.com/pixeltris/TwitchAdSolutions)
