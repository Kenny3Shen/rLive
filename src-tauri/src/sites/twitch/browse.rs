//! Twitch 分类树、语言与标签分片浏览及频道搜索。

use std::collections::{HashMap, HashSet};
use std::ops::Range;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use base64::Engine as _;
use futures_util::future;
use futures_util::stream::{self, StreamExt};
use serde_json::{Value, json};

use crate::error::{AppError, AppResult};
use crate::models::live::{LiveCategory, LiveRoomItem, LiveSubCategory, RoomListPage, SiteId};

use super::TwitchSite;
use super::parse::{first_non_empty, json_i64, json_string, non_empty};
use super::room::normalize_login;

const PAGE_SIZE: u32 = 30;

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

/// 取分类树时同时在飞的标签数。实测 41 个标签，无上限扇出会一次打出 41 个
/// 并发请求；取 8 与仓库其他扇出（IPTV 探测 12、关注刷新 5）同量级，
/// 首次取树约 6 个往返，之后由 `TAG_DIRECTORIES` 缓存兜住。
const DIRECTORY_FANOUT: usize = 8;

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

/// 每个标签下的分区列表按标签 UUID 缓存。分类树是慢变数据，而它同时被两条
/// 路径要用：`get_categories` 一次要取全部标签的分区，`tag_page` 每翻一页
/// 都要同一个标签的分区来算窗口。没有缓存时前者每次打开分类条要发数十个请求、
/// 后者每页多付一个串行往返。
static TAG_DIRECTORIES: TagDirectoryCache = OnceLock::new();

/// `TAG_DIRECTORIES` 的静态类型：标签 UUID → (抓取时间, 分区列表)。
type TagDirectoryCache = OnceLock<Mutex<HashMap<String, (Instant, Vec<LiveSubCategory>)>>>;

/// 分区缓存的存活时间。取半小时：分类树的增减以天计，而这个值同时决定
/// 「全部X」翻页期间窗口切片的稳定性。
const TAG_DIRECTORIES_TTL: Duration = Duration::from_secs(30 * 60);

/// `page` 窗口的第一个分片下标；分片列表耗尽时返回 `None`。
/// 纯算术运算，因此可以直接请求某一页，
/// 而不必先走完它之前的页面。
fn shard_window_start(page: u32) -> Option<usize> {
    let start = (page.max(1) as usize - 1).checked_mul(SHARD_WINDOW)?;
    (start < LANGUAGE_SHARDS.len()).then_some(start)
}

/// 分区信息流里房间边界在响应中的位置。`CategoryFeed::edges_path` 与按分区
/// 聚合的 `tag_page` 都用它，后者没有单个 feed 可问。
const CATEGORY_EDGES_PATH: &str = "/game/streams/edges";

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
        CATEGORY_EDGES_PATH
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

impl TwitchSite {
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
            return Ok(RoomListPage::empty());
        };
        let window_end = (start + SHARD_WINDOW).min(LANGUAGE_SHARDS.len());

        // 在扇出之前先预热共享上下文。否则冷启动的一页会并发三个引导 GET，
        // 因为每个分片都需要同一个 Client-ID。
        self.ensure_public_web_context().await?;

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
        if let Some(cached) = Self::tag_directories_cache()
            .lock()
            .map_err(|_| Self::parse_err("Twitch tag directory mutex poisoned"))?
            .get(tag_id)
            .filter(|(fetched_at, _)| fetched_at.elapsed() < TAG_DIRECTORIES_TTL)
            .map(|(_, directories)| directories.clone())
        {
            return Ok(cached);
        }
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
        let directories = parse_tag_directories(&data, tag_id);
        Self::tag_directories_cache()
            .lock()
            .map_err(|_| Self::parse_err("Twitch tag directory mutex poisoned"))?
            .insert(tag_id.to_string(), (Instant::now(), directories.clone()));
        Ok(directories)
    }

    fn tag_directories_cache() -> &'static Mutex<HashMap<String, (Instant, Vec<LiveSubCategory>)>> {
        TAG_DIRECTORIES.get_or_init(|| Mutex::new(HashMap::new()))
    }

    /// 装配分类树：一级是游戏类型标签，二级是标签下的分区。
    pub(super) async fn category_tree(&self) -> AppResult<Vec<LiveCategory>> {
        // `category_tags` 自己就会走 graphql 并填好共享上下文缓存，
        // 因此下面的扇出不会再各自引导一次 Client-ID。
        let tags = self.category_tags().await?;
        // 逐个标签取分区，但必须设闸：实测 41 个标签，无上限时一次打开分类条
        // 就是 41 个并发请求，远超同文件语言分片自定的 `SHARD_WINDOW`。
        // `buffered` 保序，因此下面能直接和 `tags` 对拉链。
        let mut children_by_tag = Vec::with_capacity(tags.len());
        let mut pending = stream::iter(
            tags.iter()
                .map(|tag| self.tag_directories(&tag.id))
                .collect::<Vec<_>>(),
        )
        .buffered(DIRECTORY_FANOUT);
        while let Some(children) = pending.next().await {
            children_by_tag.push(children?);
        }
        drop(pending);

        let mut categories = Vec::new();
        for (tag, children) in tags.iter().zip(children_by_tag) {
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

    pub(super) async fn recommend_page(&self, page: u32) -> AppResult<RoomListPage> {
        self.shard_page(RecommendFeed, page).await
    }

    pub(super) async fn category_page(
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
        let slug = normalize_category_slug(&category.id)?;
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
            return Ok(RoomListPage::empty());
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
        let mut items = Vec::new();
        let mut seen = HashSet::new();
        for data in future::try_join_all(requests).await? {
            for item in parse_stream_edges(&data, CATEGORY_EDGES_PATH, &self.site_id) {
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

    pub(super) async fn search_page(&self, keyword: &str, page: u32) -> AppResult<RoomListPage> {
        let keyword = keyword.trim();
        if keyword.is_empty() {
            return Ok(RoomListPage::empty());
        }
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

// 线上 smoke 沿用同一份校验；这些入口仅在测试编译时存在。
#[cfg(test)]
pub(super) mod test_support {
    use crate::error::AppResult;

    pub(in super::super) fn normalize_tag_id(value: &str) -> Option<String> {
        super::normalize_tag_id(value)
    }

    pub(in super::super) fn normalize_category_slug(value: &str) -> AppResult<String> {
        super::normalize_category_slug(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
