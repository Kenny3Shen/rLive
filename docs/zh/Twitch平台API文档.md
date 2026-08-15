# Twitch 平台 API 文档

更新时间：2026-08-14。本页说明 rLive 对 Twitch 网页浏览、HLS 播放与匿名 IRC 弹幕的接入范围。

## 能力总览

| 能力             | 状态                         | rLive 行为                                                                                                                                                   |
| ---------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 分类、推荐、搜索 | 已支持分页（桌面与移动一致） | 推荐和分区按语言分片翻页，搜索使用官方 offset cursor，均只需公开网页`Client-ID`。                                                                          |
| 房间详情         | 已支持                       | 通过主播 login 解析直播标题、游戏、观众数、封面与开播状态。                                                                                                  |
| HLS 播放与清晰度 | 已支持                       | 取得短时播放访问令牌并解析 HLS master playlist；切换清晰度会重新获取。                                                                                       |
| 广告占位规避     | 尽力支持                     | 检测服务端插播后依次尝试备用播放器类型；实测 Twitch 按`playerType` 区别插播，`popout` 可在保留完整清晰度的前提下避开，`autoplay` 干净但上限 `360p`。 |
| 实时弹幕接收     | 已支持                       | 匿名 IRC WebSocket 接收普通频道聊天。                                                                                                                        |
| 账号与登录       | 未接入                       | 当前没有 Twitch Cookie/OAuth 登录或账户操作。                                                                                                                |
| 弹幕发送         | 未支持                       | 匿名 IRC 仅用于接收；不发送聊天。                                                                                                                            |

## rLive 接入接口

Twitch 实现统一的分类、推荐、分区房间、搜索、详情、清晰度和播放 URL 接口。房间、播放和列表请求先从公开网页初始化 `Client-ID`，并使用进程内随机 `X-Device-Id`。推荐和分区房间使用自有命名的 GraphQL 查询（不依赖会轮换的 persisted query hash），搜索按官方 `CHANNEL` target 的 offset cursor 请求。

### 语言分片分页

Twitch 拒绝所有没有浏览器完整性上下文的 Relay 游标：只要请求带 `after:`，服务端就返回 `IntegrityCheckFailed`，且把 `Client-Integrity` 令牌、Cookie 和请求头复制到 `reqwest` 或 `curl` 也不能稳定通过，账号 Cookie 同样不免除挑战。因此 rLive 不再翻游标，而是沿 `broadcasterLanguages` 分片翻页——该参数只需公开 `Client-ID`。

`streams(first:)` 被服务端硬性限制为 30，所以不带筛选时永远只能看到最热门的 30 个频道。分片正是打开长尾的手段：2026-08-14 实测全站推荐用 27 个语言分片可取得 735 个不重复直播间，而不分片只有 30 个。分片列表为空串（不限语言，即原首屏）加 26 个 Twitch 目录自身提供的语言代码，按受众规模排序，使前几页仍是最热内容。

每页取固定的 3 个连续分片，页码到分片的映射是纯算术（第 N 页对应分片 `3(N-1)..3N`），没有跨请求状态需要维护，也没有 30 分钟游标缓存与「必须从首屏连续加载」的限制，任意页都可直接请求。分片之间会重叠（一个频道同时出现在全局分片和其语言分片中），后端按 login 去重，前端再按 `site_id + room_id` 去重，因此三个 30 条分片实际约落在 70–80 个不重复直播间。冷门分区会夹杂空分片（实测 `factorio` 有 20 个语言返回空），所以空页不代表结束：`has_more` 只在分片列表本身走完时才为 `false`，让「加载更多」能越过空分片继续扫到后面仍有内容的语言。

这条路径不需要隐藏 WebView、完整性令牌、Twitch 账号、Cookie 或 OAuth app secret，桌面与 Android / iOS 行为一致。代价是排序不再是全站统一的观众数降序，而是「分片内按观众数降序」的分段拼接；这是换取移动端可用深度分页与去掉风控依赖的取舍。分片能力仍取决于 Twitch 的公开网页接口，其可用性可能随上游变化。

播放时，适配器按频道 login 获取短时 HLS 播放许可，并立即解析 master playlist。短时 URL 不保存到前端缓存；在真正播放或切换清晰度时重新获取，以避免过期 token 被复用。GraphQL 请求附带 `X-Device-Id`：Twitch 网页客户端始终发送该头，缺失会被识别为未知客户端，而这是决定令牌是否被服务端插播广告的信号之一。该值是每个进程随机生成的 32 位小写字母数字，不落盘、不来自机器标识，也不关联账号。

### 广告占位规避

Twitch 的广告插播由服务端在签发播放令牌时决定，令牌申请所用的 `playerType` 是决定因素之一，而且**不同 `playerType` 的结果并不相同**。对 `kaicenat` 连续采样 6 次（每次间隔 15–20 秒），各档位判定完全稳定：

| `playerType`          | 是否被插播 | 清晰度阶梯                     |
| ----------------------- | ---------- | ------------------------------ |
| `site`（主令牌）      | 否         | 7 档，最高`1080p60 (source)` |
| `popout`              | 否         | 7 档，最高`1080p60 (source)` |
| `autoplay`（android） | 否         | 3 档，上限`360p`             |
| `embed`               | 是         | 7 档                           |
| `picture-by-picture`  | 是         | 3 档，上限`360p`             |

因此主令牌保持网页默认的 `site/web`（`TWITCH_PRIMARY_PLAYER_TYPE`）：它同时具备「无插播」和「完整清晰度阶梯」两个条件。

需要如实说明测量的边界：上表中 `embed` 与 `picture-by-picture` 携带的广告，其 `X-TV-TWITCH-AD-ROLL-TYPE` 为 `PREROLL`，即随新播放会话签发的前置广告，而不是主播触发的中途广告时段（`commercial break`）。所以该表证明的是「Twitch 按 `playerType` 区别对待」，并不等于证明某个档位能扛过真实的中途广告。同一时刻 `popout` 与 `embed` 拿到的是同一个创意 ID（`Amazon|2488883100494`）却结论相反，这一点是明确的。

命中广告时，本机 `stream_proxy` 会检查 child playlist。除 `stitched` 标记和 `Commercial break in progress` 文本外，还判断 `#EXT-X-DATERANGE` 中的 `X-TV-TWITCH-STREAM-SOURCE`（广告时为 `"Amazon|..."`，正常直播为 `"live"`）——广告分片可能不带任何文本提示，这个属性是更可靠的信号。命中后代理按上表的实测排序依次申请备用令牌：`popout/web`（干净且保留完整清晰度）、`autoplay/android`（干净但降到 `360p`，用清晰度换无广告画面）、`embed/web` 与 `picture-by-picture/web`（实测携带广告，仅作为前两档也被插播时的兜底，因为 Twitch 的按档位判定不保证长期固定）。申请时优先保留当前清晰度，备用档位不提供该清晰度时选择最接近的变体。找到无广告标记的播放列表后，代理在原 localhost 播放地址内完成替换，前端不需要注入 userscript 或连接第三方中转服务。

参考实现 `vaft` 的备用顺序注释为 `embed`/`popout` = Source、`autoplay` = 360p，与本次测到的清晰度阶梯一致。Twitch 的插播判定会随时间变化，因此上述结论只反映测量当时的状态；可运行 `cargo test --lib -- --ignored --nocapture live_kaicenat` 重新测量，测试会打印每个档位的判定、清晰度阶梯，以及不干净时的 `roll_type` 与 `stream_source` 证据。

若所有备用播放列表仍含广告，代理会把广告分片标记为 HLS `#EXT-X-GAP` 并停止低延迟预取，等待正常直播分片恢复。此时不会播放广告占位内容，但画面可能短暂停顿。策略参考 MIT 许可的 [TwitchAdSolutions `vaft`](https://github.com/pixeltris/TwitchAdSolutions/tree/f8f86706daf90daa534b26bce5b2f01238667d5f/vaft) 与 [ttv-lol-pro](https://github.com/younesaassila/ttv-lol-pro)；`vaft` 仓库已经归档，Twitch 也可能随时改变令牌、完整性检查或播放列表格式，因此此能力不保证持续有效。rLive 只改变自己申请令牌的方式，不代理第三方中转服务器，也不绕过订阅或付费内容的访问控制。

## 弹幕与边界

`danmaku_connect` 使用匿名 IRC WebSocket 加入当前频道并接收聊天。匿名身份没有账号写入权限，因此 rLive 不提供 Twitch 弹幕发送、订阅、礼物、支付或频道管理功能。

上游可用性、广告投放、地区、频道状态和网页接口可能变化。请勿同时叠加多个 Twitch 专用广告处理方案，以免不同播放列表改写互相冲突。

- 站点、语言分片分页与播放：`src-tauri/src/sites/twitch.rs`
- 匿名 IRC 弹幕：`src-tauri/src/danmu_rs/twitch.rs`

## 参考

- [twitch-graphql-api](https://deepwiki.com/mauricew/twitch-graphql-api)
- [TwitchAdSolutions](https://github.com/pixeltris/TwitchAdSolutions)
