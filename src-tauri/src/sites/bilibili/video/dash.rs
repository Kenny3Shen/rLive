//! DASH 纯协议处理：候选地址、选流、sidx 解析与 MPD 合成。
//!
//! 网络请求与媒体抓取由父模块编排，这里只处理响应数据和字节。

use serde_json::Value;

use crate::error::AppResult;
use crate::models::video::{VideoPlayRequest, VideoQuality};

use super::super::api::{as_i64, as_str};
use super::video_err;

/// 默认视频编码前缀。
///
/// 同一画质会并列 avc1 / hvc1 / av01 三个变体，选流必须按编码过滤。
/// avc1 在各平台 WebView 上的硬解覆盖最广，作为默认最稳。
const DEFAULT_CODEC: &str = "avc1";

/// representation 的候选地址：base_url 优先，backup_url / backupBaseUrl 随后。
///
/// mcdn 等 PCDN 节点会对部分网络环境返回 403 或直接拒连，而同一 representation
/// 的备用地址里通常有可用的 upos 镜像；抓 sidx 时逐个尝试，选第一个能服务的。
pub(super) fn stream_candidates(rep: &Value) -> Vec<String> {
    let mut candidates: Vec<String> = Vec::new();
    for key in ["base_url", "baseUrl"] {
        if let Some(url) = rep.get(key).map(as_str).filter(|url| !url.is_empty())
            && !candidates.contains(&url)
        {
            candidates.push(url);
        }
    }
    for key in ["backup_url", "backupBaseUrl"] {
        if let Some(list) = rep.get(key).and_then(Value::as_array) {
            for url in list.iter().map(as_str).filter(|url| !url.is_empty()) {
                if !candidates.contains(&url) {
                    candidates.push(url);
                }
            }
        }
    }
    candidates
}

// ---------------------------------------------------------------------------
// sidx 解析与 MPD 合成
// ---------------------------------------------------------------------------

/// sidx 解出的一个媒体分片。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SidxSegment {
    /// 分片在完整资源中的起始字节（含）。
    pub start_byte: u64,
    /// 结束字节（含），可直接用于 `Range` 与 `mediaRange`。
    pub end_byte: u64,
    /// 结束时刻，单位为 sidx 的 timescale。
    pub t_end: u64,
}

/// 一个 representation 的完整分片表。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sidx {
    pub timescale: u32,
    pub segments: Vec<SidxSegment>,
}

impl Sidx {
    /// 时间轴总时长，秒。
    pub fn duration_secs(&self) -> f64 {
        match (self.segments.last(), self.timescale) {
            (Some(last), timescale) if timescale > 0 => last.t_end as f64 / f64::from(timescale),
            _ => 0.0,
        }
    }
}

/// 从 `offset` 起读 N 字节大端整数（u16/u32/u64 共用，错误消息里的
/// 位宽由 N 推出）。
fn be<const N: usize>(bytes: &[u8], offset: usize) -> AppResult<[u8; N]> {
    bytes
        .get(offset..offset + N)
        .and_then(|slice| slice.try_into().ok())
        .ok_or_else(|| video_err(format!("sidx 截断：读取 u{} 越界", N * 8)))
}

/// 把「init 段 + sidx」的合并响应切回两段。
///
/// 合并请求的区间是 `0-index_end`，其中 `init_end + 1` 是 sidx 的起点，因此
/// 切片边界固定为 `init_end + 1`。截断到不足 init 段时宁可报错也不猜 —— 把半个
/// init 段当成 init、或把 init 的尾巴当成 sidx，都会在下游变成难查的解析错误。
pub(super) fn split_init_and_sidx(bytes: &[u8], init_end: u64) -> AppResult<(Vec<u8>, Vec<u8>)> {
    let boundary = usize::try_from(init_end)
        .ok()
        .and_then(|value| value.checked_add(1))
        .ok_or_else(|| video_err("init 段字节区间溢出"))?;
    if bytes.len() < boundary {
        return Err(video_err("init 段与 sidx 的合并响应被截断"));
    }
    Ok((bytes[..boundary].to_vec(), bytes[boundary..].to_vec()))
}

/// 解析 `segment_base.index_range` 取回的 ISO BMFF `sidx` box。
///
/// 后端在 play-info 阶段就把分片表解出来：MPD 由此合成带逐片字节区间与精确
/// 时长（`SegmentList` + `SegmentTimeline`）的清单，sidx 异常也在这一步以站点
/// 错误模型直接报给用户，而不是把问题留到播放器缓冲阶段。
///
/// `index_range_end` 是 `index_range` 的结束字节（含）。分片起始位置从
/// `index_range_end + 1 + first_offset` 开始，按各分片大小依次累加。
///
/// 入参是网络数据，每次读取都做边界检查，截断或类型不符一律报错而不是猜测。
pub fn parse_sidx(bytes: &[u8], index_range_end: u64) -> AppResult<Sidx> {
    // box 头：size(4) type(4)。这里只校验类型，长度用实际 buffer 边界兜底。
    let box_type = bytes
        .get(4..8)
        .ok_or_else(|| video_err("sidx 截断：缺少 box 头"))?;
    if box_type != b"sidx" {
        return Err(video_err(format!(
            "index_range 不是 sidx box（实际 type={}）",
            String::from_utf8_lossy(box_type)
        )));
    }
    let version = *bytes
        .get(8)
        .ok_or_else(|| video_err("sidx 截断：缺少 version"))?;
    // version(1) + flags(3)
    let mut offset = 12;
    // reference_id(4) 用不到，直接跳过；timescale 决定后面所有时刻的单位。
    let timescale = u32::from_be_bytes(be::<4>(bytes, offset + 4)?);
    offset += 8;
    let first_offset = match version {
        // version 0：earliest_presentation_time(4) + first_offset(4)
        0 => {
            let value = u64::from(u32::from_be_bytes(be::<4>(bytes, offset + 4)?));
            offset += 8;
            value
        }
        // version 1：两个字段各 8 字节。实测 B 站返回的正是 version 1。
        1 => {
            let value = u64::from_be_bytes(be::<8>(bytes, offset + 8)?);
            offset += 16;
            value
        }
        other => return Err(video_err(format!("不支持的 sidx version={other}"))),
    };
    // reserved(2) + reference_count(2)
    let count = u16::from_be_bytes(be::<2>(bytes, offset + 2)?);
    offset += 4;

    let mut base = index_range_end
        .checked_add(1)
        .and_then(|value| value.checked_add(first_offset))
        .ok_or_else(|| video_err("sidx 分片起始字节溢出"))?;
    let mut time = 0_u64;
    let mut segments = Vec::with_capacity(usize::from(count));
    for index in 0..usize::from(count) {
        let entry = offset + index * 12;
        // 首字段高位是 reference_type，低 31 位才是分片字节数。
        let size = u64::from(u32::from_be_bytes(be::<4>(bytes, entry)?) & 0x7fff_ffff);
        let duration = u64::from(u32::from_be_bytes(be::<4>(bytes, entry + 4)?));
        if size == 0 {
            return Err(video_err("sidx 分片长度为 0"));
        }
        let end = base
            .checked_add(size)
            .ok_or_else(|| video_err("sidx 分片字节区间溢出"))?;
        segments.push(SidxSegment {
            start_byte: base,
            end_byte: end - 1,
            t_end: time + duration,
        });
        base = end;
        time += duration;
    }
    if segments.is_empty() {
        return Err(video_err("sidx 未包含任何分片"));
    }
    Ok(Sidx {
        timescale,
        segments,
    })
}

/// 合成 MPD 所需的单轨信息。
#[derive(Debug, Clone)]
pub struct VideoTrack {
    /// 上游媒体地址（交给 stream_proxy 做上游）。
    pub base_url: String,
    /// init 段字节区间的结束字节（起始恒为 0）。
    pub init_end: u64,
    /// init 段的原始字节。
    ///
    /// 取流阶段它已随 sidx 一起取回（见 `video_track` 的合并 Range），在这里
    /// 带出来供调用方预写进分片缓存：播放器起播的第一个请求就是它，命中本机
    /// 就省掉一次完整 CDN 往返。
    pub init_bytes: Vec<u8>,
    pub sidx: Sidx,
    pub codecs: String,
    pub bandwidth: i64,
    pub rep_id: String,
    /// 视频轨专有；音频轨为 `None`。
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub frame_rate: Option<String>,
    pub sar: Option<String>,
    pub start_with_sap: i64,
}

/// 一次播放选中的两条轨与画质信息。
#[derive(Debug, Clone)]
pub struct VideoPlaySelection {
    pub video: VideoTrack,
    pub audio: VideoTrack,
    pub quality: i64,
    pub quality_label: String,
    pub accept_quality: Vec<VideoQuality>,
}

/// XML 属性转义。URL 里的 `&` 必须写成 `&amp;`，否则 MPD 不是合法 XML。
fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// 为一条轨输出 `<SegmentList>`：逐片 `mediaRange` + `<SegmentTimeline>` 精确时长。
///
/// 1. 携带 `SegmentTimeline` 的 `SegmentList` 是 dash.js 原生支持的形态：其对
///    含 `SegmentTimeline` 的 `SegmentList` 走按时间轴取片的 getter，第 k 个
///    `<S>` 与第 k 个 `<SegmentURL>` 一一对应——时刻来自 `t`/`d`，字节区间来自
///    `mediaRange`。B 站按关键帧切片、片长不等，任何等长假设（固定 `duration`
///    展开时间轴）都会让 seek 选错分片，因此逐片写出真实时长。
/// 2. `timescale` 与 `<S>` 的 `t`/`d` 直接取该轨 sidx 的原值：视频轨与音轨的
///    timescale 各自独立（实测 16000 / 48000），不做换算也就不引入舍入。
/// 3. 全部分片共用同一条代理 URL，差异只在 `Range` 请求头；dash.js 按时间轴
///    区分分片（不以 URL 去重），并为带 `mediaRange` 的分片发 `Range: bytes=a-b`，
///    代理照头转发即可，无需给每片编造独立地址。
fn segment_list_xml(track: &VideoTrack, proxy_url: &str) -> String {
    let media = xml_escape(proxy_url);
    let mut xml = format!(r#"<SegmentList timescale="{}">"#, track.sidx.timescale);
    xml.push_str(&format!(
        r#"<Initialization sourceURL="{media}" range="0-{}"/>"#,
        track.init_end
    ));
    for segment in &track.sidx.segments {
        xml.push_str(&format!(
            r#"<SegmentURL media="{media}" mediaRange="{}-{}"/>"#,
            segment.start_byte, segment.end_byte
        ));
    }
    // sidx 只给逐片 t_end：分片 k 的起点是上一片的 t_end（首片为 0），
    // 时长 = 本片 t_end − 起点。
    let mut start = 0_u64;
    xml.push_str("<SegmentTimeline>");
    for segment in &track.sidx.segments {
        xml.push_str(&format!(
            r#"<S t="{start}" d="{}"/>"#,
            segment.t_end - start
        ));
        start = segment.t_end;
    }
    xml.push_str("</SegmentTimeline></SegmentList>");
    xml
}

/// 用两条轨的本机代理地址合成 MPD。
///
/// 清单经文本代理按播放会话挂到 HTTP 上，适配器按 URL 拉取；清单里的分片
/// 地址是两条轨各自的代理绝对地址，与清单本身同在本机回环。
pub fn build_mpd(
    selection: &VideoPlaySelection,
    video_proxy_url: &str,
    audio_proxy_url: &str,
) -> String {
    let video = &selection.video;
    let audio = &selection.audio;
    // 时长取视频轨 sidx 时间轴，与分片表严格一致；用列表接口的整数秒会与
    // 分片累加值差出小数，尾片可能被播放器判成越界。
    let duration = video.sidx.duration_secs();
    let width = video.width.unwrap_or_default();
    let height = video.height.unwrap_or_default();
    let frame_rate = xml_escape(video.frame_rate.as_deref().unwrap_or("25"));
    let sar = xml_escape(video.sar.as_deref().unwrap_or("1:1"));

    format!(
        r#"<?xml version="1.0" encoding="utf-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT{duration}S" minBufferTime="PT1.5S">
  <Period duration="PT{duration}S">
    <AdaptationSet mimeType="video/mp4">
      <Representation id="{video_id}" mimeType="video/mp4" codecs="{video_codecs}" width="{width}" height="{height}" frameRate="{frame_rate}" sar="{sar}" startWithSAP="{video_sap}" bandwidth="{video_bandwidth}">
        {video_segments}
      </Representation>
    </AdaptationSet>
    <AdaptationSet mimeType="audio/mp4">
      <Representation id="{audio_id}" mimeType="audio/mp4" codecs="{audio_codecs}" startWithSAP="{audio_sap}" bandwidth="{audio_bandwidth}">
        {audio_segments}
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>"#,
        video_id = xml_escape(&video.rep_id),
        video_codecs = xml_escape(&video.codecs),
        video_sap = video.start_with_sap,
        video_bandwidth = video.bandwidth,
        video_segments = segment_list_xml(video, video_proxy_url),
        audio_id = xml_escape(&audio.rep_id),
        audio_codecs = xml_escape(&audio.codecs),
        audio_sap = audio.start_with_sap,
        audio_bandwidth = audio.bandwidth,
        audio_segments = segment_list_xml(audio, audio_proxy_url),
    )
}

// ---------------------------------------------------------------------------
// 选流
// ---------------------------------------------------------------------------

/// 从 playurl 的 dash 负载中挑出一条视频轨与一条音频轨。
///
/// `accept_quality` 列出的是稿件存在的全部档位，而当前身份能实际取到的只有
/// `dash.video[]` 里出现的那些（实测匿名最高 480P）。因此可用性以实际返回的
/// representation 为准，`accept_quality` 只用来给出档位名称。
pub(super) fn select_streams(
    data: &Value,
    request: &VideoPlayRequest,
) -> AppResult<(Value, Value, i64, String, Vec<VideoQuality>)> {
    // PGC 付费墙：非免费分集匿名只给试看 MP4（is_preview=1、error_code=-10403），
    // 没有可解析的 DASH。把上游状态透进报错，用户能看出「需要登录或大会员」
    // 而不是以为客户端坏了。
    let missing_dash_hint = match data.get("is_preview").and_then(Value::as_i64) {
        Some(1) => "该分集需要登录或大会员（当前身份只有试看片段，无 DASH 流）",
        _ => "playurl 缺少 dash（该稿件可能不支持 DASH 或受限）",
    };
    let dash = data
        .get("dash")
        .ok_or_else(|| video_err(missing_dash_hint))?;
    let videos = dash
        .get("video")
        .and_then(Value::as_array)
        .filter(|videos| !videos.is_empty())
        .ok_or_else(|| video_err("playurl 缺少可用视频流"))?;
    let audios = dash
        .get("audio")
        .and_then(Value::as_array)
        .filter(|audios| !audios.is_empty())
        .ok_or_else(|| video_err("playurl 缺少可用音频流"))?;

    let codec = DEFAULT_CODEC;
    // representation 的 `id` 就是该档位的 qn。
    let available: std::collections::BTreeSet<i64> = videos
        .iter()
        .map(|rep| as_i64(rep.get("id").unwrap_or(&Value::Null)))
        .collect();
    let accept_quality = data
        .get("accept_quality")
        .and_then(Value::as_array)
        .map(|list| {
            let labels = data.get("accept_description").and_then(Value::as_array);
            list.iter()
                .enumerate()
                .map(|(index, qn)| {
                    let qn = as_i64(qn);
                    let label = labels
                        .and_then(|labels| labels.get(index))
                        .map(as_str)
                        .filter(|label| !label.is_empty())
                        .unwrap_or_else(|| format!("qn {qn}"));
                    VideoQuality {
                        qn,
                        label,
                        available: available.contains(&qn),
                    }
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    // 先按请求画质与编码筛，逐步放宽：编码匹配的目标画质 → 目标画质任意编码
    // → 编码匹配的最高画质 → 任意最高画质。任何一步都不返回空。
    let pick = |quality: Option<i64>, codec: Option<&str>| -> Option<&Value> {
        videos
            .iter()
            .filter(|rep| {
                quality.is_none_or(|qn| as_i64(rep.get("id").unwrap_or(&Value::Null)) == qn)
            })
            .filter(|rep| {
                codec.is_none_or(|codec| {
                    rep.get("codecs")
                        .map(as_str)
                        .unwrap_or_default()
                        .starts_with(codec)
                })
            })
            .max_by_key(|rep| as_i64(rep.get("bandwidth").unwrap_or(&Value::Null)))
    };
    let video = pick(request.qn, Some(codec))
        .or_else(|| pick(request.qn, None))
        .or_else(|| pick(None, Some(codec)))
        .or_else(|| pick(None, None))
        .ok_or_else(|| video_err("没有可用的视频流"))?;
    let audio = audios
        .iter()
        .max_by_key(|rep| as_i64(rep.get("bandwidth").unwrap_or(&Value::Null)))
        .ok_or_else(|| video_err("没有可用的音频流"))?;

    let quality = as_i64(video.get("id").unwrap_or(&Value::Null));
    let quality_label = accept_quality
        .iter()
        .find(|candidate| candidate.qn == quality)
        .map(|candidate| candidate.label.clone())
        .unwrap_or_else(|| format!("qn {quality}"));
    Ok((
        video.clone(),
        audio.clone(),
        quality,
        quality_label,
        accept_quality,
    ))
}

pub(super) fn segment_base_ranges(rep: &Value) -> AppResult<(u64, u64, u64)> {
    let base = rep
        .get("segment_base")
        .ok_or_else(|| video_err("representation 缺少 segment_base"))?;
    let parse_range = |key: &str| -> AppResult<(u64, u64)> {
        let raw = base
            .get(key)
            .map(as_str)
            .ok_or_else(|| video_err(format!("segment_base 缺少 {key}")))?;
        let (start, end) = raw
            .split_once('-')
            .ok_or_else(|| video_err(format!("segment_base.{key} 格式异常: {raw}")))?;
        Ok((
            start
                .trim()
                .parse()
                .map_err(|_| video_err(format!("{key} 起始非数字")))?,
            end.trim()
                .parse()
                .map_err(|_| video_err(format!("{key} 结束非数字")))?,
        ))
    };
    let (_, init_end) = parse_range("initialization")?;
    let (index_start, index_end) = parse_range("index_range")?;
    Ok((init_end, index_start, index_end))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 构造一个 sidx box。`version` 决定 earliest_pts / first_offset 的宽度。
    fn build_sidx(
        version: u8,
        timescale: u32,
        first_offset: u64,
        entries: &[(u32, u32)],
    ) -> Vec<u8> {
        let mut body = Vec::new();
        body.extend_from_slice(&[0, 0, 0, 0]); // size 占位
        body.extend_from_slice(b"sidx");
        body.push(version);
        body.extend_from_slice(&[0, 0, 0]); // flags
        body.extend_from_slice(&1_u32.to_be_bytes()); // reference_id
        body.extend_from_slice(&timescale.to_be_bytes());
        if version == 0 {
            body.extend_from_slice(&0_u32.to_be_bytes()); // earliest_pts
            body.extend_from_slice(&(first_offset as u32).to_be_bytes());
        } else {
            body.extend_from_slice(&0_u64.to_be_bytes());
            body.extend_from_slice(&first_offset.to_be_bytes());
        }
        body.extend_from_slice(&0_u16.to_be_bytes()); // reserved
        body.extend_from_slice(&(entries.len() as u16).to_be_bytes());
        for (size, duration) in entries {
            // 最高位是 reference_type，置 0 表示媒体分片。
            body.extend_from_slice(&size.to_be_bytes());
            body.extend_from_slice(&duration.to_be_bytes());
            body.extend_from_slice(&0x9000_0000_u32.to_be_bytes()); // SAP
        }
        let len = body.len() as u32;
        body[..4].copy_from_slice(&len.to_be_bytes());
        body
    }

    #[test]
    fn split_init_and_sidx_cuts_at_the_recorded_boundary() {
        // 对齐实测形态：init `0-937`、sidx 从 938 开始。
        let mut merged = vec![0xAA_u8; 938];
        merged.extend_from_slice(b"sidx");
        merged.extend_from_slice(&[0xBB_u8; 20]);
        let (init, sidx) = split_init_and_sidx(&merged, 937).expect("应按边界切开");
        assert_eq!(
            init.len(),
            938,
            "init 段必须含 0..=init_end 共 init_end+1 字节"
        );
        assert!(init.iter().all(|byte| *byte == 0xAA));
        assert_eq!(sidx.len(), 24);
        assert_eq!(&sidx[..4], b"sidx", "sidx 起点不能偏移");
    }

    #[test]
    fn split_init_and_sidx_rejects_truncated_merged_response() {
        // 上游只回了 init 的一部分：既不能把半个 init 当成 init，也不能拿它当 sidx。
        let truncated = vec![0xAA_u8; 100];
        assert!(split_init_and_sidx(&truncated, 937).is_err());
        // 恰好只够 init、没有 sidx：可以切开，sidx 为空（由 parse_sidx 报错）。
        let init_only = vec![0xAA_u8; 938];
        let (init, sidx) = split_init_and_sidx(&init_only, 937).expect("边界上应可切开");
        assert_eq!(init.len(), 938);
        assert!(sidx.is_empty());
    }

    #[test]
    fn sidx_v1_yields_contiguous_byte_and_time_ranges() {
        // 对齐实测形态：version 1、timescale 16000、5s 一片。
        let bytes = build_sidx(
            1,
            16_000,
            0,
            &[(435_496, 80_000), (434_880, 80_000), (200_000, 40_000)],
        );
        let sidx = parse_sidx(&bytes, 1601).expect("sidx 应解析成功");

        assert_eq!(sidx.timescale, 16_000);
        assert_eq!(sidx.segments.len(), 3);
        // 首片起始 = index_range_end + 1 + first_offset。
        assert_eq!(sidx.segments[0].start_byte, 1602);
        assert_eq!(sidx.segments[0].end_byte, 1602 + 435_496 - 1);
        // 字节区间必须首尾相接，不留空洞也不重叠。
        assert_eq!(sidx.segments[1].start_byte, sidx.segments[0].end_byte + 1);
        assert_eq!(sidx.segments[2].start_byte, sidx.segments[1].end_byte + 1);
        // 时间轴同样累加。
        assert_eq!(sidx.segments[0].t_end, 80_000);
        assert_eq!(sidx.segments[1].t_end, 160_000);
        assert_eq!(sidx.segments[2].t_end, 200_000);
        assert_eq!(sidx.duration_secs(), 12.5);
    }

    #[test]
    fn sidx_v0_uses_32_bit_header_fields_and_honours_first_offset() {
        let bytes = build_sidx(0, 1_000, 16, &[(100, 500), (200, 500)]);
        let sidx = parse_sidx(&bytes, 999).expect("sidx v0 应解析成功");
        // first_offset 必须计入首片起始：1000 + 16。
        assert_eq!(sidx.segments[0].start_byte, 1016);
        assert_eq!(sidx.segments[0].end_byte, 1115);
        assert_eq!(sidx.segments[1].start_byte, 1116);
        assert_eq!(sidx.duration_secs(), 1.0);
    }

    #[test]
    fn sidx_rejects_wrong_box_type_and_truncation() {
        let mut wrong = build_sidx(1, 16_000, 0, &[(10, 10)]);
        wrong[4..8].copy_from_slice(b"moof");
        assert!(parse_sidx(&wrong, 0).is_err(), "非 sidx box 必须报错");

        let full = build_sidx(1, 16_000, 0, &[(10, 10), (20, 10)]);
        // 砍掉最后一条 reference，越界读取必须被边界检查拦住。
        assert!(
            parse_sidx(&full[..full.len() - 6], 0).is_err(),
            "截断必须报错"
        );
        assert!(parse_sidx(b"sid", 0).is_err(), "过短输入必须报错");
    }

    fn track_fixture() -> VideoTrack {
        VideoTrack {
            base_url: "https://upos.example.com/media.m4s".into(),
            init_end: 937,
            // init 段字节本身与 MPD 合成无关，占位即可。
            init_bytes: vec![0_u8; 938],
            sidx: Sidx {
                timescale: 16_000,
                segments: vec![
                    SidxSegment {
                        start_byte: 1602,
                        end_byte: 2000,
                        t_end: 80_000,
                    },
                    SidxSegment {
                        start_byte: 2001,
                        end_byte: 3000,
                        t_end: 160_000,
                    },
                ],
            },
            codecs: "avc1.640033".into(),
            bandwidth: 631_556,
            rep_id: "32".into(),
            width: Some(854),
            height: Some(480),
            frame_rate: Some("30.000".into()),
            sar: Some("3844:3843".into()),
            start_with_sap: 1,
        }
    }

    #[test]
    fn mpd_pairs_segment_list_with_precise_timelines_per_track() {
        let mut audio = track_fixture();
        audio.codecs = "mp4a.40.2".into();
        audio.rep_id = "30232".into();
        audio.width = None;
        audio.height = None;
        audio.frame_rate = None;
        audio.sar = None;
        // 音轨 timescale 与视频轨不同（实测形态 48000）：两条时间轴必须各自成立。
        audio.sidx = Sidx {
            timescale: 48_000,
            segments: vec![
                SidxSegment {
                    start_byte: 1602,
                    end_byte: 2000,
                    t_end: 240_000,
                },
                SidxSegment {
                    start_byte: 2001,
                    end_byte: 3000,
                    t_end: 480_000,
                },
            ],
        };
        let selection = VideoPlaySelection {
            video: track_fixture(),
            audio,
            quality: 32,
            quality_label: "清晰 480P".into(),
            accept_quality: Vec::new(),
        };

        let mpd = build_mpd(
            &selection,
            "http://127.0.0.1:5001/live",
            "http://127.0.0.1:5002/live",
        );

        // dash.js 原生支持 SegmentList + SegmentTimeline：第 k 个 <S> 与第 k 个
        // <SegmentURL> 一一对应，逐片字节区间与时刻精确，不需要前端时间轴修补。
        assert!(mpd.contains("<SegmentList"), "必须输出 SegmentList");
        assert!(
            mpd.contains("<SegmentTimeline>"),
            "必须输出 SegmentTimeline"
        );
        assert!(
            mpd.contains(
                r#"<Initialization sourceURL="http://127.0.0.1:5001/live" range="0-937"/>"#
            )
        );
        // 分片共用代理 URL，差异只在 Range；逐片 mediaRange 来自 sidx。
        assert!(mpd.contains(
            r#"<SegmentURL media="http://127.0.0.1:5001/live" mediaRange="1602-2000"/>"#
        ));
        assert!(mpd.contains(
            r#"<SegmentURL media="http://127.0.0.1:5002/live" mediaRange="2001-3000"/>"#
        ));
        assert!(
            !mpd.contains("seg="),
            "不得再给分片拼 seg 查询参数（旧播放器补丁）"
        );
        // 两条轨的 timescale 各自独立：视频 16000、音频 48000。
        assert!(mpd.contains(r#"<SegmentList timescale="16000">"#));
        assert!(mpd.contains(r#"<SegmentList timescale="48000">"#));
        // S 的 t/d 用该轨 sidx 原单位写出。
        assert!(mpd.contains(r#"<S t="0" d="80000"/>"#));
        assert!(mpd.contains(r#"<S t="80000" d="80000"/>"#));
        assert!(mpd.contains(r#"mediaPresentationDuration="PT10S""#));
        assert!(mpd.contains(r#"codecs="avc1.640033""#));
        assert!(mpd.contains(r#"codecs="mp4a.40.2""#));
    }

    #[test]
    fn mpd_segment_timeline_carries_unequal_durations() {
        // 实测形态：中途出现短片（2.7s），总时长因此小于「片数 × 首片时长」。
        // 等长假设（固定 duration 展开时间轴）会让短片后的 seek 选错分片，
        // 这里锁死逐片精确时长。
        let mut video = track_fixture();
        video.sidx.segments = vec![
            SidxSegment {
                start_byte: 1602,
                end_byte: 2000,
                t_end: 80_000,
            },
            SidxSegment {
                start_byte: 2001,
                end_byte: 3000,
                t_end: 160_000,
            },
            SidxSegment {
                start_byte: 3001,
                end_byte: 3500,
                t_end: 203_200,
            },
        ];
        let selection = VideoPlaySelection {
            video: video.clone(),
            audio: video,
            quality: 32,
            quality_label: "清晰 480P".into(),
            accept_quality: Vec::new(),
        };

        let mpd = build_mpd(
            &selection,
            "http://127.0.0.1:5001/live",
            "http://127.0.0.1:5002/live",
        );

        // 逐片 t/d 精确等于 sidx 边界：5s、5s、2.7s（timescale 16000）。
        // 末片若按平均槽位（4.23s）或首片时长（5s）展开，2.7s 片内的任何时刻
        // 都会被算进错误的分片。
        assert!(mpd.contains(r#"<S t="160000" d="43200"/>"#));
        assert!(mpd.contains(r#"mediaPresentationDuration="PT12.7S""#));
    }

    #[test]
    fn mpd_escapes_xml_special_characters_in_urls() {
        let selection = VideoPlaySelection {
            video: track_fixture(),
            audio: track_fixture(),
            quality: 32,
            quality_label: "清晰 480P".into(),
            accept_quality: Vec::new(),
        };
        let mpd = build_mpd(
            &selection,
            "http://127.0.0.1:5001/live?a=1&b=<2>",
            "http://127.0.0.1:5002/live",
        );
        // URL 里的 & 与 < 必须转义，否则 MPD 不是合法 XML。
        assert!(mpd.contains("http://127.0.0.1:5001/live?a=1&amp;b=&lt;2&gt;"));
        assert!(!mpd.contains("live?a=1&b="), "裸 & 会让 MPD 不是合法 XML");
    }

    #[test]
    fn select_streams_prefers_requested_codec_and_marks_locked_qualities() {
        let data = serde_json::json!({
            "accept_quality": [112, 80, 32],
            "accept_description": ["高清 1080P+", "高清 1080P", "清晰 480P"],
            "dash": {
                "video": [
                    { "id": 32, "codecs": "av01.0.08M.08", "bandwidth": 340_895, "base_url": "https://a/av01" },
                    { "id": 32, "codecs": "avc1.640033", "bandwidth": 631_556, "base_url": "https://a/avc1" },
                    { "id": 32, "codecs": "hvc1.1.6.L120.90", "bandwidth": 329_921, "base_url": "https://a/hvc1" },
                ],
                "audio": [
                    { "id": 30216, "codecs": "mp4a.40.2", "bandwidth": 67_224, "base_url": "https://a/a1" },
                    { "id": 30232, "codecs": "mp4a.40.2", "bandwidth": 85_370, "base_url": "https://a/a2" },
                ]
            }
        });

        let (video, audio, quality, label, accept) =
            select_streams(&data, &VideoPlayRequest::default()).expect("选流应成功");
        // 默认必须落在 avc1 上，而不是同画质里带宽更低的 hvc1/av01。
        assert_eq!(video.get("codecs").unwrap(), "avc1.640033");
        assert_eq!(audio.get("base_url").unwrap(), "https://a/a2");
        assert_eq!(quality, 32);
        assert_eq!(label, "清晰 480P");
        // 只有实际返回了 representation 的档位才算可用；1080P 需大会员，标不可用。
        assert_eq!(accept.len(), 3);
        assert!(accept.iter().find(|q| q.qn == 32).unwrap().available);
        assert!(!accept.iter().find(|q| q.qn == 112).unwrap().available);
    }

    #[test]
    fn select_streams_falls_back_when_codec_is_absent() {
        let data = serde_json::json!({
            "dash": {
                "video": [ { "id": 16, "codecs": "hvc1.1.6", "bandwidth": 1, "base_url": "https://a/v" } ],
                "audio": [ { "id": 30216, "codecs": "mp4a.40.2", "bandwidth": 1, "base_url": "https://a/a" } ]
            }
        });
        let request = VideoPlayRequest {
            qn: Some(112),
            ..VideoPlayRequest::default()
        };
        // 请求 1080P + avc1 都不存在时必须回落到唯一可用流，而不是报错。
        let (video, _, quality, _, _) = select_streams(&data, &request).expect("应回落");
        assert_eq!(video.get("codecs").unwrap(), "hvc1.1.6");
        assert_eq!(quality, 16);

        let empty = serde_json::json!({ "dash": { "video": [], "audio": [] } });
        assert!(select_streams(&empty, &VideoPlayRequest::default()).is_err());
        let no_dash = serde_json::json!({ "timelength": 1 });
        assert!(select_streams(&no_dash, &VideoPlayRequest::default()).is_err());
    }

    #[test]
    fn segment_base_ranges_reads_init_and_index_bounds() {
        let rep = serde_json::json!({
            "segment_base": { "initialization": "0-937", "index_range": "938-1601" }
        });
        assert_eq!(segment_base_ranges(&rep).unwrap(), (937, 938, 1601));

        let broken = serde_json::json!({ "segment_base": { "initialization": "0-937", "index_range": "938" } });
        assert!(segment_base_ranges(&broken).is_err());
        assert!(segment_base_ranges(&serde_json::json!({})).is_err());
    }

    #[test]
    fn stream_candidates_prefers_base_then_dedupes_backups() {
        let rep = serde_json::json!({
            "base_url": "https://mcdn.example.com/a.m4s",
            "backup_url": ["https://upos.example.com/a.m4s", "", "https://mcdn.example.com/a.m4s"],
            "backupBaseUrl": ["https://upos-2.example.com/a.m4s"]
        });
        let candidates = stream_candidates(&rep);
        assert_eq!(
            candidates,
            [
                "https://mcdn.example.com/a.m4s",
                "https://upos.example.com/a.m4s",
                "https://upos-2.example.com/a.m4s"
            ]
        );
        assert!(stream_candidates(&serde_json::json!({ "id": 32 })).is_empty());
    }
}
