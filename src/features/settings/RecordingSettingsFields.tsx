import { useEffect, useRef, useState } from "react";
import { Field, FieldContent, FieldDescription, FieldTitle } from "@/components/ui/field";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Switch } from "@/components/ui/switch";
import {
  FFMPEG_HLS_SEGMENT_RETRY_COUNT_MAX,
  FFMPEG_HLS_SEGMENT_RETRY_COUNT_MIN,
  FFMPEG_RECONNECT_DELAY_MAX_SECONDS_MAX,
  FFMPEG_RECONNECT_DELAY_MAX_SECONDS_MIN,
  FFMPEG_RW_TIMEOUT_SECONDS_MAX,
  FFMPEG_RW_TIMEOUT_SECONDS_MIN,
  parseFfmpegHlsSegmentRetryCount,
  parseFfmpegReconnectDelayMaxSeconds,
  parseFfmpegRwTimeoutSeconds,
  useSettingsStore,
} from "@/shared/stores/settingsStore";

type NumberSettingFieldProps = {
  id: string;
  title: string;
  description: string;
  value: number;
  min: number;
  max: number;
  unit: string;
  normalize: (value: unknown) => number;
  onCommit: (value: number) => void;
};

function NumberSettingField({
  id,
  title,
  description,
  value,
  min,
  max,
  unit,
  normalize,
  onCommit,
}: NumberSettingFieldProps) {
  const [draft, setDraft] = useState(String(value));
  const skipNextBlurCommit = useRef(false);

  useEffect(() => setDraft(String(value)), [value]);

  function commit() {
    if (skipNextBlurCommit.current) {
      skipNextBlurCommit.current = false;
      return;
    }
    const next = normalize(Number.parseInt(draft, 10));
    setDraft(String(next));
    onCommit(next);
  }

  return (
    <Field orientation="horizontal">
      <FieldContent>
        <FieldTitle>
          <span id={`${id}-label`}>{title}</span>
        </FieldTitle>
        <FieldDescription>{description}</FieldDescription>
      </FieldContent>
      <InputGroup className="w-28 max-w-full shrink-0">
        <InputGroupInput
          id={id}
          aria-labelledby={`${id}-label`}
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          step={1}
          value={draft}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              skipNextBlurCommit.current = true;
              setDraft(String(value));
              event.currentTarget.blur();
            }
          }}
        />
        <InputGroupAddon align="inline-end">{unit}</InputGroupAddon>
      </InputGroup>
    </Field>
  );
}

export function RecordingDefaultsFields() {
  const includeDanmaku = useSettingsStore((state) => state.recordingIncludeDanmaku);
  const continueAfterLeave = useSettingsStore((state) => state.recordingContinueAfterLeave);
  const setIncludeDanmaku = useSettingsStore((state) => state.setRecordingIncludeDanmaku);
  const setContinueAfterLeave = useSettingsStore((state) => state.setRecordingContinueAfterLeave);

  return (
    <>
      <Field orientation="horizontal">
        <FieldContent>
          <FieldTitle id="recording-include-danmaku-label">默认录制弹幕</FieldTitle>
          <FieldDescription>直播录制默认创建同步弹幕轨，开始录制前仍可单独调整。</FieldDescription>
        </FieldContent>
        <Switch
          aria-labelledby="recording-include-danmaku-label"
          checked={includeDanmaku}
          onCheckedChange={setIncludeDanmaku}
        />
      </Field>
      <Field orientation="horizontal">
        <FieldContent>
          <FieldTitle id="recording-continue-after-leave-label">默认后台录制</FieldTitle>
          <FieldDescription>离开直播间或 IPTV 播放页后继续录制，直到手动停止。</FieldDescription>
        </FieldContent>
        <Switch
          aria-labelledby="recording-continue-after-leave-label"
          checked={continueAfterLeave}
          onCheckedChange={setContinueAfterLeave}
        />
      </Field>
    </>
  );
}

export function FfmpegSettingsFields() {
  const rwTimeout = useSettingsStore((state) => state.ffmpegRwTimeoutSeconds);
  const reconnectDelay = useSettingsStore((state) => state.ffmpegReconnectDelayMaxSeconds);
  const hlsRetryCount = useSettingsStore((state) => state.ffmpegHlsSegmentRetryCount);
  const setRwTimeout = useSettingsStore((state) => state.setFfmpegRwTimeoutSeconds);
  const setReconnectDelay = useSettingsStore((state) => state.setFfmpegReconnectDelayMaxSeconds);
  const setHlsRetryCount = useSettingsStore((state) => state.setFfmpegHlsSegmentRetryCount);

  return (
    <>
      <NumberSettingField
        id="ffmpeg-rw-timeout"
        title="读写超时"
        description="直播流持续无数据超过此时间后，FFmpeg 将进入错误恢复流程。"
        value={rwTimeout}
        min={FFMPEG_RW_TIMEOUT_SECONDS_MIN}
        max={FFMPEG_RW_TIMEOUT_SECONDS_MAX}
        unit="秒"
        normalize={parseFfmpegRwTimeoutSeconds}
        onCommit={setRwTimeout}
      />
      <NumberSettingField
        id="ffmpeg-reconnect-delay"
        title="最大重连延迟"
        description="限制连续重连之间的最长等待时间。"
        value={reconnectDelay}
        min={FFMPEG_RECONNECT_DELAY_MAX_SECONDS_MIN}
        max={FFMPEG_RECONNECT_DELAY_MAX_SECONDS_MAX}
        unit="秒"
        normalize={parseFfmpegReconnectDelayMaxSeconds}
        onCommit={setReconnectDelay}
      />
      <NumberSettingField
        id="ffmpeg-hls-segment-retries"
        title="HLS 分片重试"
        description="单个 HLS 分片读取失败后的额外重试次数，设为 0 可关闭重试。"
        value={hlsRetryCount}
        min={FFMPEG_HLS_SEGMENT_RETRY_COUNT_MIN}
        max={FFMPEG_HLS_SEGMENT_RETRY_COUNT_MAX}
        unit="次"
        normalize={parseFfmpegHlsSegmentRetryCount}
        onCommit={setHlsRetryCount}
      />
    </>
  );
}
