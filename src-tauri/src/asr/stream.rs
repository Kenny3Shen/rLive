//! Qwen3-ASR 的流式调度：VAD 分句 + 有界窗口重解码。
//!
//! Qwen3-ASR 是离线 encoder-decoder，CrispASR 自带的流式会话每一步都重编码整条
//! 累积音频，单步耗时随语句长度线性增长。这里改为：
//!
//! - Silero VAD 逐帧（32 ms）增量打分，带滞回地判定语句起止；
//! - 语句进行中每隔 `partial_step` 只解码最近 `partial_window` 秒，作为在途假设；
//! - 尾部静音达到 `ENDPOINT_SILENCE_FRAMES` 或语句达到最长时长时，解码**整句**作为定稿。
//!
//! 定稿始终覆盖整句音频，在途假设的窗口截断不会影响定稿文本。
//! 关闭 VAD 时每帧都视为语音，只按最长时长切分。

use super::AsrCaptionSegment;

pub const SAMPLE_RATE: usize = 16_000;
/// Silero v6 的帧长（16 kHz 下 512 采样 = 32 ms）。
pub const FRAME_SAMPLES: usize = 512;

const SPEECH_THRESHOLD: f32 = 0.5;
/// 滞回下限：语句进行中概率要跌破它才计为静音，介于两者之间保持原状态。
const SILENCE_THRESHOLD: f32 = 0.35;
/// 0.8 s 尾部静音定稿。
const ENDPOINT_SILENCE_FRAMES: usize = 25;
/// 语句起点之前保留约 0.2 s，避免吞掉首字。
const PREROLL_FRAMES: usize = 6;
/// 定稿音频在最后一个语音帧之后再保留约 0.2 s。
const TAIL_PAD_FRAMES: usize = 6;
/// 少于约 0.25 s 语音的片段（咳嗽、按键声）直接丢弃。
const MIN_VOICED_FRAMES: usize = 8;
/// 最长语句约 20 s。
const MAX_UTTERANCE_FRAMES: usize = 625;
/// 达到最长时长时，在最后约 2 s 内找概率最低的一帧切分，尽量不切在字中间。
const MAX_CUT_SEARCH_FRAMES: usize = 62;
/// 少于 0.3 s 的音频不送解码器。
const MIN_DECODE_SAMPLES: usize = SAMPLE_RATE * 3 / 10;

/// 调度依赖的原生能力。生产实现是 CrispASR，测试用脚本化的假实现。
pub trait CaptionEngine {
    /// 给整帧对齐的 PCM 打分，返回每帧语音概率。只在 VAD 开启时调用。
    fn score(&mut self, pcm: &[f32]) -> Result<Vec<f32>, String>;
    fn transcribe(&mut self, pcm: &[f32]) -> Result<String, String>;
    /// 给一条定稿语句分配匿名说话人编号；未启用说话人区分时返回 `None`。
    fn classify_speaker(&mut self, pcm: &[f32]) -> Option<u32>;
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct StreamConfig {
    pub vad_enabled: bool,
    pub punctuation_enabled: bool,
    /// 两次在途解码之间至少新增的语音帧数。
    pub partial_step_frames: usize,
    /// 在途解码只看最近这么多帧。
    pub partial_window_frames: usize,
}

impl StreamConfig {
    /// GPU 单次解码约 0.1–0.4 s，可以每 0.5 s 刷新一次 6 s 窗口；CPU 慢 5 倍左右，
    /// 每 1 s 刷新 4 s 窗口才跟得上实时（Windows GTX 1070 Ti / 8 线程实测）。
    pub fn for_device(gpu: bool, vad_enabled: bool, punctuation_enabled: bool) -> Self {
        let (step_seconds, window_seconds) = if gpu { (0.5, 6.0) } else { (1.0, 4.0) };
        Self {
            vad_enabled,
            punctuation_enabled,
            partial_step_frames: seconds_to_frames(step_seconds),
            partial_window_frames: seconds_to_frames(window_seconds),
        }
    }
}

fn seconds_to_frames(seconds: f64) -> usize {
    (seconds * SAMPLE_RATE as f64 / FRAME_SAMPLES as f64).round() as usize
}

#[derive(Debug)]
struct Utterance {
    start_frame: usize,
    /// 从 `start_frame` 起每帧的语音概率，用于在最长时长处找切分点。
    probs: Vec<f32>,
    voiced_frames: usize,
    silence_run: usize,
    last_voiced_frame: usize,
    /// 上次在途解码时的帧位置。
    partial_frame: usize,
}

#[derive(Debug, Default)]
pub struct StreamOutput {
    pub segments: Vec<AsrCaptionSegment>,
    pub partial: Option<String>,
}

#[derive(Debug)]
pub struct CaptionStream {
    config: StreamConfig,
    /// 尚未丢弃的 PCM，起点是绝对帧 `origin_frame`（始终帧对齐）。
    pcm: Vec<f32>,
    origin_frame: usize,
    /// 下一个待打分的绝对帧。
    next_frame: usize,
    /// 空闲时最近几帧的概率，语句开始时作为前导帧的概率。
    recent_probs: Vec<f32>,
    utterance: Option<Utterance>,
    last_partial: Option<String>,
}

impl CaptionStream {
    pub fn new(config: StreamConfig) -> Self {
        Self {
            config,
            pcm: Vec::new(),
            origin_frame: 0,
            next_frame: 0,
            recent_probs: Vec::new(),
            utterance: None,
            last_partial: None,
        }
    }

    pub fn reset(&mut self) {
        *self = Self::new(self.config);
    }

    /// 喂入一个采集窗口，返回其间定稿的语句与当前在途假设。
    pub fn push(
        &mut self,
        engine: &mut impl CaptionEngine,
        samples: &[f32],
    ) -> Result<StreamOutput, String> {
        self.pcm.extend_from_slice(samples);
        let available_frames = self.origin_frame + self.pcm.len() / FRAME_SAMPLES;
        let mut output = StreamOutput::default();

        if available_frames > self.next_frame {
            let count = available_frames - self.next_frame;
            let probs = if self.config.vad_enabled {
                let start = (self.next_frame - self.origin_frame) * FRAME_SAMPLES;
                let probs = engine.score(&self.pcm[start..start + count * FRAME_SAMPLES])?;
                if probs.len() != count {
                    return Err(format!(
                        "VAD returned {} frames, expected {count}",
                        probs.len()
                    ));
                }
                probs
            } else {
                vec![1.0; count]
            };
            for prob in probs {
                self.process_frame(engine, prob, &mut output.segments);
            }
        }

        output.partial = self.decode_partial(engine);
        self.trim();
        Ok(output)
    }

    fn process_frame(
        &mut self,
        engine: &mut impl CaptionEngine,
        prob: f32,
        segments: &mut Vec<AsrCaptionSegment>,
    ) {
        let frame = self.next_frame;
        self.next_frame += 1;

        let Some(utterance) = self.utterance.as_mut() else {
            if prob >= SPEECH_THRESHOLD {
                let start_frame = frame
                    .saturating_sub(PREROLL_FRAMES.min(self.recent_probs.len()))
                    .max(self.origin_frame);
                let lead = frame - start_frame;
                let mut probs = self.recent_probs[self.recent_probs.len() - lead..].to_vec();
                probs.push(prob);
                self.recent_probs.clear();
                self.utterance = Some(Utterance {
                    start_frame,
                    probs,
                    voiced_frames: 1,
                    silence_run: 0,
                    last_voiced_frame: frame,
                    partial_frame: frame,
                });
            } else {
                self.recent_probs.push(prob);
                if self.recent_probs.len() > PREROLL_FRAMES {
                    self.recent_probs.remove(0);
                }
            }
            return;
        };

        utterance.probs.push(prob);
        if prob >= SPEECH_THRESHOLD {
            utterance.voiced_frames += 1;
            utterance.silence_run = 0;
            utterance.last_voiced_frame = frame;
        } else if prob < SILENCE_THRESHOLD {
            utterance.silence_run += 1;
        }

        if utterance.silence_run >= ENDPOINT_SILENCE_FRAMES {
            let end_frame = (utterance.last_voiced_frame + 1 + TAIL_PAD_FRAMES).min(frame + 1);
            let utterance = self.utterance.take().expect("utterance is active");
            segments.extend(self.finalize(engine, &utterance, end_frame));
            return;
        }

        if frame + 1 - utterance.start_frame >= MAX_UTTERANCE_FRAMES {
            // 在最后一段里找概率最低的帧切开；关闭 VAD 时概率全为 1，切在末尾。
            let len = utterance.probs.len();
            let search_from = len.saturating_sub(MAX_CUT_SEARCH_FRAMES);
            let cut_offset = (search_from..len)
                .rev()
                .min_by(|left, right| utterance.probs[*left].total_cmp(&utterance.probs[*right]))
                .map_or(len, |index| index + 1);
            let cut_frame = utterance.start_frame + cut_offset;
            let remaining = utterance.probs[cut_offset..].to_vec();
            let utterance = self.utterance.take().expect("utterance is active");
            segments.extend(self.finalize(engine, &utterance, cut_frame));
            if !remaining.is_empty() {
                let voiced = remaining.iter().filter(|p| **p >= SPEECH_THRESHOLD).count();
                self.utterance = Some(Utterance {
                    start_frame: cut_frame,
                    voiced_frames: voiced,
                    silence_run: 0,
                    last_voiced_frame: frame,
                    partial_frame: cut_frame,
                    probs: remaining,
                });
            }
        }
    }

    fn finalize(
        &mut self,
        engine: &mut impl CaptionEngine,
        utterance: &Utterance,
        end_frame: usize,
    ) -> Option<AsrCaptionSegment> {
        self.last_partial = None;
        if utterance.voiced_frames < MIN_VOICED_FRAMES {
            return None;
        }
        let pcm = self.frames(utterance.start_frame, end_frame);
        if pcm.len() < MIN_DECODE_SAMPLES {
            return None;
        }
        let text = match engine.transcribe(pcm) {
            Ok(text) => postprocess(&text, self.config.punctuation_enabled),
            Err(error) => {
                // 单句失败不打断整条流：丢掉这一句，继续识别后面的音频。
                tracing::warn!(%error, "ASR final decode failed");
                return None;
            }
        };
        if text.is_empty() {
            return None;
        }
        Some(AsrCaptionSegment {
            text,
            start_ms: frames_to_millis(utterance.start_frame),
            end_ms: frames_to_millis(end_frame),
            speaker_id: engine.classify_speaker(pcm),
        })
    }

    fn decode_partial(&mut self, engine: &mut impl CaptionEngine) -> Option<String> {
        let utterance = self.utterance.as_mut()?;
        // 只在有新语音时刷新：尾部静音等端点的那 0.8 s 里重解码只会得到同样的文本。
        if utterance.voiced_frames < MIN_VOICED_FRAMES
            || utterance.last_voiced_frame < utterance.partial_frame
            || self.next_frame < utterance.partial_frame + self.config.partial_step_frames
        {
            return self.last_partial.clone();
        }
        utterance.partial_frame = self.next_frame;
        let start = self
            .next_frame
            .saturating_sub(self.config.partial_window_frames)
            .max(utterance.start_frame);
        let pcm = self.frames(start, self.next_frame);
        if pcm.len() < MIN_DECODE_SAMPLES {
            return self.last_partial.clone();
        }
        match engine.transcribe(pcm) {
            Ok(text) => {
                let text = postprocess(&text, self.config.punctuation_enabled);
                self.last_partial = (!text.is_empty()).then_some(text);
            }
            // 在途假设失败时保留上一条，不能连累同一窗口里已经定稿的语句。
            Err(error) => tracing::warn!(%error, "ASR partial decode failed"),
        }
        self.last_partial.clone()
    }

    fn frames(&self, start_frame: usize, end_frame: usize) -> &[f32] {
        let start = start_frame.saturating_sub(self.origin_frame) * FRAME_SAMPLES;
        let end = (end_frame.saturating_sub(self.origin_frame) * FRAME_SAMPLES).min(self.pcm.len());
        &self.pcm[start.min(end)..end]
    }

    /// 只保留进行中的语句（或空闲时的前导帧）和尚未打分的尾巴。
    fn trim(&mut self) {
        let keep_from = self.utterance.as_ref().map_or_else(
            || self.next_frame.saturating_sub(PREROLL_FRAMES),
            |utterance| utterance.start_frame,
        );
        if keep_from > self.origin_frame {
            let drop_samples =
                ((keep_from - self.origin_frame) * FRAME_SAMPLES).min(self.pcm.len());
            self.pcm.drain(..drop_samples);
            self.origin_frame = keep_from;
        }
    }
}

fn frames_to_millis(frame: usize) -> u64 {
    (frame as u64 * FRAME_SAMPLES as u64 * 1_000) / SAMPLE_RATE as u64
}

/// 去掉首尾空白；关闭自动标点时移除 Qwen3 输出的标点。
pub fn postprocess(text: &str, punctuation_enabled: bool) -> String {
    let text = text.trim();
    if punctuation_enabled {
        return text.to_owned();
    }
    let mut stripped = String::with_capacity(text.len());
    for character in text.chars() {
        if is_removable_punctuation(character) {
            // 英文标点换成空格保住词边界；中日文之间的空格在下面压掉。
            if !stripped.ends_with(' ') {
                stripped.push(' ');
            }
        } else {
            stripped.push(character);
        }
    }
    collapse_spaces(&stripped)
}

fn is_removable_punctuation(character: char) -> bool {
    // 撇号和连字符属于单词本身（don't、e-mail），保留。
    if matches!(character, '\'' | '’' | '-') {
        return false;
    }
    character.is_ascii_punctuation()
        || matches!(character as u32, 0x3000..=0x303F | 0xFF01..=0xFF0F | 0xFF1A..=0xFF20 | 0xFF3B..=0xFF40 | 0xFF5B..=0xFF65)
        || matches!(character, '…' | '—' | '–' | '“' | '”' | '‘' | '·')
}

fn is_cjk(character: char) -> bool {
    matches!(character as u32, 0x2E80..=0x9FFF | 0xAC00..=0xD7AF | 0xF900..=0xFAFF | 0x20000..=0x3FFFF)
}

fn collapse_spaces(text: &str) -> String {
    let characters: Vec<char> = text
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .collect();
    let mut output = String::with_capacity(text.len());
    for (index, character) in characters.iter().enumerate() {
        if *character == ' ' {
            let previous = index.checked_sub(1).and_then(|i| characters.get(i));
            let next = characters.get(index + 1);
            if previous.is_some_and(|c| is_cjk(*c)) || next.is_some_and(|c| is_cjk(*c)) {
                continue;
            }
        }
        output.push(*character);
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 每帧概率由脚本给出；PCM 内容就是帧号，便于断言解码的音频范围。
    struct ScriptedEngine {
        probs: Vec<f32>,
        scored: usize,
        decoded: Vec<(usize, usize)>,
    }

    impl ScriptedEngine {
        fn new(probs: Vec<f32>) -> Self {
            Self {
                probs,
                scored: 0,
                decoded: Vec::new(),
            }
        }
    }

    impl CaptionEngine for ScriptedEngine {
        fn score(&mut self, pcm: &[f32]) -> Result<Vec<f32>, String> {
            assert_eq!(pcm.len() % FRAME_SAMPLES, 0);
            let count = pcm.len() / FRAME_SAMPLES;
            let probs = self.probs[self.scored..self.scored + count].to_vec();
            self.scored += count;
            Ok(probs)
        }

        fn transcribe(&mut self, pcm: &[f32]) -> Result<String, String> {
            let first = pcm[0] as usize;
            let last = pcm[pcm.len() - 1] as usize;
            self.decoded.push((first, last + 1));
            Ok(format!("{first}-{}", last + 1))
        }

        fn classify_speaker(&mut self, _pcm: &[f32]) -> Option<u32> {
            Some(1)
        }
    }

    fn frame_pcm(start_frame: usize, frames: usize) -> Vec<f32> {
        (start_frame..start_frame + frames)
            .flat_map(|frame| std::iter::repeat_n(frame as f32, FRAME_SAMPLES))
            .collect()
    }

    fn config(vad_enabled: bool) -> StreamConfig {
        StreamConfig {
            vad_enabled,
            punctuation_enabled: true,
            partial_step_frames: 16,
            partial_window_frames: 125,
        }
    }

    /// 以 0.2 s（约 6 帧，不对齐）的采集窗口喂入全部帧。
    fn run(
        stream: &mut CaptionStream,
        engine: &mut ScriptedEngine,
        frames: usize,
    ) -> Vec<StreamOutput> {
        let pcm = frame_pcm(0, frames);
        pcm.chunks(3_200)
            .map(|chunk| stream.push(engine, chunk).unwrap())
            .collect()
    }

    #[test]
    fn finalizes_an_utterance_after_trailing_silence() {
        // 10 帧静音、40 帧语音、30 帧静音。
        let mut probs = vec![0.1; 10];
        probs.extend(vec![0.9; 40]);
        probs.extend(vec![0.1; 30]);
        let mut engine = ScriptedEngine::new(probs);
        let mut stream = CaptionStream::new(config(true));
        let outputs = run(&mut stream, &mut engine, 80);
        let segments: Vec<_> = outputs.iter().flat_map(|output| &output.segments).collect();
        assert_eq!(segments.len(), 1);
        // 前导 6 帧（从第 4 帧起），尾部补 6 帧（到第 56 帧止）。
        assert_eq!(segments[0].text, "4-56");
        assert_eq!(segments[0].start_ms, 128);
        assert_eq!(segments[0].end_ms, 1_792);
        assert_eq!(segments[0].speaker_id, Some(1));
        assert!(outputs.last().unwrap().partial.is_none());
    }

    #[test]
    fn mid_band_probabilities_do_not_end_an_utterance() {
        let mut probs = vec![0.9; 20];
        probs.extend(vec![0.4; 40]);
        probs.extend(vec![0.9; 20]);
        probs.extend(vec![0.0; 30]);
        let mut engine = ScriptedEngine::new(probs);
        let mut stream = CaptionStream::new(config(true));
        let outputs = run(&mut stream, &mut engine, 110);
        let segments: Vec<_> = outputs.iter().flat_map(|output| &output.segments).collect();
        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0].text, "0-86");
    }

    #[test]
    fn drops_blips_shorter_than_the_minimum_speech() {
        let mut probs = vec![0.9; 5];
        probs.extend(vec![0.0; 40]);
        let mut engine = ScriptedEngine::new(probs);
        let mut stream = CaptionStream::new(config(true));
        let outputs = run(&mut stream, &mut engine, 45);
        assert!(outputs.iter().all(|output| output.segments.is_empty()));
        assert!(engine.decoded.is_empty());
    }

    #[test]
    fn partials_decode_a_bounded_trailing_window() {
        let probs = vec![0.9; 200];
        let mut engine = ScriptedEngine::new(probs);
        let mut stream = CaptionStream::new(StreamConfig {
            partial_window_frames: 32,
            ..config(true)
        });
        let outputs = run(&mut stream, &mut engine, 200);
        assert!(outputs.iter().all(|output| output.segments.is_empty()));
        let (start, end) = *engine.decoded.last().unwrap();
        assert!(end - start <= 32, "window {start}..{end} exceeds 32 frames");
        assert!(outputs.last().unwrap().partial.is_some());
        // 在途解码按步长节流，而不是每个采集窗口都解码。
        assert!(engine.decoded.len() <= 200 / 16 + 1);
    }

    #[test]
    fn cuts_at_the_quietest_frame_when_an_utterance_runs_too_long() {
        let mut probs = vec![0.9; MAX_UTTERANCE_FRAMES + 40];
        probs[MAX_UTTERANCE_FRAMES - 20] = 0.45;
        let mut engine = ScriptedEngine::new(probs);
        let mut stream = CaptionStream::new(config(true));
        let outputs = run(&mut stream, &mut engine, MAX_UTTERANCE_FRAMES + 40);
        let segments: Vec<_> = outputs.iter().flat_map(|output| &output.segments).collect();
        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0].text, format!("0-{}", MAX_UTTERANCE_FRAMES - 19));
    }

    #[test]
    fn without_vad_splits_only_at_the_maximum_length() {
        let mut engine = ScriptedEngine::new(Vec::new());
        let mut stream = CaptionStream::new(config(false));
        let outputs = run(&mut stream, &mut engine, MAX_UTTERANCE_FRAMES * 2 + 10);
        let segments: Vec<_> = outputs.iter().flat_map(|output| &output.segments).collect();
        assert_eq!(segments.len(), 2);
        assert_eq!(segments[0].text, format!("0-{MAX_UTTERANCE_FRAMES}"));
        assert_eq!(
            segments[1].text,
            format!("{MAX_UTTERANCE_FRAMES}-{}", MAX_UTTERANCE_FRAMES * 2)
        );
        assert_eq!(engine.scored, 0);
    }

    #[test]
    fn keeps_memory_bounded_while_idle() {
        let mut engine = ScriptedEngine::new(vec![0.0; 2_000]);
        let mut stream = CaptionStream::new(config(true));
        run(&mut stream, &mut engine, 2_000);
        assert!(stream.pcm.len() <= (PREROLL_FRAMES + 7) * FRAME_SAMPLES);
    }

    #[test]
    fn reset_discards_buffered_audio_and_state() {
        let mut engine = ScriptedEngine::new(vec![0.9; 40]);
        let mut stream = CaptionStream::new(config(true));
        run(&mut stream, &mut engine, 40);
        stream.reset();
        assert!(stream.pcm.is_empty());
        assert!(stream.utterance.is_none());
        assert_eq!(stream.next_frame, 0);
    }

    #[test]
    fn strips_punctuation_without_gluing_english_words() {
        assert_eq!(postprocess(" 你好，世界。 ", true), "你好，世界。");
        assert_eq!(
            postprocess("你好，世界。Hello, world!", false),
            "你好世界Hello world"
        );
        assert_eq!(
            postprocess("Don't stop — e-mail me.", false),
            "Don't stop e-mail me"
        );
        assert_eq!(
            postprocess("29岁的医生，在T恤衫里。", false),
            "29岁的医生在T恤衫里"
        );
    }
}
