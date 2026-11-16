import { memo } from "react";

import { ScrollArea } from "@/components/ui/scroll-area";
import { PlaybackSettingsContent } from "@/features/settings/PlaybackSettingsContent";
import { SettingsLayoutProvider } from "@/features/settings/SettingsSection";
import { cn } from "@/lib/utils";

/** 播放页侧栏入口，与设置页“播放与弹幕”共用同一组设置分区。 */
export const PlaybackSettingsPanel = memo(function PlaybackSettingsPanel({
  className,
  idPrefix,
}: {
  className?: string;
  idPrefix: string;
}) {
  return (
    <ScrollArea className={cn("min-h-0 flex-1", className)}>
      <div data-slot="playback-settings-panel" className="flex flex-col gap-4 px-3 py-3">
        <SettingsLayoutProvider layout="sidebar">
          <PlaybackSettingsContent idPrefix={idPrefix} />
        </SettingsLayoutProvider>
      </div>
    </ScrollArea>
  );
});
