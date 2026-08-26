import type { Window as TauriWindow } from "@tauri-apps/api/window";
import { isWindowsDesktop } from "./clientPlatform";

export type NativePlayerWindow = Pick<
  TauriWindow,
  "isFullscreen" | "isMaximized" | "setFullscreen" | "unmaximize" | "maximize"
>;

export type NativeFullscreenSession = {
  restoreMaximized: boolean;
  transitionInProgress: boolean;
};

export function createNativeFullscreenSession(): NativeFullscreenSession {
  return {
    restoreMaximized: false,
    transitionInProgress: false,
  };
}

async function waitForWindowState(
  readState: () => Promise<boolean>,
  expected: boolean,
): Promise<boolean> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if ((await readState()) === expected) return true;
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 16));
  }
  return false;
}

/** 外部原生退出后恢复全屏前的最大化状态。 */
export async function restoreNativePlayerMaximizedState(
  appWindow: NativePlayerWindow,
  session: NativeFullscreenSession,
  windowsDesktop = isWindowsDesktop(),
): Promise<void> {
  if (!windowsDesktop || !session.restoreMaximized || session.transitionInProgress) return;

  session.transitionInProgress = true;
  try {
    await appWindow.maximize();
    session.restoreMaximized = false;
  } finally {
    session.transitionInProgress = false;
  }
}

/**
 * Windows 会把最大化的无边框窗口限制在任务栏工作区内，
 * 即使 Tauri 已应用无边框全屏。先清除该状态，
 * 播放退出全屏时再恢复。
 */
export async function setNativePlayerFullscreen(
  appWindow: NativePlayerWindow,
  fullscreen: boolean,
  session: NativeFullscreenSession,
  windowsDesktop = isWindowsDesktop(),
): Promise<void> {
  if (session.transitionInProgress) return;

  session.transitionInProgress = true;
  try {
    if (fullscreen) {
      const restoreMaximized = windowsDesktop && (await appWindow.isMaximized());
      session.restoreMaximized = restoreMaximized;

      if (restoreMaximized) {
        await appWindow.unmaximize();
        const unmaximized = await waitForWindowState(() => appWindow.isMaximized(), false);
        if (!unmaximized) {
          session.restoreMaximized = false;
          throw new Error("无法在全屏前退出窗口最大化状态");
        }
      }

      try {
        await appWindow.setFullscreen(true);
      } catch (cause) {
        if (restoreMaximized) {
          session.restoreMaximized = false;
          try {
            await appWindow.maximize();
          } catch {
            // 保留最初的全屏失败原因。
          }
        }
        throw cause;
      }
      return;
    }

    await appWindow.setFullscreen(false);
    if (windowsDesktop && session.restoreMaximized) {
      await waitForWindowState(() => appWindow.isFullscreen(), false);
      await appWindow.maximize();
      session.restoreMaximized = false;
    }
  } finally {
    session.transitionInProgress = false;
  }
}

export async function toggleNativePlayerFullscreen(
  appWindow: NativePlayerWindow,
  session: NativeFullscreenSession,
): Promise<boolean> {
  const next = !(await appWindow.isFullscreen());
  await setNativePlayerFullscreen(appWindow, next, session);
  return next;
}
