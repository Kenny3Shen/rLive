//! 本机图片防盗链代理的 Tauri 命令。

use tauri::State;

use crate::error::AppResult;
use crate::state::AppState;

#[tauri::command]
pub async fn image_proxy_url(state: State<'_, AppState>) -> AppResult<String> {
    // 图片 CDN 同样受代理设置影响：被风控的出口会直接拒图，
    // 因此它与其余出站请求共用同一份路由。
    let route = {
        let conn = state.conn()?;
        crate::settings::get(&conn)?.proxy_route()
    };
    state.image_proxy.start(&route).await
}
