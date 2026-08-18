import type { IptvChannel } from "./types";

export const IPTV_AVAILABILITY_CHECK_LIMIT = 120;
export const IPTV_AVAILABILITY_BATCH_SIZE = 24;

export type IptvAvailabilityFilter = "all" | "available" | "unavailable" | "unchecked";

export type IptvChannelCheck = Pick<IptvChannel, "url" | "headers">;

export type IptvChannelAvailability = {
  url: string;
  available: boolean;
  latencyMs: number;
  httpStatus: number | null;
  message: string | null;
};

export type IptvAvailabilityState =
  | { status: "checking" }
  | {
      status: "available" | "unavailable";
      latencyMs: number;
      httpStatus: number | null;
      message: string | null;
    };

export type IptvAvailabilitySummary = {
  available: number;
  unavailable: number;
  checking: number;
  unchecked: number;
};

export function availabilityStateFromResult(
  result: IptvChannelAvailability,
): IptvAvailabilityState {
  return {
    status: result.available ? "available" : "unavailable",
    latencyMs: result.latencyMs,
    httpStatus: result.httpStatus,
    message: result.message,
  };
}

export function getIptvChannelChecks(
  channels: readonly IptvChannel[],
  limit = IPTV_AVAILABILITY_CHECK_LIMIT,
): IptvChannelCheck[] {
  const checks: IptvChannelCheck[] = [];
  const seen = new Set<string>();
  for (const channel of channels) {
    if (checks.length >= limit) break;
    if (seen.has(channel.url)) continue;
    seen.add(channel.url);
    checks.push({ url: channel.url, headers: channel.headers });
  }
  return checks;
}

export function filterIptvChannelsByAvailability(
  channels: readonly IptvChannel[],
  availability: ReadonlyMap<string, IptvAvailabilityState>,
  filter: IptvAvailabilityFilter,
): IptvChannel[] {
  if (filter === "all") return [...channels];
  return channels.filter((channel) => {
    const status = availability.get(channel.url)?.status;
    if (filter === "unchecked") return status == null || status === "checking";
    return status === filter;
  });
}

export function summarizeIptvAvailability(
  channels: readonly IptvChannel[],
  availability: ReadonlyMap<string, IptvAvailabilityState>,
): IptvAvailabilitySummary {
  const summary: IptvAvailabilitySummary = {
    available: 0,
    unavailable: 0,
    checking: 0,
    unchecked: 0,
  };
  for (const channel of channels) {
    const status = availability.get(channel.url)?.status;
    if (status) summary[status] += 1;
    else summary.unchecked += 1;
  }
  return summary;
}
