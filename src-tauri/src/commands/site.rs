use serde::Serialize;
use tauri::State;

use crate::account;
use crate::error::AppResult;
use crate::models::live::{
    LiveCategory, LivePlayQuality, LiveRoomDetail, LiveSubCategory, PlayUrl, RoomListPage, SiteId,
};
use crate::sites;
use crate::sites::bilibili::BilibiliSite;
use crate::state::AppState;

#[derive(Debug, Clone, Serialize)]
pub struct SiteInfo {
    pub id: SiteId,
    pub name: String,
}

fn resolve_site(state: &AppState, site_id: &SiteId) -> AppResult<Box<dyn sites::traits::LiveSite>> {
    // 一个站点实例可能发起多个相互依赖的请求（Twitch bootstrap、GraphQL、
    // 房间数据，然后是它的 HLS master playlist）。把 cookie 和代理一起快照，
    // 使这条链上的每个请求都遵循同一份设置。
    let (cookie, proxy) = {
        let conn = state.conn()?;
        (
            account::get_cookie(&conn, site_id)?,
            crate::settings::get(&conn)?.proxy,
        )
    };
    sites::site_with_proxy(site_id, cookie, proxy.as_deref())
}

/// 首页推荐专用的站点实例：只有 B 站的推荐会带上本机的 TV 凭据。
///
/// 为什么不能直接放进 [`resolve_site`]：把 TV 凭据发给 **web-room 系**房间接口
/// 会得到 `-663 鉴权失败`（实测 `web-room/v1/index/getInfoByRoom`、
/// `web-room/v2/index/getRoomPlayInfo`，裸 `access_key` 与 appkey+sign 同样被拒）。
/// 凭据因此必须严格限定在推荐这一条路径上。其余站点与其余命令保持原样。
///
/// 注意 `-663` 的触发条件是「带着**有效** TV 凭据访问 web-room」，而不是「没有
/// Web Cookie」：同一批端点不带任何凭据（WBI 签名即可）与匿名访问均正常。房间
/// 详情另有一条 `app-room/v1/index/getInfoByRoom` 接受 TV 凭据（实测 `code=0`），
/// 但它比 web-room 版本少 `is_studio`/`live_id` 等字段、且必须带
/// `platform`+`device`+`build` 三件套才不是 `-400`，收益为零，故不采用。
///
/// 凭据不可用时**只记日志、继续走 Cookie／匿名**：直播首页是默认浏览表面，
/// 它不应该因为一条无关的 VOD 凭据过期而整个不可用。这一点与 VOD 侧刻意不同
/// （那里用户显式选择了 App 推荐接口，失败必须报错而不是偷偷换流）：失效本身
/// 会在启动期检查与设置页提示，不依赖首页报错来暴露。
async fn resolve_recommend_site(
    state: &AppState,
    site_id: &SiteId,
) -> AppResult<Box<dyn sites::traits::LiveSite>> {
    if *site_id != SiteId::Bilibili {
        return resolve_site(state, site_id);
    }
    let (cookie, proxy, credential) = {
        let conn = state.conn()?;
        (
            account::get_cookie(&conn, site_id)?,
            crate::settings::get(&conn)?.proxy,
            account::bilibili_app::load(&conn)?,
        )
    };
    let client = crate::http_client::client_for_proxy(proxy.as_deref())?;
    let site = BilibiliSite::new(client, cookie.unwrap_or_default());
    let Some(credential) = credential else {
        return Ok(Box::new(site));
    };
    let mut auth = match account::bilibili_app::AppAuth::new(credential, proxy.as_deref()).await {
        Ok(auth) => auth,
        Err(error) => {
            tracing::warn!(error = %error, "bilibili app credential unusable for live recommend; continuing without it");
            return Ok(Box::new(site));
        }
    };
    // 续期轮换了 `refresh_token`，新凭据必须落库，否则下一次请求仍拿旧值重试。
    if let Some(renewed) = auth.take_renewed() {
        let conn = state.conn()?;
        account::bilibili_app::save(&conn, &renewed)?;
    }
    Ok(Box::new(site.with_live_auth(auth)))
}

#[tauri::command]
pub fn site_list() -> Vec<SiteInfo> {
    sites::all_meta()
        .into_iter()
        .map(|s| SiteInfo {
            id: s.id.clone(),
            name: s.name.to_string(),
        })
        .collect()
}

#[tauri::command]
pub async fn site_get_categories(
    state: State<'_, AppState>,
    site_id: SiteId,
) -> AppResult<Vec<LiveCategory>> {
    let site = resolve_site(&state, &site_id)?;
    site.get_categories().await
}

#[tauri::command]
pub async fn site_get_recommend(
    state: State<'_, AppState>,
    site_id: SiteId,
    page: u32,
) -> AppResult<RoomListPage> {
    let site = resolve_recommend_site(&state, &site_id).await?;
    site.get_recommend_rooms(page).await
}

#[tauri::command]
pub async fn site_get_category_rooms(
    state: State<'_, AppState>,
    site_id: SiteId,
    category: LiveSubCategory,
    page: u32,
) -> AppResult<RoomListPage> {
    let site = resolve_site(&state, &site_id)?;
    site.get_category_rooms(&category, page).await
}

#[tauri::command]
pub async fn site_search_rooms(
    state: State<'_, AppState>,
    site_id: SiteId,
    keyword: String,
    page: u32,
) -> AppResult<RoomListPage> {
    let site = resolve_site(&state, &site_id)?;
    site.search_rooms(&keyword, page).await
}

#[tauri::command]
pub async fn site_get_room_detail(
    state: State<'_, AppState>,
    site_id: SiteId,
    room_id: String,
) -> AppResult<LiveRoomDetail> {
    let site = resolve_site(&state, &site_id)?;
    site.get_room_detail(&room_id).await
}

#[tauri::command]
pub async fn site_get_play_qualities(
    state: State<'_, AppState>,
    site_id: SiteId,
    detail: LiveRoomDetail,
) -> AppResult<Vec<LivePlayQuality>> {
    let site = resolve_site(&state, &site_id)?;
    site.get_play_qualities(&detail).await
}

#[tauri::command]
pub async fn site_get_play_urls(
    state: State<'_, AppState>,
    site_id: SiteId,
    detail: LiveRoomDetail,
    quality: LivePlayQuality,
) -> AppResult<Vec<PlayUrl>> {
    let site = resolve_site(&state, &site_id)?;
    site.get_play_urls(&detail, &quality).await
}
