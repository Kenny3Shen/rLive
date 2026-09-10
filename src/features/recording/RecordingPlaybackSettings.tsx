import { FieldDescription, FieldGroup, FieldLegend, FieldSet } from "@/components/ui/field";
import {
  DanmakuAppearanceSettingsFields,
  DanmakuFilterSettingsFields,
  DanmakuTrackSettingsFields,
} from "@/features/settings/PlaybackPreferenceFields";

/**
 * 挂载在共享播放器菜单中、用于本地 VOD 回放的弹幕偏好。字段刻意复用房间
 * 设置字段，使录制立即响应与直播间相同的偏好；录制没有弹幕轨时由调用方
 * 直接不传 `playbackSettings`，避免渲染空壳的回放设置入口。
 */
export function RecordingPlaybackSettings() {
  return (
    <FieldSet className="gap-2">
      <FieldLegend>弹幕</FieldLegend>
      <FieldDescription>与直播间共用显示、速度和过滤设置。</FieldDescription>
      <FieldGroup className="gap-2">
        <DanmakuTrackSettingsFields idPrefix="recording" layout="panel" />
        <DanmakuAppearanceSettingsFields idPrefix="recording" layout="panel" />
        <DanmakuFilterSettingsFields idPrefix="recording" layout="panel" showSuperChat />
      </FieldGroup>
    </FieldSet>
  );
}
