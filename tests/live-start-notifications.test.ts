import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { QueryClient } from "@tanstack/react-query";
import { acquireFollowRefreshScheduler } from "../src/features/follow/followRefresh";
import { settle } from "./helpers/async";
import { useSettingsStore } from "../src/shared/stores/settingsStore";
import type { AppSettings } from "../src/shared/types/live";

describe("开播通知设置", () => {
  let windowDescriptor: PropertyDescriptor | undefined;
  let tauriDescriptor: PropertyDescriptor | undefined;
  let notificationDescriptor: PropertyDescriptor | undefined;
  let originalState: ReturnType<typeof useSettingsStore.getState>;
  let backendSettings: AppSettings;
  let writeHandler: (settings: AppSettings) => void | Promise<void>;
  const writes: AppSettings[] = [];

  beforeEach(async () => {
    windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
    tauriDescriptor = Object.getOwnPropertyDescriptor(globalThis, "isTauri");
    notificationDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Notification");
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: globalThis,
    });
    Object.defineProperty(globalThis, "isTauri", { configurable: true, value: true });
    Object.defineProperty(globalThis, "Notification", {
      configurable: true,
      value: {
        permission: "default",
        requestPermission: async () => "denied",
      },
    });

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
    clearMocks();
    useSettingsStore.setState(originalState, true);
    if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
    else Reflect.deleteProperty(globalThis, "window");
    if (tauriDescriptor) Object.defineProperty(globalThis, "isTauri", tauriDescriptor);
    else Reflect.deleteProperty(globalThis, "isTauri");
    if (notificationDescriptor) {
      Object.defineProperty(globalThis, "Notification", notificationDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, "Notification");
    }
  });

  test("默认关闭，并原样应用后端确认值", () => {
    expect(useSettingsStore.getState().liveStartNotificationsEnabled).toBe(false);
    expect(backendSettings.live_start_notifications_enabled).toBe(false);

    useSettingsStore.getState().applyFromBackend({
      ...backendSettings,
      live_start_notifications_enabled: true,
    });
    expect(useSettingsStore.getState().liveStartNotificationsEnabled).toBe(true);
  });

  test("保存失败时保持关闭并结束等待状态", async () => {
    useSettingsStore.getState().applyFromBackend(backendSettings);
    const writeError = {
      code: "settings_write_failed",
      message: "无法写入设置",
      retryable: true,
    };
    writeHandler = () => {
      throw writeError;
    };

    await expect(useSettingsStore.getState().setLiveStartNotificationsEnabled(true)).rejects.toBe(
      writeError,
    );
    expect(useSettingsStore.getState().liveStartNotificationsEnabled).toBe(false);
    expect(useSettingsStore.getState().liveStartNotificationsPending).toBe(false);
  });

  test("保存成功后才开启并写入后端", async () => {
    useSettingsStore.getState().applyFromBackend(backendSettings);

    await useSettingsStore.getState().setLiveStartNotificationsEnabled(true);

    expect(useSettingsStore.getState().liveStartNotificationsEnabled).toBe(true);
    expect(useSettingsStore.getState().liveStartNotificationsPending).toBe(false);
    expect(writes.at(-1)?.live_start_notifications_enabled).toBe(true);
  });

  test("严格写入期间排队的普通设置不会用旧值覆盖", async () => {
    useSettingsStore.getState().applyFromBackend(backendSettings);
    let resolveFirstWrite!: () => void;
    let notifyFirstWrite!: () => void;
    const firstWriteStarted = new Promise<void>((resolve) => {
      notifyFirstWrite = resolve;
    });
    writeHandler = () =>
      new Promise<void>((resolve) => {
        resolveFirstWrite = resolve;
        notifyFirstWrite();
      });

    const strictWrite = useSettingsStore.getState().setLiveStartNotificationsEnabled(true);
    await firstWriteStarted;

    writeHandler = () => {};
    useSettingsStore.getState().setTheme("dark");
    const queuedWrite = useSettingsStore.getState().persistToBackend();
    resolveFirstWrite();
    await Promise.all([strictWrite, queuedWrite]);

    expect(writes[0]?.live_start_notifications_enabled).toBe(true);
    expect(writes.slice(1).every((settings) => settings.live_start_notifications_enabled)).toBe(
      true,
    );
    expect(useSettingsStore.getState().liveStartNotificationsEnabled).toBe(true);
    expect(writes.at(-1)).toMatchObject({
      theme: "dark",
      live_start_notifications_enabled: true,
    });
  });

  test("重新应用后端设置会阻止迟到的严格写入更新状态", async () => {
    useSettingsStore.getState().applyFromBackend(backendSettings);
    let resolveWrite!: () => void;
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    writeHandler = () =>
      new Promise<void>((resolve) => {
        resolveWrite = resolve;
        notifyStarted();
      });

    const strictWrite = useSettingsStore.getState().setLiveStartNotificationsEnabled(true);
    await started;
    useSettingsStore.getState().applyFromBackend(backendSettings);
    resolveWrite();
    await strictWrite;

    expect(useSettingsStore.getState().liveStartNotificationsEnabled).toBe(false);
    expect(useSettingsStore.getState().liveStartNotificationsPending).toBe(false);
  });
});

describe("开播通知权限", () => {
  let windowDescriptor: PropertyDescriptor | undefined;
  let tauriDescriptor: PropertyDescriptor | undefined;
  let notificationDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
    tauriDescriptor = Object.getOwnPropertyDescriptor(globalThis, "isTauri");
    notificationDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Notification");
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: globalThis,
    });
    Object.defineProperty(globalThis, "isTauri", { configurable: true, value: true });
    mockIPC((command) => {
      if (command === "plugin:notification|is_permission_granted") return false;
      throw new Error(`意外 IPC 命令：${command}`);
    });
  });

  afterEach(() => {
    clearMocks();
    if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
    else Reflect.deleteProperty(globalThis, "window");
    if (tauriDescriptor) Object.defineProperty(globalThis, "isTauri", tauriDescriptor);
    else Reflect.deleteProperty(globalThis, "isTauri");
    if (notificationDescriptor) {
      Object.defineProperty(globalThis, "Notification", notificationDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, "Notification");
    }
  });

  test("系统拒绝时返回 denied，且不会误判为已授权", async () => {
    let requests = 0;
    Object.defineProperty(globalThis, "Notification", {
      configurable: true,
      value: {
        permission: "default",
        requestPermission: async () => {
          requests += 1;
          return "denied";
        },
      },
    });
    const { getLiveStartNotificationPermission, requestLiveStartNotificationPermission } =
      await import("../src/features/follow/liveStartNotifications");

    await expect(getLiveStartNotificationPermission()).resolves.toBe("default");
    expect(requests).toBe(0);
    await expect(requestLiveStartNotificationPermission()).resolves.toBe("denied");
    expect(requests).toBe(1);
  });

  test("开播事件拒绝未知平台和缺失字段", async () => {
    const { parseFollowLiveStartedPayload } =
      await import("../src/features/follow/liveStartNotifications");

    expect(
      parseFollowLiveStartedPayload({
        site_id: "unknown",
        room_id: "1",
        user_name: "主播",
      }),
    ).toBeNull();
    expect(
      parseFollowLiveStartedPayload({
        site_id: "bilibili",
        room_id: " ",
        user_name: "主播",
      }),
    ).toBeNull();
    expect(
      parseFollowLiveStartedPayload({
        site_id: "bilibili",
        room_id: " 100 ",
        user_name: " 主播 ",
      }),
    ).toEqual({
      site_id: "bilibili",
      room_id: "100",
      user_name: "主播",
    });
  });
});

describe("共享关注刷新调度", () => {
  let windowDescriptor: PropertyDescriptor | undefined;
  let documentDescriptor: PropertyDescriptor | undefined;
  let tauriDescriptor: PropertyDescriptor | undefined;
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const addedListeners: ((event: Event) => void)[] = [];
  const removedListeners: ((event: Event) => void)[] = [];

  beforeEach(() => {
    windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
    documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
    tauriDescriptor = Object.getOwnPropertyDescriptor(globalThis, "isTauri");
    Object.defineProperty(globalThis, "isTauri", { configurable: true, value: true });
    timers.clear();
    addedListeners.length = 0;
    removedListeners.length = 0;

    let timerId = 0;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        setTimeout: (callback: () => void, delay: number) => {
          const id = ++timerId;
          timers.set(id, { callback, delay });
          return id;
        },
        clearTimeout: (id: number) => {
          timers.delete(id);
        },
      },
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        visibilityState: "visible",
        addEventListener: (_event: string, handler: (event: Event) => void) => {
          addedListeners.push(handler);
        },
        removeEventListener: (_event: string, handler: (event: Event) => void) => {
          removedListeners.push(handler);
        },
      },
    });
  });

  afterEach(() => {
    clearMocks();
    if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
    else Reflect.deleteProperty(globalThis, "window");
    if (documentDescriptor) {
      Object.defineProperty(globalThis, "document", documentDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, "document");
    }
    if (tauriDescriptor) Object.defineProperty(globalThis, "isTauri", tauriDescriptor);
    else Reflect.deleteProperty(globalThis, "isTauri");
  });

  test("多个 consumer 只发一次自动刷新，并在最后一个释放时回收监听", async () => {
    let refreshes = 0;
    mockIPC((command) => {
      if (command === "follow_refresh") {
        refreshes += 1;
        return {
          follows: [],
          summary: {
            total: 0,
            refreshed: 0,
            refreshed_keys: [],
            failures: [],
            checked_at: 1,
          },
        };
      }
      throw new Error(`意外 IPC 命令：${command}`);
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const releaseFirst = acquireFollowRefreshScheduler(queryClient);
    const releaseSecond = acquireFollowRefreshScheduler(queryClient);
    expect(timers).toHaveLength(1);
    expect(addedListeners).toHaveLength(1);

    const [timerId, timer] = timers.entries().next().value!;
    timers.delete(timerId);
    timer.callback();
    await settle();
    await settle();
    expect(refreshes).toBe(1);

    releaseFirst();
    expect(removedListeners).toHaveLength(0);
    releaseSecond();
    expect(timers).toHaveLength(0);
    expect(removedListeners).toEqual(addedListeners);

    const releaseReacquired = acquireFollowRefreshScheduler(queryClient);
    releaseReacquired();
    expect(addedListeners).toHaveLength(2);
    expect(removedListeners).toEqual(addedListeners);
  });

  test("自动刷新失败后等待完整周期，不形成紧循环", async () => {
    let refreshes = 0;
    mockIPC((command) => {
      if (command === "follow_refresh") {
        refreshes += 1;
        throw new Error("network down");
      }
      throw new Error(`意外 IPC 命令：${command}`);
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const release = acquireFollowRefreshScheduler(queryClient);

    const [timerId, timer] = timers.entries().next().value!;
    timers.delete(timerId);
    timer.callback();
    await settle();
    await settle();

    expect(refreshes).toBe(1);
    expect(timers).toHaveLength(1);
    expect(timers.values().next().value!.delay).toBeGreaterThanOrEqual(59_000);

    release();
    expect(timers).toHaveLength(0);
    expect(removedListeners).toEqual(addedListeners);
  });
});
