import { MULTI_ROOM_MAIN_SLOT, type MultiRoomFourLayout, type MultiRoomLayout } from "./multiRoomStore";

/** 3x3 六屏导演网格的槽位布局。 */
export const MULTI_ROOM_SLOT_CLASSES = [
  "col-start-1 col-span-2 row-start-2 row-span-2",
  "col-start-1 row-start-1",
  "col-start-2 row-start-1",
  "col-start-3 row-start-1",
  "col-start-3 row-start-2",
  "col-start-3 row-start-3",
] as const;

export const MULTI_ROOM_FOUR_SLOT_CLASSES = [
  "col-start-1 col-span-2 row-start-1 row-span-3",
  "col-start-3 row-start-1",
  "col-start-3 row-start-2",
  "col-start-3 row-start-3",
] as const;

export const MULTI_ROOM_FOUR_EQUAL_SLOT_CLASSES = [
  "col-start-1 row-start-1",
  "col-start-2 row-start-1",
  "col-start-1 row-start-2",
  "col-start-2 row-start-2",
] as const;

/** 两条流在同一行内平分宽度。 */
export const MULTI_ROOM_TWO_SLOT_CLASSES = [
  "col-start-1 row-start-1",
  "col-start-2 row-start-1",
] as const;

export const MULTI_ROOM_SLOT_LABELS = [
  "主画面",
  "上方左侧",
  "上方中间",
  "上方右侧",
  "右侧中间",
  "右侧下方",
] as const;

export const MULTI_ROOM_FOUR_SLOT_LABELS = ["主画面", "右侧上方", "右侧中间", "右侧下方"] as const;

export const MULTI_ROOM_FOUR_EQUAL_SLOT_LABELS = [
  "主画面",
  "右上画面",
  "左下画面",
  "右下画面",
] as const;

export const MULTI_ROOM_TWO_SLOT_LABELS = ["主画面", "右侧画面"] as const;

function multiRoomSlotPlacement(
  layout: MultiRoomLayout,
  fourLayout: MultiRoomFourLayout,
): { classes: readonly string[]; labels: readonly string[] } {
  if (layout === 2) {
    return { classes: MULTI_ROOM_TWO_SLOT_CLASSES, labels: MULTI_ROOM_TWO_SLOT_LABELS };
  }
  if (layout === 4) {
    return fourLayout === "equal"
      ? { classes: MULTI_ROOM_FOUR_EQUAL_SLOT_CLASSES, labels: MULTI_ROOM_FOUR_EQUAL_SLOT_LABELS }
      : { classes: MULTI_ROOM_FOUR_SLOT_CLASSES, labels: MULTI_ROOM_FOUR_SLOT_LABELS };
  }
  return { classes: MULTI_ROOM_SLOT_CLASSES, labels: MULTI_ROOM_SLOT_LABELS };
}

export function multiRoomGridClassName(
  layout: MultiRoomLayout = 6,
  fourLayout: MultiRoomFourLayout = "main-left",
): string {
  if (layout === 2) return "grid-cols-2 grid-rows-1";
  return layout === 4 && fourLayout === "equal"
    ? "grid-cols-2 grid-rows-2"
    : "grid-cols-3 grid-rows-3";
}

export function multiRoomSlotClassName(
  index: number,
  layout: MultiRoomLayout = 6,
  fourLayout: MultiRoomFourLayout = "main-left",
): string {
  return multiRoomSlotPlacement(layout, fourLayout).classes[index] ?? "";
}

export function multiRoomSlotLabel(
  index: number,
  layout: MultiRoomLayout = 6,
  fourLayout: MultiRoomFourLayout = "main-left",
): string {
  return multiRoomSlotPlacement(layout, fourLayout).labels[index] ?? `画面 ${index + 1}`;
}

export function isMultiRoomMainSlot(index: number): boolean {
  return index === MULTI_ROOM_MAIN_SLOT;
}
