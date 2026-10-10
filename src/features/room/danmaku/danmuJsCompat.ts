import type { DanmuJsBullet, DanmuJsInstance } from "danmu.js";

type InternalBullet = DanmuJsBullet & {
  mode?: "scroll" | "top" | "bottom";
  prior?: boolean;
  /** `Bullet.startMove` 记录的墙钟起点，`fullySlideIntoScreen` 据此判断车道是否空出。 */
  _lastMoveTime?: number;
  options?: { realTime?: boolean };
  remove?: () => void;
};

type InternalChannel = {
  addBullet: (bullet: InternalBullet) => unknown;
  updatePos?: () => void;
};

type InternalInstance = DanmuJsInstance & {
  main?: { channel?: InternalChannel; queue?: InternalBullet[] };
};

/**
 * 用 WAAPI 暂停/恢复滚动弹幕，保留原来那条 CSS transition 时间轴。
 *
 * danmu.js 1.2.1 的 `Bullet.pauseMove` 用 `getBoundingClientRect()` 采样当前位置写回
 * `left`，再把 transform 清零、transition 设为 0s。transform transition 跑在合成线程，
 * 主线程采样到的位置落后于屏幕上已经画出的帧，提交后弹幕就向右跳回一截（实测
 * 约 5–7px）；暂停越频繁，倒退越明显。`Animation.pause()` 由合成器在当前时间轴上
 * 定格，不重定位。
 *
 * danmu.js 仍负责调度、车道和固定弹幕：只接管正在运行 transform transition 的滚动
 * bullet，并把它标为 `paused` 让原生 `pauseMove`/`startMove` 跳过它；其余 bullet
 * 照常走原生逻辑。
 */
export function createDanmuJsPlayback(instance: DanmuJsInstance) {
  const paused = new Map<InternalBullet, Animation[]>();
  let pausedAt = 0;
  const updatePosition = () => (instance as InternalInstance).main?.channel?.updatePos?.();
  return {
    pause() {
      updatePosition();
      if (!paused.size) pausedAt = Date.now();
      for (const bullet of instance.state.bullets) {
        if (bullet.mode !== "scroll" || bullet.status !== "start" || !bullet.el) continue;
        const animations = bullet.el
          .getAnimations()
          .filter(
            (animation) =>
              "transitionProperty" in animation &&
              animation.transitionProperty === "transform" &&
              animation.playState === "running",
          );
        if (!animations.length) continue;
        for (const animation of animations) animation.pause();
        paused.set(bullet, animations);
        // pauseMove 遇到 paused 直接返回，不再改写 left/transform。
        bullet.status = "paused";
      }
      instance.pause();
    },
    play() {
      updatePosition();
      const bullets = new Set<InternalBullet>(instance.state.bullets);
      // 暂停期间墙钟照走而动画定格；顺延起点，车道判定才不会把没飘完的弹幕当成已入屏。
      const pausedFor = pausedAt ? Date.now() - pausedAt : 0;
      pausedAt = 0;
      for (const [bullet, animations] of paused) {
        // seek/到期会移除 bullet；点选会取消原 transition 并进入 forcedPause。
        // 这些情况仍交还给 danmu.js，不能把已取消的动画或单条冻结重新拉起。
        if (
          !bullets.has(bullet) ||
          bullet.status !== "paused" ||
          !bullet.el?.isConnected ||
          animations.some(
            (animation) =>
              animation.playState === "idle" || !bullet.el?.getAnimations().includes(animation),
          )
        )
          continue;
        bullet.status = "start";
        if (typeof bullet._lastMoveTime === "number") bullet._lastMoveTime += pausedFor;
        for (const animation of animations) animation.play();
      }
      paused.clear();
      instance.play();
    },
    /** seek 清屏或实例销毁时丢弃暂停记录，避免恢复时碰到已移除的 bullet。 */
    clear() {
      paused.clear();
      pausedAt = 0;
    },
  };
}

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
