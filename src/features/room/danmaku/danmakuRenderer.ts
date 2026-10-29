import { create, type Danmaku, type Manager } from "danmu";
import { applyCommentStyle } from "./danmakuAdapter";
import type { DanmakuComment, DanmakuRendererOptions } from "./danmakuTypes";

/**
 * 基于 `danmu` 的 DOM 弹幕引擎。运动由每条弹幕自己的 CSS transition 在合成器上推进，
 * 主线程只负责投放、准入与生命周期，不再逐帧写 transform。
 *
 * 两层管理器：滚动层限制在用户设置的显示区域内，固定层占满整个舞台，与旧实现的分层一致。
 * `danmu` 不绑定媒体，因此 VOD 由本文件按媒体事件推进投放与暂停/倍速，直播按墙钟直接投放。
 * 固定弹幕（top/bottom，含 SC 与自己的弹幕）走 flexible danmaku，由 `LanePool` 独占车道；
 * 普通滚动弹幕交给 `danmu` 的轨道调度与碰撞预测。占两条车道的大表情不经过库的轨道准入，
 * 由本文件的单一调度器按实例真实位置/速度维护动态轨道锁：有碰撞风险才锁，安全后即允许复用。
 *
 * 碰撞检测档位不开放：库的 `mode` 固定 `strict`（饱和时排队延后而非叠放），
 * 轨道分配固定 `random`，见 `COLLISION_MODE` 与 `TRACK_DISTRIBUTION`。
 */
type Layer = "scroll" | "fixed";

type LayerRuntime = {
  manager: Manager<DanmakuComment>;
  lanes: LanePool;
};

type RecordItem = {
  comment: DanmakuComment;
  danmaku: Danmaku<DanmakuComment>;
  element: HTMLElement;
  layer: Layer;
  /** 固定弹幕的独占车道，或滚动大表情当前覆盖的物理轨；普通滚动弹幕为空。 */
  lanes: number[];
};

/** 投放前登记的车道占用：`pushFlexibleDanmaku` 不返回实例，靠 comment id 在钩子里认领。 */
type Reservation = {
  layer: Layer;
  lanes: number[];
  /** 滚动大表情已投放但尚未 append 的启动截止时间；固定弹幕不设。 */
  deadline?: number;
};

/** 已受理、等待安全连续两轨的大表情；`reservation` 为空表示仍在队列里。 */
type PendingWide = {
  comment: DanmakuComment;
  reservation: Reservation | null;
  deadline: number;
};

/** 轨道里一条弹幕的运动快照；`left` 是左缘相对舞台的 x 坐标。 */
export type LaneMotion = {
  paused: boolean;
  moving: boolean;
  left: number;
  width: number;
  /** 当前速度（px/ms），已含倍速。 */
  speed: number;
};

/** 已受理普通滚动弹幕的 speed/rate 快照；strict 重试可能重新回 stash，故保留到销毁。 */
type OrdinarySpeed = {
  speed: number;
};

/** 已投放但尚未 append 的图片位置/速度未知；统一按「不可放行」处理，复用同一只读快照。 */
const BLOCKING_MOTION: LaneMotion = { paused: false, moving: false, left: 0, width: 1, speed: 1 };

/** `limits.stash`：待投放上限，超出由库丢弃并触发 `limitWarning`（本文件静默处理）。 */
const MAX_STASHED = 256;
const DEFAULT_FIXED_DURATION_MS = 15_000;
/** 媒体时间单帧跳变超过该值按 seek 处理：清屏并重新定位游标。 */
const SEEK_JUMP_SECONDS = 0.5;
/** 单帧投放上限：批量注入时把 DOM 工作摊到多帧，避免单帧长任务。 */
const MAX_PUSH_PER_FRAME = 48;
/** 库自身轮询间隔；滚动层另有批次内的显式 `render()`，这里只兜底重试。 */
const SCROLL_INTERVAL_MS = 200;
const FIXED_INTERVAL_MS = 500;
/**
 * 碰撞检测档位固定为库的 `strict`：车道不满足准入时留在待投队列等空位，宁可延后也不重叠。
 * `adaptive` 在轨道占满时会随机挑一条轨道直接上屏（实测同车道多条弹幕停在同一个 x），
 * `none` 完全不检测，两者都会让文字互相压字。
 */
const COLLISION_MODE = "strict";
/**
 * 轨道分配固定用随机分布，不用库的 `order`（自顶向下填满）。库的 `getTrackIdx` 形参默认值
 * 也是 `random`，这里显式写出、不依赖它：随机分布让同屏弹幕在可用轨道间散开，
 * 不会挤在顶部几条。
 */
const TRACK_DISTRIBUTION = "random";
/**
 * 同车道前后弹幕的横向间距（px）固定为 0：前车尾部一离开右缘，后车即可入场，最大限度及时上屏。
 * 与库默认值相同，这里显式写出、不依赖它；`strict` 碰撞检测仍保证不压字。
 */
const LANE_GAP_PX = 0;
/**
 * `danmu` 的 `speed` 单位是 px/毫秒，而业务设置（与旧引擎）用 px/秒，
 * 两者差 1000 倍；漏了这一步会让每条弹幕在数毫秒内跑完并消失。
 */
const SPEED_UNIT_SCALE = 1 / 1_000;
/** 大表情与动态轨道锁的调度间隔；暂停、冻结或尚未起步时也靠它重查。 */
const WIDE_RETRY_MS = 100;
/** 大表情最多等待车道这么久，超出即丢弃，与直播待投放队列的过期时间一致。 */
const WIDE_MAX_WAIT_MS = 5_000;

/**
 * 后车从舞台右缘进入前还需等待的毫秒数，0 表示可立即进入。
 *
 * 前车尾部右缘必须先越过安全门限。后车不快于前车时门限是 `containerWidth - gap`；
 * 后车更快时还要保证在前车离屏前不追尾，门限收紧为
 * `(containerWidth - gap) * aheadSpeed / entrantSpeed`。所有运动状态未知的情况都保守重查。
 */
export function laneEntryWaitMs(
  ahead: Iterable<LaneMotion>,
  entrantSpeed: number,
  containerWidth: number,
  gap = 0,
): number {
  if (!(entrantSpeed > 0) || !Number.isFinite(entrantSpeed)) return WIDE_RETRY_MS;
  if (!(containerWidth > 0) || !Number.isFinite(containerWidth)) return WIDE_RETRY_MS;
  const safeGap = Number.isFinite(gap) ? Math.max(0, gap) : 0;
  const edge = containerWidth - safeGap;
  if (!(edge > 0) || !Number.isFinite(edge)) return WIDE_RETRY_MS;
  let wait = 0;
  for (const occupant of ahead) {
    if (
      occupant.paused ||
      !occupant.moving ||
      !(occupant.width > 0) ||
      !Number.isFinite(occupant.width) ||
      !Number.isFinite(occupant.left) ||
      !(occupant.speed > 0) ||
      !Number.isFinite(occupant.speed)
    ) {
      return WIDE_RETRY_MS;
    }
    const threshold = Math.min(edge, (edge * occupant.speed) / entrantSpeed);
    const remaining = occupant.left + occupant.width - threshold;
    if (!Number.isFinite(threshold) || !Number.isFinite(remaining)) return WIDE_RETRY_MS;
    if (remaining <= 0) continue;
    wait = Math.max(wait, remaining / occupant.speed);
  }
  return Math.ceil(wait);
}

const clock = () => performance.now() / 1_000;

function positive(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function clampArea(value: number | undefined): number {
  const next = typeof value === "number" && Number.isFinite(value) ? value : 1;
  return Math.max(0.1, Math.min(1, next));
}

function lowerBound(comments: readonly DanmakuComment[], time: number): number {
  let lo = 0;
  let hi = comments.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((comments[mid]!.time ?? Number.POSITIVE_INFINITY) < time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * 车道占用表，用于 `danmu` 轨道无法表达的几何：固定弹幕走 flexible danmaku，
 * 不进入库的轨道，车道完全由本表静态分配；滚动大表情的占用由调度器按轨道几何重算。
 */
class LanePool {
  private used: boolean[] = [];

  reset(count: number): void {
    this.used = Array.from({ length: Math.max(0, Math.floor(count)) }, () => false);
  }

  /** 自顶向下找第一段连续空闲车道；`span` 超过车道总数时返回 null。 */
  allocate(span: number): number | null {
    const need = Math.max(1, Math.floor(span));
    const total = this.used.length;
    if (need > total) return null;
    for (let start = 0; start + need <= total; start += 1) {
      let index = start;
      while (index < start + need && !this.used[index]) index += 1;
      if (index < start + need) {
        start = index;
        continue;
      }
      for (let lane = start; lane < start + need; lane += 1) this.used[lane] = true;
      return start;
    }
    return null;
  }

  release(index: number): void {
    if (index >= 0 && index < this.used.length) this.used[index] = false;
  }
}

export class DanmakuRenderer {
  readonly container: HTMLElement;
  private readonly media?: HTMLMediaElement;
  private readonly options: DanmakuRendererOptions;
  private readonly scroll: LayerRuntime;
  private readonly fixed: LayerRuntime;
  private readonly records = new Map<string, RecordItem>();
  private readonly reservations = new Map<string, Reservation>();
  /** 已受理但尚未投放的大表情，按 Map 插入顺序先来先服务。 */
  private readonly pendingWide = new Map<string, PendingWide>();
  /** 普通滚动弹幕入库时的速度快照，保留到销毁，覆盖 strict 重试后重新入 stash 的条目。 */
  private readonly ordinarySpeeds = new Map<string, OrdinarySpeed>();
  /** 当前由调度器锁住的滚动轨道；重算时先整体释放，再按最新几何重新锁定。 */
  private readonly scrollLocked = new Set<number>();
  /**
   * 已受理但尚未回调 `onDetach` 的 id。调用方按「每条受理的弹幕恰好一次 detach」
   * 记账（记录表靠它回收），因此被库丢弃、被移除、被清屏的条目都要在这里结算。
   */
  private readonly live = new Set<string>();
  private readonly observer?: ResizeObserver;
  /** VOD 时间轴与游标；直播不走这里，`emit` 直接投放。 */
  private timeline: DanmakuComment[] = [];
  private timelineIds = new Set<string>();
  private cursor = 0;
  private speed: number;
  private area: number;
  private laneHeight: number;
  private lastMediaTime = 0;
  private frozen = false;
  private frame = 0;
  private wideTimer = 0;
  private renderQueued = false;
  private destroyed = false;

  constructor(options: DanmakuRendererOptions) {
    this.options = options;
    this.container = options.container;
    this.media = options.media;
    this.speed = positive(options.speed, 100);
    this.area = clampArea(options.area);
    this.laneHeight = Math.max(1, Math.round(positive(options.laneHeight, 24)));
    this.scroll = this.createLayer("scroll");
    this.fixed = this.createLayer("fixed");
    this.applyScrollArea();
    if (this.media) this.bindMedia(this.media);
    if (typeof ResizeObserver !== "undefined") {
      this.observer = new ResizeObserver(() => this.resize());
      this.observer.observe(this.container);
    } else {
      window.addEventListener("resize", this.onResize);
    }
    this.container.dataset.danmakuRenderer = "danmu";
  }

  /** 直播：一条事件立即投放，按 `mode` 与车道占用选择普通/固定/大表情通道。 */
  emit(comment: DanmakuComment): void {
    if (this.destroyed || this.live.has(comment.id)) return;
    if (this.push(comment)) this.scheduleRender();
  }

  /**
   * 替换未来时间轴，不清除在途弹幕。同一 id 已在屏时只更新样式，保留节点身份与运动位置。
   * 只有外观变化、条目减少（屏蔽词命中）或换视频才需要整体替换；分段追加走 `appendComments`。
   */
  setComments(comments: readonly DanmakuComment[]): void {
    if (this.destroyed) return;
    const byId = new Map<string, DanmakuComment>();
    for (const comment of comments) if (!byId.has(comment.id)) byId.set(comment.id, comment);
    this.timeline = Array.from(byId.values()).sort(
      (left, right) => (left.time ?? 0) - (right.time ?? 0),
    );
    this.timelineIds = new Set(byId.keys());
    this.cursor = lowerBound(this.timeline, this.now());
    for (const record of this.records.values()) {
      const next = byId.get(record.comment.id);
      if (!next || next === record.comment) continue;
      // 样式构造器总是给出完整键集，条件键（描边）取空串即删除，因此无需先清旧值。
      applyCommentStyle(record.element, next.style);
      record.comment = next;
    }
    this.recomputeScrollLocks();
    this.ensureWideScheduler();
  }

  /**
   * 增量追加时间轴：只登记新 id，不重建已有条目。
   * 追加段全在未来时直接接在末尾；乱序分段（向后 seek 后补回旧段）整批归并并重新定位游标，
   * 与 `setComments` 一致——过去的不补投，从当前位置往后继续。
   */
  appendComments(comments: readonly DanmakuComment[]): void {
    if (this.destroyed) return;
    const additions: DanmakuComment[] = [];
    for (const comment of comments) {
      if (this.timelineIds.has(comment.id)) continue;
      this.timelineIds.add(comment.id);
      additions.push(comment);
    }
    if (additions.length === 0) return;
    additions.sort((left, right) => (left.time ?? 0) - (right.time ?? 0));
    const last = this.timeline[this.timeline.length - 1];
    const first = additions[0]!.time ?? 0;
    if (last && first >= (last.time ?? 0) && first >= this.now()) {
      this.timeline = this.timeline.concat(additions);
      return;
    }
    const merged: DanmakuComment[] = [];
    let left = 0;
    let right = 0;
    while (left < this.timeline.length && right < additions.length) {
      merged.push(
        (this.timeline[left]!.time ?? 0) <= (additions[right]!.time ?? 0)
          ? this.timeline[left++]!
          : additions[right++]!,
      );
    }
    while (left < this.timeline.length) merged.push(this.timeline[left++]!);
    while (right < additions.length) merged.push(additions[right++]!);
    this.timeline = merged;
    this.cursor = lowerBound(merged, this.now());
  }

  /** 钉住即暂停运动（含固定弹幕的到期计时）；返回 false 表示尚未开始运动，调用方不应选中。 */
  pin(id: string): boolean {
    const record = this.records.get(id);
    if (!record || this.destroyed) return false;
    record.danmaku.pause();
    this.recomputeScrollLocks();
    this.ensureWideScheduler();
    return record.danmaku.paused === true;
  }

  unpin(id: string): void {
    const record = this.records.get(id);
    if (!record || this.destroyed) return;
    record.danmaku.resume();
    this.recomputeScrollLocks();
    this.ensureWideScheduler();
  }

  clear(): void {
    if (this.destroyed) return;
    this.clearActive();
    this.timeline = [];
    this.timelineIds = new Set();
    this.cursor = 0;
  }

  resize(): void {
    if (this.destroyed) return;
    this.scroll.manager.format();
    this.fixed.manager.format();
    this.syncLanes();
    this.ensureWideScheduler();
  }

  setSpeed(speed: number): void {
    const next = positive(speed, this.speed);
    if (next === this.speed) return;
    this.speed = next;
    this.scroll.manager.setSpeed(next * SPEED_UNIT_SCALE);
    this.recomputeScrollLocks();
    this.ensureWideScheduler();
  }

  setArea(area: number): void {
    const next = clampArea(area);
    if (next === this.area) return;
    this.area = next;
    this.applyScrollArea();
  }

  /** 字号变化同时改变车道高：轨道与车道占用表一起重建。 */
  setLaneHeight(laneHeight: number): void {
    const next = Math.max(1, Math.round(positive(laneHeight, this.laneHeight)));
    if (next === this.laneHeight) return;
    this.laneHeight = next;
    this.scroll.manager.setTrackHeight(next);
    this.fixed.manager.setTrackHeight(next);
    this.syncLanes();
    this.ensureWideScheduler();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.observer?.disconnect();
    window.removeEventListener("resize", this.onResize);
    this.stopClock();
    this.stopWideScheduler();
    this.unlockScrollTracks();
    if (this.media) {
      this.media.removeEventListener("seeking", this.onSeeking);
      this.media.removeEventListener("seeked", this.onSeeked);
      this.media.removeEventListener("playing", this.onPlaying);
      this.media.removeEventListener("waiting", this.onWaiting);
      this.media.removeEventListener("stalled", this.onWaiting);
      this.media.removeEventListener("pause", this.onPause);
      this.media.removeEventListener("ended", this.onPause);
      this.media.removeEventListener("ratechange", this.onRateChange);
    }
    this.cancelPendingWide();
    this.ordinarySpeeds.clear();
    for (const runtime of [this.scroll, this.fixed]) {
      runtime.manager.stopPlaying();
      runtime.manager.clear();
    }
    this.settleAll();
    for (const runtime of [this.scroll, this.fixed]) {
      runtime.lanes.reset(0);
      runtime.manager.unmount();
    }
    this.timeline = [];
    this.timelineIds = new Set();
    delete this.container.dataset.danmakuRenderer;
  }

  private readonly onResize = () => this.resize();

  private createLayer(layer: Layer): LayerRuntime {
    const manager = create<DanmakuComment>({
      mode: COLLISION_MODE,
      distribution: TRACK_DISTRIBUTION,
      gap: LANE_GAP_PX,
      interval: layer === "scroll" ? SCROLL_INTERVAL_MS : FIXED_INTERVAL_MS,
      speed: layer === "scroll" ? this.speed * SPEED_UNIT_SCALE : null,
      trackHeight: this.laneHeight,
      limits: { stash: MAX_STASHED },
      plugin: {
        $createNode: (danmaku) => this.onCreateNode(danmaku),
        $appendNode: (danmaku) => this.onAppendNode(danmaku),
        $moved: (danmaku) => this.onMoved(danmaku),
        $destroyed: (danmaku) => this.onDestroyed(danmaku),
        limitWarning: () => {},
      },
    });
    // 两层管理器各有一个容器节点：必须是绝对定位，否则两个相对定位的块会在流里上下堆叠。
    manager.container.setStyle("position", "absolute");
    manager.container.setStyle("top", "0");
    manager.container.setStyle("left", "0");
    manager.container.setStyle("pointerEvents", "none");
    manager.mount(this.container);
    manager.startPlaying();
    return { manager, lanes: new LanePool() };
  }

  private applyScrollArea(): void {
    this.scroll.manager.setArea({ y: { start: 0, end: `${this.area * 100}%` } });
  }

  private now(): number {
    return this.media ? this.media.currentTime : clock();
  }

  private runtimeOf(layer: Layer): LayerRuntime {
    return layer === "scroll" ? this.scroll : this.fixed;
  }

  private layerOf(comment: DanmakuComment): Layer {
    return comment.mode === "scroll" ? "scroll" : "fixed";
  }

  /** 车道下标的顶部像素；底部弹幕自下而上排。 */
  private laneY(layer: Layer, lane: number, mode: DanmakuComment["mode"]): number {
    const height = this.runtimeOf(layer).manager.container.height;
    if (mode === "bottom") return Math.max(0, height - (lane + 1) * this.laneHeight);
    return lane * this.laneHeight;
  }

  private reserve(layer: Layer, span: number): Reservation | null {
    const lane = this.runtimeOf(layer).lanes.allocate(span);
    if (lane === null) return null;
    const lanes = Array.from({ length: span }, (_, index) => lane + index);
    return { layer, lanes };
  }

  private releaseLanes(reservation: Reservation): void {
    const runtime = this.runtimeOf(reservation.layer);
    for (const lane of reservation.lanes) runtime.lanes.release(lane);
    if (!this.destroyed) {
      this.recomputeScrollLocks();
      this.ensureWideScheduler();
    }
  }

  /**
   * 投放一条弹幕；被库拒绝（待投放已满、未在播放）时立即结算 detach。
   * 返回是否已受理。
   *
   * 饱和时不在这里丢弃：库的 `strict` 把超量弹幕留在待投队列延后投放，
   * 上界是 `limits.stash`（`MAX_STASHED`）。
   */
  private push(comment: DanmakuComment): boolean {
    if (this.live.has(comment.id)) return false;
    const span = Math.max(1, Math.floor(comment.lanes ?? 1));
    if (comment.mode !== "scroll") return this.pushFixed(comment, span);
    if (span > 1) return this.pushWide(comment, span);
    const speed = this.currentOrdinarySpeed();
    if (!this.scroll.manager.push(comment)) {
      this.options.onDetach?.(comment.id);
      return false;
    }
    this.ordinarySpeeds.set(comment.id, { speed });
    this.live.add(comment.id);
    return true;
  }

  /** 固定弹幕：不参与轨道调度，由本文件按车道摆位，`direction: none` 静止到期。 */
  private pushFixed(comment: DanmakuComment, span: number): boolean {
    const reservation = this.reserve("fixed", span);
    if (!reservation) {
      this.options.onDetach?.(comment.id);
      return false;
    }
    const lane = reservation.lanes[0]!;
    const duration = positive(comment.duration, DEFAULT_FIXED_DURATION_MS);
    const ok = this.fixed.manager.pushFlexibleDanmaku(comment, {
      duration,
      // 全局 speed 会让库用 (x + 自身宽) / speed 覆盖 duration；固定弹幕必须显式关掉。
      speed: null,
      direction: "none",
      position: (danmaku) => this.fixedPosition(danmaku, lane, comment.mode),
    });
    if (!ok) {
      this.releaseLanes(reservation);
      this.options.onDetach?.(comment.id);
      return false;
    }
    this.reservations.set(comment.id, reservation);
    this.live.add(comment.id);
    return true;
  }

  /**
   * 大表情滚动弹幕：占两条物理轨，但不再从进入前到离屏一直独占。
   * 立即能进就投放；否则进入有界 FIFO，等单一调度器找到安全连续两轨。
   */
  private pushWide(comment: DanmakuComment, span: number): boolean {
    if (this.pendingWide.size + this.scroll.manager.len().stash >= MAX_STASHED) {
      this.options.onDetach?.(comment.id);
      return false;
    }
    this.live.add(comment.id);
    const pending: PendingWide = {
      comment,
      reservation: null,
      deadline: performance.now() + WIDE_MAX_WAIT_MS,
    };
    this.pendingWide.set(comment.id, pending);
    if (!this.frozen) this.tryLaunchWide(pending, span);
    // 未起步的 pending 需要按预约轨加锁；已投放的由 `launchWide` 自己重算并排下一次检查。
    if (this.pendingWide.has(comment.id)) {
      this.recomputeScrollLocks();
      this.ensureWideScheduler();
    }
    return true;
  }

  /** 为最早的一条 pending 找连续两轨；FIFO 只给更早项保留轨道。 */
  private tryLaunchWide(pending: PendingWide, span: number): void {
    if (this.frozen || this.destroyed) return;
    const manager = this.scroll.manager;
    if (span > manager.trackCount) return;
    const first = this.pendingWide.keys().next().value;
    if (first !== pending.comment.id) return;
    const entrantSpeed = this.currentOrdinarySpeed();
    const gap = typeof manager.options.gap === "number" ? manager.options.gap : 0;
    const containerWidth = manager.container.width;
    let best: { start: number; wait: number } | null = null;
    for (let start = 0; start + span <= manager.trackCount; start += 1) {
      if (this.pendingRangeReserved(start, span, pending.comment.id)) continue;
      const wait = laneEntryWaitMs(
        this.scrollOccupants(start, span, pending.comment.id),
        entrantSpeed,
        containerWidth,
        gap,
      );
      if (wait <= 0) {
        best = { start, wait: 0 };
        break;
      }
      if (!best || wait < best.wait) best = { start, wait };
    }
    if (!best) return;
    pending.reservation = {
      layer: "scroll",
      lanes: Array.from({ length: span }, (_, index) => best!.start + index),
    };
    if (best.wait <= 0) this.launchWide(pending.comment, pending.reservation);
  }

  /** 更早的 pending 预约的连续轨道范围对新预约保留。 */
  private pendingRangeReserved(start: number, span: number, selfId: string): boolean {
    for (const [id, pending] of this.pendingWide) {
      if (id === selfId) break;
      const lanes = pending.reservation?.lanes;
      if (!lanes) continue;
      const end = start + span;
      if (start < lanes[lanes.length - 1]! + 1 && lanes[0]! < end) return true;
    }
    return false;
  }

  /**
   * 后续普通滚动弹幕的入场速度上界：manager 当前配置与所有已受理条目的入库速度快照。
   * `push` 对每条普通弹幕都记过快照（库在 push 时同样快照 speed/rate），快照随销毁删除，
   * 所以不必逐轨读 `_getSpeed()`——那会对每条在屏弹幕触发一次强制同步布局。
   */
  private ordinaryEntrySpeed(): number {
    let speed = this.currentOrdinarySpeed();
    for (const ordinary of this.ordinarySpeeds.values()) speed = Math.max(speed, ordinary.speed);
    return speed;
  }

  /** 新入库普通弹幕的速度快照；库会从当前 manager 配置补齐 speed/rate。 */
  private currentOrdinarySpeed(): number {
    const manager = this.scroll.manager;
    const speed =
      (typeof manager.options.speed === "number" ? manager.options.speed : 0) *
      manager.options.rate;
    return Number.isFinite(speed) && speed > 0 ? speed : 0;
  }

  /**
   * 图片进入前检查同轨所有图片、普通弹幕和尚未 append 的图片预约。
   * 普通弹幕的 paused 保持库的忽略语义；大表情即使被钉住也必须保守阻挡后来者。
   */
  private scrollOccupants(start: number, span: number, selfId: string): LaneMotion[] {
    const manager = this.scroll.manager;
    const occupants: LaneMotion[] = [];
    const seen = new Set<Danmaku<DanmakuComment>>();
    for (let lane = start; lane < start + span; lane += 1) {
      if (lane >= manager.trackCount) continue;
      manager.getTrack(lane)?.each((danmaku) => {
        if (seen.has(danmaku)) return;
        seen.add(danmaku);
        if (danmaku.type === "facile") {
          const wide = Math.max(1, Math.floor(danmaku.data.lanes ?? 1)) > 1;
          if (!danmaku.paused || wide) occupants.push(this.facileMotion(danmaku));
        } else {
          occupants.push(this.flexibleMotion(danmaku));
        }
      });
    }
    for (const [id, reservation] of this.reservations) {
      if (id === selfId || reservation.layer !== "scroll") continue;
      if (!this.rangesOverlap(start, span, reservation.lanes)) continue;
      occupants.push(BLOCKING_MOTION);
    }
    for (const [id, pending] of this.pendingWide) {
      if (id === selfId || !pending.reservation) continue;
      if (!this.rangesOverlap(start, span, pending.reservation.lanes)) continue;
      occupants.push(BLOCKING_MOTION);
    }
    for (const record of this.records.values()) {
      if (!this.isScrollWide(record)) continue;
      if (seen.has(record.danmaku)) continue;
      if (!this.rangesOverlap(start, span, record.lanes)) continue;
      occupants.push(this.recordMotion(record));
    }
    return occupants;
  }

  /** 一轨 large 经 appearance 扩为两轨后仍是 facile，也必须纳入大表情的几何准入与锁。 */
  private isScrollWide(record: RecordItem): boolean {
    return (
      record.layer === "scroll" &&
      (record.danmaku.type === "flexible" || Math.max(1, Math.floor(record.comment.lanes ?? 1)) > 1)
    );
  }

  private recordMotion(record: RecordItem): LaneMotion {
    const motion =
      record.danmaku.type === "flexible"
        ? this.flexibleMotion(record.danmaku)
        : this.facileMotion(record.danmaku);
    if (Math.max(1, Math.floor(record.comment.lanes ?? 1)) > 1) {
      motion.paused = record.danmaku.paused;
    }
    return motion;
  }

  private rangesOverlap(start: number, span: number, lanes: readonly number[]): boolean {
    const last = lanes[lanes.length - 1];
    return last !== undefined && start < last + 1 && lanes[0]! < start + span;
  }

  private facileMotion(danmaku: Danmaku<DanmakuComment>): LaneMotion {
    return {
      paused: danmaku.paused,
      moving: danmaku.moving,
      left: this.scroll.manager.container.width - danmaku._getMoveDistance(),
      width: danmaku.getWidth(),
      speed: danmaku._getSpeed(),
    };
  }

  private flexibleMotion(danmaku: Danmaku<DanmakuComment>): LaneMotion {
    return {
      paused: danmaku.paused,
      moving: danmaku.moving,
      left: danmaku.moving ? danmaku._getMoveDistance() : danmaku.position.x,
      width: danmaku.getWidth(),
      speed: danmaku._getSpeed() * danmaku.rate,
    };
  }

  /**
   * 图片在途的 y 不会随字号变化重写，因此按当前 y 与元素高度映射它实际覆盖的物理轨。
   * 更新样式后的同一调用栈里高度可能仍是旧值，故至少保留声明占用的 span。
   */
  private coveredScrollLanes(danmaku: Danmaku<DanmakuComment>): number[] {
    const manager = this.scroll.manager;
    const total = manager.trackCount;
    if (total <= 0) return [];
    const declared = Math.max(1, Math.floor(danmaku.data.lanes ?? 1));
    const height = Math.max(danmaku.getHeight(), declared * this.laneHeight);
    const top = danmaku.position.y;
    if (
      top < 0 ||
      !Number.isFinite(top) ||
      !Number.isFinite(height) ||
      top + height > manager.container.height
    ) {
      return [];
    }
    const start = Math.floor(top / this.laneHeight);
    if (start < 0 || start >= total) return [];
    const count = Math.max(1, Math.ceil((top + height) / this.laneHeight) - start);
    const end = start + count;
    if (end > total) return [];
    return Array.from({ length: end - start }, (_, index) => start + index);
  }

  /**
   * 只在「还有未起步的图片」或「轨道仍被锁」时轮询：图片完全进屏后锁会解除，
   * 此后不再需要定期重查；解除锁本身就在下一次 tick 内完成，不会漏掉。
   */
  private ensureWideScheduler(): void {
    if (this.destroyed) return;
    if (this.pendingWide.size === 0 && this.scrollLocked.size === 0) return;
    if (this.wideTimer !== 0) return;
    this.wideTimer = window.setTimeout(() => this.runWideScheduler(), WIDE_RETRY_MS);
  }

  private stopWideScheduler(): void {
    if (this.wideTimer === 0) return;
    window.clearTimeout(this.wideTimer);
    this.wideTimer = 0;
  }

  private unlockScrollTracks(): void {
    const manager = this.scroll.manager;
    for (const lane of this.scrollLocked) {
      if (lane < manager.trackCount) manager.getTrack(lane)?.unlock();
    }
    this.scrollLocked.clear();
  }

  private runWideScheduler(): void {
    this.wideTimer = 0;
    if (this.destroyed) return;
    this.expireStartingWide();
    this.expirePendingWide();
    if (!this.frozen) this.advancePendingWide();
    this.recomputeScrollLocks();
    this.ensureWideScheduler();
  }

  /**
   * 库在冻结状态下把 flexible 弹幕留在实例集合里且不会重试启动。预约一直保留到实例
   * 真正 moving：既覆盖 append 前冻结，也覆盖 append 后、下一次 nextFrame 启动前冻结。
   */
  private expireStartingWide(): void {
    const now = performance.now();
    const expired = new Set<string>();
    for (const [id, reservation] of this.reservations) {
      if (reservation.layer !== "scroll" || reservation.deadline === undefined) continue;
      const record = this.records.get(id);
      if (record?.danmaku.moving) {
        this.reservations.delete(id);
        continue;
      }
      if (reservation.deadline > now) continue;
      expired.add(id);
    }
    if (expired.size === 0) return;
    const found = new Set<string>();
    this.scroll.manager.each((danmaku) => {
      const id = danmaku.data.id;
      if (!expired.has(id)) return;
      found.add(id);
      void danmaku.destroy();
    });
    for (const id of expired) {
      if (found.has(id)) continue;
      const record = this.records.get(id);
      if (!record) continue;
      found.add(id);
      void record.danmaku.destroy();
    }
    for (const id of expired) {
      const reservation = this.reservations.get(id);
      if (!reservation) continue;
      this.reservations.delete(id);
      this.releaseLanes(reservation);
      this.detach(id);
    }
  }

  /** 等待按墙钟计时；冻结只暂停投放，不暂停超时回收。 */
  private expirePendingWide(): void {
    const now = performance.now();
    for (const [id, pending] of Array.from(this.pendingWide)) {
      if (now < pending.deadline) continue;
      this.pendingWide.delete(id);
      this.detach(id);
    }
  }

  private advancePendingWide(): void {
    for (const [id, pending] of Array.from(this.pendingWide)) {
      if (!this.pendingWide.has(id)) continue;
      this.tryLaunchWide(pending, Math.max(1, Math.floor(pending.comment.lanes ?? 1)));
    }
  }

  /**
   * 重算滚动层锁：pending/未 append 的图片预约，以及在途图片仍有碰撞风险时锁定。
   * 普通弹幕的未起步状态由库的 `_getTrack` 自行拒绝，不在这里加锁以免失去解锁调度。
   *
   * 没有任何滚动图片时直接返回（锁已在上面整体释放）：`onAppendNode`/`onDestroyed`
   * 会为每条普通弹幕调用到这里，逐条扫描轨道并读元素尺寸会把布局开销摊到热路径上。
   */
  private recomputeScrollLocks(): void {
    this.unlockScrollTracks();
    if (this.destroyed) return;
    const manager = this.scroll.manager;
    const locked = new Set<number>();
    const reservations: Reservation[] = [];
    for (const reservation of this.reservations.values()) {
      if (reservation.layer === "scroll") reservations.push(reservation);
    }
    for (const pending of this.pendingWide.values()) {
      if (pending.reservation) reservations.push(pending.reservation);
    }
    let hasWideRecord = false;
    for (const record of this.records.values()) {
      if (this.isScrollWide(record)) {
        hasWideRecord = true;
        break;
      }
    }
    if (reservations.length === 0 && !hasWideRecord) return;
    for (const reservation of reservations) {
      for (const lane of reservation.lanes) if (lane < manager.trackCount) locked.add(lane);
    }
    const entrantSpeed = this.ordinaryEntrySpeed();
    const gap = typeof manager.options.gap === "number" ? manager.options.gap : 0;
    for (const record of this.records.values()) {
      if (!this.isScrollWide(record)) continue;
      record.lanes = this.coveredScrollLanes(record.danmaku);
      const motion = this.recordMotion(record);
      for (const lane of record.lanes) {
        if (lane >= manager.trackCount) continue;
        if (laneEntryWaitMs([motion], entrantSpeed, manager.container.width, gap) > 0) {
          locked.add(lane);
        }
      }
    }
    for (const lane of locked) {
      manager.getTrack(lane)?.lock();
      this.scrollLocked.add(lane);
    }
  }

  /** 车道已就绪：真正投放；库拒绝时归还车道并结算 detach。 */
  private launchWide(comment: DanmakuComment, reservation: Reservation): void {
    const lane = reservation.lanes[0]!;
    const ok = this.scroll.manager.pushFlexibleDanmaku(comment, {
      speed: this.speed * SPEED_UNIT_SCALE,
      direction: "right",
      position: (_danmaku, container) => ({
        x: container.width,
        y: this.laneY("scroll", lane, comment.mode),
      }),
    });
    if (!ok) {
      this.pendingWide.delete(comment.id);
      this.detach(comment.id);
      return;
    }
    this.pendingWide.delete(comment.id);
    reservation.deadline = performance.now() + WIDE_MAX_WAIT_MS;
    this.reservations.set(comment.id, reservation);
    this.recomputeScrollLocks();
    this.ensureWideScheduler();
    this.scheduleRender();
  }

  /** 取消所有等待中的大表情并结算 detach。 */
  private cancelPendingWide(): void {
    const entries = Array.from(this.pendingWide.values());
    this.pendingWide.clear();
    for (const pending of entries) {
      this.detach(pending.comment.id);
    }
  }

  private fixedPosition(
    danmaku: Danmaku<DanmakuComment>,
    lane: number,
    mode: DanmakuComment["mode"],
  ): { x: number; y: number } {
    const container = this.fixed.manager.container;
    return {
      x: (container.width - danmaku.getWidth()) * 0.5,
      y: this.laneY("fixed", lane, mode),
    };
  }

  private scheduleRender(): void {
    if (this.renderQueued) return;
    this.renderQueued = true;
    queueMicrotask(() => {
      this.renderQueued = false;
      if (!this.destroyed) this.scroll.manager.render();
    });
  }

  /** 唯一结算点：每条受理过的弹幕只回调一次 `onDetach`。 */
  private detach(id: string): void {
    if (!this.live.delete(id)) return;
    this.options.onDetach?.(id);
  }

  private settleAll(): void {
    const ids = Array.from(this.live);
    this.records.clear();
    this.reservations.clear();
    for (const id of ids) this.detach(id);
  }

  private onCreateNode(danmaku: Danmaku<DanmakuComment>): void {
    danmaku.node?.appendChild(danmaku.data.render());
  }

  private onAppendNode(danmaku: Danmaku<DanmakuComment>): void {
    const comment = danmaku.data;
    const element = danmaku.node?.firstElementChild;
    if (!(element instanceof HTMLElement)) return;
    const reservation = this.reservations.get(comment.id);
    // 大表情保留启动预约到首次 moving；冻结可能发生在 append 之后、启动 nextFrame 之前。
    if (!(reservation?.layer === "scroll" && reservation.deadline !== undefined)) {
      this.reservations.delete(comment.id);
    }
    const record: RecordItem = {
      comment,
      danmaku,
      element,
      layer: reservation?.layer ?? this.layerOf(comment),
      lanes: reservation?.lanes ?? [],
    };
    this.records.set(comment.id, record);
    // 普通弹幕的入场速度已在 `push` 时记入 `ordinarySpeeds`，append 不改变图片的准入结论；
    // 只有图片自身（或一轨大表情扩为两轨）需要立即重算锁。
    if (this.isScrollWide(record)) this.recomputeScrollLocks();
    this.ensureWideScheduler();
    this.options.onAttach?.(comment, element);
  }

  /** 运动结束立即回收 DOM，不等库的批量销毁（默认 3s 一批）；车道在销毁钩子里释放。 */
  private onMoved(danmaku: Danmaku<DanmakuComment>): void {
    void danmaku.destroy();
  }

  /**
   * 记录与车道的唯一回收点：库的 `destroy()`、被丢弃的待投放弹幕都经过这里。
   * 已受理但从未上屏的条目在此结算 detach，调用方的活动预算才不会泄漏。
   */
  private onDestroyed(danmaku: Danmaku<DanmakuComment>): void {
    const comment = danmaku.data;
    this.ordinarySpeeds.delete(comment.id);
    const reservation = this.reservations.get(comment.id);
    if (reservation) {
      this.reservations.delete(comment.id);
      this.releaseLanes(reservation);
    }
    const record = this.records.get(comment.id);
    if (record) {
      this.records.delete(comment.id);
      // 固定弹幕同样占用车道，必须一并归还，否则固定层很快无车道可用。
      if (record.lanes.length > 0) {
        this.releaseLanes({ layer: record.layer, lanes: record.lanes });
      }
    }
    this.detach(comment.id);
    this.ensureWideScheduler();
  }

  private clearActive(): void {
    // 轨道锁是 Track 对象上的状态，`manager.clear()` 不会重置它；先解锁再清屏，
    // 否则被大表情锁住的轨道会永久拒绝普通滚动弹幕。
    this.stopWideScheduler();
    this.unlockScrollTracks();
    this.cancelPendingWide();
    this.ordinarySpeeds.clear();
    for (const runtime of [this.scroll, this.fixed]) runtime.manager.clear();
    this.settleAll();
    for (const runtime of [this.scroll, this.fixed])
      runtime.lanes.reset(runtime.manager.trackCount);
  }

  /**
   * 尺寸或车道高变化后重建占用表。滚动大表情的 y 已随 transition 推进，改车道会跳位，
   * 因此按实际 y/高度重新映射覆盖轨，越界即销毁；固定弹幕随后按新几何重新落位。
   */
  private syncLanes(): void {
    const records = Array.from(this.records.values());
    this.stopWideScheduler();
    this.unlockScrollTracks();
    for (const runtime of [this.scroll, this.fixed])
      runtime.lanes.reset(runtime.manager.trackCount);
    // 轨道重建后车道上限可能变小：等待中的大表情仍放得下就保留预约，稍后由调度器复核。
    for (const pending of this.pendingWide.values()) {
      const { reservation } = pending;
      if (!reservation) continue;
      if (reservation.lanes[reservation.lanes.length - 1]! >= this.scroll.manager.trackCount) {
        pending.reservation = null;
      }
    }
    for (const record of records) {
      if (record.layer !== "fixed" || record.lanes.length === 0) continue;
      if (!this.records.has(record.comment.id)) continue;
      const runtime = this.runtimeOf(record.layer);
      const span = record.lanes.length;
      const lane = runtime.lanes.allocate(span);
      if (lane === null) {
        record.lanes = [];
        void record.danmaku.destroy();
        continue;
      }
      record.lanes = Array.from({ length: span }, (_, index) => lane + index);
      // 静止弹幕的 x 居中、y 由车道决定，尺寸变化后都要按新几何重写；滚动弹幕的位置由
      // transition 推进，不能回写。
      const position = this.fixedPosition(record.danmaku, lane, record.comment.mode);
      record.danmaku.position.x = position.x;
      record.danmaku.position.y = position.y;
      record.danmaku.setStyle(
        "transform",
        `translateX(${position.x}px) translateY(${position.y}px)`,
      );
    }
    for (const record of records) {
      if (!this.isScrollWide(record)) continue;
      if (!this.records.has(record.comment.id)) continue;
      const lanes = this.coveredScrollLanes(record.danmaku);
      if (lanes.length === 0) {
        record.lanes = [];
        void record.danmaku.destroy();
        continue;
      }
      record.lanes = lanes;
    }
    this.recomputeScrollLocks();
    this.ensureWideScheduler();
  }

  private bindMedia(media: HTMLMediaElement): void {
    media.addEventListener("seeking", this.onSeeking);
    media.addEventListener("seeked", this.onSeeked);
    media.addEventListener("playing", this.onPlaying);
    media.addEventListener("waiting", this.onWaiting);
    media.addEventListener("stalled", this.onWaiting);
    media.addEventListener("pause", this.onPause);
    media.addEventListener("ended", this.onPause);
    media.addEventListener("ratechange", this.onRateChange);
    this.onRateChange();
    if (media.paused || media.seeking || media.ended) this.onPause();
    else this.onPlaying();
  }

  private freeze(): void {
    if (this.frozen) return;
    this.frozen = true;
    this.scroll.manager.freeze();
    this.fixed.manager.freeze();
    this.recomputeScrollLocks();
    this.ensureWideScheduler();
  }

  private unfreeze(): void {
    if (!this.frozen) return;
    this.frozen = false;
    this.scroll.manager.unfreeze();
    this.fixed.manager.unfreeze();
    this.recomputeScrollLocks();
    this.ensureWideScheduler();
  }

  /** seek 清屏并从新位置往后继续投放（过去的不补投），与旧实现语义一致。 */
  private readonly onSeeking = () => {
    if (this.destroyed) return;
    this.freeze();
    this.stopClock();
    this.clearActive();
    this.lastMediaTime = this.now();
    this.cursor = lowerBound(this.timeline, this.lastMediaTime);
  };

  private readonly onSeeked = () => {
    if (this.destroyed || !this.media) return;
    if (this.media.paused || this.media.ended) return;
    this.lastMediaTime = this.media.currentTime;
    this.unfreeze();
    this.startClock();
  };

  /** `playing` 而不是 `play`：缓冲结束后才恢复运动，与旧实现按媒体时间推进一致。 */
  private readonly onPlaying = () => {
    if (this.destroyed) return;
    this.lastMediaTime = this.now();
    this.unfreeze();
    this.startClock();
  };

  private readonly onWaiting = () => {
    if (this.destroyed) return;
    this.freeze();
    this.stopClock();
  };

  private readonly onPause = () => {
    if (this.destroyed) return;
    this.stopClock();
    this.freeze();
    this.lastMediaTime = this.now();
  };

  private readonly onRateChange = () => {
    if (this.destroyed || !this.media) return;
    const rate = this.media.playbackRate > 0 ? this.media.playbackRate : 1;
    this.scroll.manager.setRate(rate);
    this.fixed.manager.setRate(rate);
    this.recomputeScrollLocks();
    this.ensureWideScheduler();
  };

  private startClock(): void {
    if (this.frame !== 0 || this.destroyed || !this.media) return;
    this.frame = requestAnimationFrame(this.tick);
  }

  private stopClock(): void {
    if (this.frame === 0) return;
    cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  private readonly tick = () => {
    if (this.destroyed) return;
    this.frame = requestAnimationFrame(this.tick);
    const media = this.media;
    if (!media || this.frozen) return;
    const time = media.currentTime;
    if (Math.abs(time - this.lastMediaTime) > SEEK_JUMP_SECONDS) {
      this.onSeeking();
      return;
    }
    this.lastMediaTime = time;
    if (this.cursor >= this.timeline.length) return;
    let pushed = 0;
    while (this.cursor < this.timeline.length && pushed < MAX_PUSH_PER_FRAME) {
      const comment = this.timeline[this.cursor]!;
      if ((comment.time ?? Number.POSITIVE_INFINITY) > time) break;
      this.cursor += 1;
      if (this.live.has(comment.id)) continue;
      this.push(comment);
      pushed += 1;
    }
    if (pushed > 0) this.scheduleRender();
  };
}
