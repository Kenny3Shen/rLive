import type { DanmuJsBullet, DanmuJsInstance } from "danmu.js";

type InternalBullet = DanmuJsBullet & {
  mode?: "scroll" | "top" | "bottom";
  prior?: boolean;
  options?: { realTime?: boolean };
};

type InternalChannel = {
  addBullet: (bullet: InternalBullet) => unknown;
};

type InternalInstance = DanmuJsInstance & {
  main?: { channel?: InternalChannel };
};

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
