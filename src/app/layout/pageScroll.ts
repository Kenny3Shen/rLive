/**
 * Shell 页面滚动容器的滚动记忆。
 *
 * 打开房间会整个卸载该滚动容器 —— 沉浸播放器接管内容面板 —— 因此 DOM 无法
 * 跨访问保存位置。位置因此存放在这里、React 之外，按历史记录为键，
 * 并在用户后退回到离开的记录时回放。
 */

type NavigationType = "POP" | "PUSH" | "REPLACE";

/** 设置上限，避免长时间浏览无限累积历史条目。 */
export const PAGE_SCROLL_MEMORY_LIMIT = 64;

/** 恢复流程等待列表达到完整高度所允许的帧数。 */
export const PAGE_SCROLL_RESTORE_MAX_FRAMES = 20;

/** 锚点恢复停止之前所需的连续对齐帧数。 */
export const PAGE_SCROLL_ANCHOR_STABLE_FRAMES = 3;

/**
 * 连接 key 的各个部分。单元分隔符不可能出现在路径名、平台 id 或关注分组 id 中，
 * 因此两个不同的表面不会碰撞出同一个 key。保留转义形式而不是原始字节：
 * 源码中的字面控制字符会让 git 把本文件当作二进制、停止 diff。
 */
const KEY_SEPARATOR = "\u001f";

export type PageScrollAnchor = Readonly<{
  key: string;
  viewportOffset: number;
}>;

export type PageScrollSnapshot = Readonly<{
  top: number;
  anchor: PageScrollAnchor | null;
}>;

const positions = new Map<string, PageScrollSnapshot>();

function storePageScrollSnapshot(key: string, snapshot: PageScrollSnapshot): void {
  positions.delete(key);
  positions.set(key, snapshot);
  while (positions.size > PAGE_SCROLL_MEMORY_LIMIT) {
    const oldest = positions.keys().next();
    if (oldest.done) break;
    positions.delete(oldest.value);
  }
}

/**
 * 标识一个可滚动的表面。
 *
 * 只有历史记录并不够：切换平台或 IPTV 来源时历史不变但所有行都被替换，
 * 这些表面不得共享记忆中的位置。
 */
export function pageScrollKey(entryKey: string, group: string, subgroup?: string | null): string {
  return `${entryKey}${KEY_SEPARATOR}${group}${KEY_SEPARATOR}${subgroup ?? ""}`;
}

export function rememberPageScroll(key: string, top: number): void {
  if (!Number.isFinite(top)) return;
  // 恢复自身被钳制的写入不得被误认为用户在滚动。
  if (restore?.key === key) return;
  storePageScrollSnapshot(key, { top: Math.max(0, Math.round(top)), anchor: null });
}

/**
 * 同时捕获发起导航的房间卡片与当前像素偏移。锚点能在信息流插入和无限列表
 * 延迟布局后幸存：返回时即使卡片在网格中的绝对位置已变，
 * 也能把同一张卡对齐到同一视口坐标。
 */
export function rememberPageScrollAnchor(
  key: string,
  top: number,
  anchorKey: string,
  viewportOffset: number,
): void {
  if (!Number.isFinite(top) || !Number.isFinite(viewportOffset) || !anchorKey) return;
  storePageScrollSnapshot(key, {
    top: Math.max(0, Math.round(top)),
    anchor: { key: anchorKey, viewportOffset },
  });
}

export function recallPageScroll(key: string): number {
  return positions.get(key)?.top ?? 0;
}

export function recallPageScrollSnapshot(key: string): PageScrollSnapshot {
  return positions.get(key) ?? { top: 0, anchor: null };
}

/**
 * 当前正在回放存储位置的表面（若有）。
 *
 * 恢复过程会在列表长到完整高度之前反复赋值 `scrollTop`，
 * 浏览器每一次钳制后的赋值都会触发 `scroll` 事件。不加防护的话，
 * 滚动监听会记下这些被钳制的值、抹掉恢复正在回放的位置 —— 目标在首次写入
 * 之前就已捕获，所以滚动器能自我纠正，但记忆不能，
 * 再次访问同一历史就会从被截断的偏移开始。
 */
let restore: { readonly key: string } | null = null;

/**
 * 在返回的句柄释放之前，忽略针对 `key` 的 `rememberPageScroll`。
 *
 * 身份凭据是 token 而不是 key：已经被取代的恢复不得释放取代它的那次，
 * 即使两者命名的是同一个表面。因此释放过期句柄是无操作。
 */
export function beginPageScrollRestore(key: string): () => void {
  const token = { key };
  restore = token;
  return () => {
    if (restore === token) restore = null;
  };
}

export function clearPageScrollMemory(): void {
  positions.clear();
  restore = null;
}

export type PageScrollTransition = {
  navigationType: NavigationType;
  previousEntryKey: string;
  entryKey: string;
  previousSurfaceKey: string;
  surfaceKey: string;
};

/**
 * 只有当用户真的前进（或后退）进入一条已经滚动过的历史时，
 * 才回放记住的位置。
 *
 * 必须是历史记录本身发生了变化。平台或 IPTV 来源切换产生的是*同一*记录下的
 * 新表面：那是用户在此位置没有看过的不同内容，所以仍从顶部开始 ——
 * 这正是过去滚动容器以 platform 为 key 时的行为。
 */
export function shouldRestorePageScroll({
  navigationType,
  previousEntryKey,
  entryKey,
  previousSurfaceKey,
  surfaceKey,
}: PageScrollTransition): boolean {
  if (navigationType !== "POP") return false;
  if (previousEntryKey === entryKey) return false;
  return previousSurfaceKey !== surfaceKey;
}

/**
 * 子像素滚动位置在不同 WebView 中舍入方式不同，
 * 而落在目标之后的恢复（最后一页较短）已经近到内容允许的极限。
 */
export function pageScrollRestoreSettled(scrollTop: number, target: number): boolean {
  return scrollTop >= target - 1;
}

/** 把锚点当前的视口偏移换算成所需的 scrollTop。 */
export function pageScrollTargetForAnchor(
  scrollTop: number,
  currentViewportOffset: number,
  savedViewportOffset: number,
): number {
  if (
    !Number.isFinite(scrollTop) ||
    !Number.isFinite(currentViewportOffset) ||
    !Number.isFinite(savedViewportOffset)
  ) {
    return Math.max(0, Number.isFinite(scrollTop) ? scrollTop : 0);
  }
  return Math.max(0, scrollTop + currentViewportOffset - savedViewportOffset);
}

/**
 * 推进（或重置）锚点恢复的稳定帧计数。
 *
 * 路由过渡可能在锚点首次对齐之后的好几帧里改变滚动器的溢出状态。
 * 要求视口偏移与滚动高度同时保持不变，
 * 可防止第一次瞬态对齐过早结束恢复。
 */
export function nextPageScrollAnchorStableFrames(
  currentViewportOffset: number,
  savedViewportOffset: number,
  scrollHeight: number,
  previousScrollHeight: number | null,
  stableFrames: number,
): number {
  const aligned =
    Number.isFinite(currentViewportOffset) &&
    Number.isFinite(savedViewportOffset) &&
    Math.abs(currentViewportOffset - savedViewportOffset) <= 1;
  const layoutStable = previousScrollHeight !== null && scrollHeight === previousScrollHeight;
  return aligned && layoutStable ? stableFrames + 1 : 0;
}
