import { describe, expect, test } from "bun:test";
import {
  FOLLOW_ROOM_SWITCH_STATE,
  roomNavigationReturnsHome,
  roomSideTabFromNavigationState,
} from "../frontend/features/room/roomNavigation";

describe("room navigation state", () => {
  test("follow-list room switches keep the tab open and return home", () => {
    expect(roomSideTabFromNavigationState(FOLLOW_ROOM_SWITCH_STATE)).toBe("follow");
    expect(roomNavigationReturnsHome(FOLLOW_ROOM_SWITCH_STATE)).toBe(true);
  });

  test("ordinary room navigation preserves normal back behavior", () => {
    expect(roomSideTabFromNavigationState(undefined)).toBe("chat");
    expect(roomNavigationReturnsHome({ roomSideTab: "follow" })).toBe(false);
    expect(roomNavigationReturnsHome({ roomBackTarget: "previous" })).toBe(false);
  });
});
