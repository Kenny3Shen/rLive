import { useEffect } from "react";

import { PlaybackHotkeys } from "../shared/playback-hotkeys";

export interface VideoHotkeysProps {
  disabled?: boolean | undefined;
  onToggleFullscreen?: () => void;
}

export function VideoHotkeys({ disabled = false, onToggleFullscreen }: VideoHotkeysProps = {}) {
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

  return <PlaybackHotkeys disabled={disabled} />;
}
