import type { DanmakuEvent, DanmakuKind } from "@/shared/types/live";
import { hasValidDanmakuContentSpans } from "./content";

function normalizedShieldWords(shieldWords: readonly string[]): string[] {
  const seen = new Set<string>();
  const words: string[] = [];
  for (const rawWord of shieldWords) {
    if (typeof rawWord !== "string") continue;
    const word = rawWord.trim().toLowerCase();
    if (!word || seen.has(word)) continue;
    seen.add(word);
    words.push(word);
  }
  return words;
}

function matchesShieldWords(event: DanmakuEvent, shieldWords: readonly string[]): boolean {
  if (shieldWords.length === 0 || event.kind === "system") return false;
  const lower = (event.content || "").toLowerCase();
  if (!lower) return true;
  return shieldWords.some((word) => lower.includes(word));
}

const DANMAKU_KINDS: readonly DanmakuKind[] = [
  "chat",
  "gift",
  "enter",
  "social",
  "super_chat",
  "system",
];

/**
 * Tauri 事件源自 TypeScript 类型系统之外。把畸形负载当作一条被丢弃的消息，
 * 而不是让繁忙的监听器抛异常。
 */
export function isDanmakuEvent(value: unknown): value is DanmakuEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<DanmakuEvent>;
  return (
    typeof event.kind === "string" &&
    DANMAKU_KINDS.includes(event.kind as DanmakuKind) &&
    typeof event.user === "string" &&
    typeof event.content === "string" &&
    typeof event.ts === "number" &&
    Number.isFinite(event.ts) &&
    (event.is_self === undefined || typeof event.is_self === "boolean") &&
    (event.color === null || typeof event.color === "string") &&
    (event.spans === undefined || event.spans === null || hasValidDanmakuContentSpans(event.spans))
  );
}

const ROOM_ENTER_SUFFIXES = ["进入直播间", "进入了直播间", "进入直播间了"];

function hasRoomEnterSuffix(content: string): boolean {
  // 保持常见聊天路径零分配。三种受支持通知只以这两个字符之一结尾；关键是
  // `进入直播间了` 以 `了` 结尾，而不是 `间`。
  const finalCharacter = content.at(-1);
  if (finalCharacter !== "间" && finalCharacter !== "了") return false;
  return ROOM_ENTER_SUFFIXES.some((suffix) => content.endsWith(suffix));
}

/**
 * 部分中继把进房通知编码为普通聊天文本而不是共享的 `enter` 事件。归一化空白
 * 使"小明进入直播间"和"小明 进入了直播间"在上游兜底之后
 * 都能被一致地抑制。
 */
function isRoomEnterNotice(kind: DanmakuKind, content: string): boolean {
  if (kind === "enter") return true;
  // 它对每条聊天行都会运行。避免为普通消息分配空白归一化副本。`进入直播间了`
  // 刻意纳入快速路径，因为它以 `了` 结尾而非 `间`。
  if (hasRoomEnterSuffix(content)) return true;
  const finalCharacter = content.at(-1);
  if (finalCharacter !== "间" && finalCharacter !== "了") return false;
  // 继续支持在通知中插入空格的中继，
  // 同时不在高频常规路径上支付全局替换的开销。
  if (!/\s/.test(content)) return false;
  const compact = content.replaceAll(/\s+/g, "");
  return hasRoomEnterSuffix(compact);
}

/**
 * 为高频弹幕监听准备屏蔽匹配器。设置列表只在变化时归一化，
 * 而不是每条消息一次。
 */
export function createShieldMatcher(
  shieldWords: readonly string[],
): (event: DanmakuEvent) => boolean {
  const words = normalizedShieldWords(shieldWords);
  return (event) => matchesShieldWords(event, words);
}

/** 列表与直播悬浮层共享的屏蔽词过滤器。 */
export function isShielded(event: DanmakuEvent, shieldWords: readonly string[]): boolean {
  return matchesShieldWords(event, normalizedShieldWords(shieldWords));
}

/**
 * 在所有位置隐藏服务型进房通知。繁忙斗鱼房间里它们非常吵；
 * 斗鱼会在 IPC 前额外丢弃它们，而这里让其他站点在发出共享 `enter` 事件时
 * 保持一致。平台社交通知（"关注了主播"、"分享了房间"）同样是服务层噪音，
 * 因此 `social` 类型适用同一刀切规则。
 */
export function shouldShowValidatedInDanmakuPanel(
  event: DanmakuEvent,
  filterGifts = false,
): boolean {
  const content = event.content.trim();
  return (
    Boolean(content) &&
    !isRoomEnterNotice(event.kind, content) &&
    event.kind !== "social" &&
    !(filterGifts && event.kind === "gift")
  );
}

export function shouldShowInDanmakuPanel(
  event: unknown,
  filterGifts = false,
): event is DanmakuEvent {
  return isDanmakuEvent(event) && shouldShowValidatedInDanmakuPanel(event, filterGifts);
}

export const DANMAKU_CONTENT_AGGREGATION_WINDOW_MS = 10_000;
export const DANMAKU_CONTENT_AGGREGATION_WINDOW_MIN_MS = 1_000;
export const DANMAKU_CONTENT_AGGREGATION_WINDOW_MAX_MS = 30_000;
const MAX_CONTENT_AGGREGATION_KEYS = 512;

export type DanmakuContentAggregation = {
  /** 全平台、全发送者共享；null 表示该事件不参与分组。 */
  key: string | null;
  count: number;
};

export type DanmakuContentAggregator = {
  aggregate: (event: DanmakuEvent) => DanmakuContentAggregation;
  /** 当其展示条目跌出有界信息流时停止计数。 */
  forget: (key: string) => void;
  clear: () => void;
};

/**
 * 普通聊天使用仅内容的 key，并按是否来自本地账号区分。全房间的"加油"刷屏保持
 * 紧凑，而本地评论绝不会折叠进另一位观众的视觉处理（反之亦然）。
 */
export function danmakuContentAggregationKey(event: DanmakuEvent): string | null {
  if (event.kind !== "chat") return null;
  const content = event.content.trim();
  return content ? `${event.is_self === true ? "self" : "other"}\u0000${content}` : null;
}

export function aggregatedDanmakuText(content: string, count: number): string {
  const normalized = content.trim();
  return count > 1 ? `${normalized} ×${count}` : normalized;
}

/**
 * 维护有界、可配置的滑动内容窗口。它刻意忽略礼物和 SC，
 * 因为这些消息携带独立语义。
 */
export function createDanmakuContentAggregator(
  enabled: boolean,
  windowMs = DANMAKU_CONTENT_AGGREGATION_WINDOW_MS,
): DanmakuContentAggregator {
  const entries = new Map<string, { at: number; count: number }>();
  const safeWindowMs = Math.min(
    DANMAKU_CONTENT_AGGREGATION_WINDOW_MAX_MS,
    Math.max(
      DANMAKU_CONTENT_AGGREGATION_WINDOW_MIN_MS,
      Number.isFinite(windowMs) ? Math.round(windowMs) : DANMAKU_CONTENT_AGGREGATION_WINDOW_MS,
    ),
  );

  const trimToCapacity = () => {
    while (entries.size > MAX_CONTENT_AGGREGATION_KEYS) {
      const oldestKey = entries.keys().next().value;
      if (oldestKey === undefined) return;
      entries.delete(oldestKey);
    }
  };

  return {
    aggregate: (event) => {
      const key = enabled ? danmakuContentAggregationKey(event) : null;
      if (!key) return { key: null, count: 1 };

      const at = Number.isFinite(event.ts) ? event.ts : Date.now();
      const previous = entries.get(key);
      const count =
        previous && at >= previous.at && at - previous.at <= safeWindowMs ? previous.count + 1 : 1;

      // Map 的插入顺序兼作小型 LRU 队列。包含大量唯一评论的突发流量
      // 因此无法保留无界的键历史。
      entries.delete(key);
      entries.set(key, { at, count });
      trimToCapacity();
      return { key, count };
    },
    forget: (key) => {
      entries.delete(key);
    },
    clear: () => {
      entries.clear();
    },
  };
}

/** 悬浮轨道文本：只显示内容。Super chat 保留简短的 SC 标记以示强调。 */
export function floatingDanmakuText(event: DanmakuEvent): string {
  const content = event.content.trim();
  if (!content) return "";
  if (event.kind === "super_chat") {
    return content.startsWith("【SC】") ? content : `【SC】${content}`;
  }
  if (event.kind === "gift" || event.kind === "enter") {
    return content;
  }
  return content;
}

export function shouldShowValidatedOnFloatingDanmaku(
  event: DanmakuEvent,
  filterGifts = false,
): boolean {
  if (!shouldShowValidatedInDanmakuPanel(event, filterGifts)) return false;
  if (event.kind === "system") return false;
  return true;
}

export function shouldShowOnFloatingDanmaku(
  event: unknown,
  filterGifts = false,
): event is DanmakuEvent {
  return isDanmakuEvent(event) && shouldShowValidatedOnFloatingDanmaku(event, filterGifts);
}
