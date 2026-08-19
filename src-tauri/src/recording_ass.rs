//! 录制弹幕轨（`danmaku.jsonl`）到 ASS 字幕的转换。
//!
//! 目的是让外部播放器（PotPlayer、mpv 等）直接加载与录像同名的 `.ass`，
//! 分辨率、字体、字号、透明度、描边、阴影、粗体、滚动时间、显示区域和过滤
//! 都由独立的录制 ASS 配置决定，不受直播播放器设置变化影响。
//!
//! 滚动布局参考 DanmakuFactory（MIT, <https://github.com/hihkm/DanmakuFactory>）：
//! 每行维护「上一条尾部完全进屏时间」与「上一条离屏时间」，两个条件都不冲突
//! 才占用该行；所有行都冲突时回退到最早空出的行，而不是丢弃弹幕。

use std::collections::HashMap;
use std::io::{BufRead, Write};

use regex::RegexSet;
use serde::Deserialize;

use crate::models::live::{DanmakuEvent, DanmakuKind};
use crate::models::settings::AppSettings;

/// 与前端 `recordedDanmaku.ts` 相同的上限，避免异常大的弹幕轨占满内存。
const MAX_EXPORTED_DANMAKU: usize = 250_000;
/// 与画面层 `RecordedDanmakuCanvas` 的 SC 颜色一致。
const SUPER_CHAT_RGB: u32 = 0xFF_D7_6A;
const DEFAULT_RGB: u32 = 0xFF_FF_FF;
/// 行间距占字号的比例，与 `danmuLaneHeight` 的 1.4 倍行高一致。
const LINE_HEIGHT_RATIO: f64 = 1.4;
#[derive(Debug, Clone)]
enum ShieldMatcher {
    Literals(Vec<String>),
    Regex(RegexSet),
}

/// 一组已经归一化并完成正则编译的 ASS 导出配置。
#[derive(Debug, Clone)]
pub struct AssExportOptions {
    play_res_x: i32,
    play_res_y: i32,
    top_margin: i32,
    font_name: String,
    font_size: i32,
    line_height: i32,
    opacity: f32,
    outline: f32,
    shadow: f32,
    bold: bool,
    scroll_duration_ms: i64,
    area: f32,
    merge_window_ms: i64,
    filter_gifts: bool,
    show_super_chat: bool,
    shield_matcher: ShieldMatcher,
}

impl AssExportOptions {
    pub fn try_from_settings(settings: &AppSettings) -> Result<Self, regex::Error> {
        let ass = &settings.recording_ass;
        let font_size = ass.font_size as i32;
        let line_height = (f64::from(font_size) * LINE_HEIGHT_RATIO).round();
        let shield_matcher = if ass.shield_regex {
            ShieldMatcher::Regex(RegexSet::new(&ass.shield_rules)?)
        } else {
            ShieldMatcher::Literals(
                ass.shield_rules
                    .iter()
                    .map(|rule| rule.to_lowercase())
                    .collect(),
            )
        };
        Ok(Self {
            play_res_x: ass.resolution_width as i32,
            play_res_y: ass.resolution_height as i32,
            top_margin: (ass.resolution_height as i32 / 135).max(1),
            font_name: ass.font_name.clone(),
            font_size,
            line_height: (line_height as i32).max(1),
            opacity: ass.opacity_percent as f32 / 100.0,
            outline: ass.outline,
            shadow: ass.shadow,
            bold: ass.bold,
            scroll_duration_ms: i64::from(ass.scroll_duration_seconds) * 1_000,
            area: ass.display_area_percent as f32 / 100.0,
            merge_window_ms: i64::from(ass.merge_window_seconds) * 1_000,
            filter_gifts: ass.filter_gifts,
            show_super_chat: ass.show_super_chat,
            shield_matcher,
        })
    }

    fn lane_count(&self) -> usize {
        let usable = (self.play_res_y as f32 * self.area) as i32 - self.top_margin;
        (usable / self.line_height).max(1) as usize
    }

    fn is_shielded(&self, content: &str) -> bool {
        match &self.shield_matcher {
            ShieldMatcher::Literals(rules) => {
                let lower = content.to_lowercase();
                rules.iter().any(|rule| lower.contains(rule))
            }
            ShieldMatcher::Regex(rules) => rules.is_match(content),
        }
    }
}

#[derive(Debug, Deserialize)]
struct StoredDanmakuBatch {
    offset_ms: i64,
    events: Vec<DanmakuEvent>,
}

/// 一条待渲染弹幕。合并计数在布局前确定，因此不会出现「先写出再补 ×N」。
struct AssDanmaku {
    offset_ms: i64,
    text: String,
    rgb: u32,
    /// 合并窗口内相同内容出现的次数。
    count: u32,
}

#[derive(Clone)]
struct RollLane {
    /// 该行上一条弹幕尾部完全进入画面的时间。
    tail_entered_at: i64,
    /// 该行上一条弹幕完全离开画面的时间。
    left_at: i64,
}

/// 把弹幕轨转换为 ASS 并写入 `writer`，返回写出的弹幕条数。
///
/// 单行 JSON 解析失败会被跳过：录制被强制结束时最后一行可能不完整，其余批次
/// 仍然可用。
pub fn write_ass<R: BufRead, W: Write>(
    reader: R,
    writer: &mut W,
    options: &AssExportOptions,
) -> std::io::Result<u64> {
    let danmaku = collect_danmaku(reader, options);
    write_header(writer, options)?;
    write_events(writer, &danmaku, options)?;
    Ok(danmaku.len() as u64)
}

fn collect_danmaku<R: BufRead>(reader: R, options: &AssExportOptions) -> Vec<AssDanmaku> {
    let mut danmaku: Vec<AssDanmaku> = Vec::new();
    // 合并键 -> (锚条位置, 锚条时间)
    let mut merge_groups: HashMap<String, (usize, i64)> = HashMap::new();

    for line in reader.lines() {
        let Ok(line) = line else { break };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(batch) = serde_json::from_str::<StoredDanmakuBatch>(line) else {
            continue;
        };
        if batch.offset_ms < 0 {
            continue;
        }
        for event in batch.events {
            if !is_visible(&event, options) {
                continue;
            }
            let Some(text) = danmaku_text(&event) else {
                continue;
            };
            let merge_key = merge_key(&event, options);
            // 窗口以锚条时间为基准而非「上一条同内容」，否则周期性刷屏会沿着
            // 滑动链一路折叠到录像结尾，把计数记到一条早已滚出画面的弹幕上。
            if let Some(key) = merge_key.as_deref()
                && let Some(&(index, anchor_ms)) = merge_groups.get(key)
                && batch.offset_ms >= anchor_ms
                && batch.offset_ms - anchor_ms <= options.merge_window_ms
            {
                danmaku[index].count = danmaku[index].count.saturating_add(1);
                continue;
            }
            if let Some(key) = merge_key {
                merge_groups.insert(key, (danmaku.len(), batch.offset_ms));
            }
            danmaku.push(AssDanmaku {
                offset_ms: batch.offset_ms,
                text,
                rgb: danmaku_rgb(&event),
                count: 1,
            });
            if danmaku.len() >= MAX_EXPORTED_DANMAKU {
                danmaku.sort_by_key(|entry| entry.offset_ms);
                return danmaku;
            }
        }
    }

    danmaku.sort_by_key(|entry| entry.offset_ms);
    danmaku
}

/// 与前端 `filter.ts` 相同的可见性策略：入场/社交/系统通知不导出，礼物、SC 与
/// 屏蔽词遵循用户设置。
fn is_visible(event: &DanmakuEvent, options: &AssExportOptions) -> bool {
    let content = event.content.trim();
    if content.is_empty() {
        return false;
    }
    match event.kind {
        DanmakuKind::System | DanmakuKind::Social | DanmakuKind::Enter => return false,
        DanmakuKind::Gift if options.filter_gifts => return false,
        DanmakuKind::SuperChat if !options.show_super_chat => return false,
        _ => {}
    }
    if is_room_enter_notice(content) {
        return false;
    }
    if options.is_shielded(content) {
        return false;
    }
    true
}

/// 部分中继把入场提示当作普通聊天下发，与前端一致地按后缀识别并丢弃。
fn is_room_enter_notice(content: &str) -> bool {
    const SUFFIXES: [&str; 3] = ["进入直播间", "进入了直播间", "进入直播间了"];
    let ends_with_suffix = |value: &str| SUFFIXES.iter().any(|suffix| value.ends_with(suffix));
    if ends_with_suffix(content) {
        return true;
    }
    if !content.chars().any(char::is_whitespace) {
        return false;
    }
    let compact: String = content.chars().filter(|c| !c.is_whitespace()).collect();
    ends_with_suffix(&compact)
}

/// 与画面层相同：只显示弹幕内容，SC 保留短标记。
fn danmaku_text(event: &DanmakuEvent) -> Option<String> {
    let content = event.content.trim();
    if content.is_empty() {
        return None;
    }
    if matches!(event.kind, DanmakuKind::SuperChat) && !content.starts_with("【SC】") {
        return Some(format!("【SC】{content}"));
    }
    Some(content.to_owned())
}

/// 合并键与前端 `danmakuContentAggregationKey` 一致：仅普通聊天参与，并按是否
/// 本机账号区分。
fn merge_key(event: &DanmakuEvent, options: &AssExportOptions) -> Option<String> {
    if options.merge_window_ms == 0 || !matches!(event.kind, DanmakuKind::Chat) {
        return None;
    }
    let content = event.content.trim();
    (!content.is_empty()).then(|| {
        format!(
            "{}\u{0}{content}",
            if event.is_self { "self" } else { "other" }
        )
    })
}

fn danmaku_rgb(event: &DanmakuEvent) -> u32 {
    if matches!(event.kind, DanmakuKind::SuperChat) {
        return SUPER_CHAT_RGB;
    }
    event
        .color
        .as_deref()
        .and_then(parse_css_hex_rgb)
        .unwrap_or(DEFAULT_RGB)
}

/// 只接受 `#RGB` / `#RRGGBB`。命名颜色和 `rgb()` 交给默认白色，避免把任意字符串
/// 拼进 ASS 覆盖标签。
fn parse_css_hex_rgb(value: &str) -> Option<u32> {
    let hex = value.trim().strip_prefix('#')?;
    if !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    match hex.len() {
        3 => {
            let value = u32::from_str_radix(hex, 16).ok()?;
            let r = (value >> 8) & 0xF;
            let g = (value >> 4) & 0xF;
            let b = value & 0xF;
            Some((r * 17) << 16 | (g * 17) << 8 | (b * 17))
        }
        6 => u32::from_str_radix(hex, 16).ok(),
        _ => None,
    }
}

/// ASS 颜色是 `&HBBGGRR&`。
fn ass_color(rgb: u32) -> String {
    let r = (rgb >> 16) & 0xFF;
    let g = (rgb >> 8) & 0xFF;
    let b = rgb & 0xFF;
    format!("&H{b:02X}{g:02X}{r:02X}&")
}

fn write_header<W: Write>(writer: &mut W, options: &AssExportOptions) -> std::io::Result<()> {
    // ASS 的 alpha 是「透明度」：00 全不透明、FF 全透明。
    let alpha = ((1.0 - options.opacity) * 255.0).round().clamp(0.0, 255.0) as u32;
    let bold = if options.bold { -1 } else { 0 };
    writeln!(
        writer,
        "[Script Info]\n\
         ; 由 rLive 从录制弹幕轨生成\n\
         ; 滚动布局参考 DanmakuFactory (https://github.com/hihkm/DanmakuFactory)\n\
         ScriptType: v4.00+\n\
         Collisions: Normal\n\
         PlayResX: {play_res_x}\n\
         PlayResY: {play_res_y}\n\
         Timer: 100.0000\n\
         WrapStyle: 2\n\
         ScaledBorderAndShadow: yes\n",
        play_res_x = options.play_res_x,
        play_res_y = options.play_res_y,
    )?;
    writeln!(
        writer,
        "[V4+ Styles]\n\
         Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, \
         BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, \
         BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding"
    )?;
    writeln!(
        writer,
        "Style: R2L,{font_name},{font_size},&H{alpha:02X}FFFFFF,&H{alpha:02X}FFFFFF,\
         &H{alpha:02X}000000,&H{alpha:02X}000000,{bold},0,0,0,100,100,0,0,1,{outline:.1},{shadow:.1},8,0,0,0,1\n",
        font_name = options.font_name,
        font_size = options.font_size,
        outline = options.outline,
        shadow = options.shadow,
    )?;
    writeln!(
        writer,
        "[Events]\n\
         Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text"
    )
}

fn write_events<W: Write>(
    writer: &mut W,
    danmaku: &[AssDanmaku],
    options: &AssExportOptions,
) -> std::io::Result<()> {
    let lane_count = options.lane_count();
    let mut lanes = vec![
        RollLane {
            tail_entered_at: i64::MIN,
            left_at: i64::MIN,
        };
        lane_count
    ];

    for entry in danmaku {
        let text = if entry.count > 1 {
            format!("{} ×{}", entry.text, entry.count)
        } else {
            entry.text.clone()
        };
        let width = estimated_text_width(&text, options.font_size);
        let travel = options.play_res_x + width;
        let roll_ms = options.scroll_duration_ms;
        // 弹幕尾部完全进入画面、以及弹幕头部触及左边缘的时刻。
        let tail_entered_at = entry.offset_ms + roll_ms * i64::from(width) / i64::from(travel);
        let reaches_left_at =
            entry.offset_ms + roll_ms * i64::from(options.play_res_x) / i64::from(travel);
        let left_at = entry.offset_ms + roll_ms;

        let lane = pick_lane(&lanes, entry.offset_ms, reaches_left_at);
        lanes[lane] = RollLane {
            tail_entered_at,
            left_at,
        };

        let y = options.top_margin + lane as i32 * options.line_height;
        let start_x = options.play_res_x + width / 2;
        let end_x = -width / 2;
        write!(writer, "Dialogue: 0,")?;
        write_timestamp(writer, entry.offset_ms)?;
        write!(writer, ",")?;
        write_timestamp(writer, left_at)?;
        write!(
            writer,
            ",R2L,,0000,0000,0000,,{{\\move({start_x},{y},{end_x},{y})"
        )?;
        if entry.rgb != DEFAULT_RGB {
            write!(writer, "\\c{}", ass_color(entry.rgb))?;
        }
        writeln!(writer, "}}{}", escape_ass_text(&text))?;
    }
    Ok(())
}

/// 首个不会与前一条追尾的行；所有行都冲突时选最早空出的行，保留全部弹幕。
fn pick_lane(lanes: &[RollLane], offset_ms: i64, reaches_left_at: i64) -> usize {
    for (index, lane) in lanes.iter().enumerate() {
        if offset_ms >= lane.tail_entered_at && reaches_left_at >= lane.left_at {
            return index;
        }
    }
    lanes
        .iter()
        .enumerate()
        .min_by_key(|(_, lane)| lane.left_at)
        .map(|(index, _)| index)
        .unwrap_or(0)
}

/// 没有字体度量时的宽度估算：全角字符按一个字号，其余按 0.55 个字号。低估会让
/// 弹幕互相重叠，因此对宽字符取满宽。
fn estimated_text_width(text: &str, font_size: i32) -> i32 {
    let mut units = 0.0_f64;
    for character in text.chars() {
        units += if is_wide_character(character) {
            1.0
        } else {
            0.55
        };
    }
    ((units * f64::from(font_size)).round() as i32).max(1)
}

fn is_wide_character(character: char) -> bool {
    matches!(
        character as u32,
        0x1100..=0x115F
            | 0x2E80..=0x303E
            | 0x3041..=0x33FF
            | 0x3400..=0x4DBF
            | 0x4E00..=0x9FFF
            | 0xA000..=0xA4CF
            | 0xAC00..=0xD7A3
            | 0xF900..=0xFAFF
            | 0xFE30..=0xFE4F
            | 0xFF00..=0xFF60
            | 0xFFE0..=0xFFE6
            | 0x1F300..=0x1FAFF
            | 0x20000..=0x2FA1F
    )
}

/// libass 会解释 `{}` 覆盖块与 `\n` / `\N` / `\h`。用零宽空格打断裸反斜杠序列，
/// 保留原文可读性，同时保证内容不会变成渲染指令。
fn escape_ass_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(character) = chars.next() {
        match character {
            '{' => out.push_str("\\{"),
            '}' => out.push_str("\\}"),
            '\\' => {
                out.push('\\');
                if matches!(chars.peek(), Some('n' | 'N' | 'h')) {
                    out.push('\u{200B}');
                }
            }
            '\n' | '\r' => out.push_str("\\N"),
            ' ' => out.push_str("\\h"),
            control if control.is_control() => {}
            other => out.push(other),
        }
    }
    out
}

/// ASS 时间戳精度为百分之一秒。
fn write_timestamp<W: Write>(writer: &mut W, milliseconds: i64) -> std::io::Result<()> {
    let total = milliseconds.max(0);
    let centiseconds = total / 10 % 100;
    let seconds = total / 1_000 % 60;
    let minutes = total / 60_000 % 60;
    let hours = total / 3_600_000;
    write!(
        writer,
        "{hours}:{minutes:02}:{seconds:02}.{centiseconds:02}"
    )
}

#[cfg(test)]
mod tests {
    use super::{
        AssExportOptions, escape_ass_text, estimated_text_width, parse_css_hex_rgb, write_ass,
    };
    use crate::models::settings::AppSettings;

    fn options() -> AssExportOptions {
        AssExportOptions::try_from_settings(&AppSettings::default()).unwrap()
    }

    fn render(lines: &[&str], options: &AssExportOptions) -> (String, u64) {
        let input = lines.join("\n");
        let mut output = Vec::new();
        let count = write_ass(input.as_bytes(), &mut output, options).unwrap();
        (String::from_utf8(output).unwrap(), count)
    }

    fn event(kind: &str, content: &str) -> String {
        format!(
            r#"{{"kind":"{kind}","user":"viewer","is_self":false,"content":"{content}","color":null,"ts":1}}"#
        )
    }

    #[test]
    fn writes_a_playable_script_with_scrolling_dialogue() {
        let (script, count) = render(
            &[&format!(
                r#"{{"offset_ms":1500,"events":[{}]}}"#,
                event("chat", "你好世界")
            )],
            &options(),
        );

        assert_eq!(count, 1);
        assert!(script.starts_with("[Script Info]"));
        assert!(script.contains("PlayResX: 1920"));
        assert!(script.contains("\nStyle: R2L,"));
        assert!(script.contains("\n[Events]\n"));
        let dialogue = script
            .lines()
            .find(|line| line.starts_with("Dialogue:"))
            .expect("dialogue");
        assert!(dialogue.starts_with("Dialogue: 0,0:00:01.50,"));
        assert!(dialogue.contains(",R2L,,0000,0000,0000,,{\\move("));
        assert!(dialogue.ends_with("你好世界"));
    }

    #[test]
    fn drops_service_notices_and_shielded_content() {
        let mut settings = AppSettings::default();
        settings.recording_ass.shield_rules = vec!["广告".into()];
        settings.recording_ass.filter_gifts = true;
        let options = AssExportOptions::try_from_settings(&settings).unwrap();

        let (script, count) = render(
            &[&format!(
                r#"{{"offset_ms":0,"events":[{},{},{},{},{},{}]}}"#,
                event("chat", "保留"),
                event("enter", "观众进入直播间"),
                event("chat", "路人 进入了直播间"),
                event("social", "关注了主播"),
                event("gift", "送出礼物"),
                event("chat", "这是广告内容"),
            )],
            &options,
        );

        assert_eq!(count, 1);
        assert_eq!(
            script
                .lines()
                .filter(|line| line.starts_with("Dialogue:"))
                .count(),
            1
        );
        assert!(script.contains("保留"));
    }

    #[test]
    fn merges_repeated_chat_inside_the_anchor_window_only() {
        let options = options();
        let (script, count) = render(
            &[
                &format!(r#"{{"offset_ms":0,"events":[{}]}}"#, event("chat", "6")),
                &format!(r#"{{"offset_ms":2000,"events":[{}]}}"#, event("chat", "6")),
                // Beyond the 10s window from the anchor, so it starts a new one
                // instead of extending the first entry's count.
                &format!(r#"{{"offset_ms":15000,"events":[{}]}}"#, event("chat", "6")),
                &format!(r#"{{"offset_ms":20000,"events":[{}]}}"#, event("chat", "6")),
            ],
            &options,
        );

        assert_eq!(count, 2);
        assert_eq!(
            script.matches("6\\h×2").count(),
            2,
            "each anchor keeps its own count: {script}"
        );
    }

    #[test]
    fn keeps_super_chat_marker_and_color() {
        let (script, _) = render(
            &[&format!(
                r#"{{"offset_ms":0,"events":[{}]}}"#,
                event("super_chat", "感谢")
            )],
            &options(),
        );

        assert!(script.contains("\\c&H6AD7FF&}【SC】感谢"));
    }

    #[test]
    fn separates_simultaneous_danmaku_into_distinct_lanes() {
        let options = options();
        let (script, _) = render(
            &[&format!(
                r#"{{"offset_ms":0,"events":[{},{}]}}"#,
                event("chat", "第一条"),
                event("chat", "第二条"),
            )],
            &options,
        );

        let positions: Vec<&str> = script
            .lines()
            .filter(|line| line.starts_with("Dialogue:"))
            .collect();
        assert_eq!(positions.len(), 2);
        assert!(positions[0].contains(&format!(",{},", options.top_margin)));
        assert!(positions[1].contains(&format!(",{},", options.top_margin + options.line_height)));
    }

    #[test]
    fn skips_an_incomplete_final_line() {
        let (_, count) = render(
            &[
                &format!(r#"{{"offset_ms":0,"events":[{}]}}"#, event("chat", "完整")),
                r#"{"offset_ms":10,"events":[{"kind":"chat""#,
            ],
            &options(),
        );

        assert_eq!(count, 1);
    }

    #[test]
    fn neutralizes_override_blocks_in_danmaku_text() {
        assert_eq!(escape_ass_text("{\\pos(0,0)}x"), "\\{\\pos(0,0)\\}x");
        assert_eq!(escape_ass_text("a\\Nb"), "a\\\u{200B}Nb");
        assert_eq!(escape_ass_text("a b"), "a\\hb");
    }

    #[test]
    fn parses_only_hexadecimal_css_colors() {
        assert_eq!(parse_css_hex_rgb("#ff0000"), Some(0xFF0000));
        assert_eq!(parse_css_hex_rgb("#f00"), Some(0xFF0000));
        assert_eq!(parse_css_hex_rgb("red"), None);
        assert_eq!(parse_css_hex_rgb("rgb(255,0,0)"), None);
    }

    #[test]
    fn estimates_wide_characters_as_full_width() {
        assert_eq!(estimated_text_width("中文", 30), 60);
        assert!(estimated_text_width("abcd", 30) < estimated_text_width("中文中文", 30));
    }

    #[test]
    fn applies_independent_canvas_and_style_options() {
        let mut settings = AppSettings::default();
        let ass = &mut settings.recording_ass;
        ass.resolution_width = 1280;
        ass.resolution_height = 720;
        ass.font_name = "Noto Sans SC".into();
        ass.font_size = 30;
        ass.opacity_percent = 50;
        ass.outline = 1.5;
        ass.shadow = 1.0;
        ass.bold = true;
        ass.scroll_duration_seconds = 9;
        let options = AssExportOptions::try_from_settings(&settings).unwrap();

        let (script, _) = render(
            &[&format!(
                r#"{{"offset_ms":1000,"events":[{}]}}"#,
                event("chat", "样式")
            )],
            &options,
        );

        assert!(script.contains("PlayResX: 1280"));
        assert!(script.contains("PlayResY: 720"));
        assert!(script.contains("Style: R2L,Noto Sans SC,30,&H80FFFFFF"));
        assert!(script.contains(",1,1.5,1.0,8,"));
        assert!(script.contains("Dialogue: 0,0:00:01.00,0:00:10.00,"));
    }

    #[test]
    fn regular_expression_shield_rules_are_compiled_once() {
        let mut settings = AppSettings::default();
        settings.recording_ass.shield_regex = true;
        settings.recording_ass.shield_rules = vec![r"\d{6,}".into()];
        let options = AssExportOptions::try_from_settings(&settings).unwrap();
        let (script, count) = render(
            &[&format!(
                r#"{{"offset_ms":0,"events":[{},{}]}}"#,
                event("chat", "联系123456"),
                event("chat", "保留123")
            )],
            &options,
        );

        assert_eq!(count, 1);
        assert!(!script.contains("联系123456"));
        assert!(script.contains("保留123"));

        settings.recording_ass.shield_rules = vec!["[".into()];
        assert!(AssExportOptions::try_from_settings(&settings).is_err());
    }
}
