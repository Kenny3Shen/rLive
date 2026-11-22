import { useState } from "react";
import { Download, RefreshCw, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldTitle,
} from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  describeAsrModelStatus,
  estimateAsrDownloadBytes,
  formatAsrBytes,
  useAsrModelStatus,
} from "@/features/asr/model";
import { FieldTip } from "@/features/settings/FieldTip";
import {
  AsrCaptionFontSizeField,
  AsrChunkIntervalField,
  AsrHotwordsField,
  DanmakuAppearanceSettingsFields,
  DanmakuFilterSettingsFields,
  DanmakuTrackSettingsFields,
  VideoBlockedUploaderField,
  resetDanmakuAppearanceSettings,
} from "@/features/settings/PlaybackPreferenceFields";
import { SettingsSection, useSettingsFieldOrientation } from "@/features/settings/SettingsSection";
import { SwitchField } from "@/features/settings/SwitchField";
import { cn } from "@/lib/utils";
import { isMobileClient, isWindowsDesktop } from "@/shared/clientPlatform";
import { errorText } from "@/shared/components/errorPresentation";
import {
  ASR_FONT_SIZE_DEFAULT,
  ASR_MODEL_DEFAULT,
  ASR_WINDOW_SECONDS_DEFAULT,
  ROOM_CARD_PREVIEW_ENABLED_DEFAULT,
  VIDEO_NEXT_EPISODE_PRELOAD_DEFAULT,
  VIDEO_RECOMMEND_API_DEFAULT,
  useSettingsStore,
} from "@/shared/stores/settingsStore";
import type { AsrModel, AsrProvider } from "@/shared/types/live";

function PlaybackSettingsResetField() {
  const mobileClient = isMobileClient();
  const orientation = useSettingsFieldOrientation();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function resetAll() {
    setResetting(true);
    setStatus(null);
    setError(null);
    try {
      const store = useSettingsStore.getState();
      // 先关闭 ASR，使剩余字段的重置不会在中途重启识别会话。
      if (!mobileClient && store.asrEnabled) {
        await store.setAsrEnabled(false);
      }
      resetDanmakuAppearanceSettings();
      useSettingsStore.setState({
        qualityLevel: "high",
        playbackSoftSwitchEnabled: true,
        videoRecommendApi: VIDEO_RECOMMEND_API_DEFAULT,
        videoNextEpisodePreload: VIDEO_NEXT_EPISODE_PRELOAD_DEFAULT,
        videoBlockedUploaders: [],
        danmakuShieldWords: [],
        danmakuBlockedUsers: [],
        superChatEnabled: true,
        ...(mobileClient
          ? null
          : {
              roomCardPreviewEnabled: ROOM_CARD_PREVIEW_ENABLED_DEFAULT,
              asrModel: ASR_MODEL_DEFAULT,
              asrProvider: "auto" as const,
              asrVadEnabled: true,
              asrPunctuationEnabled: true,
              asrSpeakerDiarizationEnabled: false,
              asrHotwords: [],
              asrWindowSeconds: ASR_WINDOW_SECONDS_DEFAULT,
              asrFontSize: ASR_FONT_SIZE_DEFAULT,
            }),
      });
      await store.persistToBackend({
        quality_level: "high",
        playback_soft_switch_enabled: true,
        video_recommend_api: VIDEO_RECOMMEND_API_DEFAULT,
        video_next_episode_preload: VIDEO_NEXT_EPISODE_PRELOAD_DEFAULT,
        video_blocked_uploaders: [],
        danmaku_shield_words: [],
        danmaku_blocked_users: [],
        super_chat_enabled: true,
        ...(mobileClient
          ? null
          : {
              room_card_preview_enabled: ROOM_CARD_PREVIEW_ENABLED_DEFAULT,
              asr_model: ASR_MODEL_DEFAULT,
              asr_provider: "auto",
              asr_vad_enabled: true,
              asr_punctuation_enabled: true,
              asr_speaker_diarization_enabled: false,
              asr_hotwords: [],
              asr_window_seconds: ASR_WINDOW_SECONDS_DEFAULT,
              asr_font_size: ASR_FONT_SIZE_DEFAULT,
            }),
      });
      setStatus("已恢复这组播放设置的全部默认值。");
      setConfirmOpen(false);
    } catch (cause) {
      setError(`恢复默认设置失败：${errorText(cause)}`);
    } finally {
      setResetting(false);
    }
  }

  return (
    <Field orientation={orientation} data-invalid={error ? true : undefined}>
      <FieldContent className="min-w-0">
        <FieldTitle>
          <span>恢复默认设置</span>
          <FieldTip>重置全部播放设置，包括屏蔽词、屏蔽用户和语音字幕热词。</FieldTip>
        </FieldTitle>
        {error ? (
          <FieldError>{error}</FieldError>
        ) : (
          status && (
            <FieldDescription role="status" aria-live="polite">
              {status}
            </FieldDescription>
          )
        )}
      </FieldContent>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (resetting) return;
          setConfirmOpen(open);
        }}
        trigger={
          <Button variant="outline">
            <RotateCcw data-icon="inline-start" aria-hidden />
            恢复默认
          </Button>
        }
        icon={<RotateCcw aria-hidden />}
        title="恢复默认设置？"
        description={
          mobileClient
            ? "将重置全部播放设置，包括画质、弹幕和屏蔽词。"
            : "将重置全部播放设置，包括画质、语音字幕、热词、弹幕和屏蔽词；已开启的语音字幕会被关闭。"
        }
        busy={resetting}
        busyText="正在恢复…"
        actionIcon={<RotateCcw data-icon="inline-start" aria-hidden />}
        confirmText="恢复默认"
        onConfirm={() => void resetAll()}
      />
    </Field>
  );
}

function AsrModelField({ idPrefix }: { idPrefix: string }) {
  const orientation = useSettingsFieldOrientation();
  const enabled = useSettingsStore((state) => state.asrEnabled);
  const asrModel = useSettingsStore((state) => state.asrModel);
  const provider = useSettingsStore((state) => state.asrProvider);
  const vadEnabled = useSettingsStore((state) => state.asrVadEnabled);
  const punctuationEnabled = useSettingsStore((state) => state.asrPunctuationEnabled);
  const speakerEnabled = useSettingsStore((state) => state.asrSpeakerDiarizationEnabled);
  const pending = useSettingsStore((state) => state.asrPending);
  const setEnabled = useSettingsStore((state) => state.setAsrEnabled);
  const setModel = useSettingsStore((state) => state.setAsrModel);
  const setProvider = useSettingsStore((state) => state.setAsrProvider);
  const setVadEnabled = useSettingsStore((state) => state.setAsrVadEnabled);
  const setPunctuationEnabled = useSettingsStore((state) => state.setAsrPunctuationEnabled);
  const setSpeakerEnabled = useSettingsStore((state) => state.setAsrSpeakerDiarizationEnabled);
  const model = useAsrModelStatus({ enabled });
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const enabledTitleId = `${idPrefix}-asr-enabled-title`;
  const modelTitleId = `${idPrefix}-asr-model-title`;
  const modelSelectId = `${idPrefix}-asr-model`;
  const providerTitleId = `${idPrefix}-asr-provider-title`;
  const selectedStatus = model.status?.model === asrModel ? model.status : null;
  const modelStatusPending = model.isPending || (model.status !== null && selectedStatus === null);
  const presentation = describeAsrModelStatus(selectedStatus, {
    enabled,
    supported: model.supported,
    queryError: model.queryError,
  });

  async function applyEnabled(next: boolean) {
    setActionError(null);
    try {
      await setEnabled(next);
      await model.refetch();
    } catch (error) {
      setActionError(errorText(error));
    }
  }

  async function retryPreparation() {
    setActionError(null);
    try {
      // 资产不完整时 `loadSession` 会先补齐下载；资产已就绪时直接加载会话。
      await model.loadSession();
      await model.refetch();
    } catch (error) {
      setActionError(errorText(error));
    }
  }

  async function applySpeakerEnabled(next: boolean) {
    setActionError(null);
    try {
      await setSpeakerEnabled(next);
      await model.refetch();
    } catch (error) {
      setActionError(errorText(error));
    }
  }

  async function applyModel(next: AsrModel) {
    setActionError(null);
    try {
      await setModel(next);
      await model.refetch();
    } catch (error) {
      setActionError(errorText(error));
    }
  }

  async function applyProvider(next: AsrProvider) {
    setActionError(null);
    try {
      await setProvider(next);
      await model.refetch();
    } catch (error) {
      setActionError(errorText(error));
    }
  }

  async function applyVadEnabled(next: boolean) {
    setActionError(null);
    try {
      await setVadEnabled(next);
      await model.refetch();
    } catch (error) {
      setActionError(errorText(error));
    }
  }

  async function applyPunctuationEnabled(next: boolean) {
    setActionError(null);
    try {
      await setPunctuationEnabled(next);
      await model.refetch();
    } catch (error) {
      setActionError(errorText(error));
    }
  }

  const invalid = presentation.error || actionError !== null;
  const busy = pending || modelStatusPending || (enabled && presentation.busy);
  const unsupported = selectedStatus?.state === "unsupported";
  const estimatedDownloadBytes = selectedStatus
    ? estimateAsrDownloadBytes(selectedStatus, speakerEnabled)
    : 0;
  // 选了 CPU 时不会下载 CUDA 运行库。
  const cudaExtraBytes = provider === "cpu" ? 0 : (selectedStatus?.cuda_runtime_extra_bytes ?? 0);
  const speakerModelBytes = selectedStatus?.speaker_model_size_bytes ?? 0;
  const hotwordsSupported = selectedStatus?.hotwords_supported ?? asrModel !== "xasr";
  const controlsPending = !model.supported || modelStatusPending || pending;
  const enabledControlDisabled = controlsPending || unsupported;
  const providerNotice =
    !presentation.busy && !presentation.error && !unsupported ? selectedStatus?.message : null;

  return (
    <>
      <Field
        orientation={orientation}
        data-disabled={enabledControlDisabled || undefined}
        data-invalid={invalid || undefined}
      >
        <FieldContent className="min-w-0">
          <FieldTitle>
            <span id={enabledTitleId}>语音字幕</span>
            <FieldTip>
              启用后只准备本机语音字幕；当前直播或点播是否显示，仍由播放器字幕菜单控制。
            </FieldTip>
          </FieldTitle>
          {invalid ? (
            <FieldError role="status" aria-live="polite">
              {actionError ?? presentation.message}
            </FieldError>
          ) : unsupported ? (
            <FieldDescription role="status">{presentation.message}</FieldDescription>
          ) : (
            // 稳态文案（就绪/禁用摘要）保持隐藏；
            // 这里只显示模型下载之类的瞬态进度。
            enabled &&
            presentation.busy && (
              <FieldDescription role="status" aria-live="polite">
                {presentation.message}
              </FieldDescription>
            )
          )}
          {enabled && presentation.error && (
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="mt-2 w-fit"
              disabled={pending}
              onClick={() => void retryPreparation()}
            >
              <RefreshCw data-icon="inline-start" aria-hidden />
              重试
            </Button>
          )}
        </FieldContent>
        <div
          className={cn(
            "flex shrink-0 items-center justify-end gap-2",
            orientation === "responsive" && "w-full @md/field-group:w-auto",
          )}
        >
          {busy && <Spinner aria-hidden />}
          <Switch
            aria-labelledby={enabledTitleId}
            aria-invalid={invalid || undefined}
            checked={enabled}
            disabled={enabledControlDisabled}
            onCheckedChange={(checked) => {
              if (checked && selectedStatus?.state === "not_downloaded") {
                setConfirmOpen(true);
                return;
              }
              void applyEnabled(checked);
            }}
          />
        </div>
      </Field>

      <Field orientation={orientation} data-disabled={controlsPending || undefined}>
        <FieldContent className="min-w-0">
          <FieldTitle>
            <span id={modelTitleId}>识别模型</span>
            <FieldTip>
              Qwen3-ASR 支持更多语言和热词；xASR
              模型更小，适合中英混合语音。切换后按需下载所选模型。
            </FieldTip>
          </FieldTitle>
          {selectedStatus === null && enabled && !model.isPending && (
            <FieldDescription role="status">正在读取所选模型的状态…</FieldDescription>
          )}
        </FieldContent>
        <Select
          value={asrModel}
          disabled={controlsPending}
          onValueChange={(value) => {
            if (value === "qwen3" || value === "xasr") {
              void applyModel(value);
            }
          }}
        >
          <SelectTrigger
            id={modelSelectId}
            size="sm"
            className="min-w-40 border border-input bg-background"
            aria-labelledby={modelTitleId}
          >
            <SelectValue>{asrModel === "xasr" ? "xASR 中英" : "Qwen3-ASR"}</SelectValue>
          </SelectTrigger>
          <SelectContent align="end">
            <SelectGroup>
              <SelectItem value="qwen3">Qwen3-ASR</SelectItem>
              <SelectItem value="xasr">xASR 中英</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>

      <SwitchField
        title="VAD（静音端点检测）"
        tip="用 Silero VAD 按停顿分句；关闭后仅按最长 12 秒切分。"
        orientation={orientation}
        checked={vadEnabled}
        disabled={controlsPending}
        fieldDisabled={controlsPending}
        onCheckedChange={(checked) => void applyVadEnabled(checked)}
      />

      {isWindowsDesktop() && (
        <Field orientation={orientation} data-disabled={controlsPending || undefined}>
          <FieldContent className="min-w-0">
            <FieldTitle>
              <span id={providerTitleId}>推理后端</span>
              <FieldTip>
                Qwen3-ASR 自动优先使用 NVIDIA GPU（GTX 10 系列至 RTX 40 系列），不可用时回退 CPU；选
                CPU 不下载 CUDA 运行库。已用 CPU 运行库启动时，改用 CUDA 需重启应用。
              </FieldTip>
            </FieldTitle>
            {providerNotice && <FieldDescription role="status">{providerNotice}</FieldDescription>}
          </FieldContent>
          <ToggleGroup
            aria-labelledby={providerTitleId}
            value={[provider]}
            variant="outline"
            size="sm"
            spacing={1}
            disabled={controlsPending}
            onValueChange={(values) => {
              const next = values[0];
              if (next === "auto" || next === "cpu" || next === "cuda") {
                void applyProvider(next);
              }
            }}
          >
            <ToggleGroupItem value="auto">自动</ToggleGroupItem>
            <ToggleGroupItem value="cuda">CUDA</ToggleGroupItem>
            <ToggleGroupItem value="cpu">CPU</ToggleGroupItem>
          </ToggleGroup>
        </Field>
      )}

      <SwitchField
        title="自动标点"
        tip="关闭后去掉识别结果里的标点。"
        orientation={orientation}
        checked={punctuationEnabled}
        disabled={controlsPending}
        fieldDisabled={controlsPending}
        onCheckedChange={(checked) => void applyPunctuationEnabled(checked)}
      />

      <SwitchField
        title="说话人区分"
        tip={
          speakerModelBytes > 0
            ? `首次启用需下载约 ${formatAsrBytes(speakerModelBytes)} 声纹模型。`
            : "首次启用需下载声纹模型。"
        }
        orientation={orientation}
        checked={speakerEnabled}
        disabled={controlsPending}
        fieldDisabled={controlsPending}
        onCheckedChange={(checked) => void applySpeakerEnabled(checked)}
      />

      <AsrHotwordsField
        idPrefix={idPrefix}
        hint={
          hotwordsSupported
            ? undefined
            : "xASR 不支持热词；已保存的热词会保留，切回 Qwen3-ASR 后继续生效。"
        }
        disabled={controlsPending || !hotwordsSupported}
      />
      <AsrChunkIntervalField idPrefix={idPrefix} disabled={controlsPending} />

      <AsrDownloadDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        estimatedDownloadBytes={estimatedDownloadBytes}
        cudaExtraBytes={cudaExtraBytes}
        model={asrModel}
        onConfirm={() => void applyEnabled(true)}
      />
    </>
  );
}

function AsrDownloadDialog({
  open,
  onOpenChange,
  estimatedDownloadBytes,
  cudaExtraBytes,
  model,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  estimatedDownloadBytes: number;
  cudaExtraBytes: number;
  model: AsrModel;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia>
            <Download aria-hidden />
          </AlertDialogMedia>
          <AlertDialogTitle>下载语音字幕模型</AlertDialogTitle>
          <AlertDialogDescription>
            将下载约 {formatAsrBytes(estimatedDownloadBytes)} 的 CrispASR 运行库和{" "}
            {model === "xasr" ? "xASR 中英模型" : "Qwen3-ASR 模型"}
            ，完成后自动启用并保留在本机。
            {cudaExtraBytes > 0 &&
              ` 检测到可用的 NVIDIA GPU 时改用 CUDA 运行库，需额外下载约 ${formatAsrBytes(cudaExtraBytes)}。`}
            旧版字幕模型（如有）会被删除以释放空间。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>取消</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              onOpenChange(false);
              onConfirm();
            }}
          >
            下载并启用
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function PlaybackQualitySection({ idPrefix }: { idPrefix: string }) {
  const orientation = useSettingsFieldOrientation();
  const qualityLevel = useSettingsStore((state) => state.qualityLevel);
  const setQualityLevel = useSettingsStore((state) => state.setQualityLevel);
  const playbackSoftSwitchEnabled = useSettingsStore((state) => state.playbackSoftSwitchEnabled);
  const setPlaybackSoftSwitchEnabled = useSettingsStore(
    (state) => state.setPlaybackSoftSwitchEnabled,
  );
  const qualityLabelId = `${idPrefix}-quality-label`;

  return (
    <SettingsSection title="播放质量">
      <Field orientation={orientation}>
        <FieldTitle id={qualityLabelId}>优先清晰度</FieldTitle>
        <ToggleGroup
          aria-labelledby={qualityLabelId}
          value={[qualityLevel]}
          variant="outline"
          size="sm"
          spacing={1}
          onValueChange={(values) => {
            const next = values[0];
            if (next === "high" || next === "mid" || next === "low") {
              setQualityLevel(next);
            }
          }}
        >
          <ToggleGroupItem value="high">最高</ToggleGroupItem>
          <ToggleGroupItem value="mid">中间</ToggleGroupItem>
          <ToggleGroupItem value="low">最低</ToggleGroupItem>
        </ToggleGroup>
      </Field>
      <SwitchField
        title="软切换"
        tip="同协议换源时保留播放器；FLV 会重建内部流内核，失败时自动完整重建。"
        orientation={orientation}
        checked={playbackSoftSwitchEnabled}
        onCheckedChange={setPlaybackSoftSwitchEnabled}
      />
    </SettingsSection>
  );
}

function VideoSettingsSections({ idPrefix }: { idPrefix: string }) {
  const orientation = useSettingsFieldOrientation();
  const videoRecommendApi = useSettingsStore((state) => state.videoRecommendApi);
  const setVideoRecommendApi = useSettingsStore((state) => state.setVideoRecommendApi);
  const videoNextEpisodePreload = useSettingsStore((state) => state.videoNextEpisodePreload);
  const setVideoNextEpisodePreload = useSettingsStore((state) => state.setVideoNextEpisodePreload);
  const recommendApiLabelId = `${idPrefix}-video-recommend-api-label`;

  return (
    <SettingsSection title="视频点播">
      <Field orientation={orientation}>
        <FieldTitle id={recommendApiLabelId}>推荐接口</FieldTitle>
        <ToggleGroup
          aria-labelledby={recommendApiLabelId}
          value={[videoRecommendApi]}
          variant="outline"
          size="sm"
          spacing={1}
          onValueChange={(values) => {
            const next = values[0];
            if (next === "app" || next === "web") setVideoRecommendApi(next);
          }}
        >
          <ToggleGroupItem value="app">App API</ToggleGroupItem>
          <ToggleGroupItem value="web">Web API</ToggleGroupItem>
        </ToggleGroup>
      </Field>
      <SwitchField
        title="预加载下一分集"
        tip="默认关闭。开启后在当前集最后一个分片加载完之后，才加载下一分集的初始化段与首个音视频分片，会产生额外流量；不预载相关视频。"
        orientation={orientation}
        checked={videoNextEpisodePreload}
        onCheckedChange={setVideoNextEpisodePreload}
      />
    </SettingsSection>
  );
}

function BrowserSettingsSection() {
  const orientation = useSettingsFieldOrientation();
  const roomCardPreviewEnabled = useSettingsStore((state) => state.roomCardPreviewEnabled);
  const setRoomCardPreviewEnabled = useSettingsStore((state) => state.setRoomCardPreviewEnabled);

  return (
    <SettingsSection title="浏览页">
      <SwitchField
        title="悬停卡片预览"
        tip="鼠标停留在直播间卡片上时播放静音低画质预览；仅桌面端且系统未开启减少动态效果时生效。"
        orientation={orientation}
        checked={roomCardPreviewEnabled}
        onCheckedChange={setRoomCardPreviewEnabled}
      />
    </SettingsSection>
  );
}

export function PlaybackSettingsContent({ idPrefix = "settings" }: { idPrefix?: string }) {
  const mobileClient = isMobileClient();

  return (
    <>
      <PlaybackQualitySection idPrefix={idPrefix} />
      <VideoSettingsSections idPrefix={idPrefix} />
      {!mobileClient && <BrowserSettingsSection />}
      {!mobileClient && (
        <SettingsSection title="语音字幕">
          <AsrModelField idPrefix={idPrefix} />
          <AsrCaptionFontSizeField idPrefix={idPrefix} />
        </SettingsSection>
      )}
      <SettingsSection title="弹幕设置">
        <DanmakuTrackSettingsFields idPrefix={idPrefix} />
        <DanmakuAppearanceSettingsFields idPrefix={idPrefix} />
      </SettingsSection>
      <SettingsSection title="消息过滤">
        <DanmakuFilterSettingsFields idPrefix={idPrefix} showSuperChat />
        <VideoBlockedUploaderField idPrefix={idPrefix} />
      </SettingsSection>
      <SettingsSection title="恢复默认">
        <PlaybackSettingsResetField />
      </SettingsSection>
    </>
  );
}
