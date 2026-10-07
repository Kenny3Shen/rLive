//! B 站视频（VOD）的 Tauri 命令。
//!
//! 与直播命令分开的原因见 [`crate::sites::bilibili::video`]：VOD 是 Bilibili
//! 独有表面，不经过跨站点的 `LiveSite` trait。

use std::collections::HashMap;

use tauri::State;

use crate::account;
use crate::error::{AppError, AppResult};
use crate::models::live::SiteId;
use crate::models::video::{
    PgcListPage, VideoArchive, VideoCastSource, VideoCommentPage, VideoDanmakuSegment,
    VideoListPage, VideoPlayInfo, VideoPlayRequest, VideoPlayerMeta, VideoSeason, VideoSessionIds,
    VideoStoryDirection, VideoStoryboard, VideoUploaderStoryPage,
};
use crate::sites::bilibili::BilibiliSite;
use crate::sites::bilibili::video::VideoTrack;
use crate::state::AppState;
use crate::stream_proxy::{PrefetchedInitialization, StreamProxy, StreamProxyStartOptions};

/// 播放代理的创建事务；部分失败或 future 被取消时只回滚本次实例。
/// ID 必须由调用方新建，不能使用会被其他播放者复用的内容键。
pub(super) struct PlaybackProxyLease<'a> {
    proxy: &'a StreamProxy,
    ids: Vec<String>,
    committed: bool,
}

impl<'a> PlaybackProxyLease<'a> {
    pub(super) fn new(proxy: &'a StreamProxy, ids: impl IntoIterator<Item = String>) -> Self {
        Self {
            proxy,
            ids: ids.into_iter().collect(),
            committed: false,
        }
    }

    pub(super) fn commit(mut self) {
        self.committed = true;
    }
}

impl Drop for PlaybackProxyLease<'_> {
    fn drop(&mut self) {
        if !self.committed {
            for id in &self.ids {
                self.proxy.stop_for_session(id);
            }
        }
    }
}

fn video_session_ids(content_key: &str) -> VideoSessionIds {
    let base = format!("{content_key}-{}", uuid::Uuid::new_v4().simple());
    VideoSessionIds {
        video: format!("{base}-video"),
        audio: format!("{base}-audio"),
        mpd: format!("{base}-mpd"),
    }
}

/// 每条轨只缓存**起播前缀**的秒数。
///
/// 缓存收益全部兑现在「从零到 `canplay`」这一段（init 段 + 开头几个分片）：回滑与
/// 重进要的是马上出画，不是把整条看完。而顺向刷时写进去的字节基本不会被读回 ——
/// 实测清空缓存后 20 分钟浏览就写满 475MB / 640 个文件，其中绝大多数是只播过一次
/// 的条目，等于用预算换了一堆不会再读的字节。只留前缀让同样的预算覆盖多得多的
/// **不同条目**，命中率随之上升：存得多不如存得广。
const MEDIA_CACHE_PREFIX_SECS: f64 = 10.0;

/// 一条轨的可缓存字节区间：init 段 + 起播前缀内的分片。
///
/// 只有这些区间会被落盘。任意 Range 一律不缓存 —— 否则同一个分片被不同 Range
/// 切成无数个键，缓存碎片化且命中率归零。
fn segment_ranges(track: &VideoTrack) -> Vec<(u64, u64)> {
    let mut ranges = Vec::with_capacity(track.sidx.segments.len() + 1);
    // init 段无条件保留：它是起播的第一个请求，也是取流阶段预取落盘的那个键。
    ranges.push((0, track.init_end));
    let timescale = f64::from(track.sidx.timescale);
    // sidx 只给逐片 `t_end`：分片 k 的起点是上一片的 `t_end`（首片为 0）。
    let mut start_time = 0_u64;
    for (index, segment) in track.sidx.segments.iter().enumerate() {
        // 首片无条件保留（起播就靠它）。其余只保留**起点**落在前缀窗口内的：
        // 窗口边界落在片内时整片保留，不做半片裁剪 —— 键必须与播放器的
        // `mediaRange` 逐字节一致，裁剪过的区间不会被命中。
        let within_prefix = index == 0
            || (timescale > 0.0 && start_time as f64 / timescale < MEDIA_CACHE_PREFIX_SECS);
        if !within_prefix {
            break;
        }
        ranges.push((segment.start_byte, segment.end_byte));
        start_time = segment.t_end;
    }
    ranges
}

/// 下一分集预加载只碰**起播最小集**：init 段 + 首个媒体分片。
///
/// 复用 [`segment_ranges`] 的前两项而不是另写一套字节区间：播放器切换分集时
/// 发出的 Range 必须与这里的键逐字节一致，两套规则早晚会漂移。窗口大小由
/// [`MEDIA_CACHE_PREFIX_SECS`] 决定，这里只截断到「首片」。
fn first_segment_ranges(track: &VideoTrack) -> Vec<(u64, u64)> {
    let mut ranges = segment_ranges(track);
    ranges.truncate(2);
    ranges
}

/// 构造一个带已保存 cookie 与代理设置的 Bilibili 客户端。
///
/// 与 `site.rs::resolve_site` 取的是同一份快照，因此登录态天然复用；
/// 但那个函数返回 `Box<dyn LiveSite>`，拿不到 VOD 的 inherent 方法，
/// 所以这里返回具体类型。
fn resolve_bilibili(state: &AppState) -> AppResult<BilibiliSite> {
    let (cookie, route) = {
        let conn = state.conn()?;
        (
            account::get_cookie(&conn, &SiteId::Bilibili)?,
            crate::settings::get(&conn)?.proxy_route(),
        )
    };
    let client = crate::http_client::client_for_route(&route)?;
    Ok(BilibiliSite::new(client, cookie.unwrap_or_default()))
}

/// 本机存有 TV 凭据就启用个性化：授权是唯一事实来源，不再有单独开关。
/// 扫码即生效、移除授权即回匿名，两套状态合并成一套。
///
/// 凭据临近到期或已被服务端拒绝时会自动续期；续期轮换了 `refresh_token`，
/// 因此新凭据必须落库，否则下一次请求仍拿旧值重试。
async fn resolve_app_feed(state: &AppState) -> AppResult<BilibiliSite> {
    let (credential, route) = {
        let conn = state.conn()?;
        let settings = crate::settings::get(&conn)?;
        (account::bilibili_app::load(&conn)?, settings.proxy_route())
    };
    let site = resolve_bilibili(state)?;
    let Some(credential) = credential else {
        return Ok(site);
    };
    let mut auth = account::bilibili_app::AppAuth::new(credential, &route).await?;
    if let Some(renewed) = auth.take_renewed() {
        let conn = state.conn()?;
        account::bilibili_app::save(&conn, &renewed)?;
    }
    Ok(site.with_app_auth(auth))
}

/// 读取推荐接口偏好。设置读取失败向上报错：这是用户显式选择的上游，
/// 静默换一个流会让「切换无效」变成无法排查的现象。
fn recommend_api(state: &AppState) -> AppResult<crate::models::settings::VideoRecommendApi> {
    let conn = state.conn()?;
    Ok(crate::settings::get(&conn)?.video_recommend_api)
}

#[tauri::command]
pub async fn video_get_recommend(
    state: State<'_, AppState>,
    page: u32,
    page_size: Option<u32>,
) -> AppResult<VideoListPage> {
    let api = recommend_api(&state)?;
    let site = if api == crate::models::settings::VideoRecommendApi::App {
        resolve_app_feed(&state).await?
    } else {
        resolve_bilibili(&state)?
    };
    site.video_recommend(api, page, page_size.unwrap_or(20))
        .await
}

#[tauri::command]
pub async fn video_get_popular(
    state: State<'_, AppState>,
    page: u32,
    page_size: Option<u32>,
) -> AppResult<VideoListPage> {
    resolve_bilibili(&state)?
        .video_popular(page, page_size.unwrap_or(20))
        .await
}

/// 短视频流（story feed）。
///
/// 上游无游标：`page` 不传给上游，只是前端无限列表的页号，每次调用都拉下一批
/// 轮换内容。跳页不可能，重复由前后端各自去重（后端跨批、前端跨页）。
///
/// `more` 是「这次是补货还是首屏」的粗语义，不是批数：一次扣多少次接口属于上游
/// 调用策略，两个档位与夹取都在 `sites/bilibili/video.rs`。让前端传具体数字的话，
/// 那个数字会在两个语言里各存一份，而且前端改大就绕过了夹取。首屏不传即快路径。
///
/// `seed` 是「以某条视频为起点继续刷」的种子（上游 `bvid` + `display_id=1`）。
/// 实测它能绕开黏性头部：种子稿件排首位，且与不带种子的结果集零重叠。前端传**当前
/// 正在看的那条**（滑到哪就从哪继续），首屏还没条目可传时传 `null`。
///
/// 账号个性化由 TV 授权（`resolve_app_feed` 注入 `access_key`）提供，因此这条命令
/// 不再自己记「最近发过什么」：推荐由上游按账号给，本地只做跨批去重。
#[tauri::command]
pub async fn video_get_story(
    state: State<'_, AppState>,
    more: Option<bool>,
    seed_bvid: Option<String>,
) -> AppResult<VideoListPage> {
    let site = resolve_app_feed(&state).await?;
    let seed = seed_bvid
        .map(|bvid| bvid.trim().to_string())
        .filter(|bvid| !bvid.is_empty());
    site.video_story(more.unwrap_or(false), seed.as_deref())
        .await
}

/// 作者 story 使用真实双向游标，不经过推荐流的本地去重。
#[tauri::command]
pub async fn video_get_uploader_story(
    state: State<'_, AppState>,
    mid: String,
    cursor_aid: Option<String>,
    direction: Option<VideoStoryDirection>,
) -> AppResult<VideoUploaderStoryPage> {
    resolve_bilibili(&state)?
        .video_uploader_story(&mid, cursor_aid.as_deref(), direction.unwrap_or_default())
        .await
}

/// UGC 分区榜。`rid` 取自 [`crate::sites::bilibili::VIDEO_ZONES`]。
#[tauri::command]
pub async fn video_get_zone(state: State<'_, AppState>, rid: i64) -> AppResult<VideoListPage> {
    resolve_bilibili(&state)?.video_zone(rid).await
}

/// 可选的 UGC 分区列表（上游无对应接口，由后端提供以免前端硬编码）。
#[tauri::command]
pub fn video_zone_list() -> Vec<(String, i64)> {
    crate::sites::bilibili::VIDEO_ZONES
        .iter()
        .map(|(name, rid)| ((*name).to_string(), *rid))
        .collect()
}

/// PGC 索引。番剧传 `season_type = 1` 且 `index_type = None`；
/// 影视传 `season_type = 1` 且 `index_type = Some(102)`。
#[tauri::command]
pub async fn video_get_pgc_index(
    state: State<'_, AppState>,
    season_type: i64,
    index_type: Option<i64>,
    page: u32,
) -> AppResult<PgcListPage> {
    resolve_bilibili(&state)?
        .video_pgc_index(season_type, index_type, page)
        .await
}

#[tauri::command]
pub async fn video_get_season(
    state: State<'_, AppState>,
    season_id: Option<String>,
    ep_id: Option<String>,
) -> AppResult<VideoSeason> {
    resolve_bilibili(&state)?
        .video_season(season_id.as_deref(), ep_id.as_deref())
        .await
}

/// 媒体流向上游携带的请求头：部分 CDN 主机缺 Referer 直接 403。
fn video_stream_headers() -> HashMap<String, String> {
    HashMap::from([
        (
            "user-agent".to_string(),
            crate::sites::bilibili::DEFAULT_USER_AGENT.to_string(),
        ),
        (
            "referer".to_string(),
            crate::sites::bilibili::video::VIDEO_REFERER.to_string(),
        ),
    ])
}

/// 为下一分集预热起播字节。
///
/// 它**不拉起任何播放代理**，也不合成 MPD：只把该分集的 init 段与首个音视频分片
/// 写进与正常播放完全相同的分片缓存键。用户在选集里点下一集时，播放器的头两个
/// Range 请求就落在本机。
///
/// 只取这两段是刻意的：切集要的是「马上出画」，后续分片由播放器按需拉；顺带预取
/// 整段会变成一次未经确认的大额流量，而这只是预加载。失败一律返回 `Ok(false)`，
/// 调用方不得因预热失败影响当前播放。
///
/// 开关在后端也查一次：预加载是会产生流量的行为，设置是它的唯一授权来源，
/// 不能只靠调用方自觉。
#[tauri::command]
pub async fn video_preload_next(
    state: State<'_, AppState>,
    request: VideoPlayRequest,
) -> AppResult<bool> {
    {
        let conn = state.conn()?;
        if !crate::settings::get(&conn)?.video_next_episode_preload {
            return Ok(false);
        }
    }
    let site = match resolve_bilibili(&state) {
        Ok(site) => site,
        Err(_) => return Ok(false),
    };
    let selection = match site.video_play_selection(&request).await {
        Ok(selection) => selection,
        Err(_) => return Ok(false),
    };

    let cache_prefix = format!(
        "{}:{}:{}",
        request
            .bvid
            .as_deref()
            .or(request.ep_id.as_deref())
            .unwrap_or_default(),
        request.cid,
        selection.quality,
    );
    let store = state.media_cache.clone();
    let headers = video_stream_headers();
    let route = {
        let conn = state.conn()?;
        crate::settings::get(&conn)?.proxy_route()
    };
    let client = match crate::http_client::client_for_route(&route) {
        Ok(client) => client,
        Err(_) => return Ok(false),
    };

    // 两条轨并发：它们是完全独立的 CDN 请求。
    let video_prefix = format!("{cache_prefix}:v");
    let audio_prefix = format!("{cache_prefix}:a");
    let video = preload_track(
        &client,
        &store,
        &headers,
        &video_prefix,
        "video/mp4",
        &selection.video,
    );
    // 无声稿件没有音轨，视为音轨预热成功。
    let audio = async {
        match selection.audio.as_ref() {
            Some(audio) => {
                preload_track(&client, &store, &headers, &audio_prefix, "audio/mp4", audio).await
            }
            None => true,
        }
    };
    let (video, audio) = tokio::join!(video, audio);
    Ok(video && audio)
}

/// 把一条轨的 init 段与首个媒体分片写进分片缓存。
///
/// 键由 [`MediaCacheSpec`] 生成，与转发路径写入时用的是同一套区间规则，
/// 因此播放器后续请求必然命中；任意一段失败只返回 `false`，不把部分结果当成功。
async fn preload_track(
    client: &reqwest::Client,
    store: &crate::media_cache::SharedMediaCache,
    headers: &HashMap<String, String>,
    prefix: &str,
    content_type: &'static str,
    track: &VideoTrack,
) -> bool {
    let ranges = first_segment_ranges(track);
    let spec =
        crate::media_cache::MediaCacheSpec::new(prefix.to_string(), content_type, ranges.clone());
    for (start, end) in ranges {
        let Some(key) = spec.key_for_range(start, end) else {
            return false;
        };
        // 已命中就不用再打一次 CDN：同一分集被反复预热是常态。
        if store.get(&key).await.is_some() {
            continue;
        }
        let Some(bytes) = fetch_range_with(client, headers, &track.base_url, start, end)
            .await
            .ok()
        else {
            return false;
        };
        if bytes.len() as u64 != end.saturating_sub(start).saturating_add(1) {
            return false;
        }
        store.put(&key, &bytes).await;
    }
    true
}

/// 按 Range 拉一段字节。预热不走站点客户端：那里要保证 `buvid` 与重试语义，
/// 而这里只是尽力而为的预取，用与代理一致的头即可。
async fn fetch_range_with(
    client: &reqwest::Client,
    headers: &HashMap<String, String>,
    url: &str,
    start: u64,
    end: u64,
) -> AppResult<Vec<u8>> {
    let mut request = client
        .get(url)
        .header("range", format!("bytes={start}-{end}"));
    for (key, value) in headers {
        request = request.header(key, value);
    }
    let response = request.send().await.map_err(|error| {
        AppError::new("video_preload_failed", format!("预加载请求失败: {error}"))
    })?;
    if !response.status().is_success() {
        return Err(AppError::new(
            "video_preload_failed",
            format!("预加载返回 HTTP {}", response.status().as_u16()),
        ));
    }
    response
        .bytes()
        .await
        .map(|bytes| bytes.to_vec())
        .map_err(|error| {
            AppError::new(
                "video_preload_failed",
                format!("预加载响应读取失败: {error}"),
            )
        })
}

/// 取播放信息：解出分片表、拉起代理、合成 MPD。
///
/// 顺序不可调换：MPD 里要写入视频/音频轨的**本机代理地址**，所以必须先把两条
/// 媒体代理起起来拿到 URL，再合成清单，最后用文本代理把清单挂上 HTTP。
/// 仅音频模式不起视频轨与文本代理，也不合成 MPD（听视频，见下方分支）。
#[tauri::command]
pub async fn video_get_play_info(
    state: State<'_, AppState>,
    request: VideoPlayRequest,
) -> AppResult<VideoPlayInfo> {
    let site = resolve_bilibili(&state)?;
    let selection = site.video_play_selection(&request).await?;
    let audio_only = request.audio_only.unwrap_or(false);

    // 媒体 CDN 有一部分主机在缺少站点 Referer 时直接 403，且部分主机不带 CORS 头，
    // 因此两条轨一律经代理注入请求头。
    let headers = video_stream_headers();

    let route = {
        let conn = state.conn()?;
        crate::settings::get(&conn)?.proxy_route()
    };

    // 三条流必须各占一个 session_id：`StreamProxy::start` 按 session 覆盖同名代理，
    // 共用一个 id 会让它们互相顶掉。
    let base = match (&request.ep_id, &request.bvid) {
        (Some(ep_id), _) if !ep_id.is_empty() => format!("video-ep{ep_id}-{}", request.cid),
        (_, Some(bvid)) => format!("video-{bvid}-{}", request.cid),
        _ => format!("video-cid{}", request.cid),
    };
    let session_ids = video_session_ids(&base);
    let lease = PlaybackProxyLease::new(
        &state.stream_proxy,
        [
            session_ids.video.clone(),
            session_ids.audio.clone(),
            session_ids.mpd.clone(),
        ],
    );

    // 媒体分片的磁盘缓存规格。只有请求方显式开启时才给：playurl 产物带短时
    // 签名，重放进 MPD 会打到过期地址，因此缓存的是**分片字节**而不是地址。
    // 键按内容标识（稿件 + 分 P + 清晰度 + 轨）而不按 URL —— 同一稿件每次取流的
    // URL 都不同，按 URL 缓存必然零命中。
    let want_media_cache = request.media_cache.unwrap_or(false) && !audio_only;
    let media_cache_store = want_media_cache.then(|| state.media_cache.clone());
    let cache_prefix = format!(
        "{}:{}:{}",
        request
            .bvid
            .as_deref()
            .or(request.ep_id.as_deref())
            .unwrap_or_default(),
        request.cid,
        selection.quality,
    );
    let video_cache = media_cache_store.as_ref().map(|_| {
        std::sync::Arc::new(crate::media_cache::MediaCacheSpec::new(
            format!("{cache_prefix}:v"),
            "video/mp4",
            segment_ranges(&selection.video),
        ))
    });
    let audio_cache = media_cache_store
        .as_ref()
        .zip(selection.audio.as_ref())
        .map(|(_, audio)| {
            std::sync::Arc::new(crate::media_cache::MediaCacheSpec::new(
                format!("{cache_prefix}:a"),
                "audio/mp4",
                segment_ranges(audio),
            ))
        });

    // init 段预取落盘。它已随 sidx 一起取回（见 `video_track` 的合并 Range），
    // 在这里写进分片缓存，播放器的 `<Initialization range="0-N">` 请求就命中
    // 本机，省掉一次完整 CDN 往返（实测视频轨 97ms、音轨 70ms，且串在首个媒体
    // 分片之前）。两条轨都要写：播放器会为视频与音频各发一次初始化段请求。
    //
    // 写盘与播放器请求是并发的，但它只是一次约 1KB 的 tmp 写 + rename，而播放器
    // 要等 playurl 返回才会发起请求 —— 落空只会退回上游，不影响正确性。
    if let Some(store) = media_cache_store.clone() {
        for (spec, track) in [
            (video_cache.clone(), Some(&selection.video)),
            (audio_cache.clone(), selection.audio.as_ref()),
        ] {
            let (Some(spec), Some(track)) = (spec, track) else {
                continue;
            };
            let Some(key) = spec.key_for_range(0, track.init_end) else {
                continue;
            };
            let bytes = track.init_bytes.clone();
            let store = store.clone();
            tauri::async_runtime::spawn(async move { store.put(&key, &bytes).await });
        }
    }

    // 会话内保留已预取的 init：普通 VOD 即使关闭磁盘缓存，也无需再向 CDN 取一次。
    // 原生媒体元素的非精确 Range 仍由代理正常回源。
    let audio_initialization = selection
        .audio
        .as_ref()
        .map(|audio| PrefetchedInitialization {
            bytes: audio.init_bytes.as_slice().into(),
            content_type: "audio/mp4",
        });

    // 仅音频模式（听视频）不起视频轨代理，也不合成 MPD：音轨 fMP4 是完整
    // 文件，代理转发 Range，前端把 audio_url 直接交给媒体元素播放。
    //
    // video 与 audio 两条代理互不依赖（各绑一个回环端口 + 各建一个 TLS 客户端），
    // 并发启动省掉一次串行的本地开销；mpd 依赖两者返回的本机 URL，必须最后串行。
    //
    // 无声稿件没有音轨：仅音频模式直接报错，普通模式不起音轨代理，`audio_url` 为空串。
    let (video_url, audio_url) = if audio_only {
        let audio = selection.audio.as_ref().ok_or_else(|| {
            AppError::new("bilibili_video_error", "该视频没有声音，无法仅播声音")
                .with_site("bilibili")
        })?;
        let audio_url = state
            .stream_proxy
            .start(
                audio.base_url.clone(),
                headers.clone(),
                session_ids.audio.clone(),
                StreamProxyStartOptions {
                    route: &route,
                    media_cache: audio_cache.clone(),
                    media_cache_store: media_cache_store.clone(),
                    initialization: audio_initialization,
                    ..Default::default()
                },
            )
            .await?;
        (String::new(), audio_url)
    } else {
        let video_start = state.stream_proxy.start(
            selection.video.base_url.clone(),
            headers.clone(),
            session_ids.video.clone(),
            StreamProxyStartOptions {
                route: &route,
                media_cache: video_cache.clone(),
                media_cache_store: media_cache_store.clone(),
                initialization: Some(PrefetchedInitialization {
                    bytes: selection.video.init_bytes.as_slice().into(),
                    content_type: "video/mp4",
                }),
                ..Default::default()
            },
        );
        let audio_start = async {
            let Some(audio) = selection.audio.as_ref() else {
                return Ok(String::new());
            };
            state
                .stream_proxy
                .start(
                    audio.base_url.clone(),
                    headers.clone(),
                    session_ids.audio.clone(),
                    StreamProxyStartOptions {
                        route: &route,
                        media_cache: audio_cache.clone(),
                        media_cache_store: media_cache_store.clone(),
                        initialization: audio_initialization,
                        ..Default::default()
                    },
                )
                .await
        };
        let (video_url, audio_url) = tokio::join!(video_start, audio_start);
        (video_url?, audio_url?)
    };

    let mut mpd_url = String::new();
    if !audio_only {
        let mpd = crate::sites::bilibili::video::build_mpd(&selection, &video_url, &audio_url);
        mpd_url = state
            .stream_proxy
            .start_text(
                mpd,
                "application/dash+xml".to_string(),
                session_ids.mpd.clone(),
            )
            .await?;
    }

    lease.commit();
    Ok(VideoPlayInfo {
        mpd_url,
        video_url,
        audio_url,
        // 仅音频时视频轨代理不存在，时长只能取音轨 sidx（两者本就一致）。
        duration: match selection.audio.as_ref().filter(|_| audio_only) {
            Some(audio) => audio.sidx.duration_secs(),
            None => selection.video.sidx.duration_secs(),
        },
        quality: selection.quality,
        quality_label: selection.quality_label,
        codecs: selection.video.codecs.clone(),
        accept_quality: selection.accept_quality,
        session_ids,
        audio_only,
    })
}

/// 取 DLNA 投屏源：html5 playurl 的 MP4 直链 + 中继请求头。
///
/// 与直播页的 CastMenu 同一机制：电视访问本机中继，中继代注 UA/Referer。
#[tauri::command(async)]
pub async fn video_get_cast_url(
    state: State<'_, AppState>,
    request: VideoPlayRequest,
) -> AppResult<VideoCastSource> {
    let site = resolve_bilibili(&state)?;
    let url = site.video_cast_url(&request).await?;
    Ok(VideoCastSource {
        url,
        headers: video_stream_headers(),
    })
}

/// 取播放器元数据：同一次 player v2 响应中的 CC 字幕与章节。
#[tauri::command(async)]
pub async fn video_get_player_meta(
    state: State<'_, AppState>,
    request: VideoPlayRequest,
) -> AppResult<VideoPlayerMeta> {
    resolve_bilibili(&state)?.video_player_meta(&request).await
}

/// 取视频缩略图（storyboard）快照元数据（videoshot）。
#[tauri::command(async)]
pub async fn video_get_storyboard(
    state: State<'_, AppState>,
    request: VideoPlayRequest,
) -> AppResult<Option<VideoStoryboard>> {
    resolve_bilibili(&state)?.video_storyboard(&request).await
}

/// 拉取字幕 JSON 原文（字幕主机无 CORS 头，由本端代拉）。
#[tauri::command(async)]
pub async fn video_get_subtitle(state: State<'_, AppState>, url: String) -> AppResult<String> {
    resolve_bilibili(&state)?.fetch_subtitle(&url).await
}

/// 取一段 VOD 弹幕。
///
/// `segment_index` 与 `position_millis` 给一个即可：后者会换算成 6 分钟段号。
/// `has_more == false` 表示段号已越界（上游用 HTTP 304 表达），可停止拉取。
#[tauri::command]
pub async fn video_get_danmaku(
    state: State<'_, AppState>,
    cid: i64,
    segment_index: Option<i64>,
    position_millis: Option<i64>,
) -> AppResult<VideoDanmakuSegment> {
    let index = segment_index
        .or_else(|| position_millis.map(crate::sites::bilibili::video::danmaku_segment_index))
        .ok_or_else(|| {
            AppError::new(
                "video_danmaku_missing_segment",
                "弹幕请求需要 segment_index 或 position_millis",
            )
        })?;
    resolve_bilibili(&state)?.video_danmaku(cid, index).await
}

/// 发送一条 VOD 弹幕（普通滚动、白色、25 号字）。
///
/// 与直播的 `bilibili_danmaku_send` 同一套凭据检查、冷却与历史记录约定；
/// 限流键用 aid（同一稿件下所有分 P 共用一个冷却），room_id 字段对
/// 历史记录存 aid，标题带当前播放的稿件标题。`progress_ms` 是当前播放
/// 位置（毫秒）—— 上游 `x/v2/dm/post` 的 progress 按毫秒计。
#[tauri::command]
pub async fn video_danmaku_send(
    state: State<'_, AppState>,
    cid: i64,
    aid: String,
    progress_ms: u64,
    message: String,
    video_title: Option<String>,
) -> AppResult<()> {
    let (settings, cookie) = crate::commands::danmaku::ensure_bilibili_send_ready(state.inner())?;
    let aid_key = aid.trim().to_string();
    if aid_key.is_empty() || aid_key.len() > 32 || !aid_key.bytes().all(|b| b.is_ascii_digit()) {
        return Err(
            AppError::new("video_danmaku_invalid_aid", "B站稿件 aid 无效").with_site("bilibili"),
        );
    }
    let message = crate::danmu_rs::bilibili::normalize_outgoing_message(&message)?;
    state.bilibili_send_limiter.reserve(&aid_key)?;
    // 该请求携带用户的浏览器 Cookie。重定向目标绝不能收到它，
    // 因此写入路径对代理请求和直连请求都刻意关闭了重定向跟随。
    let client = crate::http_client::build_no_redirect_client(&settings.proxy_route())?;
    crate::danmu_rs::bilibili::send_video_danmaku(
        &client,
        &cookie,
        &aid_key,
        cid,
        progress_ms,
        &message,
    )
    .await?;
    crate::commands::danmaku::record_send_history_public(
        state.inner(),
        SiteId::Bilibili,
        &message,
        &aid_key,
        video_title.as_deref(),
        None,
    );
    Ok(())
}

/// 停掉一次播放占用的三个代理。
///
/// 离开播放页必须调用，否则三条本机监听器与其上游连接都会泄漏。
#[tauri::command]
pub fn video_stop_play(state: State<'_, AppState>, session_ids: VideoSessionIds) -> AppResult<()> {
    for session_id in [&session_ids.video, &session_ids.audio, &session_ids.mpd] {
        if !session_id.trim().is_empty() {
            state.stream_proxy.stop_for_session(session_id);
        }
    }
    Ok(())
}

/// 相关视频（UGC）。匿名可用，一次返回全部。
#[tauri::command]
pub async fn video_get_related(
    state: State<'_, AppState>,
    bvid: String,
) -> AppResult<VideoListPage> {
    resolve_bilibili(&state)?.video_related(&bvid).await
}

/// 搜索视频。关键词搜索，支持分页与可选筛选：
/// `order` 排序（click/pubdate/dm/stow/scores）、`duration` 时长档（0-4）、
/// `tids` 搜索分区（`video_search_zone_list` 的 tid）、`pub_time` 发布时间预设
/// （day/week/halfYear）。非法值一律回落默认，不报错。
#[tauri::command]
pub async fn video_search(
    state: State<'_, AppState>,
    keyword: String,
    page: u32,
    order: Option<String>,
    duration: Option<i64>,
    tids: Option<i64>,
    pub_time: Option<String>,
) -> AppResult<VideoListPage> {
    resolve_bilibili(&state)?
        .video_search(
            &keyword,
            page,
            order.as_deref(),
            duration,
            tids,
            pub_time.as_deref(),
        )
        .await
}

/// 搜索筛选的分区表（tids）。与 [`crate::sites::bilibili::VIDEO_ZONES`] 的分区榜
/// rid 是两套 ID，搜索接口只认 tid，因此单独成表而非复用 `video_zone_list`。
#[tauri::command]
pub fn video_search_zone_list() -> Vec<(String, i64)> {
    crate::sites::bilibili::VIDEO_SEARCH_ZONES
        .iter()
        .map(|(name, tid)| ((*name).to_string(), *tid))
        .collect()
}

/// UP 主空间视频列表。获取指定 UP 主的投稿视频，支持分页。
#[tauri::command]
pub async fn video_uploader_videos(
    state: State<'_, AppState>,
    mid: String,
    page: u32,
    order: Option<String>,
) -> AppResult<VideoListPage> {
    resolve_bilibili(&state)?
        .video_uploader_videos(&mid, page, order.as_deref())
        .await
}

/// 稿件详情。WBI 签名接口，播放页右侧栏用它拿简介/统计与评论区的 aid。
#[tauri::command]
pub async fn video_get_archive(
    state: State<'_, AppState>,
    bvid: String,
) -> AppResult<VideoArchive> {
    resolve_bilibili(&state)?.video_archive(&bvid).await
}

/// 当前分 P 的全端在线人数；隐藏或未提供时返回 None，不并入稿件详情。
#[tauri::command]
pub async fn video_get_online_total(
    state: State<'_, AppState>,
    bvid: String,
    cid: i64,
) -> AppResult<Option<String>> {
    resolve_bilibili(&state)?
        .video_online_total(&bvid, cid)
        .await
}

/// 评论首页（游标翻页）。`mode`：2 按时间、3 按热度；`next` 首次传 0。
#[tauri::command]
pub async fn video_get_comments(
    state: State<'_, AppState>,
    aid: String,
    mode: Option<u8>,
    next: Option<i64>,
) -> AppResult<VideoCommentPage> {
    resolve_bilibili(&state)?
        .video_comments(&aid, mode.unwrap_or(3), next.unwrap_or(0))
        .await
}

/// 二级回复（pn 翻页，首传 page = 1）。
///
/// `page_size` 缺省为 [`COMMENT_REPLIES_PAGE_SIZE`]（移动端无限滚动的页大小）；
/// 桌面端的回复分页传 10，请求与 `has_more` 推导共用它。
#[tauri::command]
pub async fn video_get_comment_replies(
    state: State<'_, AppState>,
    aid: String,
    root: i64,
    page: Option<u32>,
    page_size: Option<u32>,
) -> AppResult<VideoCommentPage> {
    resolve_bilibili(&state)?
        .video_comment_replies(&aid, root, page.unwrap_or(1), page_size)
        .await
}

#[cfg(test)]
mod tests {
    use super::{PlaybackProxyLease, first_segment_ranges, segment_ranges, video_session_ids};
    use crate::stream_proxy::StreamProxy;

    #[tokio::test]
    async fn playback_instances_are_isolated_and_partial_start_rolls_back() {
        let proxy = StreamProxy::new();
        let old = video_session_ids("same-content");
        let new = video_session_ids("same-content");
        assert_ne!(old.mpd, new.mpd);
        proxy
            .start_text("old".into(), "text/plain".into(), old.mpd.clone())
            .await
            .unwrap();
        {
            let _lease = PlaybackProxyLease::new(
                &proxy,
                [new.video.clone(), new.audio.clone(), new.mpd.clone()],
            );
            proxy
                .start_text("new".into(), "text/plain".into(), new.video.clone())
                .await
                .unwrap();
            assert!(proxy.telemetry_for_session(&new.video).is_some());
            assert!(
                proxy
                    .start(
                        "https://example.com/media".into(),
                        std::collections::HashMap::new(),
                        new.audio.clone(),
                        crate::stream_proxy::StreamProxyStartOptions {
                            route: &crate::proxy::ProxyRoute::Custom("http://[".into()),
                            ..Default::default()
                        },
                    )
                    .await
                    .is_err()
            );
            // 第二条轨道客户端创建失败：离开作用域回滚已创建的第一条。
        }
        assert!(proxy.telemetry_for_session(&new.video).is_none());
        assert!(proxy.telemetry_for_session(&old.mpd).is_some());
        let lease = PlaybackProxyLease::new(&proxy, [new.mpd.clone()]);
        proxy
            .start_text("new".into(), "text/plain".into(), new.mpd.clone())
            .await
            .unwrap();
        lease.commit();
        proxy.stop_for_session(&old.mpd);
        assert!(proxy.telemetry_for_session(&new.mpd).is_some());
        proxy.stop_for_session(&new.mpd);
    }
    #[tokio::test]
    async fn cancelled_playback_creation_rolls_back() {
        let proxy = std::sync::Arc::new(StreamProxy::new());
        let id = video_session_ids("cancelled").mpd;
        let (ready, started) = tokio::sync::oneshot::channel();
        let task = {
            let proxy = proxy.clone();
            let id = id.clone();
            tokio::spawn(async move {
                let _lease = PlaybackProxyLease::new(&proxy, [id.clone()]);
                proxy
                    .start_text("pending".into(), "text/plain".into(), id)
                    .await
                    .unwrap();
                ready.send(()).unwrap();
                std::future::pending::<()>().await;
            })
        };
        started.await.unwrap();
        assert!(proxy.telemetry_for_session(&id).is_some());
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert!(proxy.telemetry_for_session(&id).is_none());
    }

    use crate::sites::bilibili::video::{Sidx, SidxSegment, VideoTrack};

    /// 造一条轨：init `0-99`，其后每片 100 字节、每片 `segment_seconds` 秒。
    fn track(segment_seconds: u64, count: usize) -> VideoTrack {
        let mut segments = Vec::new();
        let mut start = 100_u64;
        let mut time = 0_u64;
        for _ in 0..count {
            time += segment_seconds * 1_000;
            segments.push(SidxSegment {
                start_byte: start,
                end_byte: start + 99,
                t_end: time,
            });
            start += 100;
        }
        VideoTrack {
            base_url: "https://upos.example.com/media.m4s".into(),
            init_end: 99,
            init_bytes: vec![0_u8; 100],
            sidx: Sidx {
                timescale: 1_000,
                segments,
            },
            codecs: "avc1.640033".into(),
            bandwidth: 1,
            rep_id: "32".into(),
            width: Some(854),
            height: Some(480),
            frame_rate: Some("30.000".into()),
            sar: None,
            start_with_sap: 1,
        }
    }

    #[test]
    fn init_segment_is_always_cacheable() {
        // init 段是播放器的第一个请求，也是取流阶段预写进缓存的键。
        let ranges = segment_ranges(&track(4, 30));
        assert_eq!(ranges.first(), Some(&(0, 99)));
    }

    #[test]
    fn only_the_startup_prefix_is_cacheable() {
        // 4 秒一片、前缀窗口 10s：首片（起点 0s）、第二片（4s）、第三片（8s）
        // 在内，第四片（12s）已越出窗口。
        let ranges = segment_ranges(&track(4, 30));
        assert_eq!(
            ranges,
            vec![(0, 99), (100, 199), (200, 299), (300, 399)],
            "init + 起点落在 10s 内的三片"
        );
    }

    #[test]
    fn long_segments_keep_at_least_the_first_one() {
        // 首片本身就跨过窗口（实测有 20s 的长片）：仍必须保留，否则起播无缓存。
        let ranges = segment_ranges(&track(20, 5));
        assert_eq!(ranges, vec![(0, 99), (100, 199)]);
    }

    #[test]
    fn empty_segment_table_keeps_only_init() {
        let ranges = segment_ranges(&track(4, 0));
        assert_eq!(ranges, vec![(0, 99)]);
    }

    #[test]
    fn preload_keeps_only_init_and_the_first_segment() {
        // 预加载不把 10s 窗口整个写盘：只取 init + 首片，其余留给正常播放。
        let ranges = first_segment_ranges(&track(4, 30));
        assert_eq!(ranges, vec![(0, 99), (100, 199)]);
    }

    #[test]
    fn preload_without_segments_still_writes_init() {
        // 分片表为空时不能把预加载变成空操作：init 段仍是起播的第一个请求。
        assert_eq!(first_segment_ranges(&track(4, 0)), vec![(0, 99)]);
    }
}
