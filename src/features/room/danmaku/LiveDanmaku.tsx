import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DanmakuComment } from "./danmakuTypes";
import type { DanmakuCollisionMode, DanmakuEvent, SiteId } from "@/shared/types/live";
import { prefersReducedMotion } from "@/shared/motion/tokens";
import {
  DANMAKU_FONT_STROKE_DEFAULT,
  parseDanmakuSpeed,
  useSettingsStore,
} from "@/shared/stores/settingsStore";
import { cn } from "@/lib/utils";
import { subscribeDanmakuBatches } from "./eventBus";
import {
  createBlockedUserMatcher,
  createDanmakuContentAggregator,
  createShieldMatcher,
  shouldShowValidatedOnFloatingDanmaku,
} from "./filter";
import {
  clampDanmuArea,
  danmakuCommentFromEvent,
  danmakuLayerAreaConfig,
  danmakuLaneCount,
  danmuLaneHeight,
  danmakuMaxActiveComments,
  danmakuRenderLayer,
  enqueueDanmakuPending,
  flushDanmakuPending,
  isPinnedDanmakuEvent,
  updateDanmakuAggregation,
  updateDanmakuAppearance,
  type DanmakuBulletMeta,
  type DanmakuCommentWithMeta,
  type DanmakuPendingEvent,
  type DanmakuRenderLayer,
  DANMAKU_DEFAULT_SPEED,
} from "./danmakuAdapter";
import { loadDanmakuRenderer } from "./danmakuLoader";
import {
  MAX_SUPER_CHAT_DEDUPE_KEYS,
  siteSupportsSuperChat,
  superChatDedupeKey,
} from "../superChat";
import { DanmakuActionMenu, type DanmakuHoverTarget } from "./DanmakuActionMenu";
import { useDanmakuPinInteraction } from "./useDanmakuPinInteraction";

export type DanmakuHitRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export function danmakuVisibleContentRect(
  contentRect: DanmakuHitRect | null,
  countRect: DanmakuHitRect | null,
  aggregationCount: number,
  fallbackRect: DanmakuHitRect | null = null,
): DanmakuHitRect | null {
  const rects = [contentRect, aggregationCount > 1 ? countRect : null].filter(
    (rect): rect is DanmakuHitRect =>
      Boolean(
        rect &&
          Number.isFinite(rect.x) &&
          Number.isFinite(rect.y) &&
          Number.isFinite(rect.width) &&
          Number.isFinite(rect.height) &&
          rect.width > 0 &&
          rect.height > 0,
      ),
  );
  if (rects.length === 0) return fallbackRect;
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

type LiveDanmakuProps = {
  className?: string;
  active?: boolean;
  sessionKey?: number | string | null;
  siteId?: SiteId;
  roomId?: string;
  roomTitle?: string;
  roomUserName?: string;
  large?: boolean;
  delayMs?: number;
};

type RuntimeConfig = {
  fontSize: number;
  fontStroke: number;
  opacity: number;
  danmakuSpeed: number;
  mergeWindowSeconds: number;
  filterGifts: boolean;
  shieldMatcher: (event: DanmakuEvent) => boolean;
  blockedUserMatcher: (event: DanmakuEvent) => boolean;
  superChatEnabled: boolean;
  collisionMode: DanmakuCollisionMode;
  siteId?: SiteId;
};

type RendererConstructor = Awaited<ReturnType<typeof loadDanmakuRenderer>>;
type Renderer = InstanceType<RendererConstructor>;

type RuntimeBullet = {
  comment: DanmakuCommentWithMeta;
  meta: DanmakuBulletMeta;
  layer: DanmakuRenderLayer;
  attached: boolean;
};

function useReducedMotionPreference(): boolean {
  const [reduced, setReduced] = useState(prefersReducedMotion);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduced(query.matches);
    if (typeof query.addEventListener === "function") query.addEventListener("change", sync);
    else if (typeof query.addListener === "function") query.addListener(sync);
    sync();
    return () => {
      if (typeof query.removeEventListener === "function") query.removeEventListener("change", sync);
      else if (typeof query.removeListener === "function") query.removeListener(sync);
    };
  }, []);
  return reduced;
}

function usePageVisibility(): boolean {
  const [visible, setVisible] = useState(() =>
    typeof document === "undefined" ? true : !document.hidden,
  );
  useEffect(() => {
    const sync = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", sync);
    sync();
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);
  return visible;
}

function commentMeta(comment: DanmakuComment): DanmakuBulletMeta | null {
  const candidate = (comment as DanmakuComment & { __rliveMeta?: DanmakuBulletMeta }).__rliveMeta;
  if (!candidate || typeof candidate.id !== "string" || !candidate.event) return null;
  if (typeof candidate.baseText !== "string" || typeof candidate.aggregationCount !== "number") {
    return null;
  }
  return candidate;
}

function relativeRect(container: HTMLElement, element: HTMLElement): DanmakuHitRect {
  const containerRect = container.getBoundingClientRect();
  const elementRect = element.getBoundingClientRect();
  return {
    x: elementRect.left - containerRect.left,
    y: elementRect.top - containerRect.top,
    width: elementRect.width,
    height: elementRect.height,
  };
}

function visualRect(meta: DanmakuBulletMeta): DanmakuHitRect | null {
  const toHitRect = (element: HTMLElement | undefined): DanmakuHitRect | null => {
    if (!element?.isConnected) return null;
    const rect = element.getBoundingClientRect();
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
  };
  if (meta.event.kind === "super_chat") return toHitRect(meta.element);
  return danmakuVisibleContentRect(
    toHitRect(meta.contentElement),
    toHitRect(meta.countElement),
    meta.aggregationCount,
    toHitRect(meta.element),
  );
}

function relativeVisualRect(container: HTMLElement, meta: DanmakuBulletMeta): DanmakuHitRect | null {
  const rect = visualRect(meta);
  if (!rect) return null;
  const containerRect = container.getBoundingClientRect();
  return {
    x: rect.x - containerRect.left,
    y: rect.y - containerRect.top,
    width: rect.width,
    height: rect.height,
  };
}

export const LiveDanmaku = memo(function LiveDanmaku({
  className,
  active = true,
  sessionKey = null,
  siteId,
  roomId,
  roomTitle,
  roomUserName,
  large = false,
  delayMs = 0,
}: LiveDanmakuProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<Renderer | null>(null);
  const recordsRef = useRef(new Map<string, RuntimeBullet>());
  const aggregationTargetsRef = useRef(new Map<string, string>());
  const pendingEventsRef = useRef<DanmakuPendingEvent[]>([]);
  const superChatDedupeKeysRef = useRef(new Set<string>());
  const superChatDedupeOrderRef = useRef<string[]>([]);
  const sequenceRef = useRef(0);
  const runtimeEpochRef = useRef(0);
  const selectedIdRef = useRef<string | null>(null);
  const reducedMotion = useReducedMotionPreference();
  const pageVisible = usePageVisibility();
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const [hoverTarget, setHoverTarget] = useState<DanmakuHoverTarget | null>(null);

  const fontSize = useSettingsStore((state) => state.danmakuFontSize);
  const fontStroke = useSettingsStore((state) => state.danmakuFontStroke);
  const opacity = useSettingsStore((state) => state.danmakuOpacity);
  const danmakuSpeed = parseDanmakuSpeed(useSettingsStore((state) => state.danmakuSpeed));
  const area = useSettingsStore((state) => state.danmakuArea);
  const mergeWindowSeconds = useSettingsStore((state) => state.danmakuMergeWindowSeconds);
  const filterGifts = useSettingsStore((state) => state.danmakuFilterGifts);
  const shieldWords = useSettingsStore((state) => state.danmakuShieldWords);
  const blockedUsers = useSettingsStore((state) => state.danmakuBlockedUsers);
  const superChatEnabled = useSettingsStore((state) => state.superChatEnabled);
  const collisionMode = useSettingsStore((state) => state.danmakuCollisionMode);
  const shieldMatcher = useMemo(() => createShieldMatcher(shieldWords), [shieldWords]);
  const blockedUserMatcher = useMemo(() => createBlockedUserMatcher(blockedUsers), [blockedUsers]);
  const normalizedArea = clampDanmuArea(area);
  const laneHeight = danmuLaneHeight(fontSize);
  const sizeReady = stageSize.width > 0 && stageSize.height > 0;
  const sizeReadyRef = useRef(sizeReady);
  const stageHeightRef = useRef(stageSize.height);
  const areaRef = useRef(normalizedArea);
  const laneHeightRef = useRef(laneHeight);
  const configRef = useRef<RuntimeConfig>({
    fontSize,
    fontStroke: DANMAKU_FONT_STROKE_DEFAULT,
    opacity: 0.8,
    danmakuSpeed: DANMAKU_DEFAULT_SPEED,
    mergeWindowSeconds: 10,
    filterGifts: true,
    shieldMatcher: () => false,
    blockedUserMatcher: () => false,
    superChatEnabled: true,
    collisionMode: "strict",
    siteId,
  });
  const aggregatorRef = useRef(createDanmakuContentAggregator(true, 10_000));

  useLayoutEffect(() => {
    areaRef.current = normalizedArea;
    laneHeightRef.current = laneHeight;
    sizeReadyRef.current = sizeReady;
    stageHeightRef.current = stageSize.height;
    configRef.current = {
      fontSize,
      fontStroke,
      opacity,
      danmakuSpeed,
      mergeWindowSeconds,
      filterGifts,
      shieldMatcher,
      blockedUserMatcher,
      superChatEnabled,
      collisionMode,
      siteId,
    };
  }, [
    blockedUserMatcher,
    collisionMode,
    danmakuSpeed,
    filterGifts,
    fontSize,
    fontStroke,
    laneHeight,
    mergeWindowSeconds,
    normalizedArea,
    opacity,
    shieldMatcher,
    siteId,
    sizeReady,
    stageSize.height,
    superChatEnabled,
  ]);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const measure = () => {
      const rect = host.getBoundingClientRect();
      const next = { width: Math.max(0, Math.floor(rect.width)), height: Math.max(0, Math.floor(rect.height)) };
      setStageSize((current) =>
        current.width === next.width && current.height === next.height ? current : next,
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, [active, pageVisible]);

  const dropRecordRef = useRef<(id: string) => void>(() => {});
  const releaseSelection = useCallback((dropped = false) => {
    const selectedId = selectedIdRef.current;
    selectedIdRef.current = null;
    setHoverTarget(null);
    if (!selectedId) return;
    if (!dropped) rendererRef.current?.unpin(selectedId);
  }, []);
  const releaseSelectionRef = useRef(releaseSelection);
  useLayoutEffect(() => {
    releaseSelectionRef.current = releaseSelection;
  }, [releaseSelection]);

  /**
   * 只清记账，不销毁 DOM：调用方是渲染器的 `onDetach`，节点此时已由库销毁。
   */
  const dropRecord = useCallback((id: string) => {
    const record = recordsRef.current.get(id);
    if (!record) return;
    recordsRef.current.delete(id);
    const key = record.meta.aggregationKey;
    if (key && aggregationTargetsRef.current.get(key) === id) {
      aggregationTargetsRef.current.delete(key);
      aggregatorRef.current.forget(key);
    }
    if (selectedIdRef.current === id) {
      selectedIdRef.current = null;
      setHoverTarget(null);
    }
    record.meta.element = undefined;
    record.meta.contentElement = undefined;
    record.meta.countElement = undefined;
    record.meta.countSlotElement = undefined;
  }, []);
  useLayoutEffect(() => {
    dropRecordRef.current = dropRecord;
  }, [dropRecord]);

  // 屏蔽只作用于尚未投放的待处理事件；已上屏的弹幕保留到自然结束。
  useLayoutEffect(() => {
    const matcher = blockedUserMatcher;
    pendingEventsRef.current = pendingEventsRef.current.filter((pending) => !matcher(pending.event));
  }, [blockedUserMatcher]);

  const selectBullet = useCallback(
    (id: string, element: HTMLElement) => {
      const record = recordsRef.current.get(id);
      const host = hostRef.current;
      const renderer = rendererRef.current;
      if (!record || !host || !renderer) return;
      if (selectedIdRef.current && selectedIdRef.current !== id) releaseSelection();
      if (!renderer.pin(id)) return;
      selectedIdRef.current = id;
      element.dataset.rliveDanmakuSelected = "true";
      const rect = relativeVisualRect(host, record.meta) ?? relativeRect(host, element);
      setHoverTarget({
        hoverKey: id,
        content: record.meta.event.content,
        user: record.meta.event.user,
        eventKind: record.meta.event.kind,
        left: rect.x,
        top: rect.y,
        width: rect.width,
        height: rect.height,
      });
    },
    [releaseSelection],
  );

  const queueEvents = useCallback((events: readonly DanmakuEvent[]) => {
    enqueueDanmakuPending(pendingEventsRef.current, events);
  }, []);

  const renderEvents = useCallback(
    (events: readonly DanmakuEvent[]) => {
      const renderer = rendererRef.current;
      if (!sizeReadyRef.current || !renderer) {
        queueEvents(events);
        return;
      }
      const maxActiveComments = danmakuMaxActiveComments(
        stageHeightRef.current,
        laneHeightRef.current,
        areaRef.current,
      );
      const scrollLaneCount = danmakuLaneCount(
        stageHeightRef.current,
        laneHeightRef.current,
        areaRef.current,
      );
      const topLaneCount = danmakuLaneCount(stageHeightRef.current, laneHeightRef.current, 1);
      const config = configRef.current;
      const supportsSuperChat = config.superChatEnabled && siteSupportsSuperChat(config.siteId);
      // 每批只统计一次，循环内随新增滚动记录递增；逐条遍历全部记录在高峰批次会退化为 O(n²)。
      let activeScrollCount = 0;
      for (const record of recordsRef.current.values()) if (record.layer === "scroll") activeScrollCount += 1;
      for (const event of events) {
        if (!shouldShowValidatedOnFloatingDanmaku(event, config.filterGifts)) continue;
        if (config.shieldMatcher(event) || config.blockedUserMatcher(event)) continue;
        if (event.kind === "super_chat") {
          if (!supportsSuperChat || !event.content.trim()) continue;
          const dedupeKey = superChatDedupeKey(event);
          if (superChatDedupeKeysRef.current.has(dedupeKey)) continue;
          superChatDedupeKeysRef.current.add(dedupeKey);
          superChatDedupeOrderRef.current.push(dedupeKey);
          if (superChatDedupeOrderRef.current.length > MAX_SUPER_CHAT_DEDUPE_KEYS) {
            const oldestKey = superChatDedupeOrderRef.current.shift();
            if (oldestKey) superChatDedupeKeysRef.current.delete(oldestKey);
          }
        }

        let aggregation = aggregatorRef.current.aggregate(event);
        if (aggregation.key && aggregation.count > 1) {
          const targetId = aggregationTargetsRef.current.get(aggregation.key);
          const target = targetId ? recordsRef.current.get(targetId) : undefined;
          if (target) {
            updateDanmakuAggregation(target.comment, aggregation.count);
            continue;
          }
          aggregatorRef.current.forget(aggregation.key);
          aggregation = aggregatorRef.current.aggregate(event);
        }
        if (!isPinnedDanmakuEvent(event) && activeScrollCount >= maxActiveComments) continue;

        const id = `rlive-danmaku-${runtimeEpochRef.current}-${++sequenceRef.current}`;
        const comment = danmakuCommentFromEvent(event, {
          id,
          fontSize: config.fontSize,
          fontStroke: config.fontStroke,
          opacity: config.opacity,
          laneCount: isPinnedDanmakuEvent(event) ? topLaneCount : scrollLaneCount,
          aggregationKey: aggregation.key ?? undefined,
          aggregationCount: aggregation.count,
        });
        if (!comment) continue;
        const layer = danmakuRenderLayer(comment);
        const meta = comment.__rliveMeta;
        recordsRef.current.set(id, { comment, meta, layer, attached: false });
        if (layer === "scroll") activeScrollCount += 1;
        if (meta.aggregationKey) aggregationTargetsRef.current.set(meta.aggregationKey, id);

        renderer.emit(comment);
      }
    },
    [queueEvents],
  );
  const renderEventsRef = useRef(renderEvents);
  useLayoutEffect(() => {
    renderEventsRef.current = renderEvents;
  }, [renderEvents]);

  const flushPending = useCallback(() => {
    if (!sizeReadyRef.current || !rendererRef.current || document.hidden) return;
    const events = flushDanmakuPending(pendingEventsRef.current);
    if (events.length > 0) renderEventsRef.current(events);
  }, []);
  const flushPendingRef = useRef(flushPending);
  useLayoutEffect(() => {
    flushPendingRef.current = flushPending;
  }, [flushPending]);

  const processBatch = useCallback(
    (events: readonly DanmakuEvent[]) => {
      if (!active || reducedMotion || !pageVisible) return;
      if (!sizeReadyRef.current || !rendererRef.current || document.hidden) queueEvents(events);
      else renderEventsRef.current(events);
    },
    [active, pageVisible, queueEvents, reducedMotion],
  );
  const processBatchRef = useRef(processBatch);
  useLayoutEffect(() => {
    processBatchRef.current = processBatch;
  }, [processBatch]);

  useEffect(() => {
    aggregatorRef.current = createDanmakuContentAggregator(
      mergeWindowSeconds > 0,
      mergeWindowSeconds * 1_000,
    );
    aggregationTargetsRef.current.clear();
  }, [mergeWindowSeconds, sessionKey]);

  const delayMsRef = useRef(delayMs);
  useLayoutEffect(() => {
    delayMsRef.current = Number.isFinite(delayMs) ? Math.max(0, Math.min(60_000, delayMs)) : 0;
  }, [delayMs]);

  useEffect(() => {
    if (!active || reducedMotion || !pageVisible) return;
    const pendingTimers = new Set<number>();
    const unsubscribe = subscribeDanmakuBatches((events) => {
      const delay = delayMsRef.current;
      if (delay <= 0) {
        processBatchRef.current(events);
        return;
      }
      const timer = window.setTimeout(() => {
        pendingTimers.delete(timer);
        processBatchRef.current(events);
      }, delay);
      pendingTimers.add(timer);
    });
    return () => {
      unsubscribe();
      for (const timer of pendingTimers) window.clearTimeout(timer);
      pendingTimers.clear();
    };
  }, [active, pageVisible, reducedMotion, sessionKey]);

  useEffect(() => {
    const pendingEvents = pendingEventsRef.current;
    return () => {
      pendingEvents.length = 0;
    };
  }, [active, pageVisible, reducedMotion, sessionKey]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let disposed = false;
    let renderer: Renderer | null = null;
    const records = recordsRef.current;
    const pendingEvents = pendingEventsRef.current;

    const clearRenderedState = (preservePending: boolean) => {
      releaseSelectionRef.current(true);
      renderer?.clear();
      renderer?.destroy();
      renderer = null;
      if (rendererRef.current) rendererRef.current = null;
      for (const record of records.values()) {
        record.meta.element = undefined;
        record.meta.contentElement = undefined;
        record.meta.countElement = undefined;
        record.meta.countSlotElement = undefined;
      }
      records.clear();
      aggregationTargetsRef.current.clear();
      aggregatorRef.current.clear();
      if (!preservePending) pendingEvents.length = 0;
      superChatDedupeKeysRef.current.clear();
      superChatDedupeOrderRef.current.length = 0;
      sequenceRef.current = 0;
      container.replaceChildren();
    };

    if (!active || reducedMotion || !pageVisible) {
      clearRenderedState(false);
      return;
    }
    if (!sizeReady) {
      clearRenderedState(true);
      return;
    }
    runtimeEpochRef.current += 1;
    void loadDanmakuRenderer()
      .then((RendererConstructor) => {
        if (disposed) return;
        const instance = new RendererConstructor({
          container,
          speed: configRef.current.danmakuSpeed,
          area: danmakuLayerAreaConfig("scroll", areaRef.current),
          laneHeight: laneHeightRef.current,
          collisionMode: configRef.current.collisionMode,
          onAttach: (comment: DanmakuComment, element: HTMLElement) => {
            const meta = commentMeta(comment);
            if (!meta) return;
            meta.element = element;
            element.dataset.rliveDanmakuId = meta.id;
            const record = recordsRef.current.get(meta.id);
            if (record) record.attached = true;
            if (selectedIdRef.current === meta.id) element.dataset.rliveDanmakuSelected = "true";
          },
          onDetach: (id: string) => dropRecordRef.current(id),
        });
        renderer = instance;
        rendererRef.current = instance;
        if (disposed) {
          instance.destroy();
          renderer = null;
          rendererRef.current = null;
          return;
        }
        instance.resize();
        flushPendingRef.current();
      })
      .catch((error: unknown) => {
        if (!disposed) {
          clearRenderedState(true);
          console.error("Unable to initialize danmaku renderer", error);
        }
      });

    return () => {
      disposed = true;
      clearRenderedState(true);
    };
  }, [active, pageVisible, reducedMotion, sessionKey, sizeReady]);

  useEffect(() => {
    rendererRef.current?.resize();
  }, [stageSize.height, stageSize.width]);

  useEffect(() => {
    rendererRef.current?.setSpeed(danmakuSpeed);
  }, [danmakuSpeed]);

  useEffect(() => {
    rendererRef.current?.setCollisionMode(collisionMode);
  }, [collisionMode]);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    renderer.setArea(danmakuLayerAreaConfig("scroll", normalizedArea));
    renderer.setLaneHeight(laneHeight);
    const scrollLaneCount = danmakuLaneCount(stageHeightRef.current, laneHeight, normalizedArea);
    const topLaneCount = danmakuLaneCount(stageHeightRef.current, laneHeight, 1);
    for (const { comment, layer } of recordsRef.current.values()) {
      updateDanmakuAppearance(comment, {
        fontSize,
        fontStroke,
        opacity,
        laneCount: layer === "top" ? topLaneCount : scrollLaneCount,
      });
    }
  }, [fontSize, fontStroke, laneHeight, normalizedArea, opacity]);

  useEffect(() => {
    releaseSelectionRef.current(true);
  }, [active, reducedMotion, sessionKey]);

  useEffect(() => {
    const selectedId = hoverTarget?.hoverKey;
    const host = hostRef.current;
    if (!selectedId || !host) return;
    let frame = 0;
    const update = () => {
      const meta = recordsRef.current.get(selectedId)?.meta;
      const rect = meta && relativeVisualRect(host, meta);
      if (!meta || !rect) {
        if (selectedIdRef.current === selectedId) releaseSelectionRef.current();
        return;
      }
      setHoverTarget((current) =>
        current && current.hoverKey === selectedId
          ? current.left === rect.x &&
              current.top === rect.y &&
              current.width === rect.width &&
              current.height === rect.height
            ? current
            : { ...current, left: rect.x, top: rect.y, width: rect.width, height: rect.height }
          : current,
      );
      frame = window.requestAnimationFrame(update);
    };
    frame = window.requestAnimationFrame(update);
    return () => window.cancelAnimationFrame(frame);
  }, [hoverTarget?.hoverKey]);

  useDanmakuPinInteraction({
    hostRef,
    enabled: active && !reducedMotion && pageVisible,
    selectedId: hoverTarget?.hoverKey ?? null,
    hasBullet: (id) => recordsRef.current.get(id)?.attached === true,
    selectBullet,
    releaseSelection,
  });

  return (
    <div ref={hostRef} className={cn("pointer-events-none absolute inset-0", className)}>
      <div
        ref={containerRef}
        aria-hidden="true"
        data-rlive-danmaku-layer="live"
        className="pointer-events-none absolute inset-0 z-0 overflow-hidden"
        style={{ opacity: 1 }}
      />
      {hoverTarget && (
        <>
          <div
            aria-hidden="true"
            data-rlive-danmaku-selection
            className="pointer-events-none absolute z-[11] box-border border border-white/90"
            style={{
              left: hoverTarget.left,
              top: hoverTarget.top,
              width: hoverTarget.width,
              height: hoverTarget.height,
            }}
          />
          <DanmakuActionMenu
            key={hoverTarget.hoverKey}
            target={hoverTarget}
            siteId={siteId}
            roomId={roomId}
            roomTitle={roomTitle}
            roomUserName={roomUserName}
            large={large}
          />
        </>
      )}
    </div>
  );
});
