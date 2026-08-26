import translate from "google-translate-api-x";
import fetchThroughTauri from "@/shared/api/tauriFetch";
import type {
  CaptionTranslationLanguage,
  CaptionTranslationSourceLanguage,
} from "@/shared/types/live";

type TranslateInput = string | string[];
type TranslateResult = { text: string } | { text: string }[];

type TranslateImplementation = (
  text: TranslateInput,
  options: {
    from: CaptionTranslationSourceLanguage;
    to: CaptionTranslationLanguage;
    signal: AbortSignal;
  },
) => Promise<TranslateResult>;

const googleTranslate: TranslateImplementation = async (text, options) => {
  const result = await translate(text, {
    from: options.from,
    to: options.to,
    forceBatch: true,
    requestFunction: fetchThroughTauri,
    requestOptions: { signal: options.signal },
  });
  return Array.isArray(result)
    ? result.map((translation) => ({ text: translation.text }))
    : { text: result.text };
};

export type CaptionTranslationFailureKind = "rate_limited" | "timeout" | "unavailable";

export type CaptionTranslationFailure = {
  kind: CaptionTranslationFailureKind;
  message: string;
};

function translationErrorStatus(error: unknown): unknown {
  const pending = [error];
  const visited = new Set<unknown>();
  while (pending.length > 0 && visited.size < 8) {
    const current = pending.shift();
    if (visited.has(current)) continue;
    visited.add(current);
    if (typeof current !== "object" || current === null) continue;
    const record = current as Record<string, unknown>;
    const status = record.status ?? record.statusCode;
    if (status !== undefined) return status;
    pending.push(record.cause, record.response);
  }
  return undefined;
}

export function describeCaptionTranslationFailure(error: unknown): CaptionTranslationFailure {
  const record =
    typeof error === "object" && error !== null ? (error as Record<string, unknown>) : null;
  const status = translationErrorStatus(error);
  if (status === 429 || record?.name === "TooManyRequestsError") {
    return {
      kind: "rate_limited",
      message: "Google 翻译请求受限，已保留原字幕。稍后重试或更换应用代理。",
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

/** 小型 LRU 缓存，避免重复的直播语句消耗 API 配额。 */
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
    return (await this.translateBatch([input], from, to))[0] ?? "";
  }

  async translateBatch(
    inputs: readonly string[],
    from: CaptionTranslationSourceLanguage,
    to: CaptionTranslationLanguage,
  ): Promise<string[]> {
    const texts = inputs.map((input) => input.trim());
    if (from === to && from !== "auto") return texts;

    const translated = texts.map(() => "");
    const missing = new Map<string, { text: string; indexes: number[] }>();
    for (const [index, text] of texts.entries()) {
      if (!text) {
        translated[index] = "";
        continue;
      }

      const key = `${from}\u0000${to}\u0000${text}`;
      const cached = this.cache.get(key);
      if (cached !== undefined) {
        this.cache.delete(key);
        this.cache.set(key, cached);
        translated[index] = cached;
        continue;
      }

      const entry = missing.get(key);
      if (entry) entry.indexes.push(index);
      else missing.set(key, { text, indexes: [index] });
    }

    if (missing.size === 0) return translated;

    const entries = [...missing.entries()];
    const payload = entries.map(([, entry]) => entry.text);
    const input: TranslateInput = payload.length === 1 ? payload[0] : payload;

    const controller = new AbortController();
    const timeout = globalThis.setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const result = await this.translateImplementation(input, {
        from,
        to,
        signal: controller.signal,
      });
      const results = Array.isArray(result) ? result : [result];
      if (results.length !== entries.length) {
        throw new Error("Google Translate returned an incomplete caption batch");
      }

      for (const [index, [key, entry]] of entries.entries()) {
        const resultText = results[index]?.text.trim();
        if (!resultText) throw new Error("Google Translate returned an empty caption");
        this.cache.set(key, resultText);
        for (const outputIndex of entry.indexes) translated[outputIndex] = resultText;
      }
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
