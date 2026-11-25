//! YouTube HLS 清晰度发现和播放地址。

use std::collections::HashMap;

use reqwest::Url;
use serde_json::{Value, json};

use crate::error::AppResult;
use crate::models::live::{LivePlayQuality, LiveRoomDetail, PlayUrl, PlaybackProtocol};

use super::YoutubeSite;
use super::api::DEFAULT_USER_AGENT;

#[derive(Debug, Clone)]
struct Variant {
    url: String,
    itag: String,
    height: u32,
    fps: u32,
    bandwidth: u64,
}

fn media_url(value: Option<&str>) -> Option<String> {
    let url = Url::parse(value?).ok()?;
    (url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && url
            .host_str()
            .is_some_and(|host| host == "manifest.googlevideo.com"))
    .then(|| url.to_string())
}

fn attribute<'a>(line: &'a str, name: &str) -> Option<&'a str> {
    let marker = format!("{name}=");
    let start = line.find(&marker)? + marker.len();
    let rest = &line[start..];
    if let Some(quoted) = rest.strip_prefix('"') {
        quoted.split_once('"').map(|(value, _)| value)
    } else {
        Some(rest.split(',').next().unwrap_or_default())
    }
}

fn muxed_h264_aac(attributes: &str) -> bool {
    if attribute(attributes, "AUDIO").is_some() {
        return false;
    }
    let Some(codecs) = attribute(attributes, "CODECS") else {
        return false;
    };
    let codecs = codecs
        .split(',')
        .map(|value| value.trim().to_ascii_lowercase())
        .collect::<Vec<_>>();
    codecs.iter().any(|codec| {
        codec.starts_with("avc1") || codec.starts_with("h264") || codec.starts_with("h.264")
    }) && codecs
        .iter()
        .any(|codec| codec.starts_with("mp4a") || codec.starts_with("aac"))
}

fn parse_variants(manifest: &str, base: &Url) -> Vec<Variant> {
    let mut pending = None;
    let mut variants = Vec::new();
    for raw in manifest.lines() {
        let line = raw.trim();
        if line.starts_with("#EXT-X-STREAM-INF:") {
            pending = Some(line);
            continue;
        }
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some(attributes) = pending.take() else {
            continue;
        };
        if !muxed_h264_aac(attributes) {
            continue;
        }
        let Ok(url) = base.join(line) else {
            continue;
        };
        let Some(url) = media_url(Some(url.as_str())) else {
            continue;
        };
        let height = attribute(attributes, "RESOLUTION")
            .and_then(|value| value.split_once('x'))
            .and_then(|(_, height)| height.parse::<u32>().ok())
            .unwrap_or_default();
        if height == 0 {
            continue;
        }
        let fps = attribute(attributes, "FRAME-RATE")
            .and_then(|value| value.parse::<f64>().ok())
            .map(|value| value.round() as u32)
            .unwrap_or(30);
        let bandwidth = attribute(attributes, "BANDWIDTH")
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or_default();
        let itag = url
            .as_str()
            .split_once("/itag/")
            .and_then(|(_, tail)| tail.split('/').next())
            .unwrap_or("hls")
            .to_owned();
        variants.push(Variant {
            url,
            itag,
            height,
            fps,
            bandwidth,
        });
    }
    variants.sort_by(|a, b| {
        b.height
            .cmp(&a.height)
            .then(b.fps.cmp(&a.fps))
            .then(b.bandwidth.cmp(&a.bandwidth))
    });
    variants.dedup_by(|a, b| a.height == b.height && a.fps == b.fps);
    variants
}

fn live_hls(player: &Value) -> Option<String> {
    media_url(player.pointer("/streamingData/hlsManifestUrl")?.as_str())
}

impl YoutubeSite {
    pub(super) async fn play_qualities(
        &self,
        detail: &LiveRoomDetail,
    ) -> AppResult<Vec<LivePlayQuality>> {
        if !detail.status {
            return Err(YoutubeSite::err(
                "youtube_not_live",
                "该 YouTube 频道当前未开播",
            ));
        }
        let video_id = detail
            .raw
            .get("video_id")
            .and_then(Value::as_str)
            .and_then(super::room::canonical_room_id)
            .ok_or_else(|| YoutubeSite::parse_err("YouTube 直播场次信息缺失，请重新载入"))?;
        let player = self.player(&video_id).await?;
        if !super::room::player_is_live(&player, false)? {
            return Err(YoutubeSite::err(
                "youtube_not_live",
                "该 YouTube 直播已结束",
            ));
        }
        let hls_url = live_hls(&player).ok_or_else(|| {
            YoutubeSite::err(
                "youtube_hls_unavailable",
                "YouTube 未返回可用的 HLS 直播地址，请稍后重试",
            )
            .retryable()
        })?;
        let manifest = self
            .client
            .get(&hls_url)
            .header("user-agent", DEFAULT_USER_AGENT)
            .header("referer", &detail.url)
            .send()
            .await
            // YouTube 将签名放在路径中；通用 URL 脱敏只移除 query，不能用于此处。
            .map_err(|_| {
                YoutubeSite::upstream_err("读取 YouTube HLS 清单失败，请检查网络后重试")
            })?;
        if !manifest.status().is_success() {
            return Err(YoutubeSite::upstream_err(format!(
                "YouTube HLS 清单返回 HTTP {}",
                manifest.status().as_u16()
            )));
        }
        let manifest = manifest
            .text()
            .await
            .map_err(|_| YoutubeSite::upstream_err("读取 YouTube HLS 清单内容失败"))?;
        let base =
            Url::parse(&hls_url).map_err(|_| YoutubeSite::parse_err("YouTube HLS 地址无效"))?;
        let variants = parse_variants(&manifest, &base);
        if variants.is_empty() {
            return Err(
                YoutubeSite::err("youtube_hls_empty", "YouTube HLS 清单没有可用清晰度").retryable(),
            );
        }

        Ok(variants
            .into_iter()
            .map(|variant| {
                let label = if variant.fps > 30 {
                    format!("{}p{}", variant.height, variant.fps)
                } else {
                    format!("{}p", variant.height)
                };
                LivePlayQuality {
                    quality: label.clone(),
                    data: json!({
                        "video_id": video_id,
                        "variant_url": variant.url,
                        "itag": variant.itag,
                        "height": variant.height,
                        "fps": variant.fps,
                        "display_label": label,
                    }),
                }
            })
            .collect())
    }

    pub(super) async fn play_urls(
        &self,
        detail: &LiveRoomDetail,
        quality: &LivePlayQuality,
    ) -> AppResult<Vec<PlayUrl>> {
        if quality.data.get("video_id") != detail.raw.get("video_id") {
            return Err(YoutubeSite::err(
                "youtube_playback_invalid",
                "YouTube 播放场次已变化，请重新载入",
            ));
        }
        let variant_url = quality
            .data
            .get("variant_url")
            .and_then(Value::as_str)
            .and_then(|value| media_url(Some(value)))
            .ok_or_else(|| {
                YoutubeSite::err(
                    "youtube_playback_invalid",
                    "YouTube 播放地址已失效，请重新载入",
                )
            })?;
        let label = quality
            .data
            .get("display_label")
            .and_then(Value::as_str)
            .unwrap_or("YouTube 直播")
            .to_owned();
        let video_id = quality
            .data
            .get("video_id")
            .and_then(Value::as_str)
            .unwrap_or(&detail.room_id);
        let mut headers = HashMap::new();
        headers.insert("user-agent".to_owned(), DEFAULT_USER_AGENT.to_owned());
        headers.insert(
            "referer".to_owned(),
            format!("https://www.youtube.com/watch?v={video_id}"),
        );
        Ok(vec![
            PlayUrl::inferred(
                quality
                    .data
                    .get("itag")
                    .and_then(Value::as_str)
                    .unwrap_or(&quality.quality)
                    .to_owned(),
                label,
                0,
                variant_url,
                headers,
            )
            .with_protocol(PlaybackProtocol::Hls),
        ])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_sorted_muxed_variants() {
        let base =
            Url::parse("https://manifest.googlevideo.com/api/manifest/x/index.m3u8").unwrap();
        let manifest = r#"
#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=100,CODECS="avc1.4D401E,mp4a.40.2",RESOLUTION=640x360,FRAME-RATE=30
https://manifest.googlevideo.com/api/manifest/x/itag/93/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=200,CODECS="avc1.4D401F,mp4a.40.2",RESOLUTION=1280x720,FRAME-RATE=60
https://manifest.googlevideo.com/api/manifest/x/itag/95/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=50,CODECS="avc1.4D4015",RESOLUTION=426x240,FRAME-RATE=30
https://manifest.googlevideo.com/api/manifest/x/itag/92/index.m3u8
"#;
        let variants = parse_variants(manifest, &base);
        assert_eq!(variants.len(), 2);
        assert_eq!(variants[0].itag, "95");
        assert_eq!(variants[0].height, 720);
    }

    #[test]
    fn rejects_non_googlevideo_media_urls() {
        assert!(media_url(Some("https://example.com/live.m3u8")).is_none());
        assert!(media_url(Some("http://manifest.googlevideo.com/live.m3u8")).is_none());
    }
}
