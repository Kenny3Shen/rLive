# B 站视频（VOD）功能设计

参考实现：PiliPlus（Flutter）。本文的每条 API 契约与技术结论均在 2026-09 实机请求验证过，非文档推断。

## 一、已锁定的产品决策

- 入口：**新增侧栏「视频」目的地**，独立路由 `/video`。现有首页的直播平台条（B站/斗鱼/虎牙/抖音/Twitch）完全不动。
- 头部整行 = 四个内容页签「推荐 / 热门 / 番剧 / 影视」；其下一条**分区条**；再下是内容瀑布流。
- 番剧 / 影视点进去**要能播**（PGC playurl），与 UGC 是两套播放链路。
- 画质走 **DASH**，使用 Video.js 官方 `@videojs/dash-video` 适配器（内部由 dash.js 读取 MPD）。
- **搜索筛选一起做**（结构对齐 B 站 Web 端搜索页）：`/video/search` 结果页顶部——排序是一行可横滚的 chip（复用 `ChipStrip`，与分区条同套横滚/箭头/键盘逻辑），时长 / 分区 / 发布时间是三个独立下拉（`Select`，「当前值 ▾」形态，非默认高亮，首项即默认）。不收进单个「筛选」按钮、无重置按钮（各维度选回首项即默认）。筛选住在 URL（`?order/&duration/&zone/&pubtime=`，默认位不进 URL），换筛选替换历史（与首页换分区同取向）；头部查询条提交新关键词不带筛选参数，新搜索天然重置。分区表由后端 `video_search_zone_list` 提供（搜索 tid 与分区榜 rid 两套 ID，不能复用 `video_zone_list`）。

## 二、可直接复用的现有基础设施（不要重写）

| 能力 | 位置 |
| --- | --- |
| WBI 签名 | `src-tauri/src/sites/bilibili/api.rs`：`wbi_sign_params` / `get_mixin_key` / `parse_wbi_keys` / `now_unix`，含 `MIXIN_KEY_ENC_TAB` |
| cookie + buvid 注入 | `BilibiliSite::headers()` → `cookie_with_buvids` / `merge_missing_cookie_value`；`ensure_buvid()`；`normalize_cookie_header()` 清理粘贴前缀 |
| JSON 请求包装 | `get_json` / `get_public_json` / `get_json_raw` / `get_json_signed` / `get_json_with_map`，统一走 `get_json_request`，`ResponseChecks{Full,Standard,Raw}` 控制校验档位 |
| B 站 Cookie 读取 | `commands/site.rs::resolve_site` 从 SQLite 快照 `(cookie, proxy)`，整条请求头存 `cookies` 表。视频命令照抄这个模式即可，**登录态天然复用** |
| 媒体代理 + Range | `stream_proxy.rs::StreamProxy::start(url, headers, session_id, force_hls, proxy, twitch_ad_recovery)`；headers 逐条透传上游，转发客户端 `Range`，回写 `Content-Range` + `Accept-Ranges: bytes`。**MP4/m4s 分片代理与拖进度条已可用，传 `hls: false` 即可** |

注意：`DEFAULT_REFERER` 是 `https://live.bilibili.com/`（直播用）。**视频接口与媒体 URL 必须用 `https://www.bilibili.com`**。

## 三、API 契约（全部实测）

全局：`Referer: https://www.bilibili.com` + 真实浏览器 UA。

| 表面 | 端点与参数 | 认证 |
| --- | --- | --- |
| 推荐（App API，默认） | `GET https://app.bilibili.com/x/v2/feed/index`，`build=8130300&mobi_app=android&platform=android&device=phone&style=2&column=4` | 匿名可用、免 WBI/appkey 签名，必须带 `buvid` 头。保留 `goto=av/vertical_av` 的横竖混合稿件，过滤广告/直播/PGC。`aid` 在 Rust 本地转换为 `bvid`，无逐条详情回查；画幅取 `dimension` 或 URI 的 `player_width/player_height/player_rotate`。有限并发取批（4 批同发，跨批去重）、批内去重；前端无新增批次即停，刷新可重试。**实测不按 Cookie 个性化**：有无 Cookie 的 `track_id` 前缀、竖屏占比与卡片结构一致，旋钮是设备 `buvid` |
| 推荐（Web API，可选） | `GET /x/web-interface/wbi/index/top/feed/rcmd`，`version=1&feed_version=V8&homepage_ver=1&ps=&fresh_idx=<page>&brush=<page>&fresh_type=4` | **需 WBI**；有 Cookie 才是个性化流，匿名返回通用流。取 `data.item[]`，只保留 `goto=av` 且带 `owner` 的 UGC 条目（其余是直播/番剧/广告卡） |
| 热门 | `GET /x/web-interface/popular?pn=&ps=` | 无 WBI、**匿名可用**。`data.list[]`，`data.no_more` 判尾页 |
| 番剧 | `GET /pgc/season/index/result`，`st=1&season_type=1&order=3&sort=0&pagesize=20&type=1&page=<n>`，其余筛选位一律 `-1` | 无 WBI、匿名可用。`data.list[]` 仅含 `season_id/title/cover/badge/index_show/order`，**无 ep_id** |
| 影视 | 同上，**加 `index_type=102`** | 同上 |
| 分区 | `GET /x/web-interface/ranking/v2?rid=<rid>&type=all` | **需 WBI**、匿名可用。`data.list[]` 结构同热门 |
| PGC 分区 | 番剧 `GET /pgc/web/rank/list?day=3&season_type=1` 取 `result.list[]`；其他 `GET /pgc/season/rank/web/list?day=3&season_type=<n>` 取 `data.list[]` |
| 番剧时间表 | `GET /pgc/web/timeline?types=1&before=6&after=6`（国创 `types=4`）。`result[].episodes[]` **有 `episode_id`** |
| UGC playurl | `GET /x/player/wbi/playurl`，`bvid&cid&qn=112&fnval=4048&fourk=1&fnver=0&try_look=1&web_location=1315873` | **需 WBI**。`data.dash.{video,audio}` |
| PGC playurl | `GET /pgc/player/web/v2/playurl`（响应在 `result.video_info`） |
| season 详情 | `GET /pgc/view/web/season?season_id=` 或 `?ep_id=` → `result.episodes[]` 有 `aid/cid/id(ep_id)` |
| VOD 弹幕 | `GET /x/v2/dm/web/seg.so?type=1&oid=<cid>&pid=<aid>&segment_index=<n>` | **无需 cookie / UA / Referer / WBI**，返回裸 protobuf |
| 稿件详情 | `GET /x/web-interface/view?bvid=` | **需 WBI**（未签名被风控拦下，返回 404 页）。`data` 含 `aid/desc/owner/stat/pubdate` |
| 稿件 Tags | `GET /x/tag/archive/tags?bvid=` → `data[].tag_name` | 无 WBI、匿名可用；与稿件详情并发获取，失败降级为空，不阻断播放 |
| 相关视频 | `GET /x/web-interface/archive/related?bvid=` | 无 WBI、匿名可用。`data[]` 与热门条目同构，一次给全。**含竖屏**（实测 40/200 条），条目自带 `dimension`；相关视频区固定 16:9 缩略图，不因源视频竖屏而拉高列表行 |
| 评论 | `GET /x/v2/reply/wbi/main?type=1&oid=<aid>&mode=<2\|3>&ps=20&next=<cursor>`，WBI 签名 | 签名 + **匿名时不得携带任何 cookie**：实测携带 buvid3/4 的匿名会话只回 3 条并谎称 `is_end=true`（无 cookie 才给全量 20 条）；未签名裸路径被风控后一律 -352，签名路径放行。登录态带完整 cookie 同路径。置顶有两处：`data.top_replies[]` 与 `data.top.upper`（UP 主置顶对象，参考 PiliPlus 两者都解析）。**作者标识**：页面级 `data.upper.mid`（实测两个回复接口都下发）与评论者 `member.mid` 比对得出，条目上没有现成的作者字段 |
| 二级回复 | `GET /x/v2/reply/reply?type=1&oid=<aid>&root=<rpid>&pn=&ps=<20\|10>&sort=2` | 匿名可用（不受 buvid 截断影响）。**pn 翻页有效**；`data.page.count` 是总数；`data.upper.mid` 同主接口下发，作者标识一并标到楼中楼。`ps` 由前端按需给：移动端无限滚动用默认 20，桌面端分页用 10（`video_get_comment_replies` 的可选 `pageSize`）；**`has_more` 必须按本次实际 `ps` 推导**（上游不给 `is_end`），套 20 会让 10 条一页的翻页在 pn=5 就误报到尾 |
| 视频搜索 | `GET /x/web-interface/search/type`，`search_type=video&keyword=&page=&order=&duration=0&tids=0`；筛选位：`order`（click 播放多/pubdate 新发布/dm 弹幕多/stow 收藏多/scores 评论多，空=综合）、`duration`（0 全部/1 <10min/2 10-30/3 30-60/4 >60）、`tids` 大区 tid（0=全部，与分区榜 rid 两套 ID）、`pubtime_begin_s`/`pubtime_end_s`（day/week/halfYear 预设在后端换算成「N 天前零点 ~ 当天 23:59:59」） | 无 WBI、匿名可用。取 `data.result[]`，`numPages` 判尾页。时长为 `duration` 字符串（`H:MM:SS`） |
| UP 主投稿 | `GET /x/space/wbi/arc/search?mid=&pn=&ps=30&tid=0&keyword=&order=<pubdate\|click>` | **需 WBI**。取 `data.list.vlist[]`，条目的时长字段是 `length`（`mm:ss` 字符串）而**不是** `duration`（实测），因此时长取值须做 `duration`→`length` 回退 |
分区 rid（PiliPlus 硬编码，非 API）：全站 0、动画 1005、音乐 1003、舞蹈 1004、游戏 1008、知识 1010、科技 1012、运动 1018、汽车 1013、美食 1020、动物 1024、鬼畜 1007、时尚 1014、娱乐 1002、影视 1001。
搜索 tids（`search/type` 的 `tids` 位，与上面分区榜 rid 是两套 ID）：动画 1、番剧 13、国创 167、音乐 3、舞蹈 129、游戏 4、知识 36、科技 188、运动 234、汽车 223、生活 160、美食 221、动物 217、鬼畜 119、时尚 115、资讯 202、娱乐 5、影视 181、纪录片 177、电影 23、电视剧 11（后端 `VIDEO_SEARCH_ZONES` / `video_search_zone_list`）。
season_type：番剧 1、电影 2、纪录片 3、国创 4、剧集 5、综艺 7。

**`aid` 已是超大整数**（实测 `117191437455648`），Rust 必须 `i64`；跨 IPC 建议序列化为字符串，前端只当标识符，禁止参与算术。

### 推荐源与画幅适配

- VOD 推荐默认使用 APP 主 feed；用户可在「设置 → 播放 → 视频点播」切到 Web API（`x/web-interface/wbi/index/top/feed/rcmd`，需 WBI、`fresh_idx`/`brush` 跟页码）。两条链路**互斥且不静默回退**：切到哪条就用哪条，失败直接报错。
- **App 推荐不基于 Cookie（2026-09 实机消融）**：同设备 `buvid` 下只切换 Cookie，5 轮各 45~47 条的唯一集合交集为 0、`track_id` 前缀恒为 `all`、竖屏占比与卡片结构一致；去掉 `buvid` 头后（无论有无 Cookie）立即降级为 `gateway_fb_*` 兜底流、竖屏恒为 0。因此**设备轴的旋钮是 `buvid`，不是账号 Cookie**。Web API 推荐则相反：有 Cookie 才是个性化流。两条链路的这个差异是设置项存在的理由。
- **App 推荐的账号轴是 `access_key`（2026-10 实机扫码验证）**：`app.bilibili.com` 是 APP 域，账号个性化只认 APP 登录 token（`access_key` 参数 + appkey/`sign`），与 web 的 `SESSDATA` 互不相通。用户可在「设置 → 账号 → 平台账号」最上方的「Bilibili TV 账号」用 TV 扫码取得独立凭据；**授权即生效，没有单独开关**（本机存在凭据就用，移除授权就回匿名，两套状态合并成一套）。生效后 App 推荐与 story 两条流都带 `access_key`，其余接口不受影响。凭据失效时直接报错，**不静默回退匿名**。凭据存本机 SQLite（`bilibili_app_auth`，与 Cookie 一样未额外加密）、不随配置导出。
- **同一份 TV 凭据也用于直播首页推荐（2026-10 实测）**：直播 Web 域的首页推荐接受**裸 query 参数** `access_key`（免 appkey/sign，带签名也接受），因此无需第二次扫码就能让直播首页按同一个账号个性化。以下实测结论决定了实现形状：
  1. **身份完全由 query 里的 `access_key` 决定**：有效凭据 + 坏 Cookie 仍是登录态，坏凭据 + 有效 Cookie 掉匿名（各 4/4 复现）；把 `access_key` 放进 **Cookie 头完全无效**。因此这条路径刻意只带凭据、不带 Web Cookie。
  2. **凭据必须严格限制在推荐路径上**：把有效 TV 凭据发给 **web-room 系**房间接口会得到 `-663 鉴权失败`（实测 `web-room/v1/index/getInfoByRoom`、`web-room/v2/index/getRoomPlayInfo`，裸 `access_key` 与 appkey+sign 两种形态都一样），而 `nav`、`relation/followings` 等 Web API 则一律 `-101`。这个 `-663` 的触发条件是「有效 TV 凭据 + web-room」，**不是「缺 Web Cookie」**——同一批端点匿名或仅 WBI 签名访问都正常（实测）。端点白名单在 `account/bilibili_app.rs` 的 `live_recommend_endpoint`，凭据注入只发生在 `commands/site.rs` 的 `resolve_recommend_site`。
  3. **存在接受 TV 凭据的 app-room 变体，但不采用**：`app-room/v1/index/getInfoByRoom` 与 `app-room/v1/index/getDanmuInfo` 带 appkey+sign 签名可用（实测 `code=0`；弹幕路径还不需 `nav`/WBI 密钥）。不切的原因：房间详情版字段集不同（少 `is_studio`/`live_id`、多一批 APP 专用字段）且必须带 `platform`+`device`+`build` 三件套否则 `-400`，要额外维护一套兼容；弹幕现路径工作正常，切过去只省一次 `nav`，不值得多一层条件分支。播放地址无可用 app-room 变体（一律 `-400`）。
  4. **失败是静默降级**：无效令牌返回 `code=0` 的匿名流（`trackid` 为空）或 `rec-fallback-live-*` 回退流。唯一可靠的判定信号是 `trackid` 前缀 `live_feed_0.router-live`，因此 `live_recommend_is_personalized` 为假时**按失败处理并回落到 Cookie／匿名路径**，绝不把匿名流当个性化结果展示。
  5. **回退流是抖动的、需要重试**：实测续页约 1/15~1/20 次返回 `rec-fallback-live-*`（经代理时更明显）。回退流内容与个性化流不同、也可能为空，而**空续页会被前端当成上游耗尽**（用户看到「滚到一半不动了」），因此 `live_recommend_with_retry` 有界重试一次，仍失败才上报错误；`bilibili_app_auth_required` 不重试。
- **直播首页推荐的取流形状**：第 1 页用 `xlive/web-interface/v1/index/getList`（含「我的关注」模块与置顶已关注主播，与 Web Cookie 路径同一解析器）；第 2 页起用 `xlive/web-interface/v1/webMain/getMoreRecList`（`platform=web&web_location=333.1007&page=<n>`，实测相邻页互斥、可无限翻，`page` 只当轮换种子而非稳定偏移）。匿名与 Cookie 路径仍走原来的 `getListByArea`／`index/getList`，未改动。
- **首页凭据失败不报错，只回落**：直播首页是默认浏览表面，不能因为一条 VOD 凭据过期而整页不可用。这与 VOD 侧刻意不同（那里用户显式选了 App 接口，失败必须报错而不是偷偷换流）；失效本身仍由启动期检查与设置页状态提示暴露。回落是**整条链路**的：第 1 页回落即走 Cookie／匿名首页（`index/getList` 或 `getListByArea`，单页无游标，`has_more` 为假），第 2 页起回落则返回匿名首页的第 1 页（首页无游标接口没有「第 N 页」的概念），前端靠跨页去重与「本页无新增即停」自然收敛。
- **双账号错位**：若 Web Cookie 与 TV 凭据属于不同账号，直播首页推荐按 **TV 凭据的账号**呈现，而房间详情、弹幕与发送仍按 Web Cookie。这个事实只写在文档里（用户指南 4.1 与本设计），设置行刻意不放常驻说明文案 —— 账号行只回答「这个账号是谁、什么状态、能做什么」，与其余平台账号行同密度；`isBilibiliAppQuery` 把直播首页的查询键纳入授权失效范围，换账号后首页缓存会重取。
- **播放地址依赖 Web Cookie 的真实理由**：不是「TV 凭据不能用于播放」（正确说法是它被 web-room 拒绝），而是登录态本身影响清晰度 —— 实测同一房间匿名 `current_qn=250`（最低档），带 Cookie 才默认 `current_qn=10000`（原画）。
- **自动续期（2026-10 实机验证）**：端点为 `POST passport.bilibili.com/x/passport-login/oauth2/refresh_token`（**不是** `api/v2/oauth2/refresh_token`，后者对 TV 凭据恒返回 `-101 账号未登录`），只需 `refresh_token` 一个业务参数，其余为 appkey/ts/sign。两个触发条件：本机时间距到期不足 24 小时（主动，带 1 小时进程内限速，避免时钟偏快时每请求刷新一次），或服务端拒绝了 access_token（被动）。实测 access_token 即使已被服务端拒绝，刷新仍能取回可用凭据，因此「过期」不再等于「必须重新扫码」；只有刷新令牌也失效（`-101`/`-400`）才需重扫。错误分类：`-101`/`-400` → 需重新扫码，`-3`（签名）/未知码 → 可重试。
- **续期会轮换 `access_token` 与 `refresh_token`**：新凭据必须落库，否则下次请求仍用旧值重试；实测旧 `refresh_token` 轮换后仍可用，所以「刷新成功但落库失败」可以安全重试，且并发刷新不会使先写入者失效。刷新后的 `access_token` 实测为 220 字符（含连字符，旧为 32 位纯字母数字），`valid_opaque` 的长度上限 512 能容纳这一形状。
- **失效检测只能依赖 `oauth2/info`（2026-10 实测）**：`app.bilibili.com/x/v2/feed/index` 对无效令牌、错签名、错 appkey **一律返回 `code=0`**（静默降级匿名流），因此推荐请求本身无法暴露失效。检测链只有一条：启动期后台校验 + 设置页状态查询 + 推荐失败时的错误码提示，三者共用 `oauth2/info`。由此推出两个实现约束：（1）`feed` 保留本地到期守卫作为长会话期间的最后一道防线，否则令牌中途到期会静默换流；（2）无法用 feed 的响应码判断凭据好坏，不要把 `code=0` 当成“仍有效”的证据。
- **`oauth2/info` 的错误码分类（实测）**：`61000`（篡改字符、refresh_token 冒充）与 `-101` 判为失效；**格式合法但不存在的 access_key（含随机 32 位字符串）返回 `-400`**，与真正的参数错误（缺 `ts`、空 `appkey`）同码，因此凭据格式已合法时把 `-400` 也判为失效——否则用户会看到「稍后重试」而重试永远不会成功。`-412`（风控）、`-500`、未知码仍归为可重试的 `bilibili_app_auth_unavailable`。HTTP 非 2xx 不判失效（网关/风控不能证明令牌坏了）。
- **服务端寿命是权威值**：`oauth2/info` 返回的 `expires_in` 实测是**剩余**寿命（相隔 45 秒的两次请求差 47 秒），校验成功时换算成本机时钟下的绝对到期并写回 `bilibili_app_auth`，可纠正本机时钟偏差。服务端确认有效但未返回寿命时**不**回退本地值：本机时钟可能偏快，拿一个已过的本地期限会让紧随其后的 feed 立刻拒绝一个刚被服务端接受的令牌（此时 `AppAuth` 不设本地期限，只保留路径与设备校验）。
- APP 主 feed：`page` 仅兼容既有 IPC，不是上游游标；单次**并发**取 4 批（每批 9~11 条，跨批去重后中位 31 条），跨页完全重复时暂停自动补货。并发而不是串行：该接口的批次彼此独立，并发取回不同窗口（与 story 服务端按时间推进的轮换游标不同）；串行 3 批固定付出约 1.5s 的等待，因为带 `buvid` 的单批请求实测约 500ms。详见[性能优化](性能优化.md)「问题四」。
- APP 返回的播放/弹幕统计常是「万/亿」格式的显示近似数，映射结果不是精确计数；作者 UID、标题、画幅与取流键在 Rust 统一归一化。
- **屏蔽 UP 主（2026-10）**：名单按 `author_mid`（UID）匹配，不按昵称 —— 改名不失效、同名不误伤；**缺失 `author_mid` 的条目永不被过滤、也不提供屏蔽入口**（宁可少屏蔽不可错屏蔽）。过滤是渲染前的纯函数（`filterBlockedUploaders`，名单为空时原样返回同一数组引用，零成本），不改分页游标、上游请求次数与 `has_more`；`VideoCard` 桌面右键 / 触摸长按弹出菜单调用 `blockVideoUploader(mid)` 并 `notify.success`。覆盖推荐、热门、分区、搜索、相关视频、UP 投稿抽屉与短视频流；**播放页自身不被屏蔽**（点链接直进仍可看，屏蔽只作用于列表），`UploaderDrawer` 也不过滤（用户已主动进入该作者主页）。名单上限 500、单条 20 字符，存入 `AppSettings.video_blocked_uploaders`（随配置导出/导入与局域网同步，与屏蔽词同一合并策略）。短视频流在**合并器入流时**过滤而不是渲染前，否则被屏蔽条目会占着下标使补货窗口永远凑不满。回归：`tests/video-uploader-block.test.ts`（归一化/上限/缺失 UID 不过滤/合并器过滤与补货阈值）与 `tests/video-card-block-uploader.browser.js`（真实 WebView2 上的桌面右键、触摸长按、无 mid 时无入口）。
- VOD 发现页四个页签与搜索结果使用 `VideoMasonry` 瀑布流，沿用响应式 2–6 列。以细网格行跨度承载卡片自然高度，追加分页不重新分列，保留 DOM / 键盘顺序、滚动锚点与卡片身份。`ResizeObserver` 在列宽、字体和内容变化时更新跨度；不支持时退回普通网格。分页哨兵仍在完整列表之后。
- VOD 列表与 UP 投稿抽屉的 `VideoCard` 默认按 `dimension` 设置封面比例；旋转标记非零时交换宽高，未知尺寸与 PGC 保持 16:9。**相关视频**显式使用 `coverAspect="landscape"`，桌面侧栏和移动端相关页签均固定为横屏缩略图，源内容不被过滤。
- 回归：`tests/video-masonry.browser.js` 验证补位、分页追加不移位、尺寸变化与底部哨兵；`tests/video-card-aspect.browser.js` 验证源画幅、横屏覆盖及真实相关视频区。
- 推荐页签的列表 query key 带推荐源（`video_list/recommend/…/app|web`）与 App 授权状态（`appPersonalization`/`appAuthRevision`），切换设置或换授权后旧缓存不被当作新鲜数据复用；story 的 `shorts_story` 由 `bilibiliAppQueryInvalidation` 在授权变更时取消并重置。Cookie 变更只失效 `video_list` 的推荐页签（`cookieQueryInvalidation`），热门/番剧/影视不随之重取；App 授权变更也不触碰 Web 推荐缓存。
- 推荐、通用 story、作者 story 统一通过 `get_app_feed` 分发：默认走 `get_json_with_buvid_header`，**仅当**本机存在「Bilibili TV 账号」授权且路径是主推荐或 `/story` 时改走 `AppAuth::feed`（TV appkey 签名 + `access_key`、禁止重定向、脱敏错误、绝不携带 Web Cookie）；作者 story 是普通游标列表，即使站点实例持有凭据也保持匿名路径。三条流共用 Cookie、代理、设备槽和错误处理。**不等于所有 B 站接口都换域**：详情、搜索、热门、播放、评论、弹幕仍使用已验证的 `api.bilibili.com` 端点；APP 域同路径 `/x/web-interface/view` 实测 404，APP `/x/v2/view` 在本次免签名参数下返回 -400，不能仅替换 host。未验证的 APP 等价能力不替换既有播放与账号权限链路。
- `/shorts/bilibili` 点头像/用户名可进入作者 story，从当前稿件继续，上方居中显示上游 `index/total`；详见[短视频功能](短视频功能.md)「UP 主竖屏流」。

## 四、DASH：三个关键实测结论

### 1. `segment_base.index_range` 是 sidx box，可解析出完整分片表

`playurl` 每个 representation 给 `segment_base: { initialization: "0-937", index_range: "938-1601" }`。按 `index_range` 发一次 Range 请求拿到的正是 `sidx` box。实测解析出 52 片 / 5s 一片 / `timescale=16000`。

每片自带 `moof`+`mdat`，且 `tfdt` 与 sidx 累加时间轴**精确相等**（逐片核对 seg0/1/5/51 全部 match）。init 段只有 `ftyp`+`moov`。时间轴一致不能替代播放器的顺序约束，生产链路仍使用既有按序媒体代理。

同一画质有多编码变体（avc1 / hvc1 / av01）并列，**选流必须按 codec 过滤**，默认取 `avc1` 兼容性最好。

播放页使用 Video.js DASH 适配器，与取流 IPC 并行准备；后端 `video_play_selection` 用 `tokio::join!` 并发获取音/视频两条互不依赖的 sidx，减少一次串行 CDN 往返。取流时一并取得的 init 字节保留在对应代理会话内：播放器精确请求整个 init Range 时直接返回本机 206，无需开启磁盘缓存；其他 Range、无 Range 或带 `If-Range` 的请求照常回源。字节随会话释放，不缓存完整媒体文件。该链路供 UGC/PGC、横竖屏与仅音频模式共用；各轨候选 CDN 回退仍按序执行，选流、错误优先级、MPD 标准分片时间轴与媒体代理顺序不变。

### 2. CDN 分主机行为不同 → 必须走代理

| 主机 | 无 Referer | CORS |
| --- | --- | --- |
| `*.mcdn.bilivideo.cn` | 206 可用 | `ACAO=*` |
| `*.edge.mountaintoys.cn` | **403** | `ACAO=*` |
| `upos-*.bilivideo.com` | **403** | **无 ACAO** |

不能赌 base_url 落在 mcdn 上，**一律经 `stream_proxy` 注入 Referer**。

### 3. DASH MPD 与 B站分片边界

- 后端解析 `segment_base.index_range` 的 sidx box，并把每轨初始化范围、`mediaRange` 与逐片标准时间信息写入 `SegmentList`；Video.js DASH 适配器直接交给 dash.js 解析，不依赖前端私有分片表补丁。
- 每个 `<SegmentURL>` 携带准确的 `mediaRange`，代理向上游转发 Range；不同 CDN 主机仍统一经过 `stream_proxy` 注入 Referer。
- 视频和音频轨分别使用自己的 timescale、初始化范围和分片范围；播放器接收 HTTP `mpd_url`，不转换成 blob URL。
- 无声稿件（`dash.audio` 为 `null`/空，`dolby`、`flac` 也为空，如 `BV1LAa56JEkC`）音轨为 `None`：MPD 只声明视频 AdaptationSet，不起音轨代理也不预取音轨；「仅播声音」直接报错而不是等一条不存在的音轨。

### 已验证的浏览器结论

Python/本地媒体服务模拟 stream_proxy（注入 Referer + 转发 Range）+ MPD + Video.js 官方适配器，Chromium 实跑：

- 播放正常：`HTMLVideoElement.readyState: 4`，视频轨与音频轨均解码。
- **seek 成立**：跳到中后段后重新出现有效 `buffered` 区间并继续播放。
- 同一 `<video>` 的 HLS、FLV、裸 MPEG-TS、DASH 与原生 MP4 适配路径均可出画；同协议切源等待 `canplay` 后才提交，用户暂停状态保留。

sidx 解析、DASH 选流与 MPD 生成位于 `src-tauri/src/sites/bilibili/video/dash.rs`；网络取流与点播业务编排仍在 `src-tauri/src/sites/bilibili/video.rs`。对外类型与函数通过 `sites::bilibili::video` 重导出，命令层沿用原调用路径。

## 五、VOD 弹幕

分段索引与 protobuf 解码位于 `src-tauri/src/sites/bilibili/video/danmaku.rs`，HTTP 请求保留在 `video.rs`，复用现有站点客户端。

- 6 分钟一段：`segment_index = floor(ms / 360000) + 1`。
- **越界返回 HTTP 304 + `bili-status-code: -304`**，这就是停止条件（不是空 body）。
- PGC 同接口，`oid` 取该集 cid。实测 `pid` 传对、传错、不传，响应字节数完全一致 → `pid` 可省。
- 旧 XML 接口（`/x/v1/dm/list.so?oid=`、`comment.bilibili.com/{cid}.xml`）仍活着，裸 deflate（`zlib.decompress(d, -MAX_WBITS)`），但 `maxlimit` 截断在 3600 条。**采用 `seg.so`**：官方在用、字段全、可按播放进度懒加载。

protobuf schema（已与实测字节逐字段核对，可手写 varint 解码，不引运行时）：

```proto
message DmSegMobileReply {
  repeated DanmakuElem elems = 1;
  int32 state = 2;
  DanmakuAIFlag ai_flag = 3;
  repeated int64 segment_rules = 4;
  repeated DmColorful colorful_src = 5;
  string context_src = 6;
}
message DanmakuElem {
  int64  id = 1;
  int32  progress = 2;    // 出现位置，ms —— 调度用这个
  int32  mode = 3;        // 1/2/3 滚动 4 底部 5 顶部 6 逆向 7 高级 8 代码 9 BAS
  int32  fontsize = 4;
  uint32 color = 5;       // RGB 十进制
  string mid_hash = 6;
  string content = 7;
  int64  ctime = 8;
  int32  weight = 9;      // [1,10]，屏蔽等级
  string action = 10;
  int32  pool = 11;       // 0 普通 1 字幕 2 特殊
  string id_str = 12;
  int32  attr = 13;       // bit0 保护 bit1 直播 bit2 高赞
  int64  like_count = 15;
  string animation = 22;
  string extra = 23;
  DmColorfulType colorful = 24;
  int32  type = 25;
  int64  oid = 26;
  DmFromType dm_from = 27;
}
```

实测单条 elem 出现的字段：1,2,3,4,5,6,7,8,9,12,15,20,21,25,26,27（20/21 不在 schema 内，跳过即可）。顶层出现 1,4,5。

### 弹幕发送（`video_danmaku_send`）

- 写入接口 `POST https://api.bilibili.com/x/v2/dm/post`：表单 `type=1&oid={cid}&aid={aid}&msg&progress={毫秒}&rnd={微秒时间戳}&color=16777215&fontsize=25&pool=0&mode=1&plat=1&csrf`，携带 SESSDATA Cookie。三个关键字段的对齐依据（参考 PiliPlus 的 `DanmakuHttp.shootDanmaku`）：`aid` 参与表单（上游要求稿件标识，缺失被 -400 拒绝）；`progress` 单位是毫秒（此前按秒发送导致弹幕落在 1/1000 的错误位置）；`rnd` 缺省时上游把连续发送的冷却放大到 90 秒（带上为 5 秒），本地 3 秒冷却的第二条会直接撞上它。与直播 `msg/send` 同一套凭据检查（同一设置项 `danmaku_send_enabled`）、同一 3 秒冷却（`DanmakuSendLimiter`，键用稿件 aid——同稿件各分 P 共用一个冷却）与发送历史（`danmaku_send_history`，room_id 存 aid）。
- 错误映射在直播语义之上补两条 VOD 专属：`-102` 账号权限不足（部分视频要求正式会员）、`616` 内容被过滤。不做重试、不产生乐观本地回显。
- 前端复用直播的 `DanmakuComposer`（`video` prop 切换目标：cid/aid/progressMs 入参，毫秒与上游 progress 对齐），所有尺寸均挂在控制栏居中槽位（`centerSlot`），按两侧按钮组的实际宽度预留对称空间。显隐随控制条，快捷表情/收藏/历史选择器同套可用；**键盘焦点在控制条内（正在输入弹幕）时控制条不休眠**，否则输入到一半会被闲置计时器连草稿一起淡出。

### 飘屏弹幕点击操作

- 视频画面内的滚动、顶部和底部弹幕复用直播的 `DanmakuActionMenu`：点按文字临时定住该条弹幕并显示选框，可复制原文、收藏和发送相同弹幕（+1）。只冻结所选弹幕，不暂停视频或其他弹幕；再次点按同条、点按其他位置或超过 20 秒会解除，媒体暂停时解除不会擅自恢复播放。
- 直播与视频通过 `useDanmakuPinInteraction` 共用点按委托、外部关闭和超时释放。按下时记录目标，松开时认领短促点按，避免移动中的文字错过命中；视频的位移阈值与播放器保持一致，长按倍速和侧边调节不被菜单抢占，操作按钮也不触发暂停或双击全屏。
- 顶部 HUD 的标题、渐变遮罩与留白不接收指针，点击穿透到下方弹幕或画面；只有 `data-visible="true"` 时可用的按钮恢复命中。桌面、移动端和全屏共用这一规则，隐藏或禁用的按钮不留下透明点击区域，返回和更多操作按钮及其弹层保持可用。
- 视频的 +1 使用 `video_danmaku_send`，携带当前 `cid`、稿件 `aid`、视频标题与**点击 +1 时的播放位置（毫秒）**，不沿用所选弹幕的原始时间，也不调用直播发送接口。收藏继续进入 B 站共享弹幕收藏；发送沿用账号发送开关及后端 Cookie/权限/冷却校验，未启用或视频身份未就绪时按钮禁用，失败显示视频场景提示，不做乐观发送回显。
- 拖动进度、切换视频、关闭弹幕及卸载时释放选中与冻结状态；全屏手势锁开启期间禁止弹幕点选。菜单与选框留在播放器舞台内，兼容普通与全屏布局。VOD 条目没有可用的作者昵称，不提供屏蔽用户操作；侧栏弹幕列表仍保持点击跳转播放位置的原有行为。

### 弹幕查看列表（`VideoDanmakuList`）

- 侧栏独立「弹幕」选项卡，与相关视频/评论/合集同级（顺序：选集（多 P 时）、相关视频、弹幕、评论、合集），仅 UGC 显示（PGC 分集同接口可用但当前先覆盖 UGC 主场景）。面板自持滚动视口（跟随播放需要独占滚动位置）。
- 全量渲染已加载条目（时间戳 + 内容，条目颜色还原），行级 `content-visibility: auto` + `contain-intrinsic-size` 让浏览器跳过屏外行的布局与绘制，上万条也不拖垮滚动；**每行是跳转按钮**——点击任意条目（含未来条目）即 seek 到该弹幕出现的播放位置。
- 跟随播放进度：跟随行是播放头**之前**那一条（用户在列表里看到的与画面上刚飘过的是同一条），把它滚到视口中央。判定与几何在 `videoDanmakuFollow.ts`，组件只负责接线。
  - **「贴底」不是恢复信号**。直播 `DanmakuPanel` 是增量信息流，底部就是最新，所以贴底既是跟随目标也是恢复跟随的条件；这里是一整条静态时间轴，跟随行通常落在列表中部。照搬那套「滚回底部恢复跟随」的结果是滚到底就重新武装跟随、下一个 `timeupdate` 又把列表拽回播放头——即「滚到底部会回弹」。恢复只认显式意图：点「回到当前进度」浮动按钮、点条目跳转、拖进度条（按 `positionMs` 跳变超过 `1.5s` 判定，正常播放步长约 `250ms`）。
  - **程序化滚动必须与用户滚动可分辨**。跟随自己写 `scrollTop` 也会派发 `scroll` 事件，若不加区分就会自我关闭跟随。落点回读后记为锚点，`scroll` 事件按「相对锚点位移是否超过 `32 px`」判断；锚点不随漂移更新，否则慢速拖动的每一小步都在容差内、永远攒不出用户滚动。容差要盖住 `content-visibility` 下屏内行实现真实高度时滚动锚定造成的几 px 漂移。
  - 滚轮立即停跟随（触控板一次只滚几 px，靠位移阈值会让手势开头被反复拽回）。触摸必须**按方向**判：本视口同时是侧栏横滑切页签的起手区，只看「有没有 `touchmove`」会让左右滑页签顺带关掉跟随，因此要求纵向位移过 `8 px` 且压过横向位移。拖滚动条与键盘翻页不派发指针类事件，由 `scroll` 那条兜底。
  - 跟随滚动写 `scrollTop` 而不用 `scrollIntoView({ block: "center" })`：后者在跟随行已经位于视口内时可以什么都不做（规范允许「已可见即不滚动」），跟随会停在半屏位置不再居中；它滚的又是最近的可滚动祖先，本面板嵌在横滑条带里，选错祖先会把条带带偏。目标值夹紧到 `[0, scrollHeight - viewportHeight]`——越界时浏览器自己会夹，写进去与读回来不一致就会自误判。
  - 跟随 effect 依赖 `followIndex` 而不是 `positionMs`：后者约 4Hz 跳动，每跳都重滚会与滚动锚定互相推挤。列表按 `cid` 重挂，换视频后不带着上一条的跟随状态。
- 数据直接来自播放页 `danmakuEntries`（懒加载已合并的段数据），不额外请求。加载态由「在途请求计数 + 是否有段落定」驱动：空列表只有在首段已落定且没有在途请求时才显示「暂无弹幕」，否则无弹幕视频的弹幕栏会永远转圈（旧实现以 `entries.length === 0` 当 loading，空段落永不落定即无限加载）。在途请求持有段 map 的引用，换视频（换 cid 重置 map）后回来的旧响应据此丢弃，不会污染新视频的弹幕。

## 六、清晰度切换与右侧栏

### 清晰度

- 菜单复用 `PlayerControls` 既有的 `qualities/qualityIndex/onQualityChange` 约定（录制回放同源），不可用档位列出但置灰并提示「登录或大会员后可用」。
- 切换 = 记录当前位置与播放状态 → 带 `qn` 重取 play-info。新的代理端口 = 新的 MPD 地址，播放器必然重建；DASH 在首次 source 上携带 `#t=秒` 的 MPD anchor，让引擎直接调度目标分片，metadata 回调只恢复播放意图、不再二次 seek。仅音频的原生媒体仍在 metadata 就绪后赋 `currentTime`。
- 重取期间 `keepPreviousData` 保留同内容旧数据：旧播放器继续播到新信息就位，不黑屏。交接时重新读取旧播放器的最新位置与播放/暂停状态，覆盖点击切换时的快照，避免请求期间继续观看、seek 或暂停后被回滚；新播放器尚未建立有效位置就失败时，不用它的 0 秒覆盖断点，后续重试继续沿用原快照。

### 右侧栏（`VideoSidebar`）

- UGC 页签顺序：选集（多 P 时，含折叠合集）/ 相关视频 / 评论 / 弹幕（最右）；仅合集（无分 P）时第三个页签显示为「合集」；PGC：分集 + 评论。宽屏在右（320px，xl 340px，与直播/IPTV 播放页侧栏同宽），窄屏列在播放器下方滚动。
- 页签条之上的 UP 主信息卡：头像与 UP 名点开投稿抽屉，中间是稿件标题一行。**标题整行就是简介/Tags 的展开-收起开关**（`aria-expanded` + `aria-controls`，箭头跟在文字末尾，两端都不带底色）；卡片下方第一行是统计行（播放/评论/发布时间，以及日期右侧的当前在线人数）—— 四项用同一档 `gap-x-2` 间距、不插竖线，图标 12px、字号 11px 且数值一律 `text-muted-foreground` 不加粗（播放不再用平台粉，评论不再用前景色加粗），事实数字读成安静的一行。当前在线人数仅显示数量（保留图标、悬停提示与无障碍标签，不追加「在线」字样），走独立 `video_get_online_total(bvid, cid)`，相关视频页签可见时每 30 秒刷新，读取 `/x/player/online/total` 的 `data.total` 并保留「万+」等上游格式，不用仅 Web 端的 `count` 或累计播放量代替；接口失败、空值或 `show_switch.total=false` 时不展示。统计行**不换行**：退到 11px 就是为了让「播放 + 评论 + 完整日期时间」在 320/340 侧栏里单行放下，极端缩放/超长数值下宁可各自收窄省略；收缩权重按重要性分配（`shrink-[3]` 给播放与评论、`shrink-[0.5]` 给日期），日期最后才动。**稿件详情未落定时先画同几何的卡骨架**（`UpCardSkeleton`）：真卡是「相关视频」内容区的第一块而不是页签之外的东西，从前只在 `archive` 到位后才渲染，于是移动端冷启动（`archive` 与 `related` 同时在途）会先看到一条没有 UP 主卡的相关列表，数据到达后整块内容再被往下推一次；骨架与真卡的 `section`/卡壳/头像（40px）/标题行（24px）/统计行（16px）高度逐项对齐（实测两侧都是 123px），到位时只有内容替换。骨架只在 UGC 出现（PGC 没有这张卡），`archive` 失败时不冒充成功（不画骨架、也不画卡）。视频简介默认不显示，点标题才展开（换稿件重挂复位）；**标题在收起态单行截断（卡片高度与骨架几何固定，长标题不再把卡撑高），展开后换行显示完全体**（`break-words` 同时覆盖无空格的拉丁串），箭头从文字末行落到最后一行（`items-end` + `mb-[3px]`，单行时与原来的垂直居中同高），展开态也不再挂 `title` 提示（文字已全可见）；没有简介也没有 Tags 时标题退化成不可点的普通行（`hasArchiveDetail`）；展开的简介用 Base UI `Collapsible`（`keepMounted`，收起态由基料挂 `hidden`）挂在卡片里，让 `aria-controls` 在收起态也能解析到目标；展开/收起是 `--collapsible-panel-height` 的高度过渡（150ms、`--motion-ease-out`、`data-starting-style`/`data-ending-style` 两端归零），快速连点可从当前帧反向，不再是一步跳变的显隐；`motion-reduce:transition-none` 尊重系统的减少动态偏好。稿件 Tags 位于简介正文末尾，使用可换行的 `Badge` 展示，点击 Tag 进入 `/video/search?q=<tag_name>`；Tags 接口失败或为空时不显示。统计行不再与 24px 的图标按钮（粗指针下 `min-w-11` 更高）同排，行高因此回落，卡壳下边的留白与顶部一致；标题行的可点区域是整行宽度，不必瞄准箭头。列表页 UGC 卡片同样显示发布时间（`VideoItem.pubdate`）：推荐/热门/搜索自带 Unix 秒，UP 主投稿列表只给 `created`（北京时间字符串 `yyyy-MM-dd HH:mm`），后端 `created_to_unix` 按 UTC 解析后减 8 小时还原，缺失为 0 前端不渲染；同一列表的时长同样要兼两种字段形状：`item_duration` 先取 `duration`，为 0 时回退 `length`（投稿列表只给 `length`，漏掉这一路会让抽屉里每条都显示 `0:00`）。卡片标题恒占两行（`min-h-[2lh]`），一行标题的卡片靠占位把日期/UP 主行压到相同纵向位置。**播放/弹幕已从文本块搬到封面左下、与右下时长同一排，且三个角标都不带底色**（2026-10）：卡片少一行文字、瀑布流更紧凑，统计也贴着封面读。无底色就得靠 `--text-shadow-cover` 的双层投影把白字从任意封面上拉出来（贴边一层给轮廓、外扩一层压住花纹），否则浅色封面上白字读不出来；推荐理由仍是带底色的药丸，因为它是运营标签、要读作一块标签而不是一个数字。播放与弹幕之间只用间距分隔、不插竖线：三者都无底色时竖线会成为这一排里最重的一道黑，把两个数字拆成两件事。统计可收缩、两个数字各自 `truncate`，时长固定不缩，窄卡（xl 六列约 184px）遇上六位数统计也不会把时长挤出封面；行式卡（相关视频、UP 投稿抽屉）的缩略图只有 2/5 列宽放不下这一排，统计仍留在文本块第三行，因此文本块行数按 `orientation` 分叉（网格两行、行式三行）。回归见 `tests/video-card-stats.browser.js`（断言计算样式与几何关系，而不是类名字符串：加回底色、插回竖线、或把统计放回文本块都会失败）与 `tests/video-sidebar-upcard-layout.browser.js`（侧栏 UP 卡的标题开关、收起单行截断/展开显示完全体且箭头落到末行、统计行等距/不换行/不加粗、卡壳上下留白相等、两端无底色）。
- 多 P 稿件（`pages` ≥ 2）自动展示「选集」页签并接管连播列表：点任意 P 跳转（同 bvid、按 cid 取流），当前 P 按 cid 高亮。选集与合集共用一个页签（`PartsSeasonPanel`）：同时存在时选集展开、合集折叠成标题行（点击展开，连播沿分 P 列表走）；无分 P 的合集直接展开、连播沿合集走。两区标题行都是收起开关（`ChevronDown` 旋转 + `aria-expanded`）：选集行左侧「选集」、右侧「共 x P」计数，点按切换列表显隐；收起态不跨稿件沿用（`PartsPanel` 以 bvid 为 key，换稿件重挂即默认展开），收起后再展开会把当前 P 重新滚回可视区。
- 评论的 `oid` 是 aid：列表/分集链路经路由参数携带；URL 直入时 UGC 用稿件详情补齐，PGC 用 season 详情里当前集的 aid。
- 评论列表使用游标翻页（`next`），每条主评论直接展示接口附带的部分二级回复预览与「共 N 条回复」入口；点击主评论、回复预览或入口即展开以主评论为楼主的完整回复，二级回复使用 pn 翻页（首传 1）。**展开形态按客户端分端**，判据是 `isMobileClient()`（与侧栏横滑手势、弹幕设置面板同一判据：按输入模态分野，不按视口宽度）：
  - 移动端（触摸）：二级抽屉，无限滚动，页大小用后端默认 20。详情从侧栏右侧进入，手机竖屏时仅覆盖播放器下方的侧栏。抽屉打开期间**点播放器不再把它收掉** —— 侧栏里的局部抽屉是非模态的，base-ui 的 `outsidePress` 原本会吞掉任何落在抽屉与遮罩之外的点按，而播放器正是那块区域；因此显式 `disablePointerDismissal`。退回一级只剩两条路：表头返回按钮与系统/手势返回（Android 返回键经 `dismissTopmostPopup` 派发合成 Escape，走的是 Escape 分支，不受影响）。
  - 桌面端（指针）：**就地展开**在该条评论下方，上一页 / 下一页分页，每页 10 条（`ps=10`），不叠第二层浮层 —— 侧栏只有 320/340px，抽屉会把一级列表整个盖住。一次只展开一条，点同一条（正文或入口）即收起；换楼层由 `key` 重挂，页码回到第 1 页。
  - 两种形态共用同一份「选中评论」状态与 `楼主` 判定，因此不会各自演化出不同的开关规则；桌面端展开期间一级列表的无限滚动哨兵暂停，收起后恢复。昵称行右侧的标识有两类：`楼主`（当前楼层主，仅详情抽屉里成立）与 `UP`（稿件作者，列表与抽屉里都标）。作者身份由后端在解析时就固化在 `VideoComment.is_upper` 上（页面级 `data.upper.mid` 与 `member.mid` 比对），前端不重算：上游身份未知（mid 为 0 或 `upper` 缺失）时一条也不标，宁可少标不可错标（具体见第六节第三坑）。UP 标识保留平台粉强调色（`bg-accent/18 text-accent`），Lv 等级另按等级着色；昵称行的药丸与回复预览里的缩写小标各自覆盖 `Badge` 默认高度与行高，不让标识把行撑高。
- 等级标识由 `CommentLevelBadge` 统一渲染，一级评论、完整二级回复与短视频评论共用：Lv1 灰、Lv2 绿、Lv3 蓝、Lv4 黄褐、Lv5 橙、Lv6 红，搭配浅底与细描边；始终保留 `LvN` 文字和无障碍名称，不仅靠颜色传递等级。无效/非正整数不显示，未知正整数显示原值并使用中性色。`styles.css` 的 `--comment-level-*` 随明暗主题切换，回归 `tests/comment-level-colors.browser.js` 要求文字与合成背景的对比度至少 4.5:1，且不撑高昵称行。
- 播放页通过共享 `DrawerScope` / `DrawerViewport` 为评论、UP 投稿和播放工具提供侧栏挂载范围；局部抽屉使用容器内定位和非模态交互，遮罩不越过侧栏、不模糊播放器、不锁定全页焦点与滚动。隐藏侧栏或进入全屏时关闭已打开的局部抽屉，后续全屏工具继续使用播放器的 Portal 容器。
- **评论空降**：VOD 的 `VideoPlayerPage.seekTo` 经 `VideoSidebar.onSeek`（秒）传入 `CommentsPanel`，独立于弹幕开关；评论区内部用局部 Context 让主评论、预览、桌面分页回复与移动端详情共用回调。未传 `onSeek` 的复用方（短视频）保持普通时间文本。`commentTimestampSegments` 识别 `m:ss` / `h:mm:ss` 及全角冒号，秒与小时格式的分钟必须为 `00–59`；非法数字串不提取局部后缀。先分离表情与 URL，只对 `LinkText.renderText` 的非链接正文识别时间戳。时间按钮支持键盘 Enter/Space，点击不展开/收起回复、不改变播放意图；超时长沿用 `seekTo` 的片尾 0.25 秒保护。详情整行按钮与富文本控件改为兄弟层，避免嵌套交互元素。回归：`tests/comment-timestamp.test.ts`、`tests/video-comment-seek.browser.js`（真实播放页接线，IPC/DASH 桩；含移动端详情形态）。
- `[大哭]` 占位符按 `content.emote` 映射换成内联图。
- 简介与评论正文里的 URL 经共享 `LinkText`（`src/shared/components/LinkText.tsx`）渲染为可点链接：点击由 opener 插件在系统浏览器打开（浏览器预览退回 `window.open`，双双失败用 toast 兜底），`stopPropagation` 避免连带触发打开评论详情；链接字符集限定 ASCII 可打印区以在无空格的中文句子里截断，裸域名仅带路径时匹配（`img.png` 之类不误判），尾随断句标点归还正文；表情占位符替换后剩余文本段同样走 `LinkText`。

### PGC 直入（番剧 / 影视卡片）

- 番剧 / 影视卡片点击即进播放页，不弹分集选择对话框：索引接口（`pgc_index`）只给首集 `ep_id`、排行榜接口连它都不给，`bvid`/`cid` 一律缺失，因此卡片链接只带 `season` 参数（`videoPlayPath({ seasonId })`），悬停预载与 UGC 卡片同一套 `preloadRouteModule`。
- 播放页的直入解析层（`seasonEntry`）：并发取 season 详情与该作品的观看历史，两份都落定后挑集——历史停住的那一集仍在分集表里就进它，否则首集（`videoPgcEntryEpisode`）——随即以 `replace` 把 URL 规范成带完整取流键的形态（`bvid`/`cid`/`ep_id`），下游（取流、弹幕、历史、侧栏高亮、跳原址）因此全部照旧读 URL，不需要「有效分集」这层派生状态。解析期间只渲染黑底、独立返回按钮与加载指示，不挂播放器与侧栏（侧栏会以缺 `epId` 的形态初始化出错误页签，舞台聚焦也挂在 `cid` 上等首个有效值）；season 拉取失败给可重试的错误态，分集表为空（版权/地区限制）给不可重试的解释。
- 落点语义与历史卡一致：看完的那一集也回到那一集从头播，不像多 P 稿件那样退回 P1——剧集的内容单位是集，「上次那集」对追番场景比「第 1 集」有信息量；位置续播仍交给 `videoResumePosition` 判定。换集走右侧栏「分集」页签。

### 顶栏低频工具与控制布局

- 详情页不按画幅分配舞台高度：竖屏视频与横屏视频共用同一套布局，舞台按源画幅比撑高、移动端封顶 70%，竖屏画面在舞台内居中留黑边。**拖动侧栏页签条可改占比**：把侧栏拖大来看评论、拖小让画面占满，只在本页有效（不落盘）；拖大时舞台始终保留一个满宽 16:9 窗口的高度，因此画面不会被压得看不见 —— 横屏画幅默认就在这一档上（只能往下拖），竖屏画幅可以从一条页签拖到同一档。契约与不变量见[播放器技术文档](播放器技术文档.md)第九节「点播侧栏占比拖动」；回归 `tests/vod-details-resize.browser.js` 与 `tests/details-resize.test.ts`。
- `MainActivity` 通过 `getInsetsIgnoringVisibility` 获取状态栏/刘海顶部与导航栏/刘海底部安全区，按 `devicePixelRatio` 换成 `--android-safe-area-top` / `--android-safe-area-bottom`，不包含键盘高度。页面加载完成时重新分发 inset，避免 WebView 的 `env(safe-area-inset-*)` 残留 0；旧 APK / 浏览器仍回退到 `env`。普通画面全屏继续沿用既有隐藏系统栏行为。
- 桌面与移动端统一取消流内顶栏：返回、标题和工具都改在播放器顶部 HUD 显示，与底部控制栏共用空闲显隐（鼠标移出播放器区域即收起）；画面占满原顶栏空间，HUD 自行避让状态栏/刘海。返回主页在两端都常驻 HUD（返回箭头右侧），与只回上一层的返回箭头分工；窗口全屏不挂它（那一层由返回箭头退出）。低频工具（投屏/复制链接/在浏览器中打开）收进 `⋮` 溢出菜单；桌面底部 Shell 仍常驻链接操作。
- 低频工具统一由 `PlayerHudOverflowMenu` 承载（含桌面普通详情）：投屏 / 复制链接 / 在浏览器中打开。返回主页**不**走菜单 —— 它是高频导航，两端都在 HUD 上直接可见。投屏使用 `PlayerToolPanel` 与 `CastMenu`，进行中显示「投屏中」。
- **短视频入口**：顶部 HUD 在 `⋮` 旁常驻一个「看短视频」按钮（`Smartphone` 图标），点击跳 `/shorts/bilibili?seed=<bvid>`，以当前稿件为种子进入竖屏流。它不放进 `⋮`：这是消费方式切换而不是低频工具。跳转前先 `await fullscreenExit()`（短视频页是沉浸路由）；bvid 缺失（PGC 分集）时退回裸 `/shorts`，首屏不带种子。详见[短视频功能](短视频功能.md)第三节。
- 投屏只有 HUD 溢出菜单一个入口（`castOpen` + `castMenuProps`），窗口化与全屏同一形态，不存在双入口。无有效参数、PGC 解析态（没有可覆盖的播放舞台）继续渲染流内兜底顶栏，只留返回与标题，不挂工具。
- **窗口全屏**（`webFullscreen`）隐藏页面顶栏、侧栏和底部操作栏，保留系统窗口栏；**画面全屏**（`useRecordingPlayerFullscreen`）盖住页面。桌面 Tauri 使用原生窗口全屏，Android 对齐直播使用页内固定层与沉浸式系统栏，其他浏览器使用 HTML Fullscreen API。Android 普通视频复用直播的 `useAndroidFullscreenOrientation`：横屏画幅（宽高比 > 1）转到横屏时自动进入全屏、转回竖屏自动退出，手动点开的全屏才按帧比例上横屏方向锁，退出释放（契约见 `docs/zh/播放器技术文档.md` 6.4）。两层叠加时返回/Escape 一次只退一层；全屏往返不重建媒体元素。
- 控制栏保留高频播放控制与字幕按钮；字幕弹层改为 `PlayerControls` 内置弹窗同族的 Popover（`side="top" align="end"` + glass + `portalContainer` 指向舞台），替代原先手工绝对定位的面板。控制栏居中槽位是弹幕输入条（见第五节「弹幕发送」）。
- 字幕来源有两类且互斥：平台 CC 轨（`video_get_player_meta.subtitles` → `video_get_subtitle` → VTT blob → `<track>` 原生渲染）与**「字幕（本地）」**（本地 ASR 实时识别当前音轨）。弹层顺序是「关闭字幕」→ CC 轨 → 分隔线 → 「字幕（本地）」；本地字幕设置项直接显示在「字幕（本地）」下方。「字幕（本地）」是桌面客户端的常驻项，不依赖片源有没有 CC 轨；因此没有 CC 轨时字幕按钮仍可用，只有在既无 CC 轨又非桌面客户端时才是禁用按钮。选 CC 轨会关掉本地识别，选本地识别会把 `subtitleLan` 置空（`<track>` 随之卸载）。
- **章节进度条**：`video_get_player_meta` 在首帧后一次请求 `/x/player/wbi/v2`，同时返回 CC 字幕和 `data.view_points` 中的章节（`from` / `to` 秒数、`content` 标题）。Rust 跳过无效时间及空标题并按起点排序；前端仅转成 WebVTT，挂载 `kind="chapters"`、`mode="hidden"` 的轨道。现有 Video.js `TimeSlider.Chapters` 按章节显示带间隙的分段进度/缓冲条，悬停、拖动和键盘定位时显示章节标题；未被章节覆盖的时间保持无标题区间，实际时长裁剪和重叠归一化交给 Video.js。不额外请求章节，不从简介或评论猜章节。没有有效章节或接口失败时保持普通进度条，不影响播放及本地字幕。切 P/换集清除旧章节，切画质/刷新/仅音频后重新挂轨，清理时同时释放 blob；章节不是分 P 或选集，本轮不新增章节列表菜单。回归见 `tests/video-chapters.test.ts`、`tests/video-chapters.browser.js`。
- 本地识别复用 `useAsrCaptions`（与直播间、IPTV、多画面同一条管线）与 `AsrCaptionOverlay`。点播的媒体元素跨会话复用（不按 key 重建），因此 `mediaKey` 取 `playerRevision`、`sessionKey` 取 `vod:<bvid|epId>:<cid>:<取流地址>`：换集、换画质与切「仅音频」都会重建取流，识别状态随之清空。模型未就绪时来源项禁用，并把状态文案（下载进度、重试提示）显示在选项下方；本地字幕设置项始终紧接在来源项下方。
- 所有播放模式（含桌面普通详情）都使用舞台顶部 HUD，沿用控制栏空闲显隐，返回先退全屏、无全屏层时返回页面。固定沉浸层/画面全屏的菜单与 toast 进入 `stageRef`，停用侧栏的 `DrawerViewport`，避免浮层出现在隐藏的详情区。
- **返回上级视频页有方向性转场**：`/video/play` 与直播间、IPTV、两条竖屏流同属沉浸路由（`isImmersivePlayerPath`），进出都由 `Shell` 的 `PageZoom` 承担 —— 进入时列表退去、播放页从 `0.96` 长到 `1`，返回时播放页缩回 `0.96` 淡出、列表在下方展开。离场层里的播放页靠 `FrozenRouter` 冻结路由上下文，因此仍是带 `?bvid=…` 的正在播放的画面，而不是「缺少有效参数」的错误卡；旧子树不重新挂载，媒体元素与播放器实例一并存活到过渡结束。回归 `tests/frozen-router.browser.js`。
- 普通视频画面全屏复用直播的手势锁：锁定时上下控制层隐藏，点击画面或 Android Back 只唤醒解锁按钮，不能触发播放、倍速、左右调节或退出；解锁、退出全屏和切换视频时恢复正常操作。
- 普通移动端视频左半区纵滑调亮度、右半区调音量。Android 调整 Activity 亮度与系统媒体音量，媒体元素保持 100% 音量；其他移动浏览器回退为亮度遮罩和元素音量。手势不改变播放/暂停状态，拖动时预览，松手提交音量记忆，原生音量由系统记忆。
- 底部 Shell 仅桌面端显示链接操作，移动端统一从播放器 HUD 菜单访问。详情侧栏保留底部安全区 padding。


### 播放偏好（循环播放、连播与音量记忆）

- 普通详情模式的「播放设置」弹层分为清晰度、倍速和播放偏好开关。开关行与设置页、字幕菜单同源（`Field` + `FieldLabel` + `Switch`，标签可点）；「循环播放」常驻，列表多于一项或当前视频自身有选集时多一项「自动切集」，UGC 多一项「自动连播」；三项由 `playlistStore` 持久化到 localStorage `video-playlist`。
- 「播放下一个」按钮与自动切集共用同一个目标：`nextSelectionItem` 按 PGC 分集表 / UGC 多 P / UGC 合集顺序取当前项的下一项，取不到（无选集或已在最后一集）就不传 `onNext`，按钮随之消失。该按钮**不受** `showSecondaryPlayerControls` 约束：它和「仅音频/弹幕/字幕」不同，是主播放动作，移动端竖屏也要在场（`f7ed6c27` 误将它归入次级组，曾让它在移动端整段消失）。
- 推荐/热门/相关流队列保留手动切换，但不把下一条当作自动切集；搜索、UP 投稿队列保留为选集之后的退路；稿件信息不覆盖已有来源队列，无有效来源的多 P 直链仍自动建立选集队列。
- 一集播完后的动作由纯函数 `videoEndedAction(loopPlayback, autoPlayNext, hasNext, autoPlayRelated)` 决定，优先级固定：循环 > 连播下一集 > 连播相关视频 > 停住。`hasNext` 的目标经 `videoEndedTarget(selectionNext, queueNext)` 选出：当前视频自身选集的下一项优先，没有才退回来源队列邻项（搜索/UP 投稿）；推荐/热门/相关流的邻项不计入（`getNextAutoPlayItem` 对 `feed` 返回 null），这类队列走完即落到相关连播。搜索/投稿队列的条目没有 cid（列表项以 0 占位），取流键由历史续播/稿件详情补出，若沿队列邻项走就会切到另一个视频，因此选集优先。循环是「就看这一集」的显式意图，不该被连播带走；`autoPlayRelated` 是 UGC 专属偏好（PGC 没有相关视频列表，也没有可定位的 bvid），关闭或相关视频为空时停住。`ended` 读 `usePlaylistStore.getState()` 快照而不是播放器挂载时的闭包值，播放期间改偏好立刻生效；选集经 `selectionNextItemRef` 读取，因为分集表/稿件详情晚于播放器就位，延迟窗口里还会再取一次。
- 两条连播的等待窗口不同：换集 1 秒，相关连播 3 秒。跳转前的校验按已定下的 `action` 只查它对应的开关现值（`stillWanted`），因此等待期间关掉开关、按暂停、换片或重播都会取消这次跳转；`cancelled`/`loopPlayback` 又是两条路径共用的守卫。
- 相关连播沿用来源队列耗尽时的同一条路径（`playRelatedItem`：取相关视频接口、按 `relatedPlaylistItems` 去重并滤掉当前视频、以 `feed` 类型装入队列、跳转第一个）。
- 循环重播走原生 `media.currentTime = 0` + `play()`（与 seek 同一条 DASH 路径）；进度已在 `ended` 里按总时长记满，观看历史仍认定「已看完」，下次进入从头播放。
- 音量与静音由 `src/shared/playerVolume.ts` 记在 localStorage `rlive-player-volume`，视频页、直播页、IPTV 播放页与录制回放共享同一份：初值取 `readPlayerVolume()`，音量/静音状态变化写 `rememberPlayerVolume()`（同值不重渲染，一次拖动最多写它经过的档位数，不需要节流）。不参与的两处：多画面按槽位各存一份音量（副画面默认静音是角色语义）；Android 真实音量是系统媒体音量（由 OS 记住），网页层固定 100 且不落盘，否则会把 100 写进桌面端的记忆。

### 下一分集预加载（默认关闭）

- 开关住「设置 → 播放 → 视频点播」，默认**关闭**：它会额外下载下一集的 init 段与首个音视频分片，不能在升级或首次启动后未经选择就产生流量。
- 实现复用现有分片缓存而不是另建预热通道：`video_preload_next` 用与正常播放相同的 `video_play_selection` 解出分集轨道，再以 `first_segment_ranges`（`segment_ranges` 的前两项：init + 首片）写入与转发路径**逐字节相同**的缓存键（`{bvid|ep}:{cid}:{qn}:{v|a}:{start}:{end}`）。它不拉起播放代理、不合成 MPD、不占 session；已命中就跳过，失败返回 `Ok(false)` 且调用方忽略。
- 为什么只取首片：切集要的是「马上出画」，后续分片由播放器按需拉；顺带预取整段就变成一次未经确认的大额流量。`MEDIA_CACHE_PREFIX_SECS`（10s）仍管普通播放写盘的前缀宽度，预热只截到首片。
- 触发时机是「**当前集的最后一个分片已进缓冲**」之后，而不是「当前集已就绪」：整段还没取完之前，带宽属于正在看的那一集；末片就位说明取流已追到片尾，预热下一集的起播字节才不再与当前播放抢带宽。按「下一集身份 + 画质」去重只做一次，换集后自然对新的一集再预热。仅音频模式不预热。
- 末片判据是 `HTMLMediaElement.buffered` 的末端触到时长（`isVideoTailBuffered`，`src/features/video/videoTailBuffer.ts`）：MSE 下 `buffered` 是视频与音频两条轨缓冲区间的**交集**（规范如此），因此末端触底意味着两条轨的末片都已就位，不需要另建下载账本。容差 `VIDEO_TAIL_BUFFER_EPSILON_SECONDS`（0.25s）只吸收时间轴浮点误差 —— 实测 24 条真实分集里两条轨的时长差最大 0.035s，而分片时长远大于容差，所以「倒数第二片已到」不会被误判成末片。判定在 `timeupdate` / `progress` / `pause` / `seeked` 上跑：`progress` 是 MSE 每次 `appendBuffer` 之后的信号，暂停中的后台缓冲也只有它不依赖播放推进。
- 闸门状态存「已触底的那一轮会话的取流地址」（`playUrl`）而不是布尔量，也不只存分集身份：换集、**换画质与重试**都会换一份代理地址、缓冲从零开始，旧身份自然失配、闸门随之关闭，不必在渲染期或 effect 里手动重置，也就没有「新会话还在取流、上一轮的 true 已经放行预热」的窗口。地址本身就是一轮代理会话的唯一标识（每轮 `video_get_play_info` 都新绑端口）。
- 开启后播放页自身的 `video_get_play_info` 才带 `media_cache: true`：预热的字节写在同一个缓存键空间里，不打开读路径预热就白做。默认关闭时保持原有行为（播放页不写分片缓存，见 `VideoPlayRequest.media_cache` 的注释）。
- 实机验证（Windows Debug，真实 CDN）：预热后 `initRange` 与首片 Range 经代理均返回 206 且 `upstream_requests` 不增长，只有第二个分片才触发 1 次上游请求；重复预热因命中已写盘分片而从 1550ms 降到 796ms。真实 WebView2 上同时核实了信号本身：`progress` 只在末片 append 之后到达，那一刻 `buffered` 末端才等于时长（此前停在倒数第二片）。
- 回归：`tests/video-tail-buffer.test.ts` 钉住末片判定（触底/差半秒/无缓冲/时长未知/`TimeRanges` 并发失效）；`tests/video-next-preload.browser.js` 在真实播放页上把 DASH 引擎换成可手动推进 `buffered` 的桩（夹具每次取流都发新地址，与真实会话一致），断言「末片前不发、末片后按下一集身份发一次、同一集不重复、换集后闸门重关、同集重建后闸门重关」。
- 单测：`commands::video::tests` 的 `preload_keeps_only_init_and_the_first_segment` / `preload_without_segments_still_writes_init` 钉住首片截断与空分片表行为；`tests/video-settings.test.ts` 钉住两条偏好的默认值与回填。

### 换集过渡与 seek 边界

- 换集（合集/选集/相关视频跳转，内容身份变化）时不能沿用旧 playInfo：取流查询结果携带发起时的 `videoKey`，只把身份匹配的数据交给播放器；不匹配时停止旧画面/声音并等待新信息。尤其是 A→B 取流失败→重试，TanStack Query 可能再次给出 A 的 placeholder，不能把失败时的 B 路由身份误当成 A 数据的身份。换画质/重试（同内容）仍走旧播放器无缝续播路径。
- 取流查询由页面实例独占，关闭窗口聚焦/网络重连引起的隐式刷新；显式切换与重试才新建会话。`VideoPlaybackSessions` 复用在途请求所有权池：查询取消或页面卸载后迟到的 IPC 结果会调用 `video_stop_play`；已提交会话保留到旧引擎清理完成后再释放，失败产生的 `undefined` 不会丢掉旧会话引用。`gcTime: 0` 只负责缓存回收，不能替代代理清理。回归见 `tests/video-playback-lifecycle.test.ts`（真实 QueryObserver 的取消与 placeholder 顺序）和 `tests/video-session-lifecycle.browser.js`（StrictMode 下的真实播放页、可控 IPC/引擎，覆盖交接、失败重试、历史 flush 与卸载迟到结果）。
- seek 上限离时长留 0.25s 余量：跳到正正好 `duration` 会被媒体元素当成播放结束，留余量让最后一帧真的播出来、再自然触发 ended（自动连播走正常路径）。「跳到最后无限加载不进下一 P」的真正根因是分片表被当成等长展开（见第二章第 3 节第四坑）：末片槽位倒挂 + 逐片偏差累积，插件永远选不中覆盖目标时刻的分片。仅靠这个余量遮不住它 —— 偏差大的稿件在中段 seek 同样会卡死（实测 1069s 稿件跳 500s 即复现）。

### 跳原址与复制链接（底部 Shell）

- 底部 Shell 右侧的「在浏览器中打开」按钮：与直播页同一套交互 —— 点击经 `tauri-plugin-opener` 打开系统浏览器（失败回退 `window.open`）、toast 通知结果，不在界面上展示具体地址。HUD 溢出菜单里另有图标镜像（见上节）。

### 评论接口的四个坑（实测 + PiliPlus 对照）

1. **匿名携带 buvid 会被截断**：只要 cookie 里有 buvid3/buvid4，主列表只回 3 条并谎称 `is_end=true`；无 cookie 才给全量。PiliPlus 同样在匿名请求里显式强制空 cookie。
2. **裸路径会吃 -352**：未签名的 `/x/v2/reply/main` 在高频请求后会被风控拒（换 oid 也一样）；走 `/x/v2/reply/wbi/main` + WBI 签名则稳定放行。
3. **作者标识需要自己算**：评论条目上没有「这条是 UP 发的」字段（`up_action` 只是「UP 是否点过赞/回过」）。作者 mid 在页面级 `data.upper.mid`（评论首页与二级回复两个接口都下发，实测 mid 为数字、可为 0 表示身份未知），拿它与 `member.mid` 比对得出 `VideoComment.is_upper`。`upper` 缺失时回退 `data.top.upper.member.mid`（能置顶的必是作者）；两者都拿不到时一条也不标——把路人标成作者比少标一个标识更糟。
4. **置顶的两种形态**：`data.top_replies[]` 与 `data.top.upper`（UP 主置顶对象）可能只给其一，解析时都取、按 rpid 去重。

## 七、观看历史（进度续播）

参考 PiliPlus 的「同一作品一条记录」语义:SQLite 新增 `video_history` 表(schema v3→v4 增量迁移),主键 `(kind, oid)`——UGC 的 oid 是 bvid,PGC 是 season_id。同一稿件换分 P、同一番剧换集只更新原行的 `progress`/`cid`/`ep_id` 与元数据,历史列表不会被一部番的几十集刷满。保留上限 500 行,插入后触发器按 `watched_at` 淘汰最旧,与直播 `history` 的 2,000 行上限同一手法。配置包 v2 追加 `video_history` 字段(`#[serde(default)]`,旧导出按空表导入)。

前端约定(`videoHistory.ts` 纯逻辑 + 播放页接线)。三个阈值(最小进度 3s、上报间隔 5s、片尾容差 5s)与「该续播到第几秒」的判定住在 `src/shared/watchProgress.ts`，与本地录制回放共用一份：两个表面的落盘方式不同，但「多短算没看、多久写一次盘、离结尾多近算看完」是同一套语义，各写一份只会让阈值随时间漂移。

- **上报节流**:播放中经 `timeupdate` 上报,间隔 ≥ 5s 且进度 ≥ 3s(点开就退/拖动预览不污染历史);首次越过 3s 立即落一笔「打开过」。暂停、ended(记满时长)、离开播放页(effect 清理)三个时机强制 flush。
- **续播判定**:`videoResumePosition` 只在「历史停在当前分集(`cid` 比对,取流键 UGC/PGC 都有)且未看完(距片尾 > 5s)」时返回旧位置,否则从 0 起播。DASH 在创建播放器前确定续播位置，并通过 MPD `#t` anchor 交给引擎；避免先下载开头分片再取消、重取 init。仅音频仍等 metadata 后执行原生 seek。两者与换画质续播共用快照和播放意图；续播查询未落定前不建播放器。
- **跨分 P 续播**:URL 不带 `cid`(首页/搜索/UP 主卡片进入)时,取流键不再一律取详情给的 P1，而是 `videoResumeCid(record, archive)` 给的「上次看的那一 P」——「上次退出的地方」包含「上次看的是哪一 P」。它要求那一 P 确实在 `archive.pages` 里(合集换稿件与脏数据不算)且 `videoResumePosition` 认定有续播位置,否则退回 P1;稿件详情未到时返回 0。`cid <= 0` 期间播放器、播放列表与侧栏 effect 全部按「取流键未就绪」直接返回,否则会先按 P1 建列表再切、把播放列表锚在错误的一集上。落到非首 P 时提示一次「已续播上次观看的 P{n}」(`crossPartNoticeRef` 按 cid 去重,重建播放器不重复提示)。用户明确点过某一集(选集/播放列表/历史卡)时链接一定带 `cid`,这条路径不介入。
- **身份错位防线**：每个 `cid` 持有独立的 `VideoPlaybackHistory`，同集标题/封面等晚到元数据可补齐，换集或路由变空不能抹掉旧实例的条目。旧播放器清理时仍用自己的身份 flush 最后进度，既不记到新集，也不因新集 layout 已提交而丢掉旧集最后几秒；尚未恢复有效媒体位置的失败实例不写入假进度。
- **历史页第三视图**:「观看历史 / 视频历史 / 弹幕历史」三态切换(`view` search 参数)。视频卡片显示封面(缺省回退图标)、时长标签、底边进度条、「已看到 X / Y」与分集副行;点击整卡带着 `cid` 续播进播放页;单条删除乐观更新,清空有确认弹窗。视频只有 B 站一个来源,不参与平台筛选,`historyGrouping` 因此拆成 `filterHistoryBySite`(带 `site_id` 的时间线用)+ `groupHistoryByDate`(通用按日分组)。
- **时间线窗口化**:三个视图的时间线共用 `HistoryTimeline`(`@tanstack/react-virtual`)。日期分组先由 `flattenHistoryTimeline` 拍平成「标题行 + 记录行」的线性序列,标题因此和记录一起参与同一次窗口计算。滚动容器是 Shell 的 `app-page` 而不是列表自己(整页滚动含筛选行与下拉刷新,列表另开视口会出现双滚动条),所以必须把列表在该容器内容中的起始偏移交给 `scrollMargin`——用 `offsetTop` 逐级累加得出,不用 `getBoundingClientRect` 相减:外层页面平移与横滑 track 都在祖先上留着 transform,rect 会把这些位移算进去而 `scrollTop` 不会,混用两套坐标系会让窗口整体错位。行距不靠 flex `gap`,改由每行自带上内边距:行是绝对定位的,间距必须计入被测高度,否则测量值小于实际占位、越滚越偏。非当前页签的时间线高度收为 0(`active`),否则三个面板同挂载时页面高度被最长的那个撑起,切到较短视图会留下大片空白滚动区。
- **滚动表面与窗口/元素双模式**:要虚拟化的表面由 `resolveHistoryScrollElement` 决定——优先最近的纵向可滚动祖先(历史页里是 Shell 的 `app-page`),没有则退回文档滚动元素;文档滚动时 `documentElement.scrollTop` 本身就是窗口滚动位置,同一条路径因此同时覆盖元素滚动与窗口滚动,列表自己仍不开滚动容器。两种模式的差别只在观察器:文档滚动元素是 `<html>`,`offsetHeight` 是整篇文档高而非视口高,必须改报 `innerHeight`;其 `scroll` 事件派发在 `window` 上而不是元素上,偏移观察也要改听 `window`(`observeHistoryRect` / `observeHistoryOffset`)。
- **前插稳定锚点**:时间线按时间倒序、最新记录从顶部插入,因此「直播边缘」在顶部。锚点方向随位置切换(`historyAnchorTo`):停在 8px 容差内时用 `start`,新记录顶上来后视口仍停在 0、用户自然看到最新一条;一旦向下滚过容差就切到 `end`,按稳定行键把当前可见行钉在原位,新记录插入不再挤动视口(容差是给触摸滚动留的——很难精确停在 0)。overscan 取 6 行:触摸设备一甩就是几屏,默认 1 行缓冲会露白,6 行足够覆盖合成器追赶的一帧且不会把 DOM 行数拉回与记录数同阶。
- **非活动时间线不渲染行（无限滚动的根因）**:三条时间线常挂载在同一条横滑 track 上,非活动面板把高度收为 0(`active`),否则最长的一条会把滚动范围留给另外两条。但**只收高度不够**:行是绝对定位的,盒子缩到 0 后它们仍待在原偏移上——实机实测非活动面板仍渲染 20 行、最后一行 `translateY(6672px)`。祖先 `overflow` 为 visible,这些行照样参与滚动范围:track 的高 4999 而滚动高 6770(溢出 1771px),并随滚动一路增长,页面因此永远滚不到底。修法是收起高度的同时连行一起摘掉(`active ? virtualRows : []`);修后 track 溢出为 0,逐屏下滚的增长步数从 47/57 降到 0,三个视图均为 0。
- **弹幕卡正文封顶**:弹幕正文会换行,行高随字数变化,而窗口化列表的总高度是「已测行实测高 + 未测行估高」之和、实测发生在行进入视口时——实测系统性大于估高时会让滚动条比滚动更快变长(次要成因)。因此正文封顶在约三行(`DANMAKU_CONTENT_MAX_HEIGHT_PX = 66`,用 `max-height` 而非 `line-clamp`,全文仍可读),估高取封顶后的卡高(`DANMAKU_CARD_ESTIMATE_PX = 170`)。两者要一起改:只封顶而估高仍为 132 时,封顶后实测 168 依旧高于估高,实测仍有 164/166 步增长;提到 170 后为 0。
- **刷新回顶**:锚定与「看最新」是两种相反意图。`anchorTo:"end"` 锚定的语义是钉住旧行:新记录插入后 `scrollTop` 被加上新记录高度,锚点行看着没动,真正新的那几条却落在视口上方(实测 `top=-166`),刷新于是像什么都没发生。因此刷新路径先归零再抓取(`resetHistoryScrollForRefresh`,经 `refreshResetToken` 登记回调):用户的意图是看最新,而不是保住刚才的位置。桌面刷新按钮在任意滚动位置都可点,所以这个缺口不只在顶部。
- **虚拟列表性能**:滚动更新走 `useFlushSync: false`(官方为 React 19 与低端设备推荐):`flushSync` 默认开启会在每次滚动时同步刷新,React 19 下还会从生命周期里警告;虚拟列表的滚动更新差一帧无所谓,由此换回自然批处理。`getItemKey` / `estimateSize` 经 ref 读最新行集、身份恒定——官方明确要求记忆化,否则每次筛选换一个新闭包会让整表重算。
- **快照恢复**:滚动位置与实测高度存在 `historyVirtual.ts` 的模块级 Map 里(键为 `location.key` + 视图名:前者对每条历史记录稳定,后者把三条时间线分开,切视图不会把观看历史的偏移套到弹幕历史上),写入即 LRU 淘汰、上限 32 条。离开或切视图前 `takeSnapshot()` 拍下实测高度与偏移,重挂载时喂回 `initialMeasurementsCache` / `initialOffset`,恢复因此不必先按估高铺一遍再校正;偏移用持续跟踪的值而不是此刻的 `scrollTop`——面板高度收为 0 之后浏览器会把滚动位置钳到 0,那时再读就丢了用户真实位置。Shell 的 `pageScroll.ts` 仍是 `scrollTop` 的权威(POP 恢复),虚拟列表只在切视图时补位。
- **查询上限对齐保留上限**:`history`/`video_history` 的列表查询上限直接取修剪触发器的常量(2,000 / 500),不再另设更小的 200 条。窗口化后行数不再是渲染成本,而更小的查询上限会让全局时间线丢掉库里明明还留着的记录——尤其是被 B 站活跃使用挤出前 200 条的虎牙/斗鱼记录。

## 八、待办与风险

MPD 交付：`stream_proxy` 加**纯增量**文本模式（新增命令返回 `application/dash+xml`），video / audio / mpd 各用**独立 `session_id``（`start` 按 session 覆盖同名代理），离开播放页三个一起停，防连接泄漏。

风险：风控 -352（靠 WBI + buvid3 + Referer + 真 UA 规避）；匿名最高 480P、1080P+ 需大会员；PGC 有版权与地区限制，需要可读的失败态；分区条不能直接复用 `CategoryBar`（它按 `LiveCategory` 类型），但应抽出 `CHIP_HEIGHT` / `CHIP_RADIUS` / `CHIP_TOUCH_TARGET` 与滚动/键盘逻辑共用；Shell 里视频页的 `groupStrip` 必须是四个内容页签，不能复用 `sitePlatforms`。
