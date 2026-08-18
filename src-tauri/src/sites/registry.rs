use crate::error::AppResult;
use crate::http_client;
use crate::models::live::SiteId;
use crate::sites::bilibili::BilibiliSite;
use crate::sites::douyin::DouyinSite;
use crate::sites::douyu::DouyuSite;
use crate::sites::huya::HuyaSite;
use crate::sites::traits::LiveSite;
use crate::sites::twitch::TwitchSite;

/// Metadata for site list UI (no cookie / HTTP session).
pub struct SiteMeta {
    pub id: SiteId,
    pub name: &'static str,
}

/// All registered live sites, in stable display order.
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

/// Build a site client using the currently selected HTTP(S) proxy when one is
/// configured.  Each proxy policy owns a separate reqwest client, preventing
/// a cached direct connection from bypassing a later settings change.
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

/// Whether a site's LiveSite methods are fully implemented (HTTP, etc.).
pub fn is_ready(id: &SiteId) -> bool {
    matches!(
        id,
        SiteId::Bilibili | SiteId::Huya | SiteId::Douyu | SiteId::Douyin | SiteId::Twitch
    )
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

    #[test]
    fn ready_sites() {
        assert!(is_ready(&SiteId::Bilibili));
        assert!(is_ready(&SiteId::Huya));
        assert!(is_ready(&SiteId::Douyu));
        assert!(is_ready(&SiteId::Douyin));
        assert!(is_ready(&SiteId::Twitch));
    }
}
