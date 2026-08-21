import type { DanmuJsBullet, DanmuJsInstance } from "danmu.js";

type InternalBullet = DanmuJsBullet & {
  status?: string;
  startMove?: (force?: boolean) => void;
};

type InternalMain = {
  status?: string;
  queue?: InternalBullet[];
};

type InternalInstance = DanmuJsInstance & {
  main?: InternalMain;
  freezeId?: string | null;
  mouseControl?: boolean;
};

/**
 * `DanmuJs.destroy()` deletes every own property, so a torn-down instance keeps
 * its identity but loses its methods. Teardown paths still hold a reference to
 * the pin they were carrying, so check before touching one.
 */
function isUsable(instance: DanmuJsInstance): boolean {
  return typeof instance.removeComment === "function";
}

function internalMain(instance: DanmuJsInstance): InternalMain | null {
  const main = (instance as InternalInstance).main;
  return main && typeof main === "object" ? main : null;
}

function queuedBullet(instance: DanmuJsInstance, id: string): InternalBullet | null {
  const queue = internalMain(instance)?.queue;
  if (!Array.isArray(queue)) return null;
  return queue.find((bullet) => bullet?.id === id) ?? null;
}

/**
 * Clears the single global freeze slot danmu.js keeps per instance.
 *
 * `freezeComment` sets `freezeId` plus `mouseControl`, and only `restartComment`
 * / `removeComment` clear them again. Any pin that ends without going through
 * those leaves the instance believing a comment is still held, which suppresses
 * its own pointer handling for the rest of the session. Only the holder releases
 * the slot, so a pin that was already superseded leaves it alone.
 */
export function releaseDanmuJsFreezeLock(instance: DanmuJsInstance, id: string): void {
  if (!isUsable(instance)) return;
  const internal = instance as InternalInstance;
  if (internal.freezeId !== id) return;
  internal.freezeId = null;
  internal.mouseControl = false;
}

/**
 * Gives up a pin without deciding what happens to the bullet.
 *
 * Hands the freeze slot back and downgrades `forcedPause`, the state only an
 * explicit restart leaves. Callers that are tearing the bullet down anyway use
 * this: `Bullet.remove()` runs `pauseMove()` first, which preserves
 * `forcedPause`, so a bullet left in that state could come back parked.
 */
export function releaseDanmuJsPin(instance: DanmuJsInstance, id: string): void {
  if (!isUsable(instance)) return;
  releaseDanmuJsFreezeLock(instance, id);
  const bullet = queuedBullet(instance, id);
  if (bullet?.status === "forcedPause") bullet.status = "paused";
}

/**
 * Whether the bullet would sit still indefinitely.
 *
 * `forcedPause` is the pinned state, and only an explicit restart leaves it. A
 * plain `paused` is equally terminal while the main loop is running, because
 * nothing else will come back to this bullet — only a paused loop resumes its
 * whole queue on the next `play()`.
 */
function isParked(bullet: InternalBullet, mainStatus: string | undefined): boolean {
  if (bullet.status === "forcedPause") return true;
  return bullet.status === "paused" && mainStatus !== "paused";
}

/**
 * Puts a pinned bullet back in motion.
 *
 * Returns `false` when the bullet is still parked afterwards, so the caller can
 * fall back to removing it instead of leaving it frozen on screen: a parked
 * bullet has no running CSS transition, so the `transitionend` that its removal
 * depends on never fires and it would occupy its track forever.
 */
export function resumeDanmuJsPin(instance: DanmuJsInstance, id: string): boolean {
  if (!isUsable(instance)) return true;
  releaseDanmuJsFreezeLock(instance, id);
  const main = internalMain(instance);
  if (!main) return false;

  const bullet = queuedBullet(instance, id);
  // Not in the render queue any more: nothing is stuck on screen.
  if (!bullet) return true;
  // A stopped main loop already emptied its container, so there is nothing to
  // restart into: the caller should drop the comment instead.
  if (main.status === "closed") return false;

  // The only public call that passes `force` to `Bullet.startMove`, and the one
  // that clears danmu.js' own freeze bookkeeping. On a paused main loop it just
  // marks the bullet `paused`, which is what the next `play()` expects.
  instance.restartComment(id);
  if (!isParked(bullet, main.status)) return true;

  // `Main.play()` resumes bullets without `force` and `Bullet.startMove` returns
  // early for `forcedPause`, so a pin that survived the restart above can only be
  // revived by forcing the move here.
  if (typeof bullet.startMove !== "function") return false;
  bullet.status = "paused";
  bullet.startMove(true);
  return !isParked(bullet, main.status);
}

/** Takes a pinned bullet off screen for good, freeze slot included. */
export function removeDanmuJsPin(instance: DanmuJsInstance, id: string): void {
  // `removeComment` dereferences `main` unconditionally.
  if (!isUsable(instance) || !internalMain(instance)) return;
  releaseDanmuJsPin(instance, id);
  instance.removeComment(id);
}
