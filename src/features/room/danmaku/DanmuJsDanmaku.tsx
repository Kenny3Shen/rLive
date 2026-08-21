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
import {
  DANMAKU_FONT_STROKE_DEFAULT,
  parseDanmakuSpeed,
  useSettingsStore,
} from "@/shared/stores/settingsStore";
import { cn } from "@/lib/utils";
import { subscribeDanmakuBatches } from "./eventBus";
import {
  createDanmakuContentAggregator,
  createShieldMatcher,
  shouldShowValidatedOnFloatingDanmaku,
} from "./filter";
import {
  clampDanmuArea,
  createDanmuBulletElement,
  danmuCommentFromEvent,
  danmuGhostRecordIds,
  danmuLayerAreaConfig,
  danmuLaneHeight,
  danmuMaxActiveComments,
  danmuMoveVPlayRate,
  danmuRenderLayer,
  enqueueDanmuJsPending,
  flushDanmuJsPending,
  isPinnedDanmakuEvent,
  updateDanmuAggregation,
  updateDanmuAppearance,
  type DanmuJsBulletMeta,
  type DanmuJsPendingEvent,
  type DanmuJsRenderLayer,
  DANMU_JS_MAX_ACTIVE_COMMENTS,
  DANMU_JS_MAX_SUPER_CHATS,
  DANMU_JS_DEFAULT_MOVE_V,
} from "./danmuJsAdapter";
import { installDanmuJsFixedPriorCompat } from "./danmuJsCompat";
import { loadDanmuJs } from "./danmuJsLoader";
import { releaseDanmuJsPin, removeDanmuJsPin, resumeDanmuJsPin } from "./danmuJsPin";
import {
  MAX_SUPER_CHAT_DEDUPE_KEYS,
  siteSupportsSuperChat,
  superChatDedupeKey,
} from "../superChat";
import { DANMAKU_MENU_ATTR, DanmakuActionMenu, type DanmakuHoverTarget } from "./DanmakuActionMenu";

export type DanmakuHitRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/**
 * Safety net for a pinned comment.
 *
 * Pinning parks the danmu.js Bullet in `forcedPause`, a state only an explicit
 * restart leaves. Every dismissal path below releases it, but a comment frozen
 * across a stage resize or a layer teardown used to stay on screen forever, so
 * a pin also expires on its own. Generous on purpose: it must not interrupt
 * someone still reading the comment they pinned.
 */
const DANMU_JS_PIN_AUTO_RELEASE_MS = 20_000;
/**
 * A press only pins if it stayed put, so dragging a volume/brightness gesture
 * that happens to start on a comment is not read as a pin. Mirrors the stage tap
 * thresholds in `PlayerPane`, duplicated rather than imported because that module
 * renders this one.
 */
const DANMU_JS_PIN_TAP_MAX_DISTANCE_PX = 14;
const DANMU_JS_PIN_TAP_MAX_DURATION_MS = 320;
/**
 * How long a claimed press keeps suppressing the mouse events derived from it.
 * `click` follows its `pointerup` in the same task, and the `dblclick` of a
 * double press follows the second one, so this only has to outlast one gesture.
 */
const DANMU_JS_PIN_CLAIM_WINDOW_MS = 500;

/** Short, mostly stationary press: a pin rather than the start of a gesture. */
export function isDanmakuPinTap(deltaX: number, deltaY: number, durationMs: number): boolean {
  return (
    durationMs >= 0 &&
    durationMs <= DANMU_JS_PIN_TAP_MAX_DURATION_MS &&
    Math.hypot(deltaX, deltaY) <= DANMU_JS_PIN_TAP_MAX_DISTANCE_PX
  );
}

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
  fontStroke: number;
  opacity: number;
  danmakuSpeed: number;
  mergeWindowSeconds: number;
  filterGifts: boolean;
  shieldMatcher: (event: DanmakuEvent) => boolean;
  superChatEnabled: boolean;
  siteId?: SiteId;
};

type RuntimeBullet = {
  comment: DanmuJsComment & { __rliveMeta: DanmuJsBulletMeta };
  meta: DanmuJsBulletMeta;
  layer: DanmuJsRenderLayer;
  instance: DanmuJsInstance;
  /** When the comment was handed to danmu.js, for the ghost sweep below. */
  sentAt: number;
  /** Set from the attach hook: only an attached comment has a bullet on screen. */
  attached: boolean;
};

type DanmuJsInstances = Record<DanmuJsRenderLayer, DanmuJsInstance>;

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
      if (typeof query.removeEventListener === "function")
        query.removeEventListener("change", sync);
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

function visualRect(meta: DanmuJsBulletMeta): DanmakuHitRect | null {
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

function relativeVisualRect(
  container: HTMLElement,
  meta: DanmuJsBulletMeta,
): DanmakuHitRect | null {
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
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const topContainerRef = useRef<HTMLDivElement>(null);
  const instancesRef = useRef<DanmuJsInstances | null>(null);
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
  const pinTapRef = useRef<{
    pointerId: number;
    id: string;
    element: HTMLElement;
    startX: number;
    startY: number;
    startedAt: number;
  } | null>(null);
  const claimedPressAtRef = useRef(0);
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
  const superChatEnabled = useSettingsStore((state) => state.superChatEnabled);
  const shieldMatcher = useMemo(() => createShieldMatcher(shieldWords), [shieldWords]);
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
    danmakuSpeed: DANMU_JS_DEFAULT_MOVE_V,
    mergeWindowSeconds: 10,
    filterGifts: true,
    shieldMatcher: () => false,
    superChatEnabled: true,
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
      superChatEnabled,
      siteId,
    };
  }, [
    filterGifts,
    danmakuSpeed,
    fontSize,
    fontStroke,
    laneHeight,
    mergeWindowSeconds,
    normalizedArea,
    opacity,
    shieldMatcher,
    siteId,
    stageSize.height,
    superChatEnabled,
    sizeReady,
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
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, [active, pageVisible]);

  const removeRecordRef = useRef<(id: string, removeFromInstance: boolean) => void>(() => {});

  /**
   * Undoes one pin on the danmu.js side, given the record that holds it.
   *
   * `dropped` means the bullet is going away regardless — its own record is
   * being torn down, or the whole layer is — so the freeze only has to be handed
   * back. Otherwise the bullet has to move again, and when danmu.js cannot
   * restart it the comment is removed instead: a bullet stranded in
   * `forcedPause` has no running transition, so the `transitionend` that its own
   * removal waits for would never arrive and it would hold its track forever.
   */
  const unpinRecord = useCallback((record: RuntimeBullet, id: string, dropped: boolean) => {
    const element = record.meta.element;
    if (element) {
      delete element.dataset.rliveDanmakuSelected;
      element.style.removeProperty("z-index");
    }
    if (dropped) {
      releaseDanmuJsPin(record.instance, id);
      return;
    }
    if (!resumeDanmuJsPin(record.instance, id)) {
      removeRecordRef.current(id, true);
      return;
    }
    // A resumed bullet only moves again once its main loop ticks.
    if (record.instance.status === "paused") record.instance.play();
  }, []);
  const unpinRecordRef = useRef(unpinRecord);
  useLayoutEffect(() => {
    unpinRecordRef.current = unpinRecord;
  }, [unpinRecord]);

  /** Ends the current pin, if any. See {@link unpinRecord} for `dropped`. */
  const releaseSelection = useCallback(
    (dropped = false) => {
      const selectedId = selectedIdRef.current;
      selectedIdRef.current = null;
      setHoverTarget(null);
      if (!selectedId) return;
      const record = recordsRef.current.get(selectedId);
      if (record) unpinRecord(record, selectedId, dropped);
    },
    [unpinRecord],
  );
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
    // The map entry is already gone, so `releaseSelection` could no longer find
    // the record: unpin through the one still in hand, before the element
    // references that cleanup needs are dropped below.
    if (selectedIdRef.current === id) {
      selectedIdRef.current = null;
      setHoverTarget(null);
      unpinRecordRef.current(record, id, true);
    }
    record.meta.element = undefined;
    record.meta.contentElement = undefined;
    record.meta.countElement = undefined;
    record.meta.countSlotElement = undefined;
    if (removeFromInstance) removeDanmuJsPin(record.instance, id);
    const layerHasRecords = Array.from(recordsRef.current.values()).some(
      (candidate) => candidate.instance === record.instance,
    );
    if (!layerHasRecords && record.instance.status === "playing") record.instance.pause();
  }, []);
  useLayoutEffect(() => {
    removeRecordRef.current = removeRecord;
  }, [removeRecord]);

  const selectBullet = useCallback(
    (id: string, element: HTMLElement) => {
      const record = recordsRef.current.get(id);
      const host = hostRef.current;
      if (!record || !host) return;
      if (selectedIdRef.current && selectedIdRef.current !== id) releaseSelection();

      selectedIdRef.current = id;
      element.dataset.rliveDanmakuSelected = "true";
      record.instance.freezeComment(id);
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
    enqueueDanmuJsPending(pendingEventsRef.current, events);
  }, []);

  /**
   * Drops records for comments danmu.js accepted but never rendered.
   *
   * `Main.readData` discards a real-time comment without building a Bullet when
   * every lane is busy, and that path fires neither `bullet_remove` nor the
   * detach hook. Those records used to accumulate until the active budget was
   * exhausted, at which point the oldest record — a bullet still scrolling across
   * the stage — was evicted, which is why the first comments of a busy room
   * vanished mid-flight. Reclaiming them here keeps the budget honest about what
   * is actually on screen.
   */
  const sweepGhostRecords = useCallback(() => {
    const ghosts = danmuGhostRecordIds(recordOrderRef.current, recordsRef.current);
    for (const id of ghosts) removeRecordRef.current(id, true);
  }, []);

  const renderEvents = useCallback(
    (events: readonly DanmakuEvent[]) => {
      const instances = instancesRef.current;
      if (!sizeReadyRef.current || !instances) {
        queueEvents(events);
        return;
      }

      sweepGhostRecords();
      const maxActiveComments = danmuMaxActiveComments(
        stageHeightRef.current,
        laneHeightRef.current,
        areaRef.current,
      );
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
          // Merging into a comment that never reached the screen would hide the
          // repeat as well. A real-time comment attaches synchronously inside
          // `sendComment`, so an unattached target can only be a silent drop.
          if (target?.attached) {
            updateDanmuAggregation(target.comment, aggregation.count);
            continue;
          }
          aggregatorRef.current.forget(aggregation.key);
          aggregation = aggregatorRef.current.aggregate(event);
        }

        // Saturation drops the newest comment, never one already in flight: a
        // bullet that entered the stage has to be allowed to finish crossing it.
        // Fixed comments bypass the budget because they take no scrolling lane and
        // carry their own caps.
        if (!isPinnedDanmakuEvent(event) && recordsRef.current.size >= maxActiveComments) continue;

        const id = `rlive-danmu-${runtimeEpochRef.current}-${++sequenceRef.current}`;
        const comment = danmuCommentFromEvent(event, {
          id,
          fontSize: config.fontSize,
          fontStroke: config.fontStroke,
          opacity: config.opacity,
          aggregationKey: aggregation.key ?? undefined,
          aggregationCount: aggregation.count,
        });
        if (!comment) continue;
        const layer = danmuRenderLayer(comment);
        const instance = instances[layer];
        const meta = comment.__rliveMeta;
        recordsRef.current.set(id, {
          comment,
          meta,
          layer,
          instance,
          sentAt: Date.now(),
          attached: false,
        });
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
    [queueEvents, sweepGhostRecords],
  );
  const renderEventsRef = useRef(renderEvents);
  useLayoutEffect(() => {
    renderEventsRef.current = renderEvents;
  }, [renderEvents]);

  const flushPending = useCallback(() => {
    if (!sizeReadyRef.current || !instancesRef.current || document.hidden) return;
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
      if (!sizeReadyRef.current || !instancesRef.current || document.hidden) queueEvents(events);
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

  useEffect(() => {
    if (!active || reducedMotion || !pageVisible) return;
    return subscribeDanmakuBatches((events) => processBatchRef.current(events));
  }, [active, pageVisible, reducedMotion, sessionKey]);

  // Pending messages belong to a room session, not to one renderer instance.
  // The instance below is recreated when a zero-sized host becomes measurable,
  // so keep this boundary independent of `sizeReady` and clear the queue only
  // when the room/visibility session actually ends.
  useEffect(() => {
    const pendingEvents = pendingEventsRef.current;
    return () => {
      pendingEvents.length = 0;
    };
  }, [active, pageVisible, reducedMotion, sessionKey]);

  useEffect(() => {
    const scrollContainer = scrollContainerRef.current;
    const topContainer = topContainerRef.current;
    const records = recordsRef.current;
    const recordOrder = recordOrderRef.current;
    const aggregationTargets = aggregationTargetsRef.current;
    const pendingEvents = pendingEventsRef.current;
    const superChatIds = superChatIdsRef.current;
    const superChatTimers = superChatTimersRef.current;
    const superChatDedupeKeys = superChatDedupeKeysRef.current;
    const superChatDedupeOrder = superChatDedupeOrderRef.current;
    let disposed = false;
    let instances: DanmuJsInstances | null = null;
    let listenersAttached = false;
    let restoreFixedPriorCompat = () => {};

    const onBulletRemove = (payload: { bullet: DanmuJsBullet }) => {
      const id = bulletId(payload?.bullet?.id);
      if (id) removeRecordRef.current(id, false);
    };

    const destroyInstances = () => {
      const current = instances;
      if (!current) return;
      if (listenersAttached) {
        current.scroll.off("bullet_remove", onBulletRemove);
        current.top.off("bullet_remove", onBulletRemove);
        listenersAttached = false;
      }
      restoreFixedPriorCompat();
      restoreFixedPriorCompat = () => {};
      current.scroll.destroy();
      current.top.destroy();
      if (instancesRef.current === current) instancesRef.current = null;
      instances = null;
    };

    const clearRenderedState = (preservePending: boolean) => {
      releaseSelectionRef.current(true);
      for (const timer of superChatTimers.values()) window.clearTimeout(timer);
      superChatTimers.clear();
      for (const record of records.values()) {
        record.meta.element = undefined;
        record.meta.contentElement = undefined;
        record.meta.countElement = undefined;
        record.meta.countSlotElement = undefined;
      }
      records.clear();
      recordOrder.length = 0;
      aggregationTargets.clear();
      aggregatorRef.current.clear();
      if (!preservePending) pendingEvents.length = 0;
      superChatIds.length = 0;
      superChatDedupeKeys.clear();
      superChatDedupeOrder.length = 0;
      sequenceRef.current = 0;
      destroyInstances();
      scrollContainer?.replaceChildren();
      topContainer?.replaceChildren();
    };

    if (!active || reducedMotion || !pageVisible || !scrollContainer || !topContainer) {
      clearRenderedState(false);
      return;
    }

    // A zero-sized host is common while a room tab or grid cell is entering.
    // Tear down any old bullets, but leave the bounded pending queue intact so
    // the first valid measurement can flush messages received in the interim.
    if (!sizeReady) {
      clearRenderedState(true);
      return;
    }

    runtimeEpochRef.current += 1;

    void loadDanmuJs()
      .then((Constructor) => {
        if (disposed) return;
        const hooks = {
          bulletCreateEl: (comment: DanmuJsComment) => createDanmuBulletElement(comment),
          bulletAttached: (comment: DanmuJsComment, element: HTMLElement) => {
            const meta = commentMeta(comment);
            if (!meta) return;
            meta.element = element;
            element.dataset.rliveDanmakuId = meta.id;
            const record = recordsRef.current.get(meta.id);
            if (record) record.attached = true;
            if (selectedIdRef.current === meta.id) {
              element.dataset.rliveDanmakuSelected = "true";
            }
          },
          bulletDetached: (comment: DanmuJsComment, element: HTMLElement) => {
            const meta = commentMeta(comment);
            if (meta?.element === element) {
              meta.element = undefined;
              meta.contentElement = undefined;
              meta.countElement = undefined;
              meta.countSlotElement = undefined;
            }
            // A real-time comment can be rejected when every channel is
            // occupied. danmu.js does not emit bullet_remove for that path,
            // so release the local record from the detach hook as well.
            if (meta) removeRecordRef.current(meta.id, false);
          },
        };
        const createInstance = (container: HTMLElement, layer: DanmuJsRenderLayer) =>
          new Constructor({
            container,
            comments: [],
            live: true,
            defaultOff: true,
            area: danmuLayerAreaConfig(layer, areaRef.current),
            channelSize: laneHeightRef.current,
            // Pinning is driven by our own press delegate on the layer below, so
            // danmu.js' hover path stays off. It also owns a single global freeze
            // slot whose `mouseControl` flag, once set, suppresses every later
            // hover on the instance — nothing here should be able to set it.
            mouseControl: false,
            mouseControlPause: false,
            needResizeObserver: true,
            maxCommentsLength: DANMU_JS_MAX_ACTIVE_COMMENTS,
            interval: 250,
            chaseEffect: true,
            disableCopyDOM: true,
            hooks,
          });

        let scrollInstance: DanmuJsInstance | null = null;
        try {
          scrollInstance = createInstance(scrollContainer, "scroll");
          const topInstance = createInstance(topContainer, "top");
          instances = { scroll: scrollInstance, top: topInstance };
        } catch (error) {
          scrollInstance?.destroy();
          throw error;
        }
        if (disposed) {
          destroyInstances();
          return;
        }
        restoreFixedPriorCompat = installDanmuJsFixedPriorCompat(instances.top);
        instances.scroll.setPlayRate("scroll", danmuMoveVPlayRate(configRef.current.danmakuSpeed));
        instancesRef.current = instances;
        instances.scroll.on("bullet_remove", onBulletRemove);
        instances.top.on("bullet_remove", onBulletRemove);
        listenersAttached = true;
        instances.scroll.resize();
        instances.top.resize();
        flushPendingRef.current();
      })
      .catch((error: unknown) => {
        if (!disposed) {
          clearRenderedState(true);
          console.error("Unable to initialize danmu.js", error);
        }
      });

    return () => {
      disposed = true;
      // Size changes and the session-boundary cleanup both pass through here.
      // The separate session effect above owns pending-queue invalidation.
      clearRenderedState(true);
    };
  }, [active, pageVisible, reducedMotion, sessionKey, sizeReady]);

  useEffect(() => {
    instancesRef.current?.scroll.setPlayRate("scroll", danmuMoveVPlayRate(danmakuSpeed));
  }, [danmakuSpeed]);

  useEffect(() => {
    const instances = instancesRef.current;
    if (!instances) return;
    instances.scroll.setFontSize(fontSize, laneHeight);
    instances.top.setFontSize(fontSize, laneHeight);
    instances.scroll.setArea({ ...danmuLayerAreaConfig("scroll", normalizedArea), reflow: true });
    for (const { comment } of recordsRef.current.values()) {
      updateDanmuAppearance(comment, {
        fontSize,
        fontStroke,
        opacity,
      });
    }
  }, [fontSize, fontStroke, laneHeight, normalizedArea, opacity]);

  useEffect(() => {
    if (superChatEnabled && siteSupportsSuperChat(siteId)) return;
    const ids = superChatIdsRef.current.slice();
    for (const id of ids) removeRecordRef.current(id, true);
    superChatDedupeKeysRef.current.clear();
    superChatDedupeOrderRef.current.length = 0;
  }, [siteId, superChatEnabled]);

  useEffect(() => {
    releaseSelectionRef.current(true);
  }, [active, reducedMotion, sessionKey]);

  useEffect(() => {
    const selectedId = hoverTarget?.hoverKey;
    if (!selectedId) return;

    const dismissOnOutsidePointerDown = (event: PointerEvent) => {
      if (isMenuTarget(event.target)) return;
      const targetBullet = bulletElementFromTarget(event.target);
      if (targetBullet?.dataset.rliveDanmakuId === selectedId) return;
      releaseSelection();
    };

    // Pinning is press-driven on both desktop and touch, so a pin ends on the
    // next press that lands anywhere other than this comment or its menu. Listen
    // in the capture phase above the player so chrome that stops propagation
    // still dismisses the pin.
    document.addEventListener("pointerdown", dismissOnOutsidePointerDown, true);
    return () => document.removeEventListener("pointerdown", dismissOnOutsidePointerDown, true);
  }, [hoverTarget?.hoverKey, releaseSelection]);

  useEffect(() => {
    if (!hoverTarget?.hoverKey) return;
    // Nothing outside this component can be relied on to end a pin: a stage
    // resize, a layer teardown or a rejected re-attach can all strand the frozen
    // bullet. Expire the pin on its own so a comment can never stay parked.
    const timer = window.setTimeout(
      () => releaseSelectionRef.current(),
      DANMU_JS_PIN_AUTO_RELEASE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [hoverTarget?.hoverKey]);

  useEffect(() => {
    const selectedId = hoverTarget?.hoverKey;
    const host = hostRef.current;
    if (!selectedId || !host) return;
    let frame = 0;
    const update = () => {
      const meta = recordsRef.current.get(selectedId)?.meta;
      const rect = meta && relativeVisualRect(host, meta);
      if (!meta || !rect) {
        // The bullet lost its box, but it may still sit in the render queue in
        // `forcedPause`. Go through the resuming path so it cannot stay parked.
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

  // Desktop and touch share one press gesture. Which comment a press aims at is
  // decided on pointerdown, because the comment keeps moving underneath: only the
  // press being short and still is checked on pointerup, so a volume/brightness
  // drag that happens to begin on a comment still reaches the stage. The
  // document-level delegate above owns dismissal.
  const handleLayerPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const bullet = bulletElementFromTarget(event.target);
    const id = bullet?.dataset.rliveDanmakuId;
    if (!id || !recordsRef.current.has(id)) {
      pinTapRef.current = null;
      return;
    }
    pinTapRef.current = {
      pointerId: event.pointerId,
      id,
      element: bullet,
      startX: event.clientX,
      startY: event.clientY,
      startedAt: Date.now(),
    };
  }, []);

  const finishPress = useCallback(
    (event: PointerEvent) => {
      const tap = pinTapRef.current;
      if (!tap || tap.pointerId !== event.pointerId) return;
      pinTapRef.current = null;
      if (
        !isDanmakuPinTap(
          event.clientX - tap.startX,
          event.clientY - tap.startY,
          Date.now() - tap.startedAt,
        )
      ) {
        return;
      }
      if (!recordsRef.current.has(tap.id)) return;
      // Claim the completed press: the stage reads `defaultPrevented` and will
      // not turn it into a control-bar toggle or a double-tap fullscreen.
      event.preventDefault();
      claimedPressAtRef.current = Date.now();
      if (selectedIdRef.current === tap.id) releaseSelection();
      else selectBullet(tap.id, tap.element);
    },
    [releaseSelection, selectBullet],
  );
  const finishPressRef = useRef(finishPress);
  useLayoutEffect(() => {
    finishPressRef.current = finishPress;
  }, [finishPress]);

  useEffect(() => {
    // The release cannot be caught on the layer itself. A comment keeps moving
    // under the pointer, and the layer takes no pointer events, so a mouse
    // pointerup a few frames after the press often hit-tests to the picture
    // instead. Touch is different again — it captures to the element that got the
    // pointerdown — so the only place that reliably sees both is the document.
    // Capture phase, above the stage, is also what lets `preventDefault` reach
    // the stage's own bubble-phase tap handler in time.
    const onPointerUp = (event: PointerEvent) => finishPressRef.current(event);
    const onPointerCancel = (event: PointerEvent) => {
      if (pinTapRef.current?.pointerId === event.pointerId) pinTapRef.current = null;
    };
    // `preventDefault` on a pointerup does not stop the click and dblclick it
    // produces, and those bubble to ancestors that read a press on the picture as
    // their own gesture (the multi-room grid promotes a cell that way). Their
    // target is the common ancestor of press and release, so a drifted comment
    // leaves them pointing at the picture: go by the claim the press recorded.
    const swallowClaimedClick = (event: MouseEvent) => {
      if (isMenuTarget(event.target)) return;
      if (Date.now() - claimedPressAtRef.current > DANMU_JS_PIN_CLAIM_WINDOW_MS) return;
      event.stopPropagation();
    };
    // Any press that did not start on a comment ends the claim, so pressing a
    // control right after pinning is never swallowed by the window above.
    const dropStaleClaim = (event: PointerEvent) => {
      if (!bulletElementFromTarget(event.target)) claimedPressAtRef.current = 0;
    };
    document.addEventListener("pointerdown", dropStaleClaim, true);
    document.addEventListener("pointerup", onPointerUp, true);
    document.addEventListener("pointercancel", onPointerCancel, true);
    document.addEventListener("click", swallowClaimedClick, true);
    document.addEventListener("dblclick", swallowClaimedClick, true);
    return () => {
      document.removeEventListener("pointerdown", dropStaleClaim, true);
      document.removeEventListener("pointerup", onPointerUp, true);
      document.removeEventListener("pointercancel", onPointerCancel, true);
      document.removeEventListener("click", swallowClaimedClick, true);
      document.removeEventListener("dblclick", swallowClaimedClick, true);
    };
  }, []);

  return (
    <div ref={hostRef} className={cn("pointer-events-none absolute inset-0", className)}>
      <div
        ref={scrollContainerRef}
        aria-hidden="true"
        data-rlive-danmaku-layer="scroll"
        // The layer itself never takes the pointer; only the bullet text inside
        // it does (see `createDanmuBulletElement`), which is what makes a press
        // on empty picture fall through to the stage.
        className="pointer-events-none absolute inset-0 z-0 overflow-hidden"
        style={{ opacity: 1 }}
        onPointerDown={handleLayerPointerDown}
      />
      <div
        ref={topContainerRef}
        aria-hidden="true"
        data-rlive-danmaku-layer="top"
        className="pointer-events-none absolute inset-0 z-[1] overflow-hidden"
        style={{ opacity: 1 }}
        onPointerDown={handleLayerPointerDown}
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
