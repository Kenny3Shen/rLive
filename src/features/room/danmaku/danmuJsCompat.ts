import type { DanmuJsBullet, DanmuJsInstance } from "danmu.js";

type InternalBullet = DanmuJsBullet & {
  mode?: "scroll" | "top" | "bottom";
  prior?: boolean;
  options?: { realTime?: boolean };
  remove?: () => void;
};

type InternalChannel = {
  addBullet: (bullet: InternalBullet) => unknown;
};

type InternalInstance = DanmuJsInstance & {
  main?: { channel?: InternalChannel; queue?: InternalBullet[] };
};

/**
 * danmu.js 1.2.1 的 `removeComment` 在 `queue.filter` 中调用 `Bullet.remove()`，
 * 后者同步触发 `bullet_remove`，其监听器又对同一队列 `splice`。遍历因此跳过下一颗
 * bullet，把它从主队列丢掉却不移除 DOM/车道；VOD 固定弹幕便再也无法按时清理。
 *
 * 先单独移除目标 bullet，让原生事件正常清理主队列、车道与 detach 钩子，再用公开
 * 方法清理待发数据和冻结槽位。此时 filter 中已无目标，不会边遍历边 splice。
 */
export function removeDanmuJsComment(instance: DanmuJsInstance, id: string): void {
  const main = (instance as InternalInstance).main;
  if (!main || typeof instance.removeComment !== "function") return;
  const bullet = main.queue?.find((item) => item.id === id);
  if (typeof bullet?.remove === "function") bullet.remove();
  instance.removeComment(id);
}

/**
 * danmu.js 1.2.1 会在未预约的 `prior` 固定弹幕选择上/下车道之前就拒绝它。
 * 公开 comment 与 Bullet 上保留优先级字段，
 * 但仅在钉住的实时弹幕进入车道时绕过那道损坏的守卫。
 */
export function installDanmuJsFixedPriorCompat(instance: DanmuJsInstance): () => void {
  const channel = (instance as InternalInstance).main?.channel;
  if (!channel || typeof channel.addBullet !== "function") return () => {};

  const original = channel.addBullet;
  const patched: InternalChannel["addBullet"] = function addBulletWithFixedPriorCompat(
    this: InternalChannel,
    bullet,
  ) {
    const bypassBrokenGuard =
      bullet?.prior === true &&
      bullet.options?.realTime === true &&
      (bullet.mode === "top" || bullet.mode === "bottom");
    if (!bypassBrokenGuard) return original.call(this, bullet);

    bullet.prior = false;
    try {
      return original.call(this, bullet);
    } finally {
      bullet.prior = true;
    }
  };

  channel.addBullet = patched;
  return () => {
    if (channel.addBullet === patched) channel.addBullet = original;
  };
}
