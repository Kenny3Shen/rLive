/**
 * Scroll memory for the Shell's page scroller.
 *
 * Opening a room unmounts that scroller outright — the immersive player takes
 * over the content pane — so the DOM cannot carry the position across a visit.
 * Positions therefore live here, outside React, keyed by history entry, and
 * are replayed when the user pops back to the entry they left from.
 */

type NavigationType = "POP" | "PUSH" | "REPLACE";

/** Bounded so a long browsing session cannot accumulate entries indefinitely. */
export const PAGE_SCROLL_MEMORY_LIMIT = 64;

/** Frames a restore may spend waiting for the list to reach its full height. */
export const PAGE_SCROLL_RESTORE_MAX_FRAMES = 20;

/**
 * Joins the key parts. A unit separator cannot occur in a pathname, platform id
 * or follow group id, so no two distinct surfaces can collide on one key. Kept
 * as an escape rather than a raw byte: a literal control character in the
 * source makes git treat this file as binary and stop diffing it.
 */
const KEY_SEPARATOR = "\u001f";

const positions = new Map<string, number>();

/**
 * Identifies one scrollable surface.
 *
 * A history entry alone is not enough: switching platform or IPTV source keeps
 * the same entry while replacing every row, and those surfaces must not share
 * a remembered position.
 */
export function pageScrollKey(entryKey: string, group: string, subgroup?: string | null): string {
  return `${entryKey}${KEY_SEPARATOR}${group}${KEY_SEPARATOR}${subgroup ?? ""}`;
}

export function rememberPageScroll(key: string, top: number): void {
  if (!Number.isFinite(top)) return;
  // A restore's own clamped writes must not be mistaken for the user scrolling.
  if (restore?.key === key) return;
  // Re-inserting moves the key to the end of the iteration order, so eviction
  // drops the surface the user has been away from longest rather than one they
  // are still moving between.
  positions.delete(key);
  positions.set(key, Math.max(0, Math.round(top)));
  while (positions.size > PAGE_SCROLL_MEMORY_LIMIT) {
    const oldest = positions.keys().next();
    if (oldest.done) break;
    positions.delete(oldest.value);
  }
}

export function recallPageScroll(key: string): number {
  return positions.get(key) ?? 0;
}

/**
 * Surface whose stored position is currently being replayed, if any.
 *
 * A restore assigns `scrollTop` repeatedly while the list grows into its full
 * height, and every assignment the browser clamps still fires a `scroll` event.
 * Left unguarded, the scroll listener records those clamped values and erases
 * the position the restore is in the middle of replaying — the goal is captured
 * before the first write, so the scroller recovers, but the memory does not, and
 * a second visit to the same entry starts from the truncated offset.
 */
let restore: { readonly key: string } | null = null;

/**
 * Ignore `rememberPageScroll` for `key` until the returned handle is released.
 *
 * Identity is the token, not the key: a restore that has already been superseded
 * must not release the one that replaced it, even though both name the same
 * surface. Releasing a stale handle is therefore a no-op.
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
 * A remembered position is replayed only when the user actually travelled back
 * (or forward) into an entry they had already scrolled.
 *
 * The history entry must be the thing that changed. A platform or IPTV source
 * switch produces a new surface under the *same* entry: that is different
 * content the user has not seen at this position, so it still starts at the
 * top — the behaviour the scroller had when it was keyed by platform.
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
 * Sub-pixel scroll positions round differently across WebViews, and a restore
 * that lands past its target (short final page) is already as close as the
 * content allows.
 */
export function pageScrollRestoreSettled(scrollTop: number, target: number): boolean {
  return scrollTop >= target - 1;
}
