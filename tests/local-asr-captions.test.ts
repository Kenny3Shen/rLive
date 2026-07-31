import { describe, expect, test } from "bun:test";
import {
  nextCaptionAudioStartMs,
  selectAsrModelLoadRequest,
} from "../src/features/room/asr/useLocalAsrCaptions";

describe("local ASR caption timing", () => {
  test("never serializes a non-finite media time into the raw IPC timestamp", () => {
    expect(nextCaptionAudioStartMs(null, Number.NaN, 500)).toBe(0);
    expect(nextCaptionAudioStartMs(12_500, Number.POSITIVE_INFINITY, 500)).toBe(12_500);
  });

  test("uses the media clock for a first captured PCM batch", () => {
    expect(nextCaptionAudioStartMs(null, 9.2, 500)).toBe(8_700);
  });

  test("resets an accumulated timestamp after a meaningful MSE clock jump", () => {
    expect(nextCaptionAudioStartMs(1_000, 12, 500)).toBe(11_500);
  });

  test("requests the compatibility loader when no model is ready", () => {
    expect(
      selectAsrModelLoadRequest({ loaded: false, loading: false, bundled: false, path: null }),
    ).toEqual({ command: "asr_model_load_default", args: {} });
    expect(
      selectAsrModelLoadRequest({
        loaded: true,
        loading: false,
        bundled: true,
        path: "D:\\app\\models\\future.gguf",
      }),
    ).toBeNull();
  });

  test("replaces a non-bundled legacy runtime through the compatibility loader", () => {
    expect(
      selectAsrModelLoadRequest({
        loaded: true,
        loading: false,
        bundled: false,
        path: "D:\\models\\custom.bin",
      }),
    ).toEqual({ command: "asr_model_load_default", args: {} });
  });

  test("does not replace a model while another load is in progress", () => {
    expect(
      selectAsrModelLoadRequest({
        loaded: true,
        loading: true,
        bundled: true,
        path: "D:\\app\\models\\future.gguf",
      }),
    ).toBeNull();
  });
});
