import { describe, expect, test } from "bun:test";
import {
  availabilityStateFromResult,
  filterIptvChannelsByAvailability,
  getIptvChannelChecks,
  summarizeIptvAvailability,
  type IptvAvailabilityState,
} from "../src/features/iptv/availability";
import type { IptvChannel } from "../src/features/iptv/types";

function channel(id: string, url = `https://media.example.test/${id}.m3u8`): IptvChannel {
  return {
    id,
    name: id,
    group: "综合",
    logo: null,
    url,
    headers: {},
  };
}

describe("IPTV availability", () => {
  test("deduplicates and limits channel checks while retaining headers", () => {
    const channels = [channel("one"), channel("duplicate", channel("one").url), channel("two")];
    channels[0]!.headers = { referer: "https://example.test/watch" };

    expect(getIptvChannelChecks(channels, 2)).toEqual([
      { url: channels[0]!.url, headers: channels[0]!.headers },
      { url: channels[2]!.url, headers: channels[2]!.headers },
    ]);
  });

  test("filters checked and unchecked channels without hiding an in-flight check", () => {
    const channels = [channel("live"), channel("dead"), channel("pending"), channel("new")];
    const availability = new Map<string, IptvAvailabilityState>([
      [channels[0]!.url, { status: "available", latencyMs: 80, httpStatus: 200, message: null }],
      [
        channels[1]!.url,
        { status: "unavailable", latencyMs: 7000, httpStatus: null, message: "连接超时" },
      ],
      [channels[2]!.url, { status: "checking" }],
    ]);

    expect(filterIptvChannelsByAvailability(channels, availability, "available")).toEqual([
      channels[0],
    ]);
    expect(filterIptvChannelsByAvailability(channels, availability, "unchecked")).toEqual([
      channels[2],
      channels[3],
    ]);
    expect(summarizeIptvAvailability(channels, availability)).toEqual({
      available: 1,
      unavailable: 1,
      checking: 1,
      unchecked: 1,
    });
  });

  test("maps native probe results to stable UI states", () => {
    expect(
      availabilityStateFromResult({
        url: "https://media.example.test/live.m3u8",
        available: false,
        latencyMs: 7123,
        httpStatus: 403,
        message: "频道返回 HTTP 403",
      }),
    ).toEqual({
      status: "unavailable",
      latencyMs: 7123,
      httpStatus: 403,
      message: "频道返回 HTTP 403",
    });
  });
});
