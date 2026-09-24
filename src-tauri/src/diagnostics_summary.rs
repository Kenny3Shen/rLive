//! 诊断导出采用白名单投影，而不是对任意日志正文做文本脱敏。
//!
//! 唯一来自日志的数值是解析、归一化后的时间；级别、组件与事件类别均由
//! 固定表产生。未知 target、未知事件及所有结构化字段一律丢弃。新增日志
//! 不会自动扩大导出范围，必须先审查并显式加入白名单。

use std::collections::VecDeque;

use chrono::DateTime;
use serde::Serialize;

use crate::commands::diagnostics::{AppLogSnapshot, LogFileContent};
use crate::models::live::SiteId;
use crate::stream_proxy::StreamProxyTelemetryTotals;

const MAX_ENTRIES: usize = 100;

#[derive(Debug, Serialize)]
pub struct DiagnosticSnapshot {
    pub generated_at_ms: i64,
    pub app_version: &'static str,
    pub platform: &'static str,
    pub architecture: &'static str,
    pub logs: DiagnosticLogs,
    pub proxy: StreamProxyTelemetryTotals,
    pub accounts: Vec<DiagnosticAccount>,
}

#[derive(Debug, Serialize)]
pub struct DiagnosticLogs {
    pub current: DiagnosticLog,
    pub previous: DiagnosticLog,
}

/// 只描述有界文件尾部，不承诺覆盖最近多少分钟。
/// 时间范围可从 entries 的 at_ms 最小值与最大值取得；空数组表示无可用时间。
#[derive(Debug, Serialize)]
pub struct DiagnosticLog {
    pub exists: bool,
    /// 字节窗口、读取失败、不完整行或条数上限导致信息不完整。
    pub truncated: bool,
    /// 窗口内丢弃的行数（包括首尾残行和未知行）。窗口外行数未知，不扫描全文件。
    pub omitted_lines: usize,
    /// 按文件顺序保留最新 100 条，而非按可能发生校时的时间戳排序。
    pub entries: Vec<DiagnosticEntry>,
}

#[derive(Debug, Serialize)]
pub struct DiagnosticEntry {
    pub at_ms: i64,
    pub level: DiagnosticLevel,
    pub component: &'static str,
    pub codes: Vec<&'static str>,
}

#[derive(Debug, Serialize)]
pub enum DiagnosticLevel {
    #[serde(rename = "WARN")]
    Warn,
    #[serde(rename = "ERROR")]
    Error,
}

#[derive(Debug, Serialize)]
pub struct DiagnosticAccount {
    pub site_id: SiteId,
    pub has_cookie: Option<bool>,
    pub verification: AccountVerification,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AccountVerification {
    NotChecked,
}

pub fn build_snapshot(
    generated_at_ms: i64,
    logs: &AppLogSnapshot,
    proxy: StreamProxyTelemetryTotals,
    accounts: Vec<DiagnosticAccount>,
) -> DiagnosticSnapshot {
    DiagnosticSnapshot {
        generated_at_ms,
        app_version: env!("CARGO_PKG_VERSION"),
        platform: std::env::consts::OS,
        architecture: std::env::consts::ARCH,
        logs: DiagnosticLogs {
            current: summarize_log(&logs.current),
            previous: summarize_log(&logs.previous),
        },
        proxy,
        accounts,
    }
}

pub fn summarize_log(log: &LogFileContent) -> DiagnosticLog {
    let mut entries = VecDeque::with_capacity(MAX_ENTRIES);
    let mut omitted_lines = log.omitted_lines;
    let mut truncated = log.truncated;
    for line in log.text.split_inclusive('\n') {
        // 写入与快照可能并发：尚未换行的尾记录不参与解析。
        let Some(line) = line.strip_suffix('\n') else {
            omitted_lines += 1;
            truncated = true;
            continue;
        };
        let Some(entry) = parse_entry(line.trim_end_matches('\r')) else {
            omitted_lines += 1;
            continue;
        };
        if entries.len() == MAX_ENTRIES {
            entries.pop_front();
            omitted_lines += 1;
            truncated = true;
        }
        entries.push_back(entry);
    }
    DiagnosticLog {
        exists: log.exists,
        truncated,
        omitted_lines,
        entries: entries.into_iter().collect(),
    }
}

fn parse_entry(line: &str) -> Option<DiagnosticEntry> {
    // 对齐 init_logging 的无 ANSI tracing 格式；不从正文中搜索伪造的头部。
    let (timestamp, rest) = line.split_once(' ')?;
    let at_ms = DateTime::parse_from_rfc3339(timestamp)
        .ok()?
        .timestamp_millis();
    let (level, rest) = rest.trim_start_matches(' ').split_once(' ')?;
    let level = match level {
        "WARN" => DiagnosticLevel::Warn,
        "ERROR" => DiagnosticLevel::Error,
        _ => return None,
    };
    let (target, body) = rest.split_once(": ")?;
    let (component, events) = allowed_events(target)?;
    // with_file(true)/with_line_number(true) 产生源码位置。仅跳过该位置，
    // 绝不导出文件名；兼容没有源码位置的旧日志。格式变化时安全地不匹配。
    let body = body
        .split_once(".rs:")
        .and_then(|(_, rest)| rest.split_once(": "))
        .filter(|(line, _)| !line.is_empty() && line.bytes().all(|b| b.is_ascii_digit()))
        .map_or(body, |(_, rest)| rest);
    let code = events.iter().find_map(|(message, code)| {
        body.strip_prefix(message)
            .filter(|rest| rest.is_empty() || rest.starts_with(' '))
            .map(|_| *code)
    })?;
    // 只返回表中的静态值。包括 error_code/code 在内的字段均不复制，避免
    // 未知错误码、异常正文和带凭据字段成为新的导出通道。
    Some(DiagnosticEntry {
        at_ms,
        level,
        component,
        codes: vec![code],
    })
}

type Events = &'static [(&'static str, &'static str)];

/// 每项均对应当前实际 WARN/ERROR 调用的固定消息。这里的 codes 是事件类别，
/// 不透传日志字段中的任意错误码；同类别的多种失败可归并到一个固定码。
fn allowed_events(target: &str) -> Option<(&'static str, Events)> {
    Some(match target {
        "rlive_lib::stream_proxy" => (
            "stream_proxy",
            &[
                ("stream proxy accept failed", "stream_proxy_accept_failed"),
                (
                    "Twitch 广告清单替换超出响应预算",
                    "twitch_manifest_recovery_timeout",
                ),
                (
                    "Twitch 清单续期超出响应预算",
                    "twitch_manifest_recovery_timeout",
                ),
                (
                    "Twitch 广告替换与历史清单均不可用，只能返回占位清单",
                    "twitch_manifest_unavailable",
                ),
                (
                    "Twitch 清单续期失败且没有历史清单，只能返回占位清单",
                    "twitch_manifest_unavailable",
                ),
                (
                    "Twitch 录制清单预热超时，未取得可录制的分片",
                    "twitch_recording_warmup_timeout",
                ),
            ],
        ),
        "rlive_lib::image_proxy" => (
            "image_proxy",
            &[
                (
                    "image proxy client build failed",
                    "image_proxy_client_failed",
                ),
                ("image proxy accept failed", "image_proxy_accept_failed"),
            ],
        ),
        "rlive_lib::asr" => (
            "asr",
            &[
                (
                    "ASR model preparation failed",
                    "asr_model_preparation_failed",
                ),
                ("ASR runtime load failed", "asr_runtime_load_failed"),
                ("ASR model load failed", "asr_model_load_failed"),
                ("ASR model load task failed", "asr_model_load_failed"),
                (
                    "ASR session mutex poisoned while loading model",
                    "asr_session_unavailable",
                ),
                ("ASR transcription failed", "asr_transcribe_failed"),
                (
                    "failed to clean up speaker model download",
                    "asr_cleanup_failed",
                ),
                (
                    "failed to clean up ASR partial archive",
                    "asr_cleanup_failed",
                ),
            ],
        ),
        "rlive_lib::recording" => (
            "recording",
            &[
                ("发送录制状态事件失败", "recording_event_failed"),
                ("发送录制进度事件失败", "recording_event_failed"),
                ("序列化录制弹幕失败", "recording_danmaku_failed"),
                (
                    "写入录制弹幕轨失败，后续弹幕已停用",
                    "recording_danmaku_failed",
                ),
                ("无法恢复历史录制目录", "recording_recovery_failed"),
                (
                    "录制任务收尾超时，正在强制停止",
                    "recording_shutdown_timeout",
                ),
                (
                    "录制任务优雅退出线程异常，正在强制停止剩余任务",
                    "recording_shutdown_failed",
                ),
                ("无法检查录制剩余空间", "recording_storage_failed"),
                ("无法保存录制结束状态", "recording_metadata_failed"),
                ("重试保存录制失败状态仍未成功", "recording_metadata_failed"),
                (
                    "录制保存位置不可用，已回退默认目录",
                    "recording_storage_failed",
                ),
                ("回滚录制目录迁移失败", "recording_storage_failed"),
            ],
        ),
        "rlive_lib::sites::bilibili" => (
            "site",
            &[
                (
                    "bilibili get_buvid failed; continuing empty",
                    "bilibili_identity_failed",
                ),
                (
                    "bilibili signed getDanmuInfo omitted token; trying legacy endpoint",
                    "bilibili_danmaku_info_failed",
                ),
                (
                    "bilibili signed getDanmuInfo failed; trying legacy endpoint",
                    "bilibili_danmaku_info_failed",
                ),
                (
                    "bilibili legacy danmaku endpoint omitted token",
                    "bilibili_danmaku_info_failed",
                ),
                (
                    "bilibili legacy danmaku endpoint failed",
                    "bilibili_danmaku_info_failed",
                ),
                ("bilibili play info 429; retrying", "bilibili_rate_limit"),
                (
                    "bilibili account recommendation returned no rooms; falling back to public feed",
                    "bilibili_recommendation_fallback",
                ),
                (
                    "bilibili account recommendation failed; falling back to public feed",
                    "bilibili_recommendation_fallback",
                ),
            ],
        ),
        "rlive_lib::commands::danmaku" => (
            "danmaku",
            &[
                (
                    "could not save danmaku send history",
                    "danmaku_history_failed",
                ),
                (
                    "bilibili cookie expired; danmaku falls back to anonymous mode",
                    "bilibili_cookie_expired",
                ),
                (
                    "douyu send rejected because the required Cookie fields are absent",
                    "douyu_send_cookie_missing",
                ),
                (
                    "douyu send rejected by local validation",
                    "douyu_send_validation_failed",
                ),
                (
                    "huya send rejected because the required Cookie fields are absent",
                    "huya_send_cookie_missing",
                ),
            ],
        ),
        "rlive_lib::danmu_rs::douyu" => (
            "danmaku",
            &[
                (
                    "douyu danmaku ws connect failed",
                    "douyu_danmaku_connect_failed",
                ),
                ("douyu danmaku read error", "douyu_danmaku_read_failed"),
                (
                    "douyu send websocket transport connect failed",
                    "douyu_send_connect_failed",
                ),
                (
                    "douyu send encryption request failed",
                    "douyu_send_encryption_failed",
                ),
            ],
        ),
        "rlive_lib::danmu_rs::huya" => (
            "danmaku",
            &[
                (
                    "huya send websocket connect failed",
                    "huya_send_connect_failed",
                ),
                ("huya danmaku read error", "huya_danmaku_read_failed"),
            ],
        ),
        "rlive_lib::danmu_rs::bilibili" => (
            "danmaku",
            &[
                (
                    "bilibili signed getDanmuInfo refresh failed; trying legacy endpoint",
                    "bilibili_danmaku_info_failed",
                ),
                (
                    "bilibili danmaku refresh failed; using previous connection info",
                    "bilibili_danmaku_info_failed",
                ),
            ],
        ),
        "rlive_lib::danmu_rs::douyin" => (
            "danmaku",
            &[(
                "douyin danmaku handshake timed out",
                "douyin_danmaku_connect_timeout",
            )],
        ),
        "rlive_lib::commands::recording" => (
            "recording",
            &[(
                "删除录制的观看进度行失败",
                "recording_watch_progress_failed",
            )],
        ),
        "rlive_lib::commands::android_player_controls" => (
            "android",
            &[(
                "Android 播放器控制命令失败",
                "android_player_controls_error",
            )],
        ),
        "rlive_lib::commands::android_navigation" => (
            "android",
            &[("Android 返回键桥接命令失败", "android_navigation_error")],
        ),
        "rlive_lib::commands::android_system_bars" => (
            "android",
            &[("Android 系统栏命令失败", "android_system_bars_error")],
        ),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stream_proxy::StreamProxy;
    use serde_json::json;

    fn log(text: &str) -> LogFileContent {
        LogFileContent {
            path: "/home/秘密 用户/rlive.log".into(),
            exists: true,
            size_bytes: text.len() as u64,
            truncated: false,
            text: text.into(),
            omitted_lines: 0,
        }
    }

    fn warning(message: &str) -> String {
        format!(
            "2026-08-30T22:51:31.577554+08:00  WARN rlive_lib::stream_proxy: src/stream_proxy.rs:2857: {message}\n"
        )
    }

    #[test]
    fn diagnostics_never_exports_free_text_or_paths() {
        let private = [
            "https://cdn.example.test/private.m3u8?token=secret-signature#fragment",
            "http://private-user:private-password@proxy.example.test/path",
            "token=\"quoted token with spaces\"",
            "Cookie: SESSDATA=cookie-one; bili_jct=cookie-two; extra=cookie-three",
            r#"C:\Users\私密 用户\Videos\观看.mp4"#,
            "/home/中文 user/私有 空间/字幕.srt",
            "chat=聊天私密正文 subtitle=字幕私密正文 watching=观看私密正文",
            "error_code=unknown-private-code unknown_field=unknown-private-value",
        ]
        .join(" ");
        let current = log(&format!(
            "{}{}{}",
            warning(&format!("stream proxy accept failed {private}")),
            warning(&private),
            format!("2026-08-30T22:51:31Z ERROR arbitrary-private-target: {private}\n"),
        ));
        let raw = AppLogSnapshot {
            directory: "/home/秘密 用户/logs".into(),
            current,
            previous: log(""),
        };
        let snapshot = build_snapshot(42, &raw, StreamProxy::new().telemetry_totals(), vec![]);
        let value = serde_json::to_value(&snapshot).unwrap();
        // 整个白名单输出逐字段比对，比枚举有限的敏感词更能防止新增字段穿透。
        assert_eq!(
            value,
            json!({
                "generated_at_ms": 42,
                "app_version": env!("CARGO_PKG_VERSION"),
                "platform": std::env::consts::OS,
                "architecture": std::env::consts::ARCH,
                "logs": {
                    "current": {"exists": true, "truncated": false, "omitted_lines": 2,
                        "entries": [{"at_ms": 1788101491577_i64, "level": "WARN",
                            "component": "stream_proxy", "codes": ["stream_proxy_accept_failed"]}]},
                    "previous": {"exists": true, "truncated": false, "omitted_lines": 0, "entries": []}
                },
                "proxy": {"sessions": 0, "upstream_requests": 0, "upstream_failures": 0,
                    "bytes_forwarded": 0, "first_response_samples": 0,
                    "first_response_ms_sum": 0, "first_response_ms_max": 0},
                "accounts": []
            })
        );
    }

    #[test]
    fn diagnostics_keeps_known_events_normalizes_time_and_rejects_unknown_headers() {
        let text = [
            "2026-08-30T22:51:31.577554+08:00 ERROR rlive_lib::asr: src/asr.rs:1360: ASR transcription failed error=private",
            "2026-08-30T14:51:31.577Z WARN rlive_lib::sites::bilibili: bilibili play info 429; retrying attempt=1",
            "2026-08-30T14:51:31Z WARN rlive_lib::asr::private_target: ASR transcription failed",
            "2026-08-30T14:51:31Z INFO rlive_lib::asr: ASR transcription failed",
            "invalid-time ERROR rlive_lib::asr: ASR transcription failed",
            "2026-08-30T14:51:31Z WARN rlive_lib::asr: unknown event code=asr_transcribe_failed",
            "2026-08-30T14:51:31Z WARN rlive_lib::asr: ASR transcription failed-private",
        ].join("\n") + "\n";
        let summary = summarize_log(&log(&text));
        assert_eq!(summary.entries.len(), 2);
        assert_eq!(summary.omitted_lines, 5);
        assert_eq!(summary.entries[0].at_ms, summary.entries[1].at_ms);
        assert_eq!(summary.entries[0].codes, ["asr_transcribe_failed"]);
        assert_eq!(summary.entries[1].codes, ["bilibili_rate_limit"]);
    }

    #[test]
    fn diagnostics_keeps_last_hundred_in_file_order_and_counts_omissions() {
        let mut text = String::new();
        for index in 0..130 {
            text.push_str(&format!("2026-08-30T14:51:31.{index:03}Z WARN rlive_lib::stream_proxy: stream proxy accept failed\n"));
        }
        text.push_str("unknown private line\n");
        let summary = summarize_log(&log(&text));
        assert_eq!(summary.entries.len(), 100);
        assert_eq!(summary.omitted_lines, 31);
        assert!(summary.truncated);
        assert_eq!(summary.entries[0].at_ms % 1000, 30);
        assert_eq!(summary.entries[99].at_ms % 1000, 129);
    }

    #[test]
    fn diagnostics_drops_unfinished_tail_record() {
        let summary = summarize_log(&log(warning("stream proxy accept failed").trim_end()));
        assert!(summary.entries.is_empty());
        assert!(summary.truncated);
        assert_eq!(summary.omitted_lines, 1);
    }

    #[test]
    fn diagnostics_parses_the_actual_tracing_formatter() {
        use std::io::{self, Write};
        use std::sync::{Arc, Mutex};
        use tracing_subscriber::prelude::*;

        #[derive(Clone)]
        struct Buffer(Arc<Mutex<Vec<u8>>>);
        impl Write for Buffer {
            fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(bytes);
                Ok(bytes.len())
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        let bytes = Arc::new(Mutex::new(Vec::new()));
        let output = Buffer(bytes.clone());
        let subscriber = tracing_subscriber::registry().with(
            tracing_subscriber::fmt::layer()
                .with_ansi(false)
                .with_timer(crate::LocalTimeFormat)
                .with_file(true)
                .with_line_number(true)
                .with_writer(move || output.clone()),
        );
        tracing::subscriber::with_default(subscriber, || {
            tracing::warn!(target: "rlive_lib::stream_proxy", error = "private credential", "stream proxy accept failed");
        });
        let text = String::from_utf8(bytes.lock().unwrap().clone()).unwrap();
        let summary = summarize_log(&log(&text));
        assert_eq!(summary.entries.len(), 1);
        assert_eq!(summary.entries[0].codes, ["stream_proxy_accept_failed"]);
    }
}
