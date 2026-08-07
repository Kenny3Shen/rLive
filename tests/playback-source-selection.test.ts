import { describe, expect, test } from "bun:test";
import type { PlayUrl } from "../src/shared/types/live";
import {
  lineDiagnostics,
  nextRankedLineIndex,
  rankPlaybackSourceIndices,
  shouldAdoptProbeWinner,
  type PlaybackSourceProbe,
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
    protocol: "flv",
    priority: 2,
    url: "https://three.example/live.flv",
    headers: {},
  },
];

function probe(
  sourceId: string,
  index: number,
  available: boolean,
  ttfbMs: number | null,
): PlaybackSourceProbe {
  return {
    source_id: sourceId,
    index,
    available,
    status: available ? 200 : 503,
    ttfb_ms: ttfbMs,
    content_type: null,
    sampled_bytes: available ? 128 : 0,
    error_code: available ? null : "http_status",
  };
}

describe("structured playback sources", () => {
  test("explicit protocol and safe label win over URL guessing", () => {
    expect(playbackProtocol(sources[1])).toBe("hls");
    expect(lineName(sources[1], 1)).toBe("备用线路");
    expect(lineName("https://example.test/live.flv", 0)).toBe("线路1");
    expect(lineName({ ...sources[1], label: "Twitch HLS" }, 1)).toBe("Twitch");
    expect(lineName({ ...sources[0], label: "主线路（FLV）" }, 0)).toBe("主线路");
    expect(lineLabel(sources[1], 1)).toBe("备用线路（HLS）");
    expect(lineLabel("https://example.test/live.flv", 0)).toBe("线路1（FLV）");
    expect(playbackSourceId({ url: "x" }, 2)).toBe("source:3");
  });
});

describe("smart playback source selection", () => {
  test("ranks healthy latency first, unknown second, and failures last", () => {
    const probes = [probe("primary", 0, false, null), probe("backup", 1, true, 180)];
    expect(rankPlaybackSourceIndices(sources, probes)).toEqual([1, 2, 0]);
    expect(lineDiagnostics(sources, probes, true)).toEqual([
      { state: "unavailable", errorCode: "http_status" },
      { state: "available", ttfbMs: 180 },
      { state: "testing" },
    ]);
  });

  test("associates probes by line index when platform source IDs repeat", () => {
    const duplicateSources = sources.map((source) => ({ ...source, source_id: "duplicate" }));
    const probes = [probe("duplicate", 0, false, null), probe("duplicate", 1, true, 90)];

    expect(rankPlaybackSourceIndices(duplicateSources, probes)).toEqual([1, 2, 0]);
    expect(lineDiagnostics(duplicateSources, probes, false)).toEqual([
      { state: "unavailable", errorCode: "http_status" },
      { state: "available", ttfbMs: 90 },
      { state: "untested" },
    ]);
  });

  test("adopts a measured winner before playback but preserves a healthy running source", () => {
    const probes = [probe("primary", 0, true, 600), probe("backup", 1, true, 120)];
    expect(
      shouldAdoptProbeWinner({
        currentIndex: 0,
        winnerIndex: 1,
        hasPlayed: false,
        probes,
        sources,
      }),
    ).toBe(true);
    expect(
      shouldAdoptProbeWinner({
        currentIndex: 0,
        winnerIndex: 1,
        hasPlayed: true,
        probes,
        sources,
      }),
    ).toBe(false);
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
