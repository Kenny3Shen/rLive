/**
 * Retention window for the chat list's rendered rows.
 *
 * A scroll viewport is positioned by `scrollTop`, measured from the top of its
 * content. Removing the oldest rows therefore moves every remaining row up by
 * the removed height. While the reader is pinned to the newest message that
 * shift is invisible, because the bottom of the content stays put and the
 * browser clamps `scrollTop` to the shorter content. While the reader is
 * parked in history it is very visible: the list slides out from under them on
 * every flush, and at `scrollTop === 0` it looks like the feed is scrolling by
 * itself even though the scrollbar cannot move.
 *
 * So trimming is aggressive only while pinned. While scrolled up the list
 * grows instead, and the panel's layout effect enforces the larger window with
 * an explicit scroll compensation.
 */

/** Rows retained while the feed is pinned to the newest message. */
export const DANMAKU_LIST_MAX_PINNED = 300;

/**
 * Rows retained while the reader is parked in history. This bounds the DOM for
 * a reader who leaves the panel scrolled up in a very busy room; past it the
 * oldest rows have to go, because the alternative is unbounded growth.
 */
export const DANMAKU_LIST_MAX_SCROLLED_UP = 1_200;

/**
 * Capacity for appending a flushed batch.
 *
 * Unbounded while scrolled up on purpose: a trim there has to measure the rows
 * it removes to keep the reading position, which only the panel's layout
 * effect can do. It bounds the list to `DANMAKU_LIST_MAX_SCROLLED_UP` in the
 * same frame, so growth beyond that never reaches the screen.
 */
export function danmakuListAppendCapacity(pinnedToBottom: boolean): number {
  return pinnedToBottom ? DANMAKU_LIST_MAX_PINNED : Number.POSITIVE_INFINITY;
}

/**
 * Appends a flushed batch, dropping the oldest rows only past `capacity`.
 *
 * Returns the previous array unchanged when there is nothing to append so a
 * caller passing this to `setItems` cannot schedule an empty re-render.
 */
export function appendWithinDanmakuListWindow<T>(
  previous: readonly T[],
  batch: readonly T[],
  capacity: number,
): readonly T[] {
  if (batch.length === 0) return previous;
  const next = previous.concat(batch);
  return next.length <= capacity ? next : next.slice(next.length - capacity);
}

/**
 * Shrinks a list back into `capacity`, preserving the newest rows.
 *
 * Returns the same reference when it already fits, which keeps the caller's
 * `setItems` from committing an identical tree.
 */
export function trimToDanmakuListWindow<T>(items: readonly T[], capacity: number): readonly T[] {
  return items.length <= capacity ? items : items.slice(items.length - capacity);
}

/**
 * The `scrollTop` that keeps the reading position after rows above it were
 * removed, given the viewport's content height before and after the trim.
 *
 * Rows are only ever removed from the top of this list, so the whole height
 * difference sits above the reader and has to come off the scroll offset.
 * A grown or unchanged content height means nothing was removed, so the offset
 * is kept as is rather than guessed at.
 */
export function scrollTopAfterDanmakuListTrim(
  scrollTop: number,
  heightBeforeTrim: number,
  heightAfterTrim: number,
): number {
  const removed = heightBeforeTrim - heightAfterTrim;
  if (!(removed > 0)) return scrollTop;
  return Math.max(0, scrollTop - removed);
}
