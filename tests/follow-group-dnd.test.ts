import { describe, expect, test } from "bun:test";
import type { Active, ClientRect, CollisionDetection, DroppableContainer } from "@dnd-kit/core";
import { groupTargetCollisionDetection } from "../src/features/follow/groupCollisionDetection";

const groupRect: ClientRect = {
  top: 0,
  left: 0,
  right: 120,
  bottom: 40,
  width: 120,
  height: 40,
};

const active: Active = {
  id: "follow:1",
  data: { current: {} },
  rect: { current: { initial: null, translated: null } },
};

const groupTarget: DroppableContainer = {
  id: "desktop:news",
  key: "desktop:news",
  data: { current: { groupId: "news" } },
  disabled: false,
  node: { current: null },
  rect: { current: groupRect },
};

function collisionArgs(
  pointerCoordinates: { x: number; y: number } | null,
): Parameters<CollisionDetection>[0] {
  return {
    active,
    collisionRect: {
      top: 200,
      left: 200,
      right: 300,
      bottom: 260,
      width: 100,
      height: 60,
    },
    droppableRects: new Map([[groupTarget.id, groupRect]]),
    droppableContainers: [groupTarget],
    pointerCoordinates,
  };
}

describe("follow group drag collision detection", () => {
  test("does not select a nearby group when the pointer is outside the group bar", () => {
    expect(groupTargetCollisionDetection(collisionArgs({ x: 250, y: 230 }))).toEqual([]);
  });

  test("selects a group only when the pointer is inside its target", () => {
    expect(
      groupTargetCollisionDetection(collisionArgs({ x: 60, y: 20 })).map(({ id }) => id),
    ).toEqual(["desktop:news"]);
  });

  test("keeps closest-target detection for keyboard dragging", () => {
    expect(groupTargetCollisionDetection(collisionArgs(null)).map(({ id }) => id)).toEqual([
      "desktop:news",
    ]);
  });
});
