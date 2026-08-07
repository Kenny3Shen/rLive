import { closestCenter, pointerWithin, type CollisionDetection } from "@dnd-kit/core";

export const groupTargetCollisionDetection: CollisionDetection = (args) =>
  args.pointerCoordinates === null ? closestCenter(args) : pointerWithin(args);
