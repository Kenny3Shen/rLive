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
 * 钉住评论的安全网。
 *
 * 钉住会把 danmu.js 的 Bullet 停在 `forcedPause` 状态，只有显式 restart 才能离开。
 * 下方的每条解除路径都会释放它，但曾有一条冻结的评论跨越舞台缩放或层销毁后
 * 永远停在屏幕上，因此钉住也会自行过期。时长刻意宽松：
 * 绝不能打断还在阅读自己钉住的评论的人。
 */
const DANMU_JS_PIN_AUTO_RELEASE_MS = 20_000;
/**
 * 只有保持原地的按压才构成钉住，这样碰巧从评论上开始的音量/亮度拖拽不会被
 * 读成钉住。对齐 `PlayerPane` 的舞台点按阈值；复制而非导入，
 * 因为那个模块渲染本模块。
 */
const DANMU_JS_PIN_TAP_MAX_DISTANCE_PX = 14;
const DANMU_JS_PIN_TAP_MAX_DURATION_MS = 320;
/**
 * 被认领的按压在多长时间内继续抑制由它派生的鼠标事件。`click` 与其 `pointerup`
 * 在同一任务中先后发生，双击的 `dblclick` 跟在第二次之后，
 * 所以只需比一次手势多活片刻。
 */
const DANMU_JS_PIN_CLAIM_WINDOW_MS = 500;

/** 短促且基本不动的按压：是钉住，不是手势的开始。 */
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
  /**
   * 把到达的评论延后这么多毫秒。
   *
   * 多视图时钟对齐可能让一条流落后其直播边缘数秒；评论由服务器实时下发，
   * 不加同样的延迟，它们描述的就是画面尚未到达的时刻。
   */
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
  superChatEnabled: boolean;
  siteId?: SiteId;
};

type RuntimeBullet = {
  comment: DanmuJsComment & { __rliveMeta: DanmuJsBulletMeta };
  meta: DanmuJsBulletMeta;
  layer: DanmuJsRenderLayer;
  instance: DanmuJsInstance;
  /** 交给 danmu.js 的时间，供下方幽灵清扫使用。 */
  sentAt: number;
  /** 由挂载钩子设置：只有已挂载的评论屏幕上才有 bullet。 */
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
  delayMs = 0,
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
   * 在 danmu.js 一侧撤销一次钉住，传入持有它的记录。
   *
   * `dropped` 表示 bullet 无论如何都要消失 —— 它自己的记录正在销毁或整个层正在
   * 销毁 —— 因此只需交还冻结状态。否则 bullet 必须重新移动，而当 danmu.js 无法
   * 重启它时改为移除评论：困在 `forcedPause` 的 bullet 没有运行中的 transition，
   * 其自身删除所等待的 `transitionend` 永远不会到来，
   * 会永远占着车道。
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
    // 恢复的 bullet 要等主循环 tick 之后才会重新移动。
    if (record.instance.status === "paused") record.instance.play();
  }, []);
  const unpinRecordRef = useRef(unpinRecord);
  useLayoutEffect(() => {
    unpinRecordRef.current = unpinRecord;
  }, [unpinRecord]);

  /** 结束当前的钉住（若有）。`dropped` 见 {@link unpinRecord}。 */
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
    // map 条目已经不在了，`releaseSelection` 无法找到记录：趁下方丢弃清理所需的
    // 元素引用之前，用手头仍在的这条执行 unpin。
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
   * 丢弃 danmu.js 接受却从未渲染的评论记录。
   *
   * `Main.readData` 在所有车道都忙时会直接丢弃实时评论而不构建 Bullet，
   * 且该路径既不触发 `bullet_remove` 也不触发 detach 钩子。这些记录曾不断累积
   * 直到活动预算耗尽，然后最旧的记录 —— 一颗还在舞台上滚动的 bullet —— 被
   * 淘汰，这正是繁忙房间的前几条评论中途消失的原因。在这里回收它们，
   * 让预算如实反映屏幕上实际存在的内容。
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
          // 合并进一条从未上屏的评论会把重复计数也藏掉。实时评论在 `sendComment`
          // 内同步挂载，未挂载的目标只能是静默丢弃的结果。
          if (target?.attached) {
            updateDanmuAggregation(target.comment, aggregation.count);
            continue;
          }
          aggregatorRef.current.forget(aggregation.key);
          aggregation = aggregatorRef.current.aggregate(event);
        }

        // 饱和时丢弃最新的评论，绝不在途中的那条：已进入舞台的 bullet
        // 必须被允许走完全程。固定弹幕绕过预算，
        // 因为它们不占用滚动车道且有自己的上限。
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

  const delayMsRef = useRef(delayMs);
  useLayoutEffect(() => {
    // 保存在 ref 里，使滞留值变化不会让批量流重新订阅。
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

  // 待处理消息属于房间会话，不属于某个渲染器实例。零尺寸宿主变为可测量时下方
  // 实例会被重建，因此这道边界要独立于 `sizeReady`，
  // 只在房间/可见性会话真正结束时清空队列。
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

    // 房间页签或网格单元进入时宿主尺寸为零很常见。拆除旧 bullet，
    // 但保留有界待处理队列，让第一次有效测量能冲刷期间收到的消息。
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
            // 所有通道都被占用时实时评论可能被拒绝。danmu.js 对该路径不发 bullet_remove，
            // 因此也要从 detach 钩子释放本地记录。
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
            // 钉住由下层自己的按压委托驱动，danmu.js 的 hover 路径保持关闭。它还拥有唯一
            // 的全局冻结槽位，其 `mouseControl` 标志一旦设置会抑制实例上的所有后续 hover
            // —— 本组件任何地方都不应能设置它。
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
      // 尺寸变化与会话边界清理都会经过这里。上方独立的会话副作用负责待处理队列失效。
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

    document.addEventListener("pointerdown", dismissOnOutsidePointerDown, true);
    return () => document.removeEventListener("pointerdown", dismissOnOutsidePointerDown, true);
  }, [hoverTarget?.hoverKey, releaseSelection]);

  useEffect(() => {
    if (!hoverTarget?.hoverKey) return;
    // 结束一次钉住不能依赖组件之外的任何东西：舞台缩放、层销毁或被拒绝的
    // 重新挂载都可能让冻结的 bullet 受困。让钉住自行过期，
    // 评论才绝不可能一直停驻。
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
        // 释放无法在评论层自身捕获。评论持续在指针下移动，而层本身不接受指针事件，
        // 按压数帧后的鼠标 pointerup 命中测试往往落在画面上。触摸又是另一回事 ——
        // 它会捕获到收到 pointerdown 的元素 —— 因此唯一能可靠看到两者的是 document。
        // 在舞台上方的捕获阶段监听，也让 `preventDefault` 能及时抵达舞台自己的
        // 冒泡阶段点按处理器。
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

  // 桌面与触摸共用同一种按压手势。按压瞄准哪条评论在 pointerdown 时决定，
  // 因为评论一直在指针下方移动；pointerup 只检查按压是否短促且原地不动，
  // 于是碰巧始于评论的音量/亮度拖拽仍会到达舞台。文档级委托负责解除。
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
      // 认领已完成按压：舞台读取 `defaultPrevented`，
      // 不会把它变成控制条切换或双击全屏。
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
    // 层本身从不接受指针；只有其中的 bullet 文本接受（见 `createDanmuBulletElement`），
    // 这正是空白画面的按压能落到舞台的原因。
    const onPointerUp = (event: PointerEvent) => finishPressRef.current(event);
    const onPointerCancel = (event: PointerEvent) => {
      if (pinTapRef.current?.pointerId === event.pointerId) pinTapRef.current = null;
    };
    // pointerup 上的 `preventDefault` 阻止不了它产生的 click 与 dblclick，
    // 而这些会冒泡到把画面上的按压当作自己手势的祖先（多房间网格正是借此提升
    // 单元）。它们的目标是按压与释放的共同祖先，漂移中的评论会让目标指向画面：
    // 因此依据按压记录下的认领来判断。
    const swallowClaimedClick = (event: MouseEvent) => {
      if (isMenuTarget(event.target)) return;
      if (Date.now() - claimedPressAtRef.current > DANMU_JS_PIN_CLAIM_WINDOW_MS) return;
      event.stopPropagation();
    };
    // 任何不是从评论上开始的按压都会终止认领，因此钉住后立即按下控件
    // 绝不会被上面的窗口监听吞掉。
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
        // 层本身从不接受指针；只有其中的 bullet 文本接受（见 `createDanmuBulletElement`），
        // 这正是空白画面的按压能落到舞台的原因。
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
