import type { RoomSideTab } from "./PlayerPane";

export type RoomNavigationState = {
  roomSideTab?: RoomSideTab;
  roomBackTarget?: "home" | "follow";
};

/** 房间内关注列表切换所携带的状态。 */
export const FOLLOW_ROOM_SWITCH_STATE: Readonly<RoomNavigationState> = {
  roomSideTab: "follow",
  roomBackTarget: "follow",
};

export function roomSideTabFromNavigationState(state: unknown): RoomSideTab {
  if (!state || typeof state !== "object" || !("roomSideTab" in state)) return "chat";
  const tab = (state as RoomNavigationState).roomSideTab;
  return tab === "chat" || tab === "settings" || tab === "follow" ? tab : "chat";
}

export function roomBackTargetFromNavigationState(
  state: unknown,
): RoomNavigationState["roomBackTarget"] | null {
  if (!state || typeof state !== "object" || !("roomBackTarget" in state)) return null;
  const target = (state as RoomNavigationState).roomBackTarget;
  return target === "home" || target === "follow" ? target : null;
}
