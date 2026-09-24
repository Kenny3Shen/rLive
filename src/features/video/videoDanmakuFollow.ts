import { firstVideoDanmakuAtOrAfter, type VideoDanmakuEntry } from "./videoDanmaku";

/**
 * 侧栏弹幕列表「跟随播放进度」的几何与判定。
 *
 * 与直播弹幕列表（`features/room/danmaku/listWindow.ts`）不是同一个问题：那是增量
 * 信息流，**底部就是最新**，所以「贴底」既是跟随目标也是恢复跟随的信号；这里是一整
 * 条静态时间轴，跟随目标是播放头所在的那一行，通常落在列表中部。把直播那套「滚回
 * 底部恢复跟随」搬过来，结果是用户滚到底就重新武装跟随、下一个 timeupdate 又把列表
 * 拽回播放头 —— 也就是「滚到底部会回弹」。因此这里的恢复只认显式意图（点按钮、点
 * 条目跳转、拖进度条），不认滚动位置。
 */

/**
 * 跟随行下标：最后一条已经出现过的弹幕。
 *
 * 取「播放头之前」而不是「之后」，这样跟随行始终是已经飘过画面的内容，用户在列表里
 * 看到的与画面上刚出现的是同一条。空列表返回 -1（没有可跟随的行）。
 */
export function videoDanmakuFollowIndex(
  entries: readonly VideoDanmakuEntry[],
  positionMs: number,
): number {
  if (entries.length === 0) return -1;
  return Math.max(0, firstVideoDanmakuAtOrAfter(entries, positionMs) - 1);
}

/**
 * 把跟随行居中所需的 `scrollTop`，夹在可滚动范围内。
 *
 * 自己算而不用 `scrollIntoView({ block: "center" })`：后者在跟随行已经位于视口内时
 * 什么都不做（规范允许「已可见即不滚动」），跟随会停在半屏位置不再居中；而且它滚的
 * 是最近的可滚动祖先，本面板嵌在侧栏横滑条带里，选错祖先会把条带带偏。夹紧到
 * `[0, scrollHeight - viewportHeight]` 是关键一步：目标越界时浏览器会自己夹，写进去
 * 的值与读回来的值不一致，程序化滚动就会被误判成用户滚动。
 */
export function videoDanmakuFollowScrollTop(metrics: {
  /** 跟随行相对滚动内容顶部的偏移。 */
  rowTop: number;
  rowHeight: number;
  viewportHeight: number;
  scrollHeight: number;
}): number {
  const centered = metrics.rowTop + metrics.rowHeight / 2 - metrics.viewportHeight / 2;
  if (!Number.isFinite(centered)) return 0;
  const maxScrollTop = Math.max(0, metrics.scrollHeight - metrics.viewportHeight);
  return Math.min(maxScrollTop, Math.max(0, centered));
}

/**
 * 程序化滚动与用户滚动的判定容差（px）。
 *
 * 行级 `content-visibility: auto` 让屏外行只有估算高度，屏内行实现出真实高度后滚动
 * 锚定会把 `scrollTop` 微调几 px —— 那不是用户操作。容差要盖住这点漂移，又要小于一
 * 次有意的滚动手势（滚轮一格约 100px，触摸拖动通常几十 px 以上）。
 */
export const VIDEO_DANMAKU_FOLLOW_DRIFT_PX = 32;

/**
 * 相对锚点的位移是否已构成一次用户滚动。
 *
 * 锚点是最近一次跟随滚动的落点，**不随漂移更新**：若每个 scroll 事件都把锚点挪到当前
 * 位置，慢速拖动的每一小步都在容差内，就永远攒不出「用户滚动」。固定锚点让位移累积。
 */
export function isVideoDanmakuUserScroll(
  scrollTop: number,
  anchorTop: number,
  driftPx = VIDEO_DANMAKU_FOLLOW_DRIFT_PX,
): boolean {
  return Math.abs(scrollTop - anchorTop) > driftPx;
}

/**
 * 触摸拖动表态为「纵向滚动」的位移阈值（px）。
 *
 * 只需要盖住按下时的手指抖动，因此远小于 `VIDEO_DANMAKU_FOLLOW_DRIFT_PX`：那条容差要
 * 容忍滚动锚定的漂移，这条只要区分「按住没动」和「开始拖」。
 */
export const VIDEO_DANMAKU_DRAG_INTENT_PX = 8;

/**
 * 这次触摸位移是不是一次纵向滚动意图。
 *
 * 本面板嵌在侧栏的横滑条带里，切页签的手势同样从列表上起手、同样在本视口派发
 * touchmove。只按「有没有 touchmove」停跟随，左右滑页签会顺带把跟随关掉 —— 用户
 * 没碰过滚动位置，跟随却没了。因此要求纵向位移既过阈值、又压过横向位移；横滑与
 * 斜向犹豫都不算表态，留给 `scroll` 那条按实际位移兜底。
 */
export function isVideoDanmakuVerticalDrag(
  deltaX: number,
  deltaY: number,
  thresholdPx = VIDEO_DANMAKU_DRAG_INTENT_PX,
): boolean {
  if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) return false;
  return Math.abs(deltaY) > thresholdPx && Math.abs(deltaY) > Math.abs(deltaX);
}

/**
 * 播放位置跳变到多远算一次 seek（ms）。
 *
 * `positionMs` 由媒体 `timeupdate` 驱动，约 250ms 一跳，正常播放的步长远小于这个阈值。
 */
export const VIDEO_DANMAKU_SEEK_THRESHOLD_MS = 1_500;

/**
 * 这次播放位置变化是不是一次 seek。
 *
 * 用来在用户拖动进度条后重新武装跟随：拖进度条是对播放头最明确的表态，列表停在旧位置
 * 没有意义。前后对称判定 —— 后退同样是 seek，正常播放不会倒退。
 */
export function isVideoDanmakuSeek(
  previousMs: number,
  nextMs: number,
  thresholdMs = VIDEO_DANMAKU_SEEK_THRESHOLD_MS,
): boolean {
  if (!Number.isFinite(previousMs) || !Number.isFinite(nextMs)) return false;
  return Math.abs(nextMs - previousMs) > thresholdMs;
}
