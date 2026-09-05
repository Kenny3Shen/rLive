# B 站视频（VOD）功能设计

参考实现：PiliPlus（Flutter）。本文的每条 API 契约与技术结论均在 2026-09 实机请求验证过，非文档推断。

## 一、已锁定的产品决策

- 入口：**新增侧栏「视频」目的地**，独立路由 `/video`。现有首页的直播平台条（B站/斗鱼/虎牙/抖音/Twitch）完全不动。
- 头部整行 = 四个内容页签「推荐 / 热门 / 番剧 / 影视」；其下一条**分区条**；再下是内容网格。
- 番剧 / 影视点进去**要能播**（PGC playurl），与 UGC 是两套播放链路。
- 画质走 **DASH**，使用官方 `xgplayer-dash` 插件（已装 `3.0.26`，与 `xgplayer` 版本严格对齐）。
- **VOD 弹幕一起做**（`seg.so` protobuf 分段接口）。

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
| 推荐 | `GET /x/web-interface/wbi/index/top/feed/rcmd`，`version=1&feed_version=V8&homepage_ver=1&ps=<n>&fresh_idx=<i>&brush=<i>&fresh_type=4` | **需 WBI**；有 cookie 才是个性化流，匿名返回通用流。取 `data.item[]`，只保留 `goto=="av"` 且有 `owner` |
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
| 相关视频 | `GET /x/web-interface/archive/related?bvid=` | 无 WBI、匿名可用。`data[]` 与热门条目同构，一次给全 |
| 评论 | `GET /x/v2/reply/wbi/main?type=1&oid=<aid>&mode=<2\|3>&ps=20&next=<cursor>`，WBI 签名 | 签名 + **匿名时不得携带任何 cookie**：实测携带 buvid3/4 的匿名会话只回 3 条并谎称 `is_end=true`（无 cookie 才给全量 20 条）；未签名裸路径被风控后一律 -352，签名路径放行。登录态带完整 cookie 同路径。置顶有两处：`data.top_replies[]` 与 `data.top.upper`（UP 主置顶对象，参考 PiliPlus 两者都解析） |
| 二级回复 | `GET /x/v2/reply/reply?type=1&oid=<aid>&root=<rpid>&pn=&ps=20&sort=2` | 匿名可用（不受 buvid 截断影响）。**pn 翻页有效**；`data.page.count` 是总数 |

分区 rid（PiliPlus 硬编码，非 API）：全站 0、动画 1005、音乐 1003、舞蹈 1004、游戏 1008、知识 1010、科技 1012、运动 1018、汽车 1013、美食 1020、动物 1024、鬼畜 1007、时尚 1014、娱乐 1002、影视 1001。
season_type：番剧 1、电影 2、纪录片 3、国创 4、剧集 5、综艺 7。

**`aid` 已是超大整数**（实测 `117191437455648`），Rust 必须 `i64`；跨 IPC 建议序列化为字符串，前端只当标识符，禁止参与算术。

## 四、DASH：三个关键实测结论

### 1. `segment_base.index_range` 是 sidx box，可解析出完整分片表

`playurl` 每个 representation 给 `segment_base: { initialization: "0-937", index_range: "938-1601" }`。按 `index_range` 发一次 Range 请求拿到的正是 `sidx` box。实测解析出 52 片 / 5s 一片 / `timescale=16000`。

每片自带 `moof`+`mdat`，且 `tfdt` 与 sidx 累加时间轴**精确相等**（逐片核对 seg0/1/5/51 全部 match）→ **MSE 乱序 append 安全**，不必保证下载顺序。init 段只有 `ftyp`+`moov`。

同一画质有多编码变体（avc1 / hvc1 / av01）并列，**选流必须按 codec 过滤**，默认取 `avc1` 兼容性最好。

### 2. CDN 分主机行为不同 → 必须走代理

| 主机 | 无 Referer | CORS |
| --- | --- | --- |
| `*.mcdn.bilivideo.cn` | 206 可用 | `ACAO=*` |
| `*.edge.mountaintoys.cn` | **403** | `ACAO=*` |
| `upos-*.bilivideo.com` | **403** | **无 ACAO** |

不能赌 base_url 落在 mcdn 上，**一律经 `stream_proxy` 注入 Referer**。

### 3. `xgplayer-dash@3.0.26` 四个硬坑（已读源码 + 浏览器验证）

- **MPD 解析器不认 `SegmentBase`**（`es/parse/box/sidx.d.ts` 是空的，只实现了 `SegmentTemplate` / `SegmentList`）→ 必须我们自己解析 sidx，合成带 `SegmentList` 的 MPD。`SegmentList` 支持 `<Initialization range>` 与 `<SegmentURL mediaRange>`，且 `resolveSegmentURL` 对 `^https?://` 直接放行，可以塞绝对代理 URL。
- **`Task` 按 URL 去重**（`es/media/task.js`：`Task.queue.some(item => item.url === url)` 命中就直接 return，连 XHR 都不建）。Bilibili 是「一条 URL + 不同 Range」，会导致**除首片外全部被静默丢弃**、播放卡死。→ **每个分片 URL 必须拼唯一 query**（如 `&seg=<idx>`），上游忽略该参数。
- 取 MPD 的 `es/util/xhr.js` 会给 URL **拼 `?`**，`blob:` 精确匹配因此 404 → **MPD 必须由 HTTP 提供**，不能用 blob URL。
- **`SegmentList` 被当成等长分片展开**（`es/m4s/mpd.js`：`start = index × 标称 duration`，既不认 `SegmentTimeline` 也不解析 sidx）。B 站按关键帧切片、单片长度不等（实测 5s 片里混 2.7s 片），偏差一路累积；而 `mpd.seek(t)` 只在「`t`、`t ± 该片时长`」三个窗口里挑分片，偏差超过一片时长后就再也挑不到真正覆盖 `t` 的那片 —— seek 后媒体元素永远停在 `waiting`，插件下一轮轮询算出同样的目标、命中已下载的邻片，于是死锁。→ 两道措施：
  - 后端标称 `duration` 取**平均槽位**（`mediaPresentationDuration / 片数`）而不是首片时长。取首片时 `片数 × 首片时长 > 总时长`，末片槽位倒挂（`start ≥ end`）、任何时刻都选不中，最后一片永远拉不到数据。
  - 真实逐片边界由 `Sidx::segment_times`（N+1 项，分片 `k` 覆盖 `[t[k], t[k+1])`）随 play-info 下发，前端 `applyXgDashSegmentTimeline` 在插件挂上 `dash` 后（`resourceReady`/`canplay`）把分片表改写成真实时刻，选片精确到分片级。条数与边界数不符时拒绝改写（那不是这条轨的时间轴）。

### 已验证的浏览器结论

Python 桩服务（模拟 stream_proxy：注入 Referer + 转发 Range）+ 合成 MPD + esbuild 打包 `xgplayer` & `xgplayer-dash`，Chromium 实跑：

- 播放正常：`currentTime` 46.7s → 189.8s，`854x480`，`readyState: 4`。
- **音轨已挂载**：`sourceBuffer` 同时含 `video/mp4;codecs="avc1.640033"` 与 `audio/mp4;codecs="mp4a.40.2"`，`audioBytes` 持续增长。
- **seek 成立**：跳 180s 后在 189.8s 继续播，`buffered` 出现新区间 `[175.46, 210]`。
- 曾观察到只挂载 video 轨：根因是桩服务单线程 502 导致插件 `MPD.init` 走重试路径、把 `mediaList.audio` 换成新数组从而丢掉 `selectedIdx`。桩服务加连接复用与重试后消失。**真实实现里 `stream_proxy` 必须稳定返回，502 会连带打掉音轨。**

参考实现（可移植到 Rust）：`parse_sidx()` 与 `mpd_xml()`，见本轮 `/tmp/dashtest/serve.py`（临时文件，不入库）。

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
- 前端复用直播的 `DanmakuComposer`（`video` prop 切换目标：cid/aid/progressMs 入参，毫秒与上游 progress 对齐），挂在控制栏居中槽位（`centerSlot`，直播页 composer 同款落点，播放列表计数排其后）；compact 且非全屏时 centerSlot 不渲染，回退控制条上沿。显隐随控制条，快捷表情/收藏/历史选择器同套可用；**键盘焦点在控制条内（正在输入弹幕）时控制条不休眠**，否则输入到一半会被闲置计时器连草稿一起淡出。

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

- UGC 页签顺序：选集（多 P 时，含折叠合集）/ 相关视频 / 评论 / 弹幕（最右）；仅合集（无分 P）时第三个页签显示为「合集」；PGC：分集 + 评论。宽屏在右（300px，xl 320px），窄屏列在播放器下方滚动。
- 多 P 稿件（`pages` ≥ 2）自动展示「选集」页签并接管连播列表：点任意 P 跳转（同 bvid、按 cid 取流），当前 P 按 cid 高亮。选集与合集共用一个页签（`PartsSeasonPanel`）：同时存在时选集展开、合集折叠成标题行（点击展开，连播沿分 P 列表走）；无分 P 的合集直接展开、连播沿合集走。两区标题行都是收起开关（`ChevronDown` 旋转 + `aria-expanded`）：选集行左侧「选集」、右侧「共 x P」计数，点按切换列表显隐；收起态不跨稿件沿用（`PartsPanel` 以 bvid 为 key，换稿件重挂即默认展开），收起后再展开会把当前 P 重新滚回可视区。
- 评论的 `oid` 是 aid：列表/分集链路经路由参数携带；URL 直入时 UGC 用稿件详情补齐，PGC 用 season 详情里当前集的 aid。
- 评论游标翻页（`next`），二级回复 pn 翻页（首传 1）；`[大哭]` 占位符按 `content.emote` 映射换成内联图。

### 顶栏低频工具与控制布局

- 顶栏（`topBar`）右侧只留投屏 `Tv` Popover 弹层（`side="bottom" align="end"` + glass，与直播页顶栏 `RoomToolPopover` 同一形态语义）；跳原址/复制链接在底部常驻 Shell。
- 两种全屏相互独立、可叠加（与直播页同语义）：**窗口全屏**（`webFullscreen`，PlayerControls 内置「网页全屏」按钮，`Expand/Shrink` 图标）隐藏页面 chrome（顶栏/侧栏/底部 Shell）让舞台撑满应用窗口、保留系统窗口栏（最小化/最大化/关闭），Escape 退出；**画面全屏**（`useRecordingPlayerFullscreen` 的元素级/top layer 或桌面原生窗口全屏，「全屏（F）」按钮）盖住一切。两层叠加时 HUD 返回箭头与 Escape 一次只收一层（元素全屏优先）。
- 控制栏保留高频播放控制与字幕（CC）按钮；字幕弹层改为 `PlayerControls` 内置弹窗同族的 Popover（`side="top" align="end"` + glass + `portalContainer` 指向舞台），替代原先手工绝对定位的面板。控制栏居中槽位是弹幕输入条（见第五节「弹幕发送」）。
- 画面全屏或窗口全屏时舞台顶部渲染轻量 HUD（`data-player-hud`，复用 `player-scrim-overlay-top` 渐变）：左侧返回箭头（按层级退出）、中间标题、右侧投屏弹层（`container` 指向 `stageRef`，规避 top layer 压盖）加跳原址镜像。HUD 与底部控制栏共用 `setChromeVisible` 显隐调度（同一 `data-visible` 机制），不引入第二套空闲计时器。
- 底部常驻 Shell（`footer`，与直播页底部操作行同一画法：`border-t` + `bg-sidebar/90` + 安全区 padding，右对齐）：「复制链接」（`Link2`，`copyText` 写 B 站原址 + toast）与「在浏览器中打开」（`ExternalLink`，最右，`tauri-plugin-opener` 直跳系统浏览器、失败回退 `window.open`）。所有断点常驻（视频页没有直播页的移动端溢出菜单可承接），触屏加高 `max-md:h-11`。


### 换集过渡与 seek 边界

- 换集（合集/选集/相关视频跳转，cid 变化）时 `keepPreviousData` 的旧 playInfo 不能沿用：换集过渡（`switchingItem`，用「数据与 cid 对齐时刻」的 cid 比对判定）把 playInfo 抹成 undefined —— 播放器 effect 随之销毁旧实例（旧画面/声音立刻停住，不会先闪旧集首帧）、加载遮罩显示、旧播放错误清空；新集信息就位后重建。换画质/重试（同 cid）仍走旧播放器无缝续播路径。代理会话的停用链走 query 原始数据（不经被抹掉的 playInfo），保持 A→B 连续不泄漏。
- seek 上限离时长留 0.25s 余量：跳到正正好 `duration` 会被媒体元素当成播放结束，留余量让最后一帧真的播出来、再自然触发 ended（自动连播走正常路径）。「跳到最后无限加载不进下一 P」的真正根因是分片表被当成等长展开（见第二章第 3 节第四坑）：末片槽位倒挂 + 逐片偏差累积，插件永远选不中覆盖目标时刻的分片。仅靠这个余量遮不住它 —— 偏差大的稿件在中段 seek 同样会卡死（实测 1069s 稿件跳 500s 即复现）。

### 跳原址与复制链接（底部 Shell）

- 底部 Shell 右侧的「在浏览器中打开」按钮：与直播页同一套交互 —— 点击经 `tauri-plugin-opener` 打开系统浏览器（失败回退 `window.open`）、toast 通知结果，不在界面上展示具体地址。全屏 HUD 里另有图标镜像（见上节）。

### 评论接口的三个坑（实测 + PiliPlus 对照）

1. **匿名携带 buvid 会被截断**：只要 cookie 里有 buvid3/buvid4，主列表只回 3 条并谎称 `is_end=true`；无 cookie 才给全量。PiliPlus 同样在匿名请求里显式强制空 cookie。
2. **裸路径会吃 -352**：未签名的 `/x/v2/reply/main` 在高频请求后会被风控拒（换 oid 也一样）；走 `/x/v2/reply/wbi/main` + WBI 签名则稳定放行。
3. **置顶的两种形态**：`data.top_replies[]` 与 `data.top.upper`（UP 主置顶对象）可能只给其一，解析时都取、按 rpid 去重。

## 七、观看历史（进度续播）

参考 PiliPlus 的「同一作品一条记录」语义:SQLite 新增 `video_history` 表(schema v3→v4 增量迁移),主键 `(kind, oid)`——UGC 的 oid 是 bvid,PGC 是 season_id。同一稿件换分 P、同一番剧换集只更新原行的 `progress`/`cid`/`ep_id` 与元数据,历史列表不会被一部番的几十集刷满。保留上限 500 行,插入后触发器按 `watched_at` 淘汰最旧,与直播 `history` 的 2,000 行上限同一手法。配置包 v2 追加 `video_history` 字段(`#[serde(default)]`,旧导出按空表导入)。

前端约定(`videoHistory.ts` 纯逻辑 + 播放页接线):

- **上报节流**:播放中经 `timeupdate` 上报,间隔 ≥ 5s 且进度 ≥ 3s(点开就退/拖动预览不污染历史);首次越过 3s 立即落一笔「打开过」。暂停、ended(记满时长)、离开播放页(effect 清理)三个时机强制 flush。
- **续播判定**:`videoResumePosition` 只在「历史停在当前分集(`cid` 比对,取流键 UGC/PGC 都有)且未看完(距片尾 > 5s)」时返回旧位置,否则从 0 起播。续播位置写在元数据就位前(`media.currentTime` 直接赋值),与换画质续播同一条路径;续播查询未落定前不建播放器,避免「先播 0 秒再跳」闪帧。
- **身份错位防线**:`historyEntry` 经渲染期 ref 供给播放器 effect(稿件标题/封面晚于播放器就位,闭包捕获会写成空);但只在非空时覆盖——离开播放页的路由切换会先以 `params=null` 再渲染一次,直接赋值会让卸载 flush 读到 null、丢掉最后一段进度。换集后 ref 指向新集,旧实例的 flush 由 `reportedCid` 比对丢弃,不会把旧集进度记到新集身上。
- **历史页第三视图**:「观看历史 / 视频历史 / 弹幕历史」三态切换(`view` search 参数)。视频卡片显示封面(缺省回退图标)、时长标签、底边进度条、「已看到 X / Y」与分集副行;点击整卡带着 `cid` 续播进播放页;单条删除乐观更新,清空有确认弹窗。视频只有 B 站一个来源,不参与平台筛选,`historyGrouping` 因此拆成 `filterHistoryBySite`(带 `site_id` 的时间线用)+ `groupHistoryByDate`(通用按日分组)。

## 八、待办与风险

MPD 交付：`stream_proxy` 加**纯增量**文本模式（新增命令返回 `application/dash+xml`），video / audio / mpd 各用**独立 `session_id``（`start` 按 session 覆盖同名代理），离开播放页三个一起停，防连接泄漏。

风险：风控 -352（靠 WBI + buvid3 + Referer + 真 UA 规避）；匿名最高 480P、1080P+ 需大会员；PGC 有版权与地区限制，需要可读的失败态；分区条不能直接复用 `CategoryBar`（它按 `LiveCategory` 类型），但应抽出 `CHIP_HEIGHT` / `CHIP_RADIUS` / `CHIP_TOUCH_TARGET` 与滚动/键盘逻辑共用；Shell 里视频页的 `groupStrip` 必须是四个内容页签，不能复用 `sitePlatforms`。
