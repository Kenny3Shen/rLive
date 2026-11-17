import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { useSettingsStore } from "../src/shared/stores/settingsStore";
import type { AppSettings } from "../src/shared/types/live";

describe("ASR model settings", () => {
  let windowDescriptor: PropertyDescriptor | undefined;
  let tauriDescriptor: PropertyDescriptor | undefined;
  let originalState: ReturnType<typeof useSettingsStore.getState>;
  let backendSettings: AppSettings;
  const writes: AppSettings[] = [];
  let prepareCount = 0;

  beforeEach(async () => {
    windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
    tauriDescriptor = Object.getOwnPropertyDescriptor(globalThis, "isTauri");
    Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
    Object.defineProperty(globalThis, "isTauri", { configurable: true, value: true });
    originalState = useSettingsStore.getState();
    useSettingsStore.setState(useSettingsStore.getInitialState(), true);
    writes.length = 0;
    prepareCount = 0;
    mockIPC((command, payload) => {
      if (command === "settings_set") {
        const settings = (payload as { settings: AppSettings }).settings;
        backendSettings = settings;
        writes.push(settings);
        return;
      }
      if (command === "settings_get") {
        return { settings: backendSettings, has_saved_settings: true };
      }
      if (command === "asr_enable") {
        prepareCount += 1;
        return {};
      }
      throw new Error(`意外 IPC 命令：${command}`);
    });
    useSettingsStore.setState({ hydratedFromBackend: true });
    await useSettingsStore.getState().persistToBackend();
    useSettingsStore.setState({ hydratedFromBackend: false });
  });

  afterEach(() => {
    useSettingsStore.setState(originalState, true);
    clearMocks();
    if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
    else Reflect.deleteProperty(globalThis, "window");
    if (tauriDescriptor) Object.defineProperty(globalThis, "isTauri", tauriDescriptor);
    else Reflect.deleteProperty(globalThis, "isTauri");
  });

  test("defaults to Qwen3 and falls back from unknown backend values", () => {
    expect(writes[0]).toMatchObject({ asr_model: "qwen3", asr_provider: "auto" });
    useSettingsStore
      .getState()
      .applyFromBackend({ ...backendSettings, asr_model: "unknown" as never });
    expect(useSettingsStore.getState().asrModel).toBe("qwen3");
  });

  test("switching to xASR preserves CUDA and prepares the model", async () => {
    useSettingsStore.getState().applyFromBackend({
      ...backendSettings,
      asr_enabled: true,
      asr_model: "qwen3",
      asr_provider: "cuda",
    });
    writes.length = 0;

    await useSettingsStore.getState().setAsrModel("xasr");

    expect(useSettingsStore.getState().asrModel).toBe("xasr");
    expect(useSettingsStore.getState().asrProvider).toBe("cuda");
    expect(writes.at(-1)).toMatchObject({ asr_model: "xasr", asr_provider: "cuda" });
    expect(prepareCount).toBe(1);
  });
});
