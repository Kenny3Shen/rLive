import { useEffect, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
import type { AppSettings } from "@/shared/types/live";
import {
  DANMAKU_MERGE_WINDOW_SECONDS_DEFAULT,
  DANMAKU_MERGE_WINDOW_SECONDS_MAX,
  DANMAKU_MERGE_WINDOW_SECONDS_MIN,
  parseDanmakuMergeWindowSeconds,
  useSettingsStore,
} from "@/shared/stores/settingsStore";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldTitle,
} from "@/components/ui/field";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";

export type PlaybackSettingsFieldLayout = "page" | "panel";

const FONT_WEIGHTS = [
  { value: 400, label: "常规" },
  { value: 500, label: "中等" },
  { value: 600, label: "加粗" },
  { value: 700, label: "粗体" },
] as const;

const ASR_FONT_SIZE_MIN = 12;
const ASR_FONT_SIZE_MAX = 48;
const ASR_CHUNK_SECONDS_MIN = 0.2;
const ASR_CHUNK_SECONDS_MAX = 1;

const DANMAKU_APPEARANCE_DEFAULTS = {
  danmakuOpacity: 1,
  danmakuFontSize: 18,
  danmakuSpeed: 8,
  danmakuArea: 0.9,
  danmakuLineCount: 0,
  danmakuFontWeight: 600,
  danmakuFilterRepeats: true,
  danmakuFilterGifts: true,
  danmakuMergeWindowSeconds: DANMAKU_MERGE_WINDOW_SECONDS_DEFAULT,
  superChatOpacity: 1,
};

type PreferenceSliderFieldProps = {
  id: string;
  title: string;
  description?: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  displayValue: string;
  layout: PlaybackSettingsFieldLayout;
  disabled?: boolean;
  onPreview: (value: number) => void;
  onCommit: (value: number) => void;
};

function fieldSurfaceClass(layout: PlaybackSettingsFieldLayout): string | undefined {
  return layout === "panel" ? "gap-2 rounded-lg bg-muted/35 p-3" : undefined;
}

function PreferenceSliderField({
  id,
  title,
  description,
  value,
  min,
  max,
  step = 1,
  displayValue,
  layout,
  disabled = false,
  onPreview,
  onCommit,
}: PreferenceSliderFieldProps) {
  const labelId = `${id}-label`;

  return (
    <Field
      orientation={layout === "page" ? "responsive" : "vertical"}
      data-disabled={disabled || undefined}
      className={fieldSurfaceClass(layout)}
    >
      <FieldContent>
        <FieldTitle id={labelId}>{title}</FieldTitle>
        {description && <FieldDescription>{description}</FieldDescription>}
      </FieldContent>
      <div className={cn("flex items-center gap-3", layout === "page" && "min-w-52")}>
        <Slider
          aria-labelledby={labelId}
          value={value}
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          onValueChange={(next) => {
            const numeric = Number(next);
            if (Number.isFinite(numeric)) onPreview(numeric);
          }}
          onValueCommitted={(next) => {
            const numeric = Number(next);
            if (Number.isFinite(numeric)) onCommit(numeric);
          }}
        />
        <Badge variant="secondary" className="min-w-14 justify-center tabular-nums">
          {displayValue}
        </Badge>
      </div>
    </Field>
  );
}

function persist(patch: Partial<AppSettings>) {
  void useSettingsStore.getState().persistToBackend(patch);
}

function normalizeShieldWords(value: string): string[] {
  const seen = new Set<string>();
  return value
    .split(/\r?\n|,/)
    .map((word) => word.trim())
    .filter((word) => {
      const key = word.toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function sameWords(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((word, index) => word === right[index]);
}

function useShieldWordsDraft() {
  const shieldWords = useSettingsStore((state) => state.danmakuShieldWords);
  const [draft, setDraft] = useState(shieldWords.join("\n"));
  const [status, setStatus] = useState<string | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const pendingWordsRef = useRef(shieldWords);

  useEffect(() => {
    if (!sameWords(normalizeShieldWords(draft), shieldWords)) {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
        setStatus(null);
      }
      setDraft(shieldWords.join("\n"));
    }
    pendingWordsRef.current = shieldWords;
  }, [draft, shieldWords]);

  useEffect(
    () => () => {
      if (saveTimerRef.current === null) return;
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
      persist({ danmaku_shield_words: pendingWordsRef.current });
    },
    [],
  );

  function update(value: string) {
    const words = normalizeShieldWords(value);
    setDraft(value);
    useSettingsStore.setState({ danmakuShieldWords: words });
    pendingWordsRef.current = words;
    setStatus("新的消息会立即按此过滤，正在保存…");

    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      persist({ danmaku_shield_words: pendingWordsRef.current });
      setStatus("已自动保存，新的消息会立即按此过滤");
    }, 350);
  }

  return { draft, shieldWords, status, update };
}

export function AsrCaptionFontSizeField({
  idPrefix,
  layout,
}: {
  idPrefix: string;
  layout: PlaybackSettingsFieldLayout;
}) {
  const fontSize = useSettingsStore((state) => state.asrFontSize);

  return (
    <PreferenceSliderField
      id={`${idPrefix}-asr-font-size`}
      title="字幕字号"
      description={layout === "page" ? "调整播放器字幕叠加层的字号，不影响弹幕字号。" : undefined}
      value={fontSize}
      min={ASR_FONT_SIZE_MIN}
      max={ASR_FONT_SIZE_MAX}
      displayValue={`${fontSize}px`}
      layout={layout}
      onPreview={(value) => useSettingsStore.setState({ asrFontSize: Math.round(value) })}
      onCommit={(value) => {
        const next = Math.min(ASR_FONT_SIZE_MAX, Math.max(ASR_FONT_SIZE_MIN, Math.round(value)));
        useSettingsStore.setState({ asrFontSize: next });
        persist({ asr_font_size: next });
      }}
    />
  );
}

export function AsrChunkIntervalField({
  idPrefix,
  layout,
  disabled = false,
}: {
  idPrefix: string;
  layout: PlaybackSettingsFieldLayout;
  disabled?: boolean;
}) {
  const chunkSeconds = useSettingsStore((state) => state.asrWindowSeconds);
  const setChunkSeconds = useSettingsStore((state) => state.setAsrWindowSeconds);
  const [draft, setDraft] = useState(chunkSeconds);

  useEffect(() => setDraft(chunkSeconds), [chunkSeconds]);

  return (
    <PreferenceSliderField
      id={`${idPrefix}-asr-chunk-interval`}
      title="字幕更新间隔"
      description={
        layout === "page"
          ? "Zipformer 会持续保留识别上下文；间隔越短，实时字幕刷新越快。"
          : undefined
      }
      value={draft}
      min={ASR_CHUNK_SECONDS_MIN}
      max={ASR_CHUNK_SECONDS_MAX}
      step={0.1}
      displayValue={`${Number.isInteger(draft) ? draft : draft.toFixed(1)}s`}
      layout={layout}
      disabled={disabled}
      onPreview={setDraft}
      onCommit={(value) => {
        setDraft(value);
        void setChunkSeconds(value);
      }}
    />
  );
}

export function SuperChatSettingsFields({
  idPrefix,
  layout,
}: {
  idPrefix: string;
  layout: PlaybackSettingsFieldLayout;
}) {
  const enabled = useSettingsStore((state) => state.superChatEnabled);
  const opacity = useSettingsStore((state) => state.superChatOpacity);
  const setEnabled = useSettingsStore((state) => state.setSuperChatEnabled);
  const enabledLabelId = `${idPrefix}-super-chat-enabled-label`;

  return (
    <>
      <Field
        orientation={layout === "page" ? "responsive" : "horizontal"}
        className={fieldSurfaceClass(layout)}
      >
        <FieldContent>
          <FieldTitle id={enabledLabelId}>显示 SC 卡片</FieldTitle>
          {layout === "page" && (
            <FieldDescription>在支持的平台上将醒目留言显示在播放器上方。</FieldDescription>
          )}
        </FieldContent>
        <Switch aria-labelledby={enabledLabelId} checked={enabled} onCheckedChange={setEnabled} />
      </Field>
      <PreferenceSliderField
        id={`${idPrefix}-super-chat-opacity`}
        title="SC 透明度"
        value={Math.round(opacity * 100)}
        min={0}
        max={100}
        step={5}
        displayValue={`${Math.round(opacity * 100)}%`}
        layout={layout}
        onPreview={(value) => useSettingsStore.setState({ superChatOpacity: value / 100 })}
        onCommit={(value) => persist({ super_chat_opacity: value / 100 })}
      />
    </>
  );
}

export function DanmakuTrackSettingsFields({
  idPrefix,
  layout,
}: {
  idPrefix: string;
  layout: PlaybackSettingsFieldLayout;
}) {
  const area = useSettingsStore((state) => state.danmakuArea);
  const lineCount = useSettingsStore((state) => state.danmakuLineCount);

  return (
    <>
      <PreferenceSliderField
        id={`${idPrefix}-danmaku-area`}
        title="显示区域"
        description={layout === "page" ? "限制滚动弹幕占用的播放器高度。" : undefined}
        value={Math.round(area * 100)}
        min={10}
        max={100}
        step={5}
        displayValue={`${Math.round(area * 100)}%`}
        layout={layout}
        onPreview={(value) => useSettingsStore.setState({ danmakuArea: value / 100 })}
        onCommit={(value) => persist({ danmaku_area: value / 100 })}
      />
      <PreferenceSliderField
        id={`${idPrefix}-danmaku-lines`}
        title="显示行数"
        description={layout === "page" ? "设为自动时根据播放器高度计算可用轨道。" : undefined}
        value={lineCount}
        min={0}
        max={20}
        displayValue={lineCount === 0 ? "自动" : `${lineCount} 行`}
        layout={layout}
        onPreview={(value) => useSettingsStore.setState({ danmakuLineCount: value })}
        onCommit={(value) => persist({ danmaku_line_count: value })}
      />
    </>
  );
}

export function DanmakuAppearanceSettingsFields({
  idPrefix,
  layout,
}: {
  idPrefix: string;
  layout: PlaybackSettingsFieldLayout;
}) {
  const opacity = useSettingsStore((state) => state.danmakuOpacity);
  const fontSize = useSettingsStore((state) => state.danmakuFontSize);
  const speed = useSettingsStore((state) => state.danmakuSpeed);
  const fontWeight = useSettingsStore((state) => state.danmakuFontWeight);
  const weightLabelId = `${idPrefix}-danmaku-font-weight-label`;

  return (
    <>
      <PreferenceSliderField
        id={`${idPrefix}-danmaku-opacity`}
        title="不透明度"
        value={Math.round(opacity * 100)}
        min={0}
        max={100}
        displayValue={`${Math.round(opacity * 100)}%`}
        layout={layout}
        onPreview={(value) => useSettingsStore.setState({ danmakuOpacity: value / 100 })}
        onCommit={(value) => persist({ danmaku_opacity: value / 100 })}
      />
      <PreferenceSliderField
        id={`${idPrefix}-danmaku-font-size`}
        title="字号"
        value={fontSize}
        min={12}
        max={36}
        displayValue={`${fontSize}px`}
        layout={layout}
        onPreview={(value) => useSettingsStore.setState({ danmakuFontSize: value })}
        onCommit={(value) => persist({ danmaku_font_size: value })}
      />
      <PreferenceSliderField
        id={`${idPrefix}-danmaku-speed`}
        title="滚动速度"
        value={speed}
        min={1}
        max={10}
        displayValue={`${speed} / 10`}
        layout={layout}
        onPreview={(value) => useSettingsStore.setState({ danmakuSpeed: value })}
        onCommit={(value) => persist({ danmaku_speed: value })}
      />
      <Field
        orientation={layout === "page" ? "responsive" : "vertical"}
        className={fieldSurfaceClass(layout)}
      >
        <FieldContent>
          <FieldTitle id={weightLabelId}>字重</FieldTitle>
        </FieldContent>
        <ToggleGroup
          aria-labelledby={weightLabelId}
          value={[String(fontWeight)]}
          variant="outline"
          size="sm"
          spacing={1}
          className="max-w-full flex-wrap"
          onValueChange={(values) => {
            const next = Number(values[0]);
            if (!FONT_WEIGHTS.some((option) => option.value === next)) return;
            useSettingsStore.setState({ danmakuFontWeight: next });
            persist({ danmaku_font_weight: next });
          }}
        >
          {FONT_WEIGHTS.map((option) => (
            <ToggleGroupItem key={option.value} value={String(option.value)}>
              {option.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </Field>
    </>
  );
}

export function DanmakuAppearanceResetButton() {
  function reset() {
    useSettingsStore.setState(DANMAKU_APPEARANCE_DEFAULTS);
    persist({
      danmaku_opacity: DANMAKU_APPEARANCE_DEFAULTS.danmakuOpacity,
      danmaku_font_size: DANMAKU_APPEARANCE_DEFAULTS.danmakuFontSize,
      danmaku_speed: DANMAKU_APPEARANCE_DEFAULTS.danmakuSpeed,
      danmaku_area: DANMAKU_APPEARANCE_DEFAULTS.danmakuArea,
      danmaku_line_count: DANMAKU_APPEARANCE_DEFAULTS.danmakuLineCount,
      danmaku_font_weight: DANMAKU_APPEARANCE_DEFAULTS.danmakuFontWeight,
      danmaku_filter_repeats: DANMAKU_APPEARANCE_DEFAULTS.danmakuFilterRepeats,
      danmaku_filter_gifts: DANMAKU_APPEARANCE_DEFAULTS.danmakuFilterGifts,
      danmaku_merge_window_seconds: DANMAKU_APPEARANCE_DEFAULTS.danmakuMergeWindowSeconds,
      super_chat_opacity: DANMAKU_APPEARANCE_DEFAULTS.superChatOpacity,
    });
  }

  return (
    <Button type="button" variant="outline" size="sm" onClick={reset}>
      <RotateCcw data-icon="inline-start" aria-hidden />
      恢复默认
    </Button>
  );
}

export function DanmakuFilterSettingsFields({
  idPrefix,
  layout,
}: {
  idPrefix: string;
  layout: PlaybackSettingsFieldLayout;
}) {
  const filterRepeats = useSettingsStore((state) => state.danmakuFilterRepeats);
  const filterGifts = useSettingsStore((state) => state.danmakuFilterGifts);
  const mergeWindowSeconds = useSettingsStore((state) => state.danmakuMergeWindowSeconds);
  const shield = useShieldWordsDraft();
  const repeatLabelId = `${idPrefix}-danmaku-repeat-filter-label`;
  const giftLabelId = `${idPrefix}-danmaku-gift-filter-label`;
  const shieldInputId = `${idPrefix}-danmaku-shield-words`;

  return (
    <>
      <Field
        orientation={layout === "page" ? "responsive" : "horizontal"}
        className={fieldSurfaceClass(layout)}
      >
        <FieldContent>
          <FieldTitle id={repeatLabelId}>合并重复消息</FieldTitle>
          {layout === "page" && (
            <FieldDescription>减少短时间内连续出现的相同弹幕。</FieldDescription>
          )}
        </FieldContent>
        <Switch
          aria-labelledby={repeatLabelId}
          checked={filterRepeats}
          onCheckedChange={(checked) => {
            useSettingsStore.setState({ danmakuFilterRepeats: checked });
            persist({ danmaku_filter_repeats: checked });
          }}
        />
      </Field>
      <PreferenceSliderField
        id={`${idPrefix}-danmaku-merge-window`}
        title="合并窗口"
        description={layout === "page" ? "在此时间内再次出现的相同弹幕会合并计数。" : undefined}
        value={mergeWindowSeconds}
        min={DANMAKU_MERGE_WINDOW_SECONDS_MIN}
        max={DANMAKU_MERGE_WINDOW_SECONDS_MAX}
        displayValue={`${mergeWindowSeconds} 秒`}
        layout={layout}
        disabled={!filterRepeats}
        onPreview={(value) =>
          useSettingsStore.setState({
            danmakuMergeWindowSeconds: parseDanmakuMergeWindowSeconds(value),
          })
        }
        onCommit={(value) => {
          const next = parseDanmakuMergeWindowSeconds(value);
          useSettingsStore.setState({ danmakuMergeWindowSeconds: next });
          persist({ danmaku_merge_window_seconds: next });
        }}
      />
      <Field
        orientation={layout === "page" ? "responsive" : "horizontal"}
        className={fieldSurfaceClass(layout)}
      >
        <FieldContent>
          <FieldTitle id={giftLabelId}>隐藏礼物信息</FieldTitle>
          {layout === "page" && (
            <FieldDescription>从弹幕列表和播放器叠加层中隐藏礼物消息。</FieldDescription>
          )}
        </FieldContent>
        <Switch
          aria-labelledby={giftLabelId}
          checked={filterGifts}
          onCheckedChange={(checked) => {
            useSettingsStore.setState({ danmakuFilterGifts: checked });
            persist({ danmaku_filter_gifts: checked });
          }}
        />
      </Field>
      <Field className={fieldSurfaceClass(layout)}>
        <FieldLabel htmlFor={shieldInputId}>屏蔽词</FieldLabel>
        <FieldContent>
          <Textarea
            id={shieldInputId}
            value={shield.draft}
            onChange={(event) => shield.update(event.target.value)}
            rows={layout === "page" ? 5 : 4}
            placeholder="每行一个词，也可用逗号分隔"
            className="resize-y"
          />
          {shield.status && <FieldDescription role="status">{shield.status}</FieldDescription>}
        </FieldContent>
      </Field>
    </>
  );
}
