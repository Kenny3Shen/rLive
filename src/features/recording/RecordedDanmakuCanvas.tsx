import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import { firstRecordedDanmakuAtOrAfter, type RecordedDanmakuEntry } from "./recordedDanmaku";

const DANMAKU_LIFETIME_MS = 8_000;
const REDUCED_MOTION_LIFETIME_MS = 4_000;
const FONT_SIZE = 20;
const LINE_HEIGHT = 32;
const HORIZONTAL_PADDING = 20;
const FONT_FAMILY = '"Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';

function safeTextColor(color: string | null, superChat: boolean): string {
  if (superChat) return "#ffd76a";
  if (color && /^#[0-9a-f]{6}$/i.test(color)) return color;
  return "#ffffff";
}

type RecordedDanmakuCanvasProps = {
  videoRef: RefObject<HTMLVideoElement | null>;
  entries: readonly RecordedDanmakuEntry[];
  active: boolean;
};

/** Video-time-driven canvas; seeking redraws immediately and never replays a
 * queued wall-clock animation from the old position. */
export function RecordedDanmakuCanvas({ videoRef, entries, active }: RecordedDanmakuCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvasElement = canvasRef.current;
    const videoElement = videoRef.current;
    const stageElement = canvasElement?.parentElement;
    if (!canvasElement || !videoElement || !stageElement) return;
    const canvas = canvasElement;
    const video = videoElement;
    const stage = stageElement;

    let animationFrame = 0;
    let cssWidth = 0;
    let cssHeight = 0;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const lifetime = reducedMotion ? REDUCED_MOTION_LIFETIME_MS : DANMAKU_LIFETIME_MS;

    function draw() {
      const context = canvas.getContext("2d");
      if (!context) return;
      context.clearRect(0, 0, cssWidth, cssHeight);
      if (!active || entries.length === 0 || cssWidth <= 1 || cssHeight <= 1) return;

      const currentMs = Math.max(0, video.currentTime * 1_000);
      const first = firstRecordedDanmakuAtOrAfter(entries, currentMs - lifetime);
      const last = firstRecordedDanmakuAtOrAfter(entries, currentMs + 1);
      const tracks = Math.max(1, Math.floor((cssHeight * 0.72) / LINE_HEIGHT));
      context.font = "600 " + FONT_SIZE + "px " + FONT_FAMILY;
      context.textBaseline = "middle";
      context.lineJoin = "round";
      context.lineWidth = 4;

      for (let index = first; index < last; index += 1) {
        const entry = entries[index]!;
        const age = currentMs - entry.offsetMs;
        if (age < 0 || age > lifetime) continue;
        const width = context.measureText(entry.text).width;
        const progress = Math.min(1, age / lifetime);
        const x = reducedMotion
          ? Math.max(HORIZONTAL_PADDING, cssWidth - width - HORIZONTAL_PADDING)
          : cssWidth + HORIZONTAL_PADDING - (cssWidth + width + HORIZONTAL_PADDING * 2) * progress;
        const lane = entry.sequence % tracks;
        const y = HORIZONTAL_PADDING + lane * LINE_HEIGHT;
        context.globalAlpha = Math.min(0.94, Math.max(0, (lifetime - age) / 500));
        context.strokeStyle = "rgba(0, 0, 0, 0.78)";
        context.strokeText(entry.text, x, y);
        context.fillStyle = safeTextColor(entry.event.color, entry.event.kind === "super_chat");
        context.fillText(entry.text, x, y);
      }
      context.globalAlpha = 1;
    }

    function resize() {
      const rectangle = stage.getBoundingClientRect();
      cssWidth = Math.max(1, rectangle.width);
      cssHeight = Math.max(1, rectangle.height);
      const pixelRatio = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
      canvas.width = Math.max(1, Math.round(cssWidth * pixelRatio));
      canvas.height = Math.max(1, Math.round(cssHeight * pixelRatio));
      canvas.style.width = cssWidth + "px";
      canvas.style.height = cssHeight + "px";
      const context = canvas.getContext("2d");
      context?.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      draw();
    }

    function scheduleFrame() {
      window.cancelAnimationFrame(animationFrame);
      if (video.paused || video.ended) {
        draw();
        return;
      }
      const tick = () => {
        draw();
        if (!video.paused && !video.ended) animationFrame = window.requestAnimationFrame(tick);
      };
      animationFrame = window.requestAnimationFrame(tick);
    }

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(stage);
    video.addEventListener("play", scheduleFrame);
    video.addEventListener("pause", scheduleFrame);
    video.addEventListener("seeked", draw);
    video.addEventListener("timeupdate", draw);
    resize();
    scheduleFrame();

    return () => {
      resizeObserver.disconnect();
      window.cancelAnimationFrame(animationFrame);
      video.removeEventListener("play", scheduleFrame);
      video.removeEventListener("pause", scheduleFrame);
      video.removeEventListener("seeked", draw);
      video.removeEventListener("timeupdate", draw);
    };
  }, [active, entries, videoRef]);

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none absolute inset-0 size-full"
      aria-hidden
    />
  );
}
