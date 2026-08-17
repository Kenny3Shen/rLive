import { invokeCmd } from "@/shared/api/tauri";

export type AppDataStorageInfo = {
  /** Configured location used after the next restart. */
  path: string;
  /** Location used by the running process. */
  currentPath: string;
  defaultPath: string;
  isDefault: boolean;
  restartRequired: boolean;
};

type AppDataStorageInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export function createAppDataStorageApi(invoke: AppDataStorageInvoke) {
  return {
    info: () => invoke<AppDataStorageInfo>("app_data_storage_info"),
    setPath: (path: string | null) =>
      invoke<AppDataStorageInfo>("app_data_set_storage_path", { path }),
  };
}

const appDataStorageApi = createAppDataStorageApi(invokeCmd);

export function appDataStorageInfo(): Promise<AppDataStorageInfo> {
  return appDataStorageApi.info();
}

export function setAppDataStoragePath(path: string | null): Promise<AppDataStorageInfo> {
  return appDataStorageApi.setPath(path);
}
