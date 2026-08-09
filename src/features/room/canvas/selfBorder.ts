export type SelfBorderBox = {
  top: number;
  height: number;
};

/**
 * Vertical box the local-account danmaku border should wrap.
 *
 * The engine reserves a lane line box of `fontSize * 1.35` for spacing, but the
 * renderer draws text with `textBaseline = "top"`, which anchors the top of the
 * em square at `y`. Stroking the reserved height therefore dumped all of the
 * leftover leading below the glyphs and left the text pinned to the border's top
 * edge. The em square is the box the text actually occupies, so wrapping that
 * puts equal padding above and below it.
 *
 * Deliberately independent of `measureText`: font-box extents split differently
 * per `textBaseline` and per engine, and per-string ink extents would make the
 * border change height between "啊" and "。" on the same lane. A typical font box
 * runs ~1.15–1.2em, so the existing vertical padding still covers the descenders
 * that reach below the em square.
 */
export function selfBorderTextBox(
  y: number,
  fontSize: number,
  reservedLineHeight: number,
): SelfBorderBox {
  // A degenerate font size would collapse the border, so keep the old reserved
  // box in that case: mildly off-center beats invisible.
  if (!Number.isFinite(fontSize) || fontSize <= 0) return { top: y, height: reservedLineHeight };
  return { top: y, height: fontSize };
}
