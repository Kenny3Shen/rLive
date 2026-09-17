import type { VideoPlayInfo } from "@/shared/types/video";

/**
 * 短视频的「上一会话保留」—— 方向翻转不再重付取流。
 *
 * ## 为什么需要它
 *
 * 双槽位预热覆盖了**顺着预热方向**的换片，但**方向翻转的第一次必然未命中**：
 * 新目标既不在活动槽位、也不在预热槽位。实测这一段是 386~481ms 的取流
 * （playurl + 两条 sidx）加约 75ms 的媒体段（分片已在磁盘缓存里）。
 *
 * 媒体缓存只治了后一段：分片已命中时取流仍是 481ms，一分钱没省。所以要省的是
 * **取流本身**，而唯一能省掉它的办法是不重新取 —— 也就是把刚换下的那条的会话
 * 留着。
 *
 * ## 为什么留着会话是合法的
 *
 * `useShortsPlayback` 里 `gcTime: 0` 的理由是「缓存 playInfo 会返回指向**已停
 * 会话**的 MPD」。反过来说：**把会话的存活期延长 T，就同时把 playInfo 的有效期
 * 延长了 T**。这条不变量是本模块存在的支点 —— 保留会话不是「顺手多做一件事」，
 * 而是让复用一份 playInfo 变得合法的唯一前提。
 *
 * session id 是确定性的（`video-{bvid}-{cid}-{role}`），因此不需要传递句柄。
 *
 * ## 所有权：一条会话在任一时刻只属于一个地方
 *
 * 这是全模块最重要的约束。一条会话要么属于**某个槽位的活媒体**，要么属于**保留
 * 位**，不能同时属于两边 —— 否则会「两边都以为自己该停它」（重复停）或「两边都
 * 以为对方管」（泄漏）。
 *
 * 因此取用与放回都拆成两步，让槽位能精确表达所有权的移交：
 *
 * - `shortsRetentionPeek`：**只读**，不改变保留位。给渲染期用 —— 渲染可能被
 *   React 丢弃，非幂等的取用会在丢弃时把会话从保留位里取走却没人用（泄漏）。
 * - `shortsRetentionRelease`：把会话从保留位移出但**不停它**，所有权移交给槽位。
 *   槽位随后用 `heldRef` 的交接路径负责它的存亡。
 * - `shortsRetentionPark`：槽位把会话交回保留位，此后由保留位的 TTL 负责停它。
 *
 * ## 保留谁
 *
 * 只保留**用户真正看过的那条**（离开时角色是 `play`）。同一时刻两个槽位都会换
 * 内容，但只有一个是刚看过的活动条：另一个只是被预载过，用户没看过，而它恰好
 * 又成了新方向上的预热目标 —— 两边都不值得留。
 *
 * ## 为什么 K = 1 就够
 *
 * 设活动条 X、预热条 Y（X 在方向 d 上的邻居）。换片后：
 *
 * - **顺着预热方向翻**（目标是 Y）：只有 X 被丢下 → 保留 X，用户回退目标命中。
 * - **反方向翻**：X 与 Y 都被丢下，新预热目标是新方向上的邻居 W。用户的两个
 *   即时翻页目标是「回退到 X」与「再前进到 Y」：X 被保留，而 Y 恰好成了新方向的
 *   预热目标，**已由槽位预载**。
 *
 * 也就是「一个保留位 + 一个预热槽位」合起来覆盖换片后的两个即时方向。往复滑动
 * 完全命中：每次保留的正是下一次要回退到的那条。K = 2 只多覆盖「连退两步」，
 * 代价是常驻六个额外回环监听器。
 *
 * ## 代价与边界
 *
 * 常驻一条内容的三个回环监听器与三个 reqwest 客户端（无 CPU、无带宽、无解码器
 * 占用）。TTL 必须远小于上游 playurl 签名有效期（量级为小时），15s 比它小两个
 * 数量级。TTL 的起点是「离开那条的时刻」，而回退通常发生在看完一段之后，因此
 * TTL 要覆盖「在新条上停留多久」。
 *
 * ## 它不会达到预热命中的水平
 *
 * 保留的是**会话与 playInfo，不是解码器**：播放器已被复用给别的条目、MSE 缓冲
 * 已重置，init 段与首片仍要重新取（走分片磁盘缓存，实测约 4ms + 75ms）。所以
 * 它把「必失预热的约 480ms 取流」降到「接近预热命中」，而不是等于预热命中。
 */

/**
 * 保留时长。
 *
 * 15 秒覆盖「在新的一条上停留一段再回退」这一常规动作。取更长只增加常驻会话的
 * 时长，不增加命中率 —— 用户没回退就是没回退。
 */
export const SHORTS_SESSION_RETENTION_MS = 15_000;

/** 保留位里的一条：会话仍在代理侧存活，playInfo 因此仍可用。 */
export type ShortsParkedSession = {
  itemKey: string;
  playInfo: VideoPlayInfo;
  /** 放进保留位的时刻，用于 TTL 判定。 */
  parkedAtMs: number;
};

/** 保留位。K = 1，因此只有一个槽（理由见模块头注）。 */
export type ShortsRetentionState = {
  parked: ShortsParkedSession | null;
};

export const SHORTS_RETENTION_EMPTY: ShortsRetentionState = { parked: null };

/** 保留策略：只有用户真正看过的那条值得留（预热过的没看过）。 */
export function shortsShouldRetainSession(wasPlaying: boolean): boolean {
  return wasPlaying;
}

/** TTL 判定。 */
export function shortsRetentionExpired(
  parkedAtMs: number,
  nowMs: number,
  ttlMs: number = SHORTS_SESSION_RETENTION_MS,
): boolean {
  return nowMs - parkedAtMs >= ttlMs;
}

/**
 * 只读查看保留位里是否有这一条。
 *
 * **不改变状态**，因此可以在渲染期安全调用（幂等）。到期的不交出：定时器在后台
 * 标签页会被节流而没跑，此时保留位里的会话可能已经该死了。
 */
export function shortsRetentionPeek(
  state: ShortsRetentionState,
  itemKey: string,
  nowMs: number,
  ttlMs: number = SHORTS_SESSION_RETENTION_MS,
): VideoPlayInfo | null {
  const parked = state.parked;
  if (!parked || parked.itemKey !== itemKey) return null;
  if (shortsRetentionExpired(parked.parkedAtMs, nowMs, ttlMs)) return null;
  return parked.playInfo;
}

/**
 * 把会话从保留位移出，所有权交给槽位 —— **不停它**。
 *
 * 幂等：不在保留位里时是空操作。这样槽位可以放心地在 layout effect 里调它，
 * 不必担心重复执行。
 */
export function shortsRetentionRelease(
  state: ShortsRetentionState,
  itemKey: string,
): { state: ShortsRetentionState; released: ShortsParkedSession | null } {
  if (state.parked?.itemKey !== itemKey) {
    return { state, released: null };
  }
  return { state: SHORTS_RETENTION_EMPTY, released: state.parked };
}

/**
 * 放入保留位。
 *
 * 幂等：同一条重复放入返回原状态与 `null`（不产生需要停掉的会话），这样调用方
 * 在换片与角色变化两条路径上都调它也不会重复停。
 */
export function shortsRetentionPark(
  state: ShortsRetentionState,
  itemKey: string,
  playInfo: VideoPlayInfo,
  nowMs: number,
): { state: ShortsRetentionState; displaced: ShortsParkedSession | null } {
  if (state.parked?.itemKey === itemKey) {
    return { state, displaced: null };
  }
  return {
    state: { parked: { itemKey, playInfo, parkedAtMs: nowMs } },
    // 被顶掉的那条要立刻停：保留位只有一个槽。
    displaced: state.parked,
  };
}

/**
 * 到期清理。
 *
 * 定时器与取用路径共用：定时器负责按时触发，取用路径负责兜住被节流漏掉的触发。
 */
export function shortsRetentionExpire(
  state: ShortsRetentionState,
  nowMs: number,
  ttlMs: number = SHORTS_SESSION_RETENTION_MS,
): { state: ShortsRetentionState; expired: ShortsParkedSession | null } {
  const parked = state.parked;
  if (!parked || !shortsRetentionExpired(parked.parkedAtMs, nowMs, ttlMs)) {
    return { state, expired: null };
  }
  return { state: SHORTS_RETENTION_EMPTY, expired: parked };
}
