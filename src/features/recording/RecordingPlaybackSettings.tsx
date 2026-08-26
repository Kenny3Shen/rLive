import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from "@/components/ui/field";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  DanmakuAppearanceSettingsFields,
  DanmakuFilterSettingsFields,
  DanmakuTrackSettingsFields,
} from "@/features/settings/PlaybackPreferenceFields";

const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

type RecordingPlaybackSettingsProps = {
  playbackRate: number;
  onPlaybackRateChange: (rate: number) => void;
  hasDanmaku: boolean;
};

/**
 * 挂载在共享播放器菜单中、用于本地 VOD 回放的设置项。弹幕字段刻意复用房间
 * 设置字段，使录制立即响应与直播间相同的偏好。
 */
export function RecordingPlaybackSettings({
  playbackRate,
  onPlaybackRateChange,
  hasDanmaku,
}: RecordingPlaybackSettingsProps) {
  return (
    <FieldGroup className="gap-3">
      <Field className="gap-2">
        <FieldContent>
          <FieldTitle>播放速度</FieldTitle>
          <FieldDescription>只影响当前录制，不会修改直播间默认速度。</FieldDescription>
        </FieldContent>
        <ToggleGroup
          value={[String(playbackRate)]}
          variant="outline"
          size="sm"
          spacing={1}
          aria-label="播放速度"
          className="w-full flex-wrap"
          onValueChange={(value) => {
            const selected = value.at(-1);
            const next = Number(selected);
            if (
              Number.isFinite(next) &&
              PLAYBACK_RATES.includes(next as (typeof PLAYBACK_RATES)[number])
            ) {
              onPlaybackRateChange(next);
            }
          }}
        >
          {PLAYBACK_RATES.map((rate) => (
            <ToggleGroupItem
              key={rate}
              value={String(rate)}
              aria-label={`${rate} 倍速`}
              className="min-w-0 flex-1"
            >
              {rate}x
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </Field>

      {hasDanmaku && (
        <FieldSet className="gap-2">
          <FieldLegend>弹幕</FieldLegend>
          <FieldDescription>与直播间共用显示、速度和过滤设置。</FieldDescription>
          <FieldGroup className="gap-2">
            <DanmakuTrackSettingsFields idPrefix="recording" layout="panel" />
            <DanmakuAppearanceSettingsFields idPrefix="recording" layout="panel" />
            <DanmakuFilterSettingsFields idPrefix="recording" layout="panel" showSuperChat />
          </FieldGroup>
        </FieldSet>
      )}
    </FieldGroup>
  );
}
