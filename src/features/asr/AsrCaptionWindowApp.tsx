import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowDown, Captions } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { emit, listen } from "@tauri-apps/api/event";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { cn } from "@/lib/utils";
import { useSettingsStore } from "@/shared/stores/settingsStore";
import type {
  AsrTranscriptDivider,
  AsrTranscriptEntry,
  AsrTranscriptLine,
  AsrTranscriptLive,
} from "./asrTranscript";
import {
  ASR_CAPTION_EVENT,
  type AsrCaptionAppendPayload,
  type AsrCaptionLivePayload,
  type AsrCaptionPatchPayload,
  type AsrCaptionSnapshotPayload,
} from "./asrCaptionWindowProtocol";

const EMPTY_LIVE: AsrTranscriptLive = {
  sourceTitle: null,
  captionsOn: false,
  partial: null,
  notice: null,
};

/** 距底部小于该值即视为仍在跟随最新字幕。 */
const FOLLOW_THRESHOLD_PX = 28;
/** 行与行之间的间距；与原来的 `gap-3` 对齐。虚拟列表按它累计位置。 */
const ROW_GAP_PX = 12;
/** 触摸滚动一甩就是几屏，留几行缓冲避免露白。 */
const ROW_OVERSCAN = 6;

const transcriptTimeFormat = new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function transcriptTime(at: number): string {
  return transcriptTimeFormat.format(new Date(at));
}

const CaptionLineRow = memo(function CaptionLineRow({
  entry,
  fontSize,
}: {
  entry: AsrTranscriptLine;
  fontSize: number;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <p
        className="whitespace-pre-wrap break-words font-medium leading-relaxed"
        style={{ fontSize: `${fontSize}px` }}
      >
        {entry.text}
      </p>
      {entry.translation ? (
        <p
          className="whitespace-pre-wrap break-words leading-relaxed text-muted-foreground"
          style={{ fontSize: `${Math.max(14, fontSize - 2)}px` }}
        >
          {entry.translation}
        </p>
      ) : null}
    </div>
  );
});

const CaptionDividerRow = memo(function CaptionDividerRow({
  entry,
}: {
  entry: AsrTranscriptDivider;
}) {
  return (
    <div
      role="separator"
      className="flex min-w-0 items-center gap-2 border-t border-border pt-3 text-sm text-muted-foreground"
    >
      <Captions className="size-4 shrink-0" aria-hidden />
      <span className="truncate font-medium text-foreground">{entry.title}</span>
      <time className="ml-auto shrink-0 tabular-nums" dateTime={new Date(entry.at).toISOString()}>
        {transcriptTime(entry.at)}
      </time>
    </div>
  );
});

/**
 * 独立字幕窗口的内容。
 *
 * 这个窗口不渲染路由，也不调用任何应用命令：它只订阅主窗口转发来的事件，
 * 按到达顺序累积整场转录。窗口侧同样用可变数组 + 版本号驱动渲染，并维护
 * `id → 下标`：译文回填只替换目标行（O(1)），追加只 `push`，都不整份复制。
 * 版本号只负责让 React 重渲染；行组件按条目对象身份 `memo`，因此译文到达时
 * 只有那一行重渲染。
 *
 * 列表用虚拟滚动承载任意长度的历史：DOM 里始终只有可视区附近的行。行高由
 * 文字换行与译文有无决定，交给 `measureElement` 实测；行间距改由虚拟列表的
 * `gap` 累计（绝对定位的行不能靠 flex `gap`）。
 */
export default function AsrCaptionWindowApp() {
  const fontSize = useSettingsStore((state) => state.asrFontSize);
  // 转录可能到几万行，State 里只存版本号，避免每次追加/回填都复制整个数组。
  const entriesRef = useRef<AsrTranscriptEntry[]>([]);
  const indexByIdRef = useRef(new Map<string, number>());
  const [version, setVersion] = useState(0);
  const [live, setLive] = useState<AsrTranscriptLive>(EMPTY_LIVE);
  const [following, setFollowing] = useState(true);
  const followingRef = useRef(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followFrameRef = useRef<number | null>(null);

  const bumpVersion = useCallback(() => {
    setVersion((current) => current + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const unlisteners: (() => void)[] = [];
    void (async () => {
      // 先完成订阅再发 ready，确保主窗口补发的快照不会早于监听注册。
      const registered = await Promise.all([
        listen<AsrCaptionSnapshotPayload>(ASR_CAPTION_EVENT.snapshot, (event) => {
          // 快照是唯一会整份替换列表的路径，索引在这里一次性重建。
          const next = event.payload.entries.slice();
          const indexById = new Map<string, number>();
          next.forEach((entry, index) => indexById.set(entry.id, index));
          entriesRef.current = next;
          indexByIdRef.current = indexById;
          setLive(event.payload.live);
          bumpVersion();
        }),
        listen<AsrCaptionAppendPayload>(ASR_CAPTION_EVENT.append, (event) => {
          const entry = event.payload.entry;
          indexByIdRef.current.set(entry.id, entriesRef.current.length);
          entriesRef.current.push(entry);
          bumpVersion();
        }),
        listen<AsrCaptionPatchPayload>(ASR_CAPTION_EVENT.patch, (event) => {
          const index = indexByIdRef.current.get(event.payload.id);
          if (index === undefined) return;
          const entry = entriesRef.current[index];
          if (!entry || entry.kind !== "line" || entry.translation === event.payload.translation) {
            return;
          }
          // 原地替换目标行：只有持有新对象的这一行会越过 `memo` 重渲染。
          entriesRef.current[index] = { ...entry, translation: event.payload.translation };
          bumpVersion();
        }),
        listen<AsrCaptionLivePayload>(ASR_CAPTION_EVENT.live, (event) => {
          setLive(event.payload.live);
        }),
      ]);
      if (cancelled) {
        for (const unlisten of registered) unlisten();
        return;
      }
      unlisteners.push(...registered);
      // 窗口重载会重新走到这里，主窗口再次发送快照。
      await emit(ASR_CAPTION_EVENT.ready);
    })().catch(() => undefined);

    return () => {
      cancelled = true;
      for (const unlisten of unlisteners) unlisten();
    };
  }, [bumpVersion]);

  const estimateSize = useCallback(() => Math.round(fontSize * 2.6), [fontSize]);

  const pinToBottom = useCallback(() => {
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, []);

  // 行高实测完成前按估值排布，末行可能比估值高；滚动到末行之后再补一次真实底部，
  // 否则「跟随最新」会在长句到来时停在离底部几十像素的位置。合并到下一帧读写一次。
  const schedulePin = useCallback(() => {
    if (!followingRef.current || followFrameRef.current !== null) return;
    followFrameRef.current = requestAnimationFrame(() => {
      followFrameRef.current = null;
      if (followingRef.current) pinToBottom();
    });
  }, [pinToBottom]);

  useLayoutEffect(
    () => () => {
      if (followFrameRef.current !== null) {
        cancelAnimationFrame(followFrameRef.current);
        followFrameRef.current = null;
      }
    },
    [],
  );

  // oxlint-disable-next-line react/incompatible-library
  const virtualizer = useVirtualizer({
    count: entriesRef.current.length,
    getScrollElement: () => scrollRef.current,
    estimateSize,
    getItemKey: (index) => entriesRef.current[index]?.id ?? index,
    overscan: ROW_OVERSCAN,
    gap: ROW_GAP_PX,
    // 与仓库其他虚拟列表一致：滚动更新交给 React 自然批处理，不做同步刷新。
    useFlushSync: false,
    onChange: schedulePin,
  });

  // 新条目、快照、译文（可能新增一行）或底部在途文本出现时，跟随态重新钉到最后一条。
  // `version` 覆盖前三种数据变更；`live.partial` 会改变滚动视口高度。
  useEffect(() => {
    if (!following) return;
    const count = entriesRef.current.length;
    if (count === 0) return;
    virtualizer.scrollToIndex(count - 1, { align: "end" });
  }, [following, live.partial, version, virtualizer]);

  // 字号变化会改每一行的实测高度：清空测量缓存，可视行随 ResizeObserver 重新上报；
  // 跟随态再钉一次底部，避免清缓存后估算高度把视图留在半路。
  useEffect(() => {
    virtualizer.measure();
    if (!followingRef.current) return;
    const count = entriesRef.current.length;
    if (count > 0) virtualizer.scrollToIndex(count - 1, { align: "end" });
  }, [fontSize, virtualizer]);

  const handleScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    const next = distance <= FOLLOW_THRESHOLD_PX;
    followingRef.current = next;
    setFollowing(next);
  }, []);

  const jumpToLatest = useCallback(() => {
    followingRef.current = true;
    setFollowing(true);
    const count = entriesRef.current.length;
    if (count > 0) virtualizer.scrollToIndex(count - 1, { align: "end" });
  }, [virtualizer]);

  const status = live.notice
    ? { label: "识别异常", variant: "destructive" as const }
    : live.captionsOn
      ? { label: "字幕已开启", variant: "secondary" as const }
      : { label: "字幕已关闭", variant: "outline" as const };

  const entries = entriesRef.current;
  const virtualRows = virtualizer.getVirtualItems();

  return (
    <div className="relative flex h-dvh flex-col bg-background text-foreground">
      <header className="shrink-0 border-b border-border px-4 py-3">
        <div className="flex min-w-0 items-center justify-between gap-3">
          <h1 className="min-w-0 truncate text-base font-semibold">
            {live.sourceTitle || "直播字幕"}
          </h1>
          <Badge variant={status.variant}>{status.label}</Badge>
        </div>
        {live.notice ? (
          <p className="mt-2 text-sm break-words text-destructive" role="status">
            {live.notice}
          </p>
        ) : null}
      </header>

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        data-slot="asr-caption-transcript"
        className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain px-4 py-3"
      >
        {entries.length === 0 ? (
          <Empty className="h-full border-none">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Captions />
              </EmptyMedia>
              <EmptyTitle>暂无字幕</EmptyTitle>
              <EmptyDescription>
                在直播间控制栏打开「字幕（本地）」后，本次运行识别到的对话会按顺序显示在这里。
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div
            className="relative w-full"
            style={{ height: virtualizer.getTotalSize(), overflowAnchor: "none" }}
          >
            {virtualRows.map((virtualRow) => {
              const entry = entries[virtualRow.index];
              if (!entry) return null;
              return (
                <div
                  key={virtualRow.key}
                  data-index={virtualRow.index}
                  ref={virtualizer.measureElement}
                  className="absolute inset-x-0 top-0"
                  style={{ transform: `translateY(${virtualRow.start}px)` }}
                >
                  {entry.kind === "divider" ? (
                    <CaptionDividerRow entry={entry} />
                  ) : (
                    <CaptionLineRow entry={entry} fontSize={fontSize} />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {!following && entries.length > 0 ? (
        <Button
          variant="secondary"
          size="sm"
          className="absolute bottom-20 left-1/2 -translate-x-1/2 shadow-md"
          onClick={jumpToLatest}
        >
          <ArrowDown data-icon="inline-start" aria-hidden />
          回到最新
        </Button>
      ) : null}

      <footer className="shrink-0 border-t border-border bg-muted/40 px-4 py-2">
        {live.partial ? (
          <p
            className={cn("whitespace-pre-wrap break-words leading-relaxed text-muted-foreground")}
            style={{ fontSize: `${fontSize}px` }}
          >
            {live.partial}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            {live.captionsOn ? "正在聆听…" : live.notice ? "语音识别暂不可用" : "字幕已关闭"}
          </p>
        )}
      </footer>
    </div>
  );
}
