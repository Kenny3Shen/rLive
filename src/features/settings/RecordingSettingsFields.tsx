import { useEffect, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldTitle,
} from "@/components/ui/field";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Textarea } from "@/components/ui/textarea";
import { FieldTip } from "@/features/settings/FieldTip";
import { Switch } from "@/components/ui/switch";
import {
  FFMPEG_HLS_SEGMENT_RETRY_COUNT_MAX,
  FFMPEG_HLS_SEGMENT_RETRY_COUNT_MIN,
  FFMPEG_RECONNECT_DELAY_MAX_SECONDS_MAX,
  FFMPEG_RECONNECT_DELAY_MAX_SECONDS_MIN,
  FFMPEG_RW_TIMEOUT_SECONDS_MAX,
  FFMPEG_RW_TIMEOUT_SECONDS_MIN,
  RECORDING_AUTO_SPLIT_MINUTES_MAX,
  RECORDING_AUTO_SPLIT_MINUTES_MIN,
  RECORDING_ASS_DEFAULT_SETTINGS,
  RECORDING_ASS_DISPLAY_AREA_PERCENT_MAX,
  RECORDING_ASS_DISPLAY_AREA_PERCENT_MIN,
  RECORDING_ASS_FONT_SIZE_MAX,
  RECORDING_ASS_FONT_SIZE_MIN,
  RECORDING_ASS_MERGE_WINDOW_SECONDS_MAX,
  RECORDING_ASS_MERGE_WINDOW_SECONDS_MIN,
  RECORDING_ASS_RESOLUTION_HEIGHT_MAX,
  RECORDING_ASS_RESOLUTION_HEIGHT_MIN,
  RECORDING_ASS_RESOLUTION_WIDTH_MAX,
  RECORDING_ASS_RESOLUTION_WIDTH_MIN,
  RECORDING_ASS_SCROLL_DURATION_SECONDS_MAX,
  RECORDING_ASS_SCROLL_DURATION_SECONDS_MIN,
  RECORDING_ASS_STYLE_WIDTH_MAX,
  RECORDING_ASS_STYLE_WIDTH_MIN,
  normalizeRecordingAssSettings,
  parseFfmpegHlsSegmentRetryCount,
  parseFfmpegReconnectDelayMaxSeconds,
  parseFfmpegRwTimeoutSeconds,
  parseRecordingAutoSplitMinutes,
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
  step?: number;
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
  step = 1,
}: NumberSettingFieldProps) {
  const [draft, setDraft] = useState(String(value));
  const skipNextBlurCommit = useRef(false);

  useEffect(() => setDraft(String(value)), [value]);

  function commit() {
    if (skipNextBlurCommit.current) {
      skipNextBlurCommit.current = false;
      return;
    }
    const next = normalize(Number(draft));
    setDraft(String(next));
    onCommit(next);
  }

  return (
    <Field orientation="horizontal">
      <FieldContent>
        <FieldTitle>
          <span id={`${id}-label`}>{title}</span>
          <FieldTip>{description}</FieldTip>
        </FieldTitle>
      </FieldContent>
      <InputGroup className="w-28 max-w-full shrink-0 self-center">
        <InputGroupInput
          id={id}
          aria-labelledby={`${id}-label`}
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          step={step}
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

type CompactNumberInputProps = {
  id: string;
  ariaLabel: string;
  value: number;
  min: number;
  max: number;
  normalize: (value: unknown) => number;
  onCommit: (value: number) => void;
};

function CompactNumberInput({
  id,
  ariaLabel,
  value,
  min,
  max,
  normalize,
  onCommit,
}: CompactNumberInputProps) {
  const [draft, setDraft] = useState(String(value));
  const skipNextBlurCommit = useRef(false);

  useEffect(() => setDraft(String(value)), [value]);

  function commit() {
    if (skipNextBlurCommit.current) {
      skipNextBlurCommit.current = false;
      return;
    }
    const next = normalize(Number(draft));
    setDraft(String(next));
    onCommit(next);
  }

  return (
    <InputGroup className="w-24 max-w-full">
      <InputGroupInput
        id={id}
        aria-label={ariaLabel}
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
      <InputGroupAddon align="inline-end">px</InputGroupAddon>
    </InputGroup>
  );
}

function normalizeAssPatch(
  current: ReturnType<typeof normalizeRecordingAssSettings>,
  patch: Partial<ReturnType<typeof normalizeRecordingAssSettings>>,
) {
  return normalizeRecordingAssSettings({ ...current, ...patch });
}

export function RecordingAssSettingsFields() {
  const settings = useSettingsStore((state) => state.recordingAssSettings);
  const setSettings = useSettingsStore((state) => state.setRecordingAssSettings);
  const [fontDraft, setFontDraft] = useState(settings.font_name);
  const [shieldDraft, setShieldDraft] = useState(settings.shield_rules.join("\n"));
  const skipFontBlurCommit = useRef(false);

  useEffect(() => setFontDraft(settings.font_name), [settings.font_name]);
  useEffect(() => setShieldDraft(settings.shield_rules.join("\n")), [settings.shield_rules]);

  function commitFont() {
    if (skipFontBlurCommit.current) {
      skipFontBlurCommit.current = false;
      return;
    }
    const fontName = normalizeAssPatch(settings, { font_name: fontDraft }).font_name;
    setFontDraft(fontName);
    setSettings({ font_name: fontName });
  }

  function commitShieldRules() {
    const shieldRules = shieldDraft.split(/\r?\n/);
    const normalized = normalizeAssPatch(settings, { shield_rules: shieldRules }).shield_rules;
    setShieldDraft(normalized.join("\n"));
    setSettings({ shield_rules: normalized });
  }

  return (
    <>
      <Field orientation="horizontal">
        <FieldContent>
          <FieldTitle>
            配置选项
            <FieldTip>这些选项只影响之后导出的 ASS 文件，不改变应用内弹幕显示。</FieldTip>
          </FieldTitle>
        </FieldContent>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setSettings(RECORDING_ASS_DEFAULT_SETTINGS)}
        >
          <RotateCcw data-icon="inline-start" />
          恢复默认
        </Button>
      </Field>
      <Field orientation="responsive">
        <FieldContent>
          <FieldTitle>
            <span id="recording-ass-resolution-label">视频分辨率</span>
            <FieldTip>应与录像分辨率一致，播放器会按此画布缩放弹幕坐标。</FieldTip>
          </FieldTitle>
        </FieldContent>
        <div
          className="flex shrink-0 items-center gap-1.5"
          role="group"
          aria-labelledby="recording-ass-resolution-label"
        >
          <CompactNumberInput
            id="recording-ass-resolution-width"
            ariaLabel="ASS 视频分辨率宽度"
            value={settings.resolution_width}
            min={RECORDING_ASS_RESOLUTION_WIDTH_MIN}
            max={RECORDING_ASS_RESOLUTION_WIDTH_MAX}
            normalize={(value) =>
              normalizeAssPatch(settings, { resolution_width: Number(value) }).resolution_width
            }
            onCommit={(resolution_width) => setSettings({ resolution_width })}
          />
          <span className="text-muted-foreground" aria-hidden>
            ×
          </span>
          <CompactNumberInput
            id="recording-ass-resolution-height"
            ariaLabel="ASS 视频分辨率高度"
            value={settings.resolution_height}
            min={RECORDING_ASS_RESOLUTION_HEIGHT_MIN}
            max={RECORDING_ASS_RESOLUTION_HEIGHT_MAX}
            normalize={(value) =>
              normalizeAssPatch(settings, { resolution_height: Number(value) }).resolution_height
            }
            onCommit={(resolution_height) => setSettings({ resolution_height })}
          />
        </div>
      </Field>
      <Field orientation="responsive">
        <FieldContent>
          <FieldTitle>
            <span id="recording-ass-font-label">弹幕字体</span>
            <FieldTip>填写系统已安装的字体名称；外部播放器找不到时会使用字体回退。</FieldTip>
          </FieldTitle>
        </FieldContent>
        <InputGroup className="w-52 max-w-full shrink-0">
          <InputGroupInput
            id="recording-ass-font"
            aria-labelledby="recording-ass-font-label"
            value={fontDraft}
            maxLength={80}
            spellCheck={false}
            onChange={(event) => setFontDraft(event.currentTarget.value)}
            onBlur={commitFont}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") {
                skipFontBlurCommit.current = true;
                setFontDraft(settings.font_name);
                event.currentTarget.blur();
              }
            }}
          />
        </InputGroup>
      </Field>
      <NumberSettingField
        id="recording-ass-font-size"
        title="字体大小"
        description="ASS 画布中的文字像素大小；1080p 推荐 35–45 px。"
        value={settings.font_size}
        min={RECORDING_ASS_FONT_SIZE_MIN}
        max={RECORDING_ASS_FONT_SIZE_MAX}
        unit="px"
        normalize={(value) => normalizeAssPatch(settings, { font_size: Number(value) }).font_size}
        onCommit={(font_size) => setSettings({ font_size })}
      />
      <NumberSettingField
        id="recording-ass-opacity"
        title="不透明度"
        description="0% 完全透明，100% 完全不透明。"
        value={settings.opacity_percent}
        min={0}
        max={100}
        unit="%"
        normalize={(value) =>
          normalizeAssPatch(settings, { opacity_percent: Number(value) }).opacity_percent
        }
        onCommit={(opacity_percent) => setSettings({ opacity_percent })}
      />
      <NumberSettingField
        id="recording-ass-outline"
        title="描边宽度"
        description="描边可增强复杂画面上的文字可读性，推荐 2–3 px。"
        value={settings.outline}
        min={RECORDING_ASS_STYLE_WIDTH_MIN}
        max={RECORDING_ASS_STYLE_WIDTH_MAX}
        step={0.5}
        unit="px"
        normalize={(value) => normalizeAssPatch(settings, { outline: Number(value) }).outline}
        onCommit={(outline) => setSettings({ outline })}
      />
      <NumberSettingField
        id="recording-ass-shadow"
        title="阴影宽度"
        description="为文字增加阴影；设为 0 可关闭。"
        value={settings.shadow}
        min={RECORDING_ASS_STYLE_WIDTH_MIN}
        max={RECORDING_ASS_STYLE_WIDTH_MAX}
        step={0.5}
        unit="px"
        normalize={(value) => normalizeAssPatch(settings, { shadow: Number(value) }).shadow}
        onCommit={(shadow) => setSettings({ shadow })}
      />
      <Field orientation="horizontal">
        <FieldContent>
          <FieldTitle>
            <span id="recording-ass-bold-label">字体加粗</span>
            <FieldTip>在 ASS 样式中使用粗体字重。</FieldTip>
          </FieldTitle>
        </FieldContent>
        <Switch
          aria-labelledby="recording-ass-bold-label"
          className="self-center"
          checked={settings.bold}
          onCheckedChange={(bold) => setSettings({ bold })}
        />
      </Field>
      <NumberSettingField
        id="recording-ass-scroll-duration"
        title="滚动通过时间"
        description="每条滚动弹幕从画面右侧移动到左侧所需的时间。"
        value={settings.scroll_duration_seconds}
        min={RECORDING_ASS_SCROLL_DURATION_SECONDS_MIN}
        max={RECORDING_ASS_SCROLL_DURATION_SECONDS_MAX}
        unit="秒"
        normalize={(value) =>
          normalizeAssPatch(settings, { scroll_duration_seconds: Number(value) })
            .scroll_duration_seconds
        }
        onCommit={(scroll_duration_seconds) => setSettings({ scroll_duration_seconds })}
      />
      <NumberSettingField
        id="recording-ass-display-area"
        title="显示区域"
        description="限制滚动弹幕占用的视频高度比例。"
        value={settings.display_area_percent}
        min={RECORDING_ASS_DISPLAY_AREA_PERCENT_MIN}
        max={RECORDING_ASS_DISPLAY_AREA_PERCENT_MAX}
        unit="%"
        normalize={(value) =>
          normalizeAssPatch(settings, { display_area_percent: Number(value) }).display_area_percent
        }
        onCommit={(display_area_percent) => setSettings({ display_area_percent })}
      />
      <NumberSettingField
        id="recording-ass-merge-window"
        title="重复弹幕合并"
        description="相同聊天在此时间内合并计数，设为 0 可关闭。"
        value={settings.merge_window_seconds}
        min={RECORDING_ASS_MERGE_WINDOW_SECONDS_MIN}
        max={RECORDING_ASS_MERGE_WINDOW_SECONDS_MAX}
        unit="秒"
        normalize={(value) =>
          normalizeAssPatch(settings, { merge_window_seconds: Number(value) }).merge_window_seconds
        }
        onCommit={(merge_window_seconds) => setSettings({ merge_window_seconds })}
      />
      <Field orientation="horizontal">
        <FieldContent>
          <FieldTitle>
            <span id="recording-ass-filter-gifts-label">过滤礼物消息</span>
            <FieldTip>不把礼物消息转换为滚动弹幕。</FieldTip>
          </FieldTitle>
        </FieldContent>
        <Switch
          aria-labelledby="recording-ass-filter-gifts-label"
          className="self-center"
          checked={settings.filter_gifts}
          onCheckedChange={(filter_gifts) => setSettings({ filter_gifts })}
        />
      </Field>
      <Field orientation="horizontal">
        <FieldContent>
          <FieldTitle>
            <span id="recording-ass-super-chat-label">显示醒目留言</span>
            <FieldTip>把醒目留言以带 SC 标记的滚动弹幕导出。</FieldTip>
          </FieldTitle>
        </FieldContent>
        <Switch
          aria-labelledby="recording-ass-super-chat-label"
          className="self-center"
          checked={settings.show_super_chat}
          onCheckedChange={(show_super_chat) => setSettings({ show_super_chat })}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="recording-ass-shield-rules">
          屏蔽关键词
          <FieldTip>每行一条；开启正则表达式后，每一行都会作为独立规则编译。</FieldTip>
        </FieldLabel>
        <Textarea
          id="recording-ass-shield-rules"
          rows={4}
          value={shieldDraft}
          spellCheck={false}
          placeholder="广告&#10;联系方式"
          onChange={(event) => setShieldDraft(event.currentTarget.value)}
          onBlur={commitShieldRules}
        />
        <FieldDescription>最多 100 条，每条最多 200 个字符。</FieldDescription>
      </Field>
      <Field orientation="horizontal">
        <FieldContent>
          <FieldTitle>
            <span id="recording-ass-shield-regex-label">正则表达式匹配</span>
            <FieldTip>开启后，屏蔽关键词中的每一行都按 Rust 正则表达式匹配。</FieldTip>
          </FieldTitle>
        </FieldContent>
        <Switch
          aria-labelledby="recording-ass-shield-regex-label"
          className="self-center"
          checked={settings.shield_regex}
          onCheckedChange={(shield_regex) => setSettings({ shield_regex })}
        />
      </Field>
    </>
  );
}

export function RecordingDefaultsFields() {
  const includeDanmaku = useSettingsStore((state) => state.recordingIncludeDanmaku);
  const continueAfterLeave = useSettingsStore((state) => state.recordingContinueAfterLeave);
  const autoSplitMinutes = useSettingsStore((state) => state.recordingAutoSplitMinutes);
  const setIncludeDanmaku = useSettingsStore((state) => state.setRecordingIncludeDanmaku);
  const setContinueAfterLeave = useSettingsStore((state) => state.setRecordingContinueAfterLeave);
  const setAutoSplitMinutes = useSettingsStore((state) => state.setRecordingAutoSplitMinutes);

  return (
    <>
      <Field orientation="horizontal">
        <FieldContent>
          <FieldTitle>
            <span id="recording-include-danmaku-label">默认录制弹幕</span>
            <FieldTip>直播录制默认创建同步弹幕轨，开始录制前仍可单独调整。</FieldTip>
          </FieldTitle>
        </FieldContent>
        <Switch
          aria-labelledby="recording-include-danmaku-label"
          className="self-center"
          checked={includeDanmaku}
          onCheckedChange={setIncludeDanmaku}
        />
      </Field>
      <Field orientation="horizontal">
        <FieldContent>
          <FieldTitle>
            <span id="recording-continue-after-leave-label">默认后台录制</span>
            <FieldTip>离开直播间或 IPTV 播放页后继续录制，直到手动停止。</FieldTip>
          </FieldTitle>
        </FieldContent>
        <Switch
          aria-labelledby="recording-continue-after-leave-label"
          className="self-center"
          checked={continueAfterLeave}
          onCheckedChange={setContinueAfterLeave}
        />
      </Field>
      <NumberSettingField
        id="recording-auto-split-minutes"
        title="自动分割时长"
        description="达到设定时长后保存当前段并继续录制；设为 0 可关闭。仅适用于 FFmpeg 录制的新任务。"
        value={autoSplitMinutes}
        min={RECORDING_AUTO_SPLIT_MINUTES_MIN}
        max={RECORDING_AUTO_SPLIT_MINUTES_MAX}
        unit="分钟"
        normalize={parseRecordingAutoSplitMinutes}
        onCommit={setAutoSplitMinutes}
      />
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
