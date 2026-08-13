import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { DanmakuEvent, SiteId } from "@/shared/types/live";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import {
  BILIBILI_DANMAKU_IMAGE_REFERRER_POLICY,
  DANMAKU_IMAGE_HORIZONTAL_GAP,
  DANMAKU_IMAGE_SCALE,
} from "../danmaku/content";
import { subscribeDanmakuBatches } from "../danmaku/eventBus";
import { createShieldMatcher, shouldShowValidatedOnCanvas } from "../danmaku/filter";
import { isMobileClient } from "@/shared/clientPlatform";
import {
  createEngine,
  DANMAKU_SELF_BORDER_PADDING_X,
  DANMAKU_SELF_BORDER_PADDING_Y,
  type DanmakuEngine,
  type DanmakuHit,
  type DanmakuHitBox,
  type TrackItem,
} from "./danmakuEngine";
import { CanvasDanmakuActionMenu, type CanvasDanmakuHoverTarget } from "./CanvasDanmakuActionMenu";
import { danmakuCanvasPixelRatio } from "./framePacing";
import { selfBorderTextBox } from "./selfBorder";
import { cn } from "@/lib/utils";

type CanvasDanmakuProps = {
  className?: string;
  active?: boolean;
  sessionKey?: number | string | null;
  /** Room identity for the hover action menu. Omit to keep the canvas inert. */
  siteId?: SiteId;
  roomId?: string;
  roomTitle?: string;
  roomUserName?: string;
  /**
   * Larger touch/aim targets. Set for a fullscreen stage where the picture is a
   * whole big display away from the user and the compact desktop pill is hard
   * to hit.
   */
  large?: boolean;
};

type TextRaster = {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
  pixelCount: number;
  lastUsedFrame: number;
};

type DanmakuImageAsset = {
  image: HTMLImageElement;
  state: "loading" | "ready" | "failed";
  lastUsedFrame: number;
};

const DANMAKU_FONT_FAMILY = '"Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';
const MAX_RASTER_CSS_WIDTH = 1600;
const MAX_RASTER_DEVICE_PIXELS = 512_000;
const MAX_RASTER_CACHE_PIXELS = 8_000_000;
const MAX_RASTER_CACHE_ITEMS = 96;
const MAX_IMAGE_CACHE_ITEMS = 128;
const MAX_IMAGE_NATURAL_PIXELS = 1_048_576;
const SELF_DANMAKU_BORDER_COLOR = "rgba(255,255,255,0.82)";
const SELF_DANMAKU_BORDER_WIDTH = 1.5;
const HOVER_DANMAKU_BORDER_COLOR = "rgba(255,255,255,0.95)";
const HOVER_DANMAKU_BORDER_WIDTH = 2;
const HOVER_DANMAKU_FILL_COLOR = "rgba(0,0,0,0.34)";
const HOVER_DANMAKU_BORDER_RADIUS = 6;
/**
 * Touch-tap thresholds for selecting a comment.
 *
 * The distance is deliberately *below* the stage's brightness/volume gesture
 * intent threshold (`PLAYER_EDGE_GESTURE_MIN_DISTANCE_PX`, 12px) rather than
 * matching its tap allowance (14px). Selecting a comment claims the `pointerup`,
 * which skips the stage's own gesture teardown, so the two must not be able to
 * trigger on the same contact. Duration matches the stage tap.
 *
 * Copied rather than imported because `PlayerPane` imports this module, and
 * importing back would form a cycle.
 */
export const CANVAS_TAP_MAX_DISTANCE_PX = 11;
export const CANVAS_TAP_MAX_DURATION_MS = 320;
/**
 * Extra hit padding applied to the drawn box on touch.
 *
 * A finger is far less precise than a cursor and a comment is only one line
 * tall, so the bare glyph box is unrealistically hard to land on. This widens
 * only the *test*, never the drawn border.
 */
export const TOUCH_HIT_SLOP_PX = 10;

/** A short, mostly stationary touch selects a comment rather than starting a drag. */
export function isCanvasDanmakuTap(deltaX: number, deltaY: number, durationMs: number): boolean {
  return (
    durationMs >= 0 &&
    durationMs <= CANVAS_TAP_MAX_DURATION_MS &&
    Math.hypot(deltaX, deltaY) <= CANVAS_TAP_MAX_DISTANCE_PX
  );
}

/** Grow a drawn box by the touch slop. Used for hit testing only. */
export function canvasDanmakuTouchHitBox(box: DanmakuHitBox, slop: number): DanmakuHitBox {
  return {
    x: box.x - slop,
    y: box.y - slop,
    width: box.width + slop * 2,
    height: box.height + slop * 2,
  };
}

function canvasFont(fontWeight: number, fontSize: number): string {
  return `${fontWeight} ${fontSize}px ${DANMAKU_FONT_FAMILY}`;
}

/**
 * Grow a content box into its border box. Shared by the self marker and the
 * pointer hover highlight so both outlines sit the same distance from the
 * glyphs.
 */
function danmakuBorderRect(box: DanmakuHitBox): DanmakuHitBox {
  return {
    x: box.x - DANMAKU_SELF_BORDER_PADDING_X,
    y: box.y - DANMAKU_SELF_BORDER_PADDING_Y,
    width: box.width + DANMAKU_SELF_BORDER_PADDING_X * 2,
    height: box.height + DANMAKU_SELF_BORDER_PADDING_Y * 2,
  };
}

/**
 * Box a comment's glyphs actually occupy. `textBaseline` is `"top"`, so `y`
 * anchors the top of the em square rather than the reserved lane line box; see
 * `selfBorder.ts` for why the em square is the box worth wrapping.
 */
function danmakuContentBox(
  item: TrackItem,
  x: number,
  y: number,
  width: number,
  lineHeight: number,
  /**
   * Image emotes are drawn at the full line height, so a rich comment's box
   * already is its content box. Only plain text needs the em-square fit.
   */
  fitToText: boolean,
): DanmakuHitBox {
  const vertical = fitToText
    ? selfBorderTextBox(y, item.fontSize, lineHeight)
    : { top: y, height: lineHeight };
  return { x, y: vertical.top, width, height: vertical.height };
}

function strokeSelfDanmakuBorder(
  ctx: CanvasRenderingContext2D,
  item: TrackItem,
  x: number,
  y: number,
  width: number,
  lineHeight: number,
  /**
   * Image emotes are drawn at the full line height, so a rich comment's reserved
   * box already is its content box. Only plain text needs the em-square fit.
   */
  fitToText = true,
): void {
  if (!item.isSelf) return;
  const rect = danmakuBorderRect(danmakuContentBox(item, x, y, width, lineHeight, fitToText));
  ctx.save();
  ctx.strokeStyle = SELF_DANMAKU_BORDER_COLOR;
  ctx.lineWidth = SELF_DANMAKU_BORDER_WIDTH;
  ctx.lineJoin = "round";
  ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
  ctx.restore();
}

/**
 * Hover highlight for the comment under the pointer. It is drawn straight onto
 * the live canvas rather than into the cached bitmap: a raster is keyed by the
 * message and reused across frames, while this box follows the pointer and must
 * disappear the moment hover ends.
 */
function strokeHoverDanmakuBorder(ctx: CanvasRenderingContext2D, contentBox: DanmakuHitBox): void {
  const rect = danmakuBorderRect(contentBox);
  ctx.save();
  // The cached rasters carry their own shadow; keep this box shadow-free so a
  // frozen comment does not gain a second outline.
  ctx.shadowColor = "rgba(0,0,0,0)";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
  ctx.beginPath();
  ctx.roundRect(rect.x, rect.y, rect.width, rect.height, HOVER_DANMAKU_BORDER_RADIUS);
  // The backdrop is painted after the glyphs, so compose it underneath them
  // instead of washing them out. The canvas is transparent everywhere the text
  // did not land, which is exactly where this fill should show through.
  ctx.globalCompositeOperation = "destination-over";
  ctx.fillStyle = HOVER_DANMAKU_FILL_COLOR;
  ctx.fill();
  ctx.globalCompositeOperation = "source-over";
  ctx.strokeStyle = HOVER_DANMAKU_BORDER_COLOR;
  ctx.lineWidth = HOVER_DANMAKU_BORDER_WIDTH;
  ctx.lineJoin = "round";
  ctx.stroke();
  ctx.restore();
}

function richLineMetrics(
  ctx: CanvasRenderingContext2D,
  item: TrackItem,
): { contentWidth: number; lineHeight: number; imageSize: number } | null {
  const spans = item.richSpans;
  if (!spans || spans.length === 0) return null;

  const imageSize = item.fontSize * DANMAKU_IMAGE_SCALE;
  let contentWidth = 0;
  for (const span of spans) {
    contentWidth +=
      span.type === "image"
        ? imageSize + DANMAKU_IMAGE_HORIZONTAL_GAP
        : ctx.measureText(span.text).width;
  }
  return {
    contentWidth,
    lineHeight: Math.max(item.fontSize * 1.35, imageSize),
    imageSize,
  };
}

/** Draw ordered text/image spans after their CDN images have been resolved. */
function drawRichDanmaku(
  ctx: CanvasRenderingContext2D,
  item: TrackItem,
  x: number,
  y: number,
  fontWeight: number,
  imageForUrl: (url: string) => HTMLImageElement | null,
): boolean {
  const spans = item.richSpans;
  if (!spans) return false;

  ctx.font = canvasFont(fontWeight, item.fontSize);
  const metrics = richLineMetrics(ctx, item);
  if (!metrics) return false;

  const textY = y + Math.max(0, (metrics.lineHeight - item.fontSize * 1.35) / 2);
  const imageY = y + (metrics.lineHeight - metrics.imageSize) / 2;
  let cursor = x;
  for (const span of spans) {
    if (span.type === "text") {
      ctx.strokeText(span.text, cursor, textY);
      ctx.fillText(span.text, cursor, textY);
      cursor += ctx.measureText(span.text).width;
      continue;
    }

    const image = imageForUrl(span.image_url);
    if (!image) return false;
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0)";
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    ctx.drawImage(
      image,
      cursor + DANMAKU_IMAGE_HORIZONTAL_GAP / 2,
      imageY,
      metrics.imageSize,
      metrics.imageSize,
    );
    ctx.restore();
    cursor += metrics.imageSize + DANMAKU_IMAGE_HORIZONTAL_GAP;
  }
  return true;
}

function richImagesReady(
  item: TrackItem,
  imageForUrl: (url: string) => HTMLImageElement | null,
): boolean {
  let foundImage = false;
  for (const span of item.richSpans ?? []) {
    if (span.type !== "image") continue;
    foundImage = true;
    if (!imageForUrl(span.image_url)) return false;
  }
  return foundImage;
}

/**
 * Rasterizing text once turns the hot render path into one drawImage call per
 * visible comment instead of re-laying out and stroking glyphs every frame.
 * Very long messages intentionally fall back to direct drawing so a malformed
 * event cannot allocate a giant offscreen bitmap.
 */
function createTextRaster(
  item: TrackItem,
  fontWeight: number,
  pixelRatio: number,
  frame: number,
): TextRaster | null {
  const scratch = document.createElement("canvas");
  // Avoid the browser's default 300×150 backing allocation before we know the
  // actual text dimensions.
  scratch.width = 1;
  scratch.height = 1;
  const scratchContext = scratch.getContext("2d");
  if (!scratchContext) return null;

  const font = canvasFont(fontWeight, item.fontSize);
  scratchContext.font = font;
  const textWidth = Math.ceil(scratchContext.measureText(item.text).width);
  const lineWidth = Math.max(2, item.fontSize * 0.13);
  // Include stroke and shadow extents so cached text has the same readable
  // outline as the direct Canvas path without clipping at its edges.
  const offsetX = Math.ceil(lineWidth + 5 + (item.isSelf ? DANMAKU_SELF_BORDER_PADDING_X : 0));
  const offsetY = Math.ceil(lineWidth + 5 + (item.isSelf ? DANMAKU_SELF_BORDER_PADDING_Y : 0));
  const width = textWidth + offsetX * 2;
  const height = Math.ceil(item.fontSize * 1.35) + offsetY * 2;
  const deviceWidth = Math.ceil(width * pixelRatio);
  const deviceHeight = Math.ceil(height * pixelRatio);
  const pixelCount = deviceWidth * deviceHeight;

  if (
    width > MAX_RASTER_CSS_WIDTH ||
    pixelCount > MAX_RASTER_DEVICE_PIXELS ||
    !Number.isFinite(pixelCount)
  ) {
    return null;
  }

  scratch.width = deviceWidth;
  scratch.height = deviceHeight;
  scratchContext.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  scratchContext.font = font;
  scratchContext.textBaseline = "top";
  scratchContext.lineJoin = "round";
  scratchContext.shadowColor = "rgba(0,0,0,0.75)";
  scratchContext.shadowBlur = 2;
  scratchContext.shadowOffsetX = 1;
  scratchContext.shadowOffsetY = 1;
  scratchContext.strokeStyle = "rgba(0,0,0,0.82)";
  scratchContext.lineWidth = lineWidth;
  scratchContext.fillStyle = item.color || "#fff";
  strokeSelfDanmakuBorder(scratchContext, item, offsetX, offsetY, textWidth, item.fontSize * 1.35);
  scratchContext.strokeText(item.text, offsetX, offsetY);
  scratchContext.fillText(item.text, offsetX, offsetY);

  return {
    canvas: scratch,
    width,
    height,
    offsetX,
    offsetY,
    pixelCount,
    lastUsedFrame: frame,
  };
}

/**
 * Rich comments are rasterized only after every image is available. Before
 * that, the caller keeps the normal text bitmap as a visible fallback.
 */
function createRichRaster(
  item: TrackItem,
  fontWeight: number,
  pixelRatio: number,
  frame: number,
  imageForUrl: (url: string) => HTMLImageElement | null,
): TextRaster | null {
  if (!item.richSpans) return null;
  const scratch = document.createElement("canvas");
  scratch.width = 1;
  scratch.height = 1;
  const scratchContext = scratch.getContext("2d");
  if (!scratchContext) return null;

  scratchContext.font = canvasFont(fontWeight, item.fontSize);
  const metrics = richLineMetrics(scratchContext, item);
  if (!metrics) return null;

  const lineWidth = Math.max(2, item.fontSize * 0.13);
  const offsetX = Math.ceil(lineWidth + 5 + (item.isSelf ? DANMAKU_SELF_BORDER_PADDING_X : 0));
  const offsetY = Math.ceil(lineWidth + 5 + (item.isSelf ? DANMAKU_SELF_BORDER_PADDING_Y : 0));
  const width = Math.ceil(metrics.contentWidth) + offsetX * 2;
  const height = Math.ceil(metrics.lineHeight) + offsetY * 2;
  const deviceWidth = Math.ceil(width * pixelRatio);
  const deviceHeight = Math.ceil(height * pixelRatio);
  const pixelCount = deviceWidth * deviceHeight;

  if (
    width > MAX_RASTER_CSS_WIDTH ||
    pixelCount > MAX_RASTER_DEVICE_PIXELS ||
    !Number.isFinite(pixelCount)
  ) {
    return null;
  }

  scratch.width = deviceWidth;
  scratch.height = deviceHeight;
  scratchContext.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  scratchContext.textBaseline = "top";
  scratchContext.lineJoin = "round";
  scratchContext.shadowColor = "rgba(0,0,0,0.75)";
  scratchContext.shadowBlur = 2;
  scratchContext.shadowOffsetX = 1;
  scratchContext.shadowOffsetY = 1;
  scratchContext.strokeStyle = "rgba(0,0,0,0.82)";
  scratchContext.lineWidth = lineWidth;
  scratchContext.fillStyle = item.color || "#fff";
  // Image emotes are drawn at the full line height, so this box is already the
  // real content box.
  strokeSelfDanmakuBorder(
    scratchContext,
    item,
    offsetX,
    offsetY,
    metrics.contentWidth,
    metrics.lineHeight,
    false,
  );
  if (!drawRichDanmaku(scratchContext, item, offsetX, offsetY, fontWeight, imageForUrl)) {
    return null;
  }

  return {
    canvas: scratch,
    width,
    height,
    offsetX,
    offsetY,
    pixelCount,
    lastUsedFrame: frame,
  };
}

export const CanvasDanmaku = memo(function CanvasDanmaku({
  className,
  active = true,
  sessionKey = null,
  siteId,
  roomId,
  roomTitle,
  roomUserName,
  large = false,
}: CanvasDanmakuProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<DanmakuEngine | null>(null);
  const engineSessionRef = useRef<number | string | null>(sessionKey);
  const requestFrameRef = useRef<() => void>(() => {});
  // Desktop uses pointer hover to freeze a comment and show the pill; touch
  // clients select via tap and keep the selection until dismissed. Both afford-
  // ances use the same target state and menu, just different triggers.
  const mobile = useMemo(() => isMobileClient(), []);
  const [hoverTarget, setHoverTarget] = useState<CanvasDanmakuHoverTarget | null>(null);
  /**
   * Box each item was last drawn at, in element-relative CSS pixels. The engine
   * schedules with a reserved width that can exceed the glyphs a frame actually
   * paints, so the hit test reads this instead of the reservation.
   */
  const drawnBoxesRef = useRef(new Map<string, DanmakuHitBox>());
  const hoverKeyRef = useRef<string | null>(null);
  /** Set while the pointer is over the menu, which must not release the freeze. */
  const menuHoveredRef = useRef(false);
  /**
   * Touch contact being evaluated as a possible comment tap. Kept so `pointerup`
   * can reject a drag or a long press, which belong to the stage's own swipe and
   * brightness/volume gestures rather than to comment selection.
   */
  const touchStartRef = useRef<{ id: number; x: number; y: number; at: number } | null>(null);
  /**
   * Called from the render loop, which owns no React state. Held in a ref so the
   * loop effect does not have to re-subscribe when the hover callback changes.
   */
  const syncHoverBoxRef = useRef<(hoverKey: string, box: DanmakuHitBox | null) => void>(() => {});
  const fontSize = useSettingsStore((s) => s.danmakuFontSize);
  const speed = useSettingsStore((s) => s.danmakuSpeed);
  const opacity = useSettingsStore((s) => s.danmakuOpacity);
  const area = useSettingsStore((s) => s.danmakuArea);
  const lineCount = useSettingsStore((s) => s.danmakuLineCount);
  const fontWeight = useSettingsStore((s) => s.danmakuFontWeight);
  const filterRepeats = useSettingsStore((s) => s.danmakuFilterRepeats);
  const mergeWindowSeconds = useSettingsStore((s) => s.danmakuMergeWindowSeconds);
  const filterGifts = useSettingsStore((s) => s.danmakuFilterGifts);
  const shieldWords = useSettingsStore((s) => s.danmakuShieldWords);
  const shieldMatcher = useMemo(() => createShieldMatcher(shieldWords), [shieldWords]);
  const matchersRef = useRef({ shieldMatcher, filterGifts });

  useLayoutEffect(() => {
    matchersRef.current = { shieldMatcher, filterGifts };
  }, [shieldMatcher, filterGifts]);

  const releaseHover = useCallback(() => {
    if (hoverKeyRef.current === null) return;
    hoverKeyRef.current = null;
    engineRef.current?.setPaused(null);
    setHoverTarget(null);
    requestFrameRef.current();
  }, []);

  /** Freeze `hit` and anchor the menu to it. Shared by hover and touch select. */
  const selectHit = useCallback((hit: DanmakuHit) => {
    const engine = engineRef.current;
    if (!engine) return;
    hoverKeyRef.current = hit.item.hoverKey;
    engine.setPaused(hit.item.hoverKey);
    setHoverTarget({
      hoverKey: hit.item.hoverKey,
      content: hit.item.content,
      user: hit.item.user,
      eventKind: hit.item.eventKind,
      left: hit.box.x,
      top: hit.box.y,
      width: hit.box.width,
      height: hit.box.height,
    });
    requestFrameRef.current();
  }, []);

  /** Hit-test in element-relative CSS pixels, which is the engine's own space. */
  const hitTestAt = useCallback((clientX: number, clientY: number, slop = 0): DanmakuHit | null => {
    const engine = engineRef.current;
    const canvas = canvasRef.current;
    if (!engine || !canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const hit = engine.hitTest(clientX - rect.left, clientY - rect.top, (item) => {
      const box = drawnBoxesRef.current.get(item.hoverKey);
      if (!box) return null;
      if (slop === 0) return box;
      // Grow the tested box, not the reported one: the caller anchors the menu
      // to `hit.box`, which must stay the box actually drawn.
      return canvasDanmakuTouchHitBox(box, slop);
    });
    if (!hit || slop === 0) return hit;
    const drawn = drawnBoxesRef.current.get(hit.item.hoverKey);
    return drawn ? { item: hit.item, box: drawn } : hit;
  }, []);

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      if (mobile || !active) return;
      // A touch or pen contact on a desktop-class client still reaches here.
      // Treat only a real mouse as hover so a tap cannot pin a comment with no
      // way to release it.
      if (event.pointerType !== "mouse") return;
      // The pointer stays inside the menu's own bounds while it is used. Keep
      // the current comment frozen instead of hit-testing the gap behind it.
      if (menuHoveredRef.current) return;

      const hit = hitTestAt(event.clientX, event.clientY);
      if (!hit) {
        releaseHover();
        return;
      }
      if (hit.item.hoverKey === hoverKeyRef.current) return;
      selectHit(hit);
    },
    [active, hitTestAt, mobile, releaseHover, selectHit],
  );

  const handlePointerLeave = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      // Moving onto the pill leaves the canvas. Its own enter handler has
      // already claimed the pointer in that case, so keep the freeze.
      if (event.pointerType !== "mouse" || menuHoveredRef.current) return;
      releaseHover();
    },
    [releaseHover],
  );

  /**
   * Touch selection. A tap that lands on a comment claims the press in
   * `onPointerUp` so acting on a comment cannot also toggle playback. Only that
   * press is claimed — see the canvas element for why this layer cannot be
   * excluded from the stage's gestures wholesale.
   */
  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      if (!mobile || !active) return;
      if (event.pointerType === "mouse") return;
      if (!event.isPrimary) return;
      touchStartRef.current = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        at: Date.now(),
      };
    },
    [active, mobile],
  );

  const handlePointerUp = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      const start = touchStartRef.current;
      if (!start || start.id !== event.pointerId) return;
      touchStartRef.current = null;
      if (!mobile || !active) return;

      // A swipe that starts on a comment still pages the view, and a long press
      // still opens the brightness/volume gesture rather than selecting.
      const isTap = isCanvasDanmakuTap(
        event.clientX - start.x,
        event.clientY - start.y,
        Date.now() - start.at,
      );
      if (!isTap) return;

      const hit = hitTestAt(event.clientX, event.clientY, TOUCH_HIT_SLOP_PX);
      if (!hit) {
        // A tap on empty picture dismisses an open selection instead of falling
        // through to the stage, which would also toggle playback.
        if (hoverKeyRef.current !== null) {
          event.preventDefault();
          event.stopPropagation();
          releaseHover();
        }
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      if (hit.item.hoverKey === hoverKeyRef.current) {
        // Tapping the selected comment again closes the menu.
        releaseHover();
        return;
      }
      selectHit(hit);
    },
    [active, hitTestAt, mobile, releaseHover, selectHit],
  );

  const handlePointerCancel = useCallback(() => {
    touchStartRef.current = null;
  }, []);

  useLayoutEffect(() => {
    syncHoverBoxRef.current = (hoverKey, box) => {
      // The loop can run a frame after the pointer already moved on.
      if (hoverKeyRef.current !== hoverKey) return;
      if (!box) {
        hoverKeyRef.current = null;
        menuHoveredRef.current = false;
        setHoverTarget(null);
        return;
      }
      setHoverTarget((current) => {
        if (!current || current.hoverKey !== hoverKey) return current;
        if (
          current.left === box.x &&
          current.top === box.y &&
          current.width === box.width &&
          current.height === box.height
        ) {
          // Every frame reports the box, so bail out unless it really moved.
          return current;
        }
        return { ...current, left: box.x, top: box.y, width: box.width, height: box.height };
      });
    };
    return () => {
      syncHoverBoxRef.current = () => {};
    };
  }, []);

  const handleMenuPointerEnter = useCallback(() => {
    menuHoveredRef.current = true;
  }, []);

  const handleMenuPointerLeave = useCallback(() => {
    menuHoveredRef.current = false;
    releaseHover();
  }, [releaseHover]);

  // Turning the layer off invalidates the selection, and so does a room switch
  // even while it stays on: that replaces the engine, so the frozen comment
  // lived in the one being discarded. Drop it rather than leaving a pill
  // anchored to a comment that no longer exists. (A comment aging out of the
  // bounded render list is handled by `syncHoverBoxRef` above, from the frame
  // that stops reporting its box.)
  useEffect(() => {
    if (active) return;
    menuHoveredRef.current = false;
    touchStartRef.current = null;
    releaseHover();
  }, [active, releaseHover]);

  useEffect(() => {
    menuHoveredRef.current = false;
    touchStartRef.current = null;
    releaseHover();
  }, [releaseHover, sessionKey]);

  if (engineRef.current === null || engineSessionRef.current !== sessionKey) {
    engineSessionRef.current = sessionKey;
    engineRef.current = createEngine({
      fontSize: fontSize || 18,
      speed: speed || 8,
      opacity: opacity ?? 1,
      area: area || 0.9,
      lineCount,
      fontWeight,
      aggregateRepeats: filterRepeats,
      aggregateWindowMs: mergeWindowSeconds * 1_000,
    });
  }

  useEffect(() => {
    engineRef.current?.setOpts({
      fontSize: fontSize || 18,
      speed: speed || 8,
      opacity: opacity ?? 1,
      area: area || 0.9,
      lineCount,
      fontWeight,
      aggregateRepeats: filterRepeats,
      aggregateWindowMs: mergeWindowSeconds * 1_000,
    });
    requestFrameRef.current();
  }, [fontSize, speed, opacity, area, lineCount, fontWeight, filterRepeats, mergeWindowSeconds]);

  useEffect(() => {
    if (!active) return;
    return subscribeDanmakuBatches((events) => {
      const { shieldMatcher: currentShieldMatcher, filterGifts: currentFilterGifts } =
        matchersRef.current;
      const accepted: DanmakuEvent[] = [];
      for (const message of events) {
        // Super Chats are presented by the dedicated bottom-left SC card
        // (SuperChatOverlay) and must not also float as fixed-top danmaku.
        if (message.kind === "super_chat") continue;
        if (!shouldShowValidatedOnCanvas(message, currentFilterGifts)) continue;
        if (currentShieldMatcher(message)) continue;
        accepted.push(message);
      }
      if (accepted.length === 0) return;
      // The listener has already run the structural visibility check with the
      // live gift setting. Enqueue the batch once so a native 20fps batch does
      // not ask the engine to rerun its scheduler for every accepted event.
      engineRef.current?.pushBatch(accepted, true);
      requestFrameRef.current();
    });
  }, [active, sessionKey]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const mobileClient = isMobileClient();
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    let raf: number | null = null;
    let last = performance.now();
    let lastFrameAt = last;
    let ro: ResizeObserver | null = null;
    let resizeRaf: number | null = null;
    let stopped = false;
    let needsDraw = true;
    let width = 0;
    let height = 0;
    let bitmapCssWidth = 0;
    let bitmapCssHeight = 0;
    let pixelRatio = 0;
    const rasterCache = new Map<string, TextRaster>();
    let rasterCachePixels = 0;
    let rasterCachePixelRatio = 0;
    let rasterCacheFontWeight = 0;
    let paintFrame = 0;
    const imageCache = new Map<string, DanmakuImageAsset>();

    const removeRaster = (id: string, raster: TextRaster) => {
      rasterCache.delete(id);
      rasterCachePixels -= raster.pixelCount;
    };

    const clearRasters = () => {
      rasterCache.clear();
      rasterCachePixels = 0;
    };

    const removeImage = (url: string, asset: DanmakuImageAsset) => {
      if (imageCache.get(url) !== asset) return;
      imageCache.delete(url);
      asset.image.onload = null;
      asset.image.onerror = null;
    };

    const evictImage = (): boolean => {
      let oldestUrl: string | null = null;
      let oldestAsset: DanmakuImageAsset | null = null;
      for (const [url, asset] of imageCache) {
        // Keep an in-flight image around until it settles. Evicting it would
        // restart the same network request on every frame under a CDN delay.
        if (asset.state === "loading") continue;
        if (!oldestAsset || asset.lastUsedFrame < oldestAsset.lastUsedFrame) {
          oldestUrl = url;
          oldestAsset = asset;
        }
      }
      if (!oldestUrl || !oldestAsset) return false;
      removeImage(oldestUrl, oldestAsset);
      return true;
    };

    const imageForUrl = (url: string): HTMLImageElement | null => {
      const cached = imageCache.get(url);
      if (cached) {
        cached.lastUsedFrame = paintFrame;
        return cached.state === "ready" ? cached.image : null;
      }

      while (imageCache.size >= MAX_IMAGE_CACHE_ITEMS) {
        if (!evictImage()) return null;
      }

      const image = new Image();
      const asset: DanmakuImageAsset = {
        image,
        state: "loading",
        lastUsedFrame: paintFrame,
      };
      imageCache.set(url, asset);
      image.decoding = "async";
      image.onload = () => {
        if (stopped || imageCache.get(url) !== asset) return;
        const naturalPixels = image.naturalWidth * image.naturalHeight;
        if (
          !Number.isFinite(naturalPixels) ||
          naturalPixels <= 0 ||
          naturalPixels > MAX_IMAGE_NATURAL_PIXELS
        ) {
          asset.state = "failed";
        } else {
          asset.state = "ready";
        }
        requestFrame();
      };
      image.onerror = () => {
        if (stopped || imageCache.get(url) !== asset) return;
        asset.state = "failed";
        requestFrame();
      };
      // These URLs are validated upstream to Bilibili's image hosts. Do not
      // set crossOrigin here: some Bilibili CDNs omit CORS headers, while this
      // canvas is never read back or exported and can safely draw the image.
      // The Tauri page protocol is not an accepted Bilibili CDN Referer, so
      // set this before `src` starts the request (matching the side-list img).
      image.referrerPolicy = BILIBILI_DANMAKU_IMAGE_REFERRER_POLICY;
      image.src = url;
      return null;
    };

    const ensureRasterStyle = (nextFontWeight: number) => {
      if (rasterCachePixelRatio !== pixelRatio || rasterCacheFontWeight !== nextFontWeight) {
        clearRasters();
        rasterCachePixelRatio = pixelRatio;
        rasterCacheFontWeight = nextFontWeight;
      }
    };

    const evictRaster = () => {
      let oldestId: string | null = null;
      let oldestRaster: TextRaster | null = null;
      for (const [id, raster] of rasterCache) {
        if (!oldestRaster || raster.lastUsedFrame < oldestRaster.lastUsedFrame) {
          oldestId = id;
          oldestRaster = raster;
        }
      }
      if (oldestId && oldestRaster) removeRaster(oldestId, oldestRaster);
    };

    const getTextRaster = (
      key: string,
      item: TrackItem,
      currentFontWeight: number,
    ): TextRaster | null => {
      ensureRasterStyle(currentFontWeight);
      const cached = rasterCache.get(key);
      if (cached) {
        cached.lastUsedFrame = paintFrame;
        return cached;
      }

      const raster = createTextRaster(item, currentFontWeight, pixelRatio, paintFrame);
      if (!raster || raster.pixelCount > MAX_RASTER_CACHE_PIXELS) return null;

      while (
        rasterCache.size >= MAX_RASTER_CACHE_ITEMS ||
        rasterCachePixels + raster.pixelCount > MAX_RASTER_CACHE_PIXELS
      ) {
        if (rasterCache.size === 0) return null;
        evictRaster();
      }
      rasterCache.set(key, raster);
      rasterCachePixels += raster.pixelCount;
      return raster;
    };

    const getRichRaster = (
      key: string,
      item: TrackItem,
      currentFontWeight: number,
    ): TextRaster | null => {
      ensureRasterStyle(currentFontWeight);
      const cached = rasterCache.get(key);
      if (cached) {
        cached.lastUsedFrame = paintFrame;
        return cached;
      }

      const raster = createRichRaster(item, currentFontWeight, pixelRatio, paintFrame, imageForUrl);
      if (!raster || raster.pixelCount > MAX_RASTER_CACHE_PIXELS) return null;

      while (
        rasterCache.size >= MAX_RASTER_CACHE_ITEMS ||
        rasterCachePixels + raster.pixelCount > MAX_RASTER_CACHE_PIXELS
      ) {
        if (rasterCache.size === 0) return null;
        evictRaster();
      }
      rasterCache.set(key, raster);
      rasterCachePixels += raster.pixelCount;
      return raster;
    };

    const sweepUnusedRasters = () => {
      // Only touch the cache periodically; its maximum is deliberately small
      // and this keeps the normal paint path allocation- and scan-free.
      if (paintFrame % 120 !== 0) return;
      const oldestAllowedFrame = paintFrame - 1;
      for (const [id, raster] of rasterCache) {
        if (raster.lastUsedFrame < oldestAllowedFrame) removeRaster(id, raster);
      }
    };

    const sweepUnusedImages = () => {
      if (paintFrame % 120 !== 0) return;
      const oldestAllowedFrame = paintFrame - 1;
      for (const [url, asset] of imageCache) {
        if (asset.lastUsedFrame < oldestAllowedFrame) removeImage(url, asset);
      }
    };

    const paint = (dt: number): boolean => {
      const engine = engineRef.current;
      const hadWork = active && Boolean(engine?.hasWork());
      if (engine && active) {
        engine.tick(dt, width, height);
      }
      const hasWork = active && Boolean(engine?.hasWork());

      // Do one clear after state/size changes, then leave an empty canvas
      // completely idle until a new danmaku arrives.
      if (needsDraw || hadWork || hasWork) {
        ctx.clearRect(0, 0, width, height);
      }
      needsDraw = false;

      const visibleItems = engine && active ? engine.visibleItems() : [];
      const drawnBoxes = drawnBoxesRef.current;
      // Rebuilt from the items this frame actually paints, so a comment that
      // scrolled off or was evicted cannot leave a stale hit box behind for the
      // pointer to catch.
      drawnBoxes.clear();
      const hoverKey = hoverKeyRef.current;
      let hoverBox: DanmakuHitBox | null = null;
      if (visibleItems.length > 0 && engine && active) {
        paintFrame += 1;
        const currentFontWeight = engine.fontWeight();
        ensureRasterStyle(currentFontWeight);
        ctx.save();
        ctx.globalAlpha = engine.opacity();
        ctx.textBaseline = "top";
        // Cached rasters already contain their own shadow. Keep the main
        // context shadow-free so drawImage does not apply it a second time.
        ctx.shadowColor = "rgba(0,0,0,0)";
        ctx.shadowBlur = 0;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;

        let directTextActive = false;
        let drawnFontSize = 0;
        let drawnColor = "";

        /**
         * Publish the box this item is being drawn at, for pointer hit testing
         * and for anchoring the action pill. Both use the content box, without
         * the border padding, matching what the engine's own fallback reports.
         */
        const recordBox = (
          item: TrackItem,
          left: number,
          contentWidth: number,
          lineHeight: number,
          fitToText: boolean,
        ) => {
          const box = danmakuContentBox(item, left, item.y, contentWidth, lineHeight, fitToText);
          drawnBoxes.set(item.hoverKey, box);
          if (item.hoverKey === hoverKey) hoverBox = box;
        };

        for (const it of visibleItems) {
          // The engine retains offscreen scrolling items for lane-spacing
          // purposes. Do not start image requests or create a raster until
          // one can actually contribute a pixel to this canvas. Besides
          // avoiding hidden paint work, this keeps a burst of queued rich
          // messages from filling the bounded image cache before they enter
          // the viewport.
          if (it.kind === "scroll" && (it.x >= width || it.x + it.width <= 0)) continue;

          const paintKey = `${it.id}:${it.color}:${it.isSelf ? "self" : "normal"}`;
          const richRasterKey = `${paintKey}:rich`;
          // A rich raster is self-contained, including its image pixels. Once
          // one exists we can continue drawing it even if its source image was
          // later evicted from the separate, bounded image-request cache.
          // Otherwise a cache eviction would briefly regress a live emote to
          // its raw-token fallback while the browser fetched the same URL
          // again.
          const cachedRichRaster = rasterCache.get(richRasterKey);
          if (cachedRichRaster) cachedRichRaster.lastUsedFrame = paintFrame;
          const richReady = Boolean(cachedRichRaster) || richImagesReady(it, imageForUrl);
          const raster = cachedRichRaster
            ? cachedRichRaster
            : richReady
              ? getRichRaster(richRasterKey, it, currentFontWeight)
              : getTextRaster(`${paintKey}:text`, it, currentFontWeight);
          // A rich raster contains full-line-height emotes, so its box is
          // already the content box; a text raster needs the em-square fit.
          const usedRichRaster = Boolean(cachedRichRaster) || (richReady && Boolean(raster));
          let x = it.x;
          if (it.kind === "top") {
            // The engine's width is a scheduling reservation: it can be wider
            // than either the raw fallback text or the resolved rich content.
            // Center against what this frame will actually draw instead.
            let drawableWidth: number;
            if (raster) {
              drawableWidth = raster.width - raster.offsetX * 2;
            } else {
              ctx.font = canvasFont(currentFontWeight, it.fontSize);
              drawableWidth = richReady
                ? (richLineMetrics(ctx, it)?.contentWidth ?? ctx.measureText(it.text).width)
                : ctx.measureText(it.text).width;
            }
            x = Math.max(0, (width - drawableWidth) / 2);
          }

          if (raster) {
            if (directTextActive) {
              ctx.shadowColor = "rgba(0,0,0,0)";
              ctx.shadowBlur = 0;
              ctx.shadowOffsetX = 0;
              ctx.shadowOffsetY = 0;
              directTextActive = false;
            }
            ctx.drawImage(
              raster.canvas,
              x - raster.offsetX,
              it.y - raster.offsetY,
              raster.width,
              raster.height,
            );
            // The raster was built around the real content box, so subtracting
            // its symmetric padding recovers that box without re-measuring.
            recordBox(
              it,
              x,
              raster.width - raster.offsetX * 2,
              raster.height - raster.offsetY * 2,
              !usedRichRaster,
            );
            continue;
          }

          if (richReady) {
            // Very long rich comments bypass the bounded bitmap cache, but
            // still retain their image emotes through this direct fallback.
            ctx.save();
            ctx.font = canvasFont(currentFontWeight, it.fontSize);
            ctx.lineJoin = "round";
            ctx.shadowColor = "rgba(0,0,0,0.75)";
            ctx.shadowBlur = 2;
            ctx.shadowOffsetX = 1;
            ctx.shadowOffsetY = 1;
            ctx.strokeStyle = "rgba(0,0,0,0.82)";
            ctx.lineWidth = Math.max(2, it.fontSize * 0.13);
            ctx.fillStyle = it.color || "#fff";
            const richMetrics = richLineMetrics(ctx, it);
            if (richMetrics) {
              strokeSelfDanmakuBorder(
                ctx,
                it,
                x,
                it.y,
                richMetrics.contentWidth,
                richMetrics.lineHeight,
                false,
              );
              recordBox(it, x, richMetrics.contentWidth, richMetrics.lineHeight, false);
            }
            const drewRich = drawRichDanmaku(ctx, it, x, it.y, currentFontWeight, imageForUrl);
            ctx.restore();
            if (drewRich) {
              directTextActive = false;
              drawnFontSize = 0;
              drawnColor = "";
              continue;
            }
          }

          // Long/invalid messages fall back to the previous direct path. It
          // is uncommon, but keeps rendering resilient without unbounded cache
          // allocations.
          if (!directTextActive) {
            ctx.lineJoin = "round";
            ctx.shadowColor = "rgba(0,0,0,0.75)";
            ctx.shadowBlur = 2;
            ctx.shadowOffsetX = 1;
            ctx.shadowOffsetY = 1;
            ctx.strokeStyle = "rgba(0,0,0,0.82)";
            directTextActive = true;
          }
          if (it.fontSize !== drawnFontSize) {
            drawnFontSize = it.fontSize;
            ctx.font = canvasFont(currentFontWeight, drawnFontSize);
            ctx.lineWidth = Math.max(2, drawnFontSize * 0.13);
          }
          const color = it.color || "#fff";
          if (color !== drawnColor) {
            drawnColor = color;
            ctx.fillStyle = color;
          }
          const directTextWidth = ctx.measureText(it.text).width;
          strokeSelfDanmakuBorder(ctx, it, x, it.y, directTextWidth, it.fontSize * 1.35);
          recordBox(it, x, directTextWidth, it.fontSize * 1.35, true);
          ctx.strokeText(it.text, x, it.y);
          ctx.fillText(it.text, x, it.y);
        }
        ctx.restore();
        sweepUnusedRasters();
        sweepUnusedImages();
      }

      // Drawn after the glyph loop so the highlight sits above neighbouring
      // comments that overlap it, and outside the alpha/shadow state they use.
      if (hoverBox) {
        ctx.save();
        ctx.globalAlpha = 1;
        strokeHoverDanmakuBorder(ctx, hoverBox);
        ctx.restore();
      }
      if (hoverKey !== null) {
        // A frozen comment holds still, so its box rarely moves — but a resize
        // remaps every lane, and a fixed-top comment re-centers whenever its
        // aggregated count grows. A null box means it left the render list
        // (expired as a fixed-top card, or evicted by the visible-item cap);
        // the engine has already dropped its own freeze, so retire the pill.
        syncHoverBoxRef.current(hoverKey, hoverBox);
      }

      return hasWork;
    };

    const resize = () => {
      if (stopped) return;
      const parent = canvas.parentElement;
      if (!parent) return;
      const nextPixelRatio = danmakuCanvasPixelRatio(window.devicePixelRatio, mobileClient);
      const nextWidth = parent.clientWidth;
      const nextHeight = parent.clientHeight;
      const nextCanvasWidth = Math.max(1, Math.floor(nextWidth * nextPixelRatio));
      const nextCanvasHeight = Math.max(1, Math.floor(nextHeight * nextPixelRatio));
      const cssSizeChanged =
        Math.abs(nextWidth - bitmapCssWidth) >= 1.5 ||
        Math.abs(nextHeight - bitmapCssHeight) >= 1.5;

      // ResizeObserver can fire for layout work that leaves the canvas size
      // unchanged. Resetting a canvas erases it and costs a full redraw, so
      // avoid touching its bitmap until a meaningful CSS size or device scale
      // change. The canvas element remains the exact layout size and absorbs
      // sub-pixel viewport jitter through its CSS dimensions.
      if (
        !cssSizeChanged &&
        pixelRatio === nextPixelRatio &&
        bitmapCssWidth > 0 &&
        bitmapCssHeight > 0
      ) {
        width = nextWidth;
        height = nextHeight;
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
        return;
      }

      width = nextWidth;
      height = nextHeight;
      bitmapCssWidth = nextWidth;
      bitmapCssHeight = nextHeight;
      pixelRatio = nextPixelRatio;
      canvas.width = nextCanvasWidth;
      canvas.height = nextCanvasHeight;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);

      // A native window resize can temporarily throttle animation frames while
      // the browser is repeatedly rebuilding the canvas bitmap. Do not charge
      // that layout pause to the next danmaku tick; the engine remaps the
      // existing comments to the new width and they resume at that same visual
      // progress rather than jumping off-screen.
      last = performance.now();
      lastFrameAt = last;
      needsDraw = true;
      if (paint(0)) scheduleFrame();
    };

    const loop = (now: number) => {
      raf = null;
      if (stopped || document.hidden) return;
      if (width <= 0 || height <= 0) return;
      // Keep medium stalls proportional to real time. The engine has its own
      // 200ms upper bound for a long suspension, so this cap only prevents an
      // unusually large browser pause from causing a visible teleport.
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      lastFrameAt = now;
      const hasWork = paint(dt);
      if (hasWork) scheduleFrame();
    };

    function scheduleFrame() {
      if (!stopped && !document.hidden && width > 0 && height > 0 && raf === null) {
        raf = requestAnimationFrame(loop);
      }
    }

    function requestFrame() {
      if (stopped) return;
      needsDraw = true;
      scheduleFrame();
    }

    function restartFrame() {
      if (stopped || document.hidden) return;
      if (raf !== null) cancelAnimationFrame(raf);
      raf = null;
      last = performance.now();
      lastFrameAt = last;
      requestFrame();
    }

    const resumeIfVisible = () => {
      if (document.hidden) return;
      restartFrame();
    };

    requestFrameRef.current = requestFrame;
    resize();
    // Window resizing can deliver several ResizeObserver entries in one
    // paint cycle. Coalesce them so the canvas bitmap is rebuilt at most once
    // per animation frame rather than repeatedly clearing and reallocating it.
    const requestResize = () => {
      if (stopped || resizeRaf !== null) return;
      resizeRaf = requestAnimationFrame(() => {
        resizeRaf = null;
        resize();
      });
    };
    ro = new ResizeObserver(requestResize);
    if (canvas.parentElement) ro.observe(canvas.parentElement);
    document.addEventListener("visibilitychange", resumeIfVisible);
    window.addEventListener("focus", resumeIfVisible);
    const watchdog = window.setInterval(() => {
      if (
        !document.hidden &&
        active &&
        engineRef.current?.hasWork() &&
        performance.now() - lastFrameAt > 2000
      ) {
        restartFrame();
      }
    }, 1000);

    return () => {
      stopped = true;
      if (raf !== null) cancelAnimationFrame(raf);
      if (resizeRaf !== null) cancelAnimationFrame(resizeRaf);
      ro?.disconnect();
      if (requestFrameRef.current === requestFrame) requestFrameRef.current = () => {};
      document.removeEventListener("visibilitychange", resumeIfVisible);
      window.removeEventListener("focus", resumeIfVisible);
      window.clearInterval(watchdog);
      for (const [url, asset] of imageCache) removeImage(url, asset);
    };
  }, [active, sessionKey]);

  return (
    // The wrapper is the canvas's layout parent, which `resize` measures, so it
    // must carry the caller's positioning classes.
    <div className={cn("pointer-events-none absolute inset-0", className)}>
      <canvas
        ref={canvasRef}
        // Decorative: every comment is already in the side list, which is the
        // accessible surface for reading and acting on chat. Pointer selection
        // is a shortcut on top of that.
        aria-hidden
        // Hit testing needs the pointer, hence `pointer-events-auto`. But this
        // is deliberately NOT `data-player-hud`: the layer covers the whole
        // picture, so excluding it wholesale would disable the stage's
        // brightness/volume gestures and tap-to-pause everywhere. On desktop no
        // press is handled here at all; on touch only a press that actually
        // lands on a comment is claimed, in `onPointerUp`.
        className="pointer-events-auto absolute inset-0 h-full w-full"
        onPointerMove={handlePointerMove}
        onPointerLeave={handlePointerLeave}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
      />
      {hoverTarget && (
        <CanvasDanmakuActionMenu
          key={hoverTarget.hoverKey}
          target={hoverTarget}
          siteId={siteId}
          roomId={roomId}
          roomTitle={roomTitle}
          roomUserName={roomUserName}
          // Touch always gets the large pill; a mouse only needs it when the
          // stage is a full display away.
          large={mobile || large}
          onDismiss={mobile ? releaseHover : undefined}
          onPointerEnter={mobile ? undefined : handleMenuPointerEnter}
          onPointerLeave={mobile ? undefined : handleMenuPointerLeave}
        />
      )}
    </div>
  );
});
