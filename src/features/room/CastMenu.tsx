import { useEffect, useRef, useState } from "react";
import { Loader2, Tv } from "lucide-react";
import { ErrorState } from "@/shared/components/ErrorState";
import { Button } from "@/components/ui/button";
import { invokeCmd } from "@/shared/api/tauri";
import { cn } from "@/lib/utils";
import {
  glassOptionClass,
  glassTitleClass,
} from "@/shared/components/player/glassSurface";

export type DlnaDevice = {
  usn: string;
  name: string;
  location: string;
};

type DlnaCastStatus = {
  device_name: string;
  title: string;
};

/** 与 RoomToolMenus 的 default / overlay 变体保持一致。 */
export type CastMenuVariant = "default" | "overlay";

type CastMenuProps = {
  /** 当前播放地址；投屏要求已有可播放线路。 */
  castUrl: string | null;
  headers: Record<string, string>;
  title: string;
  variant?: CastMenuVariant;
  showHeader?: boolean;
  idPrefix?: string;
  /** 投屏会话建立或断开时上报设备名（null 表示无会话），供入口按钮展示状态。 */
  onCastingDeviceChange?: (deviceName: string | null) => void;
};

/**
 * DLNA 投屏菜单：搜索局域网渲染器 → 选择设备 → 经后端中继下发播放地址。
 *
 * 与定时关闭、自动发送弹幕一样作为房间工具菜单使用（顶栏 Popover、移动端
 * 抽屉与全屏 HUD）。投屏成功后展示连接状态与断开入口；关闭菜单不会中断
 * 已建立的投屏会话，只有显式断开才会停止。
 */
export function CastMenu({
  castUrl,
  headers,
  title,
  variant = "default",
  showHeader = true,
  idPrefix = "cast",
  onCastingDeviceChange,
}: CastMenuProps) {
  const overlay = variant === "overlay";
  const [devices, setDevices] = useState<DlnaDevice[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<unknown>(null);
  const [castingName, setCastingName] = useState<string | null>(null);
  const [pendingName, setPendingName] = useState<string | null>(null);
  const [castError, setCastError] = useState<string | null>(null);
  // 菜单可能被反复开关，用 ref 防止过期搜索结果覆盖新状态。
  const searchEpochRef = useRef(0);

  useEffect(() => {
    void invokeStatus();
    return () => {
      searchEpochRef.current += 1;
    };
    // onCastingDeviceChange 由父级以 setState 稳定引用传入。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const invokeStatus = async () => {
    try {
      const status = await invokeCmd<DlnaCastStatus | null>("dlna_status");
      setCastingName(status?.device_name ?? null);
      onCastingDeviceChange?.(status?.device_name ?? null);
    } catch {
      // 状态查询失败不打断菜单；后续操作仍可发起。
    }
  };

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
      onCastingDeviceChange?.(status.device_name);
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
      onCastingDeviceChange?.(null);
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-2">
      {showHeader && (
        <div className="flex min-w-0 items-center gap-2">
          <Tv aria-hidden className="size-4 shrink-0" />
          <span className={cn("min-w-0 truncate text-sm font-medium", glassTitleClass({ overlay }))}>
            投屏到电视
          </span>
        </div>
      )}

      {!castUrl && (
        <p className={cn("text-sm", overlay ? "text-white/65" : "text-muted-foreground")}>
          当前没有可播放的线路，无法投屏。
        </p>
      )}

      {castUrl && castingName && (
        <div
          className={cn(
            "flex flex-col gap-3 rounded-lg border p-3",
            overlay ? "border-white/15 bg-black/15" : "border-border bg-muted/40",
          )}
        >
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
        <div className="flex min-h-32 flex-col gap-1.5" aria-live="polite">
          {searching && (
            <p
              className={cn("flex items-center gap-2 py-4 text-sm", overlay ? "text-white/65" : "text-muted-foreground")}
              role="status"
            >
              <Loader2 className="animate-spin-soft" data-icon="inline-start" />
              正在搜索设备…
            </p>
          )}
          {searchError ? (
            <ErrorState error={searchError} title="设备搜索失败" onRetry={() => void search()} />
          ) : null}
          {!searching && !searchError && devices && devices.length === 0 && (
            <p className={cn("py-4 text-center text-sm", overlay ? "text-white/65" : "text-muted-foreground")}>
              未发现可投屏设备，请确认电视已开启 DLNA 并接入同一网络。
            </p>
          )}
          {devices &&
            devices.map((device) => (
              <Button
                key={`${idPrefix}-${device.usn || device.location}`}
                variant={overlay ? "ghost" : "outline"}
                size="sm"
                className={cn("justify-start", overlay && glassOptionClass({ overlay }))}
                disabled={pendingName != null}
                onClick={() => void cast(device)}
              >
                {pendingName === device.name ? (
                  <Loader2 className="animate-spin-soft" data-icon="inline-start" aria-hidden />
                ) : (
                  <Tv data-icon="inline-start" aria-hidden />
                )}
                <span className="min-w-0 truncate">{device.name}</span>
              </Button>
            ))}
        </div>
      )}

      {castError && <p className="text-sm text-destructive">{castError}</p>}

      {castUrl && (
        <Button
          variant="ghost"
          size="sm"
          className={cn("self-start", overlay && glassOptionClass({ overlay }))}
          disabled={searching}
          onClick={() => void search()}
        >
          重新搜索
        </Button>
      )}
    </div>
  );
}
