import { useEffect } from "react";

import { LivePlaybackHotkeys } from "../shared/live-playback-hotkeys";

export interface LiveVideoHotkeysProps {
  disabled?: boolean | undefined;
  onToggleFullscreen?: () => void;
}

export function LiveVideoHotkeys({
  disabled = false,
  onToggleFullscreen,
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

  return <LivePlaybackHotkeys disabled={disabled} />;
}
