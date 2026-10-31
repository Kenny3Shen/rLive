import { describe, expect, test } from "bun:test";
import {
  appendAsrCaptionLine,
  appendPendingPcm,
  downsamplePcm,
  encodePcmBase64,
  formatAsrCaptionSegment,
  joinAsrCaptionText,
} from "../src/features/asr/audio";
import { estimateAsrDownloadBytes, type AsrModelStatus } from "../src/features/asr/model";
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
  test("appends pending PCM and keeps only the newest tail beyond the cap", () => {
    const first = new Float32Array([1, 2, 3]);
    expect(appendPendingPcm(null, first)).toBe(first);
    expect([...appendPendingPcm(first, new Float32Array([4, 5]))]).toEqual([1, 2, 3, 4, 5]);
    expect([...appendPendingPcm(first, new Float32Array([4, 5]), 4)]).toEqual([2, 3, 4, 5]);
    expect([...appendPendingPcm(first, new Float32Array([4, 5, 6, 7, 8]), 4)]).toEqual([
      5, 6, 7, 8,
    ]);
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

describe("ASR download estimate", () => {
  const status: AsrModelStatus = {
    state: "not_downloaded",
    downloaded_bytes: 100,
    total_bytes: 1_000,
    model_size_bytes: 1_000,
    speaker_enabled: false,
    vad_enabled: true,
    punctuation_enabled: true,
    hotwords_count: 0,
    speaker_model_downloaded: false,
    speaker_model_size_bytes: 40,
    cuda_runtime_extra_bytes: 0,
    threads: 8,
    provider: "auto",
    message: null,
  };

  test("uses the backend remainder for the configuration it last saw", () => {
    expect(estimateAsrDownloadBytes(status, false)).toBe(900);
  });

  test("adds or removes the speaker model when the page toggle differs", () => {
    expect(estimateAsrDownloadBytes(status, true)).toBe(940);
    expect(estimateAsrDownloadBytes({ ...status, speaker_enabled: true }, false)).toBe(860);
    expect(
      estimateAsrDownloadBytes(
        { ...status, speaker_model_downloaded: true, speaker_enabled: false },
        true,
      ),
    ).toBe(900);
  });
});
