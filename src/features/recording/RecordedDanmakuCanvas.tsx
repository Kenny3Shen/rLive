import { useEffect, useMemo, useRef, type RefObject } from "react";
import {
  clampDanmuArea,
  clampDanmuFontSize,
  clampDanmuFontStroke,
  clampDanmuOpacity,
  danmuLaneHeight,
  safeDanmuColor,
} from "@/features/room/danmaku/danmuJsAdapter";
import { parseDanmakuSpeed, useSettingsStore } from "@/shared/stores/settingsStore";
import {
  filterRecordedDanmakuEntries,
  recordedDanmakuFrame,
  type RecordedDanmakuEntry,
} from "./recordedDanmaku";

const REDUCED_MOTION_LIFETIME_MS = 4_000;
const MIN_DANMAKU_LIFETIME_MS = 3_500;
const MAX_DANMAKU_LIFETIME_MS = 30_000;
const MAX_TEXT_TRAVEL_WIDTH_PX = 1_200;
const HORIZONTAL_PADDING = 20;
const FADE_OUT_MS = 500;
const FONT_FAMILY = '"Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';

type RecordedDanmakuCanvasProps = {
  videoRef: RefObject<HTMLVideoElement | null>;
  entries: readonly RecordedDanmakuEntry[];
  active: boolean;
};

/**
 * Media-time-driven recording overlay. Seeking redraws immediately, and every
 * appearance/filter option is sourced from the same settings store as live
 * danmaku so recordings do not maintain a second visual configuration.
 */
export function RecordedDanmakuCanvas({ videoRef, entries, active }: RecordedDanmakuCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fontSize = clampDanmuFontSize(useSettingsStore((state) => state.danmakuFontSize));
  const fontStroke = clampDanmuFontStroke(useSettingsStore((state) => state.danmakuFontStroke));
  const opacity = clampDanmuOpacity(useSettingsStore((state) => state.danmakuOpacity));
  const speed = parseDanmakuSpeed(useSettingsStore((state) => state.danmakuSpeed));
  const area = clampDanmuArea(useSettingsStore((state) => state.danmakuArea));
  const filterGifts = useSettingsStore((state) => state.danmakuFilterGifts);
  const mergeWindowSeconds = useSettingsStore((state) => state.danmakuMergeWindowSeconds);
  const showSuperChat = useSettingsStore((state) => state.superChatEnabled);
  const shieldWords = useSettingsStore((state) => state.danmakuShieldWords);
  const visibleEntries = useMemo(
    () =>
      filterRecordedDanmakuEntries(entries, {
        filterGifts,
        showSuperChat,
        shieldWords,
      }),
    [entries, filterGifts, shieldWords, showSuperChat],
  );

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
    const lineHeight = danmuLaneHeight(fontSize);

    function scrollingLifetime(textWidth: number): number {
      const travelDistance = cssWidth + textWidth + HORIZONTAL_PADDING * 2;
      return Math.min(
        MAX_DANMAKU_LIFETIME_MS,
        Math.max(MIN_DANMAKU_LIFETIME_MS, (travelDistance / speed) * 1_000),
      );
    }

    function frameLookback(): number {
      if (reducedMotion) return REDUCED_MOTION_LIFETIME_MS;
      return scrollingLifetime(Math.min(MAX_TEXT_TRAVEL_WIDTH_PX, cssWidth * 1.5));
    }

    function draw() {
      const context = canvas.getContext("2d");
      if (!context) return;
      context.clearRect(0, 0, cssWidth, cssHeight);
      if (
        !active ||
        visibleEntries.length === 0 ||
        opacity <= 0 ||
        cssWidth <= 1 ||
        cssHeight <= 1
      ) {
        return;
      }

      const currentMs = Math.max(0, video.currentTime * 1_000);
      const frame = recordedDanmakuFrame(
        visibleEntries,
        currentMs,
        frameLookback(),
        mergeWindowSeconds,
      );
      const usableHeight = Math.max(lineHeight, cssHeight * area);
      const tracks = Math.max(1, Math.floor((usableHeight - HORIZONTAL_PADDING) / lineHeight));
      context.font = `700 ${fontSize}px ${FONT_FAMILY}`;
      context.textBaseline = "middle";
      context.lineJoin = "round";
      if (fontStroke > 0) context.lineWidth = fontStroke * 2;

      for (const entry of frame) {
        const age = currentMs - entry.offsetMs;
        const width = context.measureText(entry.text).width;
        const lifetime = reducedMotion ? REDUCED_MOTION_LIFETIME_MS : scrollingLifetime(width);
        if (age < 0 || age > lifetime) continue;

        const progress = Math.min(1, age / lifetime);
        const x = reducedMotion
          ? Math.max(HORIZONTAL_PADDING, cssWidth - width - HORIZONTAL_PADDING)
          : cssWidth + HORIZONTAL_PADDING - (cssWidth + width + HORIZONTAL_PADDING * 2) * progress;
        const lane = entry.sequence % tracks;
        const y = HORIZONTAL_PADDING + fontSize / 2 + lane * lineHeight;
        const fade = Math.min(1, Math.max(0, (lifetime - age) / FADE_OUT_MS));
        context.globalAlpha = opacity * fade;
        if (fontStroke > 0) {
          context.strokeStyle = "rgba(0, 0, 0, 0.92)";
          context.strokeText(entry.text, x, y);
        }
        context.fillStyle = safeDanmuColor(
          entry.event.color,
          entry.event.kind === "super_chat" ? "#ffd76a" : "#ffffff",
        );
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
      canvas.style.width = `${cssWidth}px`;
      canvas.style.height = `${cssHeight}px`;
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

    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
    resizeObserver?.observe(stage);
    if (!resizeObserver) window.addEventListener("resize", resize);
    video.addEventListener("play", scheduleFrame);
    video.addEventListener("pause", scheduleFrame);
    video.addEventListener("seeked", draw);
    video.addEventListener("timeupdate", draw);
    resize();
    scheduleFrame();

    return () => {
      resizeObserver?.disconnect();
      if (!resizeObserver) window.removeEventListener("resize", resize);
      window.cancelAnimationFrame(animationFrame);
      video.removeEventListener("play", scheduleFrame);
      video.removeEventListener("pause", scheduleFrame);
      video.removeEventListener("seeked", draw);
      video.removeEventListener("timeupdate", draw);
    };
  }, [
    active,
    area,
    fontSize,
    fontStroke,
    mergeWindowSeconds,
    opacity,
    speed,
    videoRef,
    visibleEntries,
  ]);

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none absolute inset-0 size-full"
      aria-hidden
    />
  );
}
