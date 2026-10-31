import { afterEach, expect, test } from "bun:test";
import type { Danmaku } from "danmu";
import { DanmakuRenderer, LanePool } from "../src/features/room/danmaku/danmakuRenderer";
import type { DanmakuComment } from "../src/features/room/danmaku/danmakuTypes";

type TestDanmaku = Danmaku<DanmakuComment> & {
  data: DanmakuComment;
  type: "facile" | "flexible";
  paused: boolean;
  moving: boolean;
  rate: number;
  position: { x: number; y: number };
  destroy(): Promise<void>;
  setStyle(key: string, value: string): void;
  getWidth(): number;
  getHeight(): number;
};

type TestRecord = {
  comment: DanmakuComment;
  danmaku: TestDanmaku;
  element: HTMLElement;
  layer: "scroll" | "fixed";
  lane: number | null;
};

type Reservation = { lane: number };

type FakeManager = {
  options: { speed: number; rate: number; gap: number };
  container: { width: number; height: number };
  readonly trackCount: number;
  setTrackCount(count: number): void;
  pushFlexibleDanmaku(comment: DanmakuComment, options: unknown): boolean;
  each(fn: (danmaku: TestDanmaku) => unknown): void;
  setRate(rate: number): void;
  len(): { stash: number };
  push(comment: DanmakuComment): boolean;
  clear(): void;
  stopPlaying(): void;
  unmount(): void;
  format(): void;
  render(): void;
  setSpeed(speed: number): void;
  setTrackHeight(height: number): void;
  pushes: Array<{ comment: DanmakuComment; options: unknown }>;
  ordinaryPushes: DanmakuComment[];
  stash: number;
  starting: TestDanmaku[];
};

type TestWillRenderEvent = {
  type: "facile" | "flexible";
  prevent: boolean;
  danmaku: TestDanmaku;
  trackIndex: number | null;
};

type TestRenderer = {
  container: { dataset: Record<string, string> };
  options: { onDetach?: (id: string) => void };
  scroll: { manager: FakeManager };
  fixed: { manager: FakeManager };
  fixedLanes: LanePool;
  records: Map<string, TestRecord>;
  reservations: Map<string, Reservation>;
  backlog: Array<{ comment: DanmakuComment; queuedAt: number }>;
  queuedAt: Map<string, number>;
  pumping: boolean;
  live: Set<string>;
  timeline: DanmakuComment[];
  timelineIds: Set<string>;
  cursor: number;
  speed: number;
  area: number;
  laneHeight: number;
  maxLatencyMs: number;
  frozen: boolean;
  frame: number;
  backlogTimer: number;
  renderQueued: boolean;
  destroyed: boolean;
  push(comment: DanmakuComment): boolean;
  pushFixed(comment: DanmakuComment): boolean;
  pumpBacklog(): void;
  trimBacklog(): void;
  cancelBacklog(): void;
  backlogCapacity(): number;
  onWillRender(event: TestWillRenderEvent): TestWillRenderEvent;
  onDestroyed(danmaku: TestDanmaku): void;
  ensureBacklogTimer(): void;
  stopBacklogTimer(): void;
  runBacklogTimer(): void;
  clearActive(): void;
  clear(): void;
  destroy(): void;
  syncLanes(): void;
  resize(): void;
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

function danmakuComment(id: string, text = id): DanmakuComment {
  return {
    id,
    text,
    mode: "scroll",
    render: () => {
      throw new Error("调度测试不创建 DOM");
    },
  };
}

function fixedComment(id: string, mode: DanmakuComment["mode"] = "top"): DanmakuComment {
  return {
    id,
    text: id,
    mode,
    render: () => {
      throw new Error("车道测试不创建 DOM");
    },
  };
}

function makeManager(trackCount: number): FakeManager {
  let count = trackCount;
  const manager: FakeManager = {
    options: { speed: 0.1, rate: 1, gap: 0 },
    container: { width: 1_000, height: 200 },
    get trackCount() {
      return count;
    },
    setTrackCount(next) {
      count = next;
    },
    pushFlexibleDanmaku(comment, options) {
      manager.pushes.push({ comment, options });
      return true;
    },
    each(fn) {
      for (const danmaku of Array.from(manager.starting)) fn(danmaku);
    },
    len() {
      return { stash: manager.stash };
    },
    push(comment) {
      manager.ordinaryPushes.push(comment);
      manager.stash += 1;
      return true;
    },
    clear() {
      manager.starting.length = 0;
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
    ordinaryPushes: [],
    stash: 0,
    starting: [],
  };
  return manager;
}

function makeDanmaku(
  id: string,
  patch: {
    type?: "facile" | "flexible";
    left?: number;
    y?: number;
    width?: number;
    height?: number;
    moving?: boolean;
    paused?: boolean;
  } = {},
): TestDanmaku {
  const state = {
    left: patch.left ?? 800,
    y: patch.y ?? 0,
    width: patch.width ?? 200,
    height: patch.height ?? 40,
  };
  const type = patch.type ?? "flexible";
  const styleCalls: Array<[string, string]> = [];
  const danmaku = {
    data: danmakuComment(id),
    type,
    paused: patch.paused ?? false,
    moving: patch.moving ?? true,
    rate: 1,
    position: { x: state.left, y: state.y },
    destroy: async () => {},
    setLeft(left: number) {
      state.left = left;
      this.position.x = left;
    },
    setY(y: number) {
      state.y = y;
      this.position.y = y;
    },
    setStyle(key: string, value: string) {
      styleCalls.push([key, value]);
    },
    styleCalls,
    getWidth: () => state.width,
    getHeight: () => state.height,
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
    scroll: { manager: makeManager(trackCount) },
    fixed: { manager: makeManager(trackCount) },
    fixedLanes: new LanePool(),
    records: new Map<string, TestRecord>(),
    reservations: new Map<string, Reservation>(),
    backlog: [],
    queuedAt: new Map<string, number>(),
    pumping: false,
    live: new Set<string>(),
    timeline: [],
    timelineIds: new Set<string>(),
    cursor: 0,
    speed: 100,
    area: 1,
    laneHeight: 20,
    maxLatencyMs: 0,
    frozen: false,
    frame: 0,
    backlogTimer: 0,
    renderQueued: true,
    destroyed: false,
  });
  return { renderer, detachIds };
}

function addFixedRecord(renderer: TestRenderer, danmaku: TestDanmaku, lane: number): void {
  renderer.records.set(danmaku.data.id, {
    comment: danmaku.data,
    danmaku,
    element: {} as HTMLElement,
    layer: "fixed",
    lane,
  });
}

function willRenderEvent(
  danmaku: TestDanmaku,
  type: "facile" | "flexible" = "facile",
): TestWillRenderEvent {
  return { type, prevent: false, danmaku, trackIndex: type === "facile" ? 0 : null };
}

test("LanePool 每条固定弹幕只分配一条车道", () => {
  const lanes = new LanePool();
  lanes.reset(2);
  expect(lanes.allocate()).toBe(0);
  expect(lanes.allocate()).toBe(1);
  expect(lanes.allocate()).toBeNull();
  lanes.release(0);
  expect(lanes.allocate()).toBe(0);
  lanes.reset(0);
  expect(lanes.allocate()).toBeNull();
});

test("应用侧队列非空时只排一条 100ms 定时器并在清空后停止", () => {
  const { renderer } = makeRenderer();

  renderer.ensureBacklogTimer();
  expect(timers.size).toBe(0);

  renderer.live.add("a");
  renderer.backlog.push({ comment: danmakuComment("a"), queuedAt: performance.now() });
  renderer.ensureBacklogTimer();
  expect(timers.size).toBe(1);
  expect([...timers.values()][0]).toMatchObject({ delay: 100 });
  renderer.ensureBacklogTimer();
  expect(timers.size).toBe(1);

  renderer.cancelBacklog();
  renderer.stopBacklogTimer();
  expect(renderer.backlogTimer).toBe(0);
  expect(timers.size).toBe(0);
});

test("未设置 maxLatencyMs 时滚动弹幕直接交给库，行为与点播一致", () => {
  const { renderer, detachIds } = makeRenderer(4);

  expect(renderer.push(danmakuComment("ordinary-1"))).toBe(true);

  expect(renderer.backlog).toHaveLength(0);
  expect(renderer.scroll.manager.ordinaryPushes.map((comment) => comment.id)).toEqual([
    "ordinary-1",
  ]);
  expect(renderer.scroll.manager.len().stash).toBe(1);
  expect(renderer.live.has("ordinary-1")).toBe(true);
  expect(renderer.queuedAt.size).toBe(0);
  expect(detachIds).toEqual([]);
});

test("应用侧队列在库 stash 达到轨道数时暂停，库取走后继续推送", () => {
  const { renderer, detachIds } = makeRenderer(2);
  renderer.maxLatencyMs = 3_000;

  expect(renderer.push(danmakuComment("a"))).toBe(true);
  expect(renderer.push(danmakuComment("b"))).toBe(true);
  expect(renderer.push(danmakuComment("c"))).toBe(true);
  expect(renderer.scroll.manager.len().stash).toBe(2);
  expect(renderer.backlog.map((item) => item.comment.id)).toEqual(["c"]);
  // 入队时刻在交给库之后仍保留，供出库时的端到端过期判断。
  expect(renderer.queuedAt.has("a")).toBe(true);
  expect(renderer.queuedAt.has("c")).toBe(true);
  expect(detachIds).toEqual([]);

  renderer.scroll.manager.stash = 1;
  renderer.pumpBacklog();

  expect(renderer.backlog).toHaveLength(0);
  expect(renderer.scroll.manager.len().stash).toBe(2);
  expect(renderer.scroll.manager.ordinaryPushes.map((comment) => comment.id)).toEqual([
    "a",
    "b",
    "c",
  ]);
});

test("队列容量为 max(4, 轨道数×2)，溢出时丢最旧且只结算一次", () => {
  const { renderer, detachIds } = makeRenderer(2);
  renderer.maxLatencyMs = 3_000;
  renderer.frozen = true;

  for (let index = 0; index < 6; index += 1) {
    expect(renderer.push(danmakuComment(`c${index}`))).toBe(true);
  }

  expect(renderer.backlog.map((item) => item.comment.id)).toEqual(["c2", "c3", "c4", "c5"]);
  expect(detachIds).toEqual(["c0", "c1"]);
  expect(renderer.live.has("c0")).toBe(false);
  expect(renderer.live.has("c5")).toBe(true);
});

test("超龄弹幕按墙钟丢弃且只结算一次", () => {
  const { renderer, detachIds } = makeRenderer(2);
  renderer.maxLatencyMs = 3_000;
  renderer.frozen = true;
  expect(renderer.push(danmakuComment("old"))).toBe(true);
  expect(renderer.push(danmakuComment("fresh"))).toBe(true);
  renderer.backlog[0]!.queuedAt = performance.now() - 3_001;

  renderer.pumpBacklog();
  renderer.pumpBacklog();

  expect(renderer.backlog.map((item) => item.comment.id)).toEqual(["fresh"]);
  expect(detachIds).toEqual(["old"]);
  expect(renderer.live.has("old")).toBe(false);
  expect(renderer.live.has("fresh")).toBe(true);
});

test("队列容量随轨道数变化，缩小后丢掉最旧的条目", () => {
  const { renderer, detachIds } = makeRenderer(5);
  renderer.maxLatencyMs = 3_000;
  renderer.frozen = true;
  for (let index = 0; index < 8; index += 1) {
    expect(renderer.push(danmakuComment(`d${index}`))).toBe(true);
  }
  expect(renderer.backlog).toHaveLength(8);
  expect(renderer.backlogCapacity()).toBe(10);

  renderer.scroll.manager.setTrackCount(2);
  renderer.syncLanes();

  expect(renderer.backlogCapacity()).toBe(4);
  expect(renderer.backlog.map((item) => item.comment.id)).toEqual(["d4", "d5", "d6", "d7"]);
  expect(detachIds).toEqual(["d0", "d1", "d2", "d3"]);

  renderer.scroll.manager.setTrackCount(5);
  renderer.syncLanes();
  expect(renderer.push(danmakuComment("d8"))).toBe(true);
  expect(renderer.backlog).toHaveLength(5);
});

test("带图的大表情滚动弹幕与普通弹幕走同一条 backlog", () => {
  const { renderer, detachIds } = makeRenderer(2);
  renderer.maxLatencyMs = 3_000;
  renderer.frozen = true;
  const emote = danmakuComment("emote", "[大表情]");

  expect(renderer.push(emote)).toBe(true);
  expect(renderer.push(danmakuComment("text"))).toBe(true);
  expect(renderer.backlog.map((item) => item.comment.id)).toEqual(["emote", "text"]);

  renderer.frozen = false;
  renderer.pumpBacklog();

  expect(renderer.backlog).toHaveLength(0);
  expect(renderer.scroll.manager.ordinaryPushes.map((comment) => comment.id)).toEqual([
    "emote",
    "text",
  ]);
  expect(renderer.scroll.manager.len().stash).toBe(2);
  expect(detachIds).toEqual([]);
});

test("clear 与 destroy 清空应用侧队列并只结算一次", () => {
  const cleared = makeRenderer(2);
  cleared.renderer.maxLatencyMs = 3_000;
  cleared.renderer.frozen = true;
  cleared.renderer.push(danmakuComment("c1"));
  cleared.renderer.push(danmakuComment("c2"));
  cleared.renderer.clearActive();
  cleared.renderer.clearActive();
  expect(cleared.renderer.backlog).toHaveLength(0);
  expect(cleared.renderer.queuedAt.size).toBe(0);
  expect(cleared.detachIds).toEqual(["c1", "c2"]);

  const destroyed = makeRenderer(2);
  destroyed.renderer.maxLatencyMs = 3_000;
  destroyed.renderer.frozen = true;
  destroyed.renderer.push(danmakuComment("d1"));
  destroyed.renderer.push(danmakuComment("d2"));
  destroyed.renderer.destroy();
  expect(destroyed.renderer.backlog).toHaveLength(0);
  expect(destroyed.renderer.queuedAt.size).toBe(0);
  expect(destroyed.detachIds).toEqual(["d1", "d2"]);
});

test("出库时已超龄的滚动弹幕被 willRender 拦下并补位", () => {
  const { renderer, detachIds } = makeRenderer(2);
  renderer.maxLatencyMs = 3_000;
  expect(renderer.push(danmakuComment("expired"))).toBe(true);
  expect(renderer.push(danmakuComment("fresh"))).toBe(true);
  expect(renderer.push(danmakuComment("next"))).toBe(true);
  expect(renderer.queuedAt.has("expired")).toBe(true);
  expect(renderer.backlog.map((item) => item.comment.id)).toEqual(["next"]);

  // 库已从 stash 取出 expired，正在询问是否上屏。
  renderer.scroll.manager.stash = 1;
  renderer.queuedAt.set("expired", performance.now() - 3_001);
  const event = willRenderEvent(makeDanmaku("expired", { type: "facile" }));

  const result = renderer.onWillRender(event);

  expect(result).toBe(event);
  expect(result.prevent).toBe(true);
  expect(detachIds).toEqual(["expired"]);
  expect(renderer.queuedAt.has("expired")).toBe(false);
  expect(renderer.backlog).toHaveLength(0);
  expect(renderer.scroll.manager.ordinaryPushes.map((comment) => comment.id)).toEqual([
    "expired",
    "fresh",
    "next",
  ]);
});

test("未超龄的滚动弹幕正常放行", () => {
  const { renderer, detachIds } = makeRenderer(2);
  renderer.maxLatencyMs = 3_000;
  expect(renderer.push(danmakuComment("ordinary-1"))).toBe(true);
  const event = willRenderEvent(makeDanmaku("ordinary-1", { type: "facile" }));

  const result = renderer.onWillRender(event);

  expect(result).toBe(event);
  expect(result.prevent).toBe(false);
  expect(detachIds).toEqual([]);
  expect(renderer.queuedAt.has("ordinary-1")).toBe(true);
});

test("willRender 不处理固定弹幕", () => {
  const { renderer, detachIds } = makeRenderer(2);
  renderer.maxLatencyMs = 3_000;
  const fixed = makeDanmaku("fixed-1", { type: "flexible" });
  renderer.live.add("fixed-1");
  renderer.queuedAt.set("fixed-1", performance.now() - 3_001);

  const result = renderer.onWillRender(willRenderEvent(fixed, "flexible"));

  expect(result.prevent).toBe(false);
  expect(detachIds).toEqual([]);
  expect(renderer.live.has("fixed-1")).toBe(true);
});

test("未设置 maxLatencyMs 时 willRender 不干预点播", () => {
  const { renderer, detachIds } = makeRenderer(2);
  const danmaku = makeDanmaku("vod-1", { type: "facile" });
  renderer.live.add("vod-1");
  renderer.queuedAt.set("vod-1", performance.now() - 10_000);

  const result = renderer.onWillRender(willRenderEvent(danmaku));

  expect(result.prevent).toBe(false);
  expect(detachIds).toEqual([]);
  expect(renderer.live.has("vod-1")).toBe(true);
});

test("strict 重试再次出库时才超龄仍只结算一次", () => {
  const { renderer, detachIds } = makeRenderer(2);
  renderer.maxLatencyMs = 3_000;
  expect(renderer.push(danmakuComment("retry"))).toBe(true);
  const danmaku = makeDanmaku("retry", { type: "facile" });

  // 第一次出库未超龄：放行并 append；库随后因 strict 重试把同一实例 unshift 回 stash。
  expect(renderer.onWillRender(willRenderEvent(danmaku)).prevent).toBe(false);
  expect(detachIds).toEqual([]);

  // 重试前 append 过一次，本文件的记录也要在拦下时回收。
  renderer.records.set("retry", {
    comment: danmaku.data,
    danmaku,
    element: {} as HTMLElement,
    layer: "scroll",
    lane: null,
  });
  renderer.queuedAt.set("retry", performance.now() - 3_001);

  expect(renderer.onWillRender(willRenderEvent(danmaku)).prevent).toBe(true);
  expect(detachIds).toEqual(["retry"]);
  expect(renderer.records.has("retry")).toBe(false);

  // 已结算的条目 queuedAt 已清，不会再次 prevent 或重复 detach。
  expect(renderer.onWillRender(willRenderEvent(danmaku)).prevent).toBe(false);
  expect(detachIds).toEqual(["retry"]);
});

test("固定弹幕每条只占一条车道，push 与 append 之间 resize 不会重复分配", () => {
  const { renderer } = makeRenderer(4);
  renderer.syncLanes();

  expect(renderer.pushFixed(fixedComment("fixed-1"))).toBe(true);
  expect(renderer.reservations.get("fixed-1")?.lane).toBe(0);

  // 第一条尚未 append（不在 records 里），此时容器尺寸变化重建占用表。
  renderer.syncLanes();

  expect(renderer.pushFixed(fixedComment("fixed-2"))).toBe(true);
  expect(renderer.reservations.get("fixed-1")?.lane).toBe(0);
  expect(renderer.reservations.get("fixed-2")?.lane).toBe(1);
});

test("缩小车道数时在途固定预约越界则撤销并只结算一次", () => {
  const { renderer, detachIds } = makeRenderer(4);
  renderer.syncLanes();
  const destroys = new Map<string, number>();
  for (let index = 1; index <= 4; index += 1) {
    const id = `fixed-${index}`;
    expect(renderer.pushFixed(fixedComment(id))).toBe(true);
    expect(renderer.reservations.get(id)?.lane).toBe(index - 1);
    const starting = makeDanmaku(id, { type: "flexible", moving: false });
    starting.destroy = async () => {
      destroys.set(id, (destroys.get(id) ?? 0) + 1);
      renderer.onDestroyed(starting);
    };
    renderer.fixed.manager.starting.push(starting);
  }

  renderer.fixed.manager.setTrackCount(2);
  renderer.syncLanes();

  expect(renderer.reservations.get("fixed-1")?.lane).toBe(0);
  expect(renderer.reservations.get("fixed-2")?.lane).toBe(1);
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

test("resize 后已上屏固定弹幕按新车道重新落位", () => {
  const { renderer } = makeRenderer(2);
  const first = makeDanmaku("fixed-1", { type: "flexible", moving: false });
  const second = makeDanmaku("fixed-2", { type: "flexible", moving: false });
  addFixedRecord(renderer, first, 0);
  addFixedRecord(renderer, second, 1);
  first.position.y = 999;
  second.position.y = 999;

  renderer.syncLanes();

  expect(first.position.y).toBe(0);
  expect(second.position.y).toBe(20);
  expect(first.position.x).toBe(400);
  expect(second.position.x).toBe(400);
});
