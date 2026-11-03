import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { notify } from "@/components/ui/toast";
import { normalizeVideoCoverUrl } from "@/lib/utils";
import type { VideoQuality } from "@/shared/types/video";
import {
  upsertVideoDownloadInCache,
  videoDownloadStart,
  type VideoDownloadInput,
} from "./videoDownload";

export type VideoDownloadTarget = {
  bvid: string | null;
  cid: number;
  epId: string | null;
  title: string;
  cover: string;
  author: string;
  duration: number;
  qualities: readonly VideoQuality[];
  defaultQn: number | null;
};

function availableQuality(target: VideoDownloadTarget | null): number | null {
  if (!target) return null;
  const defaultQuality = target.qualities.find(
    (quality) => quality.qn === target.defaultQn && quality.available,
  );
  if (defaultQuality) return defaultQuality.qn;
  return target.qualities.find((quality) => quality.available)?.qn ?? null;
}

/**
 * 播放页的下载确认框：选画质后把当前分 P / 分集加入队列。
 *
 * 音轨由后端按当前身份能取到的最高档自动选择，与 PiliPlus 的默认行为一致；
 * 这里不额外暴露音质，避免把一个次要选项铺成第二个下拉。
 */
export function VideoDownloadDialog({
  open,
  onOpenChange,
  target,
  container,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: VideoDownloadTarget | null;
  /** 画面全屏时的 portal 目标；窗口全屏仍走默认宿主。 */
  container?: HTMLElement | React.RefObject<HTMLElement | null> | null;
}) {
  const queryClient = useQueryClient();
  const [selectedQn, setSelectedQn] = useState<number | null>(null);
  const [lastOpen, setLastOpen] = useState(open);
  const [lastTargetKey, setLastTargetKey] = useState<string | null>(null);
  const targetKey = target ? `${target.bvid ?? ""}:${target.cid}:${target.epId ?? ""}` : null;

  // 每次打开或换一集都回到「当前播放画质」；停留在上次选择会让用户以为
  // 这条新内容也选了同一个档位，实际上它可能根本不可用。
  if (open !== lastOpen || (open && targetKey !== lastTargetKey)) {
    setLastOpen(open);
    setLastTargetKey(targetKey);
    if (open) setSelectedQn(availableQuality(target));
  }

  const startMutation = useMutation({
    mutationFn: (input: VideoDownloadInput) => videoDownloadStart(input),
    onSuccess: (item) => {
      upsertVideoDownloadInCache(queryClient, item);
      if (item.status === "completed") {
        notify.success("该视频已下载", "可在视频页的「下载」页签中查看。");
      } else {
        notify.success("已加入下载队列", "可在视频页的「下载」页签中查看进度。");
      }
      onOpenChange(false);
    },
    onError: (error) => notify.error("加入下载队列失败", downloadErrorText(error)),
  });

  const start = () => {
    if (!target || selectedQn === null) return;
    startMutation.mutate({
      bvid: target.bvid,
      cid: target.cid,
      ep_id: target.epId,
      title: target.title,
      cover: target.cover,
      author: target.author,
      duration: target.duration,
      qn: selectedQn,
    });
  };

  const cover = target ? normalizeVideoCoverUrl(target.cover) : undefined;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent container={container}>
        <DialogHeader>
          <DialogTitle>下载视频</DialogTitle>
          <DialogDescription>
            选择画质后加入下载队列。下载完成后可在视频页的「下载」页签中找到文件。
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-3 rounded-lg border border-border/70 bg-muted/35 p-2.5">
          <div className="aspect-video w-24 shrink-0 overflow-hidden rounded-md bg-muted">
            {cover ? (
              <img src={cover} alt="" className="h-full w-full object-cover" />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-muted-foreground">
                <Download className="size-4" aria-hidden />
              </div>
            )}
          </div>
          <div className="flex min-w-0 flex-col justify-center gap-1">
            <p className="line-clamp-2 text-sm font-medium" title={target?.title}>
              {target?.title ?? ""}
            </p>
            <p className="truncate text-sm text-muted-foreground">{target?.author ?? ""}</p>
          </div>
        </div>

        <div className="flex items-center justify-between gap-3">
          <label htmlFor="video-download-quality" className="text-sm font-medium">
            画质
          </label>
          <Select
            value={selectedQn === null ? null : String(selectedQn)}
            onValueChange={(value) => setSelectedQn(Number(value))}
            disabled={startMutation.isPending}
          >
            <SelectTrigger id="video-download-quality" className="min-w-36">
              <SelectValue>
                {target?.qualities.find((quality) => quality.qn === selectedQn)?.label ??
                  "选择画质"}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {target?.qualities.map((quality) => (
                  <SelectItem
                    key={quality.qn}
                    value={String(quality.qn)}
                    disabled={!quality.available}
                  >
                    {quality.available ? quality.label : `${quality.label}（登录或大会员可用）`}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>

        {selectedQn === null && (
          <p role="alert" className="text-sm text-destructive">
            当前身份没有可下载的画质，请先登录或开通大会员。
          </p>
        )}

        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>取消</DialogClose>
          <Button
            disabled={selectedQn === null || startMutation.isPending}
            onClick={start}
          >
            {startMutation.isPending ? (
              <Spinner data-icon="inline-start" aria-hidden />
            ) : (
              <Download data-icon="inline-start" aria-hidden />
            )}
            开始下载
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function downloadErrorText(error: unknown): string {
  if (typeof error === "object" && error && "message" in error) {
    return String((error as { message?: unknown }).message);
  }
  return String(error);
}
