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
    let headers = ffmpeg_header_block(&source);
    if !headers.is_empty() {
        options.set("headers", &headers);
    }
    if let Some(proxy) = proxy
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        options.set("http_proxy", proxy);
    }
    // Keep blocking reads inside the manager's 15 second graceful-shutdown
    // window even if a protocol handler temporarily misses the interrupt flag.
    options.set("probesize", "32768");
    options.set("analyzeduration", "1000000");
    options.set("fpsprobesize", "2");
    options.set("max_probe_packets", "64");
    let rw_timeout_us = recording_options
        .rw_timeout_seconds
        .saturating_mul(1_000_000)
        .to_string();
    let reconnect_delay_max = recording_options.reconnect_delay_max_seconds.to_string();
    options.set("rw_timeout", &rw_timeout_us);
    options.set("reconnect", "1");
    options.set("reconnect_streamed", "1");
    options.set("reconnect_on_network_error", "1");
    options.set("reconnect_on_http_error", "408,425,429,5xx");
    options.set("reconnect_delay_max", &reconnect_delay_max);
    if source_protocol == super::PlaybackProtocol::Hls {
        // HLS parsing, playlist refreshes, AES-128 keys and byte ranges all
        // stay inside libavformat. Start at the live edge and retry transient
        // segment failures without maintaining a second playlist parser here.
        options.set("live_start_index", "-1");
        let segment_retry_count = recording_options.hls_segment_retry_count.to_string();
        options.set("seg_max_retry", &segment_retry_count);
        options.set("http_persistent", "1");
        options.set("http_multiple", "1");
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
    let mut last_progress = Instant::now();
    let mut last_space_check = Instant::now() - STORAGE_SPACE_CHECK_INTERVAL;
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
        let Some(&mapped_index) = stream_mapping.get(input_index) else {
            continue;
        };
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
            break StopReason::Failed(format!("Rust FFmpeg 写入媒体包失败: {error}"));
        }
        wrote_packet = true;
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
        return match stop_reason {
            StopReason::Cancelled => interrupted("停止前尚未收到媒体数据".into()),
            StopReason::SplitLimit => interrupted("自动分割前尚未收到媒体数据".into()),
            StopReason::StorageLow(available) => failed(join_errors(
                format_storage_space_error(available),
                trailer_error,
            )),
            StopReason::Failed(error) => failed(join_errors(error, trailer_error)),
        };
    }

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
        StopReason::StorageLow(available) => interrupted(join_errors(
            format_storage_space_error(available),
            trailer_error,
        )),
        StopReason::Cancelled => interrupted(trailer_error.unwrap()),
        StopReason::SplitLimit => interrupted(trailer_error.unwrap()),
        StopReason::Failed(error) => interrupted(join_errors(error, trailer_error)),
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

enum StopReason {
    Cancelled,
    SplitLimit,
    StorageLow(u64),
    Failed(String),
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
}

#[derive(Clone, Copy)]
struct PreviousEpoch {
    offset_us: i64,
    cutoff_us: i64,
}

impl PacketTimeline {
    fn new(stream_count: usize) -> Self {
        Self {
            epoch_offset_us: None,
            last_input_clock_us: vec![None; stream_count],
            last_output_clock_us: None,
            previous_epochs: vec![None; stream_count],
        }
    }

    fn normalize(&mut self, packet: &mut Packet, time_base: Rational) -> Result<(), String> {
        let stream_index = packet.stream();
        let Some(mut last_input) = self.last_input_clock_us.get(stream_index).copied() else {
            return Err("Rust FFmpeg 时间轴轨道索引失效".into());
        };
        let Some(input_clock) = packet.dts().or_else(|| packet.pts()) else {
            return Ok(());
        };
        let input_clock_us = input_clock.rescale(time_base, TIMESTAMP_TIME_BASE);

        let previous_epoch_offset = self.previous_epochs[stream_index].and_then(|previous| {
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
        });
        if self.epoch_offset_us.is_none() {
            self.epoch_offset_us = Some(
                input_clock_us
                    .checked_neg()
                    .ok_or_else(|| "Rust FFmpeg 无法归一化直播流起始时间戳".to_string())?,
            );
        } else if previous_epoch_offset.is_none()
            && last_input.is_some_and(|previous| input_clock_us < previous)
        {
            let old_offset = self.epoch_offset_us.unwrap_or_default();
            let tick_us = 1_i64
                .rescale(time_base, TIMESTAMP_TIME_BASE)
                .unsigned_abs()
                .max(1) as i64;
            let next_output = self
                .last_output_clock_us
                .unwrap_or(-tick_us)
                .checked_add(tick_us)
                .ok_or_else(|| "Rust FFmpeg 直播流时间轴溢出".to_string())?;
            self.epoch_offset_us = Some(
                next_output
                    .checked_sub(input_clock_us)
                    .ok_or_else(|| "Rust FFmpeg 直播流时间轴溢出".to_string())?,
            );
            for (index, previous_input) in self.last_input_clock_us.iter().enumerate() {
                self.previous_epochs[index] = (index != stream_index)
                    .then_some(*previous_input)
                    .flatten()
                    .map(|cutoff_us| PreviousEpoch {
                        offset_us: old_offset,
                        cutoff_us,
                    });
            }
            self.last_input_clock_us[stream_index] = None;
        }

        let offset_ticks = previous_epoch_offset
            .or(self.epoch_offset_us)
            .unwrap_or_default()
            .rescale(TIMESTAMP_TIME_BASE, time_base);
        if let Some(pts) = packet.pts() {
            packet.set_pts(Some(
                pts.checked_add(offset_ticks)
                    .ok_or_else(|| "Rust FFmpeg PTS 时间轴溢出".to_string())?,
            ));
        }
        if let Some(dts) = packet.dts() {
            packet.set_dts(Some(
                dts.checked_add(offset_ticks)
                    .ok_or_else(|| "Rust FFmpeg DTS 时间轴溢出".to_string())?,
            ));
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
    use super::{PacketTimeline, publish_part};
    use ffmpeg_next::{Packet, Rational};
    use std::fs;
    use std::io::Write;

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
}
