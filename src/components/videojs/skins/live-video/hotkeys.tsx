import { useEffect } from "react";

import { LivePlaybackHotkeys } from "../shared/live-playback-hotkeys";

export interface LiveVideoHotkeysProps {
  disabled?: boolean | undefined;
  onToggleFullscreen?: () => void;
  /** 业务暂停入口；传入后 Space/K 与播放按钮共用同一条暂停记账。 */
  onTogglePause?: (() => void) | undefined;
}

export function LiveVideoHotkeys({
  disabled = false,
  onToggleFullscreen,
  onTogglePause,
}: LiveVideoHotkeysProps = {}) {
  useEffect(() => {
    if (disabled || !onToggleFullscreen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "f" || e.key === "F") {
        e.preventDefault();
        onToggleFullscreen();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [disabled, onToggleFullscreen]);

  return <LivePlaybackHotkeys disabled={disabled} onTogglePause={onTogglePause} />;
}
