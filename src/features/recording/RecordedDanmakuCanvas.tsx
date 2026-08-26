import { useEffect, useMemo, useRef, type RefObject } from "react";
import {
  clampDanmuArea,
  clampDanmuFontSize,
  clampDanmuFontStroke,
  clampDanmuOpacity,
  danmuLaneHeight,
  safeDanmuColor,
} from "@/features/room/danmaku/danmuJsAdapter";
import {
  DANMAKU_IMAGE_FALLBACK_TEXT,
  DANMAKU_IMAGE_HORIZONTAL_GAP,
} from "@/features/room/danmaku/content";
import { prefersReducedMotion } from "@/shared/motion/preference";
import { parseDanmakuSpeed, useSettingsStore } from "@/shared/stores/settingsStore";
import { filterRecordedDanmakuEntries, type RecordedDanmakuEntry } from "./recordedDanmaku";
import {
  layoutRecordedDanmaku,
  visibleRecordedDanmaku,
  type RecordedDanmakuLayout,
} from "./recordedDanmakuLayout";
import {
  createRecordedDanmakuImageCache,
  recordedDanmakuSegments,
  recordedDanmakuSegmentsWidth,
  recordedDanmakuSpans,
  type RecordedDanmakuSegment,
} from "./recordedDanmakuSpans";

const REDUCED_MOTION_LIFETIME_MS = 4_000;
const MIN_DANMAKU_LIFETIME_MS = 3_500;
const MAX_DANMAKU_LIFETIME_MS = 30_000;
const HORIZONTAL_PADDING = 20;
const FADE_OUT_MS = 500;
/** 同一车道上相邻弹幕之间的横向呼吸间距，以字号比例计。 */
const LANE_GAP_RATIO = 0.6;
const FONT_FAMILY = '"Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';

type RecordedDanmakuCanvasProps = {
  videoRef: RefObject<HTMLVideoElement | null>;
  entries: readonly RecordedDanmakuEntry[];
  active: boolean;
};

/**
 * 由媒体时间驱动的录制回放叠加层。seek 立即重绘，所有外观/过滤选项与直播弹幕
 * 来自同一个设置 store，
 * 使录制不维护第二套视觉配置。
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
    let layout: RecordedDanmakuLayout | null = null;
    const reducedMotion = prefersReducedMotion();
    const lineHeight = danmuLaneHeight(fontSize);
    // 暂停状态的叠加层没有动画帧可以搭车，
    // 迟到的表情需要显式触发一次重绘。
    const images = createRecordedDanmakuImageCache(() => {
      if (video.paused || video.ended) draw();
    });

    // 描边会把绘制出的字形向两侧加宽，因此把它计入预留宽度；
    // 否则间隙处相邻弹幕看起来会粘在一起。
    const strokePadding = fontStroke > 0 ? fontStroke * 2 : 0;
    /**
     * 分段在布局阶段测量，供每一帧绘制该弹幕时复用。
     * key 携带次数，因为不断增长的重复计数会改变尾部的文本分段。
     */
    const segmentCache = new Map<string, RecordedDanmakuSegment[] | null>();

    /** 测量与绘制必须使用同一种字体，否则宽度会产生漂移。 */
    function applyTextStyle(context: CanvasRenderingContext2D) {
      context.font = `700 ${fontSize}px ${FONT_FAMILY}`;
      context.textBaseline = "middle";
      context.lineJoin = "round";
      if (fontStroke > 0) context.lineWidth = fontStroke * 2;
    }

    /** 纯文本弹幕为 null，走更便宜的单次调用路径。 */
    function cachedSegments(
      context: CanvasRenderingContext2D,
      entry: RecordedDanmakuEntry,
      count: number,
    ): RecordedDanmakuSegment[] | null {
      const key = `${entry.sequence}:${count}`;
      const cached = segmentCache.get(key);
      if (cached !== undefined) return cached;
      const spans = recordedDanmakuSpans(entry, count);
      const segments = spans
        ? recordedDanmakuSegments(spans, fontSize, (text) => context.measureText(text).width)
        : null;
      segmentCache.set(key, segments);
      return segments;
    }

    /**
     * 从 `x` 开始逐段绘制一条弹幕，`y` 位于文本基线中心。每个分段按其预留宽度
     * 推进光标，包括图片尚未到达的槽位，因此迟到的表情绝不会移动其后的分段。
     */
    function paintSegments(
      context: CanvasRenderingContext2D,
      segments: readonly RecordedDanmakuSegment[],
      x: number,
      y: number,
    ) {
      let cursor = x;
      for (const segment of segments) {
        if (segment.type === "text") {
          if (fontStroke > 0) context.strokeText(segment.text, cursor, y);
          context.fillText(segment.text, cursor, y);
          cursor += segment.width;
          continue;
        }
        const image = images.resolve(segment.url);
        if (image) {
          context.drawImage(
            image,
            cursor + DANMAKU_IMAGE_HORIZONTAL_GAP / 2,
            y - segment.size / 2,
            segment.size,
            segment.size,
          );
        } else if (images.hasFailed(segment.url)) {
          // 对齐 DOM 层的做法：坏掉的表情替换为文本标记，
          // 而不是在句子里留下一个洞。
          if (fontStroke > 0) context.strokeText(DANMAKU_IMAGE_FALLBACK_TEXT, cursor, y);
          context.fillText(DANMAKU_IMAGE_FALLBACK_TEXT, cursor, y);
        }
        cursor += segment.width;
      }
    }

    function scrollingLifetime(textWidth: number): number {
      const travelDistance = cssWidth + textWidth + HORIZONTAL_PADDING * 2;
      return Math.min(
        MAX_DANMAKU_LIFETIME_MS,
        Math.max(MIN_DANMAKU_LIFETIME_MS, (travelDistance / speed) * 1_000),
      );
    }

    /**
     * 车道分配取决于测量宽度和舞台尺寸，因此这些变化时重建一次，
     * 期间的所有帧复用该结果。
     */
    function buildLayout() {
      const context = canvas.getContext("2d");
      if (!context || visibleEntries.length === 0 || cssWidth <= 1 || cssHeight <= 1) {
        layout = null;
        return;
      }
      applyTextStyle(context);
      segmentCache.clear();
      const usableHeight = Math.max(lineHeight, cssHeight * area);
      const laneCount = Math.max(1, Math.floor((usableHeight - HORIZONTAL_PADDING) / lineHeight));
      const maxLifetime = reducedMotion
        ? REDUCED_MOTION_LIFETIME_MS
        : scrollingLifetime(cssWidth + fontSize * 8);
      layout = layoutRecordedDanmaku(visibleEntries, {
        laneCount,
        stageWidth: cssWidth,
        padding: HORIZONTAL_PADDING,
        laneGap: fontSize * LANE_GAP_RATIO,
        measure: (text, entry, count) => {
          const segments = cachedSegments(context, entry, count);
          const width =
            segments === null
              ? context.measureText(text).width
              : recordedDanmakuSegmentsWidth(segments);
          return width + strokePadding;
        },
        lifetimeFor: (width) =>
          reducedMotion ? REDUCED_MOTION_LIFETIME_MS : scrollingLifetime(width),
        staticLayout: reducedMotion,
        mergeWindowMs: Math.max(0, Math.round(mergeWindowSeconds * 1_000)),
        maxGroupSpanMs: maxLifetime,
      });
    }

    function draw() {
      const context = canvas.getContext("2d");
      if (!context) return;
      context.clearRect(0, 0, cssWidth, cssHeight);
      if (!active || !layout || opacity <= 0) return;

      const currentMs = Math.max(0, video.currentTime * 1_000);
      applyTextStyle(context);

      for (const bullet of visibleRecordedDanmaku(layout, currentMs)) {
        const { placement } = bullet;
        const width = placement.width;
        const x = reducedMotion
          ? Math.max(HORIZONTAL_PADDING, cssWidth - width - HORIZONTAL_PADDING)
          : cssWidth +
            HORIZONTAL_PADDING -
            (cssWidth + width + HORIZONTAL_PADDING * 2) * bullet.progress;
        const y = HORIZONTAL_PADDING + fontSize / 2 + placement.lane * lineHeight;
        const remaining = placement.lifetimeMs - bullet.ageMs;
        const fade = Math.min(1, Math.max(0, remaining / FADE_OUT_MS));
        context.globalAlpha = opacity * fade;
        if (fontStroke > 0) context.strokeStyle = "rgba(0, 0, 0, 0.92)";
        context.fillStyle = safeDanmuColor(
          placement.entry.event.color,
          placement.entry.event.kind === "super_chat" ? "#ffd76a" : "#ffffff",
        );
        const segments = cachedSegments(context, placement.entry, bullet.count);
        if (segments === null) {
          if (fontStroke > 0) context.strokeText(bullet.text, x, y);
          context.fillText(bullet.text, x, y);
          continue;
        }
        paintSegments(context, segments, x, y);
      }
      context.globalAlpha = 1;
    }

    function resize() {
      const rectangle = stage.getBoundingClientRect();
      const nextWidth = Math.max(1, rectangle.width);
      const nextHeight = Math.max(1, rectangle.height);
      const changed = nextWidth !== cssWidth || nextHeight !== cssHeight;
      cssWidth = nextWidth;
      cssHeight = nextHeight;
      const pixelRatio = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
      canvas.width = Math.max(1, Math.round(cssWidth * pixelRatio));
      canvas.height = Math.max(1, Math.round(cssHeight * pixelRatio));
      canvas.style.width = `${cssWidth}px`;
      canvas.style.height = `${cssHeight}px`;
      const context = canvas.getContext("2d");
      context?.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      if (changed || !layout) buildLayout();
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
      images.dispose();
      segmentCache.clear();
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
