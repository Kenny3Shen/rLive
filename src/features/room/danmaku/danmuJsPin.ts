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
 * `DanmuJs.destroy()` 会删除所有自身属性，被销毁的实例保有身份但失去方法。
 * 销毁路径仍持有其所携带钉住的引用，因此触碰前先检查。
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
 * 清空 danmu.js 每实例唯一的全局冻结槽位。
 *
 * `freezeComment` 设置 `freezeId` 与 `mouseControl`，只有 `restartComment` /
 * `removeComment` 会再次清除它们。任何未经这两个路径结束的钉住都会让实例
 * 以为仍有评论被冻结，从而在整个会话剩余时间内抑制其自身的指针处理。
 * 只有持有者释放槽位；已被取代的钉住不去动它。
 */
export function releaseDanmuJsFreezeLock(instance: DanmuJsInstance, id: string): void {
  if (!isUsable(instance)) return;
  const internal = instance as InternalInstance;
  if (internal.freezeId !== id) return;
  internal.freezeId = null;
  internal.mouseControl = false;
}

/**
 * 放弃一次钉住，不决定 bullet 的去向。
 *
 * 交还冻结槽位并把 `forcedPause` 降级 —— 这是只有显式 restart 才能离开的状态。
 * 反正要销毁 bullet 的调用方使用这一支：`Bullet.remove()` 先运行 `pauseMove()`，
 * 它会保留 `forcedPause`，留在这个状态的 bullet 可能以停驻状态复活。
 */
export function releaseDanmuJsPin(instance: DanmuJsInstance, id: string): void {
  if (!isUsable(instance)) return;
  releaseDanmuJsFreezeLock(instance, id);
  const bullet = queuedBullet(instance, id);
  if (bullet?.status === "forcedPause") bullet.status = "paused";
}

/**
 * 判断 bullet 是否会无限期静止。
 *
 * `forcedPause` 是钉住状态，只有显式 restart 能离开。普通 `paused` 在主循环
 * 运行期间同样是终态，因为没有其他东西会回到这颗 bullet —— 只有暂停的循环
 * 才会在下一次 `play()` 时恢复它的整条队列。
 */
function isParked(bullet: InternalBullet, mainStatus: string | undefined): boolean {
  if (bullet.status === "forcedPause") return true;
  return bullet.status === "paused" && mainStatus !== "paused";
}

/**
 * 让被钉住的 bullet 重新运动。
 *
 * 若之后 bullet 仍处于停驻状态则返回 `false`，调用方可改用移除而不是把它冻在
 * 屏幕上：停驻的 bullet 没有运行中的 CSS transition，其删除所依赖的
 * `transitionend` 永远不会触发，会永远占着车道。
 */
export function resumeDanmuJsPin(instance: DanmuJsInstance, id: string): boolean {
  if (!isUsable(instance)) return true;
  releaseDanmuJsFreezeLock(instance, id);
  const main = internalMain(instance);
  if (!main) return false;

  const bullet = queuedBullet(instance, id);
  // 已经不在渲染队列里：屏幕上没有任何卡住的东西。
  if (!bullet) return true;
  // 停止的主循环已经清空了容器，没有可以重启进入的状态：
  // 调用方应改为丢弃该评论。
  if (main.status === "closed") return false;

  // 唯一一个向 `Bullet.startMove` 传 `force` 的公开调用，
  // 也是清除 danmu.js 自身冻结记账的那一个。主循环暂停时它只是把 bullet 标记为
  // `paused`，正是下一次 `play()` 所期待的状态。
  instance.restartComment(id);
  if (!isParked(bullet, main.status)) return true;

  // `Main.play()` 不带 `force` 地恢复 bullet，而 `Bullet.startMove` 对
  // `forcedPause` 提前返回，因此挺过了上面 restart 的钉住只能在这里强制移动才能
  // 复活。
  if (typeof bullet.startMove !== "function") return false;
  bullet.status = "paused";
  bullet.startMove(true);
  return !isParked(bullet, main.status);
}

/** 把钉住的 bullet 彻底移出屏幕，包括冻结槽位。 */
export function removeDanmuJsPin(instance: DanmuJsInstance, id: string): void {
  // `removeComment` 无条件解引用 `main`。
  if (!isUsable(instance) || !internalMain(instance)) return;
  releaseDanmuJsPin(instance, id);
  instance.removeComment(id);
}
