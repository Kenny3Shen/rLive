import { describe, expect, test } from "bun:test";
import { selfBorderTextBox } from "../src/features/room/canvas/selfBorder";

const FONT_SIZE = 18;
/** The lane height the engine reserves, which the border used to stroke. */
const RESERVED_LINE_HEIGHT = FONT_SIZE * 1.35;

describe("selfBorderTextBox", () => {
  test("wraps the em square the renderer draws into, not the reserved lane box", () => {
    // textBaseline "top" anchors the top of the em square at y, so [y, y + size]
    // is the box the glyphs occupy and padding around it comes out symmetric.
    const box = selfBorderTextBox(100, FONT_SIZE, RESERVED_LINE_HEIGHT);
    expect(box.top).toBe(100);
    expect(box.height).toBe(FONT_SIZE);
  });

  test("drops the leading that previously pooled below the text", () => {
    // Regression guard: stroking fontSize * 1.35 put ~6px of leading under the
    // glyphs and none above, which read as top-aligned rather than centered.
    const box = selfBorderTextBox(0, FONT_SIZE, RESERVED_LINE_HEIGHT);
    expect(RESERVED_LINE_HEIGHT - box.height).toBeGreaterThan(5);
  });

  test("scales with the configured danmaku font size", () => {
    expect(selfBorderTextBox(0, 32, 32 * 1.35).height).toBe(32);
    expect(selfBorderTextBox(0, 12, 12 * 1.35).height).toBe(12);
  });

  test("stays inside the raster padding the cache allocates", () => {
    // createTextRaster allocates ceil(fontSize * 1.35) + offsetY * 2 with
    // offsetY >= borderPaddingY, so both border edges must fall within that.
    const paddingY = 3;
    const offsetY = Math.ceil(Math.max(2, FONT_SIZE * 0.13) + 5 + paddingY);
    const rasterHeight = Math.ceil(RESERVED_LINE_HEIGHT) + offsetY * 2;
    const box = selfBorderTextBox(offsetY, FONT_SIZE, RESERVED_LINE_HEIGHT);
    expect(box.top - paddingY).toBeGreaterThanOrEqual(0);
    expect(box.top + box.height + paddingY).toBeLessThanOrEqual(rasterHeight);
  });

  test("falls back to the reserved box rather than collapsing the border", () => {
    for (const size of [Number.NaN, 0, -18]) {
      expect(selfBorderTextBox(4, size, RESERVED_LINE_HEIGHT)).toEqual({
        top: 4,
        height: RESERVED_LINE_HEIGHT,
      });
    }
  });
});
