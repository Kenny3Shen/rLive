import { Headphones } from "lucide-react";

/** Quiet stage state shared by live-room and IPTV playback. */
export function AudioOnlyIndicator() {
  return (
    <div
      data-audio-only-indicator
      role="status"
      aria-live="polite"
      className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 text-white/72"
    >
      <Headphones className="size-9" aria-hidden />
      <span className="text-sm font-medium">仅播声音</span>
    </div>
  );
}
