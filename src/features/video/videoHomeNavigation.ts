import { canNavigateBackInApp } from "@/shared/appHistory";

type VideoHomeNavigation = {
  fullscreen: boolean;
  exitFullscreen: () => Promise<void>;
  isCurrentEntry: () => boolean;
  navigateHome: () => void;
};

type VideoBackNavigation = {
  entryKey: string;
  requestedEntryKey?: string | null;
  historyState: unknown;
  markRequested?: () => void;
  /** 退回浏览器历史中的上一层。 */
  navigateBack: () => void;
  navigateHome: () => void;
};

export function navigateBackFromVideo({
  entryKey,
  requestedEntryKey,
  historyState,
  markRequested,
  navigateBack,
  navigateHome,
}: VideoBackNavigation): void {
  if (requestedEntryKey === entryKey) return;
  if (!historyState || typeof historyState !== "object" || Array.isArray(historyState)) {
    if (entryKey === "default") {
      markRequested?.();
      navigateHome();
    }
    return;
  }
  const key = Reflect.get(historyState, "key");
  if (typeof key === "string" && key.length > 0 && key !== entryKey) return;
  if (typeof key !== "string" && entryKey !== "default") return;
  markRequested?.();
  if (canNavigateBackInApp(historyState)) {
    navigateBack();
    return;
  }
  navigateHome();
}

/** 普通窗口不等待原生全屏 IPC；全屏退出后的迟到结果不得覆盖后续导航。 */
export async function navigateToVideoHome({
  fullscreen,
  exitFullscreen,
  isCurrentEntry,
  navigateHome,
}: VideoHomeNavigation): Promise<void> {
  if (fullscreen) await exitFullscreen();
  if (isCurrentEntry()) navigateHome();
}
