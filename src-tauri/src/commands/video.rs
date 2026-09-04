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
    VideoListPage, VideoPlayInfo, VideoPlayRequest, VideoSeason, VideoSessionIds, VideoSubtitle,
};
use crate::sites::bilibili::BilibiliSite;
use crate::state::AppState;

/// 构造一个带已保存 cookie 与代理设置的 Bilibili 客户端。
///
/// 与 `site.rs::resolve_site` 取的是同一份快照，因此登录态天然复用；
/// 但那个函数返回 `Box<dyn LiveSite>`，拿不到 VOD 的 inherent 方法，
/// 所以这里返回具体类型。
fn resolve_bilibili(state: &AppState) -> AppResult<BilibiliSite> {
    let (cookie, proxy) = {
        let conn = state.conn()?;
        (
            account::get_cookie(&conn, &SiteId::Bilibili)?,
            crate::settings::get(&conn)?.proxy,
        )
    };
    let client = crate::http_client::client_for_proxy(proxy.as_deref())?;
    Ok(BilibiliSite::new(client, cookie.unwrap_or_default()))
}

#[tauri::command]
pub async fn video_get_recommend(
    state: State<'_, AppState>,
    page: u32,
    page_size: Option<u32>,
) -> AppResult<VideoListPage> {
    resolve_bilibili(&state)?
        .video_recommend(page, page_size.unwrap_or(20))
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

/// PGC 排行榜（番剧 1、电影 2、纪录片 3、国创 4、剧集 5、综艺 7）。
#[tauri::command]
pub async fn video_get_pgc_zone(
    state: State<'_, AppState>,
    season_type: i64,
) -> AppResult<PgcListPage> {
    resolve_bilibili(&state)?.video_pgc_zone(season_type).await
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

/// 取播放信息：解出分片表、拉起三个代理、合成 MPD。
///
/// 顺序不可调换：MPD 里要写入视频/音频轨的**本机代理地址**，所以必须先把两条
/// 媒体代理起起来拿到 URL，再合成清单，最后用文本代理把清单挂上 HTTP。
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

    let proxy = {
        let conn = state.conn()?;
        crate::settings::get(&conn)?.proxy
    };

    // 三条流必须各占一个 session_id：`StreamProxy::start` 按 session 覆盖同名代理，
    // 共用一个 id 会让它们互相顶掉。
    let base = match (&request.ep_id, &request.bvid) {
        (Some(ep_id), _) if !ep_id.is_empty() => format!("video-ep{ep_id}-{}", request.cid),
        (_, Some(bvid)) => format!("video-{bvid}-{}", request.cid),
        _ => format!("video-cid{}", request.cid),
    };
    let session_ids = VideoSessionIds {
        video: format!("{base}-video"),
        audio: format!("{base}-audio"),
        mpd: format!("{base}-mpd"),
    };

    // 仅音频模式跳过视频轨代理（听视频省流），清单只含音轨。
    let video_url = if audio_only {
        String::new()
    } else {
        state
            .stream_proxy
            .start_ordered(
                selection.video.base_url.clone(),
                headers.clone(),
                session_ids.video.clone(),
                proxy.as_deref(),
            )
            .await?
    };
    let audio_url = state
        .stream_proxy
        .start_ordered(
            selection.audio.base_url.clone(),
            headers.clone(),
            session_ids.audio.clone(),
            proxy.as_deref(),
        )
        .await?;

    // 仅音频模式（听视频）：音轨 fMP4 本身是完整文件，代理转发 Range，
    // 直接当普通媒体地址播（xgplayer-dash 写死假设视频轨存在，纯音 MPD 会在
    // definitions[0].selected 上崩）。不合成 MPD、不起文本代理。
    let mut mpd = String::new();
    let mut mpd_url = String::new();
    if !audio_only {
        mpd = crate::sites::bilibili::video::build_mpd(&selection, &video_url, &audio_url);
        mpd_url = state
            .stream_proxy
            .start_text(
                mpd.clone(),
                "application/dash+xml".to_string(),
                session_ids.mpd.clone(),
            )
            .await?;
    }

    Ok(VideoPlayInfo {
        mpd,
        mpd_url,
        video_url,
        audio_url,
        headers,
        // 仅音频时视频轨代理不存在，时长只能取音轨 sidx（两者本就一致）。
        duration: if audio_only {
            selection.audio.sidx.duration_secs()
        } else {
            selection.video.sidx.duration_secs()
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

/// 取 CC 字幕轨道列表（player v2）。
#[tauri::command(async)]
pub async fn video_get_subtitles(
    state: State<'_, AppState>,
    request: VideoPlayRequest,
) -> AppResult<Vec<VideoSubtitle>> {
    resolve_bilibili(&state)?.video_subtitles(&request).await
}

/// 拉取字幕 JSON 原文（字幕主机无 CORS 头，由本端代拉）。
#[tauri::command(async)]
pub async fn video_get_subtitle(
    state: State<'_, AppState>,
    url: String,
) -> AppResult<String> {
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
    let index = match (segment_index, position_millis) {
        (Some(index), _) => index,
        (None, Some(position)) => crate::sites::bilibili::video::danmaku_segment_index(position),
        (None, None) => {
            return Err(AppError::new(
                "video_danmaku_missing_segment",
                "弹幕请求需要 segment_index 或 position_millis",
            ));
        }
    };
    resolve_bilibili(&state)?.video_danmaku(cid, index).await
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

/// 搜索视频。关键词搜索，支持分页。
#[tauri::command]
pub async fn video_search(
    state: State<'_, AppState>,
    keyword: String,
    page: u32,
) -> AppResult<VideoListPage> {
    resolve_bilibili(&state)?.video_search(&keyword, page).await
}

/// UP 主空间视频列表。获取指定 UP 主的投稿视频，支持分页。
#[tauri::command]
pub async fn video_uploader_videos(
    state: State<'_, AppState>,
    mid: String,
    page: u32,
) -> AppResult<VideoListPage> {
    resolve_bilibili(&state)?.video_uploader_videos(&mid, page).await
}

/// 稿件详情。WBI 签名接口，播放页右侧栏用它拿简介/统计与评论区的 aid。
#[tauri::command]
pub async fn video_get_archive(
    state: State<'_, AppState>,
    bvid: String,
) -> AppResult<VideoArchive> {
    resolve_bilibili(&state)?.video_archive(&bvid).await
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
#[tauri::command]
pub async fn video_get_comment_replies(
    state: State<'_, AppState>,
    aid: String,
    root: i64,
    page: Option<u32>,
) -> AppResult<VideoCommentPage> {
    resolve_bilibili(&state)?
        .video_comment_replies(&aid, root, page.unwrap_or(1))
        .await
}
