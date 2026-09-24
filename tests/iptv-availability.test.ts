// F-03：IPTV 的「网络可达」不等于「媒体已验证可播」。
//
// 验收要求：同 URL 不同请求头不能串用状态；有效清单但首片失败不显示为已验证；
// 结果按条目区分检测时间并能标出陈旧。
import { describe, expect, test } from "bun:test";

import {
  IPTV_AVAILABILITY_STALE_MS,
  availabilityStateFromResult,
  filterIptvChannelsByAvailability,
  getIptvChannelChecks,
  isIptvAvailabilityStale,
  iptvCheckIdentity,
  type IptvAvailabilityState,
} from "../src/features/iptv/availability";
import type { IptvChannel } from "../src/features/iptv/types";

function channel(url: string, headers: Record<string, string> = {}): IptvChannel {
  return {
    id: url,
    name: url,
    group: "",
    logo: null,
    url,
    protocol: "hls",
    headers,
  };
}

function state(
  overrides: Partial<Extract<IptvAvailabilityState, { status: "available" }>> = {},
): IptvAvailabilityState {
  return {
    status: "available",
    level: "reachable",
    latencyMs: 10,
    httpStatus: 200,
    message: null,
    mediaMessage: null,
    checkedAt: 1_000,
    ...overrides,
  };
}

describe("探测身份", () => {
  test("同一 URL 配不同请求头是两个身份", () => {
    const withReferer = channel("http://a/live.m3u8", { Referer: "http://site-a" });
    const otherReferer = channel("http://a/live.m3u8", { Referer: "http://site-b" });
    const withoutHeaders = channel("http://a/live.m3u8");

    expect(iptvCheckIdentity(withReferer)).not.toBe(iptvCheckIdentity(otherReferer));
    expect(iptvCheckIdentity(withReferer)).not.toBe(iptvCheckIdentity(withoutHeaders));
    // 同配置必须稳定，否则每次查询都会落空。
    expect(iptvCheckIdentity(withReferer)).toBe(iptvCheckIdentity(withReferer));
  });

  test("头字段大小写与顺序不影响身份", () => {
    const a = channel("http://a/live.m3u8", {
      Referer: "http://site",
      "User-Agent": "UA",
    });
    const b = channel("http://a/live.m3u8", {
      "user-agent": "UA",
      referer: "http://site",
    });
    expect(iptvCheckIdentity(a)).toBe(iptvCheckIdentity(b));
  });

  test("不参与请求的头字段不影响身份", () => {
    // 后端只转发 user-agent / referer；其余字段既不发也不应改变身份。
    const a = channel("http://a/live.m3u8", { Referer: "http://site" });
    const b = channel("http://a/live.m3u8", {
      Referer: "http://site",
      "X-Ignored": "whatever",
    });
    expect(iptvCheckIdentity(a)).toBe(iptvCheckIdentity(b));
  });

  test("去重按身份而不是 URL", () => {
    const channels = [
      channel("http://a/live.m3u8", { Referer: "http://site-a" }),
      channel("http://a/live.m3u8", { Referer: "http://site-b" }),
      channel("http://a/live.m3u8", { Referer: "http://site-a" }),
      channel("http://b/live.m3u8"),
    ];
    const checks = getIptvChannelChecks(channels);
    expect(checks).toHaveLength(3);
    // 第一个与第三个是同一配置，只应保留一个。
    expect(checks.filter((check) => check.headers.Referer === "http://site-a")).toHaveLength(1);
  });
});

describe("分级可用性", () => {
  test("浅探测成功只标为网络可达，不冒充媒体验证", () => {
    const state = availabilityStateFromResult({
      url: "http://a/live.m3u8",
      available: true,
      latencyMs: 12,
      httpStatus: 200,
      message: null,
      level: "reachable",
      mediaMessage: null,
    });
    expect(state.status).toBe("available");
    expect(state.status === "available" && state.level).toBe("reachable");
    // 媒体未验证时不应有验证结论。
    expect(state.status === "available" && state.mediaMessage).toBe(null);
  });

  test("清单有效但首个分片失败仍是可达，并带上媒体失败原因", () => {
    const state = availabilityStateFromResult({
      url: "http://a/live.m3u8",
      available: true,
      latencyMs: 20,
      httpStatus: 200,
      message: null,
      level: "reachable",
      mediaMessage: "首个媒体资源返回 HTTP 403",
    });
    expect(state.status).toBe("available");
    expect(state.status === "available" && state.level).toBe("reachable");
    // 关键：不能因为清单存在就显示为已验证可播。
    expect(state.status === "available" && state.level).not.toBe("media_verified");
    expect(state.status === "available" && state.mediaMessage).toContain("403");
  });

  test("深探测成功才标为媒体验证", () => {
    const state = availabilityStateFromResult({
      url: "http://a/live.m3u8",
      available: true,
      latencyMs: 30,
      httpStatus: 200,
      message: null,
      level: "media_verified",
      mediaMessage: null,
    });
    expect(state.status === "available" && state.level).toBe("media_verified");
  });

  test("不可用结果不带探测级别", () => {
    const state = availabilityStateFromResult({
      url: "http://a/live.m3u8",
      available: false,
      latencyMs: 7,
      httpStatus: 403,
      message: "频道返回 HTTP 403",
      level: null,
      mediaMessage: null,
    });
    expect(state.status).toBe("unavailable");
    expect(state.status !== "checking" && state.level).toBe(null);
  });
});

describe("按身份筛选", () => {
  test("同 URL 不同请求头不串用状态", () => {
    const allowed = channel("http://a/live.m3u8", { Referer: "http://site-a" });
    const blocked = channel("http://a/live.m3u8", { Referer: "http://site-b" });
    const availability = new Map<string, IptvAvailabilityState>([
      [iptvCheckIdentity(allowed), state({ checkedAt: 1_000 })],
      [
        iptvCheckIdentity(blocked),
        { status: "unavailable", level: null, latencyMs: 5, httpStatus: 403, message: "403", mediaMessage: null, checkedAt: 1_000 },
      ],
    ]);

    const available = filterIptvChannelsByAvailability(
      [allowed, blocked],
      availability,
      "available",
    );
    const unavailable = filterIptvChannelsByAvailability(
      [allowed, blocked],
      availability,
      "unavailable",
    );

    // 旧行为按 URL 索引，两个条目会拿到同一个结论。
    expect(available).toEqual([allowed]);
    expect(unavailable).toEqual([blocked]);
  });

  test("未检测筛选包含缺失与检测中", () => {
    const fresh = channel("http://a/live.m3u8");
    const checking = channel("http://b/live.m3u8");
    const done = channel("http://c/live.m3u8");
    const availability = new Map<string, IptvAvailabilityState>([
      [iptvCheckIdentity(checking), { status: "checking" }],
      [iptvCheckIdentity(done), state({ checkedAt: 1_000 })],
    ]);

    expect(filterIptvChannelsByAvailability([fresh, checking, done], availability, "unchecked")).toEqual([
      fresh,
      checking,
    ]);
  });
});

describe("结果陈旧", () => {
  test("超过阈值才判为陈旧，检测中不算", () => {
    const at = (checkedAt: number) => state({ checkedAt });
    expect(isIptvAvailabilityStale(at(0), IPTV_AVAILABILITY_STALE_MS, IPTV_AVAILABILITY_STALE_MS)).toBe(
      false,
    );
    expect(
      isIptvAvailabilityStale(at(0), IPTV_AVAILABILITY_STALE_MS + 1, IPTV_AVAILABILITY_STALE_MS),
    ).toBe(true);
    expect(isIptvAvailabilityStale(undefined)).toBe(false);
    expect(isIptvAvailabilityStale({ status: "checking" })).toBe(false);
  });

  test("陈旧筛选只返回过期的已完成条目", () => {
    const stale = channel("http://a/live.m3u8");
    const fresh = channel("http://b/live.m3u8");
    const now = 10 * IPTV_AVAILABILITY_STALE_MS;
    const availability = new Map<string, IptvAvailabilityState>([
      [iptvCheckIdentity(stale), state({ checkedAt: 0 })],
      [iptvCheckIdentity(fresh), state({ checkedAt: now })],
    ]);

    expect(
      filterIptvChannelsByAvailability([stale, fresh], availability, "stale", now),
    ).toEqual([stale]);
  });
});
