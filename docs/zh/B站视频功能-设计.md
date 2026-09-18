# B 站视频（VOD）功能设计

参考实现：PiliPlus（Flutter）。本文的每条 API 契约与技术结论均在 2026-09 实机请求验证过，非文档推断。

## 一、已锁定的产品决策

- 入口：**新增侧栏「视频」目的地**，独立路由 `/video`。现有首页的直播平台条（B站/斗鱼/虎牙/抖音/Twitch）完全不动。
- 头部整行 = 四个内容页签「推荐 / 热门 / 番剧 / 影视」；其下一条**分区条**；再下是内容网格。
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
| 推荐 | `GET /x/web-interface/wbi/index/top/feed/rcmd`，`version=1&feed_version=V8&homepage_ver=1&ps=<n>&fresh_idx=<i>&brush=<i>&fresh_type=4` | **需 WBI**；有 cookie 才是个性化流，匿名返回通用流。取 `data.item[]`，只保留 `goto=="av"` 且有 `owner`。**不产竖屏**：实测 115/115 条 `av` 均为横屏，加 Android 设备字段/`screen`/`web_location`/`homepage_ver` 等任何参数也不变（详见[短视频调研](短视频调研-B站与抖音.md) 2.8）。竖屏内容在 APP 的 feed 流，不在这个 PC 首页接口 |
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
| 相关视频 | `GET /x/web-interface/archive/related?bvid=` | 无 WBI、匿名可用。`data[]` 与热门条目同构，一次给全。**含竖屏**（实测 40/200 条），条目自带 `dimension`，但前端 `VideoCard` 封面固定 `aspect-video`，竖屏稿件看不出画幅 |
| 评论 | `GET /x/v2/reply/wbi/main?type=1&oid=<aid>&mode=<2\|3>&ps=20&next=<cursor>`，WBI 签名 | 签名 + **匿名时不得携带任何 cookie**：实测携带 buvid3/4 的匿名会话只回 3 条并谎称 `is_end=true`（无 cookie 才给全量 20 条）；未签名裸路径被风控后一律 -352，签名路径放行。登录态带完整 cookie 同路径。置顶有两处：`data.top_replies[]` 与 `data.top.upper`（UP 主置顶对象，参考 PiliPlus 两者都解析）。**作者标识**：页面级 `data.upper.mid`（实测两个回复接口都下发）与评论者 `member.mid` 比对得出，条目上没有现成的作者字段 |
| 二级回复 | `GET /x/v2/reply/reply?type=1&oid=<aid>&root=<rpid>&pn=&ps=<20\|10>&sort=2` | 匿名可用（不受 buvid 截断影响）。**pn 翻页有效**；`data.page.count` 是总数；`data.upper.mid` 同主接口下发，作者标识一并标到楼中楼。`ps` 由前端按需给：移动端无限滚动用默认 20，桌面端分页用 10（`video_get_comment_replies` 的可选 `pageSize`）；**`has_more` 必须按本次实际 `ps` 推导**（上游不给 `is_end`），套 20 会让 10 条一页的翻页在 pn=5 就误报到尾 |
| 视频搜索 | `GET /x/web-interface/search/type`，`search_type=video&keyword=&page=&order=&duration=0&tids=0`；筛选位：`order`（click 播放多/pubdate 新发布/dm 弹幕多/stow 收藏多/scores 评论多，空=综合）、`duration`（0 全部/1 <10min/2 10-30/3 30-60/4 >60）、`tids` 大区 tid（0=全部，与分区榜 rid 两套 ID）、`pubtime_begin_s`/`pubtime_end_s`（day/week/halfYear 预设在后端换算成「N 天前零点 ~ 当天 23:59:59」） | 无 WBI、匿名可用。取 `data.result[]`，`numPages` 判尾页。时长为 `duration` 字符串（`H:MM:SS`） |
| UP 主投稿 | `GET /x/space/wbi/arc/search?mid=&pn=&ps=30&tid=0&keyword=&order=<pubdate\|click>` | **需 WBI**。取 `data.list.vlist[]`，条目的时长字段是 `length`（`mm:ss` 字符串）而**不是** `duration`（实测），因此时长取值须做 `duration`→`length` 回退 |
分区 rid（PiliPlus 硬编码，非 API）：全站 0、动画 1005、音乐 1003、舞蹈 1004、游戏 1008、知识 1010、科技 1012、运动 1018、汽车 1013、美食 1020、动物 1024、鬼畜 1007、时尚 1014、娱乐 1002、影视 1001。
搜索 tids（`search/type` 的 `tids` 位，与上面分区榜 rid 是两套 ID）：动画 1、番剧 13、国创 167、音乐 3、舞蹈 129、游戏 4、知识 36、科技 188、运动 234、汽车 223、生活 160、美食 221、动物 217、鬼畜 119、时尚 115、资讯 202、娱乐 5、影视 181、纪录片 177、电影 23、电视剧 11（后端 `VIDEO_SEARCH_ZONES` / `video_search_zone_list`）。
season_type：番剧 1、电影 2、纪录片 3、国创 4、剧集 5、综艺 7。

**`aid` 已是超大整数**（实测 `117191437455648`），Rust 必须 `i64`；跨 IPC 建议序列化为字符串，前端只当标识符，禁止参与算术。

## 四、DASH：三个关键实测结论

### 1. `segment_base.index_range` 是 sidx box，可解析出完整分片表

`playurl` 每个 representation 给 `segment_base: { initialization: "0-937", index_range: "938-1601" }`。按 `index_range` 发一次 Range 请求拿到的正是 `sidx` box。实测解析出 52 片 / 5s 一片 / `timescale=16000`。

每片自带 `moof`+`mdat`，且 `tfdt` 与 sidx 累加时间轴**精确相等**（逐片核对 seg0/1/5/51 全部 match）。init 段只有 `ftyp`+`moov`。时间轴一致不能替代播放器的顺序约束，生产链路仍使用既有按序媒体代理。

同一画质有多编码变体（avc1 / hvc1 / av01）并列，**选流必须按 codec 过滤**，默认取 `avc1` 兼容性最好。

播放页使用 Video.js DASH 适配器，与取流 IPC 并行准备；后端 `video_play_selection` 用 `tokio::join!` 并发获取音/视频两条互不依赖的 sidx，减少一次串行 CDN 往返。该链路供 UGC/PGC、横竖屏与仅音频模式共用；各轨候选 CDN 回退仍按序执行，选流、错误优先级、MPD 标准分片时间轴与媒体代理顺序不变。

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

### 已验证的浏览器结论

Python/本地媒体服务模拟 stream_proxy（注入 Referer + 转发 Range）+ MPD + Video.js 官方适配器，Chromium 实跑：

- 播放正常：`HTMLVideoElement.readyState: 4`，视频轨与音频轨均解码。
- **seek 成立**：跳到中后段后重新出现有效 `buffered` 区间并继续播放。
- 同一 `<video>` 的 HLS、FLV、裸 MPEG-TS、DASH 与原生 MP4 适配路径均可出画；同协议切源等待 `canplay` 后才提交，用户暂停状态保留。

正式的 sidx 解析、取流与 MPD 生成实现位于 `src-tauri/src/sites/bilibili/video.rs`。

## 五、VOD 弹幕

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
- 全量渲染已加载条目（时间戳 + 内容，条目颜色还原），行级 `content-visibility: auto` + `contain-intrinsic-size` 让浏览器跳过屏外行的布局与绘制，上万条也不拖垮滚动；随播放自动跟踪滚动（用户上翻暂停跟随，滚回底部恢复）；**每行是跳转按钮**——点击任意条目（含未来条目）即 seek 到该弹幕出现的播放位置。
- 数据直接来自播放页 `danmakuEntries`（懒加载已合并的段数据），不额外请求。加载态由「在途请求计数 + 是否有段落定」驱动：空列表只有在首段已落定且没有在途请求时才显示「暂无弹幕」，否则无弹幕视频的弹幕栏会永远转圈（旧实现以 `entries.length === 0` 当 loading，空段落永不落定即无限加载）。在途请求持有段 map 的引用，换视频（换 cid 重置 map）后回来的旧响应据此丢弃，不会污染新视频的弹幕。

## 六、清晰度切换与右侧栏

### 清晰度

- 菜单复用 `PlayerControls` 既有的 `qualities/qualityIndex/onQualityChange` 约定（录制回放同源），不可用档位列出但置灰并提示「登录或大会员后可用」。
- 切换 = 记录当前位置与播放状态 → 带 `qn` 重取 play-info。新的代理端口 = 新的 MPD 地址，播放器必然重建；重建后 `currentTime` 直接赋续播点（元数据就位前赋值会作为默认起播位置被采纳），原播放状态恢复。
- 重取期间 `keepPreviousData` 保留旧数据：旧播放器继续播到新信息就位，不黑屏。

### 右侧栏（`VideoSidebar`）

- UGC 页签顺序：选集（多 P 时，含折叠合集）/ 相关视频 / 评论 / 弹幕（最右）；仅合集（无分 P）时第三个页签显示为「合集」；PGC：分集 + 评论。宽屏在右（320px，xl 340px，与直播/IPTV 播放页侧栏同宽），窄屏列在播放器下方滚动。
- 页签条之上的 UP 主信息卡：头像与 UP 名点开投稿抽屉；统计行（播放/评论/发布时间，来自稿件详情数据与 `VideoArchive.pubdate`）最右侧是简介展开/收起的纯图标开关（箭头旋转 + `aria-expanded`/`title`）。视频简介默认不显示，点开关才展开（换稿件重挂复位）；展开的简介用 `hidden` 而非条件渲染挂在卡片里，让 `aria-controls` 在收起态也能解析到目标。稿件 Tags 位于简介正文末尾，使用可换行的 `Badge` 展示，点击 Tag 进入 `/video/search?q=<tag_name>`；Tags 接口失败或为空时不显示。侧栏加宽加图标开关后统计行单行放下，`flex-wrap` 仍是字体缩放与超长数值的兑底（发布时间组因此不加 `border-l` 分隔线，避免换行后出现孤立竖线）。列表页 UGC 卡片同样显示发布时间（`VideoItem.pubdate`）：推荐/热门/搜索自带 Unix 秒，UP 主投稿列表只给 `created`（北京时间字符串 `yyyy-MM-dd HH:mm`），后端 `created_to_unix` 按 UTC 解析后减 8 小时还原，缺失为 0 前端不渲染；同一列表的时长同样要兼两种字段形状：`item_duration` 先取 `duration`，为 0 时回退 `length`（投稿列表只给 `length`，漏掉这一路会让抽屉里每条都显示 `0:00`）。卡片标题恒占两行（`min-h-[2lh]`），一行标题的卡片靠占位把 UP 主行与统计行压到相同纵向位置。
- 多 P 稿件（`pages` ≥ 2）自动展示「选集」页签并接管连播列表：点任意 P 跳转（同 bvid、按 cid 取流），当前 P 按 cid 高亮。选集与合集共用一个页签（`PartsSeasonPanel`）：同时存在时选集展开、合集折叠成标题行（点击展开，连播沿分 P 列表走）；无分 P 的合集直接展开、连播沿合集走。两区标题行都是收起开关（`ChevronDown` 旋转 + `aria-expanded`）：选集行左侧「选集」、右侧「共 x P」计数，点按切换列表显隐；收起态不跨稿件沿用（`PartsPanel` 以 bvid 为 key，换稿件重挂即默认展开），收起后再展开会把当前 P 重新滚回可视区。
- 评论的 `oid` 是 aid：列表/分集链路经路由参数携带；URL 直入时 UGC 用稿件详情补齐，PGC 用 season 详情里当前集的 aid。
- 评论列表使用游标翻页（`next`），每条主评论直接展示接口附带的部分二级回复预览与「共 N 条回复」入口；点击主评论、回复预览或入口即展开以主评论为楼主的完整回复，二级回复使用 pn 翻页（首传 1）。**展开形态按客户端分端**，判据是 `isMobileClient()`（与侧栏横滑手势、弹幕设置面板同一判据：按输入模态分野，不按视口宽度）：
  - 移动端（触摸）：二级抽屉，无限滚动，页大小用后端默认 20。详情从侧栏右侧进入，手机竖屏时仅覆盖播放器下方的侧栏。抽屉打开期间**点播放器不再把它收掉** —— 侧栏里的局部抽屉是非模态的，base-ui 的 `outsidePress` 原本会吞掉任何落在抽屉与遮罩之外的点按，而播放器正是那块区域；因此显式 `disablePointerDismissal`。退回一级只剩两条路：表头返回按钮与系统/手势返回（Android 返回键经 `dismissTopmostPopup` 派发合成 Escape，走的是 Escape 分支，不受影响）。
  - 桌面端（指针）：**就地展开**在该条评论下方，上一页 / 下一页分页，每页 10 条（`ps=10`），不叠第二层浮层 —— 侧栏只有 320/340px，抽屉会把一级列表整个盖住。一次只展开一条，点同一条（正文或入口）即收起；换楼层由 `key` 重挂，页码回到第 1 页。
  - 两种形态共用同一份「选中评论」状态与 `楼主` 判定，因此不会各自演化出不同的开关规则；桌面端展开期间一级列表的无限滚动哨兵暂停，收起后恢复。昵称行右侧的标识有两类：`楼主`（当前楼层主，仅详情抽屉里成立）与 `UP`（稿件作者，列表与抽屉里都标）。作者身份由后端在解析时就固化在 `VideoComment.is_upper` 上（页面级 `data.upper.mid` 与 `member.mid` 比对），前端不重算：上游身份未知（mid 为 0 或 `upper` 缺失）时一条也不标，宁可少标不可错标（具体见第六节第三坑）。UP 标识用平台粉强调色（`bg-accent/18 text-accent`）与蓝色的 Lv 药丸区分开；昵称行的药丸与回复预览里的缩写小标各自覆盖 `Badge` 默认高度与行高，不让标识把行撑高。
- 播放页通过共享 `DrawerScope` / `DrawerViewport` 为评论、UP 投稿和播放工具提供侧栏挂载范围；局部抽屉使用容器内定位和非模态交互，遮罩不越过侧栏、不模糊播放器、不锁定全页焦点与滚动。隐藏侧栏或进入全屏时关闭已打开的局部抽屉，后续全屏工具继续使用播放器的 Portal 容器。
- `[大哭]` 占位符按 `content.emote` 映射换成内联图。
- 简介与评论正文里的 URL 经共享 `LinkText`（`src/shared/components/LinkText.tsx`）渲染为可点链接：点击由 opener 插件在系统浏览器打开（浏览器预览退回 `window.open`，双双失败用 toast 兜底），`stopPropagation` 避免连带触发打开评论详情；链接字符集限定 ASCII 可打印区以在无空格的中文句子里截断，裸域名仅带路径时匹配（`img.png` 之类不误判），尾随断句标点归还正文；表情占位符替换后剩余文本段同样走 `LinkText`。

### PGC 直入（番剧 / 影视卡片）

- 番剧 / 影视卡片点击即进播放页，不弹分集选择对话框：索引接口（`pgc_index`）只给首集 `ep_id`、排行榜接口连它都不给，`bvid`/`cid` 一律缺失，因此卡片链接只带 `season` 参数（`videoPlayPath({ seasonId })`），悬停预载与 UGC 卡片同一套 `preloadRouteModule`。
- 播放页的直入解析层（`seasonEntry`）：并发取 season 详情与该作品的观看历史，两份都落定后挑集——历史停住的那一集仍在分集表里就进它，否则首集（`videoPgcEntryEpisode`）——随即以 `replace` 把 URL 规范成带完整取流键的形态（`bvid`/`cid`/`ep_id`），下游（取流、弹幕、历史、侧栏高亮、跳原址）因此全部照旧读 URL，不需要「有效分集」这层派生状态。解析期间只渲染顶栏 + 加载指示，不挂播放器与侧栏（侧栏会以缺 `epId` 的形态初始化出错误页签，舞台聚焦也挂在 `cid` 上等首个有效值）；season 拉取失败给可重试的错误态，分集表为空（版权/地区限制）给不可重试的解释。
- 落点语义与历史卡一致：看完的那一集也回到那一集从头播，不像多 P 稿件那样退回 P1——剧集的内容单位是集，「上次那集」对追番场景比「第 1 集」有信息量；位置续播仍交给 `videoResumePosition` 判定。换集走右侧栏「分集」页签。

### 顶栏低频工具与控制布局

- 详情页不按画幅分配舞台高度：竖屏视频与横屏视频共用 `aspect-video` 舞台与 `max-lg:max-h-[56%]` 上限，播放器与详情区的空间占比一致，竖屏画面在舞台内居中留黑边。
- `MainActivity` 通过 `getInsetsIgnoringVisibility` 获取状态栏/刘海顶部与导航栏/刘海底部安全区，按 `devicePixelRatio` 换成 `--android-safe-area-top` / `--android-safe-area-bottom`，不包含键盘高度。页面加载完成时重新分发 inset，避免 WebView 的 `env(safe-area-inset-*)` 残留 0；旧 APK / 浏览器仍回退到 `env`。普通画面全屏继续沿用既有隐藏系统栏行为。
- 桌面与移动端统一取消流内顶栏：返回、标题和工具都改在播放器顶部 HUD 显示，与底部控制栏共用空闲显隐（鼠标移出播放器区域即收起）；画面占满原顶栏空间，HUD 自行避让状态栏/刘海。桌面普通详情在 HUD 里保留返回主页（旧流内顶栏的迁移），低频工具（投屏/复制链接/在浏览器中打开）收进 `⋮` 溢出菜单；桌面底部 Shell 仍常驻链接操作。
- 低频工具统一由 `PlayerHudOverflowMenu` 承载（含桌面普通详情）：投屏 / 复制链接 / 在浏览器中打开；移动端普通视频还保留返回主页入口。投屏使用 `PlayerToolPanel` 与 `CastMenu`，进行中显示「投屏中」。
- **短视频入口**：顶部 HUD 在 `⋮` 旁常驻一个「看短视频」按钮（`Smartphone` 图标），点击跳 `/shorts?seed=<bvid>`，以当前稿件为种子进入竖屏流。它不放进 `⋮`：这是消费方式切换而不是低频工具。跳转前先 `await fullscreenExit()`（短视频页是沉浸路由）；bvid 缺失（PGC 分集）时退回裸 `/shorts`，由后端用最近观看历史当种子。详见[短视频功能](短视频功能.md)第三节。
- 投屏只有 HUD 溢出菜单一个入口（`castOpen` + `castMenuProps`），窗口化与全屏同一形态，不存在双入口。无有效参数、PGC 解析态（没有可覆盖的播放舞台）继续渲染流内兜底顶栏，只留返回与标题，不挂工具。
- **窗口全屏**（`webFullscreen`）隐藏页面顶栏、侧栏和底部操作栏，保留系统窗口栏；**画面全屏**（`useRecordingPlayerFullscreen`）盖住页面。桌面 Tauri 使用原生窗口全屏，Android 对齐直播使用页内固定层与沉浸式系统栏，其他浏览器使用 HTML Fullscreen API。Android 普通视频复用直播的 `useAndroidFullscreenOrientation`：横屏画幅（宽高比 > 1）转到横屏时自动进入全屏、转回竖屏自动退出，手动点开的全屏才按帧比例上横屏方向锁，退出释放（契约见 `docs/zh/播放器技术文档.md` 6.4）。两层叠加时返回/Escape 一次只退一层；全屏往返不重建媒体元素。
- 控制栏保留高频播放控制与字幕按钮；字幕弹层改为 `PlayerControls` 内置弹窗同族的 Popover（`side="top" align="end"` + glass + `portalContainer` 指向舞台），替代原先手工绝对定位的面板。控制栏居中槽位是弹幕输入条（见第五节「弹幕发送」）。
- 字幕来源有两类且互斥：平台 CC 轨（`video_get_subtitles` → `video_get_subtitle` → VTT blob → `<track>` 原生渲染）与**「字幕（本地）」**（本地 ASR 实时识别当前音轨）。弹层顺序是「关闭字幕」→ CC 轨 → 分隔线 → 「字幕（本地）」；本地字幕设置项直接显示在「字幕（本地）」下方。「字幕（本地）」是桌面客户端的常驻项，不依赖片源有没有 CC 轨；因此没有 CC 轨时字幕按钮仍可用，只有在既无 CC 轨又非桌面客户端时才是禁用按钮。选 CC 轨会关掉本地识别，选本地识别会把 `subtitleLan` 置空（`<track>` 随之卸载）。
- 本地识别复用 `useAsrCaptions`（与直播间、IPTV、多画面同一条管线）与 `AsrCaptionOverlay`。点播的媒体元素跨会话复用（不按 key 重建），因此 `mediaKey` 取 `playerRevision`、`sessionKey` 取 `vod:<bvid|epId>:<cid>:<取流地址>`：换集、换画质与切「仅音频」都会重建取流，识别状态随之清空。模型未就绪时来源项禁用，并把状态文案（下载进度、重试提示）显示在选项下方；本地字幕设置项始终紧接在来源项下方。
- 所有播放模式（含桌面普通详情）都使用舞台顶部 HUD，沿用控制栏空闲显隐，返回先退全屏、无全屏层时返回页面。固定沉浸层/画面全屏的菜单与 toast 进入 `stageRef`，停用侧栏的 `DrawerViewport`，避免浮层出现在隐藏的详情区。
- 普通视频画面全屏复用直播的手势锁：锁定时上下控制层隐藏，点击画面或 Android Back 只唤醒解锁按钮，不能触发播放、倍速、左右调节或退出；解锁、退出全屏和切换视频时恢复正常操作。
- 普通移动端视频左半区纵滑调亮度、右半区调音量。Android 调整 Activity 亮度与系统媒体音量，媒体元素保持 100% 音量；其他移动浏览器回退为亮度遮罩和元素音量。手势不改变播放/暂停状态，拖动时预览，松手提交音量记忆，原生音量由系统记忆。
- 底部 Shell 仅桌面端显示链接操作，移动端统一从播放器 HUD 菜单访问。详情侧栏保留底部安全区 padding。


### 播放偏好（循环播放、连播与音量记忆）

- 普通详情模式的「播放设置」弹层分为清晰度、倍速和播放偏好开关。开关行与设置页、字幕菜单同源（`Field` + `FieldLabel` + `Switch`，标签可点）；「循环播放」常驻，有列表时多一项「自动切集」，UGC 多一项「自动连播」；三项由 `playlistStore` 持久化到 localStorage `video-playlist`。
- 「播放下一个」按钮只认当前视频自身的选集：`nextSelectionItem` 按 PGC 分集表 / UGC 多 P / UGC 合集顺序取当前项的下一项，取不到（无选集或已在最后一集）就不传 `onNext`，按钮随之消失。它不沿来源队列 —— 来源队列的切换仍由键盘 `N`/`P` 与滑动承担，因此按钮在推荐、搜索、UP 投稿队列里不再出现。
- 推荐/热门/相关流队列保留手动切换，但不把下一条当作自动切集；搜索、UP 投稿及显式点选分 P/合集分集仍可自动连播；稿件信息不覆盖已有来源队列，无有效来源的多 P 直链仍自动建立选集队列。
- 一集播完后的动作由纯函数 `videoEndedAction(loopPlayback, autoPlayNext, hasNext, autoPlayRelated)` 决定，优先级固定：循环 > 连播下一集 > 连播相关视频 > 停住。`hasNext` 只看来源队列邻项，推荐/热门/相关流的邻项不计入（`getNextAutoPlayItem` 对 `feed` 返回 null），这类队列走完即落到相关连播。循环是「就看这一集」的显式意图，不该被连播带走；`autoPlayRelated` 是 UGC 专属偏好（PGC 没有相关视频列表，也没有可定位的 bvid），关闭或相关视频为空时停住。`ended` 读 `usePlaylistStore.getState()` 快照而不是播放器挂载时的闭包值，播放期间改偏好立刻生效。
- 两条连播的等待窗口不同：换集 1 秒，相关连播 3 秒。跳转前的校验按已定下的 `action` 只查它对应的开关现值（`stillWanted`），因此等待期间关掉开关、按暂停、换片或重播都会取消这次跳转；`cancelled`/`loopPlayback` 又是两条路径共用的守卫。
- 相关连播沿用来源队列耗尽时的同一条路径（`playRelatedItem`：取相关视频接口、按 `relatedPlaylistItems` 去重并滤掉当前视频、以 `feed` 类型装入队列、跳转第一个）。
- 循环重播走原生 `media.currentTime = 0` + `play()`（与 seek 同一条 DASH 路径）；进度已在 `ended` 里按总时长记满，观看历史仍认定「已看完」，下次进入从头播放。
- 音量与静音由 `src/shared/playerVolume.ts` 记在 localStorage `rlive-player-volume`，视频页、直播页、IPTV 播放页与录制回放共享同一份：初值取 `readPlayerVolume()`，音量/静音状态变化写 `rememberPlayerVolume()`（同值不重渲染，一次拖动最多写它经过的档位数，不需要节流）。不参与的两处：多画面按槽位各存一份音量（副画面默认静音是角色语义）；Android 真实音量是系统媒体音量（由 OS 记住），网页层固定 100 且不落盘，否则会把 100 写进桌面端的记忆。

### 换集过渡与 seek 边界

- 换集（合集/选集/相关视频跳转，cid 变化）时 `keepPreviousData` 的旧 playInfo 不能沿用：换集过渡（`switchingItem`，用「数据与 cid 对齐时刻」的 cid 比对判定）把 playInfo 抹成 undefined —— 播放器 effect 随之销毁旧实例（旧画面/声音立刻停住，不会先闪旧集首帧）、加载遮罩显示、旧播放错误清空；新集信息就位后重建。换画质/重试（同 cid）仍走旧播放器无缝续播路径。代理会话的停用链走 query 原始数据（不经被抹掉的 playInfo），保持 A→B 连续不泄漏。
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
- **续播判定**:`videoResumePosition` 只在「历史停在当前分集(`cid` 比对,取流键 UGC/PGC 都有)且未看完(距片尾 > 5s)」时返回旧位置,否则从 0 起播。续播位置写在元数据就位前(`media.currentTime` 直接赋值),与换画质续播同一条路径;续播查询未落定前不建播放器,避免「先播 0 秒再跳」闪帧。
- **跨分 P 续播**:URL 不带 `cid`(首页/搜索/UP 主卡片进入)时,取流键不再一律取详情给的 P1，而是 `videoResumeCid(record, archive)` 给的「上次看的那一 P」——「上次退出的地方」包含「上次看的是哪一 P」。它要求那一 P 确实在 `archive.pages` 里(合集换稿件与脏数据不算)且 `videoResumePosition` 认定有续播位置,否则退回 P1;稿件详情未到时返回 0。`cid <= 0` 期间播放器、播放列表与侧栏 effect 全部按「取流键未就绪」直接返回,否则会先按 P1 建列表再切、把播放列表锚在错误的一集上。落到非首 P 时提示一次「已续播上次观看的 P{n}」(`crossPartNoticeRef` 按 cid 去重,重建播放器不重复提示)。用户明确点过某一集(选集/播放列表/历史卡)时链接一定带 `cid`,这条路径不介入。
- **身份错位防线**:`historyEntry` 经渲染期 ref 供给播放器 effect(稿件标题/封面晚于播放器就位,闭包捕获会写成空);但只在非空时覆盖——离开播放页的路由切换会先以 `params=null` 再渲染一次,直接赋值会让卸载 flush 读到 null、丢掉最后一段进度。换集后 ref 指向新集,旧实例的 flush 由 `reportedCid` 比对丢弃,不会把旧集进度记到新集身上。
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
