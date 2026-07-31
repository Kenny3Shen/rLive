import { memo, useEffect, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
import type { AppSettings } from "@/shared/types/live";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLegend,
  FieldLabel,
  FieldSet,
  FieldTitle,
} from "@/components/ui/field";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import {
  AUTO_DANMAKU_SEND_MAX_INTERVAL_SECONDS,
  AUTO_DANMAKU_SEND_MIN_INTERVAL_SECONDS,
  normalizeAutoDanmakuSendIntervalSeconds,
} from "./danmaku/autoSend";
import type { AutoDanmakuSendController } from "./danmaku/useAutoDanmakuSend";

const FONT_WEIGHTS = [
  { value: 400, label: "常规" },
  { value: 500, label: "中等" },
  { value: 600, label: "加粗" },
  { value: 700, label: "粗体" },
] as const;

export type LocalCaptionSettings = {
  enabled: boolean;
  pending: boolean;
  ready: boolean;
  state: "off" | "starting" | "active" | "error";
  message: string | null;
  fontSize: number;
  onFontSizeChange: (size: number) => void;
};

type DanmakuSliderProps = {
  id: string;
  title: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  displayValue: string;
  onPreview: (value: number) => void;
  onCommit: (value: number) => void;
};

function DanmakuSlider({
  id,
  title,
  value,
  min,
  max,
  step = 1,
  displayValue,
  onPreview,
  onCommit,
}: DanmakuSliderProps) {
  const labelId = `${id}-label`;

  return (
    <Field className="gap-2 rounded-lg bg-muted/35 p-3">
      <FieldTitle id={labelId}>{title}</FieldTitle>
      <div className="flex items-center gap-3">
        <Slider
          aria-labelledby={labelId}
          value={value}
          min={min}
          max={max}
          step={step}
          onValueChange={(next) => onPreview(Number(next))}
          onValueCommitted={(next) => onCommit(Number(next))}
        />
        <Badge variant="secondary" className="min-w-12 justify-center">
          {displayValue}
        </Badge>
      </div>
    </Field>
  );
}

function captionStatusLabel(captions: LocalCaptionSettings): string {
  if (captions.pending || captions.state === "starting") return "准备中";
  if (captions.enabled) return "正在识别";
  if (captions.state === "error") return "需要重试";
  return "已关闭";
}

function LocalCaptionSettingsSection({ captions }: { captions: LocalCaptionSettings }) {
  const statusLabel = captionStatusLabel(captions);

  return (
    <Card size="sm">
      <CardHeader className="border-b">
        <CardTitle>本地字幕</CardTitle>
        <CardAction>
          <Badge variant={captions.state === "error" ? "destructive" : "secondary"}>
            {statusLabel}
          </Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="pt-3">
        <FieldSet>
          <FieldLegend className="sr-only">本地字幕</FieldLegend>
          <FieldGroup>
            <Field className="gap-2 rounded-lg bg-muted/35 p-3">
              <FieldTitle id="room-local-caption-font-size">字幕字号</FieldTitle>
              <div className="flex items-center gap-3">
                <Slider
                  aria-labelledby="room-local-caption-font-size"
                  value={captions.fontSize}
                  min={16}
                  max={36}
                  step={1}
                  onValueChange={(value) => captions.onFontSizeChange(Number(value))}
                />
                <Badge variant="secondary" className="min-w-12 justify-center">
                  {captions.fontSize}px
                </Badge>
              </div>
            </Field>
          </FieldGroup>
        </FieldSet>
      </CardContent>
      {captions.message && (
        <CardFooter>
          <span className="text-xs text-muted-foreground" role="status" aria-live="polite">
            {captions.message}
          </span>
        </CardFooter>
      )}
    </Card>
  );
}

function autoSendStatusLabel(autoSend: AutoDanmakuSendController): string {
  switch (autoSend.phase) {
    case "waiting":
      return "等待中";
    case "sending":
      return "发送中";
    case "paused":
      return "已暂停";
    default:
      return "已关闭";
  }
}

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
        <CardAction>
          <Badge variant={statusIsError ? "destructive" : "secondary"}>
            {autoSendStatusLabel(autoSend)}
          </Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="pt-3">
        <FieldSet>
          <FieldLegend className="sr-only">自动发送弹幕</FieldLegend>
          <FieldGroup className="gap-3">
            <Field data-invalid={autoSend.validationMessage ? true : undefined}>
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
                  aria-invalid={autoSend.validationMessage ? true : undefined}
                  className="resize-y"
                  onChange={(event) => autoSend.onTextChange(event.target.value)}
                />
                {autoSend.validationMessage && (
                  <FieldError>{autoSend.validationMessage}</FieldError>
                )}
              </FieldContent>
            </Field>

            <Field>
              <div className="flex items-center justify-between gap-2">
                <FieldLabel htmlFor="room-auto-danmaku-interval">发送间隔</FieldLabel>
                <Badge variant="outline">
                  {AUTO_DANMAKU_SEND_MIN_INTERVAL_SECONDS}–{AUTO_DANMAKU_SEND_MAX_INTERVAL_SECONDS}{" "}
                  秒
                </Badge>
              </div>
              <FieldContent>
                <InputGroup className="max-w-40">
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
              </FieldContent>
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

function normalizeShieldWords(value: string): string[] {
  const seen = new Set<string>();
  return value
    .split(/\r?\n|,/)
    .map((word) => word.trim())
    .filter((word) => {
      // Keep de-duplication consistent with the high-frequency matcher.
      const key = word.toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function sameWords(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((word, index) => word === right[index]);
}

/**
 * Room-local Simple Live-style danmaku controls. Slider movement updates the
 * Zustand store immediately; persistence happens once the thumb is released.
 */
export const DanmakuSettingsPanel = memo(function DanmakuSettingsPanel({
  className,
  captions,
  autoSend,
}: {
  className?: string;
  captions?: LocalCaptionSettings;
  autoSend?: AutoDanmakuSendController;
}) {
  const opacity = useSettingsStore((s) => s.danmakuOpacity);
  const fontSize = useSettingsStore((s) => s.danmakuFontSize);
  const speed = useSettingsStore((s) => s.danmakuSpeed);
  const area = useSettingsStore((s) => s.danmakuArea);
  const lineCount = useSettingsStore((s) => s.danmakuLineCount);
  const fontWeight = useSettingsStore((s) => s.danmakuFontWeight);
  const filterRepeats = useSettingsStore((s) => s.danmakuFilterRepeats);
  const filterGifts = useSettingsStore((s) => s.danmakuFilterGifts);
  const shieldWords = useSettingsStore((s) => s.danmakuShieldWords);
  const [shieldDraft, setShieldDraft] = useState(shieldWords.join("\n"));
  const [shieldStatus, setShieldStatus] = useState<string | null>(null);
  const shieldSaveTimerRef = useRef<number | null>(null);
  const pendingShieldWordsRef = useRef(shieldWords);

  useEffect(() => {
    // Keep externally imported/profile-updated values in sync without
    // rewriting the user's current textarea format while they are typing.
    if (!sameWords(normalizeShieldWords(shieldDraft), shieldWords)) {
      // This is an external replacement rather than the local normalized
      // value we just wrote. Do not let its older debounce overwrite it.
      if (shieldSaveTimerRef.current !== null) {
        window.clearTimeout(shieldSaveTimerRef.current);
        shieldSaveTimerRef.current = null;
        setShieldStatus(null);
      }
      setShieldDraft(shieldWords.join("\n"));
    }
    pendingShieldWordsRef.current = shieldWords;
  }, [shieldDraft, shieldWords]);

  useEffect(
    () => () => {
      if (shieldSaveTimerRef.current !== null) {
        window.clearTimeout(shieldSaveTimerRef.current);
        shieldSaveTimerRef.current = null;
        void useSettingsStore
          .getState()
          .persistToBackend({ danmaku_shield_words: pendingShieldWordsRef.current });
      }
    },
    [],
  );

  function preview(patch: {
    danmakuOpacity?: number;
    danmakuFontSize?: number;
    danmakuSpeed?: number;
    danmakuArea?: number;
    danmakuLineCount?: number;
    danmakuFontWeight?: number;
    danmakuFilterRepeats?: boolean;
    danmakuFilterGifts?: boolean;
  }) {
    useSettingsStore.setState(patch);
  }

  function persist(patch: Partial<AppSettings>) {
    void useSettingsStore.getState().persistToBackend(patch);
  }

  function updateShieldWords(value: string) {
    const words = normalizeShieldWords(value);
    setShieldDraft(value);
    useSettingsStore.setState({ danmakuShieldWords: words });
    pendingShieldWordsRef.current = words;
    setShieldStatus("新的消息会立即按此过滤，正在保存…");

    if (shieldSaveTimerRef.current !== null) {
      window.clearTimeout(shieldSaveTimerRef.current);
    }
    shieldSaveTimerRef.current = window.setTimeout(() => {
      shieldSaveTimerRef.current = null;
      // A profile import can update the store while this debounce is pending.
      // Persist the latest value rather than allowing an older closure to
      // overwrite it after the user has already moved on.
      persist({ danmaku_shield_words: pendingShieldWordsRef.current });
      setShieldStatus("已自动保存，新的消息会立即按此过滤");
    }, 350);
  }

  function resetAppearance() {
    const defaults = {
      danmakuOpacity: 1,
      danmakuFontSize: 18,
      danmakuSpeed: 8,
      danmakuArea: 0.9,
      danmakuLineCount: 0,
      danmakuFontWeight: 600,
      danmakuFilterRepeats: true,
      danmakuFilterGifts: false,
    };
    preview(defaults);
    persist({
      danmaku_opacity: defaults.danmakuOpacity,
      danmaku_font_size: defaults.danmakuFontSize,
      danmaku_speed: defaults.danmakuSpeed,
      danmaku_area: defaults.danmakuArea,
      danmaku_line_count: defaults.danmakuLineCount,
      danmaku_font_weight: defaults.danmakuFontWeight,
      danmaku_filter_repeats: defaults.danmakuFilterRepeats,
      danmaku_filter_gifts: defaults.danmakuFilterGifts,
    });
  }

  const trackSummary = `${Math.round(area * 100)}% · ${lineCount === 0 ? "自动" : `${lineCount} 行`}`;
  const appearanceSummary = `${fontSize}px · ${speed}/10`;
  const activeFilterCount = Number(filterRepeats) + Number(filterGifts);
  const filterSummary =
    shieldWords.length > 0
      ? `${activeFilterCount} 项开启 · ${shieldWords.length} 词`
      : activeFilterCount > 0
        ? `${activeFilterCount} 项开启`
        : "未开启";

  return (
    <ScrollArea className={cn("min-h-0 flex-1", className)}>
      <div className="flex flex-col gap-3 px-3 py-3">
        {captions && <LocalCaptionSettingsSection captions={captions} />}
        {autoSend && <AutoDanmakuSendSection autoSend={autoSend} />}

        <Card size="sm">
          <CardHeader className="border-b">
            <CardTitle>弹幕轨道</CardTitle>
            <CardAction>
              <Badge variant="outline">{trackSummary}</Badge>
            </CardAction>
          </CardHeader>
          <CardContent className="pt-3">
            <FieldGroup className="gap-2">
              <DanmakuSlider
                id="room-danmaku-area"
                title="显示区域"
                value={Math.round(area * 100)}
                min={10}
                max={100}
                step={5}
                displayValue={`${Math.round(area * 100)}%`}
                onPreview={(value) => preview({ danmakuArea: value / 100 })}
                onCommit={(value) => persist({ danmaku_area: value / 100 })}
              />
              <DanmakuSlider
                id="room-danmaku-lines"
                title="显示行数"
                value={lineCount}
                min={0}
                max={20}
                displayValue={lineCount === 0 ? "自动" : `${lineCount} 行`}
                onPreview={(value) => preview({ danmakuLineCount: value })}
                onCommit={(value) => persist({ danmaku_line_count: value })}
              />
            </FieldGroup>
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader className="border-b">
            <CardTitle>文字与节奏</CardTitle>
            <CardAction>
              <Badge variant="outline">{appearanceSummary}</Badge>
            </CardAction>
          </CardHeader>
          <CardContent className="pt-3">
            <FieldGroup className="gap-2">
              <DanmakuSlider
                id="room-danmaku-opacity"
                title="不透明度"
                value={Math.round(opacity * 100)}
                min={0}
                max={100}
                displayValue={`${Math.round(opacity * 100)}%`}
                onPreview={(value) => preview({ danmakuOpacity: value / 100 })}
                onCommit={(value) => persist({ danmaku_opacity: value / 100 })}
              />
              <DanmakuSlider
                id="room-danmaku-font-size"
                title="字号"
                value={fontSize}
                min={12}
                max={36}
                displayValue={`${fontSize}px`}
                onPreview={(value) => preview({ danmakuFontSize: value })}
                onCommit={(value) => persist({ danmaku_font_size: value })}
              />
              <DanmakuSlider
                id="room-danmaku-speed"
                title="滚动速度"
                value={speed}
                min={1}
                max={10}
                displayValue={`${speed} / 10`}
                onPreview={(value) => preview({ danmakuSpeed: value })}
                onCommit={(value) => persist({ danmaku_speed: value })}
              />
              <Field className="gap-2 rounded-lg bg-muted/35 p-3">
                <FieldTitle id="room-danmaku-font-weight">字重</FieldTitle>
                <ToggleGroup
                  aria-labelledby="room-danmaku-font-weight"
                  value={[String(fontWeight)]}
                  variant="outline"
                  size="sm"
                  spacing={1}
                  onValueChange={(values) => {
                    const next = Number(values[0]);
                    if (!FONT_WEIGHTS.some((option) => option.value === next)) return;
                    preview({ danmakuFontWeight: next });
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
            </FieldGroup>
          </CardContent>
          <CardFooter className="justify-end">
            <Button type="button" variant="outline" size="sm" onClick={resetAppearance}>
              <RotateCcw data-icon="inline-start" aria-hidden />
              恢复默认
            </Button>
          </CardFooter>
        </Card>

        <Card size="sm">
          <CardHeader className="border-b">
            <CardTitle>消息过滤</CardTitle>
            <CardAction>
              <Badge
                variant={activeFilterCount > 0 || shieldWords.length > 0 ? "secondary" : "outline"}
              >
                {filterSummary}
              </Badge>
            </CardAction>
          </CardHeader>
          <CardContent className="pt-3">
            <FieldGroup className="gap-2">
              <Field orientation="horizontal" className="rounded-lg bg-muted/35 p-3">
                <FieldTitle id="room-danmaku-repeat-filter">合并重复消息</FieldTitle>
                <Switch
                  aria-labelledby="room-danmaku-repeat-filter"
                  checked={filterRepeats}
                  onCheckedChange={(checked) => {
                    preview({ danmakuFilterRepeats: checked });
                    persist({ danmaku_filter_repeats: checked });
                  }}
                />
              </Field>
              <Field orientation="horizontal" className="rounded-lg bg-muted/35 p-3">
                <FieldTitle id="room-danmaku-gift-filter">隐藏礼物消息</FieldTitle>
                <Switch
                  aria-labelledby="room-danmaku-gift-filter"
                  checked={filterGifts}
                  onCheckedChange={(checked) => {
                    preview({ danmakuFilterGifts: checked });
                    persist({ danmaku_filter_gifts: checked });
                  }}
                />
              </Field>
              <Field className="rounded-lg bg-muted/35 p-3">
                <FieldLabel htmlFor="room-danmaku-shield-words">屏蔽词</FieldLabel>
                <FieldContent>
                  <Textarea
                    id="room-danmaku-shield-words"
                    value={shieldDraft}
                    onChange={(event) => {
                      updateShieldWords(event.target.value);
                    }}
                    rows={4}
                    placeholder="每行一个词，也可用逗号分隔"
                    className="resize-y"
                  />
                  {shieldStatus && (
                    <FieldDescription role="status">{shieldStatus}</FieldDescription>
                  )}
                </FieldContent>
              </Field>
            </FieldGroup>
          </CardContent>
        </Card>
      </div>
    </ScrollArea>
  );
});
