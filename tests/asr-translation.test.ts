import { describe, expect, test } from "bun:test";
import {
  CaptionTranslationClient,
  describeCaptionTranslationFailure,
} from "../src/features/asr/translation";
import {
  normalizeCaptionTranslationFrom,
  normalizeCaptionTranslationTo,
} from "../src/shared/translation/languages";
import { buildHttpFetchRequest } from "../src/shared/api/tauriFetch";

describe("caption translation settings", () => {
  test("normalizes unsupported persisted language codes", () => {
    expect(normalizeCaptionTranslationFrom("unsupported")).toBe("auto");
    expect(normalizeCaptionTranslationTo("unsupported")).toBe("zh-CN");
    expect(normalizeCaptionTranslationFrom("en")).toBe("en");
    expect(normalizeCaptionTranslationTo("ja")).toBe("ja");
    expect(normalizeCaptionTranslationTo("auto")).toBe("auto");
  });

  test("只传递 HTTP 数据，由 Rust 决定代理模式", async () => {
    const payload = await buildHttpFetchRequest(
      new Request("https://translate.google.com/translate_a/single", {
        method: "POST",
        body: "字幕",
        headers: { "Content-Type": "text/plain;charset=UTF-8" },
      }),
    );
    expect(payload.method).toBe("POST");
    expect(payload.headers).toContainEqual(["content-type", "text/plain;charset=UTF-8"]);
    expect(new TextDecoder().decode(new Uint8Array(payload.body!))).toBe("字幕");
    expect(payload).not.toHaveProperty("proxy");
  });

  test("maps transport failures without exposing the upstream error body", () => {
    expect(describeCaptionTranslationFailure({ status: 429, message: "IP: 203.0.113.1" })).toEqual({
      kind: "rate_limited",
      message: "Google 翻译请求受限，已保留原字幕。稍后重试或更换应用代理。",
    });
    expect(describeCaptionTranslationFailure({ cause: { response: { status: 429 } } })).toEqual({
      kind: "rate_limited",
      message: "Google 翻译请求受限，已保留原字幕。稍后重试或更换应用代理。",
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
    const client = new CaptionTranslationClient(async (input, options) => {
      calls += 1;
      const translateText = (text: string) => ({ text: `${options.to}:${text}` });
      return Array.isArray(input) ? input.map(translateText) : translateText(input);
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

  test("batches final segments and allows automatic source and target languages", async () => {
    let calls = 0;
    const client = new CaptionTranslationClient(async (input, options) => {
      calls += 1;
      expect(options.from).toBe("auto");
      expect(options.to).toBe("auto");
      expect(input).toEqual(["first", "second"]);
      return [{ text: "一" }, { text: "二" }];
    });

    expect(await client.translateBatch([" first ", "second", "first"], "auto", "auto")).toEqual([
      "一",
      "二",
      "一",
    ]);
    expect(calls).toBe(1);
  });
});
