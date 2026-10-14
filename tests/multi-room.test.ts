import type { MultiRoomEntry } from "../src/features/multi-room/multiRoomStore";
import { describe, expect, test } from "bun:test";
import {
  createMultiRoomEntry,
  findMultiRoomEmptySlot,
  normalizeMultiRoomAudioRoles,
  swapMultiRoomMain,
  swapMultiRoomSlots,
  useMultiRoomStore,
} from "../src/features/multi-room/multiRoomStore";
import { applyWebPlayerAudio } from "../src/features/room/player/useWebPlayer";
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
  test("writes a gesture audio snapshot to the media element immediately", () => {
    const video = {
      volume: 0.8,
      muted: false,
    };
    expect(applyWebPlayerAudio(video, 35, false)).toEqual({
      volume: 35,
      muted: false,
    });
    expect(video).toEqual({
      volume: 0.35,
      muted: false,
    });
    expect(applyWebPlayerAudio(video, 35.375, false)).toEqual({
      volume: 35.375,
      muted: false,
    });
    expect(video).toEqual({
      volume: 0.35375,
      muted: false,
    });
    expect(applyWebPlayerAudio(video, 0, false)).toEqual({
      volume: 0,
      muted: true,
    });
    expect(video).toEqual({
      volume: 0,
      muted: true,
    });
  });
  test("preserves a secondary's chosen volume when opening it as main", () => {
    const promoted = {
      ...room("secondary"),
      volume: 35,
      muted: true,
    };
    const roles = normalizeMultiRoomAudioRoles([promoted, room("main")]);
    expect(roles[0]).toMatchObject({
      volume: 35,
      muted: false,
    });
    expect(roles[1]).toMatchObject({
      muted: true,
    });
  });
});
describe("multi-room director layout", () => {
  test("enforces the selected layout capacity when adding rooms", () => {
    const slots = [room("main"), room("1"), room("2"), room("3"), null, null];
    expect(findMultiRoomEmptySlot(slots, 2)).toBe(-1);
    expect(findMultiRoomEmptySlot(slots, 4)).toBe(-1);
    expect(findMultiRoomEmptySlot(slots, 6)).toBe(4);
    expect(findMultiRoomEmptySlot([slots[0], null, ...slots.slice(2)], 4)).toBe(1);
    expect(findMultiRoomEmptySlot([room("main"), null, null, null, null, null], 2)).toBe(1);
  });
  test("preserves unrelated slot positions when promoting with the button", () => {
    const main = room("main");
    const selected = room("selected");
    const other = room("other");
    const moved = swapMultiRoomMain([main, null, selected, null, other], 2);
    expect(moved[0]).toMatchObject({
      key: selected.key,
      muted: false,
    });
    expect(moved[1]).toBeNull();
    expect(moved[2]).toMatchObject({
      key: main.key,
      muted: true,
    });
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
    const secondary = {
      ...room("secondary"),
      volume: 0,
      muted: true,
    };
    const moved = swapMultiRoomSlots([main, secondary], 0, 1);
    expect(moved[0]).toMatchObject({
      key: secondary.key,
      volume: 80,
      muted: false,
    });
    expect(moved[1]).toMatchObject({
      key: main.key,
      muted: true,
    });
  });
  test("keeps a main feed when it is moved into an empty slot", () => {
    const main = room("main");
    const secondary = room("secondary");
    const moved = swapMultiRoomSlots([main, secondary, null], 0, 2);
    expect(moved[0]).toMatchObject({
      key: secondary.key,
      muted: false,
    });
    expect(moved[1]).toBeNull();
    expect(moved[2]).toMatchObject({
      key: main.key,
      muted: true,
    });
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
});
