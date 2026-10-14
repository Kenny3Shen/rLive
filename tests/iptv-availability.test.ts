// F-03：IPTV 可用性探测的身份隔离、结果映射与陈旧判定。
//
// 验收要求：同 URL 不同请求头不能串用状态；有效清单但首片失败不显示为已验证；
// 结果按条目区分检测时间并能标出陈旧。
import { describe, expect, test } from "bun:test";
import {
  IPTV_AVAILABILITY_STALE_MS,
  filterIptvChannelsByAvailability,
  getIptvChannelChecks,
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
  overrides: Partial<
    Extract<
      IptvAvailabilityState,
      {
        status: "available";
      }
    >
  > = {},
): IptvAvailabilityState {
  return {
    status: "available",
    latencyMs: 10,
    httpStatus: 200,
    message: null,
    checkedAt: 1_000,
    ...overrides,
  };
}
describe("探测身份", () => {
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
  test("去重按身份而不是 URL", () => {
    const channels = [
      channel("http://a/live.m3u8", {
        Referer: "http://site-a",
      }),
      channel("http://a/live.m3u8", {
        Referer: "http://site-b",
      }),
      channel("http://a/live.m3u8", {
        Referer: "http://site-a",
      }),
      channel("http://b/live.m3u8"),
    ];
    const checks = getIptvChannelChecks(channels);
    expect(checks).toHaveLength(3);
    // 第一个与第三个是同一配置，只应保留一个。
    expect(checks.filter((check) => check.headers.Referer === "http://site-a")).toHaveLength(1);
  });
});
describe("按身份筛选", () => {
  test("同 URL 不同请求头不串用状态", () => {
    const allowed = channel("http://a/live.m3u8", {
      Referer: "http://site-a",
    });
    const blocked = channel("http://a/live.m3u8", {
      Referer: "http://site-b",
    });
    const availability = new Map<string, IptvAvailabilityState>([
      [
        iptvCheckIdentity(allowed),
        state({
          checkedAt: 1_000,
        }),
      ],
      [
        iptvCheckIdentity(blocked),
        {
          status: "unavailable",
          latencyMs: 5,
          httpStatus: 403,
          message: "403",
          checkedAt: 1_000,
        },
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
      [
        iptvCheckIdentity(checking),
        {
          status: "checking",
        },
      ],
      [
        iptvCheckIdentity(done),
        state({
          checkedAt: 1_000,
        }),
      ],
    ]);
    expect(
      filterIptvChannelsByAvailability([fresh, checking, done], availability, "unchecked"),
    ).toEqual([fresh, checking]);
  });
});
describe("结果陈旧", () => {
  test("陈旧筛选只返回过期的已完成条目", () => {
    const stale = channel("http://a/live.m3u8");
    const fresh = channel("http://b/live.m3u8");
    const now = 10 * IPTV_AVAILABILITY_STALE_MS;
    const availability = new Map<string, IptvAvailabilityState>([
      [
        iptvCheckIdentity(stale),
        state({
          checkedAt: 0,
        }),
      ],
      [
        iptvCheckIdentity(fresh),
        state({
          checkedAt: now,
        }),
      ],
    ]);
    expect(filterIptvChannelsByAvailability([stale, fresh], availability, "stale", now)).toEqual([
      stale,
    ]);
  });
});
