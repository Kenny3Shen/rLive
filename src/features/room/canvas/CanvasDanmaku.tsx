import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { DanmakuEvent } from "@/shared/types/live";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import { createRepeatMatcher, createShieldMatcher, shouldShowOnCanvas } from "../danmaku/filter";
import { createEngine, type DanmakuEngine } from "./danmakuEngine";
import { cn } from "@/lib/utils";

type CanvasDanmakuProps = {
  className?: string;
  active?: boolean;
  sessionKey?: number | string | null;
};

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

    void listen<DanmakuEvent>("danmaku", (event) => {
      if (cancelled) return;
      const msg = event.payload;
      const {
        shieldMatcher: currentShieldMatcher,
        repeatMatcher: currentRepeatMatcher,
        filterGifts: currentFilterGifts,
      } = matchersRef.current;
      if (!shouldShowOnCanvas(msg, currentFilterGifts)) return;
      if (currentShieldMatcher(msg)) return;
      if (currentRepeatMatcher(msg)) return;
      // The listener has already run the same structural visibility check
      // with the live gift setting. Mark it verified so the engine does not
      // repeat parsing/trimming work for every incoming IPC event.
      engineRef.current?.push(msg, true);
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
        ctx.save();
        ctx.globalAlpha = engine.opacity();
        ctx.textBaseline = "top";
        ctx.lineJoin = "round";
        ctx.shadowColor = "rgba(0,0,0,0.75)";
        ctx.shadowBlur = 2;
        ctx.shadowOffsetX = 1;
        ctx.shadowOffsetY = 1;
        ctx.strokeStyle = "rgba(0,0,0,0.82)";

        let drawnFontSize = 0;
        let drawnFontWeight = 0;
        let drawnColor = "";
        const currentFontWeight = engine.fontWeight();
        for (const it of visibleItems) {
          if (it.fontSize !== drawnFontSize || currentFontWeight !== drawnFontWeight) {
            drawnFontSize = it.fontSize;
            drawnFontWeight = currentFontWeight;
            ctx.font = `${drawnFontWeight} ${drawnFontSize}px "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif`;
            ctx.lineWidth = Math.max(2, drawnFontSize * 0.13);
          }

          const x = it.kind === "top" ? Math.max(0, (width - it.width) / 2) : it.x;
          const color = it.color || "#fff";
          if (color !== drawnColor) {
            drawnColor = color;
            ctx.fillStyle = color;
          }
          ctx.strokeText(it.text, x, it.y);
          ctx.fillText(it.text, x, it.y);
        }
        ctx.restore();
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
