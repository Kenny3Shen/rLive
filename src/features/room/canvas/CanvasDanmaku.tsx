import { useEffect, useRef } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { DanmakuEvent } from "@/shared/types/live";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import { createEngine, type DanmakuEngine } from "./danmakuEngine";
import { cn } from "@/lib/utils";

type CanvasDanmakuProps = {
  className?: string;
  active?: boolean;
};

export function CanvasDanmaku({ className, active = true }: CanvasDanmakuProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<DanmakuEngine | null>(null);
  const fontSize = useSettingsStore((s) => s.danmakuFontSize);
  const speed = useSettingsStore((s) => s.danmakuSpeed);
  const opacity = useSettingsStore((s) => s.danmakuOpacity);
  const shieldWords = useSettingsStore((s) => s.danmakuShieldWords);

  useEffect(() => {
    engineRef.current = createEngine({
      fontSize: fontSize || 18,
      speed: speed || 8,
      opacity: opacity ?? 1,
    });
  }, []);

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
    const shield = shieldWords.map((w) => w.toLowerCase()).filter(Boolean);

    void listen<DanmakuEvent>("danmaku", (event) => {
      if (cancelled) return;
      const msg = event.payload;
      if (!msg?.content?.trim()) return;
      if (msg.kind === "system") return;
      const lower = msg.content.toLowerCase();
      if (shield.some((w) => lower.includes(w))) return;
      engineRef.current?.push(msg);
    }).then((fn) => {
      unlisten = fn;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [active, shieldWords]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let last = performance.now();
    let ro: ResizeObserver | null = null;

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
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      const engine = engineRef.current;
      if (engine && active) {
        engine.tick(dt, w, h);
      }
      ctx.clearRect(0, 0, w, h);
      if (engine) {
        ctx.globalAlpha = engine.opacity();
        ctx.textBaseline = "top";
        ctx.font = `600 ${fontSize || 18}px "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif`;
        ctx.shadowColor = "rgba(0,0,0,0.75)";
        ctx.shadowBlur = 3;
        ctx.shadowOffsetX = 1;
        ctx.shadowOffsetY = 1;
        for (const it of engine.visibleItems()) {
          ctx.fillStyle = it.color || "#fff";
          if (it.kind === "top") {
            const x = (w - it.width) / 2;
            ctx.fillText(it.text, x, it.y);
          } else {
            ctx.fillText(it.text, it.x, it.y);
          }
        }
        ctx.shadowBlur = 0;
        ctx.globalAlpha = 1;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      ro?.disconnect();
    };
  }, [active, fontSize]);

  return (
    <canvas
      ref={canvasRef}
      className={cn("pointer-events-none absolute inset-0 h-full w-full", className)}
      aria-hidden
    />
  );
}
