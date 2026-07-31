import type { RoomSideTab } from "./PlayerPane";

export type RoomNavigationState = {
  roomSideTab?: RoomSideTab;
  roomBackTarget?: "home";
};

/** State carried by an in-room follow-list switch. */
export const FOLLOW_ROOM_SWITCH_STATE: Readonly<RoomNavigationState> = {
  roomSideTab: "follow",
  roomBackTarget: "home",
};

export function roomSideTabFromNavigationState(state: unknown): RoomSideTab {
  if (!state || typeof state !== "object" || !("roomSideTab" in state)) return "chat";
  const tab = (state as RoomNavigationState).roomSideTab;
  return tab === "chat" || tab === "settings" || tab === "follow" ? tab : "chat";
}

/** A follow-list switch returns to the home page instead of a prior room. */
export function roomNavigationReturnsHome(state: unknown): boolean {
  return (
    !!state &&
    typeof state === "object" &&
    "roomBackTarget" in state &&
    (state as RoomNavigationState).roomBackTarget === "home"
  );
}
