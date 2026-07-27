import { describe, expect, test } from "bun:test";
import {
  nextCaptionAudioStartMs,
  selectAsrModelLoadRequest,
} from "../src/features/room/asr/useLocalAsrCaptions";

describe("local ASR caption timing", () => {
  test("never serializes a non-finite media time into the raw IPC timestamp", () => {
    expect(nextCaptionAudioStartMs(null, Number.NaN, 500)).toBe(0);
    expect(nextCaptionAudioStartMs(12_500, Number.POSITIVE_INFINITY, 500)).toBe(
      12_500,
    );
  });

  test("uses the media clock for a first captured PCM batch", () => {
    expect(nextCaptionAudioStartMs(null, 9.2, 500)).toBe(8_700);
  });

  test("resets an accumulated timestamp after a meaningful MSE clock jump", () => {
    expect(nextCaptionAudioStartMs(1_000, 12, 500)).toBe(11_500);
  });

  test("loads the bundled model when no custom path has been configured", () => {
    expect(
      selectAsrModelLoadRequest(
        { loaded: false, loading: false, bundled: false, path: null },
        null,
      ),
    ).toEqual({ command: "asr_model_load_default", args: {} });
    expect(
      selectAsrModelLoadRequest(
        {
          loaded: true,
          loading: false,
          bundled: true,
          path: "D:\\app\\models\\tiny.bin",
        },
        null,
      ),
    ).toBeNull();
  });

  test("keeps a saved custom model as the explicit override", () => {
    expect(
      selectAsrModelLoadRequest(
        { loaded: false, loading: false, bundled: false, path: null },
        "  D:\\models\\custom.bin  ",
      ),
    ).toEqual({
      command: "asr_model_load",
      args: { path: "D:\\models\\custom.bin" },
    });
    expect(
      selectAsrModelLoadRequest(
        {
          loaded: true,
          loading: false,
          bundled: false,
          path: "D:\\models\\custom.bin",
        },
        "D:\\models\\custom.bin",
      ),
    ).toBeNull();
  });

  test("reloads the bundled model after the custom preference is cleared", () => {
    expect(
      selectAsrModelLoadRequest(
        {
          loaded: true,
          loading: false,
          bundled: false,
          path: "D:\\models\\custom.bin",
        },
        null,
      ),
    ).toEqual({ command: "asr_model_load_default", args: {} });
  });

  test("reloads the configured custom model when the current model differs", () => {
    expect(
      selectAsrModelLoadRequest(
        {
          loaded: true,
          loading: false,
          bundled: true,
          path: "D:\\app\\models\\tiny.bin",
        },
        "D:\\models\\custom.bin",
      ),
    ).toEqual({
      command: "asr_model_load",
      args: { path: "D:\\models\\custom.bin" },
    });

    expect(
      selectAsrModelLoadRequest(
        {
          loaded: true,
          loading: false,
          bundled: false,
          path: "D:\\models\\other.bin",
        },
        "D:\\models\\custom.bin",
      ),
    ).toEqual({
      command: "asr_model_load",
      args: { path: "D:\\models\\custom.bin" },
    });
  });

  test("does not replace a model while another load is in progress", () => {
    expect(
      selectAsrModelLoadRequest(
        {
          loaded: true,
          loading: true,
          bundled: true,
          path: "D:\\app\\models\\tiny.bin",
        },
        "D:\\models\\custom.bin",
      ),
    ).toBeNull();
  });
});
