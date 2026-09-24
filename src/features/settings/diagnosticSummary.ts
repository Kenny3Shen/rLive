import type { PlaybackTelemetrySnapshot } from "@/shared/types/player";

export const MAX_DIAGNOSTIC_BYTES = 128 * 1024;
export const MAX_PLAYBACK_SAMPLES = 24;
export const PLAYBACK_WINDOW_MS = 10 * 60 * 1000;

type DiagnosticLog = {
  exists: boolean;
  truncated: boolean;
  omitted_lines: number;
  entries: { at_ms: number; level: "WARN" | "ERROR"; component: string; codes: string[] }[];
};

/** Rust 已完成白名单投影；不接收原始日志、账号名称或凭据。 */
export type DiagnosticSnapshot = {
  generated_at_ms: number;
  app_version: string;
  platform: string;
  architecture: string;
  logs: { current: DiagnosticLog; previous: DiagnosticLog };
  proxy: {
    sessions: number;
    upstream_requests: number;
    upstream_failures: number;
    bytes_forwarded: number;
    first_response_samples: number;
    first_response_ms_sum: number;
    first_response_ms_max: number;
  };
  accounts: {
    site_id: string;
    has_cookie: boolean | null;
    verification: "not_checked";
  }[];
};

export type DiagnosticSection = { id: string; label: string; value: unknown };

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER
    ? value
    : null;
}

function member(value: unknown, allowed: readonly string[]): string | null {
  return typeof value === "string" && allowed.includes(value) ? value : null;
}

/** 只提取引擎及数字版本，不导出含设备型号/自定义标识的完整 User-Agent。 */
export function diagnosticWebView(userAgent: string): string {
  for (const name of ["Edg", "Chrome", "AppleWebKit"]) {
    const version = userAgent.match(
      new RegExp(`\\b${name}/([0-9]{1,4}(?:\\.[0-9]{1,6}){0,3})(?=\\s|$)`),
    );
    if (version) return `${name}/${version[1]}`;
  }
  return "未知（未导出完整 User-Agent）";
}

/** 不透传快照对象：协议、切源方式白名单，指标只接收有限非负数字。 */
export function diagnosticPlayback(
  snapshots: readonly PlaybackTelemetrySnapshot[],
  generatedAtMs: number,
) {
  const recent = snapshots.filter((sample) => {
    const at = numberOrNull(sample.sampled_at_ms);
    return at !== null && at <= generatedAtMs && at >= generatedAtMs - PLAYBACK_WINDOW_MS;
  });
  const selected = recent.slice(-MAX_PLAYBACK_SAMPLES);
  // session_id 含播放器来源信息，导出仅用本次摘要内从 1 开始的分组编号。
  const sessions = new Map<string, number>();
  const samples = selected.map((sample) => {
    let session = null;
    if (typeof sample.session_id === "string") {
      if (!sessions.has(sample.session_id)) sessions.set(sample.session_id, sessions.size + 1);
      session = sessions.get(sample.session_id)!;
    }
    const numeric = (key: keyof PlaybackTelemetrySnapshot) => numberOrNull(sample[key]);
    return {
      session,
      sampled_at_ms: numeric("sampled_at_ms"),
      protocol: member(sample.protocol, ["hls", "dash", "flv", "mp4", "mpegts", "native"]),
      switch_mode: member(sample.switch_mode, ["hard", "soft"]),
      startup_ms: numeric("startup_ms"),
      playing_ms: numeric("playing_ms"),
      waiting_count: numeric("waiting_count"),
      stalled_count: numeric("stalled_count"),
      rebuffer_ms: numeric("rebuffer_ms"),
      buffered_seconds: numeric("buffered_seconds"),
      seekable_tail_seconds: numeric("live_latency_seconds"),
      total_video_frames: numeric("total_video_frames"),
      dropped_video_frames: numeric("dropped_video_frames"),
      video_width: numeric("video_width"),
      video_height: numeric("video_height"),
      long_task_count: numeric("long_task_count"),
      long_task_ms: numeric("long_task_ms"),
      proxy: sample.proxy
        ? {
            upstream_requests: numberOrNull(sample.proxy.upstream_requests),
            upstream_failures: numberOrNull(sample.proxy.upstream_failures),
            bytes_forwarded: numberOrNull(sample.proxy.bytes_forwarded),
            first_response_ms: numberOrNull(sample.proxy.first_response_ms),
            latest_response_ms: numberOrNull(sample.proxy.latest_response_ms),
          }
        : null,
    };
  });
  const times = samples.map((sample) => sample.sampled_at_ms!);
  return {
    note: "最近 10 分钟内最多 24 条已有内存采样，不表示当前仍在播放；无采样可能是未播放、IPTV 或当前平台未启用遥测。startup_ms 是遥测会话到 playing，不是点击到首帧；seekable_tail_seconds 不是端到端直播延迟；多路 long task 不能相加。",
    available_samples: recent.length,
    omitted_samples: snapshots.length - samples.length,
    from_ms: times.length ? Math.min(...times) : null,
    to_ms: times.length ? Math.max(...times) : null,
    samples,
  };
}

// 同样显式投影 IPC 字段，后端未来新增字段也不会自动进入导出。
function diagnosticLog(log: DiagnosticLog) {
  return {
    exists: log.exists,
    truncated: log.truncated,
    omitted_lines: log.omitted_lines,
    entries: log.entries.map((entry) => ({
      at_ms: entry.at_ms,
      level: entry.level,
      component: entry.component,
      codes: entry.codes,
    })),
  };
}

export function diagnosticSections(
  backend: DiagnosticSnapshot,
  playback: readonly PlaybackTelemetrySnapshot[],
  userAgent: string,
): DiagnosticSection[] {
  return [
    {
      id: "environment",
      label: "版本与运行环境",
      value: {
        app_version: backend.app_version,
        platform: backend.platform,
        architecture: backend.architecture,
        webview: diagnosticWebView(userAgent),
      },
    },
    {
      id: "accounts",
      label: "本机账号保存状态（未联网验证）",
      value: backend.accounts.map((account) => ({
        site_id: account.site_id,
        has_cookie: account.has_cookie,
        verification: account.verification,
      })),
    },
    {
      id: "logs",
      label: "日志事件摘要（不含正文）",
      value: {
        note: "当前及上一份日志各最多读取 256 KiB 尾部，每份最多 100 条已知事件；未识别行省略。时间见 at_ms，窗口外行数未知。truncated 也可能表示读取失败，不代表没有错误。",
        current: diagnosticLog(backend.logs.current),
        previous: diagnosticLog(backend.logs.previous),
      },
    },
    {
      id: "proxy",
      label: "当前活动代理聚合指标",
      value: {
        note: "仅包含生成时仍活动的代理；已结束会话不计入，首响应耗时不是媒体首帧耗时。",
        counters: {
          sessions: backend.proxy.sessions,
          upstream_requests: backend.proxy.upstream_requests,
          upstream_failures: backend.proxy.upstream_failures,
          bytes_forwarded: backend.proxy.bytes_forwarded,
          first_response_samples: backend.proxy.first_response_samples,
          first_response_ms_sum: backend.proxy.first_response_ms_sum,
          first_response_ms_max: backend.proxy.first_response_ms_max,
        },
      },
    },
    {
      id: "playback",
      label: "近期播放阶段与计数",
      value: diagnosticPlayback(playback, backend.generated_at_ms),
    },
  ];
}

/** 预览与导出共用同一份序列化文本，不在保存时重新采样或补回已移除字段。 */
export function renderDiagnosticSummary(
  generatedAtMs: number,
  sections: DiagnosticSection[],
): string {
  const text = JSON.stringify(
    {
      schema_version: 1,
      generated_at_ms: generatedAtMs,
      privacy:
        "白名单摘要，不包含原始日志正文、地址、用户路径、观看内容、字幕、聊天、用户名或凭据；不自动上传。",
      sections,
    },
    null,
    2,
  );
  if (new TextEncoder().encode(text).byteLength > MAX_DIAGNOSTIC_BYTES) {
    throw new Error("诊断摘要超过 128 KiB，请移除部分字段后重试");
  }
  return text;
}
