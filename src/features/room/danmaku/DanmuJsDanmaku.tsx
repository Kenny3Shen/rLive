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
import type { DanmuJsBullet, DanmuJsComment, DanmuJsInstance } from "danmu.js";
import type { DanmakuEvent, SiteId } from "@/shared/types/live";
import { prefersReducedMotion } from "@/shared/motion/tokens";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import { isMobileClient } from "@/shared/clientPlatform";
import { cn } from "@/lib/utils";
import { subscribeDanmakuBatches } from "./eventBus";
import {
  createDanmakuContentAggregator,
  createShieldMatcher,
  shouldShowValidatedOnFloatingDanmaku,
} from "./filter";
import {
  createDanmuBulletElement,
  danmuBandLayout,
  danmuBandStyle,
  danmuCommentFromEvent,
  enqueueDanmuJsPending,
  flushDanmuJsPending,
  updateDanmuAggregation,
  updateDanmuAppearance,
  type DanmuJsBandLayout,
  type DanmuJsBulletMeta,
  type DanmuJsPendingEvent,
  DANMU_JS_MAX_ACTIVE_COMMENTS,
  DANMU_JS_MAX_SUPER_CHATS,
} from "./danmuJsAdapter";
import { loadDanmuJs } from "./danmuJsLoader";
import {
  MAX_SUPER_CHAT_DEDUPE_KEYS,
  siteSupportsSuperChat,
  superChatDedupeKey,
} from "../superChat";
import { DANMAKU_MENU_ATTR, DanmakuActionMenu, type DanmakuHoverTarget } from "./DanmakuActionMenu";

export const DANMAKU_TAP_MAX_DISTANCE_PX = 11;
export const DANMAKU_TAP_MAX_DURATION_MS = 320;
export const DANMAKU_TOUCH_HIT_SLOP_PX = 10;

export type DanmakuHitRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export function isDanmakuTap(deltaX: number, deltaY: number, durationMs: number): boolean {
  return (
    durationMs >= 0 &&
    durationMs <= DANMAKU_TAP_MAX_DURATION_MS &&
    Math.hypot(deltaX, deltaY) <= DANMAKU_TAP_MAX_DISTANCE_PX
  );
}

export function expandedDanmakuHitRect(
  rect: DanmakuHitRect,
  slop = DANMAKU_TOUCH_HIT_SLOP_PX,
): DanmakuHitRect {
  const safeSlop = Number.isFinite(slop) ? Math.max(0, slop) : 0;
  return {
    x: rect.x - safeSlop,
    y: rect.y - safeSlop,
    width: rect.width + safeSlop * 2,
    height: rect.height + safeSlop * 2,
  };
}

export function shouldHitTestDanmakuHover(menuHovered: boolean, hasSelection: boolean): boolean {
  return !menuHovered || !hasSelection;
}

type DanmuJsDanmakuProps = {
  className?: string;
  active?: boolean;
  sessionKey?: number | string | null;
  siteId?: SiteId;
  roomId?: string;
  roomTitle?: string;
  roomUserName?: string;
  large?: boolean;
};

type RuntimeConfig = {
  fontSize: number;
  fontWeight: number;
  opacity: number;
  filterRepeats: boolean;
  mergeWindowSeconds: number;
  filterGifts: boolean;
  shieldMatcher: (event: DanmakuEvent) => boolean;
  superChatEnabled: boolean;
  siteId?: SiteId;
};

type RuntimeBullet = {
  comment: DanmuJsComment & { __rliveMeta: DanmuJsBulletMeta };
  meta: DanmuJsBulletMeta;
};

type TouchStart = {
  pointerId: number;
  x: number;
  y: number;
  at: number;
};

function useReducedMotionPreference(): boolean {
  const [reduced, setReduced] = useState(prefersReducedMotion);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduced(query.matches);
    query.addEventListener("change", sync);
    sync();
    return () => query.removeEventListener("change", sync);
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

function isMenuTarget(target: EventTarget | null): boolean {
  const element =
    target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  return Boolean(element?.closest(`[${DANMAKU_MENU_ATTR}]`));
}

function bulletElementFromTarget(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  return target.closest<HTMLElement>("[data-rlive-danmaku-id]");
}

function bulletId(value: unknown): string | null {
  if (typeof value === "string" && value) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function commentMeta(comment: DanmuJsComment): DanmuJsBulletMeta | null {
  const candidate = comment.__rliveMeta as Partial<DanmuJsBulletMeta> | undefined;
  if (!candidate || typeof candidate.id !== "string" || !candidate.event) return null;
  if (typeof candidate.baseText !== "string" || typeof candidate.aggregationCount !== "number") {
    return null;
  }
  return candidate as DanmuJsBulletMeta;
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

function containsPoint(rect: DanmakuHitRect, x: number, y: number): boolean {
  return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
}

export const DanmuJsDanmaku = memo(function DanmuJsDanmaku({
  className,
  active = true,
  sessionKey = null,
  siteId,
  roomId,
  roomTitle,
  roomUserName,
  large = false,
}: DanmuJsDanmakuProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<DanmuJsInstance | null>(null);
  const recordsRef = useRef(new Map<string, RuntimeBullet>());
  const recordOrderRef = useRef<string[]>([]);
  const aggregationTargetsRef = useRef(new Map<string, string>());
  const pendingEventsRef = useRef<DanmuJsPendingEvent[]>([]);
  const superChatIdsRef = useRef<string[]>([]);
  const superChatTimersRef = useRef(new Map<string, number>());
  const superChatDedupeKeysRef = useRef(new Set<string>());
  const superChatDedupeOrderRef = useRef<string[]>([]);
  const sequenceRef = useRef(0);
  const runtimeEpochRef = useRef(0);
  const selectedIdRef = useRef<string | null>(null);
  const menuHoveredRef = useRef(false);
  const touchStartRef = useRef<TouchStart | null>(null);
  const mobile = useMemo(isMobileClient, []);
  const reducedMotion = useReducedMotionPreference();
  const pageVisible = usePageVisibility();
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const [hoverTarget, setHoverTarget] = useState<DanmakuHoverTarget | null>(null);

  const fontSize = useSettingsStore((state) => state.danmakuFontSize);
  const opacity = useSettingsStore((state) => state.danmakuOpacity);
  const area = useSettingsStore((state) => state.danmakuArea);
  const lineCount = useSettingsStore((state) => state.danmakuLineCount);
  const fontWeight = useSettingsStore((state) => state.danmakuFontWeight);
  const filterRepeats = useSettingsStore((state) => state.danmakuFilterRepeats);
  const mergeWindowSeconds = useSettingsStore((state) => state.danmakuMergeWindowSeconds);
  const filterGifts = useSettingsStore((state) => state.danmakuFilterGifts);
  const shieldWords = useSettingsStore((state) => state.danmakuShieldWords);
  const superChatEnabled = useSettingsStore((state) => state.superChatEnabled);
  const shieldMatcher = useMemo(() => createShieldMatcher(shieldWords), [shieldWords]);
  const bandLayout = useMemo(
    () => danmuBandLayout(stageSize.height, fontSize, area, lineCount),
    [area, fontSize, lineCount, stageSize.height],
  );
  const bandLayoutRef = useRef<DanmuJsBandLayout>(bandLayout);

  const configRef = useRef<RuntimeConfig>({
    fontSize: 18,
    fontWeight: 600,
    opacity: 0.8,
    filterRepeats: true,
    mergeWindowSeconds: 10,
    filterGifts: true,
    shieldMatcher: () => false,
    superChatEnabled: true,
    siteId,
  });
  const aggregatorRef = useRef(createDanmakuContentAggregator(true, 10_000));

  useLayoutEffect(() => {
    bandLayoutRef.current = bandLayout;
    configRef.current = {
      fontSize,
      fontWeight,
      opacity,
      filterRepeats,
      mergeWindowSeconds,
      filterGifts,
      shieldMatcher,
      superChatEnabled,
      siteId,
    };
  }, [
    bandLayout,
    filterGifts,
    filterRepeats,
    fontSize,
    fontWeight,
    mergeWindowSeconds,
    opacity,
    shieldMatcher,
    siteId,
    superChatEnabled,
  ]);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const measure = () => {
      const rect = host.getBoundingClientRect();
      const next = {
        width: Math.max(0, Math.floor(rect.width)),
        height: Math.max(0, Math.floor(rect.height)),
      };
      setStageSize((current) =>
        current.width === next.width && current.height === next.height ? current : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  const releaseSelection = useCallback((removed = false) => {
    menuHoveredRef.current = false;
    const selectedId = selectedIdRef.current;
    selectedIdRef.current = null;
    const element = selectedId ? recordsRef.current.get(selectedId)?.meta.element : undefined;
    if (element) {
      delete element.dataset.rliveDanmakuSelected;
      element.style.outline = "";
      element.style.outlineOffset = "";
    }
    if (selectedId && !removed) instanceRef.current?.restartComment(selectedId);
    setHoverTarget(null);
  }, []);
  const releaseSelectionRef = useRef(releaseSelection);
  useLayoutEffect(() => {
    releaseSelectionRef.current = releaseSelection;
  }, [releaseSelection]);

  const removeRecord = useCallback((id: string, removeFromInstance: boolean) => {
    const record = recordsRef.current.get(id);
    if (!record) return;
    const superChatTimer = superChatTimersRef.current.get(id);
    if (superChatTimer !== undefined) {
      window.clearTimeout(superChatTimer);
      superChatTimersRef.current.delete(id);
    }
    recordsRef.current.delete(id);
    const recordIndex = recordOrderRef.current.indexOf(id);
    if (recordIndex >= 0) recordOrderRef.current.splice(recordIndex, 1);
    const superChatIndex = superChatIdsRef.current.indexOf(id);
    if (superChatIndex >= 0) superChatIdsRef.current.splice(superChatIndex, 1);
    const key = record.meta.aggregationKey;
    if (key && aggregationTargetsRef.current.get(key) === id) {
      aggregationTargetsRef.current.delete(key);
      aggregatorRef.current.forget(key);
    }
    record.meta.element = undefined;
    record.meta.countElement = undefined;
    if (selectedIdRef.current === id) releaseSelectionRef.current(true);
    if (removeFromInstance) instanceRef.current?.removeComment(id);
    const instance = instanceRef.current;
    if (recordsRef.current.size === 0 && instance?.status === "playing") instance.pause();
  }, []);
  const removeRecordRef = useRef(removeRecord);
  useLayoutEffect(() => {
    removeRecordRef.current = removeRecord;
  }, [removeRecord]);

  const selectBullet = useCallback(
    (id: string, element: HTMLElement) => {
      const record = recordsRef.current.get(id);
      const container = containerRef.current;
      const instance = instanceRef.current;
      if (!record || !container || !instance) return;
      if (selectedIdRef.current && selectedIdRef.current !== id) releaseSelection();

      selectedIdRef.current = id;
      element.dataset.rliveDanmakuSelected = "true";
      element.style.outline = "1px solid rgba(255,255,255,.92)";
      element.style.outlineOffset = "2px";
      instance.freezeComment(id);
      const rect = relativeRect(container, element);
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
    enqueueDanmuJsPending(pendingEventsRef.current, events);
  }, []);

  const renderEvents = useCallback(
    (events: readonly DanmakuEvent[]) => {
      const instance = instanceRef.current;
      if (!instance) {
        queueEvents(events);
        return;
      }

      const config = configRef.current;
      const supportsSuperChat = config.superChatEnabled && siteSupportsSuperChat(config.siteId);
      for (const event of events) {
        if (!shouldShowValidatedOnFloatingDanmaku(event, config.filterGifts)) continue;
        if (config.shieldMatcher(event)) continue;

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
            updateDanmuAggregation(target.comment, aggregation.count);
            continue;
          }
          aggregatorRef.current.forget(aggregation.key);
          aggregation = aggregatorRef.current.aggregate(event);
        }

        while (recordsRef.current.size >= DANMU_JS_MAX_ACTIVE_COMMENTS) {
          const oldest = recordOrderRef.current[0];
          if (!oldest) break;
          removeRecordRef.current(oldest, true);
        }

        const id = `rlive-danmu-${runtimeEpochRef.current}-${++sequenceRef.current}`;
        const comment = danmuCommentFromEvent(event, {
          id,
          fontSize: config.fontSize,
          fontWeight: config.fontWeight,
          opacity: config.opacity,
          aggregationKey: aggregation.key ?? undefined,
          aggregationCount: aggregation.count,
        });
        if (!comment) continue;
        const meta = comment.__rliveMeta;
        recordsRef.current.set(id, { comment, meta });
        recordOrderRef.current.push(id);
        if (meta.aggregationKey) aggregationTargetsRef.current.set(meta.aggregationKey, id);

        if (event.kind === "super_chat") {
          superChatIdsRef.current.push(id);
          const duration = Math.max(1, comment.duration ?? 0);
          superChatTimersRef.current.set(
            id,
            window.setTimeout(() => removeRecordRef.current(id, true), duration),
          );
          while (superChatIdsRef.current.length > DANMU_JS_MAX_SUPER_CHATS) {
            const oldest = superChatIdsRef.current[0];
            if (!oldest) break;
            removeRecordRef.current(oldest, true);
          }
        }

        if (instance.status === "idle") instance.start();
        else if (instance.status === "paused") instance.play();
        instance.sendComment(comment);
      }
    },
    [queueEvents],
  );
  const renderEventsRef = useRef(renderEvents);
  useLayoutEffect(() => {
    renderEventsRef.current = renderEvents;
  }, [renderEvents]);

  const flushPending = useCallback(() => {
    if (!instanceRef.current || document.hidden) return;
    const events = flushDanmuJsPending(pendingEventsRef.current);
    if (events.length > 0) renderEventsRef.current(events);
  }, []);
  const flushPendingRef = useRef(flushPending);
  useLayoutEffect(() => {
    flushPendingRef.current = flushPending;
  }, [flushPending]);

  const processBatch = useCallback(
    (events: readonly DanmakuEvent[]) => {
      if (!active || reducedMotion || !pageVisible) return;
      if (!instanceRef.current || document.hidden) queueEvents(events);
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
      filterRepeats,
      mergeWindowSeconds * 1_000,
    );
    aggregationTargetsRef.current.clear();
  }, [filterRepeats, mergeWindowSeconds, sessionKey]);

  useEffect(() => {
    if (!active || reducedMotion || !pageVisible) return;
    return subscribeDanmakuBatches((events) => processBatchRef.current(events));
  }, [active, pageVisible, reducedMotion, sessionKey]);

  const sizeReady = stageSize.width > 0 && bandLayout.height > 0;
  useEffect(() => {
    const container = containerRef.current;
    const records = recordsRef.current;
    const recordOrder = recordOrderRef.current;
    const aggregationTargets = aggregationTargetsRef.current;
    const pendingEvents = pendingEventsRef.current;
    const superChatIds = superChatIdsRef.current;
    const superChatTimers = superChatTimersRef.current;
    const superChatDedupeKeys = superChatDedupeKeysRef.current;
    const superChatDedupeOrder = superChatDedupeOrderRef.current;
    let disposed = false;
    let instance: DanmuJsInstance | null = null;

    const clearSessionState = () => {
      releaseSelectionRef.current(true);
      if (instance) instance.destroy();
      if (instanceRef.current === instance) instanceRef.current = null;
      for (const timer of superChatTimers.values()) window.clearTimeout(timer);
      superChatTimers.clear();
      records.clear();
      recordOrder.length = 0;
      aggregationTargets.clear();
      aggregatorRef.current.clear();
      pendingEvents.length = 0;
      superChatIds.length = 0;
      superChatDedupeKeys.clear();
      superChatDedupeOrder.length = 0;
      sequenceRef.current = 0;
      container?.replaceChildren();
    };

    if (!active || reducedMotion || !pageVisible || !sizeReady || !container) {
      return clearSessionState;
    }

    runtimeEpochRef.current += 1;

    const onBulletRemove = (payload: { bullet: DanmuJsBullet }) => {
      const id = bulletId(payload?.bullet?.id);
      if (id) removeRecordRef.current(id, false);
    };

    void loadDanmuJs()
      .then((Constructor) => {
        if (disposed) return;
        const layout = bandLayoutRef.current;
        instance = new Constructor({
          container,
          comments: [],
          live: true,
          defaultOff: true,
          area: { start: 0, end: 1 },
          channelSize: layout.laneHeight,
          mouseControl: false,
          mouseControlPause: false,
          needResizeObserver: true,
          maxCommentsLength: DANMU_JS_MAX_ACTIVE_COMMENTS,
          interval: 250,
          chaseEffect: true,
          disableCopyDOM: true,
          hooks: {
            bulletCreateEl: (comment: DanmuJsComment) => createDanmuBulletElement(comment),
            bulletAttached: (comment: DanmuJsComment, element: HTMLElement) => {
              const meta = commentMeta(comment);
              if (!meta) return;
              meta.element = element;
              element.dataset.rliveDanmakuId = meta.id;
              if (selectedIdRef.current === meta.id) {
                element.dataset.rliveDanmakuSelected = "true";
                element.style.outline = "1px solid rgba(255,255,255,.92)";
                element.style.outlineOffset = "2px";
              }
            },
            bulletDetached: (comment: DanmuJsComment, element: HTMLElement) => {
              const meta = commentMeta(comment);
              if (meta?.element === element) {
                meta.element = undefined;
                meta.countElement = undefined;
              }
              // A real-time comment can be rejected when every channel is
              // occupied. danmu.js does not emit bullet_remove for that path,
              // so release the local record from the detach hook as well.
              if (meta) removeRecordRef.current(meta.id, false);
            },
          },
        });
        if (disposed) {
          instance.destroy();
          return;
        }
        instanceRef.current = instance;
        instance.on("bullet_remove", onBulletRemove);
        instance.resize();
        flushPendingRef.current();
      })
      .catch((error: unknown) => {
        if (!disposed) console.error("Unable to initialize danmu.js", error);
      });

    return () => {
      disposed = true;
      if (instance) {
        instance.off("bullet_remove", onBulletRemove);
      }
      clearSessionState();
    };
  }, [active, pageVisible, reducedMotion, sessionKey, sizeReady]);

  useEffect(() => {
    const instance = instanceRef.current;
    if (!instance) return;
    instance.setFontSize(fontSize, bandLayout.laneHeight);
    instance.setArea({ start: 0, end: 1, reflow: true });
    for (const { comment } of recordsRef.current.values()) {
      updateDanmuAppearance(comment, {
        fontSize,
        fontWeight,
        opacity,
      });
    }
    instance.resize();
  }, [bandLayout.height, bandLayout.laneHeight, fontSize, fontWeight, opacity]);

  useEffect(() => {
    if (superChatEnabled && siteSupportsSuperChat(siteId)) return;
    const ids = superChatIdsRef.current.slice();
    for (const id of ids) removeRecordRef.current(id, true);
    superChatDedupeKeysRef.current.clear();
    superChatDedupeOrderRef.current.length = 0;
  }, [siteId, superChatEnabled]);

  useEffect(() => {
    touchStartRef.current = null;
    releaseSelectionRef.current(true);
  }, [active, reducedMotion, sessionKey]);

  useEffect(() => {
    const selectedId = hoverTarget?.hoverKey;
    const container = containerRef.current;
    if (!selectedId || !container) return;
    let frame = 0;
    const update = () => {
      const element = recordsRef.current.get(selectedId)?.meta.element;
      if (!element || !element.isConnected) {
        if (selectedIdRef.current === selectedId) releaseSelectionRef.current(true);
        return;
      }
      const rect = relativeRect(container, element);
      setHoverTarget((current) =>
        current && current.hoverKey === selectedId
          ? current.left === rect.x &&
            current.top === rect.y &&
            current.width === rect.width &&
            current.height === rect.height
            ? current
            : {
                ...current,
                left: rect.x,
                top: rect.y,
                width: rect.width,
                height: rect.height,
              }
          : current,
      );
      frame = window.requestAnimationFrame(update);
    };
    frame = window.requestAnimationFrame(update);
    return () => window.cancelAnimationFrame(frame);
  }, [hoverTarget?.hoverKey]);

  const touchBulletAtPoint = useCallback(
    (target: EventTarget | null, clientX: number, clientY: number): HTMLElement | null => {
      const direct = bulletElementFromTarget(target);
      if (direct) return direct;
      for (let index = recordOrderRef.current.length - 1; index >= 0; index -= 1) {
        const id = recordOrderRef.current[index];
        const element = recordsRef.current.get(id)?.meta.element;
        if (!element) continue;
        const rect = element.getBoundingClientRect();
        const expanded = expandedDanmakuHitRect(
          { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
          DANMAKU_TOUCH_HIT_SLOP_PX,
        );
        if (containsPoint(expanded, clientX, clientY)) return element;
      }
      return null;
    },
    [],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!active || mobile || event.pointerType !== "mouse") return;
      if (!shouldHitTestDanmakuHover(menuHoveredRef.current, selectedIdRef.current !== null))
        return;
      if (isMenuTarget(event.target)) return;
      const element = bulletElementFromTarget(event.target);
      const id = element?.dataset.rliveDanmakuId;
      if (!element || !id) {
        if (selectedIdRef.current) releaseSelection();
        return;
      }
      if (selectedIdRef.current !== id) selectBullet(id, element);
    },
    [active, mobile, releaseSelection, selectBullet],
  );

  const handlePointerLeave = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (mobile || isMenuTarget(event.relatedTarget)) return;
      releaseSelection();
    },
    [mobile, releaseSelection],
  );

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!mobile || !active || event.pointerType === "mouse" || !event.isPrimary) return;
      if (isMenuTarget(event.target)) return;
      touchStartRef.current = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        at: Date.now(),
      };
    },
    [active, mobile],
  );

  const handlePointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const start = touchStartRef.current;
      if (!start || start.pointerId !== event.pointerId) return;
      touchStartRef.current = null;
      if (!mobile || !active || event.pointerType === "mouse") return;
      if (!isDanmakuTap(event.clientX - start.x, event.clientY - start.y, Date.now() - start.at)) {
        return;
      }

      const element = touchBulletAtPoint(event.target, event.clientX, event.clientY);
      const id = element?.dataset.rliveDanmakuId;
      if (!element || !id) {
        if (selectedIdRef.current) {
          event.preventDefault();
          releaseSelection();
        }
        return;
      }
      event.preventDefault();
      if (selectedIdRef.current === id) releaseSelection();
      else selectBullet(id, element);
    },
    [active, mobile, releaseSelection, selectBullet, touchBulletAtPoint],
  );

  const handlePointerCancel = useCallback(() => {
    touchStartRef.current = null;
  }, []);

  const handleMenuPointerEnter = useCallback(() => {
    menuHoveredRef.current = true;
  }, []);
  const handleMenuPointerLeave = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      menuHoveredRef.current = false;
      if (
        event.relatedTarget instanceof Node &&
        containerRef.current?.contains(event.relatedTarget)
      ) {
        return;
      }
      releaseSelection();
    },
    [releaseSelection],
  );

  return (
    <div ref={hostRef} className={cn("pointer-events-none absolute inset-0", className)}>
      <div
        ref={containerRef}
        aria-hidden="true"
        className="pointer-events-auto absolute top-0 left-0 w-full overflow-hidden"
        style={{ ...danmuBandStyle(bandLayout), opacity: 1 }}
        onPointerMove={handlePointerMove}
        onPointerLeave={handlePointerLeave}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
      />
      {hoverTarget && (
        <DanmakuActionMenu
          key={hoverTarget.hoverKey}
          target={hoverTarget}
          siteId={siteId}
          roomId={roomId}
          roomTitle={roomTitle}
          roomUserName={roomUserName}
          large={large && !mobile}
          touch={mobile}
          onPointerEnter={mobile ? undefined : handleMenuPointerEnter}
          onPointerLeave={mobile ? undefined : handleMenuPointerLeave}
        />
      )}
    </div>
  );
});
