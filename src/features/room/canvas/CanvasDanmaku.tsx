import { useEffect, useRef } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { DanmakuEvent } from "@/shared/types/live";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import { isShielded, shouldShowOnCanvas } from "../danmaku/filter";
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
  const fontSize = useSettingsStore((s) => s.danmakuFontSize);
  const speed = useSettingsStore((s) => s.danmakuSpeed);
  const opacity = useSettingsStore((s) => s.danmakuOpacity);
  const shieldWords = useSettingsStore((s) => s.danmakuShieldWords);

  if (engineRef.current === null || engineSessionRef.current !== sessionKey) {
    engineSessionRef.current = sessionKey;
    engineRef.current = createEngine({
      fontSize: fontSize || 18,
      speed: speed || 8,
      opacity: opacity ?? 1,
    });
  }

  useEffect(() => {
    engineRef.current?.setOpts({
      fontSize: fontSize || 18,
      speed: speed || 8,
      opacity: opacity ?? 1,
    });
  }, [fontSize, speed, opacity]);

  useEffect(() => {
    if (!active) return;
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;

    void listen<DanmakuEvent>("danmaku", (event) => {
      if (cancelled) return;
      const msg = event.payload;
      if (!shouldShowOnCanvas(msg)) return;
      if (isShielded(msg, shieldWords)) return;
      engineRef.current?.push(msg);
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
  }, [active, sessionKey, shieldWords]);

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

    const resize = () => {
      const parent = canvas.parentElement;
      if (!parent) return;
      const dpr = window.devicePixelRatio || 1;
      const w = parent.clientWidth;
      const h = parent.clientHeight;
      canvas.width = Math.max(1, Math.floor(w * dpr));
      canvas.height = Math.max(1, Math.floor(h * dpr));
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    resize();
    ro = new ResizeObserver(resize);
    if (canvas.parentElement) ro.observe(canvas.parentElement);

    const loop = (now: number) => {
      raf = null;
      if (stopped) return;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      lastFrameAt = now;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      const engine = engineRef.current;
      if (engine && active) {
        engine.tick(dt, w, h);
      }
      ctx.clearRect(0, 0, w, h);
      if (engine) {
        ctx.save();
        ctx.globalAlpha = engine.opacity();
        ctx.textBaseline = "top";
        ctx.lineJoin = "round";
        ctx.shadowColor = "rgba(0,0,0,0.75)";
        ctx.shadowBlur = 2;
        ctx.shadowOffsetX = 1;
        ctx.shadowOffsetY = 1;

        let drawnFontSize = 0;
        for (const it of engine.visibleItems()) {
          if (it.fontSize !== drawnFontSize) {
            drawnFontSize = it.fontSize;
            ctx.font = `600 ${drawnFontSize}px "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif`;
            ctx.lineWidth = Math.max(2, drawnFontSize * 0.13);
          }

          const x = it.kind === "top" ? Math.max(0, (w - it.width) / 2) : it.x;
          ctx.fillStyle = it.color || "#fff";
          ctx.strokeStyle = "rgba(0,0,0,0.82)";
          ctx.strokeText(it.text, x, it.y);
          ctx.fillText(it.text, x, it.y);
        }
        ctx.restore();
      }
      scheduleFrame();
    };

    const scheduleFrame = () => {
      if (!stopped && raf === null) raf = requestAnimationFrame(loop);
    };

    const restartLoop = () => {
      if (stopped) return;
      if (raf !== null) cancelAnimationFrame(raf);
      raf = null;
      last = performance.now();
      lastFrameAt = last;
      scheduleFrame();
    };

    const resumeIfVisible = () => {
      if (!document.hidden) restartLoop();
    };

    document.addEventListener("visibilitychange", resumeIfVisible);
    window.addEventListener("focus", restartLoop);
    const watchdog = window.setInterval(() => {
      if (!document.hidden && performance.now() - lastFrameAt > 2000) restartLoop();
    }, 1000);
    restartLoop();

    return () => {
      stopped = true;
      if (raf !== null) cancelAnimationFrame(raf);
      ro?.disconnect();
      document.removeEventListener("visibilitychange", resumeIfVisible);
      window.removeEventListener("focus", restartLoop);
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
