//! 实验性抖音单作品播放，不写入 B 站观看历史。
use super::video::PlaybackProxyLease;
use crate::error::{AppError, AppResult};
use crate::models::{douyin_video::DouyinVideoPlayback, live::SiteId};
use crate::sites::douyin::{
    DEFAULT_USER_AGENT, DouyinSite,
    video::{VIDEO_REFERER, resolve_video_id},
};
use crate::state::AppState;
use crate::stream_proxy::StreamProxyStartOptions;
use std::collections::HashMap;
use tauri::State;

#[tauri::command]
pub async fn douyin_video_resolve(
    state: State<'_, AppState>,
    input: String,
) -> AppResult<DouyinVideoPlayback> {
    let (cookie, proxy) = {
        let conn = state.conn()?;
        (
            crate::account::get_cookie(&conn, &SiteId::Douyin)?.unwrap_or_default(),
            crate::settings::get(&conn)?.proxy,
        )
    };
    let short_client = crate::http_client::build_no_redirect_client(proxy.as_deref())?;
    let id = resolve_video_id(&input, &short_client).await?;
    let site = DouyinSite::new(
        crate::http_client::client_for_proxy(proxy.as_deref())?,
        cookie,
    );
    let (item, url) = site.video_detail(&id).await?;
    let session_id = format!("douyin-video-{}", uuid::Uuid::new_v4().simple());
    let lease = PlaybackProxyLease::new(&state.stream_proxy, [session_id.clone()]);
    let play_url = state
        .stream_proxy
        .start(
            url,
            HashMap::from([
                ("user-agent".into(), DEFAULT_USER_AGENT.into()),
                ("referer".into(), VIDEO_REFERER.into()),
            ]),
            session_id.clone(),
            StreamProxyStartOptions {
                proxy: proxy.as_deref(),
                ..Default::default()
            },
        )
        .await?;
    lease.commit();
    Ok(DouyinVideoPlayback {
        item,
        play_url,
        session_id,
    })
}

#[tauri::command]
pub fn douyin_video_stop(state: State<'_, AppState>, session_id: String) -> AppResult<()> {
    if !valid_session_id(&session_id) {
        return Err(AppError::new(
            "douyin_video_session",
            "抖音播放会话标识无效",
        ));
    }
    state.stream_proxy.stop_for_session(&session_id);
    Ok(())
}

fn valid_session_id(id: &str) -> bool {
    id.strip_prefix("douyin-video-")
        .is_some_and(|suffix| suffix.len() == 32 && suffix.bytes().all(|b| b.is_ascii_hexdigit()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stop_only_accepts_own_session_namespace() {
        assert!(valid_session_id(&format!(
            "douyin-video-{}",
            uuid::Uuid::new_v4().simple()
        )));
        for id in ["", "video-other", "douyin-video-", "douyin-video-../other"] {
            assert!(!valid_session_id(id));
        }
    }
}
