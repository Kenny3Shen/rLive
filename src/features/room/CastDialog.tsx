import { useEffect, useRef, useState } from "react";
import { Cast, Loader2, Tv } from "lucide-react";
import { ErrorState } from "@/shared/components/ErrorState";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { invokeCmd } from "@/shared/api/tauri";

export type DlnaDevice = {
  usn: string;
  name: string;
  location: string;
};

type DlnaCastStatus = {
  device_name: string;
  title: string;
};

type CastDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 当前播放地址；投屏要求已有可播放线路。 */
  castUrl: string | null;
  headers: Record<string, string>;
  title: string;
};

/**
 * DLNA 投屏对话框：搜索局域网渲染器 → 选择设备 → 经后端中继下发播放地址。
 *
 * 投屏成功后展示连接状态与断开入口；重新搜索或关闭对话框不会中断已建立
 * 的投屏会话，只有显式断开才会停止。
 */
export function CastDialog({ open, onOpenChange, castUrl, headers, title }: CastDialogProps) {
  const [devices, setDevices] = useState<DlnaDevice[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<unknown>(null);
  const [castingName, setCastingName] = useState<string | null>(null);
  const [pendingName, setPendingName] = useState<string | null>(null);
  const [castError, setCastError] = useState<string | null>(null);
  // 对话框可能被关闭后重开，用 ref 防止竞态下的旧搜索结果覆盖新状态。
  const searchEpochRef = useRef(0);

  const search = async () => {
    const epoch = ++searchEpochRef.current;
    setSearching(true);
    setSearchError(null);
    setDevices(null);
    try {
      const result = await invokeCmd<DlnaDevice[]>("dlna_search_devices");
      if (epoch === searchEpochRef.current) setDevices(result);
    } catch (error) {
      if (epoch === searchEpochRef.current) setSearchError(error);
    } finally {
      if (epoch === searchEpochRef.current) setSearching(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    void invokeCmd<DlnaCastStatus | null>("dlna_status").then((status) => {
      setCastingName(status?.device_name ?? null);
    });
    void search();
    return () => {
      searchEpochRef.current += 1;
    };
  }, [open]);

  const cast = async (device: DlnaDevice) => {
    if (!castUrl) return;
    setPendingName(device.name);
    setCastError(null);
    try {
      const status = await invokeCmd<DlnaCastStatus>("dlna_cast", {
        location: device.location,
        url: castUrl,
        headers,
        title,
      });
      setCastingName(status.device_name);
    } catch (error) {
      setCastError(error instanceof Error ? error.message : String(error));
    } finally {
      setPendingName(null);
    }
  };

  const stopCasting = async () => {
    try {
      await invokeCmd("dlna_stop");
    } finally {
      setCastingName(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Cast aria-hidden />
            投屏到电视
          </DialogTitle>
          <DialogDescription>
            搜索同一局域网内的 DLNA 设备；直播流经本机中继转发，请保持本机与电视在线。
          </DialogDescription>
        </DialogHeader>

        {!castUrl && (
          <p className="text-sm text-muted-foreground">当前没有可播放的线路，无法投屏。</p>
        )}

        {castUrl && castingName && (
          <div className="flex flex-col gap-3 rounded-lg border bg-muted/40 p-3">
            <p className="flex items-center gap-2 text-sm">
              <Tv aria-hidden className="text-primary" />
              正在投屏到「{castingName}」
            </p>
            <Button variant="secondary" size="sm" onClick={() => void stopCasting()}>
              断开投屏
            </Button>
          </div>
        )}

        {castUrl && !castingName && (
          <div className="flex min-h-40 flex-col gap-2" aria-live="polite">
            {searching && (
              <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground" role="status">
                <Loader2 className="animate-spin-soft" data-icon="inline-start" />
                正在搜索设备…
              </p>
            )}
            {searchError ? (
              <ErrorState
                error={searchError}
                title="设备搜索失败"
                onRetry={() => void search()}
              />
            ) : null}
            {!searching && !searchError && devices && devices.length === 0 && (
              <p className="py-6 text-center text-sm text-muted-foreground">
                未发现可投屏设备，请确认电视已开启 DLNA 并接入同一网络。
              </p>
            )}
            {devices &&
              devices.map((device) => (
                <Button
                  key={device.usn || device.location}
                  variant="outline"
                  size="sm"
                  className="justify-start"
                  disabled={pendingName != null}
                  onClick={() => void cast(device)}
                >
                  {pendingName === device.name ? (
                    <Loader2 className="animate-spin-soft" data-icon="inline-start" aria-hidden />
                  ) : (
                    <Tv data-icon="inline-start" aria-hidden />
                  )}
                  {device.name}
                </Button>
              ))}
          </div>
        )}

        {castError && <p className="text-sm text-destructive">{castError}</p>}

        <div className="flex justify-between">
          <Button variant="ghost" size="sm" disabled={searching} onClick={() => void search()}>
            重新搜索
          </Button>
          <Button variant="secondary" size="sm" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
