//! 抖音短视频推荐，不写入 B 站观看历史。
use super::video::PlaybackProxyLease;
use crate::error::{AppError, AppResult};
use crate::models::{
    douyin_video::{DouyinVideoFeedPage, DouyinVideoPlayback},
    live::SiteId,
};
use crate::sites::douyin::{
    DEFAULT_USER_AGENT, DouyinSite,
    video::{VIDEO_REFERER, require_feed_cookie},
};
use crate::state::AppState;
use crate::stream_proxy::StreamProxyStartOptions;
use std::collections::HashMap;
use tauri::State;

/// 抖音推荐流。只看本机保存的登录 Cookie，不接受调用方指定的账号或代理。
#[tauri::command]
pub async fn douyin_video_feed(state: State<'_, AppState>) -> AppResult<DouyinVideoFeedPage> {
    let (cookie, proxy) = {
        let conn = state.conn()?;
        (
            crate::account::get_cookie(&conn, &SiteId::Douyin)?.unwrap_or_default(),
            crate::settings::get(&conn)?.proxy,
        )
    };
    require_feed_cookie(&cookie)?;
    let site = DouyinSite::new(
        crate::http_client::client_for_proxy(proxy.as_deref())?,
        cookie.clone(),
    );
    let page = site.video_feed().await?;
    // 账号在请求途中被清除/替换时，旧账号结果不得进入新一轮推荐。
    check_feed_account(&state, &cookie)?;
    Ok(page)
}

fn check_feed_account(state: &AppState, expected: &str) -> AppResult<()> {
    let conn = state.conn()?;
    let current = crate::account::get_cookie(&conn, &SiteId::Douyin)?.unwrap_or_default();
    require_same_account(&current, expected)
}

fn require_same_account(current: &str, expected: &str) -> AppResult<()> {
    if current != expected {
        return Err(AppError::new(
            "douyin_account_changed",
            "抖音账号已变化，请刷新推荐或重新进入抖音推荐页",
        )
        .with_site("douyin"));
    }
    Ok(())
}

/// 推荐流单条作品的取流入口：只接受推荐条目自带的字符串作品 ID。
///
/// 登录 Cookie 是推荐流的硬前提，因此这里没有匿名分支 —— 作品链接输入移除后，
/// 不再存在“不强制登录”的调用方。
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
    require_feed_cookie(&cookie)?;
    let expected_cookie = cookie.clone();
    let site = DouyinSite::new(
        crate::http_client::client_for_proxy(proxy.as_deref())?,
        cookie,
    );
    let (item, url) = site.video_detail(&input).await?;
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
    // 取流途中账号变化时，不把旧登录态创建的代理交给前端；lease 自动回滚。
    check_feed_account(&state, &expected_cookie)?;
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
    fn rejects_cleared_or_replaced_account_without_echoing_credentials() {
        assert!(require_same_account("sessionid=first", "sessionid=first").is_ok());
        for current in ["", "sessionid=second"] {
            let error = require_same_account(current, "sessionid=first").unwrap_err();
            assert_eq!(error.code, "douyin_account_changed");
            assert!(error.message.contains("刷新推荐"));
            assert!(!error.message.contains("sessionid"));
        }
    }

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
