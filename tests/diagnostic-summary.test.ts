import { describe, expect, test } from "bun:test";
import {
  diagnosticPlayback,
  diagnosticSections,
  diagnosticWebView,
  renderDiagnosticSummary,
  MAX_DIAGNOSTIC_BYTES,
  MAX_PLAYBACK_SAMPLES,
  PLAYBACK_WINDOW_MS,
  type DiagnosticSnapshot,
} from "../src/features/settings/diagnosticSummary";
import type { PlaybackTelemetrySnapshot } from "../src/shared/types/player";

const now = 1_800_000_000_000;
const sample = (overrides: Partial<PlaybackTelemetrySnapshot> = {}): PlaybackTelemetrySnapshot => ({
  session_id: "private-room:session",
  sampled_at_ms: now,
  site_id: "bilibili",
  source_id: "https://user:pw@private.test/m3u?token=abc",
  protocol: "hls",
  quality: "私有观看内容",
  switch_mode: "hard",
  startup_ms: 123,
  playing_ms: 4000,
  waiting_count: 2,
  stalled_count: 1,
  rebuffer_ms: 100,
  buffered_seconds: 3,
  live_latency_seconds: 8,
  total_video_frames: 240,
  dropped_video_frames: 2,
  video_width: 1920,
  video_height: 1080,
  long_task_count: 3,
  long_task_ms: 99,
  proxy: {
    started_at_ms: now - 5000,
    upstream_requests: 8,
    upstream_failures: 1,
    bytes_forwarded: 4567,
    first_response_ms: 22,
    latest_response_ms: 18,
    first_media_at_ms: now - 4000,
  },
  ...overrides,
});

const backend = (): DiagnosticSnapshot => ({
  generated_at_ms: now,
  app_version: "1.0.0",
  platform: "android",
  architecture: "aarch64",
  logs: {
    current: {
      exists: true,
      truncated: false,
      omitted_lines: 1,
      entries: [
        {
          at_ms: now,
          level: "WARN",
          component: "stream_proxy",
          codes: ["stream_proxy_accept_failed"],
        },
      ],
    },
    previous: { exists: false, truncated: false, omitted_lines: 0, entries: [] },
  },
  proxy: {
    sessions: 0,
    upstream_requests: 0,
    upstream_failures: 0,
    bytes_forwarded: 0,
    first_response_samples: 0,
    first_response_ms_sum: 0,
    first_response_ms_max: 0,
  },
  accounts: [{ site_id: "bilibili", has_cookie: true, verification: "not_checked" }],
});

describe("诊断摘要白名单与规模", () => {
  test("播放字段注入敏感信息不能穿透，耗时保留", () => {
    const injected = Object.assign(sample(), {
      unknown: "Cookie=SESSDATA-private",
      subtitle: "字幕私密",
      chat: "聊天私密",
      protocol: "https://user:password@host/path?token=secret",
      waiting_count: "C:\\Users\\Alice Smith\\private",
    }) as unknown as PlaybackTelemetrySnapshot;
    Object.assign(injected.proxy!, { token: "proxy-token", headers: { Cookie: "cookie-token" } });
    const projection = diagnosticPlayback([injected], now);
    const text = JSON.stringify(projection);
    for (const privateValue of [
      "private-room",
      "user:pw",
      "private.test",
      "私有观看",
      "SESSDATA-private",
      "字幕私密",
      "聊天私密",
      "password",
      "Alice Smith",
      "proxy-token",
      "cookie-token",
    ]) {
      expect(text).not.toContain(privateValue);
    }
    expect(projection.samples[0]?.session).toBe(1);
    expect(projection.samples[0]?.startup_ms).toBe(123);
    expect(projection.samples[0]?.proxy?.first_response_ms).toBe(22);
    expect(projection.samples[0]?.protocol).toBeNull();
    expect(projection.samples[0]?.waiting_count).toBeNull();
  });

  test("数字异常不导出，同会话分组只在本摘要内复用", () => {
    const data = diagnosticPlayback(
      [
        sample({ rebuffer_ms: Infinity, long_task_ms: -1 }),
        sample({ session_id: "another-private-room", total_video_frames: NaN }),
        sample(),
      ],
      now,
    );
    expect(data.samples.map((item) => item.session)).toEqual([1, 2, 1]);
    expect(data.samples[0]?.rebuffer_ms).toBeNull();
    expect(data.samples[0]?.long_task_ms).toBeNull();
    expect(data.samples[1]?.total_video_frames).toBeNull();
    expect(data.samples[0]?.seekable_tail_seconds).toBe(8);
  });

  test("时间窗和条数上限显式说明省略，不把旧会话当活动会话", () => {
    const rows = Array.from({ length: 120 }, (_, i) => sample({ sampled_at_ms: now - 120 + i }));
    rows.push(sample({ sampled_at_ms: now - PLAYBACK_WINDOW_MS - 1 }));
    rows.push(sample({ sampled_at_ms: now + 1 }));
    const data = diagnosticPlayback(rows, now);
    expect(data.samples).toHaveLength(MAX_PLAYBACK_SAMPLES);
    expect(data.available_samples).toBe(120);
    expect(data.omitted_samples).toBe(98);
    expect(data.from_ms).toBe(now - 24);
    expect(data.to_ms).toBe(now - 1);
    expect(
      diagnosticPlayback([sample({ sampled_at_ms: now - PLAYBACK_WINDOW_MS })], now).samples,
    ).toHaveLength(1);
  });

  test("无采样与移动端缺指标正常退化", () => {
    const data = diagnosticPlayback([], now);
    expect(data.samples).toEqual([]);
    expect(data.from_ms).toBeNull();
    expect(data.to_ms).toBeNull();
    const text = renderDiagnosticSummary(
      now,
      diagnosticSections(backend(), [], "Android device-private AppleWebKit/537.36"),
    );
    expect(text).toContain('"platform": "android"');
    expect(text).toContain('"sessions": 0');
    expect(text).toContain('"exists": false');
    expect(text).not.toContain("device-private");
  });

  test("只保留引擎数字版本，不保留完整 User-Agent", () => {
    expect(diagnosticWebView("private-device Chrome/153.0.0.0 Edg/153.0.4234.48")).toBe(
      "Edg/153.0.4234.48",
    );
    expect(diagnosticWebView("Android-secret Chrome/153.0.0.0 Mobile Safari/537.36")).toBe(
      "Chrome/153.0.0.0",
    );
    expect(diagnosticWebView("token-only-private")).not.toContain("token-only-private");
  });

  test("IPC 新增未知字段不自动导出，用户移除字段不在序列化时补回", () => {
    const data = backend();
    const secret = "NEVER_EXPORT_THIS";
    Object.assign(data, { secret });
    Object.assign(data.logs.current, { text: secret, directory: secret });
    Object.assign(data.logs.current.entries[0]!, { message: secret });
    Object.assign(data.proxy, { url: secret });
    Object.assign(data.accounts[0]!, { username: secret, cookie: secret });
    const sections = diagnosticSections(data, [sample()], "Chrome/153.0.0.0");
    expect(renderDiagnosticSummary(now, sections)).not.toContain(secret);
    const removed = sections.filter((section) => !["logs", "accounts"].includes(section.id));
    const text = renderDiagnosticSummary(now, removed);
    expect(text).not.toContain("stream_proxy_accept_failed");
    expect(text).not.toContain("has_cookie");
    expect(text).toContain('"startup_ms": 123');
    expect(JSON.parse(text).sections).toHaveLength(3);
    expect(renderDiagnosticSummary(now, [])).toContain('"sections": []');
  });

  test("最大正常快照有界，超限文本按 UTF-8 字节拒绝而不是静默截断", () => {
    const data = backend();
    data.logs.current.entries = Array.from({ length: 100 }, () => ({
      at_ms: now,
      level: "ERROR",
      component: "recording",
      codes: ["recording_watch_progress_failed"],
    }));
    data.logs.previous = structuredClone(data.logs.current);
    const rows = Array.from({ length: 120 }, () => sample());
    const text = renderDiagnosticSummary(now, diagnosticSections(data, rows, "Chrome/153.0.0.0"));
    expect(new TextEncoder().encode(text).byteLength).toBeLessThan(MAX_DIAGNOSTIC_BYTES);
    expect(() =>
      renderDiagnosticSummary(now, [
        { id: "large", label: "large", value: "中".repeat(MAX_DIAGNOSTIC_BYTES / 3) },
      ]),
    ).toThrow("128 KiB");
  });
});
