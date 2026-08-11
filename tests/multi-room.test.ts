import { describe, expect, test } from "bun:test";
import {
  createMultiRoomEntry,
  findMultiRoomEmptySlot,
  fitMultiRoomSlotsToLayout,
  moveMultiRoomSlot,
  normalizeMultiRoomAudioRoles,
  normalizeMultiRoomFourLayout,
  normalizeMultiRoomLayout,
  normalizeMultiRoomSlots,
  promoteMultiRoomSlot,
  restoreMultiRoomSlotsForLayout,
  type MultiRoomEntry,
} from "../src/features/multi-room/multiRoomStore";
import {
  isMultiRoomMainSlot,
  multiRoomGridClassName,
  multiRoomSlotClassName,
  multiRoomSlotLabel,
} from "../src/features/multi-room/multiRoomLayout";
import {
  applyWebPlayerAudio,
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

  test("writes a gesture audio snapshot to the media element immediately", () => {
    const video = { volume: 0.8, muted: false };

    expect(applyWebPlayerAudio(video, 35, false)).toEqual({ volume: 35, muted: false });
    expect(video).toEqual({ volume: 0.35, muted: false });

    expect(applyWebPlayerAudio(video, 35.375, false)).toEqual({
      volume: 35.375,
      muted: false,
    });
    expect(video).toEqual({ volume: 0.35375, muted: false });

    expect(applyWebPlayerAudio(video, 0, false)).toEqual({ volume: 0, muted: true });
    expect(video).toEqual({ volume: 0, muted: true });
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

  test("places the main feed across the left 3x2 area in four-screen mode", () => {
    expect(multiRoomGridClassName(4, "main-left")).toBe("grid-cols-3 grid-rows-3");
    expect(multiRoomSlotClassName(0, 4, "main-left")).toContain("col-span-2");
    expect(multiRoomSlotClassName(0, 4, "main-left")).toContain("row-start-1");
    expect(multiRoomSlotClassName(0, 4, "main-left")).toContain("row-span-3");
    expect(multiRoomSlotClassName(1, 4, "main-left")).toContain("col-start-3");
    expect(multiRoomSlotClassName(3, 4, "main-left")).toContain("row-start-3");
    expect(multiRoomSlotClassName(4, 4)).toBe("");
    expect(multiRoomSlotLabel(1, 4, "main-left")).toBe("右侧上方");
  });

  test("gives every feed the same size in the equal four-screen layout", () => {
    expect(multiRoomGridClassName(4, "equal")).toBe("grid-cols-2 grid-rows-2");
    expect(multiRoomSlotClassName(0, 4, "equal")).toBe("col-start-1 row-start-1");
    expect(multiRoomSlotClassName(1, 4, "equal")).toBe("col-start-2 row-start-1");
    expect(multiRoomSlotClassName(2, 4, "equal")).toBe("col-start-1 row-start-2");
    expect(multiRoomSlotClassName(3, 4, "equal")).toBe("col-start-2 row-start-2");
    expect(multiRoomSlotLabel(3, 4, "equal")).toBe("右下画面");
  });

  test("compacts four feeds into visible slots and rejects overflowing layouts", () => {
    const main = { ...room("main"), secondarySlot: 5 };
    const topLeft = { ...room("top-left"), secondarySlot: 1 };
    const rightMiddle = { ...room("right-middle"), secondarySlot: 4 };
    const rightBottom = { ...room("right-bottom"), secondarySlot: 5 };
    const fitted = fitMultiRoomSlotsToLayout(
      [main, topLeft, null, null, rightMiddle, rightBottom],
      4,
    );

    expect(fitted?.slice(0, 4).map((entry) => entry?.key)).toEqual([
      main.key,
      topLeft.key,
      rightMiddle.key,
      rightBottom.key,
    ]);
    expect(fitted?.[0]?.secondarySlot).toBeNull();
    expect(fitted?.slice(1, 4).map((entry) => entry?.secondarySlot)).toEqual([1, 2, 3]);
    expect(fitted?.slice(4)).toEqual([null, null]);

    expect(
      fitMultiRoomSlotsToLayout([main, topLeft, room("2"), room("3"), room("4")], 4),
    ).toBeNull();
  });

  test("preserves intentional empty slots when restoring four-screen mode", () => {
    const main = room("main");
    const topMiddle = { ...room("top-middle"), secondarySlot: 5 };
    const restored = restoreMultiRoomSlotsForLayout(
      [main, null, topMiddle, null, null, null],
      4,
    );

    expect(restored?.map((entry) => entry?.key ?? null)).toEqual([
      main.key,
      null,
      topMiddle.key,
      null,
      null,
      null,
    ]);
    expect(restored?.[2]?.secondarySlot).toBe(2);
  });

  test("falls back to the six-screen layout for unknown persisted values", () => {
    expect(normalizeMultiRoomLayout(4)).toBe(4);
    expect(normalizeMultiRoomLayout(6)).toBe(6);
    expect(normalizeMultiRoomLayout(5)).toBe(6);
    expect(normalizeMultiRoomFourLayout("main-left")).toBe("main-left");
    expect(normalizeMultiRoomFourLayout("equal")).toBe("equal");
    expect(normalizeMultiRoomFourLayout("unknown")).toBe("main-left");
  });

  test("enforces the selected layout capacity when adding rooms", () => {
    const slots = [room("main"), room("1"), room("2"), room("3"), null, null];

    expect(findMultiRoomEmptySlot(slots, 4)).toBe(-1);
    expect(findMultiRoomEmptySlot(slots, 6)).toBe(4);
    expect(findMultiRoomEmptySlot([slots[0], null, ...slots.slice(2)], 4)).toBe(1);
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
