import { useEffect, useRef, useState } from "react";
import type { AppSettings } from "@/shared/types/live";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLegend,
  FieldLabel,
  FieldSet,
  FieldTitle,
} from "@/components/ui/field";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";

const FONT_WEIGHTS = [
  { value: 400, label: "常规" },
  { value: 500, label: "中等" },
  { value: 600, label: "加粗" },
  { value: 700, label: "粗体" },
] as const;

type DanmakuSliderProps = {
  id: string;
  title: string;
  description: string;
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
  description,
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
    <Field>
      <FieldContent>
        <FieldTitle id={labelId}>{title}</FieldTitle>
        <FieldDescription>{description}</FieldDescription>
      </FieldContent>
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
export function DanmakuSettingsPanel({ className }: { className?: string }) {
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

  return (
    <ScrollArea className={cn("min-h-0 flex-1", className)}>
      <div className="flex flex-col gap-5 px-3 py-3">
        <FieldSet>
          <FieldGroup className="gap-4">
            <DanmakuSlider
              id="room-danmaku-area"
              title="显示区域"
              description="限制飘屏可使用的视频高度。"
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
              description="自动会按窗口高度安排轨道；可固定为 1–20 行。"
              value={lineCount}
              min={0}
              max={20}
              displayValue={lineCount === 0 ? "自动" : `${lineCount} 行`}
              onPreview={(value) => preview({ danmakuLineCount: value })}
              onCommit={(value) => persist({ danmaku_line_count: value })}
            />
            <DanmakuSlider
              id="room-danmaku-opacity"
              title="不透明度"
              description="控制飘屏文字的透明程度。"
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
              description="影响飘屏与右侧消息列表的基础大小。"
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
              description="数值越高，弹幕越快穿过画面。"
              value={speed}
              min={1}
              max={10}
              displayValue={`${speed} / 10`}
              onPreview={(value) => preview({ danmakuSpeed: value })}
              onCommit={(value) => persist({ danmaku_speed: value })}
            />
            <Field>
              <FieldContent>
                <FieldTitle id="room-danmaku-font-weight">字重</FieldTitle>
                <FieldDescription>提高对亮色画面的可读性。</FieldDescription>
              </FieldContent>
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
            <Field orientation="horizontal">
              <FieldContent>
                <FieldTitle id="room-danmaku-repeat-filter">重复过滤</FieldTitle>
                <FieldDescription>隐藏短时间内同一用户重复发送的聊天消息。</FieldDescription>
              </FieldContent>
              <Switch
                aria-labelledby="room-danmaku-repeat-filter"
                checked={filterRepeats}
                onCheckedChange={(checked) => {
                  preview({ danmakuFilterRepeats: checked });
                  persist({ danmaku_filter_repeats: checked });
                }}
              />
            </Field>
          </FieldGroup>
        </FieldSet>

        <FieldSet>
          <FieldLegend variant="label">弹幕过滤</FieldLegend>
          <FieldDescription>
            “进入直播间”等进场提示默认隐藏；屏蔽词对聊天、SC 与飘屏生效。
          </FieldDescription>
          <FieldGroup className="gap-3">
            <Field orientation="horizontal">
              <FieldContent>
                <FieldTitle id="room-danmaku-gift-filter">屏蔽礼物消息</FieldTitle>
                <FieldDescription>隐藏斗鱼等平台的礼物通知，不影响 SC。</FieldDescription>
              </FieldContent>
              <Switch
                aria-labelledby="room-danmaku-gift-filter"
                checked={filterGifts}
                onCheckedChange={(checked) => {
                  preview({ danmakuFilterGifts: checked });
                  persist({ danmaku_filter_gifts: checked });
                }}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="room-danmaku-shield-words">屏蔽词</FieldLabel>
              <FieldContent>
                <Textarea
                  id="room-danmaku-shield-words"
                  value={shieldDraft}
                  onChange={(event) => {
                    updateShieldWords(event.target.value);
                  }}
                  rows={5}
                  placeholder="每行一个词，也可用逗号分隔"
                  className="resize-y"
                />
                {shieldStatus && <FieldDescription>{shieldStatus}</FieldDescription>}
              </FieldContent>
            </Field>
          </FieldGroup>
        </FieldSet>

        <Button variant="outline" size="sm" onClick={resetAppearance}>
          恢复默认显示
        </Button>
      </div>
    </ScrollArea>
  );
}
