import { describe, expect, test } from "bun:test";
import { AdaptiveAsrWindow } from "../src/features/asr/adaptive";
import { downsamplePcm, encodePcmBase64, joinAsrCaptionText } from "../src/features/asr/audio";
import {
  describeAsrModelStatus,
  supportsLocalAsr,
  type AsrModelStatus,
} from "../src/features/asr/model";
import { asrControlPresentation } from "../src/features/room/PlayerControls";

function modelStatus(patch: Partial<AsrModelStatus>): AsrModelStatus {
  return {
    state: "not_downloaded",
    downloaded_bytes: 0,
    total_bytes: 631_026_336,
    model_size_bytes: 631_026_336,
    vad_model_size_bytes: 885_098,
    vad_enabled: false,
    vad_model_downloaded: false,
    compute_mode: "gpu",
    gpu_available: true,
    threads: 4,
    message: null,
    ...patch,
  };
}

describe("ASR model status", () => {
  test("is available only in a Tauri desktop client", () => {
    expect(supportsLocalAsr({ tauriRuntime: true, platform: "desktop" })).toBe(true);
    expect(supportsLocalAsr({ tauriRuntime: false, platform: "desktop" })).toBe(false);
    expect(supportsLocalAsr({ tauriRuntime: true, platform: "android" })).toBe(false);
  });

  test("reports bounded download progress and ready state", () => {
    const downloading = describeAsrModelStatus(
      modelStatus({
        state: "downloading",
        downloaded_bytes: 315_513_168,
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
    ).toBe("模型已就绪（GPU），可在播放页开启字幕");
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
      describeAsrModelStatus(modelStatus({ state: "ready", compute_mode: "cpu", threads: 6 }), {
        enabled: true,
        supported: true,
      }).message,
    ).toBe("模型已就绪（CPU / 6 线程），可在播放页开启字幕");
  });

  test("reports VAD download progress and active filtering", () => {
    expect(
      describeAsrModelStatus(
        modelStatus({
          state: "downloading_vad",
          downloaded_bytes: 442_549,
          total_bytes: 885_098,
          vad_enabled: true,
        }),
        { enabled: true, supported: true },
      ).message,
    ).toContain("Silero VAD 50%");

    expect(
      describeAsrModelStatus(
        modelStatus({ state: "ready", vad_enabled: true, vad_model_downloaded: true }),
        { enabled: true, supported: true },
      ).message,
    ).toBe("模型已就绪（GPU + VAD），可在播放页开启字幕");
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
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const view = new DataView(bytes.buffer);
    expect(view.getFloat32(0, true)).toBe(1);
    expect(view.getFloat32(4, true)).toBe(-0.5);
  });

  test("joins segment text without adding spaces between Chinese characters", () => {
    expect(joinAsrCaptionText([{ text: "你好" }, { text: "世界。" }])).toBe("你好世界。");
    expect(joinAsrCaptionText([{ text: "hello" }, { text: "world" }])).toBe("hello world");
  });
});

describe("adaptive ASR windows", () => {
  test("shrinks after stable headroom and expands after backpressure", () => {
    const controller = new AdaptiveAsrWindow();
    expect(controller.segmentSeconds).toBe(6);

    for (let index = 0; index < 3; index += 1) {
      controller.observe({
        audioSeconds: controller.segmentSeconds,
        processingMs: controller.segmentSeconds * 300,
        queueWaitMs: 0,
        dropped: false,
      });
    }
    expect(controller.segmentSeconds).toBe(5);

    for (let index = 0; index < 2; index += 1) {
      controller.observe({
        audioSeconds: controller.segmentSeconds,
        processingMs: controller.segmentSeconds * 1_100,
        queueWaitMs: 700,
        dropped: true,
      });
    }
    expect(controller.segmentSeconds).toBe(6);
  });

  test("keeps the window inside the supported bounds", () => {
    const controller = new AdaptiveAsrWindow(1);
    for (let index = 0; index < 20; index += 1) {
      controller.observe({ audioSeconds: 1, processingMs: 100, queueWaitMs: 0, dropped: false });
    }
    expect(controller.segmentSeconds).toBe(1);

    for (let index = 0; index < 20; index += 1) {
      controller.observe({ audioSeconds: 1, processingMs: 5_000, queueWaitMs: 2_000, dropped: true });
    }
    expect(controller.segmentSeconds).toBe(8);
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
