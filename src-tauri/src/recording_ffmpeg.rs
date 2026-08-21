//! In-process FFmpeg live-stream recorder.
//!
//! Keep every libav context inside one blocking worker. FFmpeg's APIs are
//! synchronous, and moving a context across an `.await` would make both
//! cancellation and ownership substantially harder to reason about.

use std::sync::Arc;

use tokio::sync::watch;

use super::{
    FfmpegRecordingOptions, PlayUrl, RecordingStatus, STORAGE_SPACE_CHECK_INTERVAL, SessionState,
    TaskOutcome, available_storage_space, format_storage_space_error, storage_space_is_low,
};

use std::fs;
use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use ffmpeg::{Dictionary, Error, Packet, Rational, Rescale, codec, encoder, format, media};
use ffmpeg_next as ffmpeg;

static FFMPEG_INIT_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static FFMPEG_READY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
const TIMESTAMP_TIME_BASE: Rational = Rational(1, 1_000_000);
/// Consecutive packets a live stream may fail to write before the recording
/// gives up. A single transient timestamp/muxer anomaly must not end the task.
const MAX_INVALID_WRITE_FAILURES: u32 = 12;
/// How long a started recording may go without writing a single media packet
/// before it is treated as a dead stream.
///
/// `rw_timeout` only covers a socket that stops delivering bytes. A CDN can
/// keep the connection alive while serving nothing usable — the read succeeds,
/// the packets are all discarded, and the file silently stops growing. This is
/// the bound on that case, so the task ends and reports instead of hanging.
const STREAM_STALL_TIMEOUT: Duration = Duration::from_secs(30);

pub(super) async fn run(
    source: PlayUrl,
    proxy: Option<String>,
    options: FfmpegRecordingOptions,
    state: Arc<SessionState>,
    cancel: watch::Receiver<bool>,
) -> TaskOutcome {
    let recovery_state = state.clone();
    let worker = tokio::task::spawn_blocking(move || remux(source, proxy, options, state, cancel));
    match worker.await {
        Ok(outcome) => outcome,
        Err(error) => {
            let message = format!("Rust FFmpeg 录制任务意外终止: {error}");
            // A panic is reported only after the blocking worker has stopped,
            // so its part file is no longer being written. Preserve it now,
            // but let the outer task flush danmaku before finalizing metadata.
            // Cancellation is different: an unstarted blocking task may still
            // be cancelled, while an already-running one can outlive this future.
            if !error.is_cancelled() {
                super::salvage_temporary_media_after_worker_failure(&recovery_state);
            }
            TaskOutcome {
                status: RecordingStatus::Interrupted,
                error: Some(message),
                split: false,
            }
        }
    }
}

fn initialize() -> Result<(), String> {
    if FFMPEG_READY.load(Ordering::Acquire) {
        return Ok(());
    }
    let lock = FFMPEG_INIT_LOCK.get_or_init(|| Mutex::new(()));
    let _guard = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if FFMPEG_READY.load(Ordering::Acquire) {
        return Ok(());
    }
    ffmpeg::init().map_err(|error| format!("初始化 FFmpeg 失败: {error}"))?;
    format::network::init();
    ffmpeg::log::set_level(ffmpeg::log::Level::Error);
    FFMPEG_READY.store(true, Ordering::Release);
    Ok(())
}

fn remux(
    source: PlayUrl,
    proxy: Option<String>,
    recording_options: FfmpegRecordingOptions,
    state: Arc<SessionState>,
    cancel: watch::Receiver<bool>,
) -> TaskOutcome {
    if let Err(error) = initialize() {
        return failed(error);
    }
    let source_protocol = source.protocol;
    let (media_file, output_protocol) = {
        let stored = state
            .stored
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        (stored.media_file.clone(), stored.protocol)
    };
    let muxer = match output_protocol {
        super::PlaybackProtocol::Flv => "flv",
        super::PlaybackProtocol::MpegTs => "mpegts",
        _ => {
            return failed("Rust FFmpeg 仅支持 FLV、HLS 和 MPEG-TS 直播流".into());
        }
    };
    let part = state.bundle.join(format!("{media_file}.part"));
    let final_path = state.bundle.join(media_file);
    let started = Instant::now();

    let mut options = Dictionary::new();
    for (key, value) in build_input_options(&source, proxy.as_deref(), &recording_options) {
        options.set(&key, &value);
    }

    let callback_cancel = cancel.clone();
    let callback_started = started;
    let split_duration = recording_options.split_duration;
    let mut input = match format::input_with_interrupt_and_dictionary(
        &source.url,
        move || {
            *callback_cancel.borrow()
                || split_duration.is_some_and(|limit| callback_started.elapsed() >= limit)
        },
        options,
    ) {
        Ok(input) => input,
        Err(_) if *cancel.borrow() => {
            return interrupted("停止前尚未收到媒体数据".into());
        }
        Err(error) => return failed(format!("Rust FFmpeg 打开直播流失败: {error}")),
    };
    if *cancel.borrow() {
        return interrupted("停止前尚未收到媒体数据".into());
    }
    let mut output = match format::output_as(&part, muxer) {
        Ok(output) => output,
        Err(error) => {
            remove_part(&part);
            return failed(format!("Rust FFmpeg 创建录制文件失败: {error}"));
        }
    };

    let best_video = input
        .streams()
        .best(media::Type::Video)
        .map(|stream| stream.index());
    let best_audio = best_video
        .and_then(|video_index| {
            let video = input.stream(video_index)?;
            input
                .streams()
                .related(&video)
                .best(media::Type::Audio)
                .map(|stream| stream.index())
        })
        .or_else(|| {
            input
                .streams()
                .best(media::Type::Audio)
                .map(|stream| stream.index())
        });
    if source_protocol == super::PlaybackProtocol::Hls {
        discard_unselected_hls_streams(&mut input, best_video, best_audio);
    }
    let mut stream_mapping = vec![-1_i32; input.nb_streams() as usize];
    let mut input_time_bases = vec![Rational(0, 1); input.nb_streams() as usize];
    let mut output_index = 0_i32;
    for (input_index, stream) in input.streams().enumerate() {
        let medium = stream.parameters().medium();
        if !matches!(medium, media::Type::Audio | media::Type::Video) {
            continue;
        }
        if source_protocol == super::PlaybackProtocol::Hls
            && !matches!(
                medium,
                media::Type::Video if best_video == Some(input_index)
            )
            && !matches!(
                medium,
                media::Type::Audio if best_audio == Some(input_index)
            )
        {
            continue;
        }
        stream_mapping[input_index] = output_index;
        input_time_bases[input_index] = stream.time_base();
        let mut output_stream = match output.add_stream(encoder::find(codec::Id::None)) {
            Ok(stream) => stream,
            Err(error) => {
                drop(output);
                remove_part(&part);
                return failed(format!("Rust FFmpeg 创建输出轨道失败: {error}"));
            }
        };
        output_stream.set_parameters(stream.parameters());
        // Container-specific codec tags from the input are not necessarily
        // valid in a fresh output context, even when the container is the same.
        unsafe {
            (*output_stream.parameters().as_mut_ptr()).codec_tag = 0;
        }
        output_index += 1;
    }
    if output_index == 0 {
        drop(output);
        remove_part(&part);
        return failed("Rust FFmpeg 未发现可录制的音视频轨道".into());
    }
    let write_header = if output_protocol == super::PlaybackProtocol::Flv {
        let mut output_options = Dictionary::new();
        // mpegts.js can turn an unbuffered VOD seek into an HTTP Range request
        // only when the FLV metadata contains keyframe byte positions.
        output_options.set("flvflags", "add_keyframe_index");
        output.write_header_with(output_options).map(|_| ())
    } else {
        output.write_header().map(|_| ())
    };
    if let Err(error) = write_header {
        drop(output);
        remove_part(&part);
        return failed(format!("Rust FFmpeg 写入容器头失败: {error}"));
    }

    let mut wrote_packet = false;
    let mut invalid_packets = 0_u32;
    let mut consecutive_write_failures = vec![0_u32; output_index as usize];
    let mut last_progress = Instant::now();
    let mut last_space_check = Instant::now() - STORAGE_SPACE_CHECK_INTERVAL;
    let mut last_written_packet = Instant::now();
    let mut timeline = PacketTimeline::new(input.nb_streams() as usize);
    let stop_reason = loop {
        if *cancel.borrow() {
            break StopReason::Cancelled;
        }
        if recording_options
            .split_duration
            .is_some_and(|limit| started.elapsed() >= limit)
        {
            break StopReason::SplitLimit;
        }
        // Only meaningful once the stream has proven itself: before the first
        // packet the elapsed time is startup probing, not a stall.
        if wrote_packet && last_written_packet.elapsed() >= STREAM_STALL_TIMEOUT {
            break StopReason::Stalled;
        }
        if last_space_check.elapsed() >= STORAGE_SPACE_CHECK_INTERVAL {
            last_space_check = Instant::now();
            match available_storage_space(&state.bundle) {
                Ok(available) if storage_space_is_low(available) => {
                    break StopReason::StorageLow(available);
                }
                Ok(_) => {}
                Err(error) => {
                    tracing::warn!(path = %state.bundle.display(), error = %error, "无法检查录制剩余空间");
                }
            }
        }
        let mut packet = Packet::empty();
        match packet.read(&mut input) {
            Ok(()) => invalid_packets = 0,
            Err(Error::InvalidData) if invalid_packets < 100 => {
                invalid_packets += 1;
                continue;
            }
            Err(Error::Exit) if *cancel.borrow() => break StopReason::Cancelled,
            Err(Error::Exit)
                if recording_options
                    .split_duration
                    .is_some_and(|limit| started.elapsed() >= limit) =>
            {
                break StopReason::SplitLimit;
            }
            Err(Error::Eof) => break StopReason::Failed("直播流已结束".into()),
            Err(error) => {
                break StopReason::Failed(format!("Rust FFmpeg 读取直播流中断: {error}"));
            }
        }

        let input_index = packet.stream();
        // A packet on a stream index that did not exist when the mapping was
        // built means the source started a different program mid-recording.
        // Some CDNs do this after a broadcast ends, serving an unrelated filler
        // stream on the same URL; continuing would append it to the recording.
        let Some(&mapped_index) = stream_mapping.get(input_index) else {
            if wrote_packet {
                break StopReason::SourceChanged;
            }
            continue;
        };
        // A deliberately unselected stream (an unused HLS variant) stays silent.
        if mapped_index < 0 {
            continue;
        }
        let Some(output_stream) = output.stream(mapped_index as usize) else {
            break StopReason::Failed("Rust FFmpeg 输出轨道映射失效".into());
        };
        if let Err(error) = timeline.normalize(&mut packet, input_time_bases[input_index]) {
            break StopReason::Failed(error);
        }
        packet.rescale_ts(input_time_bases[input_index], output_stream.time_base());
        packet.set_position(-1);
        packet.set_stream(mapped_index as usize);
        let packet_size = packet.size() as u64;
        let first_packet = !wrote_packet;
        if let Err(error) = packet.write_interleaved(&mut output) {
            // Counted per track. A single stream can be persistently
            // unwritable — a CDN serving FLV audio that is not valid ADTS is the
            // known case — while the other keeps succeeding. A shared counter
            // would be reset by the healthy track and never reach the limit, so
            // the recording would run on silently dropping every audio packet.
            let failures = consecutive_write_failures
                .get_mut(mapped_index as usize)
                .expect("每个输出轨在建表时都分配了失败计数");
            if *failures < MAX_INVALID_WRITE_FAILURES {
                *failures += 1;
                tracing::warn!(
                    stream = mapped_index,
                    error = %error,
                    "Rust FFmpeg 写入媒体包失败，已跳过该包"
                );
                continue;
            }
            break StopReason::TrackUnwritable {
                stream: mapped_index,
                error: error.to_string(),
            };
        }
        consecutive_write_failures[mapped_index as usize] = 0;
        wrote_packet = true;
        last_written_packet = Instant::now();
        state.bytes.fetch_add(packet_size, Ordering::Relaxed);
        if first_packet || last_progress.elapsed() >= Duration::from_millis(500) {
            update_progress(&state, &part, started);
            last_progress = Instant::now();
        }
    };

    let trailer_error = output
        .write_trailer()
        .err()
        .map(|error| format!("Rust FFmpeg 写入容器尾失败: {error}"));
    drop(output);
    drop(input);
    update_progress(&state, &part, started);

    if !wrote_packet {
        remove_part(&part);
        // Nothing was recorded, so a stop cause other than the two intentional
        // ones is a failure rather than a short recording.
        return match stop_reason {
            StopReason::Cancelled => interrupted("停止前尚未收到媒体数据".into()),
            StopReason::SplitLimit => interrupted("自动分割前尚未收到媒体数据".into()),
            other => failed(join_errors(
                other.error_message().unwrap_or_default(),
                trailer_error,
            )),
        };
    }

    // Media was written, so the file stands on its own. Every unintentional stop
    // cause keeps what was recorded and reports why it ended early.
    let mut outcome = match stop_reason {
        StopReason::Cancelled if trailer_error.is_none() => TaskOutcome {
            status: RecordingStatus::Completed,
            error: None,
            split: false,
        },
        StopReason::SplitLimit if trailer_error.is_none() => TaskOutcome {
            status: RecordingStatus::Completed,
            error: None,
            split: true,
        },
        StopReason::Cancelled | StopReason::SplitLimit => interrupted(trailer_error.unwrap()),
        other => interrupted(join_errors(
            other.error_message().unwrap_or_default(),
            trailer_error,
        )),
    };
    match publish_part(&part, &final_path) {
        Ok(size) => state.bytes.store(size, Ordering::Relaxed),
        Err(error) => {
            outcome.status = RecordingStatus::Failed;
            outcome.split = false;
            outcome.error = Some(join_errors(
                outcome.error.unwrap_or_default(),
                Some(format!("发布 Rust FFmpeg 录制文件失败: {error}")),
            ));
        }
    }
    outcome
}

/// Builds the demuxer options for one recording, as ordered key/value pairs.
///
/// Returned as pairs rather than written into a `Dictionary` so the protocol
/// branches below stay directly testable; `Dictionary` exposes no reader.
fn build_input_options(
    source: &PlayUrl,
    proxy: Option<&str>,
    recording_options: &FfmpegRecordingOptions,
) -> Vec<(String, String)> {
    let mut options: Vec<(String, String)> = Vec::new();
    let mut set = |key: &str, value: String| options.push((key.to_string(), value));

    let headers = ffmpeg_header_block(source);
    if !headers.is_empty() {
        set("headers", headers);
    }
    if let Some(proxy) = proxy.map(str::trim).filter(|value| !value.is_empty()) {
        set("http_proxy", proxy.to_string());
    }
    // A continuous stream announces its codecs in the very first tag, so a tiny
    // probe keeps startup fast and blocking reads inside the manager's 15 second
    // graceful-shutdown window. Segmented sources get a larger budget below.
    if source.protocol != super::PlaybackProtocol::Hls {
        set("probesize", "32768".into());
        set("analyzeduration", "1000000".into());
        set("fpsprobesize", "2".into());
        set("max_probe_packets", "64".into());
    }
    set(
        "rw_timeout",
        recording_options
            .rw_timeout_seconds
            .saturating_mul(1_000_000)
            .to_string(),
    );
    // A corrupt packet is dropped instead of being remuxed into the recording.
    // Without this the demuxer hands truncated slices straight to the muxer and
    // the damage only surfaces later, inside the viewer's decoder.
    set("fflags", "+discardcorrupt".into());

    if source.protocol == super::PlaybackProtocol::Hls {
        // HLS parsing, playlist refreshes, AES-128 keys and byte ranges all
        // stay inside libavformat. Start at the live edge and retry transient
        // segment failures without maintaining a second playlist parser here.
        set("live_start_index", "-1".into());
        // Probing must span the fMP4 init segment plus a whole media segment, or
        // libavformat can open the playlist and still fail to describe the
        // streams. Twitch segments run ~2 MB each, so a 32 KB probe routinely
        // ends inside the init segment. Cancellation is unaffected: the
        // interrupt callback is polled during I/O, not after the probe.
        set("probesize", "8000000".into());
        set("analyzeduration", "10000000".into());
        set("fpsprobesize", "10".into());
        set("max_probe_packets", "512".into());
        set(
            "seg_max_retry",
            recording_options.hls_segment_retry_count.to_string(),
        );
        set("http_persistent", "1".into());
        set("http_multiple", "1".into());
        // Reconnecting is only safe on a segmented protocol, where a retry
        // resumes at a segment boundary.
        //
        // A continuous stream such as FLV must not get these options: on
        // reconnect libavformat resumes at the byte level with no notion of
        // container framing, so the new response — its fresh FLV header and
        // `onMetaData` tag included — lands in the middle of whatever tag was
        // being written. That yields a structurally intact file whose H.264
        // slices contain foreign bytes, which fails only at playback time as
        // `PIPELINE_ERROR_DECODE`. A dropped continuous stream ends the task
        // instead, and the manager records the rest into a new session.
        set("reconnect", "1".into());
        set("reconnect_streamed", "1".into());
        set("reconnect_on_network_error", "1".into());
        set("reconnect_on_http_error", "408,425,429,5xx".into());
        set(
            "reconnect_delay_max",
            recording_options.reconnect_delay_max_seconds.to_string(),
        );
    }

    options
}

enum StopReason {
    Cancelled,
    SplitLimit,
    StorageLow(u64),
    /// The connection stayed open but stopped yielding writable media packets.
    Stalled,
    /// The source began a different program than the one being recorded.
    SourceChanged,
    /// One output track could not accept packets for long enough that the rest
    /// of the recording would be missing it entirely.
    TrackUnwritable {
        stream: i32,
        error: String,
    },
    Failed(String),
}

/// Reported when a stream goes quiet without closing, so the recording ends with
/// a cause the user can act on rather than an open task that never grows.
fn stall_error() -> String {
    format!(
        "直播流 {} 秒内没有新的媒体数据，已停止录制",
        STREAM_STALL_TIMEOUT.as_secs()
    )
}

impl StopReason {
    /// The user-facing reason a recording stopped, for the reasons that carry one.
    fn error_message(&self) -> Option<String> {
        match self {
            Self::Cancelled | Self::SplitLimit => None,
            Self::StorageLow(available) => Some(format_storage_space_error(*available)),
            Self::Stalled => Some(stall_error()),
            Self::SourceChanged => {
                Some("直播源已切换为其他节目，已停止录制以避免混入无关内容".into())
            }
            Self::TrackUnwritable { stream, error } => Some(format!(
                "轨道 {stream} 连续 {MAX_INVALID_WRITE_FAILURES} 个媒体包无法写入，已停止录制: {error}"
            )),
            Self::Failed(error) => Some(error.clone()),
        }
    }
}

pub(super) fn probe_media_duration(path: &Path) -> Result<u64, String> {
    initialize()?;
    let input = format::input(path).map_err(|error| format!("读取录制媒体时长失败: {error}"))?;
    let mut duration_us = input.duration();
    if duration_us <= 0 {
        duration_us = input
            .streams()
            .filter_map(|stream| {
                let duration = stream.duration();
                (duration > 0).then(|| duration.rescale(stream.time_base(), TIMESTAMP_TIME_BASE))
            })
            .max()
            .unwrap_or_default();
    }
    if duration_us <= 0 {
        return Err("录制媒体没有可用时长".into());
    }
    Ok((duration_us as u128 / 1_000).min(u64::MAX as u128) as u64)
}

/// Keep one output epoch for every selected stream. DTS is the decode clock and
/// stays monotonic even when video PTS is reordered by B-frames; shifting both
/// timestamps by the same amount preserves their composition-time difference.
struct PacketTimeline {
    epoch_offset_us: Option<i64>,
    last_input_clock_us: Vec<Option<i64>>,
    last_output_clock_us: Option<i64>,
    previous_epochs: Vec<Option<PreviousEpoch>>,
    rebase_after_synthetic: Vec<bool>,
}

#[derive(Clone, Copy)]
struct PreviousEpoch {
    offset_us: i64,
    cutoff_us: i64,
}

/// Upper bound (in microseconds) for a credible live-stream packet clock.
/// Values beyond this are produced by `AV_NOPTS_VALUE`, by overflow inside
/// libav's rescale, or by truly corrupt source timestamps (常见于斗鱼等 FLV
/// 流在 CDN 切换/重连后发生的跳变). Such packets are rewritten onto a
/// synthetic monotonic clock instead of failing the whole recording.
const MAX_SANE_TIMESTAMP_US: i64 = 1_i64 << 47;
/// Upper bound (in source time-base ticks) for a normalized output timestamp.
const MAX_SANE_TIMESTAMP_TICKS: i64 = 1_i64 << 56;
/// FFmpeg's "no timestamp" sentinel.
const AV_NOPTS_VALUE: i64 = i64::MIN;

/// Treats `AV_NOPTS_VALUE` as an absent timestamp rather than a real value.
fn usable_timestamp(value: Option<i64>) -> Option<i64> {
    value.filter(|value| *value != AV_NOPTS_VALUE)
}

impl PacketTimeline {
    fn new(stream_count: usize) -> Self {
        Self {
            epoch_offset_us: None,
            last_input_clock_us: vec![None; stream_count],
            last_output_clock_us: None,
            previous_epochs: vec![None; stream_count],
            rebase_after_synthetic: vec![false; stream_count],
        }
    }

    fn tick_us(time_base: Rational) -> i64 {
        1_i64
            .rescale(time_base, TIMESTAMP_TIME_BASE)
            .unsigned_abs()
            .max(1) as i64
    }

    fn start_new_epoch(&mut self, stream_index: usize, input_clock_us: i64, time_base: Rational) {
        let old_offset = self.epoch_offset_us.unwrap_or_default();
        let tick_us = Self::tick_us(time_base);
        let next_output = self
            .last_output_clock_us
            .unwrap_or_else(|| tick_us.saturating_neg())
            .saturating_add(tick_us);
        self.epoch_offset_us = Some(next_output.saturating_sub(input_clock_us));
        for (index, previous_input) in self.last_input_clock_us.iter().enumerate() {
            self.previous_epochs[index] = (index != stream_index)
                .then_some(*previous_input)
                .flatten()
                .map(|cutoff_us| PreviousEpoch {
                    offset_us: old_offset,
                    cutoff_us,
                });
        }
        self.previous_epochs[stream_index] = None;
        self.last_input_clock_us[stream_index] = None;
    }

    /// Rewrites a packet whose source timestamps are absent or unrepresentable
    /// onto a monotonic clock that continues right after the last written
    /// packet, so the muxer never sees `NOPTS` or absurd values while the
    /// recording keeps running.
    fn synthesize_timestamps(
        &mut self,
        packet: &mut Packet,
        stream_index: usize,
        time_base: Rational,
    ) {
        let tick_us = Self::tick_us(time_base);
        let synthetic_us = self
            .last_output_clock_us
            .unwrap_or_else(|| tick_us.saturating_neg())
            .saturating_add(tick_us);
        let synthetic_ticks = synthetic_us.rescale(TIMESTAMP_TIME_BASE, time_base);
        packet.set_dts(Some(synthetic_ticks));
        packet.set_pts(Some(synthetic_ticks));
        self.rebase_after_synthetic[stream_index] = true;
        self.last_output_clock_us = Some(
            self.last_output_clock_us
                .map_or(synthetic_us, |previous| previous.max(synthetic_us)),
        );
        tracing::warn!(
            stream = stream_index,
            synthetic_ticks,
            "直播流携带缺失或异常时间戳，已重写为单调时间轴"
        );
    }

    fn normalize(&mut self, packet: &mut Packet, time_base: Rational) -> Result<(), String> {
        let stream_index = packet.stream();
        let Some(mut last_input) = self.last_input_clock_us.get(stream_index).copied() else {
            return Err("Rust FFmpeg 时间轴轨道索引失效".into());
        };
        // `AV_NOPTS_VALUE` must not be treated as a real clock value, or the
        // rescale can overflow and previously aborted the recording with a
        // "时间轴溢出" error. Strip it and fall through to a usable sibling.
        let dts = usable_timestamp(packet.dts());
        let pts = usable_timestamp(packet.pts());
        if packet.dts().is_some() && dts.is_none() {
            packet.set_dts(None);
        }
        if packet.pts().is_some() && pts.is_none() {
            packet.set_pts(None);
        }
        let Some(input_clock) = dts.or(pts) else {
            self.synthesize_timestamps(packet, stream_index, time_base);
            return Ok(());
        };
        let input_clock_us = input_clock.rescale(time_base, TIMESTAMP_TIME_BASE);
        if input_clock_us.saturating_abs() > MAX_SANE_TIMESTAMP_US {
            self.synthesize_timestamps(packet, stream_index, time_base);
            return Ok(());
        }

        let rebase_after_synthetic = self.rebase_after_synthetic[stream_index];
        if rebase_after_synthetic {
            self.rebase_after_synthetic[stream_index] = false;
            self.start_new_epoch(stream_index, input_clock_us, time_base);
            last_input = None;
        }
        let previous_epoch_offset = if rebase_after_synthetic {
            None
        } else {
            self.previous_epochs[stream_index].and_then(|previous| {
                if input_clock_us >= previous.cutoff_us {
                    self.previous_epochs[stream_index] = Some(PreviousEpoch {
                        cutoff_us: input_clock_us,
                        ..previous
                    });
                    Some(previous.offset_us)
                } else {
                    self.previous_epochs[stream_index] = None;
                    self.last_input_clock_us[stream_index] = None;
                    last_input = None;
                    None
                }
            })
        };
        if self.epoch_offset_us.is_none() {
            self.epoch_offset_us = Some(input_clock_us.saturating_neg());
        } else if previous_epoch_offset.is_none()
            && last_input.is_some_and(|previous| input_clock_us < previous)
        {
            // Saturated arithmetic keeps a discontinuous stream alive instead
            // of aborting the recording on an extreme PTS/DTS jump; final
            // outputs are re-validated below before they reach the muxer.
            self.start_new_epoch(stream_index, input_clock_us, time_base);
        }

        let offset_ticks = previous_epoch_offset
            .or(self.epoch_offset_us)
            .unwrap_or_default()
            .rescale(TIMESTAMP_TIME_BASE, time_base);
        let next_pts = pts.map(|value| value.saturating_add(offset_ticks));
        let next_dts = dts.map(|value| value.saturating_add(offset_ticks));
        if next_pts.is_some_and(|value| value.saturating_abs() > MAX_SANE_TIMESTAMP_TICKS)
            || next_dts.is_some_and(|value| value.saturating_abs() > MAX_SANE_TIMESTAMP_TICKS)
        {
            self.synthesize_timestamps(packet, stream_index, time_base);
            return Ok(());
        }
        if let Some(pts) = next_pts {
            packet.set_pts(Some(pts));
        }
        if let Some(dts) = next_dts {
            packet.set_dts(Some(dts));
        }

        let output_clock = packet.dts().or_else(|| packet.pts()).unwrap_or(input_clock);
        let output_clock_us = output_clock.rescale(time_base, TIMESTAMP_TIME_BASE);
        self.last_input_clock_us[stream_index] = Some(input_clock_us);
        self.last_output_clock_us = Some(
            self.last_output_clock_us
                .map_or(output_clock_us, |previous| previous.max(output_clock_us)),
        );
        Ok(())
    }
}

fn discard_unselected_hls_streams(
    input: &mut format::context::Input,
    best_video: Option<usize>,
    best_audio: Option<usize>,
) {
    let selected = |index| best_video == Some(index) || best_audio == Some(index);
    unsafe {
        let context = input.as_mut_ptr();
        for index in 0..(*context).nb_streams as usize {
            let stream = *(*context).streams.add(index);
            if !stream.is_null() {
                (*stream).discard = if selected(index) {
                    ffmpeg::ffi::AVDiscard::AVDISCARD_DEFAULT
                } else {
                    ffmpeg::ffi::AVDiscard::AVDISCARD_ALL
                };
            }
        }

        let selected_program = (0..(*context).nb_programs as usize).find(|&program_index| {
            let program = *(*context).programs.add(program_index);
            if program.is_null() {
                return false;
            }
            (0..(*program).nb_stream_indexes as usize).any(|stream_offset| {
                let stream_index = *(*program).stream_index.add(stream_offset) as usize;
                best_video.map_or(best_audio == Some(stream_index), |video| {
                    video == stream_index
                })
            })
        });
        if let Some(selected_program) = selected_program {
            for program_index in 0..(*context).nb_programs as usize {
                let program = *(*context).programs.add(program_index);
                if !program.is_null() {
                    (*program).discard = if program_index == selected_program {
                        ffmpeg::ffi::AVDiscard::AVDISCARD_DEFAULT
                    } else {
                        ffmpeg::ffi::AVDiscard::AVDISCARD_ALL
                    };
                }
            }
        }
    }
}

fn ffmpeg_header_block(source: &PlayUrl) -> String {
    let mut headers = String::new();
    let mut has_user_agent = false;
    let mut has_accept = false;
    let mut has_accept_encoding = false;
    for (name, value) in &source.headers {
        has_user_agent |= name.eq_ignore_ascii_case("user-agent");
        has_accept |= name.eq_ignore_ascii_case("accept");
        has_accept_encoding |= name.eq_ignore_ascii_case("accept-encoding");
        headers.push_str(name);
        headers.push_str(": ");
        headers.push_str(value);
        headers.push_str("\r\n");
    }
    if !has_user_agent {
        headers.push_str("User-Agent: ");
        headers.push_str(crate::sites::bilibili::DEFAULT_USER_AGENT);
        headers.push_str("\r\n");
    }
    if !has_accept {
        headers.push_str("Accept: */*\r\n");
    }
    if !has_accept_encoding {
        headers.push_str("Accept-Encoding: identity\r\n");
    }
    headers
}

fn update_progress(state: &SessionState, part: &Path, started: Instant) {
    if let Ok(metadata) = fs::metadata(part) {
        state.bytes.store(metadata.len(), Ordering::Relaxed);
    }
    state.duration_ms.store(
        started.elapsed().as_millis().min(u64::MAX as u128) as u64,
        Ordering::Relaxed,
    );
    state.emit_progress();
}

fn publish_part(part: &Path, final_path: &Path) -> std::io::Result<u64> {
    // Windows requires a write-capable handle for FlushFileBuffers, which is
    // what std::fs::File::sync_all uses under the hood.
    let file = fs::OpenOptions::new().read(true).write(true).open(part)?;
    file.sync_all()?;
    drop(file);
    if final_path.exists() {
        fs::remove_file(final_path)?;
    }
    fs::rename(part, final_path)?;
    fs::metadata(final_path).map(|metadata| metadata.len())
}

fn remove_part(part: &Path) {
    let _ = fs::remove_file(part);
}

fn join_errors(primary: String, secondary: Option<String>) -> String {
    match (primary.is_empty(), secondary) {
        (true, Some(secondary)) => secondary,
        (false, Some(secondary)) => format!("{primary}; {secondary}"),
        (_, None) => primary,
    }
}

fn failed(error: String) -> TaskOutcome {
    TaskOutcome {
        status: RecordingStatus::Failed,
        error: Some(error),
        split: false,
    }
}

fn interrupted(error: String) -> TaskOutcome {
    TaskOutcome {
        status: RecordingStatus::Interrupted,
        error: Some(error),
        split: false,
    }
}

#[cfg(test)]
mod tests {
    use super::super::PlaybackProtocol;
    use super::{
        FfmpegRecordingOptions, PacketTimeline, PlayUrl, STREAM_STALL_TIMEOUT, StopReason,
        build_input_options, publish_part,
    };
    use ffmpeg_next::{Packet, Rational};
    use std::fs;
    use std::io::Write;

    /// Opens the warmed recording proxy through the *in-process* libavformat
    /// binding with the real `build_input_options` dictionary — the exact call
    /// the recording performs. The CLI smoke test in `stream_proxy` proves the
    /// proxy serves media; this one proves the option set the recording itself
    /// passes can also describe those streams.
    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "live Twitch in-process demux; requires TWITCH_VARIANT_URL and external network"]
    async fn live_twitch_recording_options_open_the_warmed_proxy_in_process() {
        let variant = std::env::var("TWITCH_VARIANT_URL").expect("TWITCH_VARIANT_URL");
        let mut headers = std::collections::HashMap::new();
        headers.insert(
            "user-agent".to_string(),
            crate::sites::twitch::DEFAULT_USER_AGENT.to_string(),
        );
        headers.insert(
            "referer".to_string(),
            "https://www.twitch.tv/dota2ti".to_string(),
        );
        let proxy = crate::stream_proxy::StreamProxy::new();
        let session_id = "recording:live-inproc";
        let local = proxy
            .start(
                variant,
                headers,
                session_id.into(),
                true,
                None,
                Some(crate::models::live::TwitchAdRecovery {
                    login: "dota2ti".into(),
                    selector: "video-group:chunked".into(),
                    target_width: 1920,
                    target_height: 1080,
                    target_frame_rate_milli: 60_000,
                }),
            )
            .await
            .expect("recording proxy");
        proxy
            .wait_for_playable_manifest(
                &local,
                session_id,
                crate::stream_proxy::TWITCH_RECORDING_WARMUP_BUDGET,
            )
            .await
            .expect("warm-up");

        let mut source =
            PlayUrl::inferred("twitch:chunked", "Twitch HLS", 0, local, Default::default());
        source.protocol = PlaybackProtocol::Hls;
        let options = build_input_options(&source, None, &FfmpegRecordingOptions::default());
        for (key, value) in &options {
            eprintln!("option {key}={value}");
        }
        let url = source.url.clone();
        let opened = tokio::task::spawn_blocking(move || {
            super::initialize().expect("ffmpeg init");
            let mut dictionary = ffmpeg_next::Dictionary::new();
            for (key, value) in &options {
                dictionary.set(key, value);
            }
            ffmpeg_next::format::input_with_interrupt_and_dictionary(&url, || false, dictionary)
                .map(|input| {
                    input
                        .streams()
                        .map(|stream| format!("{:?}", stream.parameters().medium()))
                        .collect::<Vec<_>>()
                })
        })
        .await
        .expect("demux task");
        proxy.stop_for_session(session_id);
        match opened {
            Ok(streams) => eprintln!("in-process open ok streams={streams:?}"),
            Err(error) => panic!("in-process open failed: {error}"),
        }
    }

    #[test]
    fn publish_part_flushes_with_a_write_capable_handle_before_rename() {
        let root =
            std::env::temp_dir().join(format!("rlive-ffmpeg-publish-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let part = root.join("stream.flv.part");
        let final_path = root.join("stream.flv");
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&part)
            .unwrap();
        file.write_all(b"flushed media").unwrap();
        drop(file);

        let size = publish_part(&part, &final_path).unwrap();
        assert_eq!(size, b"flushed media".len() as u64);
        assert!(!part.exists());
        assert_eq!(fs::read(&final_path).unwrap(), b"flushed media");
        fs::remove_dir_all(root).unwrap();
    }

    fn source(protocol: PlaybackProtocol) -> PlayUrl {
        PlayUrl {
            source_id: "test".into(),
            label: "test".into(),
            protocol,
            priority: 0,
            url: "https://example.com/live".into(),
            headers: Default::default(),
            twitch_ad_recovery: None,
        }
    }

    fn option_keys(options: &[(String, String)]) -> Vec<&str> {
        options.iter().map(|(key, _)| key.as_str()).collect()
    }

    /// The reconnect options splice a reconnected response into the middle of an
    /// FLV tag, so a continuous stream must never receive them.
    #[test]
    fn reconnect_options_are_limited_to_segmented_sources() {
        let recording_options = FfmpegRecordingOptions::default();
        const RECONNECT_KEYS: [&str; 5] = [
            "reconnect",
            "reconnect_streamed",
            "reconnect_on_network_error",
            "reconnect_on_http_error",
            "reconnect_delay_max",
        ];

        for protocol in [PlaybackProtocol::Flv, PlaybackProtocol::MpegTs] {
            let options = build_input_options(&source(protocol), None, &recording_options);
            let keys = option_keys(&options);
            for key in RECONNECT_KEYS {
                assert!(
                    !keys.contains(&key),
                    "{protocol:?} 不应带重连参数，但出现了 {key}"
                );
            }
            assert!(!keys.contains(&"seg_max_retry"));
        }

        let options = build_input_options(&source(PlaybackProtocol::Hls), None, &recording_options);
        let keys = option_keys(&options);
        for key in RECONNECT_KEYS {
            assert!(keys.contains(&key), "HLS 应带重连参数 {key}");
        }
        assert!(keys.contains(&"seg_max_retry"));
    }

    /// A 32 KB probe routinely ends inside a Twitch fMP4 init segment, so the
    /// demuxer opens the playlist and still cannot describe the streams. HLS
    /// therefore probes far past one segment, while a continuous stream keeps the
    /// tiny budget its first tag already satisfies.
    #[test]
    fn hls_probes_past_one_segment_while_continuous_streams_stay_small() {
        let recording_options = FfmpegRecordingOptions::default();
        let value = |options: &[(String, String)], key: &str| {
            options
                .iter()
                .find(|(option_key, _)| option_key == key)
                .map(|(_, value)| value.clone())
        };

        let hls = build_input_options(&source(PlaybackProtocol::Hls), None, &recording_options);
        let probesize = value(&hls, "probesize").expect("HLS 缺少 probesize");
        assert!(
            probesize.parse::<u64>().unwrap() >= 4_000_000,
            "HLS probesize 应覆盖初始化分片与一个媒体分片，实际为 {probesize}"
        );
        let analyzeduration = value(&hls, "analyzeduration").expect("HLS 缺少 analyzeduration");
        assert!(analyzeduration.parse::<u64>().unwrap() >= 5_000_000);
        assert_eq!(
            hls.iter()
                .filter(|(key, _)| key == "probesize" || key == "analyzeduration")
                .count(),
            2,
            "同一个参数不应被写入两次"
        );

        for protocol in [PlaybackProtocol::Flv, PlaybackProtocol::MpegTs] {
            let options = build_input_options(&source(protocol), None, &recording_options);
            assert_eq!(value(&options, "probesize").as_deref(), Some("32768"));
            assert_eq!(
                value(&options, "analyzeduration").as_deref(),
                Some("1000000")
            );
        }
    }

    /// A corrupt packet must be dropped by the demuxer on every protocol rather
    /// than remuxed into the recording.
    #[test]
    fn corrupt_packets_are_discarded_on_every_protocol() {
        let recording_options = FfmpegRecordingOptions::default();
        for protocol in [
            PlaybackProtocol::Flv,
            PlaybackProtocol::MpegTs,
            PlaybackProtocol::Hls,
        ] {
            let options = build_input_options(&source(protocol), None, &recording_options);
            assert!(
                options
                    .iter()
                    .any(|(key, value)| key == "fflags" && value.contains("discardcorrupt")),
                "{protocol:?} 缺少 +discardcorrupt"
            );
        }
    }

    #[test]
    fn reconnect_delay_and_segment_retry_come_from_settings() {
        let recording_options = FfmpegRecordingOptions {
            rw_timeout_seconds: 12,
            reconnect_delay_max_seconds: 21,
            hls_segment_retry_count: 7,
            split_duration: None,
        };
        let options = build_input_options(&source(PlaybackProtocol::Hls), None, &recording_options);
        let value = |key: &str| {
            options
                .iter()
                .find(|(option_key, _)| option_key == key)
                .map(|(_, value)| value.as_str())
        };
        assert_eq!(value("reconnect_delay_max"), Some("21"));
        assert_eq!(value("seg_max_retry"), Some("7"));
        assert_eq!(value("rw_timeout"), Some("12000000"));
    }

    #[test]
    fn blank_proxy_is_not_forwarded_to_the_demuxer() {
        let recording_options = FfmpegRecordingOptions::default();
        let flv = source(PlaybackProtocol::Flv);
        let blank = build_input_options(&flv, Some("   "), &recording_options);
        assert!(!option_keys(&blank).contains(&"http_proxy"));
        let padded = build_input_options(&flv, Some(" http://127.0.0.1:1080 "), &recording_options);
        assert!(option_keys(&padded).contains(&"http_proxy"));
    }

    /// The two intentional stops carry no error; every other cause must explain
    /// itself, or a recording would end with a blank reason.
    #[test]
    fn only_intentional_stops_have_no_error_message() {
        assert_eq!(StopReason::Cancelled.error_message(), None);
        assert_eq!(StopReason::SplitLimit.error_message(), None);

        for reason in [
            StopReason::Stalled,
            StopReason::SourceChanged,
            StopReason::StorageLow(1024),
            StopReason::TrackUnwritable {
                stream: 1,
                error: "boom".into(),
            },
            StopReason::Failed("读取中断".into()),
        ] {
            let message = reason.error_message();
            assert!(
                message
                    .as_deref()
                    .is_some_and(|text| !text.trim().is_empty()),
                "停止原因缺少可读说明"
            );
        }
    }

    #[test]
    fn a_stall_reports_the_timeout_it_waited() {
        let message = StopReason::Stalled.error_message().unwrap();
        assert!(
            message.contains(&STREAM_STALL_TIMEOUT.as_secs().to_string()),
            "停滞说明应包含等待秒数: {message}"
        );
    }

    #[test]
    fn an_unwritable_track_reports_which_track_and_why() {
        let message = StopReason::TrackUnwritable {
            stream: 3,
            error: "ADTS 缺失".into(),
        }
        .error_message()
        .unwrap();
        assert!(message.contains('3'), "应指明轨道编号: {message}");
        assert!(message.contains("ADTS 缺失"), "应保留底层错误: {message}");
    }

    fn packet(stream: usize, dts: i64, pts: i64) -> Packet {
        let mut packet = Packet::empty();
        packet.set_stream(stream);
        packet.set_dts(Some(dts));
        packet.set_pts(Some(pts));
        packet
    }

    #[test]
    fn packet_timeline_zeroes_a_high_start_without_changing_b_frame_delay() {
        let mut timeline = PacketTimeline::new(1);
        let mut packet = packet(0, 7_200_000, 7_200_040);

        timeline.normalize(&mut packet, Rational(1, 1_000)).unwrap();

        assert_eq!(packet.dts(), Some(0));
        assert_eq!(packet.pts(), Some(40));
    }

    #[test]
    fn packet_timeline_uses_one_shared_offset_after_a_clock_reset() {
        let mut timeline = PacketTimeline::new(2);
        let time_base = Rational(1, 1_000);
        let mut packets = [
            packet(0, 10_000, 10_040),
            packet(1, 10_020, 10_020),
            packet(0, 11_000, 11_040),
            packet(1, 11_020, 11_020),
            packet(0, 0, 40),
            packet(1, 11_040, 11_040),
            packet(1, 20, 20),
            packet(0, 1_000, 1_040),
        ];
        for packet in &mut packets {
            timeline.normalize(packet, time_base).unwrap();
        }

        assert_eq!(packets[4].dts(), Some(1_021));
        assert_eq!(packets[4].pts(), Some(1_061));
        assert_eq!(packets[5].dts(), Some(1_040));
        assert_eq!(packets[6].dts(), Some(1_041));
        assert_eq!(packets[7].dts(), Some(2_021));
        assert_eq!(packets[7].pts().unwrap() - packets[7].dts().unwrap(), 40);
    }

    #[test]
    fn packet_timeline_does_not_treat_equal_dts_as_a_clock_reset() {
        let mut timeline = PacketTimeline::new(1);
        let time_base = Rational(1, 1_000);
        let mut packets = [
            packet(0, 5_000, 5_000),
            packet(0, 5_000, 5_040),
            packet(0, 6_000, 6_040),
        ];
        for packet in &mut packets {
            timeline.normalize(packet, time_base).unwrap();
        }

        assert_eq!(packets[0].dts(), Some(0));
        assert_eq!(packets[1].dts(), Some(0));
        assert_eq!(packets[2].dts(), Some(1_000));
    }

    #[test]
    fn packet_timeline_ignores_nopts_dts_and_uses_pts() {
        let mut timeline = PacketTimeline::new(1);
        let mut packet = packet(0, i64::MIN, 5_000);
        let time_base = Rational(1, 1_000);

        timeline.normalize(&mut packet, time_base).unwrap();

        // AV_NOPTS_VALUE dts is cleared instead of overflowing the offset;
        // the packet keeps its usable pts on the normalized timeline.
        assert_eq!(packet.dts(), None);
        assert_eq!(packet.pts(), Some(0));
    }

    #[test]
    fn packet_timeline_rewrites_absurd_timestamps_onto_monotonic_clock() {
        let mut timeline = PacketTimeline::new(1);
        let time_base = Rational(1, 1_000);
        let mut packets = [
            packet(0, i64::MAX, i64::MAX),
            packet(0, i64::MIN, i64::MIN),
            packet(0, 5_000, 5_040),
        ];
        for packet in &mut packets {
            timeline.normalize(packet, time_base).unwrap();
        }

        // Every output timestamp stays inside a sane envelope and remains
        // monotonic across the synthetic-to-real transition.
        let dts: Vec<Option<i64>> = packets.iter().map(|packet| packet.dts()).collect();
        assert!(dts[0].is_some());
        assert!(dts[1].is_some());
        assert!(packets[1].dts().unwrap() > packets[0].dts().unwrap());
        assert!(packets[2].dts().unwrap() > packets[1].dts().unwrap());
        assert_eq!(packets[2].dts(), Some(2));
        assert_eq!(packets[2].pts(), Some(42));
        for packet in &packets {
            let dts = packet.dts().unwrap();
            let pts = packet.pts().unwrap();
            assert!(dts.saturating_abs() < 1_i64 << 40);
            assert!(pts.saturating_abs() < 1_i64 << 40);
        }
    }
}
