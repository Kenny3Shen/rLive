import { afterEach, expect, test } from "bun:test";
import type { Danmaku } from "danmu";
import {
  DanmakuRenderer,
  LanePool,
  type LaneMotion,
} from "../src/features/room/danmaku/danmakuRenderer";
import type { DanmakuComment } from "../src/features/room/danmaku/danmakuTypes";

type Reservation = {
  layer: "scroll" | "fixed";
  lanes: number[];
  locked: boolean;
  deadline?: number;
};

type PendingWide = {
  comment: DanmakuComment;
  reservation: Reservation | null;
  deadline: number;
};

type TestDanmaku = Danmaku<DanmakuComment> & {
  data: DanmakuComment;
  type: "facile" | "flexible";
  paused: boolean;
  moving: boolean;
  rate: number;
  position: { x: number; y: number };
  setLeft(left: number): void;
  setY(y: number): void;
  _getMoveDistance(): number;
  _getMovePercent(): number;
  getWidth(): number;
  getHeight(): number;
  _getSpeed(): number;
};

type TestRecord = {
  comment: DanmakuComment;
  danmaku: TestDanmaku;
  element: HTMLElement;
  layer: "scroll" | "fixed";
  lanes: number[];
  locked: boolean;
};

type FakeTrack = {
  list: TestDanmaku[];
  isLock: boolean;
  each(fn: (danmaku: TestDanmaku) => unknown): void;
  lock(): void;
  unlock(): void;
  clear(): void;
};

type FakeManager = {
  options: { speed: number; rate: number; gap: number };
  container: { width: number; height: number };
  readonly trackCount: number;
  setTrackCount(count: number): void;
  getTrack(index: number): FakeTrack;
  pushFlexibleDanmaku(comment: DanmakuComment, options: unknown): boolean;
  each(fn: (danmaku: TestDanmaku) => unknown): void;
  setRate(rate: number): void;
  len(): { stash: number };
  clear(): void;
  stopPlaying(): void;
  unmount(): void;
  format(): void;
  render(): void;
  setSpeed(speed: number): void;
  setTrackHeight(height: number): void;
  pushes: Array<{ comment: DanmakuComment; options: unknown }>;
  starting: TestDanmaku[];
};

type TestRenderer = {
  container: { dataset: Record<string, string> };
  options: { onDetach?: (id: string) => void };
  scroll: { manager: FakeManager; lanes: LanePool };
  fixed: { manager: FakeManager; lanes: LanePool };
  media?: undefined;
  observer?: undefined;
  records: Map<string, TestRecord>;
  reservations: Map<string, Reservation>;
  pendingWide: Map<string, PendingWide>;
  ordinarySpeeds: Map<string, { speed: number }>;
  scrollLocked: Set<number>;
  live: Set<string>;
  timeline: DanmakuComment[];
  timelineIds: Set<string>;
  cursor: number;
  speed: number;
  area: number;
  laneHeight: number;
  lastMediaTime: number;
  frozen: boolean;
  frame: number;
  wideTimer: number;
  runWideScheduler: () => void;
  onResize: () => void;
  renderQueued: boolean;
  destroyed: boolean;
  expirePendingWide(): void;
  expireStartingWide(): void;
  advancePendingWide(): void;
  recomputeScrollLocks(): void;
  scrollOccupants(start: number, span: number, selfId: string): LaneMotion[];
  tryLaunchWide(pending: PendingWide, span: number): void;
  ordinaryEntrySpeed(): number;
  ensureWideScheduler(): void;
  stopWideScheduler(): void;
  unlockScrollTracks(): void;
  clearActive(): void;
  clear(): void;
  destroy(): void;
  syncLanes(): void;
  pushFixed(comment: DanmakuComment, span: number): boolean;
  coveredScrollLanes(danmaku: TestDanmaku): number[];
  onDestroyed(danmaku: TestDanmaku): void;
};

type FakeTimer = { callback: () => void; delay: number };

const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
let timers = new Map<number, FakeTimer>();
let nextTimerId = 1;

function installWindow(): void {
  timers = new Map();
  nextTimerId = 1;
  const fakeWindow = {
    setTimeout(callback: TimerHandler, delay = 0): number {
      const id = nextTimerId++;
      timers.set(id, { callback: callback as () => void, delay });
      return id;
    },
    clearTimeout(id?: number): void {
      if (id !== undefined) timers.delete(id);
    },
    addEventListener(): void {},
    removeEventListener(): void {},
  };
  Object.defineProperty(globalThis, "window", { configurable: true, value: fakeWindow });
}

afterEach(() => {
  timers.clear();
  if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
  else Reflect.deleteProperty(globalThis, "window");
});

function danmakuComment(id: string, lanes: number): DanmakuComment {
  return {
    id,
    text: id,
    mode: "scroll",
    lanes,
    render: () => {
      throw new Error("调度测试不创建 DOM");
    },
  };
}

function wideComment(id: string): DanmakuComment {
  return danmakuComment(id, 2);
}

function fixedComment(id: string, mode: DanmakuComment["mode"] = "top", lanes = 1): DanmakuComment {
  return {
    id,
    text: id,
    mode,
    lanes,
    render: () => {
      throw new Error("车道测试不创建 DOM");
    },
  };
}

function makeTrack(): FakeTrack {
  return {
    list: [],
    isLock: false,
    each(fn) {
      for (const danmaku of Array.from(this.list)) fn(danmaku);
    },
    lock() {
      this.isLock = true;
    },
    unlock() {
      this.isLock = false;
    },
    clear() {
      this.list.length = 0;
    },
  };
}

function makeLanePool(): LanePool {
  return new LanePool();
}

function makeManager(trackCount: number): FakeManager {
  const tracks = Array.from({ length: trackCount }, makeTrack);
  const manager: FakeManager = {
    options: { speed: 0.1, rate: 1, gap: 0 },
    container: { width: 1_000, height: 200 },
    get trackCount() {
      return tracks.length;
    },
    setTrackCount(count) {
      while (tracks.length > count) tracks.pop();
      while (tracks.length < count) tracks.push(makeTrack());
    },
    getTrack(index) {
      return tracks[index]!;
    },
    pushFlexibleDanmaku(comment, options) {
      manager.pushes.push({ comment, options });
      return true;
    },
    each(fn) {
      for (const danmaku of Array.from(manager.starting)) fn(danmaku);
    },
    len() {
      return { stash: 0 };
    },
    clear() {
      for (const track of tracks) track.clear();
    },
    stopPlaying() {},
    unmount() {},
    format() {},
    render() {},
    setSpeed(speed) {
      manager.options.speed = speed;
    },
    setRate(rate) {
      manager.options.rate = rate;
    },
    setTrackHeight() {},
    pushes: [],
    starting: [],
  };
  return manager;
}

function makeDanmaku(
  id: string,
  patch: {
    type?: "facile" | "flexible";
    lanes?: number;
    left?: number;
    y?: number;
    width?: number;
    height?: number;
    speed?: number;
    rate?: number;
    moving?: boolean;
    paused?: boolean;
  } = {},
): TestDanmaku {
  const state = {
    left: patch.left ?? 800,
    y: patch.y ?? 0,
    width: patch.width ?? 200,
    height: patch.height ?? 40,
    speed: patch.speed ?? 0.1,
  };
  const type = patch.type ?? "flexible";
  const danmaku = {
    data: danmakuComment(id, patch.lanes ?? (type === "facile" ? 1 : 2)),
    type,
    paused: patch.paused ?? false,
    moving: patch.moving ?? true,
    rate: patch.rate ?? 1,
    position: { x: state.left, y: state.y },
    setLeft(left: number) {
      state.left = left;
      this.position.x = left;
    },
    setY(y: number) {
      state.y = y;
      this.position.y = y;
    },
    _getMoveDistance: () => (type === "facile" ? 1_000 - state.left : state.left),
    _getMovePercent: () => state.left / 1_000,
    getWidth: () => state.width,
    getHeight: () => state.height,
    _getSpeed: () => state.speed,
  };
  return danmaku as unknown as TestDanmaku;
}

function makeRenderer(trackCount = 4): {
  renderer: TestRenderer;
  detachIds: string[];
} {
  installWindow();
  const detachIds: string[] = [];
  const renderer = Object.create(DanmakuRenderer.prototype) as TestRenderer;
  Object.assign(renderer, {
    container: { dataset: {} },
    options: { onDetach: (id: string) => detachIds.push(id) },
    scroll: { manager: makeManager(trackCount), lanes: makeLanePool() },
    fixed: { manager: makeManager(trackCount), lanes: makeLanePool() },
    records: new Map<string, TestRecord>(),
    reservations: new Map<string, Reservation>(),
    pendingWide: new Map<string, PendingWide>(),
    ordinarySpeeds: new Map<string, { speed: number }>(),
    scrollLocked: new Set<number>(),
    live: new Set<string>(),
    timeline: [],
    timelineIds: new Set<string>(),
    cursor: 0,
    speed: 100,
    area: 1,
    laneHeight: 20,
    lastMediaTime: 0,
    frozen: false,
    frame: 0,
    wideTimer: 0,
    renderQueued: true,
    destroyed: false,
  });
  return { renderer, detachIds };
}

function addRecord(renderer: TestRenderer, danmaku: TestDanmaku, lanes = [0, 1]): void {
  renderer.records.set(danmaku.data.id, {
    comment: danmaku.data,
    danmaku,
    element: {} as HTMLElement,
    layer: "scroll",
    lanes,
    locked: false,
  });
}

function addPendingWide(
  renderer: TestRenderer,
  id: string,
  deadline = performance.now() + 5_000,
): PendingWide {
  const pending: PendingWide = {
    comment: wideComment(id),
    reservation: null,
    deadline,
  };
  renderer.pendingWide.set(id, pending);
  renderer.live.add(id);
  return pending;
}

function addOrdinary(renderer: TestRenderer, danmaku: TestDanmaku, lane = 0): void {
  renderer.scroll.manager.getTrack(lane).list.push(danmaku);
  renderer.records.set(danmaku.data.id, {
    comment: danmaku.data,
    danmaku,
    element: {} as HTMLElement,
    layer: "scroll",
    lanes: [],
    locked: false,
  });
}

test("单一调度器只注册一条 100ms 定时器并在停止时清理", () => {
  const { renderer } = makeRenderer();
  addPendingWide(renderer, "wide-1");

  renderer.ensureWideScheduler();
  expect(timers.size).toBe(1);
  expect([...timers.values()][0]).toMatchObject({ delay: 100 });
  const timerId = renderer.wideTimer;
  expect(timerId).not.toBe(0);

  renderer.ensureWideScheduler();
  expect(timers.size).toBe(1);

  renderer.stopWideScheduler();
  expect(renderer.wideTimer).toBe(0);
  expect(timers.size).toBe(0);
});

test("真实 100ms 回调先回收到期项，再预约并重排下一次检查", () => {
  const { renderer, detachIds } = makeRenderer(2);
  const blocker = makeDanmaku("ordinary-1", {
    type: "facile",
    left: 900,
    width: 200,
    speed: 0.1,
  });
  addOrdinary(renderer, blocker);
  addPendingWide(renderer, "expired", performance.now() - 1);
  addPendingWide(renderer, "pending");
  renderer.ensureWideScheduler();
  const callback = timers.get(renderer.wideTimer)?.callback;
  expect(callback).toBeFunction();
  callback!();

  expect(renderer.pendingWide.has("expired")).toBe(false);
  expect(renderer.pendingWide.has("pending")).toBe(true);
  expect(renderer.pendingWide.size).toBe(1);
  expect(renderer.pendingWide.get("pending")?.reservation?.lanes).toEqual([0, 1]);
  expect(detachIds).toEqual(["expired"]);
  expect(renderer.scroll.manager.pushes).toHaveLength(0);
  expect(renderer.scrollLocked).toEqual(new Set([0, 1]));
  expect(renderer.wideTimer).not.toBe(0);
  expect(timers.has(renderer.wideTimer)).toBe(true);
});

test("公开 setSpeed 更新普通弹幕速度并同步滚动锁", () => {
  const { renderer } = makeRenderer();
  const image = makeDanmaku("wide-1", { left: 500, width: 200, speed: 0.1 });
  addRecord(renderer, image);

  renderer.recomputeScrollLocks();
  expect(renderer.scrollLocked).toEqual(new Set());

  renderer.setSpeed(200);
  expect(renderer.scroll.manager.options.speed).toBe(0.2);
  expect(renderer.scrollLocked).toEqual(new Set([0, 1]));
});

test("图片实例倍速参与相对速度准入", () => {
  const { renderer } = makeRenderer();
  const image = makeDanmaku("wide-1", { left: 500, width: 200, speed: 0.1, rate: 0.5 });
  addRecord(renderer, image);

  renderer.recomputeScrollLocks();
  expect(renderer.scrollLocked).toEqual(new Set([0, 1]));

  image.rate = 1;
  renderer.recomputeScrollLocks();
  expect(renderer.scrollLocked).toEqual(new Set());
});

test("前图完全进屏后，新图片可在同一双轨安全进入", () => {
  const { renderer } = makeRenderer();
  const image = makeDanmaku("wide-1", { left: 800, width: 200, speed: 0.1 });
  addRecord(renderer, image);
  addPendingWide(renderer, "wide-2");

  renderer.recomputeScrollLocks();
  expect(renderer.scrollLocked).toEqual(new Set());
  renderer.advancePendingWide();

  expect(renderer.pendingWide.has("wide-2")).toBe(false);
  expect(renderer.reservations.get("wide-2")?.lanes).toEqual([0, 1]);
  expect(renderer.scroll.manager.pushes).toHaveLength(1);
  expect(renderer.scroll.manager.pushes[0]?.comment.id).toBe("wide-2");
});

test("已有图片尾部完全进屏后解锁，快后车进入时继续锁两轨", () => {
  const { renderer } = makeRenderer();
  const image = makeDanmaku("wide-1", { left: 800, width: 200, speed: 0.1 });
  addRecord(renderer, image);

  renderer.recomputeScrollLocks();
  expect(renderer.scrollLocked).toEqual(new Set());
  expect(renderer.scroll.manager.getTrack(0).isLock).toBe(false);
  expect(renderer.scroll.manager.getTrack(1).isLock).toBe(false);

  renderer.scroll.manager.options.speed = 0.2;
  renderer.recomputeScrollLocks();
  expect(renderer.scrollLocked).toEqual(new Set([0, 1]));
  expect(renderer.scroll.manager.getTrack(0).isLock).toBe(true);
  expect(renderer.scroll.manager.getTrack(1).isLock).toBe(true);

  image.setLeft(300);
  renderer.recomputeScrollLocks();
  expect(renderer.scrollLocked).toEqual(new Set());
});

test("单轨 facile 扩为双轨后按实际几何锁住相邻轨", () => {
  const { renderer } = makeRenderer();
  const expanded = makeDanmaku("expanded", {
    type: "facile",
    lanes: 2,
    left: 900,
    width: 200,
    height: 40,
    speed: 0.1,
  });
  addRecord(renderer, expanded, [0]);
  renderer.scroll.manager.getTrack(0).list.push(expanded);

  renderer.recomputeScrollLocks();

  expect(renderer.records.get("expanded")?.lanes).toEqual([0, 1]);
  expect(renderer.scrollLocked).toEqual(new Set([0, 1]));
  expect(renderer.scroll.manager.getTrack(0).isLock).toBe(true);
  expect(renderer.scroll.manager.getTrack(1).isLock).toBe(true);
});

test("双轨 facile 扩轨后同原生轨与相邻轨都不能再进图", () => {
  const { renderer } = makeRenderer(4);
  const expanded = makeDanmaku("expanded", {
    type: "facile",
    lanes: 2,
    left: 900,
    width: 200,
    height: 40,
    speed: 0.1,
  });
  addRecord(renderer, expanded, [0]);
  renderer.scroll.manager.getTrack(0).list.push(expanded);
  renderer.recomputeScrollLocks();
  addPendingWide(renderer, "wide-2");

  renderer.advancePendingWide();

  expect(renderer.pendingWide.has("wide-2")).toBe(false);
  expect(renderer.reservations.get("wide-2")?.lanes).toEqual([2, 3]);
  expect(renderer.scroll.manager.pushes).toHaveLength(1);
});

test("双轨中一条仍有普通弹幕时先预约但不上屏，清空后放行", () => {
  const { renderer } = makeRenderer(2);
  const blocker = makeDanmaku("ordinary-1", {
    type: "facile",
    left: 900,
    width: 200,
    speed: 0.1,
  });
  addOrdinary(renderer, blocker);
  addPendingWide(renderer, "wide-1");

  renderer.advancePendingWide();
  expect(renderer.pendingWide.get("wide-1")?.reservation?.lanes).toEqual([0, 1]);
  expect(renderer.scroll.manager.pushes).toHaveLength(0);

  renderer.recomputeScrollLocks();
  expect(renderer.scrollLocked).toEqual(new Set([0, 1]));

  renderer.scroll.manager.getTrack(0).clear();
  renderer.advancePendingWide();
  expect(renderer.pendingWide.has("wide-1")).toBe(false);
  expect(renderer.scroll.manager.pushes).toHaveLength(1);
});

test("两条连续轨道都有一轨阻塞时不会选择被占用的起点", () => {
  const { renderer } = makeRenderer(3);
  const blocker = makeDanmaku("ordinary-1", {
    type: "facile",
    left: 900,
    width: 200,
    speed: 0.1,
  });
  addOrdinary(renderer, blocker, 1);
  addPendingWide(renderer, "wide-1");

  renderer.advancePendingWide();
  expect(renderer.pendingWide.get("wide-1")?.reservation?.lanes).toEqual([0, 1]);
  expect(renderer.scroll.manager.pushes).toHaveLength(0);
});

test("已 launch 但尚未 append 的 reservation 仍锁住对应轨道", () => {
  const { renderer } = makeRenderer();
  renderer.reservations.set("wide-1", { layer: "scroll", lanes: [1, 2], locked: false });

  renderer.recomputeScrollLocks();
  expect(renderer.scrollLocked).toEqual(new Set([1, 2]));
  expect(renderer.scroll.manager.getTrack(1).isLock).toBe(true);
  expect(renderer.scroll.manager.getTrack(2).isLock).toBe(true);
});

test("普通入库速度快照抬高图片准入速度上界", () => {
  const { renderer } = makeRenderer();
  renderer.ordinarySpeeds.set("slow", { speed: 0.1 });
  renderer.ordinarySpeeds.set("fast", { speed: 0.5 });
  expect(renderer.ordinaryEntrySpeed()).toBe(0.5);

  // 已上屏图片作为前车；后车速度上界由 ordinarySpeeds 提供，而不是 manager 默认值。
  const image = makeDanmaku("wide-1", { left: 500, width: 200, speed: 0.1 });
  addRecord(renderer, image);
  renderer.recomputeScrollLocks();
  expect(renderer.scroll.manager.getTrack(0).isLock).toBe(true);
  expect(renderer.scroll.manager.getTrack(1).isLock).toBe(true);

  // 快照从 0.5 降到 0.1 后，前车右缘 700px 已过同速门限，解除锁。
  renderer.ordinarySpeeds.delete("fast");
  renderer.recomputeScrollLocks();
  expect(renderer.scroll.manager.getTrack(0).isLock).toBe(false);
  expect(renderer.scroll.manager.getTrack(1).isLock).toBe(false);
});

test("队首 pending 已预约时，后续图片不越过 FIFO 抢占其他双轨", () => {
  const { renderer } = makeRenderer();
  const first = addPendingWide(renderer, "wide-1");
  first.reservation = { layer: "scroll", lanes: [0, 1], locked: false };
  const second = addPendingWide(renderer, "wide-2");

  renderer.tryLaunchWide(second, 2);
  expect(second.reservation).toBeNull();
  expect(renderer.scroll.manager.pushes).toHaveLength(0);

  renderer.launchWide(first.comment, first.reservation);
  renderer.advancePendingWide();
  expect(renderer.pendingWide.has("wide-2")).toBe(false);
  expect(renderer.reservations.get("wide-2")?.lanes).toEqual([2, 3]);
});

test("启动预约过期时销毁未起步图片并只结算一次", () => {
  const { renderer, detachIds } = makeRenderer();
  const starting = makeDanmaku("starting", { moving: false });
  let destroys = 0;
  starting.destroy = async () => {
    destroys += 1;
    renderer.onDestroyed(starting);
  };
  renderer.scroll.manager.starting.push(starting);
  renderer.reservations.set("starting", {
    layer: "scroll",
    lanes: [0, 1],
    locked: false,
    deadline: performance.now() - 1,
  });
  renderer.live.add("starting");
  renderer.recomputeScrollLocks();
  expect(renderer.scrollLocked).toEqual(new Set([0, 1]));

  renderer.expireStartingWide();

  expect(destroys).toBe(1);
  expect(detachIds).toEqual(["starting"]);
  expect(renderer.reservations.has("starting")).toBe(false);
  expect(renderer.scrollLocked).toEqual(new Set());
  expect(renderer.scroll.manager.getTrack(0).isLock).toBe(false);
  expect(renderer.scroll.manager.getTrack(1).isLock).toBe(false);
});

test("启动预约对应的图片已 moving 时只移除预约，不销毁实例", () => {
  const { renderer, detachIds } = makeRenderer();
  const moving = makeDanmaku("moving", { moving: true, left: 800, width: 200, speed: 0.1 });
  let destroys = 0;
  moving.destroy = async () => {
    destroys += 1;
  };
  addRecord(renderer, moving, [0, 1]);
  renderer.reservations.set("moving", {
    layer: "scroll",
    lanes: [0, 1],
    locked: false,
    deadline: performance.now() - 1,
  });
  renderer.live.add("moving");

  renderer.expireStartingWide();
  expect(renderer.reservations.has("moving")).toBe(false);
  expect(destroys).toBe(0);
  expect(detachIds).toEqual([]);
  expect(renderer.live.has("moving")).toBe(true);

  renderer.recomputeScrollLocks();
  expect(renderer.scrollLocked).toEqual(new Set());
});

test("冻结期间 deadline 到期仍只 detach 一次且不投放", () => {
  const { renderer, detachIds } = makeRenderer();
  renderer.frozen = true;
  addPendingWide(renderer, "wide-1", performance.now() - 1);

  renderer.expirePendingWide();
  expect(renderer.pendingWide.has("wide-1")).toBe(false);
  expect(renderer.live.has("wide-1")).toBe(false);
  expect(detachIds).toEqual(["wide-1"]);
  expect(renderer.scroll.manager.pushes).toHaveLength(0);

  renderer.expirePendingWide();
  expect(detachIds).toEqual(["wide-1"]);
});

test("clear 清理滚动锁与 pending 并只结算一次", () => {
  const { renderer, detachIds } = makeRenderer();
  renderer.scrollLocked.add(0);
  renderer.scrollLocked.add(1);
  renderer.scroll.manager.getTrack(0).lock();
  renderer.scroll.manager.getTrack(1).lock();
  addPendingWide(renderer, "wide-1");

  renderer.clearActive();
  expect(renderer.scrollLocked).toEqual(new Set());
  expect(renderer.scroll.manager.getTrack(0).isLock).toBe(false);
  expect(renderer.scroll.manager.getTrack(1).isLock).toBe(false);
  expect(renderer.pendingWide.size).toBe(0);
  expect(detachIds).toEqual(["wide-1"]);
});

test("公开 clear 同样释放滚动锁并清空 pending", () => {
  const { renderer, detachIds } = makeRenderer();
  renderer.scrollLocked.add(0);
  renderer.scrollLocked.add(1);
  renderer.scroll.manager.getTrack(0).lock();
  renderer.scroll.manager.getTrack(1).lock();
  addPendingWide(renderer, "wide-1");

  renderer.clear();
  expect(renderer.scrollLocked).toEqual(new Set());
  expect(renderer.scroll.manager.getTrack(0).isLock).toBe(false);
  expect(renderer.scroll.manager.getTrack(1).isLock).toBe(false);
  expect(renderer.pendingWide.size).toBe(0);
  expect(detachIds).toEqual(["wide-1"]);
});

test("destroy 清理滚动锁、定时器与 pending", () => {
  const { renderer, detachIds } = makeRenderer();
  renderer.scrollLocked.add(0);
  renderer.scrollLocked.add(1);
  renderer.scroll.manager.getTrack(0).lock();
  renderer.scroll.manager.getTrack(1).lock();
  addPendingWide(renderer, "wide-1");
  renderer.ensureWideScheduler();

  renderer.destroy();
  expect(renderer.destroyed).toBe(true);
  expect(renderer.scrollLocked).toEqual(new Set());
  expect(renderer.scroll.manager.getTrack(0).isLock).toBe(false);
  expect(renderer.scroll.manager.getTrack(1).isLock).toBe(false);
  expect(renderer.wideTimer).toBe(0);
  expect(timers.size).toBe(0);
  expect(renderer.pendingWide.size).toBe(0);
  expect(detachIds).toEqual(["wide-1"]);
});

test("没有待投图片且轨道已解锁时不再排队下一次检查", () => {
  const { renderer } = makeRenderer();
  const image = makeDanmaku("wide-1", { left: 800, width: 200, speed: 0.1 });
  addRecord(renderer, image);

  renderer.recomputeScrollLocks();
  expect(renderer.scrollLocked).toEqual(new Set());
  renderer.ensureWideScheduler();

  expect(renderer.wideTimer).toBe(0);
  expect(timers.size).toBe(0);
});

test("没有图片时重算轨道锁不读取在屏普通弹幕尺寸", () => {
  const { renderer } = makeRenderer();
  const ordinary = makeDanmaku("ordinary-1", { type: "facile" });
  let widthReads = 0;
  ordinary.getWidth = () => {
    widthReads += 1;
    return 200;
  };
  addOrdinary(renderer, ordinary);

  renderer.recomputeScrollLocks();

  expect(widthReads).toBe(0);
  expect(renderer.scrollLocked).toEqual(new Set());
});

test("resize 按当前 y 与元素高度重新映射图片触及的轨道", () => {
  const { renderer } = makeRenderer();
  const image = makeDanmaku("wide-1", { y: 40, height: 40 });
  expect(renderer.coveredScrollLanes(image)).toEqual([2, 3]);

  addRecord(renderer, image, [0, 1]);
  renderer.syncLanes();
  expect(renderer.records.get("wide-1")?.lanes).toEqual([2, 3]);
});

test("resize 重建轨道时保留普通弹幕入库速度快照", () => {
  const { renderer } = makeRenderer();
  renderer.ordinarySpeeds.set("ordinary-1", { speed: 0.5 });

  renderer.resize();

  expect(renderer.ordinarySpeeds.get("ordinary-1")).toEqual({ speed: 0.5 });
  expect(renderer.ordinaryEntrySpeed()).toBe(0.5);
});

test("固定弹幕 push 与 append 之间 resize 后不会把同一车道再分出去", () => {
  const { renderer } = makeRenderer(4);
  renderer.syncLanes();

  expect(renderer.pushFixed(fixedComment("fixed-1"), 1)).toBe(true);
  expect(renderer.reservations.get("fixed-1")?.lanes).toEqual([0]);

  // 第一条尚未 append（不在 records 里），此时容器尺寸变化重建占用表。
  renderer.syncLanes();

  expect(renderer.pushFixed(fixedComment("fixed-2"), 1)).toBe(true);
  expect(renderer.reservations.get("fixed-1")?.lanes).toEqual([0]);
  expect(renderer.reservations.get("fixed-2")?.lanes).toEqual([1]);
});

test("缩小车道数时在途固定预约越界则撤销并只结算一次", () => {
  const { renderer, detachIds } = makeRenderer(4);
  renderer.syncLanes();
  const destroys = new Map<string, number>();
  for (let index = 1; index <= 4; index += 1) {
    const id = `fixed-${index}`;
    expect(renderer.pushFixed(fixedComment(id), 1)).toBe(true);
    expect(renderer.reservations.get(id)?.lanes).toEqual([index - 1]);
    const starting = makeDanmaku(id, { type: "flexible", moving: false });
    starting.destroy = async () => {
      destroys.set(id, (destroys.get(id) ?? 0) + 1);
      renderer.onDestroyed(starting);
    };
    renderer.fixed.manager.starting.push(starting);
  }

  renderer.fixed.manager.setTrackCount(2);
  renderer.syncLanes();

  expect(renderer.reservations.get("fixed-1")?.lanes).toEqual([0]);
  expect(renderer.reservations.get("fixed-2")?.lanes).toEqual([1]);
  expect(renderer.reservations.has("fixed-3")).toBe(false);
  expect(renderer.reservations.has("fixed-4")).toBe(false);
  expect(destroys.get("fixed-1")).toBeUndefined();
  expect(destroys.get("fixed-2")).toBeUndefined();
  expect(destroys.get("fixed-3")).toBe(1);
  expect(destroys.get("fixed-4")).toBe(1);
  expect(renderer.live.has("fixed-3")).toBe(false);
  expect(renderer.live.has("fixed-4")).toBe(false);
  expect(detachIds.sort()).toEqual(["fixed-3", "fixed-4"]);
});

test("resize 重分配的固定预约在 append 时按新车道定位", () => {
  const { renderer, detachIds } = makeRenderer(4);
  renderer.syncLanes();

  // 两条都还在等着 append：宽弹幕占三车道，后一条预约到第 3 车道。
  expect(renderer.pushFixed(fixedComment("fixed-wide", "top", 3), 3)).toBe(true);
  expect(renderer.pushFixed(fixedComment("fixed-narrow"), 1)).toBe(true);
  expect(renderer.reservations.get("fixed-wide")?.lanes).toEqual([0, 1, 2]);
  expect(renderer.reservations.get("fixed-narrow")?.lanes).toEqual([3]);
  const wide = makeDanmaku("fixed-wide", { type: "flexible", moving: false });
  wide.destroy = async () => renderer.onDestroyed(wide);
  renderer.fixed.manager.starting.push(wide);

  // 缩到两车道：宽预约放不下被撤销，窄预约回填到第 0 车道。
  renderer.fixed.manager.setTrackCount(2);
  renderer.syncLanes();
  expect(renderer.reservations.get("fixed-narrow")?.lanes).toEqual([0]);
  expect(detachIds).toEqual(["fixed-wide"]);

  const pushed = renderer.fixed.manager.pushes.at(-1)!;
  const options = pushed.options as {
    position(danmaku: TestDanmaku, container: unknown): { x: number; y: number };
  };
  expect(options.position(makeDanmaku("fixed-narrow"), {})).toEqual({ x: 400, y: 0 });
});
