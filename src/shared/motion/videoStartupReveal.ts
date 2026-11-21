export type VideoStartupOrientation = "landscape" | "portrait";

export const VIDEO_STARTUP_CHROME_SELECTOR = "[data-player-hud], [data-vod-details-controls]";
export const VIDEO_STARTUP_DETAILS_SELECTOR = "[data-vod-details-aside]";

export type VideoStartupKeyframes = {
  chrome: Keyframe[];
  details: Keyframe[];
};

/**
 * 方向取当前路由 entry 第一次出现时的值。
 * 同一 entry 只锁定一次；只有路由进入或同路由的新历史条目才开启下一轮。
 */
export function lockVideoStartupOrientation(
  previous: { entryKey: string; orientation: VideoStartupOrientation } | null,
  entryKey: string,
  orientation: VideoStartupOrientation,
): { entryKey: string; orientation: VideoStartupOrientation } {
  if (previous?.entryKey === entryKey) return previous;
  return { entryKey, orientation };
}

export function shouldRevealVideoStartup({
  ready,
  mobileClient,
  reducedMotion,
  entryKey,
  attemptedEntryKey,
}: {
  ready: boolean;
  mobileClient: boolean;
  reducedMotion: boolean;
  entryKey: string;
  attemptedEntryKey: string | null;
}): boolean {
  if (!ready || !mobileClient || reducedMotion) return false;
  return attemptedEntryKey !== entryKey;
}

/**
 * 播放界面已在视口里，细节区的位移只做方向提示：竖屏从下方、横屏从右侧。
 * 控制层留在原位淡入，避免产生第二个大范围运动焦点。
 */
export function videoStartupKeyframes(orientation: VideoStartupOrientation): VideoStartupKeyframes {
  return {
    chrome: [{ opacity: 0 }, { opacity: 1 }],
    details: [
      {
        opacity: 0.35,
        transform:
          orientation === "portrait" ? "translate3d(0, 12px, 0)" : "translate3d(12px, 0, 0)",
      },
      { opacity: 1, transform: "translate3d(0, 0, 0)" },
    ],
  };
}
