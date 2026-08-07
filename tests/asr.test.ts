import { describe, expect, test } from "bun:test";
import {
  ASR_DEFAULT_CHUNK_SECONDS,
  ASR_MAX_CHUNK_SECONDS,
  ASR_MIN_CHUNK_SECONDS,
  appendAsrCaptionLine,
  downsamplePcm,
  encodePcmBase64,
  formatAsrCaptionSegment,
  joinAsrCaptionText,
  selectAudioCaptureBackend,
} from "../src/features/asr/audio";
import {
  describeAsrModelStatus,
  supportsLocalAsr,
  type AsrModelStatus,
} from "../src/features/asr/model";
import { asrControlPresentation } from "../src/shared/components/player/PlayerControls";

function modelStatus(patch: Partial<AsrModelStatus>): AsrModelStatus {
  return {
    state: "not_downloaded",
    downloaded_bytes: 0,
    total_bytes: 575_992_102,
    model_size_bytes: 575_992_102,
    speaker_enabled: false,
    vad_enabled: true,
    punctuation_enabled: true,
    hotwords_count: 0,
    speaker_model_downloaded: false,
    speaker_model_size_bytes: 28_281_164,
    threads: 4,
    provider: "cpu",
    message: null,
    ...patch,
  };
}

describe("ASR model status", () => {
  test("is available only in a Tauri desktop client", () => {
    expect(supportsLocalAsr({ tauriRuntime: true, platform: "desktop" })).toBe(
      true,
    );
    expect(supportsLocalAsr({ tauriRuntime: false, platform: "desktop" })).toBe(
      false,
    );
    expect(supportsLocalAsr({ tauriRuntime: true, platform: "android" })).toBe(
      false,
    );
    expect(supportsLocalAsr({ tauriRuntime: true, platform: "ios" })).toBe(
      false,
    );
  });

  test("reports bounded download progress and ready state", () => {
    const downloading = describeAsrModelStatus(
      modelStatus({
        state: "downloading",
        downloaded_bytes: 287_996_051,
      }),
      { enabled: true, supported: true },
    );
    expect(downloading.progress).toBe(50);
    expect(downloading.message).toContain("50%");

    expect(
      describeAsrModelStatus(modelStatus({ state: "ready" }), {
        enabled: true,
        supported: true,
      }).message,
    ).toBe("Zipformer 中英双语模型已就绪（CPU / 4 线程 + VAD + 自动标点）");
  });

  test("keeps the downloaded model when the feature is disabled", () => {
    expect(
      describeAsrModelStatus(modelStatus({ state: "downloaded" }), {
        enabled: false,
        supported: true,
      }).message,
    ).toBe("功能已关闭，本地模型会保留");
  });

  test("reports the active CPU thread count", () => {
    expect(
      describeAsrModelStatus(modelStatus({ state: "ready", threads: 6 }), {
        enabled: true,
        supported: true,
      }).message,
    ).toBe("Zipformer 中英双语模型已就绪（CPU / 6 线程 + VAD + 自动标点）");
  });

  test("reports speaker differentiation in the ready state", () => {
    expect(
      describeAsrModelStatus(
        modelStatus({ state: "ready", speaker_enabled: true }),
        {
          enabled: true,
          supported: true,
        },
      ).message,
    ).toBe(
      "Zipformer 中英双语模型已就绪（CPU / 4 线程 + VAD + 自动标点 + 说话人区分）",
    );
  });

  test("reports the active CUDA provider", () => {
    expect(
      describeAsrModelStatus(
        modelStatus({ state: "ready", provider: "cuda" }),
        {
          enabled: true,
          supported: true,
        },
      ).message,
    ).toBe(
      "Zipformer 中英双语模型已就绪（NVIDIA CUDA / 4 线程 + VAD + 自动标点）",
    );
  });

  test("reports independently disabled VAD, punctuation, and local hotwords", () => {
    expect(
      describeAsrModelStatus(
        modelStatus({
          state: "ready",
          vad_enabled: false,
          punctuation_enabled: false,
          hotwords_count: 3,
        }),
        { enabled: true, supported: true },
      ).message,
    ).toBe(
      "Zipformer 中英双语模型已就绪（CPU / 4 线程 + 关闭 VAD + 原始文本 + 3 个热词）",
    );
  });

  test("uses the native download stage message", () => {
    const presentation = describeAsrModelStatus(
      modelStatus({
        state: "downloading",
        downloaded_bytes: 590_000_000,
        total_bytes: 604_273_266,
        model_size_bytes: 604_273_266,
        speaker_enabled: true,
        message: "正在下载说话人声纹模型…",
      }),
      { enabled: true, supported: true },
    );
    expect(presentation.message).toContain("正在下载说话人声纹模型…");
  });

  test("keeps a renderable presentation while extracting in the background", () => {
    const presentation = describeAsrModelStatus(
      modelStatus({
        state: "extracting",
        downloaded_bytes: 575_992_102,
        message: "正在解压 Zipformer 识别模型…",
      }),
      { enabled: true, supported: true },
    );
    expect(presentation.message).toBe("正在解压 Zipformer 识别模型…");
    expect(presentation.busy).toBe(true);
    expect(presentation.progress).toBe(100);
  });
});

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
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    const view = new DataView(bytes.buffer);
    expect(view.getFloat32(0, true)).toBe(1);
    expect(view.getFloat32(4, true)).toBe(-0.5);
  });

  test("joins segment text without adding spaces between Chinese characters", () => {
    expect(joinAsrCaptionText([{ text: "你好" }, { text: "世界。" }])).toBe(
      "你好世界。",
    );
    expect(joinAsrCaptionText([{ text: "hello" }, { text: "world" }])).toBe(
      "hello world",
    );
  });

  test("keeps finalized utterances on separate subtitle lines", () => {
    const first = appendAsrCaptionLine(null, "你好。 ");
    expect(appendAsrCaptionLine(first, "How are you?")).toBe(
      "你好。\nHow are you?",
    );
  });

  test("formats only finalized segments with a valid speaker id", () => {
    expect(formatAsrCaptionSegment({ text: "你好。", speaker_id: 1 })).toBe(
      "说话人 1：你好。",
    );
    expect(formatAsrCaptionSegment({ text: "你好。", speaker_id: null })).toBe(
      "你好。",
    );
  });
});

describe("streaming ASR chunks", () => {
  test("use a low-latency 0.2–1.0 second range", () => {
    expect(ASR_DEFAULT_CHUNK_SECONDS).toBe(0.2);
    expect(ASR_MIN_CHUNK_SECONDS).toBe(0.2);
    expect(ASR_MAX_CHUNK_SECONDS).toBe(1);
  });

  test("prefers AudioWorklet and keeps a legacy WebView fallback", () => {
    expect(
      selectAudioCaptureBackend({ audioWorklet: true, audioWorkletNode: true }),
    ).toBe("audio-worklet");
    expect(
      selectAudioCaptureBackend({
        audioWorklet: false,
        audioWorkletNode: true,
      }),
    ).toBe("script-processor");
    expect(
      selectAudioCaptureBackend({
        audioWorklet: true,
        audioWorkletNode: false,
      }),
    ).toBe("script-processor");
  });
});

describe("ASR player control", () => {
  test("uses stable icons for off, active, and busy states", () => {
    expect(asrControlPresentation(false, false)).toEqual({
      enabled: false,
      icon: "captions-off",
    });
    expect(asrControlPresentation(true, false)).toEqual({
      enabled: true,
      icon: "captions",
    });
    expect(asrControlPresentation(true, true)).toEqual({
      enabled: true,
      icon: "spinner",
    });
  });
});
