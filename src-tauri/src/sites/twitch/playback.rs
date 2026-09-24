//! Twitch 播放令牌、usher 请求、画质交接缓存与广告回退。

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use reqwest::{Client, Url};
use serde_json::{Value, json};

use crate::error::{AppError, AppResult};
use crate::models::live::{LivePlayQuality, LiveRoomDetail, PlayUrl};

use super::api::preview;
use super::hls::{TwitchVariant, find_closest_hls_variant, find_hls_variant, parse_hls_variants};
use super::room::normalize_login;
use super::{DEFAULT_USER_AGENT, TwitchSite};

const TWITCH_USHER_URL: &str = "https://usher.ttvnw.net/api/channel/hls";

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

/// `get_play_qualities` → `get_play_urls` 的进程内一次性交接缓存。
///
/// 播放流程总是先取画质列表、紧接着为选中的画质取播放地址，而这两步过去
/// 各自完整执行一次 `playback_variants`（GQL 播放 token + usher 主清单），
/// 重复的网络往返是 Twitch 首帧延迟的主要来源之一。qualities 成功后把
/// 变体列表交接进这里，紧随其后的 urls 直接消费，省掉第二次往返。
///
/// 安全边界：
/// - 只存在于进程内存，绝不持久化，也绝不进入返回给前端的画质数据；
/// - 短 TTL：值里携带短时效的签名 URL 与播放 token，窗口只覆盖
///   qualities→urls 的正常衔接，过期一律作废并回退重新请求；
/// - 一次性：取出即删除，并发的第二次消费必然 miss；
/// - 有界容量：逐房间浏览不会让缓存增长。
#[derive(Default)]
struct PlaybackHandoffCache {
    /// 键为已规范化的 login：写入与消费两侧都先经过 `normalize_login`。
    entries: Mutex<HashMap<String, PlaybackHandoffEntry>>,
}

/// 一条交接记录：变体列表与作废时刻。
struct PlaybackHandoffEntry {
    expires_at: Instant,
    variants: Vec<TwitchVariant>,
}

/// 交接缓存的存活时间。qualities→urls 的正常衔接在一秒量级，这里取 15 秒
/// 给慢设备与画质选择留余量；同时保证交接出去的签名 URL 距离新鲜签发最多
/// 15 秒，仍落在 Twitch 播放 token 的时效内。
const PLAYBACK_HANDOFF_TTL: Duration = Duration::from_secs(15);

/// 交接缓存的容量上限。一次交接只服务一个房间的画质选择，8 个条目足以容纳
/// 快速切换房间时的在途交接，同时约束长期驻留内存的签名 URL 总量。
const PLAYBACK_HANDOFF_CAPACITY: usize = 8;

static PLAYBACK_HANDOFF: LazyLock<PlaybackHandoffCache> =
    LazyLock::new(PlaybackHandoffCache::default);

impl PlaybackHandoffCache {
    /// 以默认 TTL 写入一次交接，仅由 qualities 成功路径调用。
    fn store(&self, login: &str, variants: Vec<TwitchVariant>) {
        self.store_with_ttl(login, variants, PLAYBACK_HANDOFF_TTL)
    }

    /// 写入一条带自定义 TTL 的交接；测试用它构造确定性的过期与淘汰场景。
    /// 全程同步，锁不跨 await。
    fn store_with_ttl(&self, login: &str, variants: Vec<TwitchVariant>, ttl: Duration) {
        // 交接缓存是纯优化：mutex 中毒只意味着放弃这次交接，
        // 绝不让一次已经成功的画质请求因此失败。
        let Ok(mut entries) = self.entries.lock() else {
            return;
        };
        let now = Instant::now();
        // 先清过期条目：既释放容量，也不让签名 URL 在内存里滞留超过 TTL。
        entries.retain(|_, entry| entry.expires_at > now);
        if entries.len() >= PLAYBACK_HANDOFF_CAPACITY && !entries.contains_key(login) {
            // 仍满则淘汰最接近过期的条目；统一 TTL 下即最早写入的房间。
            if let Some(evict) = entries
                .iter()
                .min_by_key(|(_, entry)| entry.expires_at)
                .map(|(key, _)| key.clone())
            {
                entries.remove(&evict);
            }
        }
        entries.insert(
            login.to_string(),
            PlaybackHandoffEntry {
                expires_at: now + ttl,
                variants,
            },
        );
    }

    /// 原子取出未过期的一次交接。取出即删除：过期、未写入或已被并发消费
    /// 都返回 `None`，调用方按现状重新请求。全程同步，锁不跨 await。
    fn take_fresh(&self, login: &str) -> Option<Vec<TwitchVariant>> {
        let mut entries = self.entries.lock().ok()?;
        match entries.remove(login) {
            Some(entry) if entry.expires_at > Instant::now() => Some(entry.variants),
            // 过期条目同样被 remove 丢弃，不会留在内存里。
            _ => None,
        }
    }
}

impl TwitchSite {
    async fn playback_variants(&self, login: &str) -> AppResult<Vec<TwitchVariant>> {
        let (player_type, platform) = TWITCH_PRIMARY_PLAYER_TYPE;
        self.playback_variants_for_profile(login, player_type, platform)
            .await
    }

    pub(super) async fn playback_variants_for_profile(
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

    pub(super) async fn play_qualities(
        &self,
        detail: &LiveRoomDetail,
    ) -> AppResult<Vec<LivePlayQuality>> {
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
        // 交接给紧随其后的 get_play_urls 消费，免去它对同一变体列表的
        // 重复 GQL token + usher 主清单往返。签名 URL 只留在进程内的
        // 短时缓存里，绝不进入返回给前端的画质数据。
        PLAYBACK_HANDOFF.store(&login, variants.clone());
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

    pub(super) async fn play_urls(
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
        // 优先消费 qualities 刚交接的变体：命中时省掉一次完整的
        // playback_variants（GQL 播放 token + usher 主清单）往返，
        // 这正是 Twitch 首帧延迟的一半来源。缓存缺失、过期或已被并发
        // 消费时回退到现状的重新抓取。`take_fresh` 的锁只在同步段内
        // 持有，这里没有跨 await 的锁。
        let variants = match PLAYBACK_HANDOFF.take_fresh(&login) {
            Some(variants) => variants,
            None => self.playback_variants(&login).await?,
        };
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

#[cfg(test)]
mod tests {
    use super::*;

    use super::super::hls::tests::handoff_variant;

    #[test]
    fn requests_av1_and_h264_twitch_variants_for_webview_playback() {
        let url = usher_master_url("demo", "signature", "token", "site").expect("master URL");
        let supported_codecs = url
            .query_pairs()
            .find_map(|(key, value)| (key == "supported_codecs").then(|| value.into_owned()));

        assert_eq!(supported_codecs.as_deref(), Some("av1,h264"));
    }

    /// 拍下交接缓存当前的键集合（排序后便于断言）。
    /// 锁结果不直接 unwrap：中毒时恢复内部数据而不是 panic。
    fn handoff_snapshot(cache: &PlaybackHandoffCache) -> Vec<String> {
        let entries = cache
            .entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut logins: Vec<String> = entries.keys().cloned().collect();
        logins.sort();
        logins
    }

    #[test]
    fn playback_handoff_is_served_once_then_misses() {
        let cache = PlaybackHandoffCache::default();
        cache.store("caedrel", vec![handoff_variant("video-group:720p60")]);

        // 一次交接命中：urls 消费到的正是 qualities 刚写入的变体。
        let consumed = cache.take_fresh("caedrel").expect("handoff hit");
        assert_eq!(consumed.len(), 1);
        assert_eq!(consumed[0].selector, "video-group:720p60");
        // 消费即删除：二次消费必然 miss，让调用方回退重新请求，
        // 并发的两个 urls 也只有一个能拿到交接。
        assert!(cache.take_fresh("caedrel").is_none());
        assert!(handoff_snapshot(&cache).is_empty());
    }

    #[test]
    fn expired_playback_handoff_misses_and_is_dropped() {
        let cache = PlaybackHandoffCache::default();
        // 零 TTL：写入即过期，绝不交接出陈旧的签名 URL。
        cache.store_with_ttl(
            "caedrel",
            vec![handoff_variant("video-group:chunked")],
            Duration::ZERO,
        );

        assert!(cache.take_fresh("caedrel").is_none());
        // 过期条目在取出时被一并丢弃，不滞留在内存里。
        assert!(handoff_snapshot(&cache).is_empty());
    }

    #[test]
    fn playback_handoff_capacity_stays_bounded() {
        let cache = PlaybackHandoffCache::default();
        // 容量 + 2 个房间依次写入。递增 TTL 让最早写入的房间拥有严格最小的
        // 过期时刻，规避时钟粒度把淘汰目标打平。
        let rooms: Vec<String> = (0..(PLAYBACK_HANDOFF_CAPACITY + 2))
            .map(|index| format!("room{index}"))
            .collect();
        for (index, room) in rooms.iter().enumerate() {
            cache.store_with_ttl(
                room,
                vec![handoff_variant("video-group:chunked")],
                Duration::from_secs(index as u64 + 1),
            );
        }

        // 缓存大小被容量钉死：逐房间浏览不会让它无界增长。
        let logins = handoff_snapshot(&cache);
        assert_eq!(logins.len(), PLAYBACK_HANDOFF_CAPACITY);
        // 超出容量时淘汰最早写入的条目，最新的交接仍然在位。
        assert!(!logins.contains(&rooms[0]));
        assert!(!logins.contains(&rooms[1]));
        assert!(logins.contains(rooms.last().unwrap()));
    }

    #[test]
    fn playback_handoff_keeps_rooms_isolated_by_login() {
        let cache = PlaybackHandoffCache::default();
        cache.store("caedrel", vec![handoff_variant("video-group:chunked")]);

        // 另一个房间的 urls 消费不到 caedrel 的交接。
        assert!(cache.take_fresh("pirategp").is_none());
        // caedrel 自己的交接完好无损，仍然可以消费。
        let consumed = cache.take_fresh("caedrel").expect("own handoff hit");
        assert_eq!(consumed[0].selector, "video-group:chunked");
    }
}
