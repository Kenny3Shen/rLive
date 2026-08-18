import { describe, expect, test } from "bun:test";
import {
  FOLLOW_ROOM_SWITCH_STATE,
  roomBackTargetFromNavigationState,
  roomSideTabFromNavigationState,
} from "../src/features/room/roomNavigation";

describe("room navigation state", () => {
  test("follow-list room switches keep the tab open and return to the follow page", () => {
    expect(roomSideTabFromNavigationState(FOLLOW_ROOM_SWITCH_STATE)).toBe("follow");
    expect(roomBackTargetFromNavigationState(FOLLOW_ROOM_SWITCH_STATE)).toBe("follow");
  });

  test("ordinary room navigation preserves normal back behavior", () => {
    expect(roomSideTabFromNavigationState(undefined)).toBe("chat");
    expect(roomSideTabFromNavigationState({ roomSideTab: "sc" })).toBe("chat");
    expect(roomBackTargetFromNavigationState({ roomBackTarget: "home" })).toBe("home");
    expect(roomBackTargetFromNavigationState({ roomBackTarget: "previous" })).toBeNull();
  });
});
