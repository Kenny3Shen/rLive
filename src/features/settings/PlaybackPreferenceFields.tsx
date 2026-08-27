import { useEffect, useRef, useState } from "react";
import type { AppSettings } from "@/shared/types/live";
import {
  DANMAKU_AREA_DEFAULT,
  DANMAKU_FONT_STROKE_DEFAULT,
  DANMAKU_FONT_STROKE_MAX,
  DANMAKU_FONT_STROKE_MIN,
  DANMAKU_FONT_STROKE_STEP,
  DANMAKU_OPACITY_DEFAULT,
  DANMAKU_SPEED_DEFAULT,
  DANMAKU_SPEED_MAX,
  DANMAKU_SPEED_MIN,
  DANMAKU_MERGE_WINDOW_SECONDS_DEFAULT,
  DANMAKU_MERGE_WINDOW_SECONDS_MAX,
  DANMAKU_MERGE_WINDOW_SECONDS_MIN,
  defaultDanmakuFontSize,
  parseDanmakuFontStroke,
  parseDanmakuSpeed,
  parseDanmakuMergeWindowSeconds,
  useSettingsStore,
} from "@/shared/stores/settingsStore";
import { Badge } from "@/components/ui/badge";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldTitle,
} from "@/components/ui/field";
import { FieldTip } from "@/features/settings/FieldTip";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

export type PlaybackSettingsFieldLayout = "page" | "panel";

const ASR_FONT_SIZE_MIN = 12;
const ASR_FONT_SIZE_MAX = 48;
const ASR_CHUNK_SECONDS_MIN = 0.2;
const ASR_CHUNK_SECONDS_MAX = 1;

const DANMAKU_APPEARANCE_DEFAULTS = {
  danmakuOpacity: DANMAKU_OPACITY_DEFAULT,
  danmakuFontSize: defaultDanmakuFontSize(),
  danmakuFontStroke: DANMAKU_FONT_STROKE_DEFAULT,
  danmakuSpeed: DANMAKU_SPEED_DEFAULT,
  danmakuArea: DANMAKU_AREA_DEFAULT,
  danmakuFilterGifts: true,
  danmakuMergeWindowSeconds: DANMAKU_MERGE_WINDOW_SECONDS_DEFAULT,
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
      orientation="horizontal"
      data-disabled={disabled || undefined}
      className={fieldSurfaceClass(layout)}
    >
      <FieldContent className={layout === "panel" ? "min-w-0 flex-none" : undefined}>
        <FieldTitle>
          <span id={labelId}>{title}</span>
          {description && <FieldTip>{description}</FieldTip>}
        </FieldTitle>
      </FieldContent>
      {/* 窄屏上与标题共享一行；宽屏布局下上限 13rem。 */}
      <div
        className={cn(
          "flex items-center gap-3",
          layout === "page" ? "min-w-32 max-w-52 flex-1" : "min-w-0 flex-1",
        )}
      >
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
      if (!key || Array.from(word).length > 80 || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function normalizeBlockedUsersDraft(value: string): string[] {
  const seen = new Set<string>();
  return value
    .split(/\r?\n|,/)
    .map((user) => user.trim())
    .filter((user) => {
      // 与匹配器一致按大小写敏感精确匹配，去重也保持同一口径。
      if (!user || Array.from(user).length > 80 || seen.has(user)) return false;
      seen.add(user);
      return true;
    });
}

function sameWords(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((word, index) => word === right[index]);
}

/**
 * 屏蔽词与屏蔽用户共享的逐行草稿编辑。输入即时写入本地 store（消息流立即
 * 按新列表过滤），持久化则做 350ms 防抖，组件卸载前冲刷未保存的修改。
 */
function useSettingsLinesDraft(options: {
  lines: readonly string[];
  normalize: (value: string) => string[];
  applyLines: (lines: string[]) => void;
  persistPatch: (lines: string[]) => Partial<AppSettings>;
  pendingStatus: string;
  savedStatus: string;
}) {
  const { lines } = options;
  // 包装 hook 每次渲染都传入新的 options 字面量。直接把它放进 effect 依赖会
  // 在每次渲染后重跑清理、打穿 350ms 防抖，因此经由 ref 读取最新值，
  // 依赖数组只跟踪真正驱动行为的 `lines` 与 `draft`。
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [draft, setDraft] = useState(lines.join("\n"));
  const [status, setStatus] = useState<string | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const pendingLinesRef = useRef<string[]>([]);

  useEffect(() => {
    if (!sameWords(optionsRef.current.normalize(draft), lines)) {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
        setStatus(null);
      }
      setDraft(lines.join("\n"));
    }
    pendingLinesRef.current = [...lines];
  }, [draft, lines]);

  useEffect(
    () => () => {
      if (saveTimerRef.current === null) return;
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
      persist(optionsRef.current.persistPatch(pendingLinesRef.current));
    },
    [],
  );

  function update(value: string) {
    const next = optionsRef.current.normalize(value);
    setDraft(value);
    optionsRef.current.applyLines(next);
    pendingLinesRef.current = next;
    setStatus(optionsRef.current.pendingStatus);

    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      persist(optionsRef.current.persistPatch(pendingLinesRef.current));
      setStatus(optionsRef.current.savedStatus);
    }, 350);
  }

  return { draft, status, update };
}

function useShieldWordsDraft() {
  return useSettingsLinesDraft({
    lines: useSettingsStore((state) => state.danmakuShieldWords),
    normalize: normalizeShieldWords,
    applyLines: (words) => useSettingsStore.setState({ danmakuShieldWords: words }),
    persistPatch: (words) => ({ danmaku_shield_words: words }),
    pendingStatus: "新的消息会立即按此过滤，正在保存…",
    savedStatus: "已自动保存，新的消息会立即按此过滤",
  });
}

function useBlockedUsersDraft() {
  return useSettingsLinesDraft({
    lines: useSettingsStore((state) => state.danmakuBlockedUsers),
    normalize: normalizeBlockedUsersDraft,
    applyLines: (users) => useSettingsStore.setState({ danmakuBlockedUsers: users }),
    persistPatch: (users) => ({ danmaku_blocked_users: users }),
    pendingStatus: "屏蔽立即生效并撤下已显示的消息，正在保存…",
    savedStatus: "已自动保存，屏蔽在弹幕列表与飘屏同时生效",
  });
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
      title="更新间隔"
      description={layout === "page" ? "越短，刷新越快。" : undefined}
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

function normalizeAsrHotwords(value: string): string[] {
  const seen = new Set<string>();
  return value
    .split(/\r?\n|,/)
    .map((word) => word.replace(/[\t]/g, " ").trim())
    .filter((word) => {
      const key = word.toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 100);
}

export function AsrHotwordsField({
  idPrefix,
  layout,
  disabled = false,
}: {
  idPrefix: string;
  layout: PlaybackSettingsFieldLayout;
  disabled?: boolean;
}) {
  const hotwords = useSettingsStore((state) => state.asrHotwords);
  const setHotwords = useSettingsStore((state) => state.setAsrHotwords);
  const [draft, setDraft] = useState(hotwords.join("\n"));
  const [status, setStatus] = useState<string | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const pendingWordsRef = useRef(hotwords);
  const editingRef = useRef(false);
  const composingRef = useRef(false);
  const revisionRef = useRef(0);
  const savePendingRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!editingRef.current) {
      pendingWordsRef.current = hotwords;
      setDraft(hotwords.join("\n"));
    }
  }, [hotwords]);

  function clearSaveTimer() {
    if (saveTimerRef.current === null) return;
    window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = null;
  }

  function savePending(revision: number) {
    if (revision !== revisionRef.current || composingRef.current) return;
    const next = pendingWordsRef.current;
    const current = useSettingsStore.getState().asrHotwords;
    if (sameWords(next, current)) return;

    setStatus("正在保存热词…");
    void setHotwords(next)
      .then(() => {
        if (revision === revisionRef.current) {
          editingRef.current = false;
          setDraft(next.join("\n"));
          setStatus(next.length > 0 ? `已自动保存 ${next.length} 个热词` : "热词已清空");
        }
      })
      .catch(() => {
        if (revision === revisionRef.current) {
          setStatus("热词保存失败，请重试");
        }
      });
  }

  savePendingRef.current = () => savePending(revisionRef.current);

  function scheduleSave() {
    clearSaveTimer();
    if (composingRef.current) return;
    const revision = revisionRef.current;
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      savePending(revision);
    }, 350);
  }

  useEffect(
    () => () => {
      clearSaveTimer();
      if (!composingRef.current) savePendingRef.current?.();
    },
    [],
  );

  function update(value: string) {
    editingRef.current = true;
    revisionRef.current += 1;
    pendingWordsRef.current = normalizeAsrHotwords(value);
    setDraft(value);
    setStatus(composingRef.current ? "输入完成后自动保存" : "修改后将自动保存");
    scheduleSave();
  }

  return (
    <Field data-disabled={disabled || undefined} className={fieldSurfaceClass(layout)}>
      <div className="flex items-center gap-1.5">
        <FieldLabel htmlFor={`${idPrefix}-asr-hotwords`}>本地热词</FieldLabel>
        {layout === "page" && <FieldTip>每行一个，最多 100 个。</FieldTip>}
      </div>
      <FieldContent>
        <Textarea
          id={`${idPrefix}-asr-hotwords`}
          value={draft}
          rows={layout === "page" ? 5 : 4}
          placeholder="每行一个词，也可用逗号分隔"
          className="resize-y"
          disabled={disabled}
          spellCheck={false}
          onCompositionStart={() => {
            composingRef.current = true;
            clearSaveTimer();
            setStatus("输入完成后自动保存");
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
            scheduleSave();
          }}
          onChange={(event) => update(event.target.value)}
          onBlur={() => {
            if (composingRef.current) return;
            clearSaveTimer();
            savePending(revisionRef.current);
          }}
        />
        {status && <FieldDescription role="status">{status}</FieldDescription>}
      </FieldContent>
    </Field>
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

  return (
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
  const fontStroke = useSettingsStore((state) => state.danmakuFontStroke);
  const speed = useSettingsStore((state) => state.danmakuSpeed);

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
        title="弹幕字号"
        value={fontSize}
        min={12}
        max={36}
        displayValue={`${fontSize}px`}
        layout={layout}
        onPreview={(value) => useSettingsStore.setState({ danmakuFontSize: value })}
        onCommit={(value) => persist({ danmaku_font_size: value })}
      />
      <PreferenceSliderField
        id={`${idPrefix}-danmaku-font-stroke`}
        title="字体描边"
        description={
          layout === "page" ? "调整播放器弹幕的文字轮廓宽度，设为 0 可关闭。" : undefined
        }
        value={fontStroke}
        min={DANMAKU_FONT_STROKE_MIN}
        max={DANMAKU_FONT_STROKE_MAX}
        step={DANMAKU_FONT_STROKE_STEP}
        displayValue={fontStroke === 0 ? "关闭" : `${fontStroke.toFixed(1)}px`}
        layout={layout}
        onPreview={(value) =>
          useSettingsStore.setState({ danmakuFontStroke: parseDanmakuFontStroke(value) })
        }
        onCommit={(value) => {
          const next = parseDanmakuFontStroke(value);
          useSettingsStore.setState({ danmakuFontStroke: next });
          persist({ danmaku_font_stroke: next });
        }}
      />
      <PreferenceSliderField
        id={`${idPrefix}-danmaku-speed`}
        title="滚动速度"
        description={layout === "page" ? "调整普通滚动弹幕的移动速度。" : undefined}
        value={speed}
        min={DANMAKU_SPEED_MIN}
        max={DANMAKU_SPEED_MAX}
        step={10}
        displayValue={`${speed} px/s`}
        layout={layout}
        onPreview={(value) => useSettingsStore.setState({ danmakuSpeed: parseDanmakuSpeed(value) })}
        onCommit={(value) => {
          const next = parseDanmakuSpeed(value);
          useSettingsStore.setState({ danmakuSpeed: next });
          persist({ danmaku_speed: next });
        }}
      />
    </>
  );
}

/** 重置弹幕轨道/文本/过滤设置；屏蔽词保留。 */
export function resetDanmakuAppearanceSettings() {
  useSettingsStore.setState(DANMAKU_APPEARANCE_DEFAULTS);
  persist({
    danmaku_opacity: DANMAKU_APPEARANCE_DEFAULTS.danmakuOpacity,
    danmaku_font_size: DANMAKU_APPEARANCE_DEFAULTS.danmakuFontSize,
    danmaku_font_stroke: DANMAKU_APPEARANCE_DEFAULTS.danmakuFontStroke,
    danmaku_speed: DANMAKU_APPEARANCE_DEFAULTS.danmakuSpeed,
    danmaku_area: DANMAKU_APPEARANCE_DEFAULTS.danmakuArea,
    danmaku_filter_gifts: DANMAKU_APPEARANCE_DEFAULTS.danmakuFilterGifts,
    danmaku_merge_window_seconds: DANMAKU_APPEARANCE_DEFAULTS.danmakuMergeWindowSeconds,
  });
}

export function DanmakuFilterSettingsFields({
  idPrefix,
  layout,
  showSuperChat = false,
}: {
  idPrefix: string;
  layout: PlaybackSettingsFieldLayout;
  showSuperChat?: boolean;
}) {
  const filterGifts = useSettingsStore((state) => state.danmakuFilterGifts);
  const mergeWindowSeconds = useSettingsStore((state) => state.danmakuMergeWindowSeconds);
  const superChatEnabled = useSettingsStore((state) => state.superChatEnabled);
  const setSuperChatEnabled = useSettingsStore((state) => state.setSuperChatEnabled);
  const shield = useShieldWordsDraft();
  const blocked = useBlockedUsersDraft();
  const giftLabelId = `${idPrefix}-danmaku-gift-filter-label`;
  const superChatLabelId = `${idPrefix}-super-chat-enabled-label`;
  const shieldInputId = `${idPrefix}-danmaku-shield-words`;
  const blockedInputId = `${idPrefix}-danmaku-blocked-users`;

  return (
    <>
      <PreferenceSliderField
        id={`${idPrefix}-danmaku-merge-window`}
        title="合并窗口"
        description={layout === "page" ? "相同弹幕在此时间内合并计数，0 秒表示关闭。" : undefined}
        value={mergeWindowSeconds}
        min={DANMAKU_MERGE_WINDOW_SECONDS_MIN}
        max={DANMAKU_MERGE_WINDOW_SECONDS_MAX}
        displayValue={`${mergeWindowSeconds} 秒`}
        layout={layout}
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
      <Field orientation="horizontal" className={fieldSurfaceClass(layout)}>
        <FieldContent>
          <FieldTitle>
            <span id={giftLabelId}>隐藏礼物信息</span>
            {layout === "page" && <FieldTip>隐藏弹幕列表和叠加层中的礼物消息。</FieldTip>}
          </FieldTitle>
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
      {showSuperChat && (
        <Field orientation="horizontal" className={fieldSurfaceClass(layout)}>
          <FieldContent>
            <FieldTitle>
              <span id={superChatLabelId}>显示醒目留言</span>
              {layout === "page" && <FieldTip>显示支持平台的固定醒目留言。</FieldTip>}
            </FieldTitle>
          </FieldContent>
          <Switch
            aria-labelledby={superChatLabelId}
            checked={superChatEnabled}
            onCheckedChange={setSuperChatEnabled}
          />
        </Field>
      )}
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
      <Field className={fieldSurfaceClass(layout)}>
        <FieldLabel htmlFor={blockedInputId}>屏蔽用户</FieldLabel>
        <FieldContent>
          <Textarea
            id={blockedInputId}
            value={blocked.draft}
            onChange={(event) => blocked.update(event.target.value)}
            rows={layout === "page" ? 5 : 4}
            placeholder="每行一个昵称；也可在弹幕列表中点击消息直接屏蔽"
            className="resize-y"
          />
          {blocked.status && <FieldDescription role="status">{blocked.status}</FieldDescription>}
        </FieldContent>
      </Field>
    </>
  );
}
