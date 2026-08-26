import { describe, expect, test } from "bun:test";
import {
  createMultiRoomEntry,
  findMultiRoomEmptySlot,
  MULTI_ROOM_LAYOUT_OPTIONS,
  normalizeMultiRoomAudioRoles,
  normalizeMultiRoomFourLayout,
  normalizeMultiRoomLayout,
  normalizeMultiRoomSlots,
  swapMultiRoomMain,
  swapMultiRoomSlots,
  useMultiRoomStore,
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
  test("limits shared-window fullscreen to its owning player", () => {
    // 六条流共享一个窗口，否则其全屏状态会把每个次要流都标记为全屏、
    // 放大网格而不是画面。
    expect(playerOwnsFullscreen(true)).toBe(true);
    expect(playerOwnsFullscreen(false)).toBe(false);
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

  test("splits the stage evenly left and right in two-screen mode", () => {
    expect(multiRoomGridClassName(2)).toBe("grid-cols-2 grid-rows-1");
    expect(multiRoomSlotClassName(0, 2)).toBe("col-start-1 row-start-1");
    expect(multiRoomSlotClassName(1, 2)).toBe("col-start-2 row-start-1");
    expect(multiRoomSlotClassName(2, 2)).toBe("");
    expect(multiRoomSlotLabel(0, 2)).toBe("主画面");
    expect(multiRoomSlotLabel(1, 2)).toBe("右侧画面");
    expect(multiRoomSlotLabel(2, 2)).toBe("画面 3");
  });

  test("falls back to the six-screen layout for unknown persisted values", () => {
    expect(normalizeMultiRoomLayout(2)).toBe(2);
    expect(normalizeMultiRoomLayout(4)).toBe(4);
    expect(normalizeMultiRoomLayout(6)).toBe(6);
    expect(normalizeMultiRoomLayout(5)).toBe(6);
    expect(normalizeMultiRoomLayout(3)).toBe(6);
    expect(normalizeMultiRoomFourLayout("main-left")).toBe("main-left");
    expect(normalizeMultiRoomFourLayout("equal")).toBe("equal");
    expect(normalizeMultiRoomFourLayout("unknown")).toBe("main-left");
  });

  test("enforces the selected layout capacity when adding rooms", () => {
    const slots = [room("main"), room("1"), room("2"), room("3"), null, null];

    expect(findMultiRoomEmptySlot(slots, 2)).toBe(-1);
    expect(findMultiRoomEmptySlot(slots, 4)).toBe(-1);
    expect(findMultiRoomEmptySlot(slots, 6)).toBe(4);
    expect(findMultiRoomEmptySlot([slots[0], null, ...slots.slice(2)], 4)).toBe(1);
    expect(findMultiRoomEmptySlot([room("main"), null, null, null, null, null], 2)).toBe(1);
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
    const moved = swapMultiRoomMain([main, secondary], 1);

    expect(moved[0]?.key).toBe(secondary.key);
    expect(moved[1]?.key).toBe(main.key);
  });

  test("preserves unrelated slot positions when promoting with the button", () => {
    const main = room("main");
    const selected = room("selected");
    const other = room("other");
    const moved = swapMultiRoomMain([main, null, selected, null, other], 2);

    expect(moved[0]).toMatchObject({ key: selected.key, muted: false });
    expect(moved[1]).toBeNull();
    expect(moved[2]).toMatchObject({ key: main.key, muted: true });
    expect(moved[3]).toBeNull();
    expect(moved[4]?.key).toBe(other.key);
  });

  test("moves or swaps occupied secondary feeds", () => {
    const main = room("main");
    const first = room("first");
    const second = room("second");
    const slots = [main, first, second, null];
    const swapped = swapMultiRoomSlots(slots, 1, 2);
    const moved = swapMultiRoomSlots(slots, 1, 3);

    expect(swapped.slice(0, 3).map((entry) => entry?.key)).toEqual([
      main.key,
      second.key,
      first.key,
    ]);
    expect(moved[1]).toBeNull();
    expect(moved[3]?.key).toBe(first.key);
  });

  test("swaps main and secondary feeds while normalizing audio roles", () => {
    const main = room("main");
    const secondary = { ...room("secondary"), volume: 0, muted: true };
    const moved = swapMultiRoomSlots([main, secondary], 0, 1);

    expect(moved[0]).toMatchObject({ key: secondary.key, volume: 80, muted: false });
    expect(moved[1]).toMatchObject({ key: main.key, muted: true });
  });

  test("keeps a main feed when it is moved into an empty slot", () => {
    const main = room("main");
    const secondary = room("secondary");
    const moved = swapMultiRoomSlots([main, secondary, null], 0, 2);

    expect(moved[0]).toMatchObject({ key: secondary.key, muted: false });
    expect(moved[1]).toBeNull();
    expect(moved[2]).toMatchObject({ key: main.key, muted: true });
  });

  test("compacts feeds so a smaller layout never hides a playing room", () => {
    useMultiRoomStore.setState({
      layout: 6,
      slots: [room("main"), null, room("second"), null, null, null],
    });

    expect(useMultiRoomStore.getState().setLayout(2)).toBe(true);

    const state = useMultiRoomStore.getState();
    expect(state.layout).toBe(2);
    expect(state.slots.map((entry) => entry?.roomId ?? null)).toEqual([
      "main",
      "second",
      null,
      null,
      null,
      null,
    ]);
  });

  test("rejects a layout smaller than the number of open rooms", () => {
    useMultiRoomStore.setState({
      layout: 6,
      slots: [room("main"), room("1"), room("2"), null, null, null],
    });

    expect(useMultiRoomStore.getState().setLayout(2)).toBe(false);
    expect(useMultiRoomStore.getState().layout).toBe(6);
    expect(useMultiRoomStore.getState().setLayout(4)).toBe(true);
  });

  test("offers the two, four and six screen capacities", () => {
    expect([...MULTI_ROOM_LAYOUT_OPTIONS]).toEqual([2, 4, 6]);
  });

  test("compacts remaining feeds after a slot is removed", () => {
    const main = room("main");
    const secondary = room("secondary");
    const normalized = normalizeMultiRoomSlots([main, null, secondary]);

    expect(normalized[0]?.key).toBe(main.key);
    expect(normalized[1]?.key).toBe(secondary.key);
    expect(normalized[2]).toBeNull();
  });
});
