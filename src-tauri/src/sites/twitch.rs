//! Twitch 公开 Web 直播站点客户端。
//!
//! Twitch 有文档记载的 Helix 接口需要应用级 OAuth 凭据，桌面客户端不得内嵌。
//! 本模块改为使用 `www.twitch.tv` 向匿名访客暴露的同一批公开 GraphQL 接口和
//! 播放引导数据。公开 Web 客户端 id 在运行时从引导文档中发现，
//! 既不硬编码也不持久化。
//!
//! 浏览按*语言分片*分页，而不是按 Relay 游标。除非请求来自通过了其 JS 完整性
//! 挑战的浏览器上下文，否则 Twitch 对任何 `after:` 游标都回答
//! `IntegrityCheckFailed`；而单纯的 `broadcasterLanguages` 过滤只需要公开的
//! 客户端 id。因此遍历语言列表即可达到相同深度：
//! 无需 token、无需隐藏 WebView，移动端行为也一致。

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

/// 分页轴：一个分片就是一个 `broadcasterLanguages` 过滤值，
/// 空字符串表示"不过滤"，即过去唯一可达的全局热门列表。
///
/// `first` 服务端上限为 30，因此单个不过滤的请求永远看不到观看数前 30 之外的
/// 频道。按语言分片才让长尾可达：相对全局信息流测量，下面 27 个分片能带来
/// 735 个去重后的直播频道，而不用它们只有 30 个。
///
/// 按观众规模排序，让前面的分片保持最有内容；
/// 并限定在 Twitch 自家目录过滤提供的语言内 —— 未知的代码不是错误，
/// 只会返回空结果并浪费一次请求。
const LANGUAGE_SHARDS: &[&str] = &[
    "", "EN", "ZH", "JA", "KO", "ES", "PT", "DE", "FR", "RU", "IT", "PL", "TR", "TH", "VI", "AR",
    "NL", "SV", "CS", "HU", "FI", "DA", "NO", "ID", "MS", "EL", "RO",
];

/// 合并进一个列表页的分片数。取三既能让突发请求保持较小规模又能填满一页：
/// 分片之间有重叠（一个频道可能同时出现在全局与其语言分片中），
/// 三个 30 条的分片大约落在 70-80 个去重房间。
const SHARD_WINDOW: usize = 3;

/// 标签聚合视图一页并发拉取的分区数。与语言分片同样取三：突发请求量相当，
/// 三个分区约落在 70-90 个去重房间，够填满一页。
const DIRECTORY_SHARD_WINDOW: usize = 3;

/// 一次取回的分类标签数。上游 `searchCategoryTags` 实测返回 41 个，
/// 取 100 留出余量，同时避免上游哪天放开时一次拉回过多。
const CATEGORY_TAG_LIMIT: u32 = 100;

/// 每个标签下取回的分区数。`games(first:)` 服务端上限为 100，且游标翻页过不了
/// 完整性校验，所以这个值就是单个标签的可见深度，同时决定两件事：
///
/// - 分类树的 IPC 体积。取满 100 时 41 个标签共 2800 余项、约 500 KiB，是另外
///   三个平台整棵树（B站 454 项 / 斗鱼 502 项 / 虎牙 356 项，40-65 KiB）的近十倍；
///   取 30 落在 1000 项上下、约 185 KiB，覆盖 638 个去重游戏，仍比任何一个平台的
///   分区总数多。
/// - 「全部X」聚合视图的可翻深度：30 个分区按每页 3 个分片即 10 页，
///   与语言分片的 9 页（27 个分片）同量级。
const DIRECTORY_PAGE_SIZE: u32 = 30;

/// Twitch 按播放 token 在服务端决定广告拼接，而签发 token 时使用的 `playerType`
/// 是决策的一部分。`site` 保持首选，因为它既干净又是全画质：
/// 在 `kaicenat` 上实测，它携带频道的完整清晰度阶梯
/// （`1080p60` 原画到 `audio_only`，共 7 档），
/// 且所有样本中都没有出现拼接广告。
pub(crate) const TWITCH_PRIMARY_PLAYER_TYPE: (&str, &str) = ("site", "web");

/// 拼接广告播放列表的恢复顺序，按实测结果而非猜测排列。对 `kaicenat` 连续六次
/// 采样中，每个 `playerType` 的结论完全稳定，因此这里是有序列表，
/// 而不是随机尝试的集合：
///
/// | profile             | 拼接广告     | 清晰度阶梯                 |
/// |---------------------|-------------|----------------------------|
/// | `popout`            | 无          | 7 档，最高 `1080p60` 原画  |
/// | `autoplay`          | 无          | 3 档，封顶 `360p`          |
/// | `embed`             | 有（preroll） | 7 档                     |
/// | `picture-by-picture`| 有（preroll） | 3 档，封顶 `360p`         |
///
/// 所以先试 `popout`：它既干净又保留完整阶梯。其次是 `autoplay` —— 同样干净，
/// 但被 Twitch 封顶，用画质换取无广告画面。`embed` 和 `picture-by-picture`
/// 放在最后，正是因为观测到它们带广告；仅当上面那些 profile 才是拼接对象时
/// 才作为最后尝试保留 —— Twitch 按 profile 的决策并不保证一成不变。
///
/// 注意在 `embed` / `picture-by-picture` 上看到的广告都是 `ROLL-TYPE=PREROLL`，
/// 即附着在新签发的播放会话上，而不是插播的商业广告。某个 profile 在此表现
/// 干净并不能证明它能挺过真实的插播；它只证明 Twitch 并不一视同仁地对待
/// 所有播放器类型。
pub(crate) const TWITCH_AD_FALLBACK_PROFILES: [(&str, &str); 4] = [
    ("popout", "web"),
    ("autoplay", "android"),
    ("embed", "web"),
    ("picture-by-picture", "web"),
];

/// 为 Web 引导与 HLS CDN 保持稳定的类浏览器 UA。它不标识账号，
/// 也不绑定到脆弱的浏览器版本号。
pub const DEFAULT_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/// 当前 Twitch 公开 Web 的 GraphQL 客户端 id 内嵌在 HTML 引导文档中。
/// 它可能轮换，因此只保存在进程内存里。
#[derive(Clone)]
struct PublicWebContext {
    client_id: String,
    fetched_at: Instant,
}

static PUBLIC_WEB_CONTEXT: OnceLock<Mutex<Option<PublicWebContext>>> = OnceLock::new();

/// Twitch 的 Web 客户端在每个 GraphQL 请求中都发送设备标识符。省略它会把调用方
/// 标记为未识别客户端，这是决定播放 token 是否被服务端拼接广告的信号之一。
/// 它是每个进程随机生成的取值：绝不持久化、不从机器信息派生、不标识任何账号。
static GQL_DEVICE_ID: OnceLock<String> = OnceLock::new();

fn gql_device_id() -> &'static str {
    GQL_DEVICE_ID.get_or_init(|| {
        // Twitch 自己的标识符是 32 位小写字母数字。
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

/// 已注册的 Twitch 直播站点后端。
pub struct TwitchSite {
    client: Client,
    site_id: SiteId,
}

/// `page` 窗口的第一个分片下标；分片列表耗尽时返回 `None`。
/// 纯算术运算，因此可以直接请求某一页，
/// 而不必先走完它之前的页面。
fn shard_window_start(page: u32) -> Option<usize> {
    let start = (page.max(1) as usize - 1).checked_mul(SHARD_WINDOW)?;
    (start < LANGUAGE_SHARDS.len()).then_some(start)
}

/// 标签聚合视图里第 `page` 页对应的分区窗口起点。分区数由上游决定，
/// 因此上界不是常量，走完就返回 `None` 让翻页自然终止。
fn directory_window_start(page: u32, directory_count: usize) -> Option<usize> {
    let start = (page.max(1) as usize - 1).checked_mul(DIRECTORY_SHARD_WINDOW)?;
    (start < directory_count).then_some(start)
}

/// 按语言分片的信息流：每种信息流类型（推荐、分类）都知道如何向 Twitch 请求
/// 一个语言分片，以及其边界在响应中的位置。翻页遍历的是分片而不是 Relay 游标，
/// 每一页相互独立，
/// 不需要任何进程内的游标状态。
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

/// `broadcasterLanguages: []` 表示"所有语言"，第 1 页使用它；
/// 具体的语言代码把分片限定到该语言。
fn language_filter(language: &str) -> Value {
    if language.is_empty() {
        json!([])
    } else {
        json!([language])
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TwitchVariant {
    /// 来自 HLS master playlist 的语义 ID，而不是变体在该列表中的位置。
    /// 每次签发短时效播放 token 时，Twitch 都可能重排列表。
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

    /// 一次匿名 Web 访问式的 GraphQL POST：
    /// 请求头与 text/plain 内容类型都对齐 Twitch 自己的引导请求。
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

    /// 抓取属于 `page` 的各语言分片，并把它们合并成一个列表页。
    ///
    /// Twitch 会拒绝所有没有真实浏览器完整性上下文支撑的 Relay `after:` 游标，
    /// 这正是过去第 2 页只能靠隐藏 WebView 访问、移动端完全无法访问的原因。
    /// 分片请求不携带游标，公开的 `Client-ID` 就够了，
    /// 且同样的深度在每个平台都可达。
    ///
    /// 页码到分片的映射是固定的算术，因此请求之间不需要保存游标状态。稀疏分类可能
    /// 穿插空分片（在 `factorio` 上实测：26 种语言中 20 种返回空），所以空页不代表
    /// 信息流耗尽：在语言列表本身结束之前 `has_more` 保持 true，
    /// 允许前端继续向后扫描仍含房间的分片。
    async fn shard_page(&self, feed: impl ShardFeed, page: u32) -> AppResult<RoomListPage> {
        let page = page.max(1);
        let Some(start) = shard_window_start(page) else {
            return Ok(empty_page());
        };
        let window_end = (start + SHARD_WINDOW).min(LANGUAGE_SHARDS.len());

        // 在扇出之前先预热共享上下文。否则冷启动的一页会并发三个引导 GET，
        // 因为每个分片都需要同一个 Client-ID。
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

    /// 并发请求一个分片区间，并按分片顺序追加新房间。区间宽度至多为
    /// `SHARD_WINDOW`，使突发请求量与 Twitch 自己的 Web 客户端
    /// 发出单次目录浏览时相当。
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

    /// 取一级分类：Twitch 目录自身的游戏类型标签（FPS、RPG、IRL……）。
    ///
    /// 这些标签是 Twitch 网页端「浏览」页左侧筛选器的数据源，也是 `games(tags:)`
    /// 唯一接受的取值：只认标签 UUID，传 `"FPS"` 这样的名字会得到空结果。
    async fn category_tags(&self) -> AppResult<Vec<TwitchCategoryTag>> {
        let data = self
            .graphql(
                "RLiveTwitchCategoryTags",
                r#"
                query RLiveTwitchCategoryTags($query: String!, $limit: Int!) {
                  searchCategoryTags(userQuery: $query, limit: $limit) {
                    id
                    tagName
                    isLanguageTag
                  }
                }
                "#,
                json!({ "query": "", "limit": CATEGORY_TAG_LIMIT }),
            )
            .await?;
        let tags: Vec<TwitchCategoryTag> = data
            .get("searchCategoryTags")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(parse_category_tag)
            .collect();
        if tags.is_empty() {
            return Err(Self::parse_err("Twitch 未返回可用分类标签"));
        }
        Ok(tags)
    }

    /// 取某个标签下的二级分区（具体游戏）。
    ///
    /// `first` 服务端上限 100，且 `after:` 游标同样过不了完整性校验（实测 `games`、
    /// `streams`、`game.streams` 三个连接，连真实 `Client-Integrity` 令牌也一样被拒），
    /// 所以这里只取第一页 100 条，不做游标翻页。实测 41 个标签合计约 1600 个
    /// 去重分区，远多于过去单层的 30 个。
    async fn tag_directories(&self, tag_id: &str) -> AppResult<Vec<LiveSubCategory>> {
        let data = self
            .graphql(
                "RLiveTwitchTagDirectories",
                r#"
                query RLiveTwitchTagDirectories($first: Int!, $tags: [String!]) {
                  games(first: $first, tags: $tags) {
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
                json!({ "first": DIRECTORY_PAGE_SIZE, "tags": [tag_id] }),
            )
            .await?;
        Ok(parse_tag_directories(&data, tag_id))
    }

    async fn recommend_page(&self, page: u32) -> AppResult<RoomListPage> {
        self.shard_page(RecommendFeed, page).await
    }

    async fn category_page(&self, category_id: &str, page: u32) -> AppResult<RoomListPage> {
        let slug = normalize_category_slug(category_id)?;
        self.shard_page(CategoryFeed { slug: &slug }, page).await
    }

    /// 「全部X」磁贴的房间列表：把该游戏类型标签下的分区横向聚合。
    ///
    /// 不能像虎牙那样直接拿父分区 id 请求房间：`streams` 的两种标签入参
    /// （顶层 `tags:` 与 `options.tags`）实测都是空转 —— 传 FPS 标签、传全 f 的
    /// 伪造 UUID、和完全不传，返回的频道列表一模一样，结果里混着 Just Chatting
    /// 和 IRL。标签只在 `games(tags:)`（分区目录）上真正生效。
    ///
    /// 因此这里换一条分片轴：先取标签下的分区，再按 `DIRECTORY_SHARD_WINDOW`
    /// 个分区为一页并发拉房间。翻页仍是纯算术（第 N 页对应分区
    /// `w(N-1)..wN`），不需要游标，也不需要跨请求状态。分区已按热度排序，
    /// 所以前几页仍是该类型下最热的内容。
    async fn tag_page(&self, tag_id: &str, page: u32) -> AppResult<RoomListPage> {
        let tag_id = normalize_tag_id(tag_id).ok_or_else(|| {
            AppError::new("twitch_invalid_category_id", "无效的 Twitch 分类标识")
                .with_site("twitch")
        })?;
        let page = page.max(1);
        let directories = self.tag_directories(&tag_id).await?;
        let Some(start) = directory_window_start(page, directories.len()) else {
            return Ok(empty_page());
        };
        let window = &directories[start..(start + DIRECTORY_SHARD_WINDOW).min(directories.len())];

        let requests = window.iter().map(|directory| {
            let feed = CategoryFeed {
                slug: &directory.id,
            };
            // 聚合视图不再按语言收窄：分片轴已经是分区，再叠一层语言只会让
            // 每个分区都只剩它的一个语言切片。
            self.graphql(feed.operation_name(), feed.query(), feed.variables(""))
        });
        let edges_path = CategoryFeed { slug: "" }.edges_path();
        let mut items = Vec::new();
        let mut seen = HashSet::new();
        for data in future::try_join_all(requests).await? {
            for item in parse_stream_edges(&data, edges_path, &self.site_id) {
                if seen.insert(item.room_id.to_ascii_lowercase()) {
                    items.push(item);
                }
            }
        }
        Ok(RoomListPage {
            has_more: directory_window_start(page + 1, directories.len()).is_some(),
            items,
        })
    }

    async fn search_page(&self, keyword: &str, page: u32) -> AppResult<RoomListPage> {
        let page = page.max(1);
        // 搜索使用基于偏移的游标（base64 编码的整数），不需要完整性 token。
        // 游标直接用算术计算。
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
                // 这是 Twitch 公开 HTML 引导中下发的非持久化 query。它避免依赖会轮换的持久化
                // query hash，且只返回短时效的公开播放 token。
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
        // 先预热共享上下文，否则下面的扇出会让每个标签各自去引导一次 Client-ID。
        self.public_web_context().await?;
        let tags = self.category_tags().await?;
        let requests = tags.iter().map(|tag| self.tag_directories(&tag.id));
        let mut categories = Vec::new();
        for (tag, children) in tags.iter().zip(future::try_join_all(requests).await?) {
            if children.is_empty() {
                continue;
            }
            categories.push(LiveCategory {
                id: tag.id.clone(),
                name: tag.name.clone(),
                children,
            });
        }
        if categories.is_empty() {
            return Err(Self::parse_err("Twitch 未返回可用直播分类"));
        }
        Ok(categories)
    }

    async fn get_recommend_rooms(&self, page: u32) -> AppResult<RoomListPage> {
        self.recommend_page(page).await
    }

    async fn get_category_rooms(
        &self,
        category: &LiveSubCategory,
        page: u32,
    ) -> AppResult<RoomListPage> {
        // 分类页给每个父分区合成一个 id 为 "0" 的「全部X」磁贴，它不是真实分区。
        // 虎牙的父分区聚合 gid 能直接拉房间，Twitch 没有等价物，因此按标签下的
        // 分区分片聚合，详见 `tag_page`。
        if is_all_categories_entry(&category.id) {
            return self.tag_page(&category.parent_id, page).await;
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
                // 签名 URL 刻意不保留在这个负载中。在真正播放前立即重新抓取，
                // 避免过期的 Twitch token 存留在前端查询缓存里。
                // 同时保留语义化的 HLS 选择器，
                // 即使 Twitch 中途改变清单顺序也能找到同一画质。
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
    // 当前公开的 Twitch 引导使用 `clientId="..."` 赋值形式。第二个标记用于处理等价
    // 的对象字面量形式，而不会把页面里的任意取值当作客户端 id。
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

/// Twitch 目录的游戏类型标签，充当 rLive 分类树的一级分区。
#[derive(Debug, Clone, PartialEq, Eq)]
struct TwitchCategoryTag {
    /// 标签 UUID。`games(tags:)` 只认这个值，不认标签名。
    id: String,
    name: String,
}

/// 解析一个分类标签。语言标签（`isLanguageTag`）会和 rLive 既有的语言分片翻页
/// 轴重叠，混进分类树只会让用户在两个地方筛同一件事，因此丢掉。
fn parse_category_tag(value: &Value) -> Option<TwitchCategoryTag> {
    if value
        .get("isLanguageTag")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return None;
    }
    let id = normalize_tag_id(&json_string(value.get("id")))?;
    let name = json_string(value.get("tagName"));
    if name.is_empty() {
        return None;
    }
    Some(TwitchCategoryTag { id, name })
}

/// 解析一个标签下的分区列表。子分区 id 沿用 `slug`（`game(slug:)` 与语言分片
/// 翻页都用它），`parent_id` 存标签 UUID。
fn parse_tag_directories(data: &Value, tag_id: &str) -> Vec<LiveSubCategory> {
    data.pointer("/games/edges")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|edge| edge.get("node"))
        .filter_map(|node| {
            let id = normalize_category_slug(&json_string(node.get("slug"))).ok()?;
            let name = first_non_empty([
                json_string(node.get("displayName")),
                json_string(node.get("name")),
            ]);
            if name.is_empty() {
                return None;
            }
            Some(LiveSubCategory {
                id,
                name,
                parent_id: tag_id.to_string(),
                pic: non_empty(json_string(node.get("boxArtURL"))),
            })
        })
        .collect()
}

/// 校验标签 UUID。它会作为 `parent_id` 回到 `tags:` 查询变量里，
/// 因此只接受 UUID 的字面形状，不让任意字符串原样回流到上游。
fn normalize_tag_id(value: &str) -> Option<String> {
    let value = value.trim();
    if value.len() != 36 {
        return None;
    }
    let shaped = value.bytes().enumerate().all(|(index, byte)| {
        if matches!(index, 8 | 13 | 18 | 23) {
            byte == b'-'
        } else {
            byte.is_ascii_hexdigit()
        }
    });
    shaped.then(|| value.to_ascii_lowercase())
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

/// 共享的分类页面为合成"全部"磁贴保留了 `0`。Twitch 的游戏 id 是正数字字符串，
/// 因此这个哨兵值绝不会发送给 Twitch 的 `game(id:)` GraphQL 字段。
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
        live_status: None,
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
            let room_id = normalize_login(&json_string(user.get("login"))).ok()?;
            // 搜索会同时返回在播和未开播的频道，`stream` 只在开播时是对象。
            // 未开播的频道照样收下并用 `live_status` 标出来，让调用方决定怎么排。
            let stream = user.get("stream").filter(|stream| stream.is_object());
            let user_name = first_non_empty([
                json_string(user.get("displayName")),
                json_string(user.get("login")),
            ]);
            Some(LiveRoomItem {
                site_id: site_id.clone(),
                room_id,
                // 未开播的频道没有直播标题，留空由展示层退回频道名。
                title: stream.map_or_else(String::new, |stream| json_string(stream.get("title"))),
                cover: first_non_empty([
                    stream.map_or_else(String::new, |stream| {
                        json_string(stream.get("previewImageURL"))
                    }),
                    json_string(user.get("profileImageURL")),
                ]),
                user_name,
                // 未开播没有观看人数，退回粉丝数只会和在播人数混成一个量纲，
                // 因此留 0 表示未知。
                online: stream.map_or(0, |stream| json_i64(stream.get("viewersCount"))),
                live_status: Some(stream.is_some()),
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

/// 关注刷新只向 Twitch 请求这份刻意收窄的 query：
/// 判断关注频道是否正在直播，
/// 不需要房间资料、预览图、标题或播放 token 数据。
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
    // UI 的默认画质偏好把下标 0 视为最佳选项。HLS master 清单并不保证有序，
    // 而且 Twitch 可能在两次 token 刷新之间改变顺序，
    // 因此改为按流的实际属性排序。
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
    // Twitch 的 `VIDEO` 渲染组是一种画质的稳定身份
    // （例如 `chunked`、`720p60` 或 `480p30`）。即使新 token 生成的
    // master 清单项顺序不同，它依然有效。
    if let Some(group) = video_group.map(str::trim).filter(|group| !group.is_empty()) {
        return format!("video-group:{}", group.to_ascii_lowercase());
    }

    // Twitch 通常都带有 `VIDEO`。对不完整的 master 清单保留确定性的兜底，
    // 而不是回退到数组位置。URI 路径只在完全没有流元数据时使用。
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
    fn directory_windows_tile_the_tag_directories_and_then_stop() {
        // 与语言分片同构：第 N 页对应分区 w(N-1)..wN，纯算术、无跨请求状态。
        assert_eq!(directory_window_start(1, 100), Some(0));
        assert_eq!(directory_window_start(2, 100), Some(DIRECTORY_SHARD_WINDOW));
        assert_eq!(
            directory_window_start(4, 100),
            Some(DIRECTORY_SHARD_WINDOW * 3)
        );
        // 页码 0 视作第 1 页，而不是下溢。
        assert_eq!(directory_window_start(0, 100), Some(0));

        // 上界随上游返回的分区数变化：走完就终止，不像语言分片那样是常量。
        assert_eq!(directory_window_start(1, 2), Some(0));
        assert_eq!(directory_window_start(2, 2), None);
        assert_eq!(directory_window_start(2, 3), None);
        assert_eq!(directory_window_start(2, 4), Some(DIRECTORY_SHARD_WINDOW));
        // 标签下没有分区时任何页都是空的。
        assert_eq!(directory_window_start(1, 0), None);
    }

    #[test]
    fn category_tags_drop_language_tags_and_malformed_ids() {
        let tag = parse_category_tag(&json!({
            "id": "A69F7FFB-DDDA-4C05-8D7D-F0B24975A2C3",
            "tagName": "FPS",
            "isLanguageTag": false
        }))
        .expect("a usable category tag");
        // UUID 归一化成小写，`tags:` 变量里两种写法不会当成两个标签。
        assert_eq!(tag.id, "a69f7ffb-ddda-4c05-8d7d-f0b24975a2c3");
        assert_eq!(tag.name, "FPS");

        // 语言标签与既有的语言分片翻页轴重叠，混进分类树只会让用户在两处筛同一件事。
        assert!(
            parse_category_tag(&json!({
                "id": "a69f7ffb-ddda-4c05-8d7d-f0b24975a2c3",
                "tagName": "Chinese",
                "isLanguageTag": true
            }))
            .is_none()
        );
        // 缺 `isLanguageTag` 时按非语言标签处理，不因为字段缺失整棵树都空掉。
        assert!(
            parse_category_tag(&json!({
                "id": "a69f7ffb-ddda-4c05-8d7d-f0b24975a2c3",
                "tagName": "FPS"
            }))
            .is_some()
        );
        // 标签 id 会作为 parent_id 回流到 `tags:` 查询变量，形状不对就不要。
        assert!(parse_category_tag(&json!({ "id": "FPS", "tagName": "FPS" })).is_none());
        assert!(
            parse_category_tag(&json!({
                "id": "a69f7ffb-ddda-4c05-8d7d-f0b24975a2c3",
                "tagName": ""
            }))
            .is_none()
        );
    }

    #[test]
    fn tag_id_accepts_only_uuid_shaped_values() {
        assert_eq!(
            normalize_tag_id(" A69F7FFB-DDDA-4C05-8D7D-F0B24975A2C3 ").as_deref(),
            Some("a69f7ffb-ddda-4c05-8d7d-f0b24975a2c3")
        );
        // 长度对但分隔符位置不对。
        assert!(normalize_tag_id("a69f7ffb0ddda-4c05-8d7d-f0b24975a2c3").is_none());
        // 非十六进制字符。
        assert!(normalize_tag_id("z69f7ffb-ddda-4c05-8d7d-f0b24975a2c3").is_none());
        assert!(normalize_tag_id("").is_none());
        assert!(normalize_tag_id("0").is_none());
    }

    #[test]
    fn tag_directories_become_sub_categories_under_their_tag() {
        let data = json!({
            "games": {
                "edges": [
                    { "node": {
                        "slug": "valorant",
                        "displayName": "VALORANT",
                        "name": "Valorant",
                        "boxArtURL": "https://img.example/box.jpg"
                    }},
                    // 大写 slug 不能作为 `game(slug:)` 的取值，丢掉而不是原样上送。
                    { "node": { "slug": "Not A Slug", "displayName": "Bad" }},
                    // 没有可用名字的分区在 UI 上是一个空格子。
                    { "node": { "slug": "nameless" }},
                    // 只有 `name` 时用它兜底。
                    { "node": { "slug": "fallback", "name": "Fallback Game" }}
                ]
            }
        });
        let subs = parse_tag_directories(&data, "a69f7ffb-ddda-4c05-8d7d-f0b24975a2c3");
        let ids: Vec<&str> = subs.iter().map(|item| item.id.as_str()).collect();
        assert_eq!(ids, ["valorant", "fallback"]);
        assert_eq!(subs[0].name, "VALORANT");
        assert_eq!(subs[0].parent_id, "a69f7ffb-ddda-4c05-8d7d-f0b24975a2c3");
        assert_eq!(subs[0].pic.as_deref(), Some("https://img.example/box.jpg"));
        assert_eq!(subs[1].name, "Fallback Game");
        assert!(subs[1].pic.is_none());
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
        // 第 1 页必须保持不过滤的全局列表，
        // 使首屏与过去游标分页展示的内容一致。
        assert_eq!(LANGUAGE_SHARDS[0], "");
        assert_eq!(shard_window_start(2), Some(SHARD_WINDOW));
        assert_eq!(shard_window_start(3), Some(SHARD_WINDOW * 2));

        // 相邻窗口彼此衔接：不跳过任何分片，也不重复抓取，
        // 这正是合并列表无缺口的原因。
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
        // 越过末尾再翻一页时报告耗尽，而不是回绕或产生越界切片。
        assert_eq!(shard_window_start(last_page + 1), None);
        assert_eq!(shard_window_start(u32::MAX), None);

        // 页码为 0 视作第 1 页，而不是发生下溢。
        assert_eq!(shard_window_start(0), Some(0));
    }

    #[test]
    fn language_filter_distinguishes_all_languages_from_one() {
        // 空数组是 Twitch 的"不限语言"；具体代码则收窄分片。
        // 如果发送 `[""]`，将匹配不到任何主播。
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
    fn search_keeps_offline_channels_with_status() {
        let data = json!({
            "searchFor": {
                "channels": {
                    "items": [
                        {
                            "login": "offline",
                            "displayName": "Offline",
                            "profileImageURL": "https://img.example/avatar.png",
                            "stream": null
                        },
                        {
                            "login": "online",
                            "displayName": "Online",
                            "profileImageURL": "https://img.example/online-avatar.png",
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
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].room_id, "offline");
        assert_eq!(items[0].live_status, Some(false));
        // 未开播没有直播标题和截图：标题留空由展示层兜底，封面退回头像。
        assert_eq!(items[0].title, "");
        assert_eq!(items[0].cover, "https://img.example/avatar.png");
        assert_eq!(items[0].online, 0);
        assert_eq!(items[1].room_id, "online");
        assert_eq!(items[1].live_status, Some(true));
        assert_eq!(items[1].title, "Live");
        assert_eq!(items[1].cover, "https://img.example/live.jpg");
        assert_eq!(items[1].online, 7);
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

        // 刷新后的播放 token 可能把这些完全相同的画质排成不同顺序，
        // 并给它们的子播放列表分配不同 URL。
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
}
