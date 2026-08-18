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
 * Settings mounted in the shared player menu for local VOD playback.
 * Danmaku fields deliberately reuse the room settings fields so a recording
 * responds to the same preferences as a live room immediately.
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
