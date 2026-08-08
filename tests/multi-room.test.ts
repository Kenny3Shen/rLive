import { describe, expect, test } from "bun:test";
import {
  createMultiRoomEntry,
  moveMultiRoomSlot,
  normalizeMultiRoomAudioRoles,
  normalizeMultiRoomSlots,
  promoteMultiRoomSlot,
  type MultiRoomEntry,
} from "../src/features/multi-room/multiRoomStore";
import {
  isMultiRoomMainSlot,
  multiRoomSlotClassName,
  multiRoomSlotLabel,
} from "../src/features/multi-room/multiRoomLayout";
import {
  normalizeWebPlayerAudio,
  playerOwnsFullscreen,
  requestPlayerAutoplay,
} from "../src/features/room/player/useWebPlayer";

function room(id: string): MultiRoomEntry {
  return createMultiRoomEntry(
    {
      site_id: "bilibili",
      room_id: id,
      title: `直播间 ${id}`,
      user_name: `主播 ${id}`,
    },
    id === "main",
  );
}

describe("multi-room audio defaults", () => {
  test("starts the primary audible and every secondary silent", () => {
    expect(room("main")).toMatchObject({ volume: 80, muted: false });
    expect(room("secondary")).toMatchObject({ volume: 0, muted: true });
  });

  test("normalizes per-player volume before the media element mounts", () => {
    expect(normalizeWebPlayerAudio(0, false)).toEqual({
      volume: 0,
      muted: true,
      previousVolume: 80,
    });
    expect(normalizeWebPlayerAudio(135, true)).toEqual({
      volume: 100,
      muted: true,
      previousVolume: 100,
    });
  });

  test("opens the promoted main feed and mutes every secondary feed", () => {
    const promoted = { ...room("secondary"), volume: 0, muted: true };
    const previousMain = room("main");
    const roles = normalizeMultiRoomAudioRoles([promoted, previousMain]);

    expect(roles[0]).toMatchObject({ key: promoted.key, volume: 80, muted: false });
    expect(roles[1]).toMatchObject({ key: previousMain.key, volume: 80, muted: true });
  });

  test("preserves a secondary's chosen volume when opening it as main", () => {
    const promoted = { ...room("secondary"), volume: 35, muted: true };
    const roles = normalizeMultiRoomAudioRoles([promoted, room("main")]);

    expect(roles[0]).toMatchObject({ volume: 35, muted: false });
    expect(roles[1]).toMatchObject({ muted: true });
  });

  test("returns a demoted feed to its remembered secondary slot", () => {
    const main = room("main");
    const topLeft = { ...room("top-left"), secondarySlot: 1 };
    const bottomRight = { ...room("bottom-right"), secondarySlot: 5 };
    const afterTopLeft = promoteMultiRoomSlot(
      [main, topLeft, null, null, null, bottomRight],
      1,
    );
    const afterBottomRight = promoteMultiRoomSlot(afterTopLeft, 5);

    expect(afterBottomRight[0]?.key).toBe(bottomRight.key);
    expect(afterBottomRight[1]?.key).toBe(topLeft.key);
    expect(afterBottomRight[5]?.key).toBe(main.key);
  });

  test("keeps a silent secondary muted after autoplay fallback", async () => {
    let attempts = 0;
    const video = { muted: false } as Pick<HTMLVideoElement, "muted">;
    let recovered: (() => void) | undefined;
    const recovery = new Promise<void>((resolve) => {
      recovered = resolve;
    });

    requestPlayerAutoplay(
      {
        play: () => {
          attempts += 1;
          return attempts === 1 ? Promise.reject(new Error("autoplay blocked")) : Promise.resolve();
        },
      },
      video,
      () => true,
      () => {
        recovered?.();
        return false;
      },
    );
    await recovery;

    expect(attempts).toBe(2);
    expect(video.muted).toBe(true);
  });
});

describe("multi-room fullscreen ownership", () => {
  test("gives fullscreen to the main feed alone", () => {
    // All six feeds share one window, so its fullscreen state would otherwise
    // mark every secondary fullscreen and grow the grid instead of the picture.
    expect(playerOwnsFullscreen(true)).toBe(true);
    expect(playerOwnsFullscreen(false)).toBe(false);
  });

  test("keeps a single room player owning fullscreen by default", () => {
    expect(playerOwnsFullscreen(undefined)).toBe(true);
  });
});

describe("multi-room director layout", () => {
  test("anchors the main feed in the lower-left 2x2 area", () => {
    expect(isMultiRoomMainSlot(0)).toBe(true);
    expect(multiRoomSlotClassName(0)).toContain("col-span-2");
    expect(multiRoomSlotClassName(0)).toContain("row-start-2");
    expect(multiRoomSlotClassName(0)).toContain("row-span-2");
    expect(multiRoomSlotLabel(0)).toBe("主画面");
  });

  test("places secondary feeds across the top and right edge", () => {
    expect(multiRoomSlotClassName(1)).toContain("row-start-1");
    expect(multiRoomSlotClassName(2)).toContain("row-start-1");
    expect(multiRoomSlotClassName(3)).toContain("col-start-3");
    expect(multiRoomSlotClassName(4)).toContain("col-start-3");
    expect(multiRoomSlotClassName(5)).toContain("col-start-3");
  });

  test("swaps any occupied secondary feed into the main slot", () => {
    const main = room("main");
    const secondary = room("secondary");
    const moved = moveMultiRoomSlot([main, secondary], 1, 0);

    expect(moved[0]?.key).toBe(secondary.key);
    expect(moved[1]?.key).toBe(main.key);
  });

  test("moves a secondary feed into any empty top or right slot", () => {
    const main = room("main");
    const secondary = room("secondary");
    const moved = moveMultiRoomSlot([main, secondary], 1, 5);

    expect(moved[0]?.key).toBe(main.key);
    expect(moved[1]).toBeNull();
    expect(moved[5]?.key).toBe(secondary.key);
  });

  test("keeps a main feed when the current main is moved to an empty slot", () => {
    const main = room("main");
    const secondary = room("secondary");
    const moved = moveMultiRoomSlot([main, secondary], 0, 4);

    expect(moved[0]?.key).toBe(secondary.key);
    expect(moved[4]?.key).toBe(main.key);
  });

  test("promotes the first remaining feed when the main slot is empty", () => {
    const secondary = room("secondary");
    const normalized = normalizeMultiRoomSlots([null, null, secondary]);

    expect(normalized[0]?.key).toBe(secondary.key);
    expect(normalized[2]).toBeNull();
  });
});
