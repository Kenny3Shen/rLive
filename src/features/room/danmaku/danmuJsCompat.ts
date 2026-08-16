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
 * danmu.js 1.2.1 rejects an unbooked `prior` fixed bullet before it can select
 * a top/bottom track. Keep priority on the public comment and Bullet, but bypass
 * that broken guard only while the pinned real-time bullet enters a track.
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
