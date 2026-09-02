use crate::error::AppResult;
use crate::http_client;
use crate::models::live::SiteId;
use crate::sites::bilibili::BilibiliSite;
use crate::sites::douyin::DouyinSite;
use crate::sites::douyu::DouyuSite;
use crate::sites::huya::HuyaSite;
use crate::sites::traits::LiveSite;
use crate::sites::twitch::TwitchSite;

/// 站点列表 UI 使用的元数据（不含 cookie / HTTP 会话）。
pub struct SiteMeta {
    pub id: SiteId,
    pub name: &'static str,
}

/// 全部已注册直播站点，按稳定的展示顺序排列。
pub fn all_meta() -> Vec<SiteMeta> {
    vec![
        SiteMeta {
            id: SiteId::Bilibili,
            name: "Bilibili",
        },
        SiteMeta {
            id: SiteId::Huya,
            name: "Huya",
        },
        SiteMeta {
            id: SiteId::Douyu,
            name: "Douyu",
        },
        SiteMeta {
            id: SiteId::Douyin,
            name: "Douyin",
        },
        SiteMeta {
            id: SiteId::Twitch,
            name: "Twitch",
        },
    ]
}

/// 使用当前选定的 HTTP(S) 代理构建站点客户端（如已配置）。每种代理策略
/// 持有独立的 reqwest 客户端，
/// 防止缓存的直连连接绕过之后的设置变更。
pub fn site_with_proxy(
    id: &SiteId,
    cookie: Option<String>,
    proxy: Option<&str>,
) -> AppResult<Box<dyn LiveSite>> {
    let client = http_client::client_for_proxy(proxy)?;
    site_with_client(id, cookie, client)
}

fn site_with_client(
    id: &SiteId,
    cookie: Option<String>,
    client: reqwest::Client,
) -> AppResult<Box<dyn LiveSite>> {
    match id {
        SiteId::Bilibili => {
            let cookie = cookie.unwrap_or_default();
            Ok(Box::new(BilibiliSite::new(client, cookie)))
        }
        SiteId::Huya => Ok(Box::new(HuyaSite::new(client, cookie.unwrap_or_default()))),
        SiteId::Douyu => Ok(Box::new(DouyuSite::new_with_cookie(
            client,
            cookie.unwrap_or_default(),
        ))),
        SiteId::Douyin => Ok(Box::new(DouyinSite::new(
            client,
            cookie.unwrap_or_default(),
        ))),
        SiteId::Twitch => Ok(Box::new(TwitchSite::new(client))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_has_five_sites() {
        assert_eq!(all_meta().len(), 5);
    }

    #[test]
    fn site_lookup_roundtrip() {
        for m in all_meta() {
            site_with_proxy(&m.id, None, None).expect("site must resolve");
        }
    }
}
