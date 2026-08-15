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
  SuperChatSettingsFields,
} from "@/features/settings/PlaybackPreferenceFields";
import { siteSupportsSuperChat } from "./superChat";
/**
 * Room-local access to the shared playback preferences.
 */
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

        {siteSupportsSuperChat(siteId) && (
          <Card size="sm">
            <CardHeader className="border-b">
              <CardTitle>醒目留言</CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              <FieldGroup className="gap-2">
                <SuperChatSettingsFields idPrefix="room" layout="panel" />
              </FieldGroup>
            </CardContent>
          </Card>
        )}
        <Card size="sm">
          <CardHeader className="border-b">
            <CardTitle>弹幕轨道</CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <FieldGroup className="gap-2">
              <DanmakuTrackSettingsFields idPrefix="room" layout="panel" />
            </FieldGroup>
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader className="border-b">
            <CardTitle>文字与节奏</CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <FieldGroup className="gap-2">
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
              <DanmakuFilterSettingsFields idPrefix="room" layout="panel" />
            </FieldGroup>
          </CardContent>
        </Card>
      </div>
    </ScrollArea>
  );
});
