# 短视频（竖屏流）调研：B 站与抖音

调研目标：B 站与抖音的短视频（竖屏流）实现方案与可用 API 入口，以及接入 rLive 的边界。
本文所有接口契约均为 2026-09 实机匿名请求验证结果，非文档推断；未验证的推论显式标注。

**落地状态**：B 站侧已实现，见[短视频功能](短视频功能.md)。实现期间有一条本文结论被实测推翻，已在 2.2 节更正。抖音侧尚未实现。

## 一、结论速览

| 维度 | B 站 | 抖音 |
| --- | --- | --- |
| 可用入口 | `x/v2/feed/index/story`（app / api 两个主机都放行） | `aweme/v1/web/tab/feed/`（必须 `a_bogus`） |
| 匿名可用 | 是，且**不需要 appkey/sign、不需要 WBI** | 是，只需 `ttwid` 引导会话 |
| 是否纯竖屏 | 否。`card_goto` 恒为 `vertical_av`，但 `dimension` 含横屏（实测 60 条：竖 37 / 横 23） | 否。实测为混合流（PC 首页推荐），竖屏占少数 |
| 竖屏判定 | 条目自带 `dimension{width,height,rotate}`，本地过滤 | 条目自带 `video.width/height`，本地过滤 |
| 翻页 | **无游标**，轮换流。12 次连拉 60 条零重复；`ps`/`count` 无效 | `has_more=1` 但无稳定游标；轮换流，单次 3~6 条 |
| 取流 | 完全复用现有 `x/player/wbi/playurl` + DASH 链路 | `play_addr.url_list` / `bit_rate[]` 直给渐进式 MP4 |
| 媒体代理 | 必须（现有 `stream_proxy` 注 Referer 即可） | 必须（`Referer: https://www.douyin.com/`，无 Referer 403） |
| 弹幕 | 有，`seg.so` 按 cid 复用现有实现 | 无点播弹幕概念 |
| 主要缺口 | 无 UP 主竖屏列表（`space/story/cursor` 一律 -400） | 作者作品列表与搜索需登录 Cookie |

一句话：**B 站短视频是纯增量**——列表解析之外的取流、弹幕、评论、历史全部已在 `video.rs` 里；**抖音短视频是新表面**——需要新建点播侧实现，且受登录门槛与 `a_bogus` 脆弱性约束。

## 二、B 站短视频

### 2.1 入口：story feed

```
GET https://app.bilibili.com/x/v2/feed/index/story
GET https://api.bilibili.com/x/v2/feed/index/story      # 同一负载，两个主机都放行
```

必要参数：**没有**。裸请求 + 浏览器 UA 即 `code: 0`。实测细节：

- **不需要 WBI**（与 `x/web-interface/view`、`playurl` 不同），**不需要 appkey/sign**。带 appkey 签名同样放行，两条路径负载一致。
- `Referer` 不敏感：无 Referer、`https://live.bilibili.com/`（站点默认值）、`https://www.bilibili.com` 三者结果相同 → 现有 `BilibiliSite::headers()` 可原样复用。
- **`buvid` 请求头是推荐引擎开关**：不带时 `track_id = gateway_fallback_…`；带 `buvid: <buvid3>` 时变为 `track_id = story_0.router-story-…`。仅在 cookie 里放 `buvid3`/`buvid4` **不生效**，必须是独立请求头。buvid 从既有 `ensure_buvid()`（`x/frontend/finger/spi`）取，现有 `headers()` 只写 cookie，需要额外加这一个头。
- `pull` 必须传 `1`/`0`；传字符串 `"true"` 直接 -400（PiliPlus 在另一个接口 `feed/index` 上用的是 `'true'`/`'false'`，两个接口口径不同，不能照搬）。

单条目字段（够直接建卡片，无需二次请求）：

| 字段 | 内容 |
| --- | --- |
| `bvid` / `param` | 稿件标识；`param` 是 aid 的字符串形态 |
| `player_args` | `{aid, cid, type:"av"}`，可选 `ugc_season_id` |
| `dimension` | `{width, height, rotate}` —— **竖屏判定唯一依据** |
| `duration` | 秒。实测 min 18 / 中位 89 / max 2903 → **story 流并不限定短视频**，长视频同样出现 |
| `stat` | `{aid, view, danmaku, reply, favorite, coin, share, like}` |
| `owner` | `{mid, name, face, fans, relation}` |
| `cover` / `ff_cover` | 常规封面 / 首帧图（`bfs/storyff/...`），均为 `http://`，需升级 https（现有 `video_cover` 已做） |
| `title` / `part` / `desc` | 标题与简介 |
| `season` | 合集信息（`season_id/current_index/total`），存在时可接现有合集连播 |
| `uri` | `bilibili://story/<aid>?cid=&player_height=&player_preload=<JSON>` |

实测 60 条无一条缺 `bvid`/`cid`/`aid`/`cover`/`owner.name`。

**`aid` 是超大整数**（实测 `117240846355180`），与现有文档一致：Rust 用 `i64`，跨 IPC 序列化为字符串。

### 2.2 翻页语义：轮换而非游标

story feed 没有 cursor/offset/page。实测：

- 连续 10 次（app 主机）：每次 3~5 条，总 41 条，**零重复**。
- 连续 12 次（api 主机）：总 60 条，**零重复**。
- `ps` / `count` / `pull_count` 均不改变返回条数。

因此「加载更多」= 反复请求 + 跨页去重。

> **更正（实现期实测）**：原文说这与抖音直播推荐 feed 的 `RECOMMEND_FEED_BATCHES` **并发**批次「完全同构」，**这一条是错的**。story 的轮换是服务端按时间推进的，并发请求会拿到同一批：3 路并发 15 条只有 6~11 条唯一（3 轮实测重叠率 27%~60%）。**串行**才零重复：连续 3 次串行 15 条 15 唯一，单次耗时约 400ms。
>
> 因此实现取串行两批（`STORY_FEED_BATCHES = 2`）+ 跨批去重，而不是并发。抖音直播 feed 的并发模式不适用于此。

### 2.3 内联 `player_preload`：可用但有反直觉的 Referer 语义

`uri` 的 `player_preload` 参数是一段 JSON，直接内联了一条**已签名的 360P MP4 地址**：

```json
{"cid":41720021928,"expire_time":1789368709,"quality":16,
 "url":"http://upos-lcdn-cqgl01.solseed.cn/upgcxcode/...&platform=android&gen=playurlv3&upsig=...",
 "file_info":{"16":[{"timelength":13119,"filesize":754294}]},"video_codecid":7,"fnver":0,"fnval":0}
```

实测该地址的 Referer 行为与现有视频 CDN **相反**：

| Referer | 结果 |
| --- | --- |
| 不带 | **206**（可播，支持 Range） |
| `https://www.bilibili.com` | **403** |
| `https://app.bilibili.com/` | 403 |
| `https://m.bilibili.com/` | 403 |

原因是这条 URL 的签名里带 `platform=android`（app 端 playurlv3 产物），CDN 按签名平台校验来源。**现有 `stream_proxy` 一律注入 `VIDEO_REFERER` 的做法会把它打成 403**。

结论：不要用内联 preload 作为播放源。story 列表拿到 `bvid + cid` 后直接走现有 `x/player/wbi/playurl`（web 平台签名、DASH、注 `https://www.bilibili.com`），链路与既有 UGC 播放完全一致。preload 的价值限于「预知时长/体积」这类元数据，或首帧预热（需要一条不注 Referer 的代理会话，属额外复杂度，不建议）。

### 2.4 取流与弹幕：零改动复用

用 story 条目的 `bvid`/`cid` 实测：

- `x/web-interface/wbi/view?bvid=` → `code 0`，`dimension` 与列表一致（`1080x1920`），`cid` 与 `player_args.cid` 相同。
- `x/player/wbi/playurl?bvid&cid&qn=112&fnval=4048&fourk=1&try_look=1` → `code 0`，`accept_quality [112,80,64,32,16]`，匿名实际只下发 480P/360P 的 `dash.video[]`（与现有文档「匿名最高 480P」一致），每条 representation 带 `segment_base` → 现有 sidx 解析 + MPD 合成链路直接可用。
- VOD 弹幕 `x/v2/dm/web/seg.so?type=1&oid=<cid>` 同接口同语义。

也就是说：**播放、清晰度、弹幕、评论、观看历史全部是现成的**，短视频只新增「列表 + 竖屏舞台」。

### 2.5 已排除的入口（不要再试）

| 候选 | 实测结果 |
| --- | --- |
| `app.bilibili.com/x/v2/feed/index/space/story/cursor`（UP 主竖屏流） | 一律 `-400`，即使按 PiliPlus 注释里的全参数（`vmid/aid/cid/before_size/after_size/contain/index` + `statistics`）+ appkey 签名。PiliPlus 自身也已把这段代码注释掉。**[INFERENCE]** 推测已迁至 gRPC 或需要 `access_key`（登录态），未验证 |
| `api.vc.bilibili.com/clip/v1/video/{index,search}`（旧「小视频」） | HTTP 404，接口已下线 |
| `x/web-interface/dynamic/region?rid=76`（旧小视频分区） | `-404 啥都木有` |
| `x/vertical/feed/index`、`x/web-interface/story/feed` | 非 JSON（错误页），不存在 |
| `app.bilibili.com/x/v2/feed/index`（app 主 feed） | `code 0` 但 `card_goto` 只有 `av`/`inline_av`，**不产出 `vertical_av`**，不能当竖屏源 |
| `x/web-interface/wbi/index/top/feed/rcmd`（web 推荐流） | `code 0`，但条目**无 `dimension`** → 无法判定竖屏 |
| `x/web-interface/popular`（热门） | 条目**有 `dimension`** → 可作为「竖屏热门」的补充来源，服务端过滤即可 |

### 2.6 story feed 与「短视频」的错配

必须明确：story feed 是**竖屏播放器入口流**，不是「短视频流」。两处证据：

1. `card_goto` 恒为 `vertical_av`，但 `dimension` 有 `1920x1080`、`3840x2160` 等横屏条目（60 条里 23 条横屏）。
2. `duration` 最长实测 2903s（48 分钟）。

所以产品语义要自己定：若要「短视频」，需按 `dimension.height > width`（`rotate` 非 0 时交换宽高）与时长上限双重过滤，并接受过滤后单次产出更少（约 3 条/次），靠并发批次补量。

rLive 最终选择**不过滤画幅也不限时长**（用户确认）：这一流本来就是混合画幅，舞台按原比例呈现两种都能看。

### 2.7 登录态与个性化（2026-10 实测修正）

问题：story feed 是否有「按 Cookie 做个性化推荐」的接口或参数？已设置 Cookie 时是否会用上？

**修正结论：web Cookie 递上去了，但这条 APP 侧 feed 不按它个性化。** 代码路径确实是
`resolve_bilibili` → `account::get_cookie` → `BilibiliSite::new(client, cookie)` → `headers()`
（`if !cookie.is_empty() { headers.push(("cookie", cookie)) }`），story 走
`get_json_with_buvid_header`（`public_headers = false`，即带 Cookie）。但真机登录态并发对照（25 轮）
证明：**有无 Cookie 对结果集的影响落在服务端轮换噪声内**；用种子把同一条目强制塞进 anon 与
login 响应逐字段对比，完全一致。个性化旋钮只有 `buvid`（设备轴）与种子参数。

（首页推荐 `x/web-interface/wbi/index/top/feed/rcmd` 的「有 cookie 才是个性化流」不适用于 story；
两者虽同走 `headers()`，但是不同的推荐场景。）

接口层面的四件事（均已实测）：

- **`aid`/`bvid` + `display_id` 是种子参数**，官方文档写 `aid`「会影响到后续视频内容」，
  `display_id`「第1页会得到比其他页多 aid 处所填视频」。实测：传入某个竖屏稿件的 `bvid`
  且 `display_id=1` 时，该稿件出现在结果首位，且与不传种子的结果集**零重叠**；只传种子不带
  `display_id` 时种子不进首位。rLive 已接（`video_story` 的 `seed`）。
- **`buvid` 请求头本身就是一根个性化轴**：两个全新设备 id（均无 Cookie）各拉 3 批，各自 15 条
  唯一 bvid，**交集只有 1 条**。但多个新设备号的**并集**收敛到同一个共享冷启动池（8 个新 buvid
  的并集仅 111 条）—— 因此轮换设备号会很快枯竭，必须固定（见功能文档「固定设备指纹」）。
- **APP 参数不改变结果集**：`login_event`/`mobi_app`/`platform`/`build`/`statistics`/`fnval`/`fourk`
  的组合实测均无显著影响。
- `access_key` 是 APP 侧的登录 Token（`app.bilibili.com` 那一路，需 appkey + sign）；网页侧没有
  这个参数。TV 端扫码登录链路可拿到它，但 rLive **暂缓**接入（收益未验证、凭据敏感）。

顺带记下另一个接口的口径差异：`x/web-interface/wbi/index/top/feed/rcmd`（首页推荐）**需要 WBI
签名**且 Cookie 才个性化，rLive 已实现（`video_recommend`）；它的条目**不带 `dimension`**
（实测 0/12），且混入广告/直播/番剧，无法当竖屏源。

## 三、抖音短视频

### 3.1 `a_bogus` 是硬门槛，无签名旁路

实测所有免签名路径均已失效：

| 路径 | 结果 |
| --- | --- |
| `www.iesdouyin.com/share/video/<id>/` 的 `_ROUTER_DATA` | 页面仍返回，但 `videoInfoRes` 为空对象、`item_list` 长度 0 —— 已不再 SSR 作品数据 |
| `www.iesdouyin.com/web/api/v2/aweme/iteminfo/?item_ids=` | 空 body |
| `aweme/v1/web/aweme/detail/` 不带 `a_bogus` | 空 body |
| `www.iesdouyin.com/web/api/v2/hotsearch/billboard/aweme/` | `status_code 0` 但 `aweme_list` 为空 |

因此点播侧必须复用 `src-tauri/src/sites/douyin/a_bogus.rs`（现成的纯 Rust SM3 + RC4 实现）与 `get_signed_json`。已验证：**这套现有签名对点播接口同样有效**，不需要新算法。

无头浏览器路径也不通：`https://www.douyin.com/` 与 `?recommend=1` 在无头环境直接返回「验证码中间页」（`title: 验证码中间页`，8.6 KB，无 `_ROUTER_DATA`/`RENDER_DATA`），抓不到竖屏 tab 的真实翻页请求。`/discover` 会 302 到 `/jingxuan`（精选＝横屏长视频页），只发 `multi/aweme/detail/`。

### 3.2 匿名放行的接口（`ttwid` + `a_bogus`）

公共参数沿用现有 web 客户端那套（`device_platform=webapp&aid=6383&channel=channel_pc_web` + 浏览器指纹位 + 每请求随机 `msToken`），会话由现有 `ensure_web_session()` 引导。

| 接口 | 结果 | 关键字段 |
| --- | --- | --- |
| `GET aweme/v1/web/tab/feed/` | `status_code 0`，单次 3~6 条，`has_more: 1` | `aweme_list[]` |
| `GET aweme/v1/web/aweme/detail/?aweme_id=` | `status_code 0` | `aweme_detail`（含完整 `video`） |
| `GET aweme/v1/web/aweme/related/?aweme_id=&count=` | `status_code 0` | `aweme_list` / `has_more` / `filter_infos` |
| `GET aweme/v1/web/comment/list/?aweme_id=&cursor=&count=20` | `status_code 0`，实测 20 条 | `comments` / `cursor: 20` / `has_more: 1` / `total` |

登录门槛（与既有直播搜索限制同源）：

| 接口 | 匿名结果 |
| --- | --- |
| `GET aweme/v1/web/aweme/post/?sec_user_id=` | `status_code 0` 但 `aweme_list` 长度 0、`has_more: 0`，响应含 `not_login_module` → 作者作品列表**需登录** |
| `GET aweme/v1/web/general/search/single/` | `status_code 2483`「请先登录」→ 命中现有 `login_required()` 映射 |

已排除：`aweme/v1/web/module/feed/`（空 body / 触发验证）、`aweme/v1/web/recommend/item_list/`（404）、`aweme/v1/web/feed/`（404）。**没有找到匿名可用的纯竖屏 feed 端点。**

### 3.3 `tab/feed` 是混合流，不是竖屏流

实测取向分布（`video.width/height`）：

- 桌面 UA：3 条全横屏（`1920x1080`、`1920x1180`、`2880x2160`），`ratio: "default"`。
- 移动 UA（`a_bogus` 用同一 UA 签名）：3 条中 1 条竖屏（`2160x3840`）。

`duration` 也证明它不是短视频流：实测 12734ms ~ 840533ms（14 分钟）。`media_type: 4`、`aweme_type: 0`、无 `images` → 都是视频稿件，非图文。

结论与 B 站一致：**取向由推荐决定，与 UA/参数无关，竖屏必须本地按 `width/height` 过滤。**

### 3.4 取流

`video.play_addr` 与 `video.bit_rate[]` 直接给可播地址，不需要额外的 playurl 接口：

- `play_addr`: `{url_list[], uri, url_key, data_size, file_hash, height, width}`，渐进式 MP4（`mime_type=video_mp4`）。
- `bit_rate[]`: 多档并列，`gear_name`（`normal_1080_0` / `1080_1_1` / `adapt_lowest_4_1` / `normal_720_0` / `low_720_0` / `normal_540_0`）、`bit_rate`、`is_h265`、`FPS`、各自的 `play_addr`。同一档位常有 h264（`is_h265: 0`）与 h265/bytevc1（`is_h265: 1`）两个变体 → **选流必须按编码过滤**，与 B 站 DASH 的 avc1/hvc1/av01 同理，默认取 h264 兼容性最好。
- 另有 `play_addr_h264` / `play_addr_265` 两个显式字段可直接取。

CDN 行为（`v11-web-prime.douyinvod.com` / `v26-web.douyinvod.com`）实测：

| 条件 | 结果 |
| --- | --- |
| 无 Referer | **403**（`text/html`，375 B） |
| `Referer: https://www.douyin.com/` | **206** `video/mp4` |
| 带 Referer + `Range: bytes=1000000-1065535` | 206，`Content-Range: bytes 1000000-1065535/38088075` |
| CORS | `Access-Control-Allow-Origin: *`，`Access-Control-Expose-Headers` 含 `Content-Range` |

即：虽然有 `ACAO: *`，但 WebView 无法自行设置 Referer → **必须经 `stream_proxy` 注入 `Referer: https://www.douyin.com/`**，与 B 站 m4s 分片同一手法。URL 自带短时 `expire`（实测约 3 小时），失败即重取详情。

因为是渐进式 MP4（非 DASH/HLS），播放侧直接 `<video src=代理地址>`，不需要 dash.js，也不需要 sidx/MPD 合成。

## 四、接入 rLive 的边界

### 4.1 B 站（纯增量）

复用（不要重写）：`x/player/wbi/playurl` 取流与 sidx/MPD 合成、`seg.so` 弹幕、评论、`video_history` 观看历史、`stream_proxy`。

需要新增的最小集合：

1. `sites/bilibili/video.rs` 加一个 story 列表解析（`parse_story` + 对应 IPC 命令），字段映射进现有 `VideoItem`；`VideoItem` 需补 `dimension`（现有结构没有这个字段，竖屏判定要用）。
2. `BilibiliSite::headers()` 或 story 专用请求路径补 `buvid` **请求头**（现有实现只写 cookie），否则拿到的是 `gateway_fallback` 降级流。
3. 列表页复用抖音直播推荐 feed 的「并发批次 + 跨页去重 + 新条目耗尽即停」模式（无游标轮换流）。
4. 竖屏舞台：现有播放页详情区固定 `aspect-video` 且竖屏画面居中留黑边（见 `B站视频功能-设计.md` 第六节），短视频若要全屏竖屏消费需要另一套舞台，属 UI 工作量的主要部分。

### 4.2 抖音（新表面）

`DouyinSite` 目前只实现 `LiveSite`。点播不属于该 trait（其他站点无对应概念），应照 `bilibili/video.rs` 的做法作为 inherent impl 追加（例如 `sites/douyin/video.rs`），复用同一份 cookie、`ensure_web_session` 与 `a_bogus`。

能做到：竖屏推荐流（`tab/feed` + 本地取向过滤）、单作品详情、相关推荐、评论（含游标翻页）、经 `stream_proxy` 的多档位播放。

做不到（不要伪造）：作者作品列表与搜索（需登录 Cookie，与既有「抖音搜索需登录」同源）；无点播弹幕。

## 五、风险

- **B 站 story 无游标**：条数由上游轮换决定，前端「加载更多」是概率性的，会在新条目耗尽时自然终止；竖屏过滤后单次产出更少。
- **B 站 `buvid` 头依赖**：这是行为观测（`track_id` 前缀变化），不是上游承诺；失效时退化为 `gateway_fallback` 流，仍可用但推荐质量下降。
- **抖音 `a_bogus` 脆弱**：算法与参数约定跟随抖音网页端，上游调整即需同步更新（既有文档已列明这条限制）。
- **抖音验证页**：列表/详情随时可能返回访问验证，现有 `douyin_browser_verification` 错误映射已覆盖。
- **两侧地址均为短时签名**：B 站 playurl 与抖音 `play_addr` 都带 `expire`，播放失败必须重取，不可缓存落盘。
- **风控**：B 站 story 未见 -352（无 WBI 也放行），但高频请求未做压力验证；抖音沿用现有 `ttwid` 会话缓存（30 分钟 TTL）即可，无需每次引导。

## 六、验证方式

本文结论由以下方式取得，均为一次性验证脚本 / 临时探测（已删除，未留入仓库）：

- B 站：直接 HTTP 请求 `feed/index/story`（app / api 两主机、裸 query 与 appkey 签名两种形态）、`finger/spi`、`wbi/view`、`wbi/playurl`、`top/feed/rcmd`、`popular`，以及 preload 直链的 Referer 矩阵（`curl -r` Range 探测）。
- 抖音：在 `sites/douyin/mod.rs` 测试模块内临时接入 `a_bogus::generate_a_bogus` + `ensure_web_session` 发真实请求（覆盖 `tab/feed`、`aweme/detail`、`aweme/related`、`comment/list`、`aweme/post`、`general/search/single`、`module/feed`、`recommend/item_list`、`web/feed`，含移动 UA 变体），CDN 可播性用 `curl` Range 验证；无头浏览器用于确认 web 根路径的验证码拦截。
