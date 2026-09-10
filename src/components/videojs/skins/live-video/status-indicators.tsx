import type { ComponentProps } from "react";

import { cn } from "@/components/videojs/lib/resolve-class-name";
import { StatusAnnouncer } from "@/components/videojs/ui/status-announcer";
import { PlaybackStatusIndicator, StatusIndicator } from "@/components/videojs/ui/status-indicator";
import { VolumeIndicator } from "@/components/videojs/ui/volume-indicator";

export type LiveVideoStatusIndicatorsProps = Omit<ComponentProps<"div">, "children">;

export function LiveVideoStatusIndicators({
  className,
  ...props
}: LiveVideoStatusIndicatorsProps = {}) {
  return (
    <>
      <StatusAnnouncer />
      <div
        className={cn(
          "pointer-events-none absolute inset-0 grid grid-cols-3 items-center justify-items-center text-media-controls-foreground",
          className,
        )}
        {...props}
      >
        <VolumeIndicator />
        <StatusIndicator />
        <PlaybackStatusIndicator />
      </div>
    </>
  );
}
