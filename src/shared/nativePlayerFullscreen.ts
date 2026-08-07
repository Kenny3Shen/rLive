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

/** Restore the pre-fullscreen maximized state after an external native exit. */
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
 * Windows constrains a maximized undecorated window to the taskbar work area,
 * even after Tauri applies borderless fullscreen. Clear that state first, then
 * restore it when playback leaves fullscreen.
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
            // Preserve the original fullscreen failure.
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
