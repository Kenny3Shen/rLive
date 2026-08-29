//! 进程内 FFmpeg 直播录制器。
//!
//! 把所有 libav 上下文都留在同一个阻塞 worker 内。FFmpeg 的 API 是同步的，
//! 让上下文跨越 `.await` 移动会显著增加取消与所有权
//! 两方面的推理难度。

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
/// 直播流在录制放弃之前允许的连续写入失败数据包数。
/// 一次瞬态的时间戳/封装异常不应结束任务。
const MAX_INVALID_WRITE_FAILURES: u32 = 12;
/// 直播流在录制放弃之前允许产生的连续不可解码读取次数。直播 CDN 上出现
/// 瞬时损坏很正常；但始终无法恢复的源不是。
const MAX_INVALID_READS: u32 = 100;
/// 已开始的录制在不写出任何媒体数据包的情况下，最多可以持续多久才被视为
/// 死流。
///
/// `rw_timeout` 只覆盖停止交付字节的套接字。CDN 可能保持连接存活却不提供
/// 任何可用内容 —— 读取成功、数据包全被丢弃、文件静默停止增长。
/// 这个上限就是针对该情况：任务结束并报告原因，而不是一直挂着。
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
            // panic 只在阻塞 worker 停止之后才被上报，因此它的分片文件已不再被写入。
            // 现在先保留它，让外层任务先冲刷弹幕再收尾元数据。
            // 取消则不同：尚未启动的阻塞任务仍可被取消，
            // 而已经在运行的任务可能比这个 future 活得更久。
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
        Err(error) => {
            return failed(open_failure_message(&source.url, proxy.as_deref(), error));
        }
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
        // 来自输入的容器特定 codec tag 不一定能直接用于新建的输出上下文，
        // 即使容器类型相同。
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
        // 只有当 FLV 元数据包含关键帧字节位置时，mpegts.js 才能把无缓冲的 VOD seek
        // 转换为 HTTP Range 请求。
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
        // 只有在流证明了自己之后才有意义：首个数据包之前的耗时属于启动探测，
        // 而不是停滞。
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
            Err(error) => {
                let split_due = recording_options
                    .split_duration
                    .is_some_and(|limit| started.elapsed() >= limit);
                match classify_read_failure(error, *cancel.borrow(), split_due, invalid_packets) {
                    ReadFailure::Retry => {
                        invalid_packets += 1;
                        continue;
                    }
                    ReadFailure::Stop(reason) => break reason,
                }
            }
        }

        let input_index = packet.stream();
        // 数据包所属的流索引在构建映射时尚不存在，说明源在录制中途切换了节目。
        // 部分 CDN 在直播结束后会这样做，在同一 URL 上提供无关的填充流；
        // 继续录制会把它追加进文件。
        let Some(&mapped_index) = stream_mapping.get(input_index) else {
            if wrote_packet {
                break StopReason::SourceChanged;
            }
            continue;
        };
        // 刻意未选择的流（未使用的 HLS 变体）保持安静。
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
            // 按轨道计数。单一轨道可能持续不可写 —— 已知案例是 CDN 下发的 FLV 音频
            // 不是合法 ADTS —— 而另一条轨道持续成功。共享计数器会被健康轨道重置、
            // 永远达不到上限，录制就会一边静默丢弃所有音频包一边继续运行。
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
        // 没有记录到任何内容，因此除两种有意为之的情况之外的任何停止原因
        // 都属于失败，而不是短录制。
        return match stop_reason {
            StopReason::Cancelled => interrupted("停止前尚未收到媒体数据".into()),
            StopReason::SplitLimit => interrupted("自动分割前尚未收到媒体数据".into()),
            other => failed(join_errors(
                other.error_message().unwrap_or_default(),
                trailer_error,
            )),
        };
    }

    // 已经写入了媒体内容，因此文件可以独立成立。每个非预期的停止原因都会保留
    // 已录制的部分，并报告提前结束的原因。
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

/// 为一场录制构建解复用器选项，以有序键值对的形式返回。
///
/// 以键值对返回而不是写入 `Dictionary`，使下方的协议分支保持可直接测试；
/// `Dictionary` 不提供读取接口。
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
    // 连续流会在第一个 tag 中就声明其编解码器，因此很小的探测值既能保证启动
    // 迅速，又把阻塞读取限制在 manager 15 秒优雅关机窗口之内。
    // 分片源在下方获得更大的预算。
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
    // 损坏的数据包被丢弃，而不是重新封装进录制。没有这一步，解复用器会把截断
    // 的切片直接交给封装器，损伤只会在稍后于观看者的解码器中暴露。
    set("fflags", "+discardcorrupt".into());

    if source.protocol == super::PlaybackProtocol::Hls {
        // HLS 解析、播放列表刷新、AES-128 密钥和字节范围全部留在 libavformat 内部。
        // 从直播边缘开始，对瞬态分片失败自动重试，
        // 无需在这里维护第二套播放列表解析器。
        set("live_start_index", "-1".into());
        // 探测必须覆盖 fMP4 init 分片加上完整的媒体分片，否则 libavformat 可能打开
        // 了播放列表却仍然无法描述各个流。Twitch 的分片约 2 MB 一个，
        // 32 KB 探测经常停在 init 分片内部。取消不受影响：
        // 中断回调在 I/O 期间轮询，而不是在探测之后。
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
        // 只有分段协议上重连才是安全的，重试可以从分片边界恢复。
        //
        // FLV 这类连续流绝不能拿到这些选项：重连时 libavformat 从字节层面恢复，
        // 完全不了解容器分帧，于是新响应 —— 包括全新的 FLV 头和 `onMetaData`
        // tag —— 会落进上一个正在写入的 tag 中间。结果是结构完整、H.264 切片中却
        // 混入外来字节的文件，只在播放时以 `PIPELINE_ERROR_DECODE` 失败。
        // 连续流断开时直接结束任务，剩余内容由 manager 记入新会话。
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

/// 一次失败的解复用器读取对录制意味着什么。
#[derive(Debug, PartialEq, Eq)]
enum ReadFailure {
    /// 可恢复的损坏数据包：再次读取，而不是结束录制。
    Retry,
    Stop(StopReason),
}

/// 把一次解复用器读取错误映射为录制停止的原因。
///
/// `cancelled` 和 `split_due` 正是中断回调上报的两类条件，且它们先于错误本身
/// 被检查。一旦回调要求 libavformat 中止，随后出现的任何错误描述的都是这次
/// 被中止的 I/O，与流本身无关：FFmpeg 的 HLS 解复用器把被打断的分片抓取
/// 报告为 `AVERROR_EOF` 而不是 `AVERROR_EXIT`。把它当成真正的流结束，
/// 曾让一场完好的录制以 `interrupted` 和「直播流已结束」收场，
/// 尽管用户按下的是停止键、磁盘上的文件也是完整的。
fn classify_read_failure(
    error: Error,
    cancelled: bool,
    split_due: bool,
    invalid_packets: u32,
) -> ReadFailure {
    if cancelled {
        return ReadFailure::Stop(StopReason::Cancelled);
    }
    if split_due {
        return ReadFailure::Stop(StopReason::SplitLimit);
    }
    match error {
        Error::InvalidData if invalid_packets < MAX_INVALID_READS => ReadFailure::Retry,
        Error::Eof => ReadFailure::Stop(StopReason::Failed("直播流已结束".into())),
        error => ReadFailure::Stop(StopReason::Failed(format!(
            "Rust FFmpeg 读取直播流中断: {error}"
        ))),
    }
}

#[derive(Debug, PartialEq, Eq)]
enum StopReason {
    Cancelled,
    SplitLimit,
    StorageLow(u64),
    /// 连接保持打开，但不再产出可写的媒体数据包。
    Stalled,
    /// 源开始了一个不同于正在录制内容的节目。
    SourceChanged,
    /// 某条输出轨道长时间无法接受数据包，导致录制剩余部分完全缺失它。
    TrackUnwritable {
        stream: i32,
        error: String,
    },
    Failed(String),
}

/// 在流静默但未关闭时上报，使录制以用户可以采取行动的原因结束，
/// 而不是留下一个永不增长的任务。
fn stall_error() -> String {
    format!(
        "直播流 {} 秒内没有新的媒体数据，已停止录制",
        STREAM_STALL_TIMEOUT.as_secs()
    )
}

impl StopReason {
    /// 录制停止的用户可见原因（仅限带有原因的那些情况）。
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

/// 为每条选中的流维护独立的输出纪元。DTS 是解码时钟，即使视频 PTS 因
/// B 帧而乱序也保持单调；两个时间戳平移相同量即可保持它们的组合时间差。
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

/// 可信直播数据包时钟的上限（微秒）。超过该值的取值来自 `AV_NOPTS_VALUE`、
/// libav 重缩放中的溢出，或真正损坏的源时间戳（常见于斗鱼等 FLV 流在 CDN
/// 切换/重连后发生的跳变）。这类数据包会被改写到合成的单调时钟上，
/// 而不是让整场录制失败。
const MAX_SANE_TIMESTAMP_US: i64 = 1_i64 << 47;
/// 归一化输出时间戳的上限（以源 time-base tick 计）。
const MAX_SANE_TIMESTAMP_TICKS: i64 = 1_i64 << 56;
/// FFmpeg 的"无时间戳"哨兵值。
const AV_NOPTS_VALUE: i64 = i64::MIN;

/// 把 `AV_NOPTS_VALUE` 视为缺失的时间戳，而不是真实取值。
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

    /// 当源时间戳缺失或无法表示时，把数据包改写到紧接最后一个已写入数据包的
    /// 单调时钟上，使封装器既看不到 `NOPTS` 也看不到荒谬取值，
    /// 同时录制继续保持运行。
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
        // 不能把 `AV_NOPTS_VALUE` 当作真实时钟值，否则重缩放可能溢出，
        // 此前曾以"时间轴溢出"错误中止录制。剥离它并落到可用的同侧取值上。
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
            // 饱和运算让不连续的流得以存活，而不是在极端 PTS/DTS 跳变上中止录制；
            // 最终输出在下方向封装器提交前还会重新校验。
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

/// 把 FFmpeg 打开输入失败的错误转换为用户可见消息。
///
/// HTTPS 直播流经代理录制时，libavformat 的 tls 协议会把连接交给
/// `httpproxy://` 协议建立 CONNECT 隧道；裁剪构建若缺少该协议，
/// 上层只会得到一句含糊的 "Protocol not found"。把这种已知成因
/// 翻译出来，避免用户面对无法行动的错误。
fn open_failure_message(url: &str, proxy: Option<&str>, error: Error) -> String {
    let through_https_proxy_tunnel = proxy.is_some()
        && url.trim_start().to_ascii_lowercase().starts_with("https://");
    if through_https_proxy_tunnel && matches!(error, Error::ProtocolNotFound) {
        format!(
            "Rust FFmpeg 打开直播流失败: {error}（当前 FFmpeg 缺少 httpproxy 协议，\
无法通过代理录制 HTTPS 直播流）"
        )
    } else {
        format!("Rust FFmpeg 打开直播流失败: {error}")
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
    // Windows 要求 FlushFileBuffers 使用可写句柄，
    // std::fs::File::sync_all 底层正是调用它。
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
        FfmpegRecordingOptions, MAX_INVALID_READS, PacketTimeline, PlayUrl, ReadFailure,
        STREAM_STALL_TIMEOUT, StopReason, build_input_options, classify_read_failure,
        open_failure_message, publish_part,
    };
    use ffmpeg_next::{Error, Packet, Rational};
    use std::fs;
    use std::io::Write;
    use std::time::{Duration, Instant};

    /// 通过*进程内* libavformat 绑定、携带真实 `build_input_options` 字典来打开
    /// 预热过的录制代理 —— 与录制执行的是同一个调用。`stream_proxy` 里的 CLI
    /// 冒烟测试证明代理能提供媒体；
    /// 而这个测试证明录制自身传入的选项集也能描述这些流。
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

    /// 重连选项会把重连后的响应拼接进某个 FLV tag 的中间，
    /// 因此连续流绝不能收到这些选项。
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

    /// 32 KB 探测经常停在 Twitch fMP4 init 分片内部，解复用器打开了播放列表却
    /// 仍无法描述各流。因此 HLS 的探测远超一个分片，
    /// 而连续流保持极小的预算 —— 它的第一个 tag 已经满足。
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

    /// 无论何种协议，损坏的数据包都必须由解复用器丢弃，
    /// 而不是重新封装进录制。
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

    #[test]
    fn a_read_error_after_a_stop_request_is_a_cancellation_not_an_ended_stream() {
        // FFmpeg 的 HLS 解复用器以 `AVERROR_EOF` 中止分片抓取，
        // 因此仅凭错误无法区分"用户按下停止"和"直播已结束"。
        // 先由中断条件决定。
        for error in [Error::Eof, Error::Exit, Error::InvalidData, Error::Unknown] {
            assert!(
                matches!(
                    classify_read_failure(error, true, false, 0),
                    ReadFailure::Stop(StopReason::Cancelled)
                ),
                "{error} after a stop request was not treated as a cancellation"
            );
            assert!(
                matches!(
                    classify_read_failure(error, false, true, 0),
                    ReadFailure::Stop(StopReason::SplitLimit)
                ),
                "{error} at the split boundary was not treated as a split"
            );
        }
    }

    #[test]
    fn an_uninterrupted_read_error_still_reports_why_the_stream_ended() {
        assert_eq!(
            classify_read_failure(Error::Eof, false, false, 0),
            ReadFailure::Stop(StopReason::Failed("直播流已结束".into()))
        );
        // 损坏数据包按预算重试，超过后上报。
        assert_eq!(
            classify_read_failure(Error::InvalidData, false, false, 0),
            ReadFailure::Retry
        );
        assert_eq!(
            classify_read_failure(Error::InvalidData, false, false, MAX_INVALID_READS - 1),
            ReadFailure::Retry
        );
        assert!(matches!(
            classify_read_failure(Error::InvalidData, false, false, MAX_INVALID_READS),
            ReadFailure::Stop(StopReason::Failed(_))
        ));
        let ReadFailure::Stop(StopReason::Failed(message)) =
            classify_read_failure(Error::Unknown, false, false, 0)
        else {
            panic!("一个未被中断的 I/O 错误应结束录制");
        };
        assert!(
            message.starts_with("Rust FFmpeg 读取直播流中断"),
            "{message}"
        );
    }

    /// 两种有意为之的停止不携带错误；其余每种原因都必须说明自己，
    /// 否则录制会以空白原因收场。
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

    /// 代理下的 HTTPS 直播流打开失败时，"Protocol not found" 的真实成因是
    /// FFmpeg 构建缺少 httpproxy 协议；错误消息必须把它说出来，
    /// 否则用户面对的只是一句无法行动的废话。
    #[test]
    fn protocol_not_found_through_an_https_proxy_names_the_missing_protocol() {
        let url = "https://example.com/live.flv";
        let message = open_failure_message(url, Some("http://127.0.0.1:7897/"), Error::ProtocolNotFound);
        assert!(
            message.contains("httpproxy"),
            "应指出缺失的协议名: {message}"
        );

        // 没有代理或非 HTTPS 地址时不追加误导性提示。
        for (url, proxy) in [
            (url, None),
            ("http://example.com/live.flv", Some("http://127.0.0.1:7897/")),
        ] {
            let message = open_failure_message(url, proxy, Error::ProtocolNotFound);
            assert!(
                !message.contains("httpproxy"),
                "无代理成因时不应追加提示: {message}"
            );
        }

        // 其他错误即使发生在代理下也不改写。
        let message = open_failure_message(url, Some("http://127.0.0.1:7897/"), Error::InvalidData);
        assert!(!message.contains("httpproxy"), "仅 ProtocolNotFound 补充成因: {message}");
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

        // AV_NOPTS_VALUE 的 dts 被清除而不是令偏移溢出；
        // 数据包在归一化时间轴上保留可用的 pts。
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

        // 所有输出时间戳保持在合理范围内，
        // 并在合成时钟到真实时钟的切换处保持单调。
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

    /// 端到端录制启动冒烟：推荐 → 房间详情 → 播放地址 → 与 `remux` 完全一致的
    /// 选项字典进程内打开直播流 → 读到真实媒体包。
    ///
    /// 不写盘、不跑完整 `remux`，但覆盖录制启动的全部失败面：站点 API、
    /// 地址解析、请求头、协议选项与 FFmpeg 打开。Twitch 源与生产路径一致地
    /// 经预热代理打开。
    ///
    /// 环境变量：
    /// - `RLIVE_RECORDING_SMOKE_PROXY`：站点请求与 FFmpeg 都经此 HTTP 代理，
    ///   验证代理下的 HTTPS 隧道路径（如 `http://127.0.0.1:7897/`）。
    /// - `RLIVE_RECORDING_SMOKE_ROOM`：直接指定房间号，跳过推荐列表探测。
    async fn live_recording_open_smoke(site_id: crate::models::live::SiteId) {
        let proxy = std::env::var("RLIVE_RECORDING_SMOKE_PROXY")
            .ok()
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let site =
            crate::sites::site_with_proxy(&site_id, None, proxy.as_deref()).expect("site");

        let detail = match std::env::var("RLIVE_RECORDING_SMOKE_ROOM") {
            Ok(room) => site.get_room_detail(&room).await.expect("room detail"),
            Err(_) => {
                let page = site.get_recommend_rooms(1).await.expect("recommend page");
                assert!(!page.items.is_empty(), "{site_id:?} 推荐列表为空");
                let mut found = None;
                for item in page.items.iter().take(12) {
                    if let Ok(detail) = site.get_room_detail(&item.room_id).await
                        && detail.status
                    {
                        found = Some(detail);
                        break;
                    }
                }
                found.unwrap_or_else(|| panic!("{site_id:?} 推荐列表前 12 个房间都没有开播"))
            }
        };
        assert!(detail.status, "指定的房间未开播");

        let qualities = site.get_play_qualities(&detail).await.expect("play qualities");
        assert!(!qualities.is_empty(), "{site_id:?} 无可用画质");
        let mut urls = site
            .get_play_urls(&detail, &qualities[0])
            .await
            .expect("play urls");
        assert!(!urls.is_empty(), "{site_id:?} 无播放线路");
        let source = urls
            .iter()
            .position(|url| url.protocol != PlaybackProtocol::Unknown)
            .map(|index| urls.swap_remove(index))
            .unwrap_or_else(|| urls.swap_remove(0));
        let preview = &source.url[..source.url.len().min(120)];
        eprintln!("{site_id:?} source protocol={:?} url={preview}", source.protocol);

        // Twitch：与生产一致，经预热代理打开；解复用器只探测一次，
        // 广告插播中的清单会让直连打开随机失败。
        let twitch_recovery = (source.protocol == PlaybackProtocol::Hls)
            .then(|| source.twitch_ad_recovery.clone())
            .flatten();
        let warmed = match twitch_recovery {
            Some(recovery) => {
                let session_id = "recording:live-smoke".to_string();
                let recording_proxy = crate::stream_proxy::StreamProxy::new();
                let local_url = recording_proxy
                    .start(
                        source.url.clone(),
                        source.headers.clone(),
                        session_id.clone(),
                        true,
                        proxy.as_deref(),
                        Some(recovery),
                    )
                    .await
                    .expect("启动 Twitch 录制清单代理");
                recording_proxy
                    .wait_for_playable_manifest(
                        &local_url,
                        &session_id,
                        crate::stream_proxy::TWITCH_RECORDING_WARMUP_BUDGET,
                    )
                    .await
                    .expect("等待 Twitch 录制清单");
                Some((recording_proxy, session_id, local_url))
            }
            None => None,
        };
        let open_source = match &warmed {
            Some((_, _, local_url)) => {
                let mut warmed_source = source.clone();
                warmed_source.url = local_url.clone();
                warmed_source.headers.clear();
                warmed_source.twitch_ad_recovery = None;
                warmed_source
            }
            None => source.clone(),
        };
        // 直连时把代理交给 FFmpeg；本地代理已在上游处理过它。
        let ffmpeg_proxy = warmed.is_none().then(|| proxy.as_deref()).flatten();

        let result = open_and_read_media_packets(&open_source, ffmpeg_proxy).await;
        if let Some((recording_proxy, session_id, _)) = warmed {
            recording_proxy.stop_for_session(&session_id);
        }
        let (packets, bytes, streams) = result.expect("进程内打开直播流并读取媒体包");
        assert!(packets >= 3, "{site_id:?} 读到的媒体包过少: {packets}");
        assert!(bytes > 0, "{site_id:?} 未读到任何媒体字节");
        eprintln!(
            "{site_id:?} 录制冒烟通过: packets={packets} bytes={bytes} streams={streams}"
        );
    }

    /// 用录制真实的选项字典打开直播流，读到至少几包真实媒体数据。
    async fn open_and_read_media_packets(
        source: &PlayUrl,
        proxy: Option<&str>,
    ) -> Result<(usize, i64, u32), String> {
        let options = build_input_options(source, proxy, &FfmpegRecordingOptions::default());
        let url = source.url.clone();
        let proxy = proxy.map(str::to_string);
        let proxy_for_error = proxy.clone();
        tokio::task::spawn_blocking(move || {
            super::initialize()?;
            let mut dictionary = ffmpeg_next::Dictionary::new();
            for (key, value) in &options {
                dictionary.set(key, value);
            }
            // 打开（含 HLS 探测）与读包共享一个壁钟预算，
            // 避免坏流把测试无限挂住。
            let deadline = Instant::now() + Duration::from_secs(90);
            let mut input =
                ffmpeg_next::format::input_with_interrupt_and_dictionary(
                    &url,
                    move || Instant::now() >= deadline,
                    dictionary,
                )
                .map_err(|error| open_failure_message(&url, proxy_for_error.as_deref(), error))?;
            let streams = input.nb_streams();
            let mut packets = 0_usize;
            let mut bytes = 0_i64;
            for _ in 0..32 {
                let mut packet = Packet::empty();
                packet
                    .read(&mut input)
                    .map_err(|error| format!("读取媒体包失败: {error}"))?;
                packets += 1;
                bytes += packet.size() as i64;
                // 单个视频关键帧就可能超过 64 KB，因此字节数只在凑够包数后才参与提前退出。
                if packets >= 3 && bytes >= 65_536 {
                    break;
                }
            }
            Ok((packets, bytes, streams))
        })
        .await
        .map_err(|error| format!("demux 任务失败: {error}"))?
    }

    #[tokio::test]
    #[ignore = "live network smoke — run with --ignored"]
    async fn live_bilibili_recording_open_smoke() {
        live_recording_open_smoke(crate::models::live::SiteId::Bilibili).await;
    }

    #[tokio::test]
    #[ignore = "live network smoke — run with --ignored"]
    async fn live_huya_recording_open_smoke() {
        live_recording_open_smoke(crate::models::live::SiteId::Huya).await;
    }

    #[tokio::test]
    #[ignore = "live network smoke — run with --ignored"]
    async fn live_douyu_recording_open_smoke() {
        live_recording_open_smoke(crate::models::live::SiteId::Douyu).await;
    }

    #[tokio::test]
    #[ignore = "live network smoke — run with --ignored"]
    async fn live_douyin_recording_open_smoke() {
        live_recording_open_smoke(crate::models::live::SiteId::Douyin).await;
    }

    #[tokio::test]
    #[ignore = "live network smoke — run with --ignored"]
    async fn live_twitch_recording_open_smoke() {
        live_recording_open_smoke(crate::models::live::SiteId::Twitch).await;
    }
}
