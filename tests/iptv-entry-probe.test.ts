// 预热从「应用启动」改为「首次进入 IPTV」：不进入该路由就不产生探测流量。
import { describe, expect, test } from "bun:test";

import { shouldRunIptvEntryProbe } from "../src/features/iptv/entryProbe";

describe("IPTV 首次进入预热", () => {
  test("未进入 IPTV 时不探测", () => {
    expect(shouldRunIptvEntryProbe(new Set(), "https://a/list.m3u", false, 12)).toBe(false);
  });

  test("进入但播放列表还没到时不探测", () => {
    expect(shouldRunIptvEntryProbe(new Set(), "https://a/list.m3u", true, 0)).toBe(false);
  });

  test("首次进入且有频道时探测一次", () => {
    expect(shouldRunIptvEntryProbe(new Set(), "https://a/list.m3u", true, 12)).toBe(true);
  });

  test("同一来源离开再返回不重复探测", () => {
    const probed = new Set(["https://a/list.m3u"]);
    expect(shouldRunIptvEntryProbe(probed, "https://a/list.m3u", true, 12)).toBe(false);
  });

  test("换一个来源是新的一次进入", () => {
    const probed = new Set(["https://a/list.m3u"]);
    expect(shouldRunIptvEntryProbe(probed, "https://b/list.m3u", true, 12)).toBe(true);
  });
});
