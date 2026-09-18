import {
  debounce,
  observeElementOffset,
  observeElementRect,
  type Rect,
  type VirtualItem,
  type Virtualizer,
} from "@tanstack/react-virtual";
import { findVerticalScrollParent } from "@/shared/gestures/pullToRefresh";

/**
 * 可视区外多渲染的行数。
 *
 * 历史页在触摸设备上一甩就是几屏，默认 1 行缓冲会露白；6 行足够覆盖合成器
 * 追赶期间的一帧，也不会把 DOM 行数拉回与记录数同阶。
 */
export const HISTORY_TIMELINE_OVERSCAN = 6;

/** 快照记忆上限，避免长时间浏览无限累积。 */
export const HISTORY_SCROLL_SNAPSHOT_LIMIT = 32;

/**
 * 判定「停在直播边缘（顶部）」的像素容差。
 *
 * 时间线按时间倒序，最新记录从顶部插入，因此顶部就是直播边缘。触摸滚动很难精确
 * 停在 0，留几像素容差，避免刚离开顶部就把新记录顶到视口外。
 */
export const HISTORY_LIVE_EDGE_THRESHOLD_PX = 8;

/**
 * 一条时间线的滚动快照。
 *
 * `measurements` 来自 `virtualizer.takeSnapshot()`，恢复时喂回
 * `initialMeasurementsCache`；`offset` 是滚动容器坐标里的偏移，恢复时喂回
 * `initialOffset`。两者缺一：只有偏移会把内容高度交给估高，恢复在列表长到足够高
 * 之前会被钳制；只有高度则落不回原来的行。
 */
export type HistoryScrollSnapshot = {
  measurements: VirtualItem[];
  offset: number;
};

const snapshots = new Map<string, HistoryScrollSnapshot>();

/** 写入（或覆盖）一条快照；超过上限先淘汰最旧的一条。 */
export function saveHistoryScrollSnapshot(key: string, snapshot: HistoryScrollSnapshot): void {
  if (!key) return;
  // 覆盖时先删再插，让最近写入的条目排到 Map 末尾，淘汰顺序才是真正的 LRU。
  snapshots.delete(key);
  snapshots.set(key, snapshot);
  while (snapshots.size > HISTORY_SCROLL_SNAPSHOT_LIMIT) {
    const oldest = snapshots.keys().next();
    if (oldest.done) break;
    snapshots.delete(oldest.value);
  }
}

export function readHistoryScrollSnapshot(key: string): HistoryScrollSnapshot | null {
  return snapshots.get(key) ?? null;
}

export function clearHistoryScrollSnapshots(): void {
  snapshots.clear();
}

/**
 * 时间线要虚拟化的滚动表面。
 *
 * 优先取最近的纵向可滚动祖先（历史页里是 Shell 的 `app-page`）；没有可滚动祖先时
 * 退回文档滚动元素 —— 页面本身滚动时 `documentElement.scrollTop` 就是窗口滚动位置，
 * 同一条代码路径因此同时覆盖元素滚动与窗口滚动。这里不创建任何滚动容器：表面
 * 始终由产品 UI 拥有。
 */
export function resolveHistoryScrollElement(node: HTMLElement): HTMLElement {
  const parent = findVerticalScrollParent(node);
  if (parent) return parent;
  return node.ownerDocument.scrollingElement as HTMLElement;
}

/** 该元素是否代表文档（窗口）滚动，而不是一个内部滚动容器。 */
export function isDocumentScrollElement(element: HTMLElement): boolean {
  const ownerDocument = element.ownerDocument;
  return element === ownerDocument.scrollingElement || element === ownerDocument.documentElement;
}

/**
 * 文档滚动元素的尺寸观察。
 *
 * 普通滚动容器用元素自身的 border-box；文档滚动元素是 `<html>`，它的
 * `offsetHeight` 是整篇文档高度而不是视口高度，必须改报 `innerHeight`，否则可视区
 * 尺寸错到无法计算窗口。
 */
export function observeHistoryRect(
  instance: Virtualizer<HTMLElement, any>,
  cb: (rect: Rect) => void,
): (() => void) | undefined {
  const element = instance.scrollElement;
  if (!element) return undefined;
  if (!isDocumentScrollElement(element)) return observeElementRect(instance, cb);

  const view = element.ownerDocument.defaultView;
  if (!view) return undefined;
  const report = () => cb({ width: view.innerWidth, height: view.innerHeight });
  report();
  view.addEventListener("resize", report, { passive: true });
  return () => view.removeEventListener("resize", report);
}

/**
 * 文档滚动元素的偏移观察。
 *
 * 文档滚动的 `scroll` 事件派发在 `window` 上而不是 `<html>`，沿用元素观察器会收不到
 * 通知。内部滚动容器仍走默认实现。
 */
export function observeHistoryOffset(
  instance: Virtualizer<HTMLElement, any>,
  cb: (offset: number, isScrolling: boolean) => void,
): (() => void) | undefined {
  const element = instance.scrollElement;
  if (!element) return undefined;
  if (!isDocumentScrollElement(element)) return observeElementOffset(instance, cb);

  const view = element.ownerDocument.defaultView;
  if (!view) return undefined;
  const fallback = debounce(
    view,
    () => cb(element.scrollTop, false),
    instance.options.isScrollingResetDelay,
  );
  const onScroll = () => {
    fallback();
    cb(element.scrollTop, true);
  };
  view.addEventListener("scroll", onScroll, { passive: true });
  return () => {
    view.removeEventListener("scroll", onScroll);
    fallback.cancel();
  };
}

/**
 * 快照记忆的键：历史记录 key + 视图名。
 *
 * 三个视图共用同一个滚动容器，却是彼此独立的列表。`entryKey` 传 `location.key`，
 * 让键随历史记录稳定（Shell 的 `pageScrollKey` 同样以它为锚），POP 回到同一条记录
 * 时快照仍能对上；`view` 把三条时间线分开，切视图才不会把观看历史的偏移套到弹幕
 * 历史上。`location.key` 由 react-router 生成，是无冒号的字母数字串，视图名是固定枚举，
 * 因此冒号分隔不会撞键。
 */
export function historySnapshotKey(entryKey: string, view: string): string {
  return `${entryKey}:${view}`;
}

/**
 * 锚点方向随用户位置切换。
 *
 * 时间倒序列表的直播边缘在顶部：停在顶部时不锚定（`start`），新记录从顶部插入后
 * 视口仍停在 0，用户自然看到最新一条；向下滚动后锚定到 `end`，TanStack Virtual 按
 * 稳定行键把当前可见行钉在原位，新记录插入不会挤动视口。
 */
export function historyAnchorTo(scrollOffset: number): "start" | "end" {
  return scrollOffset <= HISTORY_LIVE_EDGE_THRESHOLD_PX ? "start" : "end";
}

/**
 * 元素在滚动容器内容坐标系中的纵向偏移。
 *
 * 用 offsetTop 逐级累加而不是两个 `getBoundingClientRect` 相减：历史页外面套着
 * 页面平移与横滑 track，两者都在祖先上留着 transform，rect 会把这些位移算进去，
 * 而 `scrollTop` 不会——混用两套坐标系会让窗口整体错位。offsetTop 是布局量，
 * 对 transform 免疫。
 *
 * 定位祖先链绕过滚动容器时（文档滚动下 body 的 offsetParent 为 null）退回
 * 文档坐标：rect 加当前滚动量就是内容坐标，仍然正确。
 */
export function offsetWithinScrollElement(node: HTMLElement, element: HTMLElement): number {
  if (isDocumentScrollElement(element)) {
    const view = node.ownerDocument.defaultView;
    return node.getBoundingClientRect().top + (view?.scrollY ?? element.scrollTop);
  }
  let offset = 0;
  let current: HTMLElement | null = node;
  while (current && current !== element) {
    offset += current.offsetTop;
    const parent: Element | null = current.offsetParent;
    if (!(parent instanceof HTMLElement)) {
      return (
        node.getBoundingClientRect().top - element.getBoundingClientRect().top + element.scrollTop
      );
    }
    current = parent;
  }
  return offset;
}
