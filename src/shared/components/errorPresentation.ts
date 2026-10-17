import type { AppError } from "@/shared/types/error";

/**
 * 错误卡的呈现内容：一句可读的说明 + 可展开的原始诊断。
 *
 * 取流链路把后端与上游的原始报错原样带到前端，其中既有 `HTTP 412: <!DOCTYPE html>`
 * 这种整页响应，也有几十行的解析堆栈。把它们直接铺进错误卡，用户既读不懂，长串
 * 无断点的 URL 还会把卡片撑出容器。这里把「说明」与「诊断」分开：说明只保留短、
 * 可读的句子，其余全部收进技术详情，文字本身不做删改。
 */

/** 说明区最多显示多少个字符；更长的内容一定有上下文缺失，交给技术详情。 */
const MAX_INLINE_MESSAGE_LENGTH = 160;

const GENERIC_DESCRIPTION = "请求没有成功。请检查网络后重试，或稍后再试。";

function messageFromError(error: unknown): string {
  if (typeof error === "string") return error;
  if (typeof error === "number" || typeof error === "boolean") return String(error);
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error && "message" in error) {
    const message = (error as { message?: unknown }).message;
    // 只有字符串/数字才是上游给的说明；对象形态的 message（base-ui 事件载荷等）
    // 转成 `[object Object]` 只会挤进技术详情，不如不留。
    return typeof message === "string" || typeof message === "number" ? String(message) : "";
  }
  return "";
}

function codeFromError(error: unknown): string | null {
  if (typeof error === "object" && error && "code" in error) {
    return String((error as AppError).code);
  }
  return null;
}

/**
 * 这句话是否只适合放进技术详情。
 *
 * 判据是「内容形态」而不是「是否来自网络」：HTML 响应、URL、多行堆栈、HTTP 状态行
 * 都属于排查信息；后端给出的中文业务说明（例如「该视频没有声音」）仍然直接显示。
 */
export function errorMessageLooksTechnical(message: string): boolean {
  if (message.length > MAX_INLINE_MESSAGE_LENGTH) return true;
  if (/<\/?[a-z][\s\S]*>/i.test(message)) return true;
  if (/https?:\/\//i.test(message)) return true;
  if (/\bHTTP\s+\d{3}\b/i.test(message)) return true;
  // 堆栈帧既可能带前导换行，也可能只有一行（`at async fetch (...)`）；后者同样
  // 不是给用户看的说明。常见框架的 `file.ts:1:2` 位置也一并归入技术详情。
  if (/(?:^|[\n\r])\s*at\s+\S|\b[\w./-]+\.(?:[cm]?[jt]sx?):\d+:\d+/.test(message)) return true;
  if (/\b(?:TypeError|ReferenceError|SyntaxError|Error):/.test(message)) return true;
  return false;
}

export type ErrorPresentation = {
  /** 面向用户的说明；永远不会是 HTML、URL 或整段堆栈。 */
  description: string;
  /** 展开后展示的原始诊断信息（含错误码）；没有可展示内容时为 null。 */
  technical: string | null;
};

export function errorPresentation(error: unknown): ErrorPresentation {
  const raw = messageFromError(error).trim();
  const code = codeFromError(error)?.trim() || null;
  const message = raw || null;
  const technical = [code && message ? `${code}: ${message}` : (code ?? message)]
    .filter((part): part is string => Boolean(part))
    .join("\n");
  const description =
    !message || errorMessageLooksTechnical(message) ? GENERIC_DESCRIPTION : message;
  return { description, technical: technical || null };
}
