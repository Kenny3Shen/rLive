//! AcFun 视频与文章 Tauri 命令。

use std::collections::HashMap;

use tauri::State;

use crate::error::AppResult;
use crate::models::acfun::{
    AcfunArticleChannel, AcfunArticleDetail, AcfunArticleListPage, AcfunCommentPage,
    AcfunCommentReplyPage, AcfunCommentSort, AcfunVideoDetail, AcfunVideoListPage,
    AcfunVideoPlayInfo, AcfunVideoSection,
};
use crate::sites::acfun::content::{
    AcfunContentClient, CONTENT_REFERER, CONTENT_USER_AGENT, video_sections_static,
};
use crate::state::AppState;
use crate::stream_proxy::StreamProxyStartOptions;

fn content_client(state: &AppState) -> AppResult<(AcfunContentClient, crate::proxy::ProxyRoute)> {
    let route = {
        let conn = state.conn()?;
        crate::settings::get(&conn)?.proxy_route()
    };
    let client = crate::http_client::client_for_route(&route)?;
    Ok((AcfunContentClient::new(client), route))
}

#[tauri::command]
pub fn acfun_video_get_sections() -> Vec<AcfunVideoSection> {
    video_sections_static()
}

#[tauri::command]
pub async fn acfun_video_get_recommend(
    state: State<'_, AppState>,
    page: u32,
    page_size: Option<u32>,
) -> AppResult<AcfunVideoListPage> {
    content_client(&state)?
        .0
        .video_recommend(page, page_size)
        .await
}

#[tauri::command]
pub async fn acfun_video_get_section(
    state: State<'_, AppState>,
    section_id: String,
    page: u32,
) -> AppResult<AcfunVideoListPage> {
    content_client(&state)?
        .0
        .video_section(&section_id, page)
        .await
}

#[tauri::command]
pub async fn acfun_video_search(
    state: State<'_, AppState>,
    keyword: String,
    page: u32,
) -> AppResult<AcfunVideoListPage> {
    content_client(&state)?.0.video_search(&keyword, page).await
}

#[tauri::command]
pub async fn acfun_video_get_detail(
    state: State<'_, AppState>,
    id: String,
) -> AppResult<AcfunVideoDetail> {
    content_client(&state)?.0.video_detail(&id).await
}

#[tauri::command]
pub async fn acfun_video_get_play_info(
    state: State<'_, AppState>,
    video_id: String,
    part_id: Option<String>,
    quality: Option<String>,
) -> AppResult<AcfunVideoPlayInfo> {
    let (content, route) = content_client(&state)?;
    let source = content
        .video_play_source(&video_id, part_id.as_deref(), quality.as_deref())
        .await?;
    let session_id = format!(
        "acfun-vod-{}-{}",
        video_id
            .trim()
            .trim_start_matches("ac")
            .chars()
            .filter(char::is_ascii_digit)
            .collect::<String>(),
        uuid::Uuid::new_v4().simple()
    );
    let headers = HashMap::from([
        ("Referer".to_string(), CONTENT_REFERER.to_string()),
        ("User-Agent".to_string(), CONTENT_USER_AGENT.to_string()),
    ]);
    let url = state
        .stream_proxy
        .start(
            source.url,
            headers.clone(),
            session_id.clone(),
            StreamProxyStartOptions {
                force_hls: true,
                route: &route,
                ..Default::default()
            },
        )
        .await?;
    Ok(AcfunVideoPlayInfo {
        url,
        quality: source.quality,
        quality_label: source.quality_label,
        protocol: "hls".to_string(),
        accept_qualities: source.qualities,
        headers,
        session_id,
    })
}

#[tauri::command]
pub async fn acfun_video_get_comments(
    state: State<'_, AppState>,
    video_id: String,
    page: u32,
    sort: Option<AcfunCommentSort>,
) -> AppResult<AcfunCommentPage> {
    content_client(&state)?
        .0
        .video_comments(&video_id, page, sort.unwrap_or_default())
        .await
}

#[tauri::command]
pub async fn acfun_video_get_comment_replies(
    state: State<'_, AppState>,
    video_id: String,
    comment_id: String,
    cursor: Option<String>,
) -> AppResult<AcfunCommentReplyPage> {
    content_client(&state)?
        .0
        .video_comment_replies(&video_id, &comment_id, cursor.as_deref())
        .await
}

#[tauri::command]
pub fn acfun_video_stop_play(state: State<'_, AppState>, session_id: String) -> AppResult<()> {
    if !session_id.trim().is_empty() {
        state.stream_proxy.stop_for_session(&session_id);
    }
    Ok(())
}

#[tauri::command]
pub async fn acfun_article_get_channels(
    state: State<'_, AppState>,
) -> AppResult<Vec<AcfunArticleChannel>> {
    content_client(&state)?.0.article_channels().await
}

#[tauri::command]
pub async fn acfun_article_get_feed(
    state: State<'_, AppState>,
    channel_id: Option<String>,
    cursor: Option<String>,
) -> AppResult<AcfunArticleListPage> {
    content_client(&state)?
        .0
        .article_feed(channel_id.as_deref(), cursor.as_deref())
        .await
}

#[tauri::command]
pub async fn acfun_article_search(
    state: State<'_, AppState>,
    keyword: String,
    page: u32,
) -> AppResult<AcfunArticleListPage> {
    content_client(&state)?
        .0
        .article_search(&keyword, page)
        .await
}

#[tauri::command]
pub async fn acfun_article_get_detail(
    state: State<'_, AppState>,
    id: String,
) -> AppResult<AcfunArticleDetail> {
    content_client(&state)?.0.article_detail(&id).await
}
