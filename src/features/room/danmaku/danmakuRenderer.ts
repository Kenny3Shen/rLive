import Danmaku from "danmaku";
import type { DanmakuComment, DanmakuRendererOptions } from "./danmakuTypes";

/**
 * 私有字段集中在此处，锁定 danmaku 2.0.10。原生引擎负责唯一的 rAF、媒体事件、
 * 时间轴、轨道分配和 DOM 移动；应用仅补充公开 API 缺失的生命周期、单条冻结和移除。
 * 固定弹幕按时长分组，仍由原生媒体时间到期，绝不使用 CSS transition 或墙钟占位。
 */
type NativeComment = {
  mode: "rtl" | "top" | "bottom";
  time: number;
  _utc: number;
  render: () => HTMLElement;
  node?: HTMLElement;
  width: number;
  height: number;
  x: number;
  y: number;
};
type SpaceItem = { range: number; time: number; width: number; height: number };
type NativeEngine = {
  framing: (stage: HTMLElement) => void;
  setup: (stage: HTMLElement, comments: NativeComment[]) => void;
  render: (stage: HTMLElement, comment: NativeComment) => void;
  remove: (stage: HTMLElement, comment: NativeComment) => void;
  clear: (stage: HTMLElement) => void;
};
type NativeInstance = Danmaku & {
  comments: NativeComment[];
  _: {
    engine: NativeEngine;
    stage: HTMLElement;
    runningList: NativeComment[];
    position: number;
    duration: number;
    width: number;
    height: number;
    space: Record<NativeComment["mode"] | "ltr", SpaceItem[]>;
  };
};
type Group = {
  key: string;
  duration?: number;
  host: HTMLElement;
  native: NativeInstance;
  emptySpace: NativeInstance["_"]["space"];
  /** 最近一次有效尺寸；帧内只读缓存，避免在 transform 写入后强制布局。 */
  width: number;
  height: number;
  /** 仍在记录中的弹幕数，用于 O(1) 判断空组。 */
  count: number;
};
type RecordItem = {
  definition: DanmakuComment;
  group: Group;
  comment: NativeComment;
  element: HTMLElement;
  attached: boolean;
  pinned: boolean;
  /** 铉住时的媒体时间与墙钟，释放时顺延固定弹幕寿命。 */
  pinnedAt?: { media: number; wall: number };
};

const MAX_PENDING_PER_FRAME = 32;
const MAX_LIVE_PENDING = 160;
const MAX_ACTIVE = 800;
/** 常规固定弹幕 1 组 + 同屏至多 3 条 SC 各自的时长。 */
const MAX_FIXED_GROUPS = 4;
const DEFAULT_DURATION_MS = 15_000;
/** 容器尚无尺寸时的占位时长；原生 duration=0 会把所有待投弹幕判为过期。 */
const FALLBACK_DURATION_S = 8;
const clock = () => performance.now() / 1_000;
const positive = (value: number | undefined, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
const copySpace = (space: NativeInstance["_"]["space"]): NativeInstance["_"]["space"] => ({
  rtl: space.rtl.map((item) => ({ ...item })),
  ltr: space.ltr.map((item) => ({ ...item })),
  top: space.top.map((item) => ({ ...item })),
  bottom: space.bottom.map((item) => ({ ...item })),
});

function lowerBound(comments: NativeComment[], time: number): number {
  let lo = 0;
  let hi = comments.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (comments[mid]!.time < time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function applyStyle(element: HTMLElement, style: DanmakuComment["style"]) {
  for (const [key, value] of Object.entries(style ?? {})) {
    const property = key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
    if (value === undefined) element.style.removeProperty(property);
    else element.style.setProperty(property, String(value));
  }
}

export class DanmakuRenderer {
  readonly container: HTMLElement;
  private readonly media?: HTMLMediaElement;
  private readonly options: DanmakuRendererOptions;
  private readonly groups = new Map<string, Group>();
  private readonly records = new Map<string, RecordItem>();
  private readonly definitions = new WeakMap<NativeComment["render"], DanmakuComment>();
  private readonly observer?: ResizeObserver;
  private speed: number;
  private area: number;
  private destroyed = false;

  constructor(options: DanmakuRendererOptions) {
    this.options = options;
    this.container = options.container;
    this.media = options.media;
    this.speed = positive(options.speed, 100);
    this.area = this.normalizedArea(options.area ?? 1);
    this.container.dataset.danmakuRenderer = "weizhenye";
    if (typeof ResizeObserver !== "undefined") {
      this.observer = new ResizeObserver(() => this.resize());
      this.observer.observe(this.container);
    } else {
      window.addEventListener("resize", this.onResize);
    }
  }

  get size(): number {
    let size = 0;
    for (const record of this.records.values()) if (record.attached) size += 1;
    return size;
  }

  has(id: string): boolean {
    return this.records.get(id)?.attached === true;
  }

  emit(definition: DanmakuComment): void {
    if (this.destroyed || this.records.has(definition.id)) return;
    const group = this.groupFor(definition);
    const state = group.native._;
    // 未挂载消息必须有界；原生下一帧会按轨道饱和度进一步拒绝新消息。
    if (group.native.comments.length - state.position >= MAX_LIVE_PENDING) {
      this.options.onDetach?.(definition.id);
      return;
    }
    const native = this.toNative(definition);
    group.native.emit(native);
    group.native.show();
  }

  /** 替换未来时间轴，不清除/重投在途弹幕。每次 seek 仍由原生重新定位。 */
  setComments(comments: readonly DanmakuComment[]): void {
    if (this.destroyed) return;
    const grouped = new Map<Group, NativeComment[]>();
    const seen = new Set<string>();
    for (const definition of comments) {
      if (seen.has(definition.id)) continue;
      seen.add(definition.id);
      const group = this.groupFor(definition);
      let list = grouped.get(group);
      if (!list) grouped.set(group, list = []);
      list.push(this.toNative(definition));
      const record = this.records.get(definition.id);
      if (record) {
        // 仅更新样式：保留节点身份、菜单命中和原来的运动位置。
        for (const key of Object.keys(record.definition.style ?? {})) {
          if (!(key in (definition.style ?? {}))) {
            record.element.style.removeProperty(key.replace(/[A-Z]/g, (l) => `-${l.toLowerCase()}`));
          }
        }
        record.definition = definition;
        applyStyle(record.element, definition.style);
      }
    }
    const now = this.now();
    for (const group of this.groups.values()) {
      const list = grouped.get(group) ?? [];
      list.sort((a, b) => a.time - b.time);
      group.native.comments = list;
      group.native._.position = lowerBound(list, now);
    }
    this.refreshLayout();
  }

  remove(id: string): void {
    if (this.destroyed) return;
    for (const group of this.groups.values()) {
      const state = group.native._;
      let removedBefore = 0;
      group.native.comments = group.native.comments.filter((comment, index) => {
        if (this.definitions.get(comment.render)?.id !== id) return true;
        if (index < state.position) removedBefore++;
        return false;
      });
      state.position -= removedBefore;
      state.runningList = state.runningList.filter((comment) => this.definitions.get(comment.render)?.id !== id);
    }
    const record = this.records.get(id);
    if (record) {
      record.comment.node?.remove();
      this.detach(record);
    } else {
      this.options.onDetach?.(id);
    }
  }

  pin(id: string): boolean {
    const record = this.records.get(id);
    if (!record?.attached || this.destroyed) return false;
    if (record.pinned) return true;
    // 从原生运行列表暂时摘出，DOM 和最后一帧 transform 原封不动地保留。
    // 不能修改持久 comments 的 time，否则反向 seek 会重播错误时间。
    record.group.native._.runningList = record.group.native._.runningList.filter((c) => c !== record.comment);
    record.pinned = true;
    record.pinnedAt = { media: this.now(), wall: clock() };
    return true;
  }

  unpin(id: string): void {
    const record = this.records.get(id);
    if (!record?.pinned || this.destroyed) return;
    const comment = record.comment;
    if (comment.mode === "rtl") {
      this.rebase(record);
    } else if (record.pinnedAt) {
      // 固定弹幕铉住期间寿命暂停：顺延铉住时长，否则释放后会被原生立即判为到期。
      comment.time += Math.max(0, this.now() - record.pinnedAt.media);
      comment._utc += Math.max(0, clock() - record.pinnedAt.wall);
    }
    record.pinned = false;
    record.pinnedAt = undefined;
    record.group.native._.runningList.push(comment);
    // 不启动媒体、不手动 play 原生循环；暂停/缓冲期间继续保持静止。
  }

  clear(): void {
    if (this.destroyed) return;
    for (const group of Array.from(this.groups.values())) this.destroyGroup(group);
  }

  resize(): void {
    if (this.destroyed) return;
    for (const group of this.groups.values()) this.resizeGroup(group);
    // 新宽度/时长生效后，按在途弹幕当前像素位置反推起始时间，从同一位置以新速度继续。
    for (const record of this.records.values()) if (record.attached && !record.pinned) this.rebase(record);
    this.refreshLayout();
  }

  setSpeed(speed: number): void {
    const next = positive(speed, this.speed);
    if (next === this.speed) return;
    this.speed = next;
    this.resize();
  }

  setArea(area: number): void {
    const next = this.normalizedArea(area);
    if (next === this.area) return;
    this.area = next;
    this.resize();
  }

  /**
   * 重新测量在途弹幕。只对尺寸变化的弹幕重基：未变化时 x 是上一帧的位置，
   * 按当前媒体时间反推会让弹幕倒退一帧。
   */
  refreshLayout(): void {
    if (this.destroyed) return;
    for (const record of this.records.values()) {
      const node = record.comment.node;
      if (!node) continue;
      const width = node.offsetWidth;
      const height = node.offsetHeight;
      if (width === record.comment.width && height === record.comment.height) continue;
      if (!record.pinned) this.rebase(record);
      record.comment.width = width;
      record.comment.height = height;
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.observer?.disconnect();
    window.removeEventListener("resize", this.onResize);
    this.clear();
    this.destroyed = true;
    delete this.container.dataset.danmakuRenderer;
  }

  private readonly onResize = () => this.resize();
  private normalizedArea(area: number) {
    return Number.isFinite(area) ? Math.max(0.1, Math.min(1, area)) : 1;
  }
  private now() {
    return this.media ? this.media.currentTime : clock();
  }

  private toNative(definition: DanmakuComment): NativeComment {
    const render = () => {
      const element = definition.render?.() ?? document.createElement("span");
      if (!definition.render) element.textContent = definition.text;
      element.dataset.rliveDanmakuId = definition.id;
      applyStyle(element, definition.style);
      return element;
    };
    this.definitions.set(render, definition);
    return {
      mode: definition.mode === "scroll" ? "rtl" : definition.mode,
      time: Number.isFinite(definition.time) ? definition.time! : this.now(),
      _utc: clock(),
      render,
      width: 0, height: 0, x: 0, y: 0,
    };
  }

  /** 以当前容器尺寸更新一个原生实例，并缓存尺寸供帧内读取。 */
  private resizeGroup(group: Group): void {
    group.host.style.height = group.duration ? "100%" : `${this.area * 100}%`;
    const width = group.host.offsetWidth;
    const height = group.host.offsetHeight;
    group.width = width;
    group.height = height;
    // 隐藏/折叠时保留上次的原生尺寸：duration=0 会让在途弹幕位置变成 NaN、待投弹幕全部跳过。
    // 此时 setup 会拒绝新弹幕，恢复尺寸后 ResizeObserver 再走一次这里。
    if (width <= 0 || height <= 0) return;
    group.native.resize();
    group.native.speed = group.duration ? width / group.duration : this.speed;
    // 原生 allocate 在恰好一行高时会对 0 取模；只为分配加极小余量，真实边界仍做准入检查。
    group.native._.height = height + 0.01;
  }

  private groupFor(definition: DanmakuComment): Group {
    let duration = definition.mode === "scroll" ? undefined : positive(definition.duration, DEFAULT_DURATION_MS) / 1_000;
    if (duration !== undefined && !this.groups.has(`fixed:${duration}`)) {
      // SC 时长随价位变化；固定层原生实例有上限，超出时并入不短于自身时长的最接近一组，
      // 避免并入更短的组被提前判为到期（直播 SC 另有按自身时长移除的计时器）。
      const fixed = Array.from(this.groups.values()).filter((group) => group.duration !== undefined);
      if (fixed.length >= MAX_FIXED_GROUPS) {
        const target = duration;
        const longer = fixed.filter((group) => group.duration! >= target);
        const candidates = longer.length > 0 ? longer : fixed;
        duration = candidates.reduce((best, group) =>
          Math.abs(group.duration! - target) < Math.abs(best.duration! - target) ? group : best,
        ).duration;
      }
    }
    const key = duration === undefined ? "scroll" : `fixed:${duration}`;
    const existing = this.groups.get(key);
    if (existing) return existing;
    const host = document.createElement("div");
    host.style.cssText = `position:absolute;top:0;left:0;width:100%;height:${duration ? 100 : this.area * 100}%;pointer-events:none;overflow:hidden`;
    host.dataset.danmakuGroup = key;
    this.container.appendChild(host);
    const native = new Danmaku({
      container: host, media: this.media, engine: "dom",
      speed: duration ? Math.max(1, host.offsetWidth) / duration : this.speed,
    }) as NativeInstance;
    // 构造时原生可能已经捕获引擎回调，先停下，再以实例级钩子启动。
    native.hide();
    const group: Group = {
      key, duration, host, native, emptySpace: copySpace(native._.space), width: 0, height: 0, count: 0,
    };
    this.groups.set(key, group);
    this.installLifecycle(group);
    this.resizeGroup(group);
    if (group.width <= 0) native._.duration = duration ?? FALLBACK_DURATION_S;
    if (this.media) native.show();
    return group;
  }

  private installLifecycle(group: Group): void {
    const native = group.native;
    const original = native._.engine;
    // 引擎对象在库内是全局共享的，必须每实例复制，避免另一个播放器被打补丁。
    native._.engine = {
      ...original,
      framing: (stage) => {
        original.framing.call(native, stage);
        // 原生直播 emit 会不断追加已消费的 comments，及时释放前缀而不另建调度器。
        if (!this.media && native._.position > 0) {
          native.comments.splice(0, native._.position);
          native._.position = 0;
        }
      },
      setup: (stage, pending) => {
        const selected: NativeComment[] = [];
        const seen = new Set<string>();
        for (const scheduled of pending) {
          const definition = this.definitions.get(scheduled.render);
          if (!definition || this.records.has(definition.id) || seen.has(definition.id)) continue;
          seen.add(definition.id);
          if (selected.length >= MAX_PENDING_PER_FRAME || this.records.size + selected.length >= MAX_ACTIVE ||
              group.width <= 0 || group.height <= 0) {
            this.options.onDetach?.(definition.id);
            continue;
          }
          // 运行副本与原始时间轴分离，pin/unpin/resize 重基不污染下次 seek。
          // 节点在这里建好并先设 flex（避免 inline-flex 内容多出 baseline 行盒），
          // 原生 setup 再一次性插入 fragment 并统一测量：整批只触发一次布局。
          // 原生每帧写 transform 而非 CSS 动画，浏览器不会自动提升图层；不加 will-change 时
          // 整个舞台每帧重绘光栅（实测 Raster 约 200ms/s），加上后只走合成。
          const node = document.createElement("div");
          node.style.cssText = "position:absolute;display:flex;will-change:transform;";
          node.appendChild(scheduled.render());
          selected.push({ ...scheduled, node, width: 0, height: 0 });
        }
        pending.splice(0, pending.length, ...selected);
        original.setup.call(native, stage, pending);
        for (let i = pending.length - 1; i >= 0; i--) {
          const comment = pending[i]!;
          const definition = this.definitions.get(comment.render)!;
          if (!comment.node || comment.height > group.height + 0.5) {
            comment.node?.remove();
            pending.splice(i, 1);
            this.options.onDetach?.(definition.id);
            continue;
          }
          const element = comment.node.firstElementChild as HTMLElement;
          this.records.set(definition.id, { definition, group, comment, element, attached: false, pinned: false });
          group.count += 1;
        }
      },
      render: (stage, comment) => {
        const definition = this.definitions.get(comment.render);
        const record = definition && this.records.get(definition.id);
        if (!record) return;
        if (this.media && comment.mode === "rtl") {
          // 2.0.10 的 _utc 插值在重新播放/迟到投放时会重复乘倍率，且不监听 ratechange。
          // 在同一原生帧内按媒体时间计算原生公式，保持暂停、等待和倍速只有一个时间基准。
          comment.x = native._.width - (native._.width + comment.width) *
            (this.media.currentTime - comment.time) / native._.duration;
        }
        if (!record.attached && !this.canAttach(record)) {
          comment.node?.remove();
          this.detach(record);
          // 引擎仍在遍历 runningList，不在钩子中 splice；下一帧原生到期删除这个无 DOM 条目。
          comment.time = -Number.MAX_SAFE_INTEGER;
          comment._utc = -Number.MAX_SAFE_INTEGER;
          return;
        }
        original.render.call(native, stage, comment);
        if (!record.attached) {
          record.attached = true;
          this.options.onAttach?.(record.definition, record.element);
        }
      },
      remove: (_stage, comment) => {
        // 被准入拒绝的节点可能已脱离 stage，不能再调用无条件 removeChild 的原实现。
        comment.node?.remove();
        const id = this.definitions.get(comment.render)?.id;
        const record = id && this.records.get(id);
        if (record && record.comment === comment) this.detach(record);
      },
      clear: (stage) => {
        original.clear.call(native, stage);
        for (const record of Array.from(this.records.values())) {
          if (record.group === group) this.detach(record);
        }
        native._.space = copySpace(group.emptySpace);
      },
    };
  }

  private canAttach(record: RecordItem): boolean {
    const current = record.comment;
    const height = record.group.height;
    if (!Number.isFinite(current.x) || !Number.isFinite(current.y) ||
        current.y < 0 || current.y + current.height > height + 0.5) return false;
    const scroll = current.mode === "rtl";
    for (const other of this.records.values()) {
      if (other === record || !other.attached || (other.comment.mode === "rtl") !== scroll) continue;
      const previous = other.comment;
      if (current.y >= previous.y + previous.height || previous.y >= current.y + current.height) continue;
      if (!scroll) return false;
      const gap = current.x - previous.x - previous.width;
      if (gap < 2) return false;
      // 补充原生 modulo 饱和回绕和冻结时的碰撞保护：只拒绝新弹幕，不提前移除旧弹幕。
      const oldSpeed = other.pinned ? 0 : (other.group.native._.width + previous.width) / other.group.native._.duration;
      const newSpeed = (record.group.native._.width + current.width) / record.group.native._.duration;
      if (oldSpeed === 0 || (newSpeed > oldSpeed &&
          gap / (newSpeed - oldSpeed) < (previous.x + previous.width) / oldSpeed)) return false;
    }
    return true;
  }

  private rebase(record: RecordItem): void {
    const comment = record.comment;
    const state = record.group.native._;
    if (comment.mode !== "rtl") return;
    const elapsed = (state.width - comment.x) / Math.max(1, state.width + comment.width) * state.duration;
    comment.time = this.now() - elapsed;
    comment._utc = clock() - elapsed;
  }

  private detach(record: RecordItem): void {
    const id = record.definition.id;
    if (this.records.get(id) !== record) return;
    this.records.delete(id);
    record.group.count -= 1;
    this.options.onDetach?.(id);
    if (!this.media && record.group.count === 0) {
      // 直播空闲时销毁空组以停掉原生 rAF；必须等原生 frame 完成，否则它会在 destroy 后重新安排下一帧。
      queueMicrotask(() => {
        const group = record.group;
        if (this.destroyed || this.groups.get(group.key) !== group || group.count > 0) return;
        if (group.native.comments.length > group.native._.position) return;
        this.destroyGroup(group);
      });
    }
  }

  private destroyGroup(group: Group): void {
    this.groups.delete(group.key);
    group.native.destroy();
    // 原生 destroy 经 clear 调用我们的清理钩子，包含从 runningList 摘出的钉住 DOM。
    for (const record of Array.from(this.records.values())) if (record.group === group) this.detach(record);
    group.host.remove();
  }
}
