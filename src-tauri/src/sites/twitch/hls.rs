//! Twitch HLS 主清单解析、稳定画质选择器与画质匹配。

use std::collections::HashMap;

use reqwest::Url;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct TwitchVariant {
    /// 来自 HLS master playlist 的语义 ID，而不是变体在该列表中的位置。
    /// 每次签发短时效播放 token 时，Twitch 都可能重排列表。
    pub(super) selector: String,
    pub(super) label: String,
    pub(super) url: String,
    is_source: bool,
    pub(super) width: u32,
    pub(super) height: u32,
    pub(super) frame_rate_milli: u32,
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

pub(super) fn parse_hls_variants(manifest: &str, master_url: &Url) -> Vec<TwitchVariant> {
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

pub(super) fn find_hls_variant<'a>(
    variants: &'a [TwitchVariant],
    selector: &str,
) -> Option<&'a TwitchVariant> {
    variants.iter().find(|variant| variant.selector == selector)
}

pub(super) fn find_closest_hls_variant<'a>(
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

#[cfg(test)]
pub(super) mod tests {
    use super::*;

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

    /// 构造一个仅 selector 有区分度的交接变体：缓存测试只关心交接语义，
    /// 不关心清晰度数值本身。
    pub(in super::super) fn handoff_variant(selector: &str) -> TwitchVariant {
        TwitchVariant {
            selector: selector.into(),
            label: selector.into(),
            url: format!("https://playlist.example/{selector}.m3u8"),
            is_source: false,
            width: 1280,
            height: 720,
            frame_rate_milli: 60_000,
            bandwidth: 3_000_000,
        }
    }
}
