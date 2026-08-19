import { describe, expect, test } from "bun:test";
import type { PlayUrl } from "../src/shared/types/live";
import {
  MAX_PLAYBACK_LINE_PREFERENCES,
  playbackLinePreferenceRoomKey,
  readPlaybackLinePreference,
  rememberPlaybackLine,
  resolvePlaybackLineIndex,
} from "../src/features/room/playback/linePreference";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

const lines: PlayUrl[] = [
  {
    url: "https://one.example/live.flv",
    headers: {},
    source_id: "line-one",
    label: "第一线路",
    protocol: "flv",
    priority: 0,
  },
  {
    url: "https://two.example/live.flv",
    headers: {},
    source_id: "line-two",
    label: "第二线路",
    protocol: "flv",
    priority: 1,
  },
];

describe("room playback line preference", () => {
  test("keeps preferences isolated by platform and room", () => {
    const bilibili = playbackLinePreferenceRoomKey("bilibili", "100");
    const huya = playbackLinePreferenceRoomKey("huya", "100");
    expect(bilibili).not.toBe(huya);
    expect(playbackLinePreferenceRoomKey("bilibili", " 100 ")).toBe(bilibili);
  });

  test("restores source identity before falling back to the old index", () => {
    const storage = memoryStorage();
    const roomKey = playbackLinePreferenceRoomKey("bilibili", "100");
    rememberPlaybackLine(roomKey, lines[1], 1, storage, 10);

    const preference = readPlaybackLinePreference(roomKey, storage);
    expect(preference).toMatchObject({ sourceId: "line-two", index: 1, updatedAt: 10 });
    expect(resolvePlaybackLineIndex([lines[1], lines[0]], preference)).toBe(0);
    expect(resolvePlaybackLineIndex([{ ...lines[0], source_id: "replacement" }], preference)).toBe(
      0,
    );
  });

  test("bounds device-local room history", () => {
    const storage = memoryStorage();
    for (let index = 0; index <= MAX_PLAYBACK_LINE_PREFERENCES; index += 1) {
      rememberPlaybackLine(`room-${index}`, lines[index % 2], index % 2, storage, index);
    }

    expect(readPlaybackLinePreference("room-0", storage)).toBeNull();
    expect(
      readPlaybackLinePreference(`room-${MAX_PLAYBACK_LINE_PREFERENCES}`, storage),
    ).not.toBeNull();
  });
});
