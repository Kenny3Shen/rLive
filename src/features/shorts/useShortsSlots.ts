import { useCallback, useEffect, useState } from "react";
import type { VideoItem } from "@/shared/types/video";
import {
  shortsNextSlots,
  shortsPreloadDirection,
  type ShortsSlotId,
  type ShortsSlots,
  type ShortsSwipeDirection,
} from "./shortsFeed";
import { useShortsPlaybackSlot, type ShortsPlaybackState } from "./useShortsPlayback";
import type { ShortsSessionRetention } from "./useShortsSessionRetention";

/**
 * 短视频的三播放器编排层。
 *
 * 三个槽位固定承担「上一条 / 当前 / 下一条」（见 `shortsSlotRole`），换片时按
 * `index % 3` 轮转：当前槽位走一格，刚预热好的邻居升为活动，**不重新取流、不重建
 * 播放器**，换片的取流延迟（400~700ms）在预热命中时归零。
 *
 * 为什么是三个：
 *
 * - **一个**等于没有预热：每次换片都要等一次 playurl + 两条 sidx + 三个回环代理。
 * - **两个**只覆盖一个方向。短视频消费确实是连续朝一个方向刷，但回滑并不罕见
 *   （没看清、想再听一遍），而两槽位下回滑必然冷启动 —— 预热方向翻转之后还要
 *   再等一次完整取流。
 * - **三个**让前进与回滑同样命中。
 *
 * 两个邻居可先取控制面数据；只有下一条在当前可播且页面可见时深预热。
 * 预热到 canplay 后关闭暂停态分片调度；上一条保留已有缓冲，不主动扩充。
 * 三槽只约束播放器数量，不代表三路无限缓冲；缓冲目标由共享 Video.js 封装管理。
 *
 * ## 三个 hook 按**槽位**绑定，不按角色
 *
 * `useShortsPlaybackSlot` 被调用三次，参数里的 `videoRef` 与 `slotId` 恒定属于
 * 某一个槽位（A / B / C），只有 `mode` 随角色变化。这一点是必须的：React 的 hook
 * 状态按**调用位置**保存，若按「活动/预热」传 ref，角色轮转时 hook 会互换
 * 媒体元素 —— 各自的 `playerRef` 于是绑在对方的元素上，播放器复用当场失效
 * （检测到元素变了就会完整重建）。
 */

export type ShortsSlotRefs = Record<ShortsSlotId, React.RefObject<HTMLVideoElement | null>>;

export type ShortsSlotsState = {
  /** 三个槽位各自持有哪一条；null 表示该槽位空着。 */
  slots: ShortsSlots;
  /**
   * 各槽位自己的状态（按槽位索引，不是按角色）。
   *
   * 舞台要用它：预热面板也要按自己的 `intrinsicSize` 定画面框、按自己的 `loading`
   * 决定封面是否还盖着 —— 拿活动槽位的状态去画预热面板，会得到错误的画幅与错误
   * 的加载指示。
   */
  slotStates: Record<ShortsSlotId, ShortsPlaybackState>;
  /** 活动槽位的状态。页面上的进度条、暂停图标与错误面板都只描述它。 */
  playback: ShortsPlaybackState;
  /** 换片时先调它：预热方向只影响槽位分配，与手势管线无关。 */
  noteDirection: (from: number, to: number) => void;
};

export type UseShortsSlotsOptions = {
  items: readonly VideoItem[];
  /** 当前条目下标。 */
  index: number;
  refs: ShortsSlotRefs;
  /** 播放位置推进的回调：弹幕分段按它加载。只有活动槽位会收到。 */
  onProgress?: ((positionMs: number) => void) | undefined;
  /**
   * 保留会话的三件套，原样转给两个槽位。
   *
   * 放在页面层是因为被保留的条目换片后**不属于任何一个槽位**（两个槽位被新
   * 活动条与新预热条占着），槽位 hook 看不到它。
   */
  retention?: ShortsSessionRetention | undefined;
};

const INITIAL_SLOTS: ShortsSlots = { held: { a: null, b: null, c: null }, active: "a" };

export function useShortsSlots({
  items,
  index,
  refs,
  onProgress,
  retention,
}: UseShortsSlotsOptions): ShortsSlotsState {
  const [slots, setSlots] = useState<ShortsSlots>(INITIAL_SLOTS);
  /** 预热方向。回滑一次就翻到另一侧，此后顺着它预热。 */
  const [direction, setDirection] = useState<ShortsSwipeDirection>(1);

  /**
   * 在渲染期重排槽位（与 `useShortsPlayback` 的 `settledKey` 同一手法）：
   * 放进 effect 会先用旧分配提交一帧，那一帧里活动槽位指向的是上一条 —— 于是
   * 弹幕层与进度条会短暂读到错误条目的状态。
   */
  const settledKey = `${index}:${items.length}:${direction}`;
  const [settled, setSettled] = useState(settledKey);
  if (settled !== settledKey) {
    setSettled(settledKey);
    setSlots((current) => shortsNextSlots(index, items.length, direction, current));
  }

  const noteDirection = useCallback((from: number, to: number) => {
    setDirection((current) => shortsPreloadDirection(from, to, current));
  }, []);

  const active: ShortsSlotId = slots.active;

  /**
   * 各槽位的「已可播」快照 —— 预热槽位的**媒体**闸门。
   *
   * 活动槽位还没出画之前，不该让另一条去抢带宽（首屏与弱网下那会拖慢用户正在看
   * 的那条）。
   *
   * 它只拦「附着媒体、开始下载分片」，**不拦取流**：playurl 与两条 sidx 是控制面
   * 请求（几 KB），抢不走带宽，却是预热链路上最贵的一段（实测中位 560ms，占就绪
   * 时间一半）。取流因此与活动条并行跑，就绪时间减半。
   *
   * 用 state 而不是 ref：两个槽位互为对方的闸门，读 ref 是在渲染期读可变状态，
   * 既躲过了 React 的重渲染也躲过了 lint。这里需要的是「活动槽位可播」这个事实
   * 传播到下一次渲染 —— 用 state 表达才是诚实的；它只会在 `ready` 真的翻转时
   * 变化一次，不会形成循环。
   */
  const [activeReady, setActiveReady] = useState(false);
  const [foreground, setForeground] = useState(() => !document.hidden);
  useEffect(() => {
    const sync = () => setForeground(!document.hidden);
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);
  const activeKey = `${active}:${index}:${items[index]?.bvid ?? ""}:${items[index]?.cid ?? 0}`;
  const [readyKey, setReadyKey] = useState(activeKey);
  const connection = (
    navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }
  ).connection;
  const allowWarm =
    readyKey === activeKey &&
    activeReady &&
    foreground &&
    !connection?.saveData &&
    !["slow-2g", "2g"].includes(connection?.effectiveType ?? "");
  const allowMedia = (slot: ShortsSlotId) =>
    slot === active || (allowWarm && slots.held[slot] === index + 1);

  const slotA = useShortsPlaybackSlot({
    item: items[slots.held.a ?? -1] ?? null,
    videoRef: refs.a,
    slotId: "a",
    mode: active === "a" ? "play" : "warm",
    // 活动槽位永远放行：它就是要播的那一条。预热槽位等活动槽位出画。
    mediaAllowed: allowMedia("a"),
    claimPlayInfo: retention?.peek,
    releasePlayInfo: retention?.release,
    parkPlayInfo: retention?.park,
    onProgress: active === "a" ? onProgress : undefined,
  });
  const slotB = useShortsPlaybackSlot({
    item: items[slots.held.b ?? -1] ?? null,
    videoRef: refs.b,
    slotId: "b",
    mode: active === "b" ? "play" : "warm",
    mediaAllowed: allowMedia("b"),
    claimPlayInfo: retention?.peek,
    releasePlayInfo: retention?.release,
    parkPlayInfo: retention?.park,
    onProgress: active === "b" ? onProgress : undefined,
  });
  const slotC = useShortsPlaybackSlot({
    item: items[slots.held.c ?? -1] ?? null,
    videoRef: refs.c,
    slotId: "c",
    mode: active === "c" ? "play" : "warm",
    mediaAllowed: allowMedia("c"),
    claimPlayInfo: retention?.peek,
    releasePlayInfo: retention?.release,
    parkPlayInfo: retention?.park,
    onProgress: active === "c" ? onProgress : undefined,
  });

  const slotStates: Record<ShortsSlotId, ShortsPlaybackState> = { a: slotA, b: slotB, c: slotC };

  const nextActiveReady = slotStates[active].ready;
  if (readyKey !== activeKey) setReadyKey(activeKey);
  if (nextActiveReady !== activeReady) setActiveReady(nextActiveReady);

  const playback = slotStates[active];

  return { slots, slotStates, playback, noteDirection };
}
