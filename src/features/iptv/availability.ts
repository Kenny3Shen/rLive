import type { IptvChannel } from "./types";

export const IPTV_AVAILABILITY_CHECK_LIMIT = 120;
export const IPTV_AVAILABILITY_BATCH_SIZE = 24;

export type IptvAvailabilityFilter = "all" | "available" | "unavailable" | "unchecked" | "stale";

/** 与后端 `IptvProbeLevel` 对应。 */
export type IptvProbeLevel = "reachable" | "media_verified";

export type IptvChannelCheck = Pick<IptvChannel, "url" | "headers"> & {
  /** 是否在「网络可达」之外继续验证首个媒体资源。 */
  deep?: boolean;
};

export type IptvChannelAvailability = {
  url: string;
  available: boolean;
  latencyMs: number;
  httpStatus: number | null;
  message: string | null;
  level: IptvProbeLevel | null;
  mediaMessage: string | null;
};

/**
 * 结果按**完整播放配置**索引，而不是只看 URL。
 *
 * 同一 URL 配不同 Referer/UA 是 IPTV 列表里的常见写法，按 URL 索引会让后一个
 * 条目显示前一个的结论。身份串必须与后端 `channel_check_identity` 一致：
 * URL + 会实际发送的白名单头（user-agent / referer），小写归一、排序。
 */
export function iptvCheckIdentity(channel: Pick<IptvChannel, "url" | "headers">): string {
  const headers: [string, string][] = [];
  for (const [name, value] of Object.entries(channel.headers ?? {})) {
    const normalized = name.trim().toLowerCase();
    if (normalized === "user-agent" || normalized === "referer") {
      headers.push([normalized, value.trim()]);
    }
  }
  headers.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  let identity = channel.url.trim();
  for (const [name, value] of headers) identity += `\n${name}:${value}`;
  return identity;
}

export type IptvAvailabilityState =
  | { status: "checking" }
  | {
      /**
       * `available` 只代表「网络可达且拿到了可识别清单」；
       * `media_verified` 才代表清单引用的媒体也取到了首块字节。
       */
      status: "available" | "unavailable";
      level: IptvProbeLevel | null;
      latencyMs: number;
      httpStatus: number | null;
      message: string | null;
      /** 深探测失败的原因；浅探测或深探测成功时为 null。 */
      mediaMessage: string | null;
      /** 该结果产生的时刻，用于判定陈旧。 */
      checkedAt: number;
    };

/** 超过这个时长就把结果标为「已陈旧」，提示重查。 */
export const IPTV_AVAILABILITY_STALE_MS = 10 * 60_000;

export function availabilityStateFromResult(
  result: IptvChannelAvailability,
  checkedAt = Date.now(),
): IptvAvailabilityState {
  return {
    status: result.available ? "available" : "unavailable",
    level: result.level,
    latencyMs: result.latencyMs,
    httpStatus: result.httpStatus,
    message: result.message,
    mediaMessage: result.mediaMessage,
    checkedAt,
  };
}

/** 结果是否已陈旧。`checking` 与缺失都不算陈旧。 */
export function isIptvAvailabilityStale(
  state: IptvAvailabilityState | undefined,
  now = Date.now(),
  staleMs = IPTV_AVAILABILITY_STALE_MS,
): boolean {
  if (!state || state.status === "checking") return false;
  return now - state.checkedAt > staleMs;
}

/**
 * 按完整播放配置去重，而不是只看 URL。
 * 与后端一致：同一 URL 不同请求头是两个不同的检测目标。
 */
export function getIptvChannelChecks(
  channels: readonly IptvChannel[],
  limit = IPTV_AVAILABILITY_CHECK_LIMIT,
  deep = false,
): IptvChannelCheck[] {
  const checks: IptvChannelCheck[] = [];
  const seen = new Set<string>();
  for (const channel of channels) {
    if (checks.length >= limit) break;
    const identity = iptvCheckIdentity(channel);
    if (seen.has(identity)) continue;
    seen.add(identity);
    checks.push({ url: channel.url, headers: channel.headers, deep });
  }
  return checks;
}

export function filterIptvChannelsByAvailability(
  channels: readonly IptvChannel[],
  availability: ReadonlyMap<string, IptvAvailabilityState>,
  filter: IptvAvailabilityFilter,
  now = Date.now(),
): IptvChannel[] {
  if (filter === "all") return [...channels];
  return channels.filter((channel) => {
    const state = availability.get(iptvCheckIdentity(channel));
    const status = state?.status;
    if (filter === "unchecked") return status == null || status === "checking";
    if (filter === "stale") return isIptvAvailabilityStale(state, now);
    return status === filter;
  });
}

/**
 * 可用性筛选的可选值。
 *
 * 把「已陈旧」单独列出来，是因为「网络可达」不是「现在还能播」：
 * 结果会过期，用户需要能只挑出该重查的条目。
 */
export const IPTV_AVAILABILITY_FILTERS: readonly IptvAvailabilityFilter[] = [
  "all",
  "available",
  "unavailable",
  "unchecked",
  "stale",
];
