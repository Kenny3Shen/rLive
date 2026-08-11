import {
  MULTI_ROOM_MAIN_SLOT,
  MULTI_ROOM_MAX_SLOTS,
  type MultiRoomFourLayout,
  type MultiRoomLayout,
} from "./multiRoomStore";

/** Slot placement for the 3x3 six-screen director grid. */
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

export function multiRoomGridClassName(
  layout: MultiRoomLayout = 6,
  fourLayout: MultiRoomFourLayout = "main-left",
): string {
  return layout === 4 && fourLayout === "equal"
    ? "grid-cols-2 grid-rows-2"
    : "grid-cols-3 grid-rows-3";
}

export function multiRoomSlotClassName(
  index: number,
  layout: MultiRoomLayout = 6,
  fourLayout: MultiRoomFourLayout = "main-left",
): string {
  const classes =
    layout === 4
      ? fourLayout === "equal"
        ? MULTI_ROOM_FOUR_EQUAL_SLOT_CLASSES
        : MULTI_ROOM_FOUR_SLOT_CLASSES
      : MULTI_ROOM_SLOT_CLASSES;
  return classes[index] ?? "";
}

export function multiRoomSlotLabel(
  index: number,
  layout: MultiRoomLayout = 6,
  fourLayout: MultiRoomFourLayout = "main-left",
): string {
  const labels =
    layout === 4
      ? fourLayout === "equal"
        ? MULTI_ROOM_FOUR_EQUAL_SLOT_LABELS
        : MULTI_ROOM_FOUR_SLOT_LABELS
      : MULTI_ROOM_SLOT_LABELS;
  return labels[index] ?? `画面 ${index + 1}`;
}

export function isMultiRoomMainSlot(index: number): boolean {
  return index === MULTI_ROOM_MAIN_SLOT;
}

if (MULTI_ROOM_SLOT_CLASSES.length !== MULTI_ROOM_MAX_SLOTS) {
  throw new Error("多画面布局槽位数量不一致");
}

if (MULTI_ROOM_FOUR_SLOT_CLASSES.length !== 4) {
  throw new Error("四画面布局槽位数量不一致");
}

if (MULTI_ROOM_FOUR_EQUAL_SLOT_CLASSES.length !== 4) {
  throw new Error("四画面均分布局槽位数量不一致");
}

if (MULTI_ROOM_SLOT_LABELS.length !== MULTI_ROOM_MAX_SLOTS) {
  throw new Error("多画面布局标签数量不一致");
}

if (MULTI_ROOM_FOUR_SLOT_LABELS.length !== 4 || MULTI_ROOM_FOUR_EQUAL_SLOT_LABELS.length !== 4) {
  throw new Error("四画面布局标签数量不一致");
}
