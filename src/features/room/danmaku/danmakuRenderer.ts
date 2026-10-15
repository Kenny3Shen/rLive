import { create, type Danmaku, type Manager } from "danmu";
import type { DanmakuCollisionMode } from "@/shared/types/live";
import { danmakuMaxActiveComments } from "./danmakuAdapter";
import type { DanmakuComment, DanmakuRendererOptions } from "./danmakuTypes";

/**
 * 基于 `danmu` 的 DOM 弹幕引擎。运动由每条弹幕自己的 CSS transition 在合成器上推进，
 * 主线程只负责投放、准入与生命周期，不再逐帧写 transform。
 *
 * 两层管理器：滚动层限制在用户设置的显示区域内，固定层占满整个舞台，与旧实现的分层一致。
 * `danmu` 不绑定媒体，因此 VOD 由本文件按媒体事件推进投放与暂停/倍速，直播按墙钟直接投放。
 * 固定弹幕（top/bottom，含 SC 与自己的弹幕）和占两条车道的大表情走 flexible danmaku，
 * 由本文件的 `LanePool` 按车道摆位；普通滚动弹幕交给 `danmu` 的轨道调度与碰撞预测。
 * 大表情不经过库的轨道准入，进入前由 `pushWide` 按同一判据等车道内普通弹幕尾部进屏。
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
  /** 占用的车道下标；空数组表示由 `danmu` 轨道自行调度。 */
  lanes: number[];
  /** 是否锁住了对应轨道（大表情让同层普通弹幕避开占用车道）。 */
  locked: boolean;
};

/** 投放前登记的车道占用：`pushFlexibleDanmaku` 不返回实例，靠 comment id 在钩子里认领。 */
type Reservation = {
  layer: Layer;
  lanes: number[];
  locked: boolean;
};

/** 已锁住车道、等待车道内普通弹幕尾部进屏的大表情。 */
type PendingWide = {
  comment: DanmakuComment;
  reservation: Reservation;
  timer: number;
};

/** 车道里一条普通弹幕的运动快照，用于估算它的尾部还要多久完全进屏。 */
export type LaneOccupant = {
  paused: boolean;
  moving: boolean;
  /** 弹幕宽度（px）。 */
  width: number;
  /** 已移动距离（px），从左缘贴住舞台右边缘时为 0。 */
  distance: number;
  /** 当前速度（px/ms），已含倍速。 */
  speed: number;
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
 * `danmu` 的 `speed` 单位是 px/毫秒，而业务设置（与旧引擎）用 px/秒，
 * 两者差 1000 倍；漏了这一步会让每条弹幕在数毫秒内跑完并消失。
 */
const SPEED_UNIT_SCALE = 1 / 1_000;
/** 大表情等车道时的重新检查间隔：车道内弹幕尚未起步、暂停或冻结时无法估算剩余时间。 */
const WIDE_RETRY_MS = 100;
/** 大表情最多等待车道这么久，超出即丢弃，与直播待投放队列的过期时间一致。 */
const WIDE_MAX_WAIT_MS = 5_000;

/**
 * 车道内所有普通弹幕尾部完全进屏（再留出 `gap`）还需的毫秒数，0 表示可立即进入。
 * 与 `danmu` 的轨道准入（`_getTrack`）同一判据：钉住（暂停）的弹幕不阻挡后来者；
 * 尚未起步或速度未知时返回重试间隔，由调用方稍后重新估算。
 * 普通弹幕与大表情速度相同，尾部进屏后便不会再被追上。
 */
export function laneEntryWaitMs(occupants: Iterable<LaneOccupant>, gap = 0): number {
  let wait = 0;
  for (const occupant of occupants) {
    if (occupant.paused) continue;
    if (!occupant.moving || occupant.width <= 0) return WIDE_RETRY_MS;
    const remaining = occupant.width + gap - occupant.distance;
    if (remaining <= 0) continue;
    if (!(occupant.speed > 0) || !Number.isFinite(occupant.speed)) return WIDE_RETRY_MS;
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

function cssPropertyName(name: string): string {
  if (name.startsWith("--")) return name;
  return name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function applyStyle(element: HTMLElement, style: DanmakuComment["style"]): void {
  if (!style || typeof style !== "object") return;
  for (const [name, value] of Object.entries(style)) {
    if (value === undefined) continue;
    element.style.setProperty(cssPropertyName(name), String(value));
  }
}

/** 时间轴里被替换掉的定义要清掉自己引入的样式，否则旧字号/描边会留在节点上。 */
function clearStyleKeys(element: HTMLElement, style: DanmakuComment["style"]): void {
  if (!style || typeof style !== "object") return;
  for (const name of Object.keys(style)) element.style.removeProperty(cssPropertyName(name));
}

/**
 * 车道占用表，用于 `danmu` 轨道无法表达的几何：固定弹幕（不参与轨道调度）
 * 与占多条车道的大表情滚动弹幕。
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

  /** 所有能放下 `span` 条连续空闲车道的起点，自顶向下。 */
  freeStarts(span: number): number[] {
    const need = Math.max(1, Math.floor(span));
    const starts: number[] = [];
    let run = 0;
    for (let lane = 0; lane < this.used.length; lane += 1) {
      run = this.used[lane] ? 0 : run + 1;
      if (run >= need) starts.push(lane - need + 1);
    }
    return starts;
  }

  /** 尝试占用一段指定车道；已被占用或越界时返回 false。 */
  reserveRange(start: number, span: number): boolean {
    if (start < 0 || start + span > this.used.length) return false;
    for (let lane = start; lane < start + span; lane += 1) if (this.used[lane]) return false;
    for (let lane = start; lane < start + span; lane += 1) this.used[lane] = true;
    return true;
  }

  release(index: number): void {
    if (index >= 0 && index < this.used.length) this.used[index] = false;
  }
}

function fallbackElement(comment: DanmakuComment): HTMLElement {
  const element = document.createElement("span");
  element.textContent = comment.text;
  element.dataset.rliveDanmakuId = comment.id;
  applyStyle(element, comment.style);
  return element;
}

export class DanmakuRenderer {
  readonly container: HTMLElement;
  private readonly media?: HTMLMediaElement;
  private readonly options: DanmakuRendererOptions;
  private readonly scroll: LayerRuntime;
  private readonly fixed: LayerRuntime;
  private readonly records = new Map<string, RecordItem>();
  private readonly reservations = new Map<string, Reservation>();
  /** 已受理、锁住车道但尚未投放的大表情，见 `pushWide`。 */
  private readonly pendingWide = new Map<string, PendingWide>();
  /**
   * 已受理但尚未回调 `onDetach` 的 id。调用方按「每条受理的弹幕恰好一次 detach」
   * 记账（活动预算、记录表都靠它回收），因此被库丢弃、被移除、被清屏的条目都要在这里结算。
   */
  private readonly live = new Set<string>();
  /** 在屏滚动弹幕的 id 集合：唯一准入判据的计数来源，随 `detach` 回收。 */
  private readonly scrollLive = new Set<string>();
  private readonly observer?: ResizeObserver;
  /** VOD 时间轴与游标；直播不走这里，`emit` 直接投放。 */
  private timeline: DanmakuComment[] = [];
  private timelineIds = new Set<string>();
  private cursor = 0;
  private speed: number;
  private area: number;
  private laneHeight: number;
  private collisionMode: DanmakuCollisionMode;
  private lastMediaTime = 0;
  private frozen = false;
  private frame = 0;
  private renderQueued = false;
  private destroyed = false;

  constructor(options: DanmakuRendererOptions) {
    this.options = options;
    this.container = options.container;
    this.media = options.media;
    this.speed = positive(options.speed, 100);
    this.area = clampArea(options.area);
    this.laneHeight = Math.max(1, Math.round(positive(options.laneHeight, 24)));
    this.collisionMode = options.collisionMode ?? "strict";
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
      clearStyleKeys(record.element, record.comment.style);
      applyStyle(record.element, next.style);
      record.comment = next;
    }
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

  /**
   * 切换碰撞检测算法。在屏预算（`scrollCapacity`）与算法无关，始终生效：
   * 它是应用侧的密度上限，不是碰撞策略的一部分。
   */
  setCollisionMode(mode: DanmakuCollisionMode): void {
    if (this.destroyed || mode === this.collisionMode) return;
    this.collisionMode = mode;
    for (const runtime of [this.scroll, this.fixed]) {
      runtime.manager.updateOptions({
        mode,
        // `none` 与 `order` 组合会把每条弹幕都放在第一条轨道上，见 `createLayer`。
        distribution: mode === "none" ? "random" : "order",
      });
    }
    this.scheduleRender();
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
  }

  /** 字号变化同时改变车道高：轨道与车道占用表一起重建。 */
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
      mode: this.collisionMode,
      // `none` 与 `order` 组合会把每条弹幕都放在第一条轨道上（`getTrackIdx` 恒返回 0），
      // 与「不检测碰撞」的语义相反，因此关闭检测时改用随机分布。
      distribution: this.collisionMode === "none" ? "random" : "order",
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

  private reserve(layer: Layer, span: number, locked: boolean): Reservation | null {
    const lane = this.runtimeOf(layer).lanes.allocate(span);
    if (lane === null) return null;
    return this.lockLanes(layer, lane, span, locked);
  }

  private reserveRange(
    layer: Layer,
    start: number,
    span: number,
    locked: boolean,
  ): Reservation | null {
    if (!this.runtimeOf(layer).lanes.reserveRange(start, span)) return null;
    return this.lockLanes(layer, start, span, locked);
  }

  /** 车道已在占用表中登记，按需锁住对应轨道。 */
  private lockLanes(layer: Layer, start: number, span: number, locked: boolean): Reservation {
    const runtime = this.runtimeOf(layer);
    const lanes = Array.from({ length: span }, (_, index) => start + index);
    if (locked) {
      for (const index of lanes) {
        if (index < runtime.manager.trackCount) runtime.manager.getTrack(index)?.lock();
      }
    }
    return { layer, lanes, locked };
  }

  private unlock(reservation: Reservation): void {
    if (!reservation.locked) return;
    const manager = this.runtimeOf(reservation.layer).manager;
    for (const lane of reservation.lanes) {
      if (lane < manager.trackCount) manager.getTrack(lane)?.unlock();
    }
  }

  private releaseLanes(reservation: Reservation): void {
    const runtime = this.runtimeOf(reservation.layer);
    for (const lane of reservation.lanes) runtime.lanes.release(lane);
    this.unlock(reservation);
  }

  /**
   * 投放一条弹幕；被库拒绝（待投放已满、未在播放）时立即结算 detach。
   * 返回是否已受理。
   */
  private push(comment: DanmakuComment): boolean {
    if (this.live.has(comment.id)) return false;
    const span = Math.max(1, Math.floor(comment.lanes ?? 1));
    if (comment.mode !== "scroll") return this.pushFixed(comment, span);
    if (this.scrollLive.size >= this.scrollCapacity()) {
      this.options.onDetach?.(comment.id);
      return false;
    }
    if (span > 1) return this.pushWide(comment, span);
    if (!this.scroll.manager.push(comment)) {
      this.options.onDetach?.(comment.id);
      return false;
    }
    this.live.add(comment.id);
    this.scrollLive.add(comment.id);
    return true;
  }

  /**
   * 在屏滚动弹幕上限。滚动层容器本身已按用户设置裁到显示区域，因此这里 `area = 1`；
   * 公式与直播层的批次准入（`danmakuMaxActiveComments`）共用，两处判据不会漂移。
   * 库在 `strict` 下只会排队、不会丢弃，超出的新弹幕必须在这里丢掉，
   * 才能保持与旧引擎车道准入一致的密度。
   */
  private scrollCapacity(): number {
    return danmakuMaxActiveComments(this.scroll.manager.container.height, this.laneHeight, 1);
  }

  /** 固定弹幕：不参与轨道调度，由本文件按车道摆位，`direction: none` 静止到期。 */
  private pushFixed(comment: DanmakuComment, span: number): boolean {
    const reservation = this.reserve("fixed", span, false);
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
   * 大表情滚动弹幕：占多条车道，用 flexible danmaku 按车道摆位并锁住对应轨道，
   * 让同层普通弹幕不再落进被占用的车道。速度与普通滚动弹幕一致。
   *
   * 锁轨只拦住后来者，拦不住车道里已在途的普通弹幕：它们刚进屏时尾部还在舞台外，
   * 大表情从右边缘直接起步就会与之重叠。因此选等待最短的一段车道，先锁住（停止新弹幕进入），
   * 等其中普通弹幕尾部全部进屏再投放；同速运动下此后不会再追上。
   */
  private pushWide(comment: DanmakuComment, span: number): boolean {
    const choice = this.pickWideLanes(span);
    if (!choice) {
      this.options.onDetach?.(comment.id);
      return false;
    }
    const reservation = this.reserveRange("scroll", choice.start, span, true);
    if (!reservation) {
      this.options.onDetach?.(comment.id);
      return false;
    }
    this.live.add(comment.id);
    this.scrollLive.add(comment.id);
    if (choice.wait <= 0) {
      this.launchWide(comment, reservation);
      return true;
    }
    this.pendingWide.set(comment.id, {
      comment,
      reservation,
      timer: window.setTimeout(() => this.retryWide(comment.id), choice.wait),
    });
    return true;
  }

  /** 在所有空闲车道段中选进入等待最短的一段；等待都超过上限时返回 null。 */
  private pickWideLanes(span: number): { start: number; wait: number } | null {
    let best: { start: number; wait: number } | null = null;
    for (const start of this.scroll.lanes.freeStarts(span)) {
      const wait = this.wideEntryWait(start, span);
      if (wait <= 0) return { start, wait: 0 };
      if (!best || wait < best.wait) best = { start, wait };
    }
    return best && best.wait <= WIDE_MAX_WAIT_MS ? best : null;
  }

  /** 一段车道内普通弹幕全部尾部进屏还需的毫秒数；关闭碰撞检测时不等待。 */
  private wideEntryWait(start: number, span: number): number {
    if (this.collisionMode === "none") return 0;
    const manager = this.scroll.manager;
    const gap = typeof manager.options.gap === "number" ? manager.options.gap : 0;
    const occupants: LaneOccupant[] = [];
    for (let lane = start; lane < start + span; lane += 1) {
      if (lane >= manager.trackCount) continue;
      manager.getTrack(lane)?.each((danmaku) => {
        occupants.push({
          paused: danmaku.paused,
          moving: danmaku.moving,
          width: danmaku.getWidth(),
          distance: danmaku._getMoveDistance(),
          speed: danmaku._getSpeed(),
        });
      });
    }
    return laneEntryWaitMs(occupants, gap);
  }

  private retryWide(id: string): void {
    const pending = this.pendingWide.get(id);
    if (!pending || this.destroyed) return;
    const { reservation } = pending;
    // 冻结（VOD 暂停、缓冲）时车道内弹幕不动，等待估算失效，只能稍后重查。
    const wait = this.frozen
      ? WIDE_RETRY_MS
      : this.wideEntryWait(reservation.lanes[0]!, reservation.lanes.length);
    if (wait > 0) {
      pending.timer = window.setTimeout(() => this.retryWide(id), wait);
      return;
    }
    this.pendingWide.delete(id);
    this.launchWide(pending.comment, reservation);
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
      this.releaseLanes(reservation);
      this.detach(comment.id);
      return;
    }
    this.reservations.set(comment.id, reservation);
  }

  /** 取消所有等待中的大表情：解锁、归还车道并结算 detach。 */
  private cancelPendingWide(): void {
    const entries = Array.from(this.pendingWide.values());
    this.pendingWide.clear();
    for (const pending of entries) {
      window.clearTimeout(pending.timer);
      this.releaseLanes(pending.reservation);
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
    this.scrollLive.delete(id);
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
    const comment = danmaku.data;
    const element = comment.render ? comment.render() : fallbackElement(comment);
    danmaku.node?.appendChild(element);
  }

  private onAppendNode(danmaku: Danmaku<DanmakuComment>): void {
    const comment = danmaku.data;
    const element = danmaku.node?.firstElementChild;
    if (!(element instanceof HTMLElement)) return;
    const reservation = this.reservations.get(comment.id);
    this.reservations.delete(comment.id);
    this.records.set(comment.id, {
      comment,
      danmaku,
      element,
      layer: reservation?.layer ?? this.layerOf(comment),
      lanes: reservation?.lanes ?? [],
      locked: reservation?.locked ?? false,
    });
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
      this.releaseLanes(reservation);
    }
    const record = this.records.get(comment.id);
    if (record) {
      this.records.delete(comment.id);
      // 固定弹幕（`locked: false`）同样占用车道，必须一并归还，否则固定层很快无车道可用。
      if (record.lanes.length > 0) {
        this.releaseLanes({ layer: record.layer, lanes: record.lanes, locked: record.locked });
      }
    }
    this.detach(comment.id);
  }

  private clearActive(): void {
    // 轨道锁是 Track 对象上的状态，`manager.clear()` 不会重置它；先解锁再清屏，
    // 否则被大表情锁住的轨道会永久拒绝普通滚动弹幕。
    for (const record of this.records.values()) {
      if (record.locked) this.unlock({ layer: record.layer, lanes: record.lanes, locked: true });
    }
    this.cancelPendingWide();
    for (const runtime of [this.scroll, this.fixed]) runtime.manager.clear();
    this.settleAll();
    for (const runtime of [this.scroll, this.fixed])
      runtime.lanes.reset(runtime.manager.trackCount);
  }

  /**
   * 尺寸或车道高变化后重建占用表。大表情必须留在原车道（滚动中的 y 已随 transition 推进，
   * 改车道就会跳位），因此先按原车道重占，占不到再丢弃；固定弹幕随后按新几何重新落位。
   */
  private syncLanes(): void {
    const records = Array.from(this.records.values());
    for (const record of records) {
      if (record.locked) this.unlock({ layer: record.layer, lanes: record.lanes, locked: true });
    }
    for (const pending of this.pendingWide.values()) this.unlock(pending.reservation);
    for (const runtime of [this.scroll, this.fixed])
      runtime.lanes.reset(runtime.manager.trackCount);
    for (const record of records) {
      if (!record.locked) continue;
      const runtime = this.runtimeOf(record.layer);
      const start = record.lanes[0]!;
      const span = record.lanes.length;
      if (!runtime.lanes.reserveRange(start, span)) {
        record.lanes = [];
        void record.danmaku.destroy();
        continue;
      }
      for (const lane of record.lanes) {
        if (lane < runtime.manager.trackCount) runtime.manager.getTrack(lane)?.lock();
      }
    }
    // 等待中的大表情尚未起步，原车道占不到就丢弃；它的车道锁同样要按新轨道重建。
    for (const [id, pending] of Array.from(this.pendingWide)) {
      const { reservation } = pending;
      const reserved = this.reserveRange(
        reservation.layer,
        reservation.lanes[0]!,
        reservation.lanes.length,
        true,
      );
      if (reserved) {
        pending.reservation = reserved;
        continue;
      }
      this.pendingWide.delete(id);
      window.clearTimeout(pending.timer);
      this.detach(id);
    }
    for (const record of records) {
      if (record.locked || record.lanes.length === 0 || !this.records.has(record.comment.id))
        continue;
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
  }

  private unfreeze(): void {
    if (!this.frozen) return;
    this.frozen = false;
    this.scroll.manager.unfreeze();
    this.fixed.manager.unfreeze();
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
