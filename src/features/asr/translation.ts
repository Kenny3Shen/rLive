import { translate } from "@vitalets/google-translate-api";
import type {
  CaptionTranslationLanguage,
  CaptionTranslationSourceLanguage,
} from "@/shared/types/live";

type TranslateImplementation = (
  text: string,
  options: {
    from: CaptionTranslationSourceLanguage;
    to: CaptionTranslationLanguage;
    fetchOptions?: { signal: AbortSignal };
  },
) => Promise<{ text: string }>;

const googleTranslate: TranslateImplementation = (text, options) =>
  translate(text, options as never);

export type CaptionTranslationFailureKind = "rate_limited" | "timeout" | "unavailable";

export type CaptionTranslationFailure = {
  kind: CaptionTranslationFailureKind;
  message: string;
};

export function describeCaptionTranslationFailure(error: unknown): CaptionTranslationFailure {
  const record =
    typeof error === "object" && error !== null ? (error as Record<string, unknown>) : null;
  const status = record?.status ?? record?.statusCode;
  if (status === 429 || record?.name === "TooManyRequestsError") {
    return {
      kind: "rate_limited",
      message: "翻译请求过于频繁，已保留原字幕。关闭后重新开启可重试。",
    };
  }
  if (record?.name === "CaptionTranslationTimeoutError") {
    return { kind: "timeout", message: "字幕翻译超时，已保留原字幕。" };
  }
  if (record?.name === "TauriUnavailableError") {
    return { kind: "unavailable", message: "字幕翻译仅在 rLive 客户端中可用。" };
  }
  return { kind: "unavailable", message: "字幕翻译暂时不可用，已保留原字幕。" };
}

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_CACHE_LIMIT = 160;

/** A small LRU cache prevents repeated live phrases from consuming API quota. */
export class CaptionTranslationClient {
  private readonly cache = new Map<string, string>();

  constructor(
    private readonly translateImplementation: TranslateImplementation = googleTranslate,
    private readonly cacheLimit = DEFAULT_CACHE_LIMIT,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  async translate(
    input: string,
    from: CaptionTranslationSourceLanguage,
    to: CaptionTranslationLanguage,
  ): Promise<string> {
    const text = input.trim();
    if (!text || from === to) return text;

    const key = `${from}\u0000${to}\u0000${text}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached;
    }

    const controller = new AbortController();
    const timeout = globalThis.setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const result = await this.translateImplementation(text, {
        from,
        to,
        fetchOptions: { signal: controller.signal },
      });
      const translated = result.text.trim();
      if (!translated) throw new Error("Google Translate returned an empty caption");

      this.cache.set(key, translated);
      while (this.cache.size > this.cacheLimit) {
        const oldest = this.cache.keys().next().value;
        if (oldest === undefined) break;
        this.cache.delete(oldest);
      }
      return translated;
    } catch (error) {
      if (controller.signal.aborted) {
        const timeoutError = new Error("Caption translation timed out");
        timeoutError.name = "CaptionTranslationTimeoutError";
        throw timeoutError;
      }
      throw error;
    } finally {
      globalThis.clearTimeout(timeout);
    }
  }
}

export const captionTranslationClient = new CaptionTranslationClient();
