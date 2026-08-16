//! Twitch public-web live-site client.
//!
//! Twitch's documented Helix endpoints require an app OAuth credential, which
//! a desktop client must not embed.  This module instead uses the same public
//! GraphQL endpoint and playback bootstrap exposed by `www.twitch.tv` to an
//! anonymous visitor.  The public web client id is discovered from the
//! bootstrap document at runtime; it is neither hard-coded nor persisted.
//!
//! Browsing is paginated by *language shard* rather than by Relay cursor.
//! Twitch answers any `after:` cursor with `IntegrityCheckFailed` unless the
//! request comes from a browser context that passed its JavaScript integrity
//! challenge, whereas a plain `broadcasterLanguages` filter needs nothing but
//! the public client id.  Walking the language list therefore reaches the same
//! depth with no token, no hidden WebView and identical behaviour on mobile.

use std::collections::{HashMap, HashSet};
use std::ops::Range;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use base64::Engine as _;
use futures_util::future;
use reqwest::{Client, Url};
use serde_json::{Value, json};

use crate::error::{AppError, AppResult};
use crate::models::live::{
    LiveCategory, LivePlayQuality, LiveRoomDetail, LiveRoomItem, LiveRoomStatus, LiveSubCategory,
    PlayUrl, RoomListPage, SiteId, parse_live_started_at,
};
use crate::sites::traits::LiveSite;

const TWITCH_WEB_ROOT: &str = "https://www.twitch.tv/";
const TWITCH_GQL_URL: &str = "https://gql.twitch.tv/gql";
const TWITCH_USHER_URL: &str = "https://usher.ttvnw.net/api/channel/hls";
const PAGE_SIZE: u32 = 30;
const CONTEXT_CACHE_TTL: Duration = Duration::from_secs(6 * 60 * 60);

/// The pagination axis: one shard is one `broadcasterLanguages` filter, and the
/// empty string means "no filter", i.e. the global top-viewed listing that used
/// to be the only reachable page.
///
/// `first` is capped at 30 server-side, so a single unfiltered request can never
/// see past the 30 most-watched channels. Sharding by language is what makes the
/// tail reachable: measured against the global feed the 27 shards below yield 735
/// distinct live channels, versus 30 without them.
///
/// Ordered by audience size so the first pages stay the most interesting ones,
/// and kept to languages Twitch's own directory filter offers -- an unknown code
/// is not an error, it just returns nothing and wastes a request.
const LANGUAGE_SHARDS: &[&str] = &[
    "", "EN", "ZH", "JA", "KO", "ES", "PT", "DE", "FR", "RU", "IT", "PL", "TR", "TH", "VI", "AR",
    "NL", "SV", "CS", "HU", "FI", "DA", "NO", "ID", "MS", "EL", "RO",
];

/// Shards merged into one list page. Three keeps the burst small while still
/// filling a page: the shards overlap (a channel can be listed under both the
/// global and its language shard), so three 30-item shards land at roughly
/// 70-80 distinct rooms.
const SHARD_WINDOW: usize = 3;

/// Twitch decides server-side ad stitching per playback token, and the
/// `playerType` the token was minted for is part of that decision.  `site` stays
/// the primary because it is both clean and full quality: measured on
/// `kaicenat` it carries the channel's whole ladder (`1080p60` source down to
/// `audio_only`, 7 renditions) and returned no stitched ad in any sample.
pub(crate) const TWITCH_PRIMARY_PLAYER_TYPE: (&str, &str) = ("site", "web");

/// Recovery order for a stitched playlist, ordered by what was measured rather
/// than by guesswork.  Across six consecutive samples of `kaicenat` the verdict
/// per `playerType` was completely stable, which is why this is an ordered list
/// and not a set to try at random:
///
/// | profile             | stitched ad | ladder                     |
/// |---------------------|-------------|----------------------------|
/// | `popout`            | no          | 7, up to `1080p60` source  |
/// | `autoplay`          | no          | 3, capped at `360p`        |
/// | `embed`             | yes (preroll) | 7                        |
/// | `picture-by-picture`| yes (preroll) | 3, capped at `360p`      |
///
/// So `popout` is tried first: it was clean *and* keeps the full ladder.
/// `autoplay` is next -- also clean, but Twitch caps it, so it trades quality
/// for an ad-free picture.  `embed` and `picture-by-picture` stay last precisely
/// because they were the profiles observed carrying ads; they are retained only
/// as a final attempt for the case where the profiles above are the stitched
/// ones, since Twitch's per-profile decision is not guaranteed to stay fixed.
///
/// Note the ads seen on `embed` / `picture-by-picture` were `ROLL-TYPE=PREROLL`,
/// i.e. attached to a freshly minted playback session rather than to a mid-stream
/// commercial.  A profile being clean here therefore does not prove it survives a
/// real commercial break; it proves Twitch does not treat all player types alike.
pub(crate) const TWITCH_AD_FALLBACK_PROFILES: [(&str, &str); 4] = [
    ("popout", "web"),
    ("autoplay", "android"),
    ("embed", "web"),
    ("picture-by-picture", "web"),
];

/// Keep a stable browser-like UA for the web bootstrap and HLS CDN.  It does
/// not identify an account and is not coupled to a fragile browser version.
pub const DEFAULT_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/// The current Twitch public-web GraphQL client id is embedded in the HTML
/// bootstrap.  It may rotate, so retain it only in process memory.
#[derive(Clone)]
struct PublicWebContext {
    client_id: String,
    fetched_at: Instant,
}

static PUBLIC_WEB_CONTEXT: OnceLock<Mutex<Option<PublicWebContext>>> = OnceLock::new();

/// Twitch's web client sends a device identifier with every GraphQL request.
/// Omitting it marks the caller as an unrecognised client, which is one of the
/// signals that decides whether a playback token gets server-stitched ads.
/// This is a random per-process value: it is never persisted, never derived
/// from the machine, and identifies no account.
static GQL_DEVICE_ID: OnceLock<String> = OnceLock::new();

fn gql_device_id() -> &'static str {
    GQL_DEVICE_ID.get_or_init(|| {
        // Twitch's own identifier is 32 lowercase alphanumerics.
        const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
        let raw = uuid::Uuid::new_v4().as_u128();
        let mut id = String::with_capacity(32);
        let mut remaining = raw;
        for _ in 0..32 {
            let index = (remaining % ALPHABET.len() as u128) as usize;
            id.push(ALPHABET[index] as char);
            remaining /= ALPHABET.len() as u128;
            if remaining == 0 {
                remaining = uuid::Uuid::new_v4().as_u128();
            }
        }
        id
    })
}

/// Twitch's registered live-site backend.
pub struct TwitchSite {
    client: Client,
    site_id: SiteId,
}

/// First shard index of `page`'s window, or `None` once the shard list is
/// exhausted. Pure arithmetic, so a page can be requested directly without
/// having walked the pages before it.
fn shard_window_start(page: u32) -> Option<usize> {
    let start = (page.max(1) as usize - 1).checked_mul(SHARD_WINDOW)?;
    (start < LANGUAGE_SHARDS.len()).then_some(start)
}

/// A language-sharded feed: each feed type (recommend, category) knows how to
/// ask Twitch for one language shard and where its edges live in the response.
/// Paging walks shards instead of Relay cursors, so every page is independent
/// and needs no per-process state.
trait ShardFeed {
    fn operation_name(&self) -> &'static str;
    fn query(&self) -> &'static str;
    fn variables(&self, language: &str) -> Value;
    fn edges_path(&self) -> &'static str;
}

struct RecommendFeed;

impl ShardFeed for RecommendFeed {
    fn operation_name(&self) -> &'static str {
        "RLiveTwitchStreams"
    }

    fn query(&self) -> &'static str {
        r#"
        query RLiveTwitchStreams($limit: Int!, $languages: [Language!]) {
          streams(first: $limit, options: { broadcasterLanguages: $languages, sort: VIEWER_COUNT }) {
            edges {
              node {
                id
                title
                viewersCount
                previewImageURL(width: 440, height: 248)
                broadcaster { id login displayName }
              }
            }
          }
        }
        "#
    }

    fn variables(&self, language: &str) -> Value {
        json!({
            "limit": PAGE_SIZE,
            "languages": language_filter(language),
        })
    }

    fn edges_path(&self) -> &'static str {
        "/streams/edges"
    }
}

struct CategoryFeed<'a> {
    slug: &'a str,
}

impl ShardFeed for CategoryFeed<'_> {
    fn operation_name(&self) -> &'static str {
        "RLiveTwitchCategoryStreams"
    }

    fn query(&self) -> &'static str {
        r#"
        query RLiveTwitchCategoryStreams($slug: String!, $limit: Int!, $languages: [Language!]) {
          game(slug: $slug) {
            streams(first: $limit, options: { broadcasterLanguages: $languages, sort: VIEWER_COUNT }) {
              edges {
                node {
                  id
                  title
                  viewersCount
                  previewImageURL(width: 440, height: 248)
                  broadcaster { id login displayName }
                }
              }
            }
          }
        }
        "#
    }

    fn variables(&self, language: &str) -> Value {
        json!({
            "slug": self.slug,
            "limit": PAGE_SIZE,
            "languages": language_filter(language),
        })
    }

    fn edges_path(&self) -> &'static str {
        "/game/streams/edges"
    }
}

/// `broadcasterLanguages: []` means "every language" and is what page 1 uses;
/// a concrete code restricts the shard to that language.
fn language_filter(language: &str) -> Value {
    if language.is_empty() {
        json!([])
    } else {
        json!([language])
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TwitchVariant {
    /// A semantic ID from the HLS master playlist, rather than the variant's
    /// position in that playlist. Twitch can reorder the playlist each time a
    /// short-lived playback token is issued.
    selector: String,
    label: String,
    url: String,
    is_source: bool,
    width: u32,
    height: u32,
    frame_rate_milli: u32,
    bandwidth: u64,
}

#[derive(Debug, Clone)]
struct HlsStreamInfo {
    video_group: Option<String>,
    resolution: Option<String>,
    frame_rate: Option<String>,
    codecs: Option<String>,
    bandwidth: Option<String>,
}

impl TwitchSite {
    pub fn new(client: Client) -> Self {
        Self {
            client,
            site_id: SiteId::Twitch,
        }
    }

    fn err(message: impl Into<String>) -> AppError {
        AppError::new("twitch_api_error", message)
            .with_site("twitch")
            .retryable()
    }

    fn parse_err(message: impl Into<String>) -> AppError {
        AppError::new("twitch_parse_error", message).with_site("twitch")
    }

    fn context_cache() -> &'static Mutex<Option<PublicWebContext>> {
        PUBLIC_WEB_CONTEXT.get_or_init(|| Mutex::new(None))
    }

    async fn public_web_context(&self) -> AppResult<PublicWebContext> {
        if let Some(context) = Self::context_cache()
            .lock()
            .map_err(|_| Self::parse_err("Twitch public context mutex poisoned"))?
            .as_ref()
            .filter(|context| context.fetched_at.elapsed() < CONTEXT_CACHE_TTL)
            .cloned()
        {
            return Ok(context);
        }

        let response = self
            .client
            .get(TWITCH_WEB_ROOT)
            .header("user-agent", DEFAULT_USER_AGENT)
            .header(
                "accept",
                "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            )
            .header("accept-language", "zh-CN,zh;q=0.9,en;q=0.8")
            .send()
            .await
            .map_err(|error| Self::err(format!("获取 Twitch 网页初始化信息失败: {error}")))?;
        let status = response.status();
        let html = response
            .text()
            .await
            .map_err(|error| Self::err(format!("读取 Twitch 网页初始化信息失败: {error}")))?;
        if !status.is_success() {
            return Err(Self::err(format!(
                "Twitch 网页初始化 HTTP {status}: {}",
                preview(&html)
            )));
        }

        let client_id = parse_public_client_id(&html).ok_or_else(|| {
            Self::parse_err("Twitch 网页未提供公共客户端标识，可能变更了网页初始化格式，请稍后重试")
        })?;
        let context = PublicWebContext {
            client_id,
            fetched_at: Instant::now(),
        };
        *Self::context_cache()
            .lock()
            .map_err(|_| Self::parse_err("Twitch public context mutex poisoned"))? =
            Some(context.clone());
        Ok(context)
    }

    /// One anonymous-web-visit GraphQL POST: the headers and text/plain
    /// content type mirror Twitch's own bootstrap requests.
    async fn post_gql(&self, body: &Value) -> AppResult<Value> {
        let context = self.public_web_context().await?;
        let response = self
            .client
            .post(TWITCH_GQL_URL)
            .header("user-agent", DEFAULT_USER_AGENT)
            .header("referer", TWITCH_WEB_ROOT)
            .header("client-id", context.client_id)
            .header("x-device-id", gql_device_id())
            .header("content-type", "text/plain; charset=UTF-8")
            .json(body)
            .send()
            .await
            .map_err(|error| Self::err(format!("Twitch GraphQL 请求失败: {error}")))?;
        let status = response.status();
        let text = response
            .text()
            .await
            .map_err(|error| Self::err(format!("读取 Twitch GraphQL 响应失败: {error}")))?;
        if !status.is_success() {
            return Err(Self::err(format!(
                "Twitch GraphQL HTTP {status}: {}",
                preview(&text)
            )));
        }
        serde_json::from_str(&text)
            .map_err(|error| Self::parse_err(format!("Twitch GraphQL JSON 解析失败: {error}")))
    }

    async fn graphql(
        &self,
        operation_name: &str,
        query: &str,
        variables: Value,
    ) -> AppResult<Value> {
        let value = self
            .post_gql(&json!({
                "operationName": operation_name,
                "query": query,
                "variables": variables,
            }))
            .await?;
        if let Some(error) = graphql_error(&value) {
            return Err(error);
        }
        value
            .get("data")
            .cloned()
            .ok_or_else(|| Self::parse_err("Twitch GraphQL 响应缺少 data"))
    }

    /// Fetch the language shards belonging to `page` and merge them into one
    /// list page.
    ///
    /// Twitch rejects every Relay `after:` cursor that is not backed by a live
    /// browser integrity context, which is why page 2 used to be reachable only
    /// through the hidden WebView and not at all on mobile. A shard request
    /// carries no cursor, so the public `Client-ID` is enough and the same depth
    /// is reachable on every platform.
    ///
    /// The page-to-shard mapping is fixed arithmetic, so no cursor state has to
    /// survive between requests. Sparse categories can interleave empty shards
    /// (measured on `factorio`: 20 of 26 languages return nothing), therefore an
    /// empty page does not mean the feed is exhausted: `has_more` remains true
    /// until the language list itself ends, allowing the frontend to scan on to
    /// a later shard that still contains rooms.
    async fn shard_page(&self, feed: impl ShardFeed, page: u32) -> AppResult<RoomListPage> {
        let page = page.max(1);
        let Some(start) = shard_window_start(page) else {
            return Ok(empty_page());
        };
        let window_end = (start + SHARD_WINDOW).min(LANGUAGE_SHARDS.len());

        // Warm the shared context before fan-out. Otherwise a cold page would
        // race three bootstrap GETs, because each shard needs the same Client-ID.
        self.public_web_context().await?;

        let mut items = Vec::new();
        let mut seen = HashSet::new();
        self.collect_shards(&feed, start..window_end, &mut items, &mut seen)
            .await?;

        Ok(RoomListPage {
            has_more: shard_window_start(page + 1).is_some(),
            items,
        })
    }

    /// Request a shard range concurrently and append the new rooms in shard
    /// order. The range is at most `SHARD_WINDOW` wide, which keeps the burst
    /// comparable to what Twitch's own web client issues for one directory view.
    async fn collect_shards(
        &self,
        feed: &impl ShardFeed,
        shards: Range<usize>,
        items: &mut Vec<LiveRoomItem>,
        seen: &mut HashSet<String>,
    ) -> AppResult<()> {
        let requests = LANGUAGE_SHARDS[shards].iter().map(|language| {
            self.graphql(
                feed.operation_name(),
                feed.query(),
                feed.variables(language),
            )
        });
        for data in future::try_join_all(requests).await? {
            for item in parse_stream_edges(&data, feed.edges_path(), &self.site_id) {
                if seen.insert(item.room_id.to_ascii_lowercase()) {
                    items.push(item);
                }
            }
        }
        Ok(())
    }

    async fn recommend_page(&self, page: u32) -> AppResult<RoomListPage> {
        self.shard_page(RecommendFeed, page).await
    }

    async fn category_page(&self, category_id: &str, page: u32) -> AppResult<RoomListPage> {
        let slug = normalize_category_slug(category_id)?;
        self.shard_page(CategoryFeed { slug: &slug }, page).await
    }

    async fn search_page(&self, keyword: &str, page: u32) -> AppResult<RoomListPage> {
        let page = page.max(1);
        // Search uses offset-based cursors (base64-encoded integers) and does
        // not require the integrity token. Compute cursor arithmetically.
        let offset = (page.saturating_sub(1)) * PAGE_SIZE;
        let cursor =
            base64::engine::general_purpose::STANDARD.encode(offset.to_string().as_bytes());
        let target = json!({
            "index": "CHANNEL",
            "cursor": cursor,
            "limit": PAGE_SIZE,
        });
        let data = self
            .graphql(
                "RLiveTwitchSearch",
                r#"
                query RLiveTwitchSearch($query: String!, $options: SearchForOptions) {
                  searchFor(userQuery: $query, platform: "web", options: $options) {
                    channels {
                      cursor
                      totalMatches
                      edges {
                        item {
                          ... on User {
                            id
                            login
                            displayName
                            profileImageURL(width: 150)
                            stream {
                              id
                              title
                              viewersCount
                              previewImageURL(width: 440, height: 248)
                            }
                          }
                        }
                      }
                    }
                  }
                }
                "#,
                json!({
                    "query": keyword,
                    "options": {
                        "targets": [target],
                    },
                }),
            )
            .await?;
        let returned_cursor = data
            .pointer("/searchFor/channels/cursor")
            .and_then(Value::as_str)
            .filter(|c| !c.is_empty());
        let item_count = data
            .pointer("/searchFor/channels/edges")
            .and_then(Value::as_array)
            .map_or(0, Vec::len);
        let has_more =
            item_count > 0 && returned_cursor.is_some() && returned_cursor != Some(&cursor);
        Ok(RoomListPage {
            has_more,
            items: parse_search_items(&data, &self.site_id),
        })
    }

    async fn playback_variants(&self, login: &str) -> AppResult<Vec<TwitchVariant>> {
        let (player_type, platform) = TWITCH_PRIMARY_PLAYER_TYPE;
        self.playback_variants_for_profile(login, player_type, platform)
            .await
    }

    async fn playback_variants_for_profile(
        &self,
        login: &str,
        player_type: &str,
        platform: &str,
    ) -> AppResult<Vec<TwitchVariant>> {
        let login = normalize_login(login)?;
        let data = self
            .graphql(
                "PlaybackAccessToken_Template",
                // This is the non-persisted query emitted in Twitch's public
                // HTML bootstrap.  It avoids relying on a rotating persisted
                // query hash and returns only a short-lived public play token.
                r#"
                    query PlaybackAccessToken_Template(
                      $login: String!,
                      $isLive: Boolean!,
                      $vodID: ID!,
                      $isVod: Boolean!,
                      $playerType: String!,
                      $platform: String!
                    ) {
                      streamPlaybackAccessToken(
                        channelName: $login,
                        params: {
                          platform: $platform,
                          playerBackend: "mediaplayer",
                          playerType: $playerType
                        }
                      ) @include(if: $isLive) {
                        value
                        signature
                        authorization {
                          isForbidden
                          forbiddenReasonCode
                        }
                      }
                      videoPlaybackAccessToken(
                        id: $vodID,
                        params: {
                          platform: $platform,
                          playerBackend: "mediaplayer",
                          playerType: $playerType
                        }
                      ) @include(if: $isVod) {
                        value
                        signature
                      }
                    }
                "#,
                json!({
                    "isLive": true,
                    "login": login,
                    "isVod": false,
                    "vodID": "",
                    "playerType": player_type,
                    "platform": platform,
                }),
            )
            .await?;
        let token = data
            .pointer("/streamPlaybackAccessToken/value")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                AppError::new("twitch_not_live", "该 Twitch 直播间当前未开播或无法观看")
                    .with_site("twitch")
            })?;
        let signature = data
            .pointer("/streamPlaybackAccessToken/signature")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| Self::parse_err("Twitch 播放令牌缺少签名"))?;
        if data
            .pointer("/streamPlaybackAccessToken/authorization/isForbidden")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            let reason = data
                .pointer("/streamPlaybackAccessToken/authorization/forbiddenReasonCode")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            return Err(AppError::new(
                "twitch_playback_forbidden",
                format!("该 Twitch 直播间不允许播放（{reason}）"),
            )
            .with_site("twitch"));
        }

        let master = usher_master_url(&login, signature, token, player_type)?;
        let response = self
            .client
            .get(master.clone())
            .header("user-agent", DEFAULT_USER_AGENT)
            .header("referer", format!("https://www.twitch.tv/{login}"))
            .send()
            .await
            .map_err(|error| Self::err(format!("请求 Twitch HLS 主播放列表失败: {error}")))?;
        let status = response.status();
        let body = response
            .text()
            .await
            .map_err(|error| Self::err(format!("读取 Twitch HLS 主播放列表失败: {error}")))?;
        if !status.is_success() {
            return Err(Self::err(format!(
                "Twitch HLS 主播放列表 HTTP {status}: {}",
                preview(&body)
            )));
        }
        let variants = parse_hls_variants(&body, &master);
        if variants.is_empty() {
            return Err(Self::parse_err("Twitch HLS 主播放列表没有可用清晰度"));
        }
        Ok(variants)
    }
}

pub(crate) async fn twitch_ad_fallback_url(
    client: Client,
    recovery: &crate::models::live::TwitchAdRecovery,
    player_type: &str,
    platform: &str,
) -> AppResult<String> {
    let site = TwitchSite::new(client);
    let variants = site
        .playback_variants_for_profile(&recovery.login, player_type, platform)
        .await?;
    find_hls_variant(&variants, &recovery.selector)
        .or_else(|| find_closest_hls_variant(&variants, recovery))
        .map(|variant| variant.url.clone())
        .ok_or_else(|| TwitchSite::parse_err("Twitch 备用播放列表缺少所选清晰度"))
}

#[async_trait::async_trait]
impl LiveSite for TwitchSite {
    async fn get_categories(&self) -> AppResult<Vec<LiveCategory>> {
        let data = self
            .graphql(
                "RLiveTwitchGames",
                r#"
                    query RLiveTwitchGames($first: Int!) {
                      games(first: $first) {
                        edges {
                          node {
                            id
                            slug
                            name
                            displayName
                            boxArtURL(width: 285, height: 380)
                          }
                        }
                      }
                    }
                "#,
                json!({ "first": PAGE_SIZE }),
            )
            .await?;
        let mut children = Vec::new();
        for node in data
            .pointer("/games/edges")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|edge| edge.get("node"))
        {
            let id = json_string(node.get("slug"));
            let name = first_non_empty([
                json_string(node.get("displayName")),
                json_string(node.get("name")),
            ]);
            if normalize_category_slug(&id).is_err() || name.is_empty() {
                continue;
            }
            children.push(LiveSubCategory {
                id,
                name,
                parent_id: "twitch".into(),
                pic: non_empty(json_string(node.get("boxArtURL"))),
            });
        }
        if children.is_empty() {
            return Err(Self::parse_err("Twitch 未返回可用直播分类"));
        }
        Ok(vec![LiveCategory {
            id: "twitch".into(),
            name: "热门分类".into(),
            children,
        }])
    }

    async fn get_recommend_rooms(&self, page: u32) -> AppResult<RoomListPage> {
        self.recommend_page(page).await
    }

    async fn get_category_rooms(
        &self,
        category: &LiveSubCategory,
        page: u32,
    ) -> AppResult<RoomListPage> {
        // CategoryPage provides a synthetic "全部热门分类" tile with ID "0"
        // for every platform. Twitch has no corresponding game ID, so route
        // that common UI affordance back to the regular live recommendation
        // feed instead of returning an empty `game(id: "0")` result.
        if is_all_categories_entry(&category.id) {
            return self.get_recommend_rooms(page).await;
        }
        self.category_page(&category.id, page).await
    }

    async fn search_rooms(&self, keyword: &str, page: u32) -> AppResult<RoomListPage> {
        let keyword = keyword.trim();
        if keyword.is_empty() {
            return Ok(empty_page());
        }
        self.search_page(keyword, page).await
    }

    async fn get_room_live_status(&self, room_id: &str) -> AppResult<LiveRoomStatus> {
        let login = normalize_login(room_id)?;
        let data = self
            .graphql(
                "RLiveTwitchRoomStatus",
                r#"
                    query RLiveTwitchRoomStatus($login: String!) {
                      user(login: $login) {
                        stream {
                          createdAt
                        }
                      }
                    }
                "#,
                json!({ "login": login }),
            )
            .await?;
        parse_room_live_status(&data)
    }

    async fn get_room_detail(&self, room_id: &str) -> AppResult<LiveRoomDetail> {
        let login = normalize_login(room_id)?;
        let data = self
            .graphql(
                "RLiveTwitchRoom",
                r#"
                    query RLiveTwitchRoom($login: String!) {
                      user(login: $login) {
                        id
                        login
                        displayName
                        description
                        profileImageURL(width: 150)
                        stream {
                          id
                          createdAt
                          title
                          viewersCount
                          previewImageURL(width: 440, height: 248)
                          game {
                            id
                            displayName
                            name
                          }
                        }
                      }
                    }
                "#,
                json!({ "login": login }),
            )
            .await?;
        parse_room_detail(&data, &self.site_id, &login)
    }

    async fn get_play_qualities(&self, detail: &LiveRoomDetail) -> AppResult<Vec<LivePlayQuality>> {
        if !detail.status {
            return Err(AppError::new(
                "twitch_not_live",
                "该 Twitch 直播间当前未开播，无法获取播放地址",
            )
            .with_site("twitch"));
        }
        let login = detail
            .raw
            .get("login")
            .and_then(Value::as_str)
            .unwrap_or(&detail.room_id);
        let login = normalize_login(login)?;
        let variants = self.playback_variants(&login).await?;
        Ok(variants
            .iter()
            .map(|variant| LivePlayQuality {
                quality: variant.label.clone(),
                // The signed URL is intentionally not retained in this
                // payload.  Re-fetch it immediately before playback so stale
                // Twitch tokens cannot survive in the frontend query cache.
                // Keep the semantic HLS selector so the same quality can be
                // found even if Twitch changes manifest ordering meanwhile.
                data: json!({ "selector": variant.selector.clone() }),
            })
            .collect())
    }

    async fn get_play_urls(
        &self,
        detail: &LiveRoomDetail,
        quality: &LivePlayQuality,
    ) -> AppResult<Vec<PlayUrl>> {
        let selector = quality
            .data
            .get("selector")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| Self::parse_err("Twitch 播放清晰度缺少稳定标识"))?;
        let login = detail
            .raw
            .get("login")
            .and_then(Value::as_str)
            .unwrap_or(&detail.room_id);
        let login = normalize_login(login)?;
        let variants = self.playback_variants(&login).await?;
        let variant = find_hls_variant(&variants, selector)
            .ok_or_else(|| Self::parse_err("Twitch 播放清晰度已过期，请刷新后重试"))?;
        let mut headers = HashMap::new();
        headers.insert("user-agent".into(), DEFAULT_USER_AGENT.into());
        headers.insert("referer".into(), format!("https://www.twitch.tv/{login}"));
        Ok(vec![
            PlayUrl::inferred(
                format!("twitch:{selector}"),
                "Twitch HLS",
                0,
                variant.url.clone(),
                headers,
            )
            .with_protocol(crate::models::live::PlaybackProtocol::Hls)
            .with_twitch_ad_recovery(
                login,
                selector.to_string(),
                variant.width,
                variant.height,
                variant.frame_rate_milli,
            ),
        ])
    }
}

fn empty_page() -> RoomListPage {
    RoomListPage {
        has_more: false,
        items: Vec::new(),
    }
}

fn parse_public_client_id(html: &str) -> Option<String> {
    // Current public Twitch bootstrap assigns `clientId="..."`.  The second
    // marker handles an equivalent object-literal form without treating an
    // arbitrary value in the page as a client id.
    ["clientId=\"", "clientId:\""].iter().find_map(|marker| {
        let rest = html.split_once(marker)?.1;
        let candidate = rest.split('"').next()?.trim();
        (candidate.len() >= 16
            && candidate.len() <= 96
            && candidate
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-')))
        .then(|| candidate.to_string())
    })
}

fn normalize_login(value: &str) -> AppResult<String> {
    let value = value.trim();
    let without_host = value
        .strip_prefix("https://www.twitch.tv/")
        .or_else(|| value.strip_prefix("http://www.twitch.tv/"))
        .or_else(|| value.strip_prefix("https://twitch.tv/"))
        .or_else(|| value.strip_prefix("http://twitch.tv/"))
        .unwrap_or(value);
    let login = without_host
        .split(['/', '?', '#'])
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    if login.is_empty()
        || login.len() > 25
        || !login
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
    {
        return Err(
            AppError::new("twitch_invalid_room_id", "无效的 Twitch 频道名").with_site("twitch"),
        );
    }
    Ok(login)
}

fn normalize_category_slug(value: &str) -> AppResult<String> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 96
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return Err(
            AppError::new("twitch_invalid_category_id", "无效的 Twitch 分类标识")
                .with_site("twitch"),
        );
    }
    Ok(value.to_string())
}

/// The shared category page reserves `0` for its synthetic "all" tile.
/// Twitch game IDs are positive numeric strings, so this sentinel is never
/// sent to Twitch's `game(id:)` GraphQL field.
fn is_all_categories_entry(value: &str) -> bool {
    value.trim() == "0"
}

fn parse_stream_edges(data: &Value, pointer: &str, site_id: &SiteId) -> Vec<LiveRoomItem> {
    data.pointer(pointer)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|edge| edge.get("node"))
        .filter_map(|stream| stream_to_item(stream, site_id))
        .collect()
}

fn stream_to_item(stream: &Value, site_id: &SiteId) -> Option<LiveRoomItem> {
    let broadcaster = stream.get("broadcaster")?;
    let room_id = normalize_login(&json_string(broadcaster.get("login"))).ok()?;
    Some(LiveRoomItem {
        site_id: site_id.clone(),
        room_id,
        title: json_string(stream.get("title")),
        cover: json_string(stream.get("previewImageURL")),
        user_name: first_non_empty([
            json_string(broadcaster.get("displayName")),
            json_string(broadcaster.get("login")),
        ]),
        online: json_i64(stream.get("viewersCount")),
    })
}

fn parse_search_items(data: &Value, site_id: &SiteId) -> Vec<LiveRoomItem> {
    let users = data
        .pointer("/searchFor/channels/edges")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|edge| edge.get("item"))
        .chain(
            data.pointer("/searchFor/channels/items")
                .and_then(Value::as_array)
                .into_iter()
                .flatten(),
        );
    users
        .filter_map(|user| {
            let stream = user.get("stream").filter(|stream| stream.is_object())?;
            let room_id = normalize_login(&json_string(user.get("login"))).ok()?;
            Some(LiveRoomItem {
                site_id: site_id.clone(),
                room_id,
                title: json_string(stream.get("title")),
                cover: json_string(stream.get("previewImageURL")),
                user_name: first_non_empty([
                    json_string(user.get("displayName")),
                    json_string(user.get("login")),
                ]),
                online: json_i64(stream.get("viewersCount")),
            })
        })
        .collect()
}

fn parse_room_detail(
    data: &Value,
    site_id: &SiteId,
    fallback_login: &str,
) -> AppResult<LiveRoomDetail> {
    let user = data
        .get("user")
        .filter(|value| !value.is_null())
        .ok_or_else(|| {
            AppError::new("twitch_room_not_found", "未找到该 Twitch 频道").with_site("twitch")
        })?;
    let login = normalize_login(&first_non_empty([
        json_string(user.get("login")),
        fallback_login.to_string(),
    ]))?;
    let stream = user.get("stream").filter(|value| value.is_object());
    let status = stream.is_some();
    let title = stream
        .map(|stream| json_string(stream.get("title")))
        .filter(|title| !title.is_empty())
        .unwrap_or_else(|| format!("{} 的直播间", json_string(user.get("displayName"))));
    let cover = stream
        .map(|stream| json_string(stream.get("previewImageURL")))
        .filter(|cover| !cover.is_empty())
        .unwrap_or_else(|| json_string(user.get("profileImageURL")));
    let stream_id = stream
        .map(|stream| json_string(stream.get("id")))
        .unwrap_or_default();
    Ok(LiveRoomDetail {
        site_id: site_id.clone(),
        room_id: login.clone(),
        title,
        cover,
        user_name: first_non_empty([json_string(user.get("displayName")), login.clone()]),
        user_avatar: json_string(user.get("profileImageURL")),
        online: stream
            .map(|stream| json_i64(stream.get("viewersCount")))
            .unwrap_or(0),
        status,
        live_started_at: stream.and_then(|stream| parse_live_started_at(stream.get("createdAt"))),
        notice: json_string(user.get("description")),
        url: format!("https://www.twitch.tv/{login}"),
        raw: json!({
            "login": login,
            "broadcaster_id": json_string(user.get("id")),
            "stream_id": stream_id,
        }),
    })
}

/// The follow refresher asks Twitch for this intentionally narrow query: no
/// room profile, preview image, title, or playback-token data is needed to
/// decide whether a followed channel is currently live.
fn parse_room_live_status(data: &Value) -> AppResult<LiveRoomStatus> {
    let user = data
        .get("user")
        .filter(|value| !value.is_null())
        .ok_or_else(|| {
            AppError::new("twitch_room_not_found", "未找到该 Twitch 频道").with_site("twitch")
        })?;
    let stream = user.get("stream").filter(|value| value.is_object());
    Ok(LiveRoomStatus {
        status: stream.is_some(),
        live_started_at: stream.and_then(|stream| parse_live_started_at(stream.get("createdAt"))),
    })
}

fn usher_master_url(
    login: &str,
    signature: &str,
    token: &str,
    player_type: &str,
) -> AppResult<Url> {
    let mut url = Url::parse(&format!("{TWITCH_USHER_URL}/{login}.m3u8"))
        .map_err(|error| TwitchSite::parse_err(format!("Twitch HLS URL 无效: {error}")))?;
    url.query_pairs_mut()
        .append_pair("acmb", "e30=")
        .append_pair("allow_source", "true")
        .append_pair("allow_audio_only", "true")
        .append_pair("fast_bread", "true")
        .append_pair("player_backend", "mediaplayer")
        .append_pair("playlist_include_framerate", "true")
        .append_pair("reassignments_supported", "true")
        .append_pair("sig", signature)
        .append_pair("supported_codecs", "av1,h264")
        .append_pair("token", token)
        .append_pair("player_type", player_type);
    Ok(url)
}

fn parse_hls_variants(manifest: &str, master_url: &Url) -> Vec<TwitchVariant> {
    let mut media_names = HashMap::<String, String>::new();
    let mut pending = None::<HlsStreamInfo>;
    let mut variants = Vec::new();

    for raw_line in manifest.lines() {
        let line = raw_line.trim();
        if let Some(attributes) = line.strip_prefix("#EXT-X-MEDIA:") {
            if hls_attribute(attributes, "TYPE").as_deref() == Some("VIDEO")
                && let (Some(group_id), Some(name)) = (
                    hls_attribute(attributes, "GROUP-ID"),
                    hls_attribute(attributes, "NAME"),
                )
            {
                media_names.insert(group_id, name);
            }
            continue;
        }
        if let Some(attributes) = line.strip_prefix("#EXT-X-STREAM-INF:") {
            pending = Some(HlsStreamInfo {
                video_group: hls_attribute(attributes, "VIDEO"),
                resolution: hls_attribute(attributes, "RESOLUTION"),
                frame_rate: hls_attribute(attributes, "FRAME-RATE"),
                codecs: hls_attribute(attributes, "CODECS"),
                bandwidth: hls_attribute(attributes, "BANDWIDTH"),
            });
            continue;
        }
        if line.starts_with('#') || line.is_empty() {
            continue;
        }
        let Some(stream) = pending.take() else {
            continue;
        };
        let Ok(url) = master_url.join(line) else {
            continue;
        };
        if !matches!(url.scheme(), "http" | "https") {
            continue;
        }
        let label = stream
            .video_group
            .as_ref()
            .and_then(|group| media_names.get(group))
            .cloned()
            .or_else(|| stream.resolution.clone())
            .unwrap_or_else(|| "自动".into());
        let (width, height) = parse_hls_resolution(stream.resolution.as_deref());
        variants.push(TwitchVariant {
            selector: hls_variant_selector(
                stream.video_group.as_deref(),
                stream.resolution.as_deref(),
                stream.frame_rate.as_deref(),
                stream.codecs.as_deref(),
                stream.bandwidth.as_deref(),
                &url,
            ),
            is_source: is_source_variant(stream.video_group.as_deref(), &label),
            label,
            url: url.to_string(),
            width,
            height,
            frame_rate_milli: parse_hls_frame_rate_milli(stream.frame_rate.as_deref()),
            bandwidth: stream
                .bandwidth
                .as_deref()
                .and_then(|value| value.parse::<u64>().ok())
                .unwrap_or_default(),
        });
    }
    // The UI's default-quality preference treats index zero as the best
    // option. HLS master manifests are not ordered by the protocol, and
    // Twitch may change their order between token refreshes, so order by the
    // actual stream properties instead.
    variants.sort_by(|left, right| {
        right
            .is_source
            .cmp(&left.is_source)
            .then_with(|| right.height.cmp(&left.height))
            .then_with(|| right.width.cmp(&left.width))
            .then_with(|| right.frame_rate_milli.cmp(&left.frame_rate_milli))
            .then_with(|| right.bandwidth.cmp(&left.bandwidth))
            .then_with(|| left.label.cmp(&right.label))
            .then_with(|| left.selector.cmp(&right.selector))
    });
    variants
}

fn hls_variant_selector(
    video_group: Option<&str>,
    resolution: Option<&str>,
    frame_rate: Option<&str>,
    codecs: Option<&str>,
    bandwidth: Option<&str>,
    url: &Url,
) -> String {
    // Twitch's `VIDEO` rendition group is the stable identity of a quality
    // (for example `chunked`, `720p60` or `480p30`). It remains valid when a
    // new token produces a master playlist with a different item order.
    if let Some(group) = video_group.map(str::trim).filter(|group| !group.is_empty()) {
        return format!("video-group:{}", group.to_ascii_lowercase());
    }

    // `VIDEO` is normally present for Twitch. Keep a deterministic fallback
    // for an incomplete master playlist without falling back to its array
    // position. The URI path is only used when no stream metadata exists.
    let resolution = hls_selector_part(resolution);
    let frame_rate = hls_selector_part(frame_rate);
    let codecs = hls_selector_part(codecs);
    let bandwidth = hls_selector_part(bandwidth);
    if !resolution.is_empty()
        || !frame_rate.is_empty()
        || !codecs.is_empty()
        || !bandwidth.is_empty()
    {
        return format!(
            "stream:resolution={resolution}|fps={frame_rate}|codecs={codecs}|bandwidth={bandwidth}"
        );
    }
    format!("uri:{}", url.path())
}

fn hls_selector_part(value: Option<&str>) -> String {
    value.unwrap_or_default().trim().to_ascii_lowercase()
}

fn parse_hls_resolution(value: Option<&str>) -> (u32, u32) {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return (0, 0);
    };
    let Some((width, height)) = value.split_once('x').or_else(|| value.split_once('X')) else {
        return (0, 0);
    };
    (
        width.trim().parse::<u32>().unwrap_or_default(),
        height.trim().parse::<u32>().unwrap_or_default(),
    )
}

fn parse_hls_frame_rate_milli(value: Option<&str>) -> u32 {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return 0;
    };
    let (whole, fractional) = value.split_once('.').unwrap_or((value, ""));
    let Ok(whole) = whole.parse::<u32>() else {
        return 0;
    };
    let mut fractional_milli = 0_u32;
    let mut digits = 0_u32;
    for character in fractional.chars() {
        let Some(digit) = character.to_digit(10) else {
            return 0;
        };
        if digits < 3 {
            fractional_milli = fractional_milli.saturating_mul(10).saturating_add(digit);
            digits += 1;
        }
    }
    for _ in digits..3 {
        fractional_milli = fractional_milli.saturating_mul(10);
    }
    whole.saturating_mul(1_000).saturating_add(fractional_milli)
}

fn is_source_variant(video_group: Option<&str>, label: &str) -> bool {
    video_group.is_some_and(|group| group.eq_ignore_ascii_case("chunked"))
        || label.to_ascii_lowercase().contains("source")
}

fn find_hls_variant<'a>(
    variants: &'a [TwitchVariant],
    selector: &str,
) -> Option<&'a TwitchVariant> {
    variants.iter().find(|variant| variant.selector == selector)
}

fn find_closest_hls_variant<'a>(
    variants: &'a [TwitchVariant],
    recovery: &crate::models::live::TwitchAdRecovery,
) -> Option<&'a TwitchVariant> {
    if recovery.target_width == 0 || recovery.target_height == 0 {
        return variants.first();
    }
    let target_pixels = u64::from(recovery.target_width) * u64::from(recovery.target_height);
    variants.iter().min_by_key(|variant| {
        let pixels = u64::from(variant.width) * u64::from(variant.height);
        (
            pixels.abs_diff(target_pixels),
            variant
                .frame_rate_milli
                .abs_diff(recovery.target_frame_rate_milli),
        )
    })
}

fn hls_attribute(attributes: &str, key: &str) -> Option<String> {
    let mut quoted = false;
    let mut start = 0;
    for (index, character) in attributes.char_indices() {
        match character {
            '"' => quoted = !quoted,
            ',' if !quoted => {
                if let Some(value) = hls_attribute_piece(&attributes[start..index], key) {
                    return Some(value);
                }
                start = index + 1;
            }
            _ => {}
        }
    }
    hls_attribute_piece(&attributes[start..], key)
}

fn hls_attribute_piece(piece: &str, key: &str) -> Option<String> {
    let (candidate, value) = piece.trim().split_once('=')?;
    if candidate.trim() != key {
        return None;
    }
    let value = value.trim();
    Some(
        value
            .strip_prefix('"')
            .and_then(|value| value.strip_suffix('"'))
            .unwrap_or(value)
            .to_string(),
    )
}

fn graphql_error(value: &Value) -> Option<AppError> {
    let errors = value.get("errors").and_then(Value::as_array);
    let challenge = value
        .pointer("/extensions/challenge/type")
        .and_then(Value::as_str)
        .or_else(|| {
            errors.into_iter().flatten().find_map(|error| {
                (error.pointer("/extensions/code").and_then(Value::as_str)
                    == Some("IntegrityCheckFailed")
                    || error
                        .pointer("/extensions/challenge/type")
                        .and_then(Value::as_str)
                        == Some("integrity"))
                .then_some("integrity")
            })
        });
    if challenge == Some("integrity") {
        return Some(
            AppError::new(
                "twitch_integrity_challenge",
                "Twitch 拒绝了受浏览器完整性保护的 GraphQL 请求，请稍后重试",
            )
            .with_site("twitch")
            .retryable(),
        );
    }
    let first = errors?.first()?;
    let message = first
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("unknown Twitch GraphQL error");
    Some(TwitchSite::err(format!("Twitch GraphQL 错误: {message}")))
}

fn json_string(value: Option<&Value>) -> String {
    value
        .and_then(|value| match value {
            Value::String(value) => Some(value.clone()),
            Value::Number(value) => Some(value.to_string()),
            Value::Bool(value) => Some(value.to_string()),
            _ => None,
        })
        .unwrap_or_default()
}

fn json_i64(value: Option<&Value>) -> i64 {
    value
        .and_then(|value| {
            value
                .as_i64()
                .or_else(|| value.as_u64().and_then(|value| i64::try_from(value).ok()))
                .or_else(|| value.as_str().and_then(|value| value.parse::<i64>().ok()))
        })
        .unwrap_or(0)
}

fn non_empty(value: String) -> Option<String> {
    (!value.trim().is_empty()).then_some(value)
}

fn first_non_empty<const N: usize>(values: [String; N]) -> String {
    values
        .into_iter()
        .find(|value| !value.trim().is_empty())
        .unwrap_or_default()
}

fn preview(value: &str) -> String {
    value.chars().take(180).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Reads one quoted `#EXT-X-DATERANGE` attribute out of a playlist. Used by
    /// the live diagnostics to name what made a playlist unclean without dumping
    /// the whole tag, which carries a multi-kilobyte ad token.
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

    #[test]
    fn extracts_only_valid_public_client_id_from_bootstrap() {
        let html = r#"<script>var clientId="kimne78kx3ncx6brgo4mv6wki5h1ko"</script>"#;
        assert_eq!(
            parse_public_client_id(html).as_deref(),
            Some("kimne78kx3ncx6brgo4mv6wki5h1ko")
        );
        assert!(parse_public_client_id(r#"clientId="<script>"#).is_none());
    }

    #[test]
    fn normalizes_twitch_login_from_channel_url() {
        assert_eq!(
            normalize_login("https://www.twitch.tv/Caedrel/videos").unwrap(),
            "caedrel"
        );
        assert!(normalize_login("caedrel?oops").is_ok());
        assert!(normalize_login("not-a-valid-login").is_err());
    }

    #[test]
    fn recognizes_shared_all_categories_sentinel() {
        assert!(is_all_categories_entry("0"));
        assert!(is_all_categories_entry(" 0 "));
        assert!(!is_all_categories_entry("509658"));
    }

    #[test]
    fn stream_edges_map_to_live_room_items() {
        let data = json!({
            "streams": {
                "edges": [{
                    "node": {
                        "title": "A live title",
                        "viewersCount": 1234,
                        "previewImageURL": "https://img.example/cover.jpg",
                        "broadcaster": { "login": "streamer", "displayName": "Streamer" }
                    }
                }]
            }
        });
        let items = parse_stream_edges(&data, "/streams/edges", &SiteId::Bilibili);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].room_id, "streamer");
        assert_eq!(items[0].user_name, "Streamer");
        assert_eq!(items[0].online, 1234);
    }

    #[test]
    fn shard_windows_tile_the_language_list_without_gaps_or_overlap() {
        assert_eq!(shard_window_start(1), Some(0));
        // Page 1 must stay the unfiltered global listing so the first screen is
        // unchanged from what cursor pagination used to show.
        assert_eq!(LANGUAGE_SHARDS[0], "");
        assert_eq!(shard_window_start(2), Some(SHARD_WINDOW));
        assert_eq!(shard_window_start(3), Some(SHARD_WINDOW * 2));

        // Consecutive windows are adjacent: no shard is skipped and none is
        // fetched twice, which is what keeps the merged listing gap-free.
        let mut expected = 0;
        while let Some(start) = shard_window_start((expected / SHARD_WINDOW) as u32 + 1) {
            assert_eq!(start, expected);
            expected += SHARD_WINDOW;
        }
        assert!(expected >= LANGUAGE_SHARDS.len());
    }

    #[test]
    fn shard_windows_end_with_the_language_list() {
        let last_page = LANGUAGE_SHARDS.len().div_ceil(SHARD_WINDOW) as u32;
        assert!(shard_window_start(last_page).is_some());
        // One page past the tail reports exhaustion instead of wrapping around
        // or emitting an out-of-range slice.
        assert_eq!(shard_window_start(last_page + 1), None);
        assert_eq!(shard_window_start(u32::MAX), None);

        // A zero page number is treated as page 1 rather than underflowing.
        assert_eq!(shard_window_start(0), Some(0));
    }

    #[test]
    fn language_filter_distinguishes_all_languages_from_one() {
        // An empty array is Twitch's "no language restriction"; a code narrows
        // the shard. Sending `[""]` instead would match no broadcaster at all.
        assert_eq!(language_filter(""), json!([]));
        assert_eq!(language_filter("ZH"), json!(["ZH"]));
    }

    #[test]
    fn shard_feeds_request_the_capped_page_size_and_their_own_language() {
        let recommend = RecommendFeed.variables("JA");
        assert_eq!(recommend["limit"], PAGE_SIZE);
        assert_eq!(recommend["languages"], json!(["JA"]));
        assert_eq!(RecommendFeed.edges_path(), "/streams/edges");

        let category = CategoryFeed { slug: "factorio" }.variables("");
        assert_eq!(category["slug"], "factorio");
        assert_eq!(category["limit"], PAGE_SIZE);
        assert_eq!(category["languages"], json!([]));
        assert_eq!(
            CategoryFeed { slug: "factorio" }.edges_path(),
            "/game/streams/edges"
        );
    }

    #[test]
    fn search_skips_offline_channels() {
        let data = json!({
            "searchFor": {
                "channels": {
                    "items": [
                        { "login": "offline", "displayName": "Offline", "stream": null },
                        {
                            "login": "online",
                            "displayName": "Online",
                            "stream": {
                                "title": "Live",
                                "viewersCount": 7,
                                "previewImageURL": "https://img.example/live.jpg"
                            }
                        }
                    ]
                }
            }
        });
        let items = parse_search_items(&data, &SiteId::Bilibili);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].room_id, "online");
    }

    #[test]
    fn search_parses_official_edge_items() {
        let data = json!({
            "searchFor": {
                "channels": {
                    "cursor": "MjU=",
                    "edges": [{
                        "item": {
                            "login": "official",
                            "displayName": "Official",
                            "stream": {
                                "title": "Live",
                                "viewersCount": 12,
                                "previewImageURL": "https://img.example/official.jpg"
                            }
                        }
                    }]
                }
            }
        });
        let items = parse_search_items(&data, &SiteId::Twitch);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].room_id, "official");
        assert_eq!(items[0].online, 12);
    }

    #[test]
    fn parses_minimal_twitch_live_status() {
        let status = parse_room_live_status(&json!({
            "user": {
                "stream": {
                    "createdAt": "2024-07-03T09:46:40Z",
                    "playback_token_that_must_not_be_needed": "ignored"
                }
            }
        }))
        .expect("status");

        assert!(status.status);
        assert_eq!(status.live_started_at, Some(1_720_000_000_000));
    }

    #[test]
    fn parses_offline_twitch_live_status() {
        let status =
            parse_room_live_status(&json!({ "user": { "stream": null } })).expect("status");

        assert!(!status.status);
        assert_eq!(status.live_started_at, None);
    }

    #[test]
    fn parses_hls_media_names_and_relative_variants() {
        let master = Url::parse("https://usher.ttvnw.net/api/channel/hls/demo.m3u8?sig=x").unwrap();
        let manifest = concat!(
            "#EXTM3U\n",
            "#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID=\"chunked\",NAME=\"1080p60 (source)\"\n",
            "#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,VIDEO=\"chunked\"\n",
            "source.m3u8\n",
            "#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID=\"720p60\",NAME=\"720p60\"\n",
            "#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,VIDEO=\"720p60\"\n",
            "https://playlist.ttvnw.net/720.m3u8\n"
        );
        let variants = parse_hls_variants(manifest, &master);
        assert_eq!(variants.len(), 2);
        assert_eq!(variants[0].label, "1080p60 (source)");
        assert_eq!(
            variants[0].url,
            "https://usher.ttvnw.net/api/channel/hls/source.m3u8"
        );
        assert_eq!(variants[1].label, "720p60");
    }

    #[test]
    fn requests_av1_and_h264_twitch_variants_for_webview_playback() {
        let url = usher_master_url("demo", "signature", "token", "site").expect("master URL");
        let supported_codecs = url
            .query_pairs()
            .find_map(|(key, value)| (key == "supported_codecs").then(|| value.into_owned()));

        assert_eq!(supported_codecs.as_deref(), Some("av1,h264"));
    }

    #[test]
    fn keeps_quality_mapping_when_master_playlist_reorders_variants() {
        let master = Url::parse("https://usher.ttvnw.net/api/channel/hls/demo.m3u8?sig=x").unwrap();
        let initial_manifest = concat!(
            "#EXTM3U\n",
            "#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID=\"chunked\",NAME=\"1080p60 (source)\"\n",
            "#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,FRAME-RATE=60.000,VIDEO=\"chunked\"\n",
            "epoch-one-source.m3u8\n",
            "#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID=\"720p60\",NAME=\"720p60\"\n",
            "#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,FRAME-RATE=60.000,VIDEO=\"720p60\"\n",
            "epoch-one-720.m3u8\n",
            "#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID=\"480p30\",NAME=\"480p30\"\n",
            "#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=854x480,FRAME-RATE=30.000,VIDEO=\"480p30\"\n",
            "epoch-one-480.m3u8\n"
        );
        let advertised = parse_hls_variants(initial_manifest, &master);
        assert_eq!(
            advertised
                .iter()
                .map(|variant| variant.label.as_str())
                .collect::<Vec<_>>(),
            ["1080p60 (source)", "720p60", "480p30"]
        );
        let selected = advertised
            .iter()
            .find(|variant| variant.label == "720p60")
            .expect("720p60 variant");
        assert_eq!(selected.selector, "video-group:720p60");

        // A renewed playback token can put these exact same qualities in a
        // different order and give their child playlists different URLs.
        let refreshed_manifest = concat!(
            "#EXTM3U\n",
            "#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID=\"480p30\",NAME=\"480p30\"\n",
            "#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=854x480,FRAME-RATE=30.000,VIDEO=\"480p30\"\n",
            "epoch-two-480.m3u8\n",
            "#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID=\"chunked\",NAME=\"1080p60 (source)\"\n",
            "#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,FRAME-RATE=60.000,VIDEO=\"chunked\"\n",
            "epoch-two-source.m3u8\n",
            "#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID=\"720p60\",NAME=\"720p60\"\n",
            "#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,FRAME-RATE=60.000,VIDEO=\"720p60\"\n",
            "epoch-two-720.m3u8\n"
        );
        let refreshed = parse_hls_variants(refreshed_manifest, &master);
        let resolved = find_hls_variant(&refreshed, &selected.selector)
            .expect("refreshed 720p60 variant by stable selector");
        assert_eq!(resolved.label, "720p60");
        assert_eq!(
            resolved.url,
            "https://usher.ttvnw.net/api/channel/hls/epoch-two-720.m3u8"
        );
    }

    #[test]
    fn chooses_closest_quality_when_a_twitch_fallback_has_fewer_variants() {
        let master = Url::parse("https://usher.ttvnw.net/api/channel/hls/demo.m3u8").unwrap();
        let variants = parse_hls_variants(
            concat!(
                "#EXTM3U\n",
                "#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,FRAME-RATE=30.000,VIDEO=\"360p30\"\n",
                "360.m3u8\n",
                "#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=284x160,FRAME-RATE=30.000,VIDEO=\"160p30\"\n",
                "160.m3u8\n"
            ),
            &master,
        );
        let recovery = crate::models::live::TwitchAdRecovery {
            login: "demo".into(),
            selector: "video-group:chunked".into(),
            target_width: 1920,
            target_height: 1080,
            target_frame_rate_milli: 60_000,
        };

        let closest = find_closest_hls_variant(&variants, &recovery).unwrap();
        assert_eq!(closest.selector, "video-group:360p30");
    }

    #[test]
    fn recognizes_integrity_challenge_without_bypass() {
        let value = json!({
            "errors": [{
                "message": "failed integrity check",
                "extensions": { "code": "IntegrityCheckFailed" }
            }],
            "extensions": { "challenge": { "type": "integrity" } }
        });
        let error = graphql_error(&value).expect("must map challenge");
        assert_eq!(error.code, "twitch_integrity_challenge");
        assert!(error.retryable);
    }

    #[test]
    fn recognizes_integrity_challenge_after_another_graphql_error() {
        let value = json!({
            "errors": [
                { "message": "partial warning" },
                {
                    "message": "failed integrity check",
                    "extensions": { "code": "IntegrityCheckFailed" }
                }
            ],
            "data": { "streams": null }
        });
        let error = graphql_error(&value).expect("must map challenge");
        assert_eq!(error.code, "twitch_integrity_challenge");
        assert!(error.retryable);
    }

    #[tokio::test]
    #[ignore = "live Twitch persisted browse contracts; requires external network"]
    async fn live_persisted_browse_contracts_smoke() {
        let site = TwitchSite::new(reqwest::Client::new());
        let page = site.get_recommend_rooms(1).await.expect("recommend page");
        assert!(!page.items.is_empty(), "Twitch returned no live rooms");
        assert!(page.has_more, "official browse connection lost its cursor");

        let categories = site.get_categories().await.expect("categories");
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

        let search = site.search_rooms("music", 1).await.expect("search page");
        assert!(
            search.has_more,
            "official search connection lost its cursor"
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
        // Judged with the proxy's own detector: every break measured on this
        // channel carried no textual marker at all, so a text-only check here
        // would report a stitched playlist as clean.
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
                // Attribute the verdict instead of just reporting it: `clean=false`
                // has to be traceable to a real stitched ad rather than to a
                // detector quirk. Only the identifying attributes are printed --
                // the full DATERANGE carries a multi-kilobyte ad token.
                let roll_type = twitch_daterange_attribute(&body, "X-TV-TWITCH-AD-ROLL-TYPE");
                let source = twitch_daterange_attribute(&body, "X-TV-TWITCH-STREAM-SOURCE");
                eprintln!(
                    "  {player_type} stitched-ad evidence: roll_type={} stream_source={}",
                    roll_type.as_deref().unwrap_or("-"),
                    source.as_deref().unwrap_or("-"),
                );
            }
            // The quality a profile can offer is the other half of the picture:
            // `autoplay` is a profile observed to stay clean through a break, but
            // Twitch caps it, so a "clean" verdict alone would hide what it costs.
            // Read from the *variant list*, because the URL above is already
            // resolved to a single media playlist and so never carries
            // `#EXT-X-STREAM-INF` itself.
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
        // Not asserted: when the channel is not in a commercial every profile is
        // clean, and during one the honest outcome may be that only the capped
        // `autoplay` survives. Both are findings to read, not failures.
        eprintln!(
            "Kai Cenat primary clean={primary_clean} clean fallback profiles: {clean_profiles:?}"
        );
    }
}
