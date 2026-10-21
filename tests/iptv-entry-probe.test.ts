import { describe, expect, test } from "bun:test";
import { getIptvEntryProbeChannels } from "../src/features/iptv/entryProbe";
import { iptvCheckIdentity, type IptvAvailabilityState } from "../src/features/iptv/availability";
import type { IptvChannel } from "../src/features/iptv/types";

function channel(url: string, headers: Record<string, string> = {}): IptvChannel {
  return { id: url, name: url, group: "", logo: null, url, protocol: "hls", headers };
}
const a = channel("https://a/live.m3u8");
const b = channel("https://b/live.m3u8");
const cached: IptvAvailabilityState = {
  status: "available",
  latencyMs: 12,
  httpStatus: 200,
  message: null,
  checkedAt: 0,
};

describe("IPTV 按缓存进入检测", () => {
  test("未进入或没有频道时不检测", () => {
    expect(getIptvEntryProbeChannels([a], new Map(), false)).toEqual([]);
    expect(getIptvEntryProbeChannels([], new Map(), true)).toEqual([]);
  });
  test("没有缓存时检测，已有检测运行时不叠加", () => {
    expect(getIptvEntryProbeChannels([a, b], new Map(), true)).toEqual([a, b]);
    expect(getIptvEntryProbeChannels([a], new Map(), true, true)).toEqual([]);
  });
  test("已有结果即使陈旧或不可用也不自动重测", () => {
    const availability = new Map<string, IptvAvailabilityState>([
      [iptvCheckIdentity(a), cached],
      [iptvCheckIdentity(b), { ...cached, status: "unavailable" }],
    ]);
    expect(getIptvEntryProbeChannels([a, b], availability, true)).toEqual([]);
  });
  test("更新列表只检测新增或请求头改变的配置", () => {
    const changed = channel(a.url, { Referer: "https://site" });
    const availability = new Map([[iptvCheckIdentity(a), cached]]);
    expect(getIptvEntryProbeChannels([a, b, changed], availability, true)).toEqual([b, changed]);
  });
  test("检测中条目不重复加入", () => {
    const availability = new Map<string, IptvAvailabilityState>([
      [iptvCheckIdentity(a), { status: "checking" }],
    ]);
    expect(getIptvEntryProbeChannels([a, b], availability, true)).toEqual([b]);
  });
});
