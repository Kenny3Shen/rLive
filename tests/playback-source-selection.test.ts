import { describe, expect, test } from "bun:test";
import type { PlayUrl } from "../src/shared/types/live";
import {
  nextRankedLineIndex,
  rankPlaybackSourceIndices,
} from "../src/features/room/playback/sourceSelection";
import {
  lineLabel,
  lineName,
  playbackProtocol,
  playbackSourceId,
  playbackSourcePriority,
} from "../src/lib/playUrl";
import {
  canRenewPlaybackInPlace,
  playbackSourceFromKey,
  playUrlKey,
  shouldSoftSwitchToSource,
} from "../src/features/room/playback/sourceIdentity";

const sources: PlayUrl[] = [
  {
    source_id: "primary",
    label: "主线路",
    protocol: "flv",
    priority: 0,
    url: "https://one.example/live?token=secret",
    headers: {},
  },
  {
    source_id: "backup",
    label: "备用线路",
    protocol: "hls",
    priority: 1,
    url: "https://two.example/live?id=1",
    headers: {},
  },
  {
    source_id: "third",
    label: "第三线路",
    protocol: "flv",
    priority: 2,
    url: "https://three.example/live.flv",
    headers: {},
  },
];

describe("structured playback sources", () => {
  test("explicit protocol and safe label win over URL guessing", () => {
    expect(playbackProtocol(sources[1])).toBe("hls");
    expect(lineName(sources[1], 1)).toBe("备用线路");
    expect(lineName("https://example.test/live.flv", 0)).toBe("线路1");
    expect(lineName({ ...sources[1], label: "Twitch HLS" }, 1)).toBe("Twitch");
    expect(lineName({ ...sources[0], label: "主线路（FLV）" }, 0)).toBe("主线路");
    expect(lineLabel(sources[1], 1)).toBe("备用线路（HLS）");
    expect(lineLabel("https://example.test/live.flv", 0)).toBe("线路1（FLV）");
    expect(playbackSourceId(sources[2])).toBe("third");
    expect(playbackSourceId({ ...sources[2], source_id: " third " })).toBe("third");
    expect(playbackSourcePriority({ ...sources[0], priority: -1 })).toBe(0);
  });
});

describe("smart playback source selection", () => {
  test("ranks by adapter priority and keeps original order within a tie", () => {
    expect(rankPlaybackSourceIndices(sources)).toEqual([0, 1, 2]);
  });

  test("a lower priority value wins regardless of declaration order", () => {
    const reordered = [
      { ...sources[0], priority: 5 },
      { ...sources[1], priority: 0 },
      { ...sources[2], priority: 5 },
    ];
    expect(rankPlaybackSourceIndices(reordered)).toEqual([1, 0, 2]);
  });

  test("failover follows rank and skips exhausted lines", () => {
    expect(
      nextRankedLineIndex({
        currentIndex: 1,
        rankedIndices: [1, 2, 0],
        exhaustedIndices: new Set([1, 2]),
      }),
    ).toBe(0);
  });
});

describe("播放源身份与原地续期", () => {
  test("语义 key 可还原，且对请求头顺序不敏感", () => {
    const source: PlayUrl = {
      ...sources[0],
      headers: { referer: "https://live.bilibili.com", "user-agent": "ua" },
    };
    const reordered = {
      ...source,
      headers: { "user-agent": "ua", referer: "https://live.bilibili.com" },
    };
    expect(playUrlKey(source)).toBe(playUrlKey(reordered));
    expect(playbackSourceFromKey(playUrlKey(source))).toEqual(source);
    expect(playbackSourceFromKey("not-json")).toBeNull();
  });

  test("恢复元数据参与语义 key 并可完整还原", () => {
    const source: PlayUrl = {
      ...sources[0],
      twitch_ad_recovery: {
        login: "channel",
        selector: "video",
        target_width: 1920,
        target_height: 1080,
        target_frame_rate_milli: 30_000,
      },
      douyu_flv_recovery: {
        room_id: "6979222",
        rate: 4,
        cdn: "hw-h5",
      },
    };
    const key = playUrlKey(source);
    expect(playbackSourceFromKey(key)).toEqual(source);
    expect(
      playUrlKey({
        ...source,
        twitch_ad_recovery: {
          target_frame_rate_milli: 30_000,
          target_height: 1080,
          target_width: 1920,
          selector: "video",
          login: "channel",
        },
        douyu_flv_recovery: {
          cdn: "hw-h5",
          rate: 4,
          room_id: "6979222",
        },
      }),
    ).toBe(key);
    expect(
      playUrlKey({
        ...source,
        douyu_flv_recovery: { ...source.douyu_flv_recovery!, rate: 0 },
      }),
    ).not.toBe(key);
    expect(
      playUrlKey({
        ...source,
        twitch_ad_recovery: { ...source.twitch_ad_recovery!, selector: "next" },
      }),
    ).not.toBe(key);
  });

  test("损坏的恢复元数据不会还原成播放源", () => {
    const malformed = JSON.parse(playUrlKey(sources[0])) as unknown[];
    malformed[7] = { room_id: "6979222", rate: "4", cdn: "hw-h5" };
    expect(playbackSourceFromKey(JSON.stringify(malformed))).toBeNull();
  });

  test("只有同协议才允许原地重连，地址没变也算", () => {
    const renewed = { ...sources[0], url: "https://one.example/live?token=next" };
    expect(canRenewPlaybackInPlace(sources[0], renewed)).toBe(true);
    // 续期原样返回同一个签名地址：连接仍需重新打开。
    expect(canRenewPlaybackInPlace(sources[0], { ...sources[0] })).toBe(true);
    expect(canRenewPlaybackInPlace(sources[0], sources[1])).toBe(false);
    expect(canRenewPlaybackInPlace(null, sources[0])).toBe(false);
    expect(canRenewPlaybackInPlace(sources[0], null)).toBe(false);
  });

  test("续期可以强制重连，没有活动播放器时让初始化路径接手", () => {
    const base = {
      enabled: true,
      activeSourceKey: playUrlKey(sources[0]),
      targetSourceKey: playUrlKey(sources[0]),
      activeKind: "flv" as const,
      targetKind: "flv" as const,
    };
    expect(shouldSoftSwitchToSource(base)).toBe(false);
    expect(shouldSoftSwitchToSource({ ...base, force: true })).toBe(true);
    const changed = { ...base, targetSourceKey: playUrlKey({ ...sources[0], url: "https://x" }) };
    expect(shouldSoftSwitchToSource(changed)).toBe(true);
    expect(shouldSoftSwitchToSource({ ...changed, activeKind: "hls" })).toBe(false);
    expect(shouldSoftSwitchToSource({ ...changed, activeSourceKey: "" })).toBe(false);
    expect(shouldSoftSwitchToSource({ ...changed, enabled: false })).toBe(false);
  });
});
