import { describe, expect, test } from "bun:test";
import {
  CaptionTranslationClient,
  describeCaptionTranslationFailure,
} from "../src/features/asr/translation";
import {
  normalizeCaptionTranslationFrom,
  normalizeCaptionTranslationTo,
} from "../src/shared/translation/languages";

describe("caption translation settings", () => {
  test("normalizes unsupported persisted language codes", () => {
    expect(normalizeCaptionTranslationFrom("unsupported")).toBe("auto");
    expect(normalizeCaptionTranslationTo("unsupported")).toBe("zh-CN");
    expect(normalizeCaptionTranslationFrom("en")).toBe("en");
    expect(normalizeCaptionTranslationTo("ja")).toBe("ja");
  });

  test("maps transport failures without exposing the upstream error body", () => {
    expect(describeCaptionTranslationFailure({ status: 429, message: "IP: 203.0.113.1" })).toEqual({
      kind: "rate_limited",
      message: "翻译请求过于频繁，已保留原字幕。关闭后重新开启可重试。",
    });
    expect(describeCaptionTranslationFailure(new Error("private upstream detail"))).toEqual({
      kind: "unavailable",
      message: "字幕翻译暂时不可用，已保留原字幕。",
    });
  });
});

describe("caption translation client", () => {
  test("caches repeated final captions by source and target language", async () => {
    let calls = 0;
    const client = new CaptionTranslationClient(async (text, options) => {
      calls += 1;
      return { text: `${options.to}:${text}` };
    });

    expect(await client.translate(" hello ", "auto", "zh-CN")).toBe("zh-CN:hello");
    expect(await client.translate("hello", "auto", "zh-CN")).toBe("zh-CN:hello");
    expect(await client.translate("hello", "en", "zh-CN")).toBe("zh-CN:hello");
    expect(calls).toBe(2);
  });

  test("does not call Google for empty or same-language captions", async () => {
    let calls = 0;
    const client = new CaptionTranslationClient(async (text) => {
      calls += 1;
      return { text };
    });

    expect(await client.translate("   ", "auto", "en")).toBe("");
    expect(await client.translate("hello", "en", "en")).toBe("hello");
    expect(calls).toBe(0);
  });
});
