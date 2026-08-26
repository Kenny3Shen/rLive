import { proxyImageUrl } from "@/shared/api/imageProxy";
import type { DanmakuContentSpan, DanmakuEvent } from "@/shared/types/live";

/** 协议图片表情以聊天字号的 1.35 倍渲染。 */
export const DANMAKU_IMAGE_SCALE = 1.35;
/** 单个图片表情周围的内联呼吸空间总量，CSS 像素。 */
export const DANMAKU_IMAGE_HORIZONTAL_GAP = 2;
/** URL 被拒绝或请求失败的表情的替代显示。 */
export const DANMAKU_IMAGE_FALLBACK_TEXT = "[表情]";
/**
 * 桌面 webview 的 `tauri://…` Referer 会被 Bilibili CDN 以 403 拒绝。
 * 显式省略它可使 DOM 图片请求与普通 Bilibili 页面使用的
 * 同一批 CDN URL 保持兼容。
 */
export const BILIBILI_DANMAKU_IMAGE_REFERRER_POLICY = "no-referrer" as const;

const MAX_DANMAKU_CONTENT_SPANS = 32;
const MAX_DANMAKU_IMAGE_URL_LENGTH = 2_048;

function isTrustedBilibiliImageHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "hdslb.com" ||
    host.endsWith(".hdslb.com") ||
    host === "bilibili.com" ||
    host.endsWith(".bilibili.com") ||
    host === "biliimg.com" ||
    host.endsWith(".biliimg.com")
  );
}

/**
 * Bilibili 弹幕负载可能使用协议相对的 CDN URL。在它进入 img 标签前转换为
 * HTTPS，且只保留平台自有图片 CDN。
 */
export function normalizeDanmakuImageUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const source = value.trim();
  if (!source || source.length > MAX_DANMAKU_IMAGE_URL_LENGTH) return null;
  const normalized = source.startsWith("//") ? `https:${source}` : source;
  try {
    const url = new URL(normalized);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      !isTrustedBilibiliImageHost(url.hostname)
    ) {
      return null;
    }
    // 原生解码器执行同样的升级。这里保留一份使浏览器侧守卫能应对旧格式负载，
    // 也避免未来后端事件直达 WebView 时产生混合内容请求。
    url.protocol = "https:";
    return url.href;
  } catch {
    return null;
  }
}

/**
 * 为已归一化的表情地址构造请求 URL。
 *
 * 表情是应用中重复度最高的图片：一个房间只用到几十个不同的表情，
 * 每个在会话中出现数千次，在其每场录制中还会再次出现。经本机图片代理路由后，
 * 它们与头像、分类图标共用磁盘缓存，
 * 重复出现只需本地读取而不是一次 CDN 往返。代理启动之前返回直连 CDN URL ——
 * 仍可加载（见 `BILIBILI_DANMAKU_IMAGE_REFERRER_POLICY`），
 * 但不会跨重启缓存。
 */
export function danmakuImageRequestUrl(imageUrl: string): string {
  return proxyImageUrl(imageUrl) ?? imageUrl;
}

export function isDanmakuContentSpan(value: unknown): value is DanmakuContentSpan {
  if (!value || typeof value !== "object") return false;
  const span = value as { type?: unknown; text?: unknown; image_url?: unknown };
  if (span.type === "text") return typeof span.text === "string";
  return span.type === "image" && normalizeDanmakuImageUrl(span.image_url) !== null;
}

export function hasValidDanmakuContentSpans(value: unknown): value is DanmakuContentSpan[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= MAX_DANMAKU_CONTENT_SPANS &&
    value.every(isDanmakuContentSpan)
  );
}

/** 只有确实存在图片需要替换时才返回富片段。纯文本数组走常规的无分配文本路径。 */
export function richDanmakuContent(spans: unknown): readonly DanmakuContentSpan[] | null {
  if (!hasValidDanmakuContentSpans(spans) || !spans.some((span) => span.type === "image")) {
    return null;
  }

  const normalized: DanmakuContentSpan[] = [];
  for (const span of spans) {
    if (span.type === "text") {
      if (span.text) normalized.push(span);
      continue;
    }
    const imageUrl = normalizeDanmakuImageUrl(span.image_url);
    if (imageUrl) normalized.push({ type: "image", image_url: imageUrl });
  }
  return normalized.some((span) => span.type === "image") ? normalized : null;
}

/**
 * 悬浮 bullet 的富文本片段；当负载只携带原始消息时补回 `【SC】` 标记。
 * 直播 DOM 渲染器与录制回放 canvas 都从这里读取片段，
 * 使两条路径无法产生偏差。
 */
export function floatingRichSpans(event: DanmakuEvent): readonly DanmakuContentSpan[] | undefined {
  const spans = richDanmakuContent(event.spans);
  if (!spans) return undefined;
  const firstSpan = spans[0];
  const hasSuperChatMarker =
    firstSpan?.type === "text" && firstSpan.text.trimStart().startsWith("【SC】");
  if (event.kind === "super_chat" && !hasSuperChatMarker) {
    return [{ type: "text", text: "【SC】" }, ...spans];
  }
  return spans;
}

/** 在最后一个富片段之后追加聚合后缀，不改变图片顺序。 */
export function withDanmakuContentSuffix(
  spans: readonly DanmakuContentSpan[],
  suffix: string,
): DanmakuContentSpan[] {
  if (!suffix) return [...spans];
  const next = [...spans];
  const last = next.at(-1);
  if (last?.type === "text") {
    next[next.length - 1] = { type: "text", text: `${last.text}${suffix}` };
  } else {
    next.push({ type: "text", text: suffix });
  }
  return next;
}
