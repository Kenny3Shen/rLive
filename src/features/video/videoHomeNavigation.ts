type VideoHomeNavigation = {
  fullscreen: boolean;
  exitFullscreen: () => Promise<void>;
  isCurrentEntry: () => boolean;
  navigateHome: () => void;
};

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
