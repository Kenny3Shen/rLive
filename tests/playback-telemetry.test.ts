import { beforeEach, describe, expect, test } from "bun:test";
import {
  clearPlaybackTelemetrySnapshots,
  createPlaybackTelemetrySession,
  markTelemetryPlaying,
  markTelemetryStalled,
  markTelemetryWaiting,
  playbackTelemetrySnapshots,
  samplePlaybackTelemetry,
} from "../src/features/room/player/playbackTelemetry";

function ranges(...ends: number[]): TimeRanges {
  return {
    length: ends.length,
    start: () => 0,
    end: (index: number) => ends[index],
  };
}

describe("local playback telemetry", () => {
  beforeEach(() => clearPlaybackTelemetrySnapshots());

  test("measures startup, rebuffering, frames and live edge without source secrets", () => {
    const session = createPlaybackTelemetrySession({
      sessionId: "session-1",
      startedAtEpochMs: 10_000,
      startedAtMonotonicMs: 100,
      siteId: "bilibili",
      sourceId: "bilibili:1",
      protocol: "flv",
      quality: "原画",
      switchMode: "hard",
    });
    markTelemetryPlaying(session, 500);
    markTelemetryWaiting(session, 1_000);
    markTelemetryStalled(session, 1_100);
    markTelemetryPlaying(session, 1_400);

    const snapshot = samplePlaybackTelemetry({
      session,
      nowEpochMs: 20_000,
      nowMonotonicMs: 2_000,
      proxy: null,
      video: {
        currentTime: 20,
        buffered: ranges(24),
        seekable: ranges(26),
        videoWidth: 1920,
        videoHeight: 1080,
        getVideoPlaybackQuality: () => ({ totalVideoFrames: 300, droppedVideoFrames: 3 }),
      },
    });

    expect(snapshot.startup_ms).toBe(400);
    expect(snapshot.rebuffer_ms).toBe(400);
    expect(snapshot.waiting_count).toBe(1);
    expect(snapshot.stalled_count).toBe(1);
    expect(snapshot.buffered_seconds).toBe(4);
    expect(snapshot.live_latency_seconds).toBe(6);
    expect(snapshot.dropped_video_frames).toBe(3);
    expect(JSON.stringify(snapshot)).not.toContain("token");
    expect(playbackTelemetrySnapshots()).toHaveLength(1);
  });
});
