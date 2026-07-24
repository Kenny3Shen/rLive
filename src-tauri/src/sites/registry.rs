use crate::error::AppResult;
use crate::http_client;
use crate::models::live::SiteId;
use crate::sites::bilibili::BilibiliSite;
use crate::sites::douyin::DouyinSite;
use crate::sites::douyu::DouyuSite;
use crate::sites::huya::HuyaSite;
use crate::sites::kuaishou::KuaishouSite;
use crate::sites::traits::LiveSite;

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
            id: SiteId::Kuaishou,
            name: "Kuaishou",
        },
    ]
}

/// Backward-compatible alias used by commands that only need id/name.
pub fn all() -> Vec<SiteMeta> {
    all_meta()
}

/// Build a site instance. For Bilibili, `cookie` is applied (from account store).
pub fn site(id: &SiteId, cookie: Option<String>) -> AppResult<Box<dyn LiveSite>> {
    match id {
        SiteId::Bilibili => {
            let cookie = cookie.unwrap_or_default();
            Ok(Box::new(BilibiliSite::new(
                http_client::default_client(),
                cookie,
            )))
        }
        SiteId::Huya => Ok(Box::new(HuyaSite::new(http_client::default_client()))),
        SiteId::Douyu => Ok(Box::new(DouyuSite::new(http_client::default_client()))),
        SiteId::Douyin => Ok(Box::new(DouyinSite::new(
            http_client::default_client(),
            cookie.unwrap_or_default(),
        ))),
        SiteId::Kuaishou => Ok(Box::new(KuaishouSite)),
    }
}

/// Whether a site's LiveSite methods are fully implemented (HTTP, etc.).
pub fn is_ready(id: &SiteId) -> bool {
    matches!(
        id,
        SiteId::Bilibili | SiteId::Huya | SiteId::Douyu | SiteId::Douyin
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_has_five_sites() {
        assert_eq!(all().len(), 5);
    }

    #[test]
    fn site_lookup_roundtrip() {
        for m in all() {
            let found = site(&m.id, None).expect("site must resolve");
            assert_eq!(found.id(), m.id);
            assert_eq!(found.name(), m.name);
        }
    }

    #[test]
    fn ready_sites() {
        assert!(is_ready(&SiteId::Bilibili));
        assert!(is_ready(&SiteId::Huya));
        assert!(is_ready(&SiteId::Douyu));
        assert!(is_ready(&SiteId::Douyin));
    }
}
