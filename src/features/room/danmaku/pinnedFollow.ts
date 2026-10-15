/**
 * 直播弹幕列表「是否仍在跟随最新消息」的几何判定。
 *
 * 与 VOD 侧（`features/video/videoDanmakuFollow.ts`）不是同一个问题：那是静态时间轴，
 * 跟随目标是播放头所在行；这里是增量信息流，**底部就是最新**，所以「贴底」既是跟随
 * 目标也是恢复跟随的信号。
 *
 * 抽成纯函数模块（不 import React）是为了让这两条容差能单测 —— 它们只差一个数量级，
 * 混用会静默地把用户上滚读成程序滚动，而症状（小格滚轮滚不动）离判定点很远。
 */

/**
 * 阅读态滚回距底多近算「重新跟随最新消息」。
 *
 * 这是一次刻意的收尾手势（滚轮一路滚到底、拖滚动条到底），因此容差宽松：
 * 用户不必像素级精确地停在最底端。
 */
export const DANMAKU_REPIN_THRESHOLD_PX = 48;

/**
 * 钉底期间判定「视口还在不在底部」的容差。
 *
 * 必须远小于上面那条，因为这里要区分的是两件量级相近的事：
 *
 * - **程序性夹取**：测高收缩让内容总高变小，浏览器把 `scrollTop` 夹到新的最大值。
 *   落点恰好是新的底部，距底为 0。
 * - **用户上滚**：滚轮一格、触控板一次滑动、键盘一行，落点在别处，距底就是上滚的
 *   位移量（滚轮一格约 30–100px）。
 *
 * 钉底时若套用 48px 宽带，用户上滚 30px 仍被判为「在底部」，于是钉底逻辑立刻把他
 * 拉回去继续跟随 —— 表现为「列表被强制滚至底部，只有滚轮幅度较大时才滚得上去」。
 * 取 2px 而不是 0：回底写入本身在 1px 内就跳过，留一点余量吸收亚像素抖动。
 */
export const DANMAKU_PINNED_TOLERANCE_PX = 2;

/**
 * 视口是否仍算「在底部」。
 *
 * @param distanceToBottom `scrollHeight - scrollTop - clientHeight`（px）。
 * @param following 当前是否处于钉底跟随态 —— 决定用哪条容差。
 */
export function isDanmakuViewportAtBottom(distanceToBottom: number, following: boolean): boolean {
  if (!Number.isFinite(distanceToBottom)) return false;
  const tolerance = following ? DANMAKU_PINNED_TOLERANCE_PX : DANMAKU_REPIN_THRESHOLD_PX;
  return distanceToBottom < tolerance;
}
