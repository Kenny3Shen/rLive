import { memo, useEffect, useRef, useState } from "react";
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
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
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

export type LocalCaptionSettings = {
  enabled: boolean;
  pending: boolean;
  ready: boolean;
  state: "off" | "starting" | "active" | "error";
  message: string | null;
  modelPath: string | null;
  fontSize: number;
  onModelPathChange: (path: string | null) => void;
  onFontSizeChange: (size: number) => void;
};

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

function captionStatusLabel(captions: LocalCaptionSettings): string {
  if (captions.pending || captions.state === "starting") return "准备中";
  if (captions.enabled) return "正在识别";
  if (captions.state === "error") return "需要重试";
  return "已关闭";
}

function captionStatusDescription(captions: LocalCaptionSettings): string {
  if (captions.message) return captions.message;
  if (captions.pending || captions.state === "starting") {
    return "正在加载模型并连接播放器音频。";
  }
  if (captions.enabled) return "正在通过本机 CPU 实时识别直播声音。";
  if (!captions.ready) return "等待直播声音就绪后，可从播放器底栏开启。";
  return "功能默认关闭；从播放器底栏的字幕按钮开启。";
}

function LocalCaptionSettingsSection({ captions }: { captions: LocalCaptionSettings }) {
  const [modelDraft, setModelDraft] = useState(captions.modelPath ?? "");
  const statusLabel = captionStatusLabel(captions);
  const statusDescription = captionStatusDescription(captions);

  useEffect(() => {
    setModelDraft(captions.modelPath ?? "");
  }, [captions.modelPath]);

  return (
    <FieldSet>
      <FieldLegend variant="label">本地字幕</FieldLegend>
      <FieldDescription>
        Whisper 在本机 CPU 上实时识别直播声音，不会上传音频；自动识别语言，中文字幕以简体显示。
      </FieldDescription>
      <FieldGroup className="gap-3">
        <Field orientation="horizontal">
          <FieldContent>
            <FieldTitle>运行状态</FieldTitle>
            <FieldDescription>{statusDescription}</FieldDescription>
          </FieldContent>
          <Badge variant={captions.state === "error" ? "destructive" : "secondary"}>
            {statusLabel}
          </Badge>
        </Field>

        <Field orientation="horizontal">
          <FieldContent>
            <FieldTitle>识别模型</FieldTitle>
            <FieldDescription>
              {captions.modelPath
                ? "已选择自定义 GGML .bin 模型。"
                : "使用应用内置的 Whisper tiny Q5_1 多语言模型。"}
            </FieldDescription>
          </FieldContent>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!captions.modelPath && !modelDraft.trim()}
            onClick={() => {
              setModelDraft("");
              captions.onModelPathChange(null);
            }}
          >
            使用内置模型
          </Button>
        </Field>

        <Field>
          <FieldLabel htmlFor="room-local-caption-model-path">自定义模型路径</FieldLabel>
          <FieldContent>
            <form
              className="w-full"
              onSubmit={(event) => {
                event.preventDefault();
                captions.onModelPathChange(modelDraft);
              }}
            >
              <InputGroup>
                <InputGroupInput
                  id="room-local-caption-model-path"
                  value={modelDraft}
                  onChange={(event) => setModelDraft(event.target.value)}
                  placeholder="D:\\models\\ggml-base.bin"
                  spellCheck={false}
                  autoComplete="off"
                />
                <InputGroupAddon align="inline-end">
                  <InputGroupButton type="submit" variant="secondary" size="sm">
                    保存
                  </InputGroupButton>
                </InputGroupAddon>
              </InputGroup>
            </form>
            <FieldDescription>
              仅支持 GGML `.bin`
              文件。保存后会在下次开启字幕时加载；若正在识别，请先关闭再开启字幕。
            </FieldDescription>
          </FieldContent>
        </Field>

        <Field>
          <FieldContent>
            <FieldTitle id="room-local-caption-font-size">字幕字号</FieldTitle>
            <FieldDescription>仅作用于当前直播间，不影响弹幕显示。</FieldDescription>
          </FieldContent>
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
}: {
  className?: string;
  captions?: LocalCaptionSettings;
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

  return (
    <ScrollArea className={cn("min-h-0 flex-1", className)}>
      <div className="flex flex-col gap-5 px-3 py-3">
        {captions && <LocalCaptionSettingsSection captions={captions} />}

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
                <FieldTitle id="room-danmaku-repeat-filter">飘屏相同内容合并</FieldTitle>
                <FieldDescription>
                  仅在飘屏中：5 秒内合并所有用户的相同聊天内容，并显示次数；右侧列表逐条显示。
                </FieldDescription>
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
});
