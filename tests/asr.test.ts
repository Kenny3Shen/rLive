import { describe, expect, test } from "bun:test";
import {
  appendAsrCaptionLine,
  downsamplePcm,
  encodePcmBase64,
  formatAsrCaptionSegment,
  joinAsrCaptionText,
} from "../src/features/asr/audio";
describe("ASR audio transport", () => {
  test("downsamples one second of 48 kHz PCM to 16 kHz", () => {
    const input = new Float32Array(48_000).fill(0.25);
    const output = downsamplePcm(input, 48_000);
    expect(output.length).toBe(16_000);
    expect(output[0]).toBeCloseTo(0.25, 6);
    expect(output[output.length - 1]).toBeCloseTo(0.25, 6);
  });
  test("encodes f32 samples as little-endian base64", () => {
    const encoded = encodePcmBase64(new Float32Array([1, -0.5]));
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const view = new DataView(bytes.buffer);
    expect(view.getFloat32(0, true)).toBe(1);
    expect(view.getFloat32(4, true)).toBe(-0.5);
  });
  test("joins segment text without adding spaces between Chinese characters", () => {
    expect(
      joinAsrCaptionText([
        {
          text: "你好",
        },
        {
          text: "世界。",
        },
      ]),
    ).toBe("你好世界。");
    expect(
      joinAsrCaptionText([
        {
          text: "hello",
        },
        {
          text: "world",
        },
      ]),
    ).toBe("hello world");
  });
  test("keeps finalized utterances on separate subtitle lines", () => {
    const first = appendAsrCaptionLine(null, "你好。 ");
    expect(appendAsrCaptionLine(first, "How are you?")).toBe("你好。\nHow are you?");
  });
  test("formats only finalized segments with a valid speaker id", () => {
    expect(
      formatAsrCaptionSegment({
        text: "你好。",
        speaker_id: 1,
      }),
    ).toBe("说话人 1：你好。");
    expect(
      formatAsrCaptionSegment({
        text: "你好。",
        speaker_id: null,
      }),
    ).toBe("你好。");
  });
});
