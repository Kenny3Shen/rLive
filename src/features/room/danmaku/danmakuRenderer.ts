import { create, type Danmaku, type Manager } from "danmu";
import { applyCommentStyle } from "./danmakuAdapter";
import type { DanmakuComment, DanmakuRendererOptions } from "./danmakuTypes";

/**
 * 基于 `danmu` 的 DOM 弹幕引擎。运动由每条弹幕自己的 CSS transition 在合成器上推进，
 * 主线程只负责投放、准入与生命周期，不再逐帧写 transform。
 *
 * 两层管理器：滚动层限制在用户设置的显示区域内，固定层占满整个舞台，与旧实现的分层一致。
 * `danmu` 不绑定媒体，因此 VOD 由本文件按媒体事件推进投放与暂停/倍速，直播按墙钟直接投放。
 * 固定弹幕（top/bottom，含 SC 与自己的弹幕）走 flexible danmaku，由 `LanePool` 每条独占
 * 一条车道；滚动弹幕（含带图的大表情）全部交给 `danmu` 的轨道调度与碰撞预测，大表情与
 * 普通弹幕同尺寸、只占一条轨道。
 *
 * 碰撞检测档位不开放给用户：两层都用库的 `strict`（饱和时排队延后而非叠放），
 * 轨道分配固定 `random`，见 `COLLISION_MODE` 与 `TRACK_DISTRIBUTION`。直播另用应用侧
 * 限时队列控制滚动弹幕的陈旧度（`maxLatencyMs`），点播不启用。
 */
type Layer = "scroll" | "fixed";

type LayerRuntime = {
  manager: Manager<DanmakuComment>;
};

type RecordItem = {
  comment: DanmakuComment;
  danmaku: Danmaku<DanmakuComment>;
  element: HTMLElement;
  layer: Layer;
  /** 固定弹幕的独占车道；滚动弹幕交给库的轨道调度，不占 `LanePool`。 */
  lane: number | null;
};

/** 固定弹幕投放前的车道占用：`pushFlexibleDanmaku` 不返回实例，靠 comment id 在钩子里认领。 */
type Reservation = {
  lane: number;
};

/** 应用侧限时队列里的滚动弹幕；`queuedAt` 是入队时的墙钟毫秒。 */
type BacklogItem = {
  comment: DanmakuComment;
  queuedAt: number;
};

/** 库在弹幕从 stash 取出、即将上屏前回调的 `willRender` 事件。 */
type WillRenderEvent = {
  type: "facile" | "flexible";
  prevent: boolean;
  danmaku: Danmaku<DanmakuComment>;
  trackIndex: number | null;
};

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
 * 滚动层碰撞检测档位固定为库的 `strict`：车道不满足准入时留在待投队列等空位，宁可延后也不重叠。
 * 不用 `adaptive`：轨道全满时它随机挑一条轨道直接叠放；`none` 完全不检测，两者都会压字。
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
/** 应用侧队列的过期检查间隔；只在队列非空时排定，冻结时也靠它按墙钟过期。 */
const BACKLOG_RETRY_MS = 100;

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
 * 固定弹幕的车道占用表。固定弹幕全部单车道，走进 flexible danmaku 后车道完全由本表
 * 静态分配；滚动弹幕交给库自己的轨道调度，不经过这里。
 */
export class LanePool {
  private used: boolean[] = [];

  reset(count: number): void {
    this.used = Array.from({ length: Math.max(0, Math.floor(count)) }, () => false);
  }

  /** 自顶向下找第一条空闲车道；没有空车道时返回 null。 */
  allocate(): number | null {
    const index = this.used.indexOf(false);
    if (index < 0) return null;
    this.used[index] = true;
    return index;
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
  private readonly fixedLanes = new LanePool();
  private readonly records = new Map<string, RecordItem>();
  private readonly reservations = new Map<string, Reservation>();
  /** 直播滚动弹幕的应用侧限时队列；`maxLatencyMs` 未设置时始终为空。 */
  private readonly backlog: BacklogItem[] = [];
  /** 直播滚动弹幕的入队墙钟；交给库后仍保留到结算，供 `willRender` 做端到端过期。 */
  private readonly queuedAt = new Map<string, number>();
  /** 泵正在进行时防止 `onAppendNode` 在库的渲染循环里重入。 */
  private pumping = false;
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
  /** 滚动弹幕在应用侧的最长等待（毫秒）；0 表示不启用，直接交给库的 strict 队列。 */
  private readonly maxLatencyMs: number;
  private lastMediaTime = 0;
  private frozen = false;
  /** 离场导航：停掉本引擎的 rAF 与投放，但保留媒体和已上屏弹幕。 */
  private quiet = false;
  private frame = 0;
  private backlogTimer = 0;
  private renderQueued = false;
  private destroyed = false;

  constructor(options: DanmakuRendererOptions) {
    this.options = options;
    this.container = options.container;
    this.media = options.media;
    this.speed = positive(options.speed, 100);
    this.area = clampArea(options.area);
    this.laneHeight = Math.max(1, Math.round(positive(options.laneHeight, 24)));
    this.maxLatencyMs =
      typeof options.maxLatencyMs === "number" &&
      Number.isFinite(options.maxLatencyMs) &&
      options.maxLatencyMs > 0
        ? options.maxLatencyMs
        : 0;
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

  /** 直播：一条事件立即投放；带图的大表情与普通滚动弹幕走同一条路径。 */
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
    this.ensureBacklogTimer();
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
    return record.danmaku.paused === true;
  }

  unpin(id: string): void {
    const record = this.records.get(id);
    if (!record || this.destroyed) return;
    record.danmaku.resume();
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
  }

  setSpeed(speed: number): void {
    const next = positive(speed, this.speed);
    if (next === this.speed) return;
    this.speed = next;
    this.scroll.manager.setSpeed(next * SPEED_UNIT_SCALE);
  }

  setArea(area: number): void {
    const next = clampArea(area);
    if (next === this.area) return;
    this.area = next;
    this.applyScrollArea();
    // `setArea` 经库的 `format()` 重建轨道，队列容量与每轮可投放数随之变化。
    this.trimBacklog();
    this.pumpBacklog();
    this.ensureBacklogTimer();
  }

  /** 字号变化同时改变车道高：轨道与固定车道占用表一起重建。 */
  setLaneHeight(laneHeight: number): void {
    const next = Math.max(1, Math.round(positive(laneHeight, this.laneHeight)));
    if (next === this.laneHeight) return;
    this.laneHeight = next;
    this.scroll.manager.setTrackHeight(next);
    this.fixed.manager.setTrackHeight(next);
    this.syncLanes();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.observer?.disconnect();
    window.removeEventListener("resize", this.onResize);
    this.stopClock();
    this.stopBacklogTimer();
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
    this.cancelBacklog();
    for (const runtime of [this.scroll, this.fixed]) {
      runtime.manager.stopPlaying();
      runtime.manager.clear();
    }
    this.settleAll();
    this.fixedLanes.reset(0);
    for (const runtime of [this.scroll, this.fixed]) runtime.manager.unmount();
    this.timeline = [];
    this.timelineIds = new Set();
    delete this.container.dataset.danmakuRenderer;
  }

  /**
   * 页面开始离场时静默调度。不 clear、不 pause 媒体：已经上屏的 CSS 过渡由
   * 合成器继续推进，旧播放页的活画面与弹幕画面都保留；只停掉主线程的 rAF
   * 投放循环，避免它与目标列表的并发渲染争抢每一帧。
   */
  setQuiet(quiet: boolean): void {
    if (this.destroyed || this.quiet === quiet) return;
    this.quiet = quiet;
    if (quiet) {
      this.stopClock();
      this.stopBacklogTimer();
      // 两层 manager 自身各有一个 200/500ms 渲染定时器，离场时也要停下。
      this.scroll.manager.stopPlaying();
      this.fixed.manager.stopPlaying();
      return;
    }
    this.scroll.manager.startPlaying();
    this.fixed.manager.startPlaying();
    if (this.media && !this.media.paused && !this.media.ended && !this.frozen) {
      this.lastMediaTime = this.now();
      this.startClock();
    }
    this.ensureBacklogTimer();
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
        willRender: (event: WillRenderEvent) => this.onWillRender(event),
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
    return { manager };
  }

  private applyScrollArea(): void {
    this.scroll.manager.setArea({ y: { start: 0, end: `${this.area * 100}%` } });
  }

  private now(): number {
    return this.media ? this.media.currentTime : clock();
  }

  private layerOf(comment: DanmakuComment): Layer {
    return comment.mode === "scroll" ? "scroll" : "fixed";
  }

  private reserveFixed(): Reservation | null {
    const lane = this.fixedLanes.allocate();
    return lane === null ? null : { lane };
  }

  private releaseFixedLane(lane: number | null): void {
    if (lane !== null) this.fixedLanes.release(lane);
  }

  /**
   * 投放一条弹幕；被库拒绝（待投放已满、未在播放）时立即结算 detach。
   * 返回是否已受理。
   *
   * 滚动弹幕在直播设置 `maxLatencyMs` 后先进入应用侧限时队列，由 `pumpBacklog`
   * 按轨道数与陈旧度决定何时交给库；点播与固定弹幕直接交给库。
   */
  private push(comment: DanmakuComment): boolean {
    if (this.quiet || this.live.has(comment.id)) return false;
    if (comment.mode !== "scroll") return this.pushFixed(comment);
    if (this.maxLatencyMs > 0) return this.enqueueBacklog(comment);
    if (!this.scroll.manager.push(comment)) {
      this.options.onDetach?.(comment.id);
      return false;
    }
    this.live.add(comment.id);
    return true;
  }

  /**
   * 受理一条滚动弹幕到应用侧队列。库的 `strict` 只看条数上限、不看时间，
   * 饱和时会一直保留最旧的弹幕；直播要的恰好相反，因此陈旧度与容量都由这里控制。
   */
  private enqueueBacklog(comment: DanmakuComment): boolean {
    const queuedAt = performance.now();
    this.live.add(comment.id);
    this.queuedAt.set(comment.id, queuedAt);
    this.backlog.push({ comment, queuedAt });
    this.trimBacklog();
    this.pumpBacklog();
    this.ensureBacklogTimer();
    return true;
  }

  /** 队列容量随轨道数变化：至少 4 条，约两轮轨道容量。 */
  private backlogCapacity(): number {
    return Math.max(4, this.scroll.manager.trackCount * 2);
  }

  /** 容量溢出时丢最旧的，与直播「丢旧留新」一致；每条恰好结算一次。 */
  private trimBacklog(): void {
    const capacity = this.backlogCapacity();
    while (this.backlog.length > capacity) {
      const dropped = this.backlog.shift();
      if (!dropped) break;
      this.detach(dropped.comment.id);
    }
  }

  /** 按墙钟丢弃超龄项；冻结只暂停投放，不暂停过期。 */
  private expireBacklog(): void {
    if (!(this.maxLatencyMs > 0)) return;
    const now = performance.now();
    while (this.backlog.length > 0) {
      const head = this.backlog[0]!;
      if (now - head.queuedAt <= this.maxLatencyMs) break;
      this.backlog.shift();
      this.detach(head.comment.id);
    }
  }

  /**
   * 把队列头部交给库，直到库的 stash 接近一轮轨道容量。库在 `strict` 下每次渲染最多
   * 消费 `trackCount` 条，stash 再多也只是把陈旧弹幕泡得更久，因此只保持约一轮。
   */
  private pumpBacklog(): void {
    if (!(this.maxLatencyMs > 0) || this.destroyed || this.quiet || this.pumping) return;
    this.expireBacklog();
    if (this.frozen) return;
    const manager = this.scroll.manager;
    const limit = Math.max(1, manager.trackCount);
    let pushed = 0;
    this.pumping = true;
    try {
      while (this.backlog.length > 0 && manager.len().stash < limit) {
        const item = this.backlog[0]!;
        if (!manager.push(item.comment)) {
          this.backlog.shift();
          this.detach(item.comment.id);
          continue;
        }
        this.backlog.shift();
        pushed += 1;
      }
    } finally {
      this.pumping = false;
    }
    if (pushed > 0) this.scheduleRender();
  }

  /** 清空应用侧队列并逐条结算；`live` 保证与后续 `settleAll` 不会重复回调。 */
  private cancelBacklog(): void {
    const items = this.backlog.splice(0);
    for (const item of items) this.detach(item.comment.id);
  }

  /**
   * 库从 stash 取出、即将上屏前的最后一道端到端过期检查。`pumpBacklog` 只约束
   * 应用侧队列；交给库的条目仍可能等待，因此这里按入队时刻再判一次。
   * 库对 prevent 的条目不会 append、入 view 或 destroy，也不会触发 `$destroyed`，
   * 所以必须在这里回收记录并结算 `detach`。
   */
  private onWillRender(event: WillRenderEvent): WillRenderEvent {
    if (event.prevent || event.type !== "facile" || !(this.maxLatencyMs > 0)) return event;
    const id = event.danmaku.data.id;
    const queuedAt = this.queuedAt.get(id);
    if (queuedAt === undefined || performance.now() - queuedAt <= this.maxLatencyMs) return event;
    // strict 重试可能已经 append 过一次；`_reset` 移除了 DOM，但本文件的记录还在。
    const record = this.records.get(id);
    if (record) {
      this.records.delete(id);
      this.releaseFixedLane(record.lane);
    }
    this.detach(id);
    this.pumpBacklog();
    event.prevent = true;
    return event;
  }

  /** 固定弹幕：不参与轨道调度，由本文件按单条车道摆位，`direction: none` 静止到期。 */
  private pushFixed(comment: DanmakuComment): boolean {
    const reservation = this.reserveFixed();
    if (!reservation) {
      this.options.onDetach?.(comment.id);
      return false;
    }
    const duration = positive(comment.duration, DEFAULT_FIXED_DURATION_MS);
    const ok = this.fixed.manager.pushFlexibleDanmaku(comment, {
      duration,
      // 全局 speed 会让库用 (x + 自身宽) / speed 覆盖 duration；固定弹幕必须显式关掉。
      speed: null,
      direction: "none",
      // 回调在 append 时才调用；resize 可能已在 push 与 append 之间重建车道表并改写预约，
      // 因此这里读预约的当前车道，而不是 push 时捕获的下标。
      position: (danmaku) => this.fixedPosition(danmaku, reservation.lane, comment.mode),
    });
    if (!ok) {
      this.releaseFixedLane(reservation.lane);
      this.options.onDetach?.(comment.id);
      return false;
    }
    this.reservations.set(comment.id, reservation);
    this.live.add(comment.id);
    return true;
  }

  private fixedPosition(
    danmaku: Danmaku<DanmakuComment>,
    lane: number,
    mode: DanmakuComment["mode"],
  ): { x: number; y: number } {
    const container = this.fixed.manager.container;
    return {
      x: (container.width - danmaku.getWidth()) * 0.5,
      y: this.fixedLaneY(lane, mode),
    };
  }

  /** 固定弹幕车道的顶部像素；底部弹幕自下而上排。 */
  private fixedLaneY(lane: number, mode: DanmakuComment["mode"]): number {
    const height = this.fixed.manager.container.height;
    if (mode === "bottom") return Math.max(0, height - (lane + 1) * this.laneHeight);
    return lane * this.laneHeight;
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
    this.queuedAt.delete(id);
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
    if (reservation) this.reservations.delete(comment.id);
    const record: RecordItem = {
      comment,
      danmaku,
      element,
      layer: reservation ? "fixed" : this.layerOf(comment),
      lane: reservation?.lane ?? null,
    };
    this.records.set(comment.id, record);
    // 库刚从 stash 取走一条，空出的位置立即用队列头部补上。
    this.pumpBacklog();
    this.ensureBacklogTimer();
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
    const reservation = this.reservations.get(comment.id);
    if (reservation) {
      this.reservations.delete(comment.id);
      this.releaseFixedLane(reservation.lane);
    }
    const record = this.records.get(comment.id);
    if (record) {
      this.records.delete(comment.id);
      // 固定弹幕占用的车道必须归还，否则固定层很快无车道可用。
      this.releaseFixedLane(record.lane);
    }
    this.detach(comment.id);
    // 销毁可能腾出了待投位，队列头部可以继续交给库。
    this.pumpBacklog();
    this.ensureBacklogTimer();
  }

  private clearActive(): void {
    this.stopBacklogTimer();
    this.cancelBacklog();
    for (const runtime of [this.scroll, this.fixed]) runtime.manager.clear();
    this.settleAll();
    this.fixedLanes.reset(this.fixed.manager.trackCount);
  }

  /**
   * 尺寸或车道高变化后重建固定车道占用表。已上屏固定弹幕按新表重新落位，放不下即销毁；
   * 已预约但尚未 append 的条目同样重新分配，否则新占用表会把同一条车道再分给后一条，
   * 两条在 append 后叠放。滚动弹幕的轨道由库的 `format()` 处理，不在这里重排。
   */
  private syncLanes(): void {
    const records = Array.from(this.records.values());
    this.stopBacklogTimer();
    this.fixedLanes.reset(this.fixed.manager.trackCount);
    for (const record of records) {
      if (record.layer !== "fixed" || record.lane === null) continue;
      if (!this.records.has(record.comment.id)) continue;
      const lane = this.fixedLanes.allocate();
      if (lane === null) {
        record.lane = null;
        void record.danmaku.destroy();
        continue;
      }
      record.lane = lane;
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
    // 已上屏固定弹幕优先占位；在途预约（已受理、尚未 append）随后回填到新表。
    // 放不下时与已上屏条目一致：撤销这条预约，结算 detach，不让它继续占用失效车道。
    for (const [id, reservation] of Array.from(this.reservations)) {
      if (this.records.has(id)) continue;
      const lane = this.fixedLanes.allocate();
      if (lane === null) {
        this.reservations.delete(id);
        this.fixed.manager.each((danmaku) => {
          if (danmaku.data.id === id) void danmaku.destroy();
        });
        this.detach(id);
        continue;
      }
      reservation.lane = lane;
    }
    // 轨道数变化后，队列容量与每轮可投放数都要按新几何重算。
    this.trimBacklog();
    this.pumpBacklog();
    this.ensureBacklogTimer();
  }

  private ensureBacklogTimer(): void {
    if (this.destroyed || this.quiet || this.backlog.length === 0) return;
    if (this.backlogTimer !== 0) return;
    this.backlogTimer = window.setTimeout(() => this.runBacklogTimer(), BACKLOG_RETRY_MS);
  }

  private stopBacklogTimer(): void {
    if (this.backlogTimer === 0) return;
    window.clearTimeout(this.backlogTimer);
    this.backlogTimer = 0;
  }

  /** 队列轮询：冻结时 `pumpBacklog` 只按墙钟过期，不向库投放。 */
  private runBacklogTimer(): void {
    this.backlogTimer = 0;
    if (this.destroyed) return;
    this.pumpBacklog();
    this.ensureBacklogTimer();
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
    this.ensureBacklogTimer();
  }

  private unfreeze(): void {
    if (!this.frozen) return;
    this.frozen = false;
    this.scroll.manager.unfreeze();
    this.fixed.manager.unfreeze();
    this.ensureBacklogTimer();
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
  };

  private startClock(): void {
    if (this.frame !== 0 || this.destroyed || this.quiet || !this.media) return;
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
