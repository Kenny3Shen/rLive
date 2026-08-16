// One backing-store policy for every client.
//
// A fixed device-scale cap is the wrong knob: it is a *ratio*, but the cost it
// is meant to bound is a *pixel count*. The old 1.5x ceiling left a desktop
// 1080p stage untouched (its ratio is 1) while cutting a phone's 2.75x screen
// almost in half — so the glyph bitmap was upscaled into the display and read
// visibly softer than the DOM text right next to it.
//
// Bound the backing store by total device pixels instead. A phone's picture is
// physically small in CSS pixels, so it can afford its full device scale; a
// fullscreen high-DPI desktop stage is the case that actually needs reining in.
export const DANMAKU_MAX_PIXEL_RATIO = 3;
// 4K worth of backing store, which is the largest surface the old flat 1.5x
// ceiling could already produce on a 1440p retina desktop stage. Keeping that
// as the ceiling means this change never asks any client for more per-frame
// pixel throughput than it was already handling — it only redistributes the
// allowance towards the physically small surfaces that were starved by a ratio
// cap.
export const DANMAKU_MAX_BACKING_PIXELS = 8_294_400;

/**
 * Upper bound on the frame delta handed to the engine, in seconds.
 *
 * The previous 0.1s bound sat *below* the hiccups an Android WebView actually
 * produces while the video decoder is busy. A 150ms gap then advanced every
 * comment by only 100ms, so the hiccup did not merely drop a frame — it also
 * silently slowed the motion and let it snap back afterwards, which is what
 * reads as stutter rather than as one missed frame. Charging the real elapsed
 * time keeps the on-screen velocity constant in wall-clock terms, the same
 * guarantee a single linear CSS transition gives; bytedance/danmu.js drives its
 * bullets exactly that way, reconstructing position from `pastDuration * moveV`
 * whenever it has to compute one itself.
 *
 * The bound only exists so a genuine multi-second suspension cannot teleport a
 * comment across the picture. `visibilitychange` / `focus` already restart the
 * clock for the common suspension cases, so this is the rare-path guard.
 */
export const DANMAKU_MAX_FRAME_SECONDS = 0.25;

/**
 * Device scale for the danmaku canvas backing store.
 *
 * `cssWidth`/`cssHeight` are the canvas's layout size. Omit them (or pass a
 * degenerate size) to get the plain device-scale ceiling, which is what a
 * caller that has not measured its parent yet should use.
 */
export function danmakuCanvasPixelRatio(
  devicePixelRatio: number,
  cssWidth = 0,
  cssHeight = 0,
): number {
  const safePixelRatio = Number.isFinite(devicePixelRatio) ? Math.max(devicePixelRatio, 1) : 1;
  const capped = Math.min(safePixelRatio, DANMAKU_MAX_PIXEL_RATIO);

  const area = cssWidth * cssHeight;
  if (!Number.isFinite(area) || area <= 0) return capped;

  const budgetRatio = Math.sqrt(DANMAKU_MAX_BACKING_PIXELS / area);
  // The picture fits the budget at its native scale, which is the case worth
  // keeping exact: one device pixel per backing pixel, no resampling at all.
  if (budgetRatio >= capped) return capped;

  // Quantize only the budget-limited result. This ratio is an input to the
  // raster cache key, so letting it track every sub-pixel layout wobble would
  // throw away every cached glyph bitmap during a window drag.
  return Math.max(1, Math.floor(budgetRatio * 4) / 4);
}

/**
 * Round a CSS-pixel coordinate so it lands on a whole device pixel.
 *
 * The canvas context carries a `pixelRatio` transform, so the values that reach
 * an integer device pixel are multiples of `1 / pixelRatio` — not integer CSS
 * values, which at 2.75x still land three quarters of a pixel off. Blitting a
 * cached glyph bitmap to a fractional device offset makes the compositor
 * resample it, which softens the text and, because a scrolling comment's
 * sub-pixel phase changes every frame, makes the same glyph shimmer as it
 * travels.
 */
export function snapToDevicePixel(value: number, pixelRatio: number): number {
  if (!Number.isFinite(value)) return value;
  if (!Number.isFinite(pixelRatio) || pixelRatio <= 0) return value;
  return Math.round(value * pixelRatio) / pixelRatio;
}

/**
 * Never quantize the axis a comment travels along.
 *
 * Snapping is unambiguously right for a coordinate that is *constant* over the
 * item's flight: the glyph bitmap lands 1:1 on the display and nothing about it
 * changes between frames. Applying the same rounding to the moving axis looks
 * like a similar trade, but it is not — it trades a static, sub-pixel error for
 * a *dynamic* one, and the eye is far more sensitive to the second.
 *
 * At the default speed a comment travels 197px/s, so at 60fps it advances 3.3
 * CSS px per frame. Rounding that to whole device pixels cannot produce a
 * constant step: the position lands on alternating floor/ceil values, so the
 * comment moves 3,3,4,3,3,4… device pixels per frame. That is a ±30% velocity
 * jitter at frame rate on a 1x display — read as the shearing, out-of-vsync
 * judder this constant is named after. The error it buys back is at most half a
 * device pixel of static blur on a bitmap that is already moving.
 *
 * Crucially, the jitter gets *worse* as the density drops, not better: the
 * quantum is a whole device pixel either way, so the smaller the per-frame step
 * measured in device pixels, the larger a fraction of it the rounding is. A 1x
 * desktop is therefore the worst case (±30%), not the safe one, which is why
 * gating this by density was backwards.
 *
 * bytedance/danmu.js reaches the same place from the other direction: it hands
 * one linear `transform` transition to the compositor and never rounds the
 * interpolated position at all. Sub-pixel positioning of a moving object is
 * what the compositor is for.
 */
export function snapStaticAxis(value: number, pixelRatio: number): number {
  return snapToDevicePixel(value, pixelRatio);
}

/**
 * Readability outline for a glyph size — the v0.43.1 values.
 *
 * These are deliberately the *original* numbers: `max(2, fontSize * 0.13)` for
 * the stroke and a fixed `blur 2 / offset 1 / alpha 0.75` shadow. A round of
 * blurriness work thinned the stroke to `clamp(fontSize * 0.1, 1, 3)`, dropped
 * the shadow alpha to 0.55 and tied the blur to the stroke width. That removed
 * 23–52% of the outline at every size (the 3px ceiling cost a 48px comment more
 * than half of it) and the text lost the weight that makes it readable over
 * moving video without the eye having to work — which is the tiring part.
 *
 * The reasoning behind thinning it was wrong about the cause. Small-font
 * softness came from the backing store being capped by device *ratio* instead of
 * by total pixel count, so the glyph bitmap was upscaled into the display; that
 * is fixed by `danmakuCanvasPixelRatio` and needs nothing from the outline. A
 * stroke is centered on the letterform, so half of it does eat inward — but at
 * 12px `max(2, …)` yields exactly 2px, i.e. 1px inward, which is what gives a
 * thin glyph a defined dark edge rather than erasing it.
 *
 * Keep the shadow independent of `lineWidth`. Tying them made the shadow shrink
 * exactly where the stroke was already thinnest, so the two losses compounded.
 */
export function danmakuOutline(fontSize: number): {
  lineWidth: number;
  shadowBlur: number;
  shadowOffset: number;
  shadowAlpha: number;
} {
  const safeFontSize = Number.isFinite(fontSize) && fontSize > 0 ? fontSize : 18;
  return {
    lineWidth: Math.max(2, safeFontSize * 0.13),
    shadowBlur: 2,
    shadowOffset: 1,
    shadowAlpha: 0.75,
  };
}
