import { memo } from "react";
import type { SiteId } from "@/shared/types/live";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import { isMobileClient } from "@/shared/clientPlatform";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FieldGroup } from "@/components/ui/field";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import {
  AsrCaptionFontSizeField,
  AsrChunkIntervalField,
  DanmakuAppearanceSettingsFields,
  DanmakuFilterSettingsFields,
  DanmakuTrackSettingsFields,
} from "@/features/settings/PlaybackPreferenceFields";
import { siteSupportsSuperChat } from "./superChat";
/** 访问共享播放偏好设置的房间级入口。 */
export const DanmakuSettingsPanel = memo(function DanmakuSettingsPanel({
  className,
  siteId,
}: {
  className?: string;
  siteId?: SiteId;
}) {
  const asrPending = useSettingsStore((s) => s.asrPending);
  const mobileClient = isMobileClient();

  return (
    <ScrollArea className={cn("min-h-0 flex-1", className)}>
      <div className="flex flex-col gap-3 px-3 py-3">
        {!mobileClient && (
          <Card size="sm">
            <CardHeader className="border-b">
              <CardTitle>语音字幕</CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              <FieldGroup className="gap-2">
                <AsrCaptionFontSizeField idPrefix="room" layout="panel" />
                <AsrChunkIntervalField idPrefix="room" layout="panel" disabled={asrPending} />
              </FieldGroup>
            </CardContent>
          </Card>
        )}

        <Card size="sm">
          <CardHeader className="border-b">
            <CardTitle>弹幕设置</CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <FieldGroup className="gap-2">
              <DanmakuTrackSettingsFields idPrefix="room" layout="panel" />
              <DanmakuAppearanceSettingsFields idPrefix="room" layout="panel" />
            </FieldGroup>
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader className="border-b">
            <CardTitle>消息过滤</CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <FieldGroup className="gap-2">
              <DanmakuFilterSettingsFields
                idPrefix="room"
                layout="panel"
                showSuperChat={siteSupportsSuperChat(siteId)}
              />
            </FieldGroup>
          </CardContent>
        </Card>
      </div>
    </ScrollArea>
  );
});
