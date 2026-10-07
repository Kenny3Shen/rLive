import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mockIPC } from "@tauri-apps/api/mocks";
import { useSettingsStore } from "../src/shared/stores/settingsStore";
import type { AppSettings, ProxyMode } from "../src/shared/types/live";

const savedProxy = "http://127.0.0.1:7890";
const writeError = { code: "settings_write_failed", message: "无法写入设置", retryable: true };

// 只替换 IPC，全量设置由真实 store 序列化产生，避免再复制一份易漂移的后端 schema。
describe("代理三档设置", () => {
  let windowDescriptor: PropertyDescriptor | undefined;
  let tauriDescriptor: PropertyDescriptor | undefined;
  let originalState: ReturnType<typeof useSettingsStore.getState>;
  let backendSettings: AppSettings;
  let writeHandler: (settings: AppSettings) => void | Promise<void>;
  const writes: AppSettings[] = [];

  beforeEach(async () => {
    windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
    tauriDescriptor = Object.getOwnPropertyDescriptor(globalThis, "isTauri");
    Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
    Object.defineProperty(globalThis, "isTauri", { configurable: true, value: true });
    originalState = useSettingsStore.getState();
    useSettingsStore.setState(useSettingsStore.getInitialState(), true);
    writes.length = 0;
    writeHandler = () => {};
    mockIPC((command, payload) => {
      if (command === "settings_get") {
        return { settings: backendSettings, has_saved_settings: true };
      }
      if (command === "settings_set") {
        const settings = (payload as { settings: AppSettings }).settings;
        writes.push(settings);
        return writeHandler(settings);
      }
      throw new Error(`意外 IPC 命令：${command}`);
    });
    useSettingsStore.setState({ hydratedFromBackend: true });
    await useSettingsStore.getState().persistToBackend();
    backendSettings = writes.pop()!;
    useSettingsStore.setState({ hydratedFromBackend: false });
  });

  afterEach(() => {
    useSettingsStore.setState(originalState, true);
    if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
    else Reflect.deleteProperty(globalThis, "window");
    if (tauriDescriptor) Object.defineProperty(globalThis, "isTauri", tauriDescriptor);
    else Reflect.deleteProperty(globalThis, "isTauri");
  });

  test("默认自动模式，自定义地址独立留空", () => {
    expect(useSettingsStore.getState().proxyMode).toBe("auto");
    expect(useSettingsStore.getState().proxy).toBeNull();
    expect(backendSettings.proxy_mode).toBe("auto");
    expect(backendSettings.proxy).toBeNull();
  });

  for (const mode of ["auto", "off", "custom"] satisfies ProxyMode[]) {
    test(`后端 ${mode} 模式原样回填，不根据已保存地址推断模式`, async () => {
      backendSettings = { ...backendSettings, proxy_mode: mode, proxy: savedProxy };
      useSettingsStore.setState({ proxyMode: "custom", proxy: "http://old:8888" });
      await useSettingsStore.getState().loadFromBackend();
      expect(useSettingsStore.getState().proxyMode).toBe(mode);
      expect(useSettingsStore.getState().proxy).toBe(savedProxy);
      expect(useSettingsStore.getState().hydratedFromBackend).toBe(true);
      expect(writes).toHaveLength(0);
    });
  }

  test("连续切换三档始终保留自定义地址", async () => {
    useSettingsStore.getState().applyFromBackend({ ...backendSettings, proxy: savedProxy });
    for (const mode of ["custom", "off", "auto", "custom"] satisfies ProxyMode[]) {
      const result = useSettingsStore.getState().setProxyMode(mode);
      expect(result).toBeInstanceOf(Promise);
      await result;
      expect(useSettingsStore.getState().proxyMode).toBe(mode);
      expect(useSettingsStore.getState().proxy).toBe(savedProxy);
      expect(writes.at(-1)).toMatchObject({ proxy_mode: mode, proxy: savedProxy });
    }
  });

  test("保存或清空地址不会隐式切换代理模式", async () => {
    useSettingsStore.getState().applyFromBackend({ ...backendSettings, proxy_mode: "off" });
    const result = useSettingsStore.getState().setProxy(savedProxy);
    expect(result).toBeInstanceOf(Promise);
    await result;
    expect(writes.at(-1)).toMatchObject({ proxy_mode: "off", proxy: savedProxy });
    await useSettingsStore.getState().setProxy(null);
    expect(writes.at(-1)).toMatchObject({ proxy_mode: "off", proxy: null });
    expect(useSettingsStore.getState().proxyMode).toBe("off");
  });

  test("其他设置全量写入保留代理模式和已保存地址", async () => {
    useSettingsStore.getState().applyFromBackend({
      ...backendSettings,
      proxy_mode: "off",
      proxy: savedProxy,
    });
    useSettingsStore.getState().setTheme("dark");
    await useSettingsStore.getState().persistToBackend();
    expect(writes).toHaveLength(2);
    for (const settings of writes) {
      expect(settings).toMatchObject({ theme: "dark", proxy_mode: "off", proxy: savedProxy });
    }
  });

  test("真实 IPC 失败向调用者抛错并回滚模式，后续队列继续可用", async () => {
    useSettingsStore.getState().applyFromBackend({
      ...backendSettings,
      proxy_mode: "custom",
      proxy: savedProxy,
    });
    writeHandler = () => {
      throw writeError;
    };
    await expect(useSettingsStore.getState().setProxyMode("off")).rejects.toBe(writeError);
    expect(useSettingsStore.getState().proxyMode).toBe("custom");
    expect(useSettingsStore.getState().proxy).toBe(savedProxy);
    writeHandler = () => {};
    await useSettingsStore.getState().setProxyMode("auto");
    expect(writes.at(-1)).toMatchObject({ proxy_mode: "auto", proxy: savedProxy });
    expect(useSettingsStore.getState().proxyMode).toBe("auto");
  });

  test("真实 IPC 失败回滚地址，不改变当前模式", async () => {
    useSettingsStore.getState().applyFromBackend({
      ...backendSettings,
      proxy_mode: "custom",
      proxy: savedProxy,
    });
    writeHandler = () => {
      throw writeError;
    };
    await expect(useSettingsStore.getState().setProxy("http://new:8080")).rejects.toBe(writeError);
    expect(useSettingsStore.getState().proxy).toBe(savedProxy);
    expect(useSettingsStore.getState().proxyMode).toBe("custom");
    writeHandler = () => {};
    await useSettingsStore.getState().setProxy("socks5://127.0.0.1:1080");
    expect(writes.at(-1)).toMatchObject({
      proxy_mode: "custom",
      proxy: "socks5://127.0.0.1:1080",
    });
  });

  test("失败期间排队的普通快照不能重新写入已回滚的代理模式", async () => {
    useSettingsStore.getState().applyFromBackend({ ...backendSettings, proxy: savedProxy });
    let fail!: (reason: unknown) => void;
    let started!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    writeHandler = () =>
      new Promise<void>((_, reject) => {
        fail = reject;
        started();
      });
    const result = useSettingsStore
      .getState()
      .setProxyMode("off")
      .then(
        () => {
          throw new Error("代理写入本应失败");
        },
        (error: unknown) => error,
      );
    await firstStarted;
    expect(useSettingsStore.getState().proxyMode).toBe("off");
    useSettingsStore.getState().setTheme("dark");
    const nextMode = useSettingsStore.getState().setProxyMode("custom");
    const finalWrite = useSettingsStore.getState().persistToBackend();
    writeHandler = () => {};
    fail(writeError);
    expect(await result).toBe(writeError);
    await nextMode;
    await finalWrite;
    expect(writes.map((settings) => settings.proxy_mode)).toEqual([
      "off",
      "auto",
      "custom",
      "custom",
    ]);
    expect(writes.at(-1)).toMatchObject({ theme: "dark", proxy: savedProxy });
    expect(useSettingsStore.getState().proxyMode).toBe("custom");
  });

  test("多个失败代理事务均回滚到已确认值，而非上一笔乐观值", async () => {
    useSettingsStore.getState().applyFromBackend({ ...backendSettings, proxy: savedProxy });
    writeHandler = () => {
      throw writeError;
    };
    const results = await Promise.all(
      [
        useSettingsStore.getState().setProxyMode("off"),
        useSettingsStore.getState().setProxyMode("custom"),
        useSettingsStore.getState().setProxy("http://new:8080"),
      ].map((result) =>
        result.then(
          () => {
            throw new Error("代理写入本应失败");
          },
          (error: unknown) => error,
        ),
      ),
    );
    expect(results).toEqual([writeError, writeError, writeError]);
    expect(useSettingsStore.getState().proxyMode).toBe("auto");
    expect(useSettingsStore.getState().proxy).toBe(savedProxy);
  });

  test("普通设置保留既有吞错语义，不产生未处理 rejection", async () => {
    useSettingsStore.getState().applyFromBackend(backendSettings);
    writeHandler = () => {
      throw writeError;
    };
    expect(useSettingsStore.getState().setTheme("dark")).toBeUndefined();
    await expect(useSettingsStore.getState().persistToBackend()).resolves.toBeUndefined();
    expect(useSettingsStore.getState().theme).toBe("dark");
    writeHandler = () => {};
    await useSettingsStore.getState().setProxyMode("off");
    expect(useSettingsStore.getState().proxyMode).toBe("off");
  });

  test("未加载后端时不将默认设置写入 IPC", async () => {
    await useSettingsStore.getState().setProxy(savedProxy);
    await useSettingsStore.getState().setProxyMode("off");
    expect(writes).toHaveLength(0);
  });

  test("纯浏览器允许切换代理设置，仍忽略不可用的 Tauri 环境", async () => {
    Object.defineProperty(globalThis, "isTauri", { configurable: true, value: false });
    await useSettingsStore.getState().loadFromBackend();
    await expect(useSettingsStore.getState().setProxy(savedProxy)).resolves.toBeUndefined();
    await expect(useSettingsStore.getState().setProxyMode("custom")).resolves.toBeUndefined();
    expect(useSettingsStore.getState().proxyMode).toBe("custom");
    expect(useSettingsStore.getState().proxy).toBe(savedProxy);
    expect(writes).toHaveLength(0);
  });
});
