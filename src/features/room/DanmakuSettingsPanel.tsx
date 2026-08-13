import { memo, useEffect, useState } from "react";
import type { SiteId } from "@/shared/types/live";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import { isMobileClient } from "@/shared/clientPlatform";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Field,
  FieldContent,
  FieldGroup,
  FieldLegend,
  FieldLabel,
  FieldSet,
  FieldTitle,
} from "@/components/ui/field";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  AsrCaptionFontSizeField,
  AsrChunkIntervalField,
  DanmakuAppearanceSettingsFields,
  DanmakuFilterSettingsFields,
  DanmakuTrackSettingsFields,
  SuperChatSettingsFields,
} from "@/features/settings/PlaybackPreferenceFields";
import {
  AUTO_DANMAKU_SEND_MAX_INTERVAL_SECONDS,
  AUTO_DANMAKU_SEND_MIN_INTERVAL_SECONDS,
  normalizeAutoDanmakuSendIntervalSeconds,
} from "./danmaku/autoSend";
import type { AutoDanmakuSendController } from "./danmaku/useAutoDanmakuSend";
import { siteSupportsSuperChat } from "./superChat";

function AutoDanmakuSendSection({ autoSend }: { autoSend: AutoDanmakuSendController }) {
  const [intervalDraft, setIntervalDraft] = useState(() => String(autoSend.intervalSeconds));

  useEffect(() => {
    setIntervalDraft(String(autoSend.intervalSeconds));
  }, [autoSend.intervalSeconds]);

  const commitInterval = () => {
    const intervalSeconds = normalizeAutoDanmakuSendIntervalSeconds(Number(intervalDraft));
    autoSend.onIntervalChange(intervalSeconds);
    setIntervalDraft(String(intervalSeconds));
  };

  const segmentLabel =
    autoSend.currentSegmentIndex === null || autoSend.segmentCount === 0
      ? `${autoSend.segmentCount} 段`
      : `${autoSend.currentSegmentIndex + 1}/${autoSend.segmentCount} 段`;
  const statusIsError = autoSend.phase === "paused";

  return (
    <Card size="sm">
      <CardHeader className="border-b">
        <CardTitle>自动发送弹幕</CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <FieldSet>
          <FieldLegend className="sr-only">自动发送弹幕</FieldLegend>
          <FieldGroup className="gap-3">
            <Field>
              <div className="flex items-center justify-between gap-2">
                <FieldLabel htmlFor="room-auto-danmaku-text">发送内容</FieldLabel>
                <Badge variant="outline">{autoSend.segmentCount} 段</Badge>
              </div>
              <FieldContent>
                <Textarea
                  id="room-auto-danmaku-text"
                  value={autoSend.text}
                  rows={4}
                  placeholder="输入要循环发送的普通弹幕"
                  className="resize-y"
                  onChange={(event) => autoSend.onTextChange(event.target.value)}
                />
              </FieldContent>
            </Field>

            <Field orientation="horizontal">
              <FieldLabel htmlFor="room-auto-danmaku-interval">发送间隔</FieldLabel>
              <InputGroup className="w-28 shrink-0">
                <InputGroupInput
                  id="room-auto-danmaku-interval"
                  type="number"
                  inputMode="numeric"
                  min={AUTO_DANMAKU_SEND_MIN_INTERVAL_SECONDS}
                  max={AUTO_DANMAKU_SEND_MAX_INTERVAL_SECONDS}
                  step={1}
                  value={intervalDraft}
                  onChange={(event) => setIntervalDraft(event.currentTarget.value)}
                  onBlur={commitInterval}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                  }}
                />
                <InputGroupAddon align="inline-end">秒</InputGroupAddon>
              </InputGroup>
            </Field>

            <Field orientation="horizontal" data-disabled={!autoSend.canEnable ? true : undefined}>
              <FieldTitle id="room-auto-danmaku-enabled">自动发送</FieldTitle>
              <Switch
                aria-labelledby="room-auto-danmaku-enabled"
                checked={autoSend.enabled}
                disabled={!autoSend.canEnable}
                onCheckedChange={autoSend.onEnabledChange}
              />
            </Field>
          </FieldGroup>
        </FieldSet>
      </CardContent>
      <CardFooter className="justify-between gap-3">
        <span
          className={cn(
            "min-w-0 text-xs text-muted-foreground",
            statusIsError && "text-destructive",
          )}
          role="status"
          aria-live="polite"
        >
          {autoSend.statusMessage}
        </span>
        <Badge variant="outline">{segmentLabel}</Badge>
      </CardFooter>
    </Card>
  );
}

/**
 * Room-local access to the shared playback preferences, plus the one
 * session-only auto-send controller that cannot exist outside a live room.
 */
export const DanmakuSettingsPanel = memo(function DanmakuSettingsPanel({
  className,
  autoSend,
  siteId,
}: {
  className?: string;
  autoSend?: AutoDanmakuSendController;
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
        {autoSend && <AutoDanmakuSendSection autoSend={autoSend} />}

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
