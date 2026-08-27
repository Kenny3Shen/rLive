import { describe, expect, test } from "bun:test";
import type { LivePlayQuality, PlayUrl } from "../src/shared/types/live";
import {
  ROOM_CARD_PREVIEW_DELAY_MS,
  isRoomCardPreviewPointer,
  pickRoomCardPreviewQuality,
  pickRoomCardPreviewSource,
  roomCardPreviewHlsOptions,
  roomCardPreviewMpegtsOptions,
  supportsRoomCardPreview,
} from "../src/features/room/player/roomCardPreview";
import { liveFlvPlaybackOptions } from "../src/features/room/player/useWebPlayer";

function line(overrides: Partial<PlayUrl>): PlayUrl {
  return {
    source_id: "a",
    label: "线路",
    protocol: "flv",
    priority: 0,
    url: "https://example.com/live.flv",
    headers: {},
    ...overrides,
  };
}

function quality(name: string): LivePlayQuality {
  return { quality: name, data: name };
}

describe("room card hover preview", () => {
  test("only arms on desktop fine pointers that accept motion", () => {
    expect(supportsRoomCardPreview({ mobile: false, finePointer: true, reducedMotion: false })).toBe(
      true,
    );
    expect(supportsRoomCardPreview({ mobile: true, finePointer: true, reducedMotion: false })).toBe(
      false,
    );
    expect(supportsRoomCardPreview({ mobile: false, finePointer: false, reducedMotion: false })).toBe(
      false,
    );
    expect(supportsRoomCardPreview({ mobile: false, finePointer: true, reducedMotion: true })).toBe(
      false,
    );
  });

  test("treats touch and pen hover as accidental", () => {
    expect(isRoomCardPreviewPointer("mouse")).toBe(true);
    expect(isRoomCardPreviewPointer(undefined)).toBe(true);
    expect(isRoomCardPreviewPointer("touch")).toBe(false);
    expect(isRoomCardPreviewPointer("pen")).toBe(false);
  });

  test("dwell delay outlasts a pointer sweeping across a card row", () => {
    expect(ROOM_CARD_PREVIEW_DELAY_MS).toBeGreaterThanOrEqual(400);
  });

  test("picks the cheapest quality and drops to nothing when the room offers none", () => {
    expect(pickRoomCardPreviewQuality([quality("原画"), quality("高清"), quality("流畅")])).toEqual(
      quality("流畅"),
    );
    expect(pickRoomCardPreviewQuality([quality("原画")])).toEqual(quality("原画"));
    expect(pickRoomCardPreviewQuality([])).toBeNull();
  });

  test("takes the highest ranked line without probing", () => {
    const lines = [
      line({ source_id: "slow", priority: 5 }),
      line({ source_id: "fast", priority: 1 }),
    ];
    expect(pickRoomCardPreviewSource(lines)?.source_id).toBe("fast");
    expect(pickRoomCardPreviewSource([])).toBeNull();
  });

  test("buffers far less than the room player and never stashes", () => {
    const preview = roomCardPreviewMpegtsOptions("flv");
    const room = liveFlvPlaybackOptions(false);
    const previewConfig = preview.mpegtsConfig as Record<string, unknown>;
    const roomConfig = room.mpegtsConfig as Record<string, unknown>;

    expect(preview.mediaDataSource).toMatchObject({ type: "flv", isLive: true, hasAudio: false });
    expect(previewConfig.enableStashBuffer).toBe(false);
    expect(previewConfig.autoCleanupSourceBuffer).toBe(true);
    expect(previewConfig.autoCleanupMaxBackwardDuration as number).toBeLessThan(
      roomConfig.autoCleanupMaxBackwardDuration as number,
    );
  });

  test("caps the hls rendition to the card surface", () => {
    const options = roomCardPreviewHlsOptions();
    expect(options.capLevelToPlayerSize).toBe(true);
    expect(options.startLevel).toBe(0);
    expect(options.maxBufferLength as number).toBeLessThan(30);
  });
});
