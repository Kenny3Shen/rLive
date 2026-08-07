import { memo, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { DanmakuEvent } from "@/shared/types/live";
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
  type TrackItem,
} from "./danmakuEngine";
import {
  canvasFrameIsDue,
  MOBILE_DANMAKU_FRAME_INTERVAL_MS,
  nextCanvasFrameDeadline,
} from "./framePacing";
import { cn } from "@/lib/utils";

type CanvasDanmakuProps = {
  className?: string;
  active?: boolean;
  sessionKey?: number | string | null;
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
// Rendering at a native 2×/3× backing scale makes every full-canvas clear and
// redraw substantially more expensive. Text remains crisp at this cap while
// avoiding the quadratic pixel cost on high-DPI displays.
const MAX_CANVAS_PIXEL_RATIO = 1.5;
const SELF_DANMAKU_BORDER_COLOR = "rgba(255,255,255,0.82)";
const SELF_DANMAKU_BORDER_WIDTH = 1.5;

function canvasFont(fontWeight: number, fontSize: number): string {
  return `${fontWeight} ${fontSize}px ${DANMAKU_FONT_FAMILY}`;
}

function strokeSelfDanmakuBorder(
  ctx: CanvasRenderingContext2D,
  item: TrackItem,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  if (!item.isSelf) return;
  ctx.save();
  ctx.strokeStyle = SELF_DANMAKU_BORDER_COLOR;
  ctx.lineWidth = SELF_DANMAKU_BORDER_WIDTH;
  ctx.lineJoin = "round";
  ctx.strokeRect(
    x - DANMAKU_SELF_BORDER_PADDING_X,
    y - DANMAKU_SELF_BORDER_PADDING_Y,
    width + DANMAKU_SELF_BORDER_PADDING_X * 2,
    height + DANMAKU_SELF_BORDER_PADDING_Y * 2,
  );
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
  strokeSelfDanmakuBorder(
    scratchContext,
    item,
    offsetX,
    offsetY,
    metrics.contentWidth,
    metrics.lineHeight,
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
}: CanvasDanmakuProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<DanmakuEngine | null>(null);
  const engineSessionRef = useRef<number | string | null>(sessionKey);
  const requestFrameRef = useRef<() => void>(() => {});
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
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf: number | null = null;
    let last = performance.now();
    let lastFrameAt = last;
    let nextFrameDeadline = 0;
    const frameIntervalMs = isMobileClient() ? MOBILE_DANMAKU_FRAME_INTERVAL_MS : 0;
    let ro: ResizeObserver | null = null;
    let resizeRaf: number | null = null;
    let stopped = false;
    let needsDraw = true;
    let width = 0;
    let height = 0;
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

    const resize = () => {
      if (stopped) return;
      const parent = canvas.parentElement;
      if (!parent) return;
      const nextPixelRatio = Math.min(
        Math.max(window.devicePixelRatio || 1, 1),
        MAX_CANVAS_PIXEL_RATIO,
      );
      const nextWidth = parent.clientWidth;
      const nextHeight = parent.clientHeight;
      const nextCanvasWidth = Math.max(1, Math.floor(nextWidth * nextPixelRatio));
      const nextCanvasHeight = Math.max(1, Math.floor(nextHeight * nextPixelRatio));

      // ResizeObserver can fire for layout work that leaves the canvas size
      // unchanged. Resetting a canvas erases it and costs a full redraw, so
      // avoid touching its bitmap until a CSS size or device scale changed.
      if (
        width === nextWidth &&
        height === nextHeight &&
        pixelRatio === nextPixelRatio &&
        canvas.width === nextCanvasWidth &&
        canvas.height === nextCanvasHeight
      ) {
        return;
      }

      width = nextWidth;
      height = nextHeight;
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
      requestFrame();
    };

    const loop = (now: number) => {
      raf = null;
      if (stopped || document.hidden) return;
      if (width <= 0 || height <= 0) return;
      if (!canvasFrameIsDue(now, nextFrameDeadline, frameIntervalMs)) {
        scheduleFrame();
        return;
      }
      nextFrameDeadline = nextCanvasFrameDeadline(now, nextFrameDeadline, frameIntervalMs);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      lastFrameAt = now;
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
              );
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
          strokeSelfDanmakuBorder(
            ctx,
            it,
            x,
            it.y,
            ctx.measureText(it.text).width,
            it.fontSize * 1.35,
          );
          ctx.strokeText(it.text, x, it.y);
          ctx.fillText(it.text, x, it.y);
        }
        ctx.restore();
        sweepUnusedRasters();
        sweepUnusedImages();
      }

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
      nextFrameDeadline = 0;
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
    <canvas
      ref={canvasRef}
      className={cn("pointer-events-none absolute inset-0 h-full w-full", className)}
      aria-hidden
    />
  );
});
