import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { DanmakuEvent } from "@/shared/types/live";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import { batchEvents, type DanmakuBatch } from "../danmaku/batch";
import { createRepeatMatcher, createShieldMatcher, shouldShowOnCanvas } from "../danmaku/filter";
import { createEngine, type DanmakuEngine, type TrackItem } from "./danmakuEngine";
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

const DANMAKU_FONT_FAMILY = '"Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';
const MAX_RASTER_CSS_WIDTH = 1600;
const MAX_RASTER_DEVICE_PIXELS = 512_000;
const MAX_RASTER_CACHE_PIXELS = 8_000_000;
const MAX_RASTER_CACHE_ITEMS = 96;

function canvasFont(fontWeight: number, fontSize: number): string {
  return `${fontWeight} ${fontSize}px ${DANMAKU_FONT_FAMILY}`;
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
  const offsetX = Math.ceil(lineWidth + 5);
  const offsetY = Math.ceil(lineWidth + 5);
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

export function CanvasDanmaku({ className, active = true, sessionKey = null }: CanvasDanmakuProps) {
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
  const filterGifts = useSettingsStore((s) => s.danmakuFilterGifts);
  const shieldWords = useSettingsStore((s) => s.danmakuShieldWords);
  const shieldMatcher = useMemo(() => createShieldMatcher(shieldWords), [shieldWords]);
  const repeatMatcher = useMemo(() => createRepeatMatcher(filterRepeats), [filterRepeats]);
  const matchersRef = useRef({ shieldMatcher, repeatMatcher, filterGifts });

  useLayoutEffect(() => {
    matchersRef.current = { shieldMatcher, repeatMatcher, filterGifts };
  }, [shieldMatcher, repeatMatcher, filterGifts]);

  if (engineRef.current === null || engineSessionRef.current !== sessionKey) {
    engineSessionRef.current = sessionKey;
    engineRef.current = createEngine({
      fontSize: fontSize || 18,
      speed: speed || 8,
      opacity: opacity ?? 1,
      area: area || 0.9,
      lineCount,
      fontWeight,
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
    });
    requestFrameRef.current();
  }, [fontSize, speed, opacity, area, lineCount, fontWeight]);

  useEffect(() => {
    if (!active) return;
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;

    void listen<DanmakuBatch>("danmaku-batch", (event) => {
      if (cancelled) return;
      const {
        shieldMatcher: currentShieldMatcher,
        repeatMatcher: currentRepeatMatcher,
        filterGifts: currentFilterGifts,
      } = matchersRef.current;
      const accepted: DanmakuEvent[] = [];
      for (const message of batchEvents(event.payload)) {
        if (!shouldShowOnCanvas(message, currentFilterGifts)) continue;
        if (currentShieldMatcher(message)) continue;
        if (currentRepeatMatcher(message)) continue;
        accepted.push(message);
      }
      if (accepted.length === 0) return;
      // The listener has already run the structural visibility check with the
      // live gift setting. Enqueue the batch once so a native 20fps batch does
      // not ask the engine to rerun its scheduler for every accepted event.
      engineRef.current?.pushBatch(accepted, true);
      requestFrameRef.current();
    })
      .then((fn) => {
        if (cancelled) {
          void fn();
          return;
        }
        unlisten = fn;
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [active, sessionKey]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf: number | null = null;
    let last = performance.now();
    let lastFrameAt = last;
    let ro: ResizeObserver | null = null;
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

    const removeRaster = (id: string, raster: TextRaster) => {
      rasterCache.delete(id);
      rasterCachePixels -= raster.pixelCount;
    };

    const clearRasters = () => {
      rasterCache.clear();
      rasterCachePixels = 0;
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

    const getTextRaster = (item: TrackItem, currentFontWeight: number): TextRaster | null => {
      ensureRasterStyle(currentFontWeight);
      const cached = rasterCache.get(item.id);
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
      rasterCache.set(item.id, raster);
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

    const resize = () => {
      if (stopped) return;
      const parent = canvas.parentElement;
      if (!parent) return;
      const nextPixelRatio = window.devicePixelRatio || 1;
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
          const x = it.kind === "top" ? Math.max(0, (width - it.width) / 2) : it.x;
          // The engine keeps offscreen items long enough to retain safe lane
          // spacing. They still need no canvas work until a pixel can appear.
          if (it.kind === "scroll" && (x >= width || x + it.width <= 0)) continue;

          const raster = getTextRaster(it, currentFontWeight);
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
          ctx.strokeText(it.text, x, it.y);
          ctx.fillText(it.text, x, it.y);
        }
        ctx.restore();
        sweepUnusedRasters();
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
      requestFrame();
    }

    const resumeIfVisible = () => {
      if (document.hidden) return;
      restartFrame();
    };

    requestFrameRef.current = requestFrame;
    resize();
    ro = new ResizeObserver(resize);
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
      ro?.disconnect();
      if (requestFrameRef.current === requestFrame) requestFrameRef.current = () => {};
      document.removeEventListener("visibilitychange", resumeIfVisible);
      window.removeEventListener("focus", resumeIfVisible);
      window.clearInterval(watchdog);
    };
  }, [active, sessionKey]);

  return (
    <canvas
      ref={canvasRef}
      className={cn("pointer-events-none absolute inset-0 h-full w-full", className)}
      aria-hidden
    />
  );
}
