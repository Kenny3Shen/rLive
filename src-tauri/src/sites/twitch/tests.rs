//! Twitch 线上 smoke 与播放列表诊断辅助测试。

use std::collections::HashSet;

use super::browse::test_support::{normalize_category_slug, normalize_tag_id};
use super::*;

/// 从播放列表中读取一个带引号的 `#EXT-X-DATERANGE` 属性。直播诊断用它指名
/// 是什么污染了清单，而不用输出整个 tag ——
/// 后者携带数 KB 的广告 token。
fn twitch_daterange_attribute(manifest: &str, attribute: &str) -> Option<String> {
    manifest
        .lines()
        .filter(|line| line.trim_start().starts_with("#EXT-X-DATERANGE:"))
        .find_map(|line| {
            let value = line.split(&format!("{attribute}=")).nth(1)?;
            Some(value.trim_start_matches('"').split('"').next()?.to_string())
        })
}

#[test]
fn a_daterange_attribute_is_read_without_the_surrounding_tag() {
    let manifest = concat!(
        "#EXTM3U\n",
        "#EXT-X-DATERANGE:ID=\"stitched-ad-1\",CLASS=\"twitch-stitched-ad\",",
        "X-TV-TWITCH-AD-ROLL-TYPE=\"PREROLL\",X-TV-TWITCH-AD-RADS-TOKEN=\"eyJhbGci\"\n",
        "#EXT-X-DATERANGE:ID=\"source-1\",X-TV-TWITCH-STREAM-SOURCE=\"Amazon|24888\"\n",
    );
    assert_eq!(
        twitch_daterange_attribute(manifest, "X-TV-TWITCH-AD-ROLL-TYPE").as_deref(),
        Some("PREROLL")
    );
    assert_eq!(
        twitch_daterange_attribute(manifest, "X-TV-TWITCH-STREAM-SOURCE").as_deref(),
        Some("Amazon|24888")
    );
    assert!(twitch_daterange_attribute(manifest, "X-TV-TWITCH-ABSENT").is_none());
}

#[tokio::test]
#[ignore = "live Twitch persisted browse contracts; requires external network"]
async fn live_persisted_browse_contracts_smoke() {
    let site = TwitchSite::new(reqwest::Client::new());
    let page = site.get_recommend_rooms(1).await.expect("recommend page");
    assert!(!page.items.is_empty(), "Twitch returned no live rooms");
    assert!(page.has_more, "official browse connection lost its cursor");

    let categories = site.get_categories().await.expect("categories");
    // 分类树是「游戏类型标签 → 具体分区」两级，不是过去单层的 30 个热门游戏。
    assert!(
        categories.len() > 1,
        "expected multiple tag parents, got {}",
        categories.len()
    );
    for parent in &categories {
        normalize_tag_id(&parent.id).expect("parent id is a tag uuid");
        assert!(!parent.children.is_empty(), "tag parent has no directories");
    }
    // 过去是单层 30 个热门游戏。实测 41 个标签 × 每标签 30 个分区约 1000 项，
    // 断言取一半留出上游波动余量。
    let total: usize = categories.iter().map(|parent| parent.children.len()).sum();
    assert!(
        total > 500,
        "tag directories should go far deeper than the old flat list, got {total}"
    );

    let category = categories[0].children.first().expect("category");
    normalize_category_slug(&category.id).expect("category slug");
    let category_page = site
        .get_category_rooms(category, 1)
        .await
        .expect("category page");
    assert!(
        !category_page.items.is_empty(),
        "category returned no rooms"
    );

    // 「全部X」磁贴按标签下的分区聚合，且能继续翻页。它必须与全站推荐不同 ——
    // 早先 `streams` 的标签入参空转时，两者返回的是同一批房间。
    let aggregate = LiveSubCategory {
        id: "0".into(),
        name: format!("全部{}", categories[0].name),
        parent_id: categories[0].id.clone(),
        pic: None,
    };
    let aggregate_page = site
        .get_category_rooms(&aggregate, 1)
        .await
        .expect("aggregate tile page");
    assert!(
        !aggregate_page.items.is_empty(),
        "aggregate tile returned no rooms"
    );
    assert!(
        aggregate_page.has_more,
        "aggregate tile should offer another page"
    );
    let first_ids: HashSet<&str> = aggregate_page
        .items
        .iter()
        .map(|item| item.room_id.as_str())
        .collect();
    let second_page = site
        .get_category_rooms(&aggregate, 2)
        .await
        .expect("aggregate page 2");
    assert!(
        second_page
            .items
            .iter()
            .any(|item| !first_ids.contains(item.room_id.as_str())),
        "aggregate page 2 repeated page 1 — the directory window is not advancing"
    );

    let search = site.search_rooms("music", 1).await.expect("search page");
    assert!(
        search.has_more,
        "official search connection lost its cursor"
    );
}

/// 真实演练搜索里的未开播频道：`searchFor` 的 CHANNEL target 同时返回在播和
/// 未开播频道，`stream` 为 `null` 就是未开播。关键词刻意用主播名而不是分区名，
/// 分区名命中的多是在播频道，覆盖不到未开播分支。
#[tokio::test]
#[ignore = "live Twitch public-web smoke; requires external network"]
async fn live_search_keeps_offline_channels_smoke() {
    let site = TwitchSite::new(reqwest::Client::new());
    let page = site.search_rooms("ninja", 1).await.expect("search page");
    assert!(
        page.items
            .iter()
            .any(|item| item.live_status == Some(true) && !item.title.is_empty()),
        "search page 1 returned no live channel with a title"
    );
    let offline = page
        .items
        .iter()
        .find(|item| item.live_status == Some(false))
        .expect("search page 1 returned no offline channels");
    assert!(
        offline.title.is_empty(),
        "offline channels carry no stream title"
    );
    assert_eq!(offline.online, 0, "offline channels report unknown viewers");
    assert!(
        offline.cover.contains("profile_image"),
        "offline channels fall back to the avatar, got: {}",
        offline.cover
    );
}

#[tokio::test]
#[ignore = "live Twitch public-web smoke; requires external network"]
async fn live_public_web_browse_room_and_playback_smoke() {
    let site = TwitchSite::new(reqwest::Client::new());
    let page = site.get_recommend_rooms(1).await.expect("recommend page");
    assert!(!page.items.is_empty(), "Twitch returned no live rooms");

    let detail = site
        .get_room_detail(&page.items[0].room_id)
        .await
        .expect("room detail");
    assert!(detail.status, "recommended room should still be live");
    let qualities = site
        .get_play_qualities(&detail)
        .await
        .expect("play qualities");
    assert!(!qualities.is_empty(), "Twitch returned no HLS variants");
    let urls = site
        .get_play_urls(&detail, &qualities[0])
        .await
        .expect("play urls");
    assert!(
        urls.first()
            .is_some_and(|url| url.url.starts_with("https://")),
        "expected a HTTPS HLS URL"
    );
}

#[tokio::test]
#[ignore = "live Kai Cenat Twitch ad-fallback smoke; requires channel and external network"]
async fn live_kaicenat_ad_fallback_smoke() {
    let client = reqwest::Client::new();
    let site = TwitchSite::new(client.clone());
    let detail = site
        .get_room_detail("kaicenat")
        .await
        .expect("Kai Cenat room detail");
    if !detail.status {
        eprintln!("Kai Cenat is offline; skipping live ad-fallback probe");
        return;
    }

    let qualities = site
        .get_play_qualities(&detail)
        .await
        .expect("Kai Cenat qualities");
    let sources = site
        .get_play_urls(&detail, &qualities[0])
        .await
        .expect("Kai Cenat play URL");
    let recovery = sources[0]
        .twitch_ad_recovery
        .as_ref()
        .expect("Twitch recovery context");
    let primary_response = client
        .get(&sources[0].url)
        .header("user-agent", DEFAULT_USER_AGENT)
        .header("referer", "https://www.twitch.tv/kaicenat")
        .send()
        .await
        .expect("Kai Cenat primary playlist request");
    let primary_status = primary_response.status();
    let primary_body = primary_response
        .text()
        .await
        .expect("Kai Cenat primary playlist body");
    // 用代理自带的检测器判断：该频道上测到的每段广告都没有任何文本标记，
    // 因此这里若只做文本检查，
    // 会把拼接过的播放列表误报为干净。
    let primary_clean = primary_status.is_success()
        && primary_body.trim_start().starts_with("#EXTM3U")
        && !crate::stream_proxy::is_twitch_ad_manifest(&primary_body);
    eprintln!(
        "Kai Cenat primary profile={}/{} status={} clean={primary_clean}",
        TWITCH_PRIMARY_PLAYER_TYPE.0,
        TWITCH_PRIMARY_PLAYER_TYPE.1,
        primary_status.as_u16(),
    );
    let mut clean_profiles = Vec::new();
    for (player_type, platform) in TWITCH_AD_FALLBACK_PROFILES {
        let url = twitch_ad_fallback_url(client.clone(), recovery, player_type, platform)
            .await
            .unwrap_or_else(|error| panic!("{player_type} fallback URL: {}", error.message));
        let response = client
            .get(url)
            .header("user-agent", DEFAULT_USER_AGENT)
            .header("referer", "https://www.twitch.tv/kaicenat")
            .send()
            .await
            .unwrap_or_else(|error| panic!("{player_type} playlist request: {error}"));
        let status = response.status();
        let body = response.text().await.expect("fallback playlist body");
        let clean = status.is_success()
            && body.trim_start().starts_with("#EXTM3U")
            && !crate::stream_proxy::is_twitch_ad_manifest(&body);
        if !clean {
            // 对结论做归因而不是简单上报：`clean=false` 必须能追溯到真实的拼接广告，
            // 而不是检测器的怪癖。只打印有辨识度的属性 ——
            // 完整 DATERANGE 携带数 KB 的广告 token。
            let roll_type = twitch_daterange_attribute(&body, "X-TV-TWITCH-AD-ROLL-TYPE");
            let source = twitch_daterange_attribute(&body, "X-TV-TWITCH-STREAM-SOURCE");
            eprintln!(
                "  {player_type} stitched-ad evidence: roll_type={} stream_source={}",
                roll_type.as_deref().unwrap_or("-"),
                source.as_deref().unwrap_or("-"),
            );
        }
        // 某 profile 能提供的画质是另一半事实：`autoplay` 是观测到能干净度过一段广告
        // 的 profile，但被 Twitch 封顶，只凭"干净"的结论会掩盖它的代价。
        // 从*变体列表*读取，因为上面的 URL 已解析成单个媒体清单，
        // 本身不再携带 `#EXT-X-STREAM-INF`。
        let ladder = TwitchSite::new(client.clone())
            .playback_variants_for_profile(&recovery.login, player_type, platform)
            .await
            .map(|variants| {
                variants
                    .iter()
                    .map(|variant| variant.label.clone())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        eprintln!(
            "Kai Cenat fallback profile={player_type}/{platform} status={} clean={clean} renditions={} ladder={ladder:?}",
            status.as_u16(),
            ladder.len(),
        );
        if clean {
            clean_profiles.push(player_type);
        }
    }
    // 不断言：频道不在广告时段时每个 profile 都是干净的，而在广告期间诚实的结论
    // 可能就是只有被封顶的 `autoplay` 能存活。两者都是要解读的发现，不是失败。
    eprintln!(
        "Kai Cenat primary clean={primary_clean} clean fallback profiles: {clean_profiles:?}"
    );
}
