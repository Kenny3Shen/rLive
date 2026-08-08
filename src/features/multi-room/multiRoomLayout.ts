import { MULTI_ROOM_MAIN_SLOT, MULTI_ROOM_MAX_SLOTS } from "./multiRoomStore";

/**
 * A 3x3 director grid: the main feed occupies the lower-left 2x2 area and
 * every remaining 1x1 cell follows the top edge, then the right edge.
 */
export const MULTI_ROOM_SLOT_CLASSES = [
  "col-start-1 col-span-2 row-start-2 row-span-2",
  "col-start-1 row-start-1",
  "col-start-2 row-start-1",
  "col-start-3 row-start-1",
  "col-start-3 row-start-2",
  "col-start-3 row-start-3",
] as const;

export const MULTI_ROOM_SLOT_LABELS = [
  "主画面",
  "上方左侧",
  "上方中间",
  "上方右侧",
  "右侧中间",
  "右侧下方",
] as const;

export function multiRoomSlotClassName(index: number): string {
  return MULTI_ROOM_SLOT_CLASSES[index] ?? "";
}

export function multiRoomSlotLabel(index: number): string {
  return MULTI_ROOM_SLOT_LABELS[index] ?? `画面 ${index + 1}`;
}

export function isMultiRoomMainSlot(index: number): boolean {
  return index === MULTI_ROOM_MAIN_SLOT;
}

if (
  MULTI_ROOM_SLOT_CLASSES.length !== MULTI_ROOM_MAX_SLOTS ||
  MULTI_ROOM_SLOT_LABELS.length !== MULTI_ROOM_MAX_SLOTS
) {
  throw new Error("多画面布局槽位数量不一致");
}
