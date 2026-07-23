use crate::error::AppResult;
use crate::models::live::SiteId;
use crate::sites::bilibili::BilibiliSite;
use crate::sites::douyin::DouyinSite;
use crate::sites::douyu::DouyuSite;
use crate::sites::huya::HuyaSite;
use crate::sites::kuaishou::KuaishouSite;
use crate::sites::traits::LiveSite;

static BILIBILI: BilibiliSite = BilibiliSite;
static HUYA: HuyaSite = HuyaSite;
static DOUYU: DouyuSite = DouyuSite;
static DOUYIN: DouyinSite = DouyinSite;
static KUAISHOU: KuaishouSite = KuaishouSite;

/// All registered live sites, in stable display order.
pub fn all() -> Vec<&'static dyn LiveSite> {
    vec![&BILIBILI, &HUYA, &DOUYU, &DOUYIN, &KUAISHOU]
}

/// Look up a site by id.
pub fn site(id: &SiteId) -> AppResult<&'static dyn LiveSite> {
    match id {
        SiteId::Bilibili => Ok(&BILIBILI),
        SiteId::Huya => Ok(&HUYA),
        SiteId::Douyu => Ok(&DOUYU),
        SiteId::Douyin => Ok(&DOUYIN),
        SiteId::Kuaishou => Ok(&KUAISHOU),
    }
}

/// Whether a site's LiveSite methods are fully implemented (HTTP, etc.).
/// Task 5: all stubs — Task 6 will flip bilibili to true.
pub fn is_ready(id: &SiteId) -> bool {
    match id {
        SiteId::Bilibili
        | SiteId::Huya
        | SiteId::Douyu
        | SiteId::Douyin
        | SiteId::Kuaishou => false,
    }
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
        for s in all() {
            let found = site(&s.id()).expect("site must resolve");
            assert_eq!(found.id(), s.id());
            assert_eq!(found.name(), s.name());
        }
    }

    #[test]
    fn no_sites_ready_yet() {
        for s in all() {
            assert!(!is_ready(&s.id()));
        }
    }
}
