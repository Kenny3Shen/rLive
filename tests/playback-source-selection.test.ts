import { describe, expect, test } from "bun:test";
import type { PlayUrl } from "../src/shared/types/live";
import {
  nextRankedLineIndex,
  rankPlaybackSourceIndices,
} from "../src/features/room/playback/sourceSelection";
import { lineLabel, lineName, playbackProtocol, playbackSourceId } from "../src/lib/playUrl";

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
    expect(playbackSourceId(sources[2], 2)).toBe("third");
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
